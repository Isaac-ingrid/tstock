from __future__ import annotations

import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Optional
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

from backend.coach import get_coach_config, test_coach_connection, generate_coach_review
from backend.diagnosis import get_stock_diagnosis
from backend.ignition import (
    _fetch_stock_notice_risk,
    diagnose_ignition_stock,
    get_ignition_pool,
    get_ignition_tracking_pool,
)
from backend.limitup import get_limitup_pool, invalidate_limitup_cache
from backend.meme_radar import get_meme_radar_overview, diagnose_stock_meme
from backend.strategy_ledger import get_strategy_performance, snapshot_strategies
from backend.strong_herd import mutate_herd_pool
from backend.user_vault import load_user_vault, save_user_vault

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
async def stock_diagnosis(
    request: Request,
    code: str = Query(min_length=6, max_length=6, pattern="^[0-9]{6}$"),
) -> dict[str, object]:
    """个股全景体检报告：聚合行情、公告排雷、板块风口、公司主营、筹码分布与做T自救处方"""
    try:
        http_client = getattr(request.app.state, "http", None)
        return await get_stock_diagnosis(code, http_client=http_client)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"体检诊断聚合失败: {exc}") from exc


@app.get("/api/stock/batch_notice_risk")
async def stock_batch_notice_risk(
    request: Request,
    codes: str = Query(..., min_length=6, max_length=260),
) -> dict[str, object]:
    """盘前批量公告排雷：并发扫描持仓/自选股近 35 天高危与提示公告（复用带上限缓存）"""
    import datetime

    raw_codes = [c.strip().zfill(6) for c in codes.split(",") if c.strip()]
    uniq_codes = list(dict.fromkeys(c for c in raw_codes if len(c) == 6 and c.isdigit()))[:30]
    if not uniq_codes:
        return {"ok": True, "items": {}, "redCount": 0, "yellowCount": 0, "checkedAt": ""}

    http_client = getattr(request.app.state, "http", None)
    close_client = http_client is None
    client = http_client or httpx.AsyncClient(timeout=httpx.Timeout(10.0), trust_env=False)
    try:
        sem = asyncio.Semaphore(4)
        results = await asyncio.gather(
            *[_fetch_stock_notice_risk(client, c, sem) for c in uniq_codes],
            return_exceptions=True,
        )
    finally:
        if close_client:
            await client.aclose()

    today_dt = datetime.date.today()
    items: dict[str, Any] = {}
    red_count = 0
    yellow_count = 0
    for c, res in zip(uniq_codes, results):
        info = res if isinstance(res, dict) else {"riskLevel": "安全", "redFlags": [], "yellowAlerts": []}
        red_flags = info.get("redFlags") or []
        yellow_alerts = info.get("yellowAlerts") or []
        recent_3d = False
        for entry in (*red_flags, *yellow_alerts):
            try:
                if (today_dt - datetime.date.fromisoformat(str(entry.get("date") or "")[:10])).days <= 3:
                    recent_3d = True
                    break
            except Exception:
                pass
        if red_flags:
            red_count += 1
        elif yellow_alerts:
            yellow_count += 1
        items[c] = {
            **info,
            "hasRecent3dAlert": recent_3d,
        }

    return {
        "ok": True,
        "items": items,
        "redCount": red_count,
        "yellowCount": yellow_count,
        "checkedAt": datetime.datetime.now().strftime("%H:%M:%S"),
    }


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


@app.get("/api/stock/ignition_tracking")
async def stock_ignition_tracking(request: Request) -> dict[str, object]:
    """获取起爆挖掘与抗跌抄底在轨生命周期跟踪池（毫秒级拉取最新现价与SOP建议）"""
    try:
        http_client = getattr(request.app.state, "http", None)
        return await get_ignition_tracking_pool(http_client=http_client)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"起爆在轨跟踪获取失败: {exc}") from exc


@app.get("/api/stock/ignition_diagnose")
async def stock_ignition_diagnose(request: Request, query: str = Query(..., min_length=1, max_length=50)) -> dict[str, object]:
    """诊断自选横盘标的的起爆成色（试盘涨停 + 月放量 + 周向上 + 日缩量 + 均线粘合震仓 + 底座防守）"""
    try:
        http_client = getattr(request.app.state, "http", None)
        return await diagnose_ignition_stock(query=query, http_client=http_client)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"起爆成色体检异常: {exc}") from exc


@app.get("/api/stock/meme_radar")
async def stock_meme_radar() -> dict[str, Any]:
    """获取全市场玄学字辈共振全景榜单（东方系、日/阳字辈、华字辈、龙蛇生肖、中字头等）"""
    try:
        return get_meme_radar_overview()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"玄学字辈雷达统计失败: {exc}") from exc


