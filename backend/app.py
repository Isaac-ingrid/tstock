from __future__ import annotations

import asyncio
import os
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

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
    allow_methods=["GET"],
    allow_headers=["*"],
)


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
        result = await request.app.state.http.get(
            upstream,
            headers={"Referer": f"https://{urlsplit(upstream).hostname}/"},
        )
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
