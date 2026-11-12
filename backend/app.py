from __future__ import annotations

import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

from backend.diagnosis import get_stock_diagnosis
from backend.ignition import get_ignition_pool
from backend.limitup import get_limitup_pool, invalidate_limitup_cache
from backend.strategy_ledger import get_strategy_performance, snapshot_strategies
from backend.strong_herd import mutate_herd_pool

ALLOWED_HOSTS = {
    "qt.gtimg.cn",
    "proxy.finance.qq.com",
    "web.ifzq.gtimg.cn",
    "ifzq.gtimg.cn",
    "stock.gtimg.cn",
    "datacenter-web.eastmoney.com",
}


@dataclass
class CacheEntry:
    expires_at: float
    status_code: int
    content: bytes
    content_type: str


_cache: dict[str, CacheEntry] = {}
_cache_lock = asyncio.Lock()


def _cors_origins() -> list[str]:
    raw = os.getenv("STOCK_API_CORS_ORIGINS", "*")
    return [item.strip() for item in raw.split(",") if item.strip()]


def _validate_upstream(url: str) -> str:
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS:
        raise HTTPException(status_code=400, detail="不允许的股票数据源")
    if parsed.username or parsed.password or parsed.port not in (None, 443):
        raise HTTPException(status_code=400, detail="上游地址格式不合法")
    return url


def _cache_ttl(url: str) -> int:
    parsed = urlsplit(url)
    if parsed.hostname == "qt.gtimg.cn":
        return 2
    if "minute" in parsed.path or "detail" in parsed.query:
        return 5
    if parsed.hostname == "datacenter-web.eastmoney.com":
        return 300
    return 60


@asynccontextmanager
async def lifespan(app: FastAPI):
    timeout = float(os.getenv("STOCK_API_TIMEOUT_SECONDS", "15"))
    app.state.http = httpx.AsyncClient(
        timeout=httpx.Timeout(timeout),
        follow_redirects=True,
        trust_env=False,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "*/*",
        },
    )
    yield
    await app.state.http.aclose()


app = FastAPI(title="TStock Data API", version="1.0.0", lifespan=lifespan)
origins = _cors_origins()
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


class HerdActionReq(BaseModel):
    action: str = Field(..., pattern="^(add|remove|restore|pin)$")
    code: str = Field(..., min_length=6, max_length=6, pattern="^[0-9]{6}$")
    name: str = ""
    hybk: str = ""
    price: float = 0.0
    reason: str = ""


@app.get("/")
async def root() -> dict[str, object]:
    return {
        "ok": True,
        "service": "tstock-data",
        "message": "股票数据后端运行正常",
        "health": "/health",
        "docs": "/docs",
    }


@app.get("/health")
async def health() -> dict[str, object]:
    return {"ok": True, "service": "tstock-data", "upstreams": len(ALLOWED_HOSTS)}


@app.get("/api/stock/diagnosis")
async def stock_diagnosis(code: str = Query(min_length=6, max_length=6, pattern="^[0-9]{6}$")) -> dict[str, object]:
    """个股全景体检报告：聚合行情、公告排雷、板块风口、公司主营、筹码分布与做T自救处方"""
    try:
        return await get_stock_diagnosis(code)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"体检诊断聚合失败: {exc}") from exc


@app.get("/api/stock/limitup_pool")
async def stock_limitup_pool(
    request: Request,
    date: str | None = Query(None, min_length=8, max_length=8, pattern="^[0-9]{8}$"),
    mystic_roots: str | None = Query(None, max_length=200),
) -> dict[str, object]:
    """全市场连板天梯与打板股池：聚合连板高度、首封时点、封单额与封成比、热点题材、玄学字根共振与双轨评分"""
    try:
        http_client = getattr(request.app.state, "http", None)
        return await get_limitup_pool(date, mystic_roots=mystic_roots, http_client=http_client)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"连板池数据拉取失败: {exc}") from exc


@app.post("/api/stock/herd_action")
async def stock_herd_action(payload: HerdActionReq) -> dict[str, object]:
    """抱团自动跟踪池的手动干预接口（固定pin / 加池add / 移出remove / 恢复restore）"""
    try:
        res = await mutate_herd_pool(
            action=payload.action,
            code=payload.code,
            name=payload.name,
            hybk=payload.hybk,
            price=payload.price,
            reason=payload.reason,
        )
        await invalidate_limitup_cache()
        return res
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"抱团池更新失败: {exc}") from exc