@app.get("/api/stock/meme_diagnose")
async def stock_meme_diagnose(query: str = Query(..., min_length=1, max_length=50)) -> dict[str, Any]:
    """诊断任意单只个股的玄学字辈血统、共振强度与是否属于孤狼自嗨"""
    try:
        return diagnose_stock_meme(query=query)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"个股玄学共振诊断失败: {exc}") from exc


_tail_scan_lock = asyncio.Lock()


@app.post("/api/stock/run_tail_scan")
async def run_tail_scan_api(force: bool = Query(default=True)) -> dict[str, object]:
    """一键触发全市场尾盘黑马实时选股扫描并更新契约与前端缓存"""
    if _tail_scan_lock.locked():
        return {
            "ok": False,
            "busy": True,
            "message": "全市场尾盘黑马扫描正在执行中，请稍候刷新结果…",
        }

    async with _tail_scan_lock:
        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        task_script = os.path.join(project_root, "timing_task", "tasks", "task_tail.js")

        cmd = ["node", task_script]
        if force:
            cmd.append("--force")

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=project_root,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=60.0)
            out_str = stdout.decode("utf-8", errors="replace")
            err_str = stderr.decode("utf-8", errors="replace")

            if proc.returncode != 0:
                raise HTTPException(
                    status_code=500,
                    detail=f"尾盘扫描执行失败 (code {proc.returncode}): {err_str or out_str}",
                )

            latest_file = os.path.join(project_root, "data", "latest.json")
            tail_data = []
            tail_meta = None
            if os.path.exists(latest_file):
                try:
                    with open(latest_file, "r", encoding="utf-8") as f:
                        lj = json.load(f)
                        tail_data = lj.get("tail", [])
                        tail_meta = lj.get("tailMeta")
                except Exception:
                    pass

            return {
                "ok": True,
                "message": f"尾盘扫描完成，共精选出 {len(tail_data)} 只隔夜黑马标的",
                "count": len(tail_data),
                "tailMeta": tail_meta,
                "tail": tail_data,
                "logs": [line.strip() for line in out_str.strip().splitlines() if line.strip()][-12:],
            }
        except asyncio.TimeoutError:
            raise HTTPException(status_code=504, detail="尾盘黑马全市场扫描超时 (60s)")
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"触发尾盘扫描异常: {exc}") from exc


class CoachTestReq(BaseModel):
    apiKey: Optional[str] = None
    apiUrl: Optional[str] = None
    model: Optional[str] = None


class CoachReviewReq(BaseModel):
    trades: list[dict[str, Any]]
    date: str
    marketEnv: Optional[dict[str, Any]] = None
    userNotes: Optional[str] = None
    apiKey: Optional[str] = None
    apiUrl: Optional[str] = None
    model: Optional[str] = None
    mode: str = "auto"


class UserVaultSaveReq(BaseModel):
    pool: list[dict[str, Any]] = Field(default_factory=list)
    logs: list[dict[str, Any]] = Field(default_factory=list)
    tailActives: list[dict[str, Any]] = Field(default_factory=list)
    snapshots: list[dict[str, Any]] = Field(default_factory=list)
    eodArchives: list[dict[str, Any]] = Field(default_factory=list)
    posRules: dict[str, Any] = Field(default_factory=dict)
    initialCapital: float = 100000.0
    availableCash: float = 0.0
    force: bool = False


@app.get("/api/user/vault")
async def get_user_vault_api() -> dict[str, Any]:
    """读取本地磁盘持久化金库（持仓池、成交流水、尾盘持仓、收盘快照、风控配置与现金总账）"""
    return load_user_vault()


@app.post("/api/user/vault")
async def save_user_vault_api(req: UserVaultSaveReq) -> dict[str, Any]:
    """原子双写用户金库至本地磁盘，并自动生成按日滚动快照备份"""
    try:
        return save_user_vault(
            payload=req.model_dump(),
            force=bool(req.force),
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"本地磁盘金库写入失败: {exc}") from exc


@app.get("/api/coach/config")
async def coach_config_api() -> dict[str, Any]:
    """获取天翼云大模型配置状态与可用参数"""
    return get_coach_config()


@app.post("/api/coach/test")
async def coach_test_api(req: CoachTestReq) -> dict[str, Any]:
    """测试天翼云 / OpenAI 兼容接口连接性与模型延迟"""
    try:
        return await test_coach_connection(
            api_key=req.apiKey,
            api_url=req.apiUrl,
            model=req.model,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/coach/review")
async def coach_review_api(req: CoachReviewReq) -> dict[str, Any]:
    """调用大模型或内置量化规则教练执行今日操盘与做T实战复盘诊断"""
    try:
        return await generate_coach_review(
            trades=req.trades,
            date=req.date,
            market_env=req.marketEnv,
            user_notes=req.userNotes,
            api_key=req.apiKey,
            api_url=req.apiUrl,
            model=req.model,
            mode=req.mode,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


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

    content_type = result.headers.get("content-type", "application/octet-stream",).split(";", 1)[0]
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