@app.get("/api/stock/strategy_perf")
async def stock_strategy_perf(
    request: Request,
    refresh: bool = Query(False),
) -> dict[str, object]:
    """四维策略推荐战绩与胜率统计（稳健长线 / 短线双列 / 尾盘黑马 / 连板打板已剔除一字与14:30+尾盘）"""
    try:
        http_client = getattr(request.app.state, "http", None)
        return await get_strategy_performance(http_client=http_client, force_snapshot=refresh)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"策略战绩统计失败: {exc}") from exc


@app.post("/api/stock/strategy_snapshot")
async def stock_strategy_snapshot(request: Request) -> dict[str, object]:
    """触发一次全策略建档快照并更新 data/strategy_ledger.json"""
    try:
        http_client = getattr(request.app.state, "http", None)
        return await snapshot_strategies(http_client=http_client)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"策略建档失败: {exc}") from exc


@app.get("/api/stock/ignition_pool")
async def stock_ignition_pool(
    request: Request,
    include_cyb: bool = Query(False),
    lookback_days: int = Query(20, ge=5, le=30),
    sector_dd_min: float = Query(30.0, ge=10.0, le=70.0),
    stock_dd_min: float = Query(40.0, ge=15.0, le=80.0),
    custom_mappings: str | None = Query(None, max_length=4000),
    refresh: bool = Query(False),
) -> dict[str, object]:
    """起爆点挖掘双方向扫描：横盘多周期试盘起爆 + 板块深跌腰斩龙头抗跌抄底"""
    parsed_custom = None
    if custom_mappings and custom_mappings.strip():
        try:
            raw = json.loads(custom_mappings)
            if isinstance(raw, list):
                parsed_custom = raw
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"custom_mappings JSON 格式错误: {exc}") from exc
    try:
        http_client = getattr(request.app.state, "http", None)
        return await get_ignition_pool(
            include_cyb=include_cyb,
            lookback_days=lookback_days,
            sector_dd_min=sector_dd_min,
            stock_dd_min=stock_dd_min,
            custom_us_mappings=parsed_custom,
            force_refresh=refresh,
            http_client=http_client,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"起爆挖掘扫描失败: {exc}") from exc


@app.get("/api/proxy")
async def proxy(request: Request, url: str = Query(min_length=12)) -> Response:
    upstream = _validate_upstream(url)
    now = time.monotonic()

    async with _cache_lock:
        cached = _cache.get(upstream)
        if cached and cached.expires_at > now:
            return Response(
                content=cached.content,
                status_code=cached.status_code,
                media_type=cached.content_type,
                headers={"X-TStock-Cache": "HIT"},
            )
        if cached:
            _cache.pop(upstream, None)

    try:
        host = urlsplit(upstream).hostname or ""
        result = await request.app.state.http.get(
            upstream,
            headers={"Referer": "https://gu.qq.com/" if "ifzq.gtimg.cn" in host else f"https://{host}/"},
        )
        # 若腾讯某边缘节点触发 WAF 501，自动在 ifzq.gtimg.cn 与 web.ifzq.gtimg.cn 间互切重试一次
        if result.status_code == 501 and host in ("ifzq.gtimg.cn", "web.ifzq.gtimg.cn"):
            alt_host = "web.ifzq.gtimg.cn" if host == "ifzq.gtimg.cn" else "ifzq.gtimg.cn"
            alt_url = upstream.replace(f"https://{host}/", f"https://{alt_host}/", 1)
            alt_res = await request.app.state.http.get(
                alt_url,
                headers={"Referer": "https://gu.qq.com/"},
            )
            if 200 <= alt_res.status_code < 300:
                result = alt_res
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail="股票数据源请求超时") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="股票数据源暂时不可用") from exc

    content_type = result.headers.get("content-type", "application/octet-stream").split(";", 1)[0]
    if 200 <= result.status_code < 300:
        entry = CacheEntry(
            expires_at=now + _cache_ttl(upstream),
            status_code=result.status_code,
            content=result.content,
            content_type=content_type,
        )
        async with _cache_lock:
            if len(_cache) > 1000:
                expired = [key for key, value in _cache.items() if value.expires_at <= now]
                for key in expired:
                    _cache.pop(key, None)
                if len(_cache) > 1000:
                    _cache.pop(next(iter(_cache)))
            _cache[upstream] = entry

    return Response(
        content=result.content,
        status_code=result.status_code,
        media_type=content_type,
        headers={"X-TStock-Cache": "MISS"},
    )
