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
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from backend.auth import (
    COOKIE_NAME,
    SESSION_TTL_SECONDS,
    change_user_password,
    create_login_challenge,
    get_auth_settings,
    get_auth_status,
    list_invites,
    list_users_with_vault_stats,
    login_with_challenge,
    mutate_invite,
    owner_mutate_user,
    register_with_invite,
    setup_initial_owner,
    update_auth_settings,
    verify_session_token,
)
from backend.coach import get_coach_config, test_coach_connection, generate_coach_review
from backend.diagnosis import get_stock_diagnosis
from backend.ignition import (
    _fetch_stock_notice_risk,
    diagnose_ignition_stock,
    get_ignition_pool,
    get_ignition_tracking_pool,
    mutate_ignition_tracking,
)
from backend.limitup import get_limitup_pool, invalidate_limitup_cache
from backend.market_data import build_tencent_fqkline_payload, fetch_em_klines, to_em_secid
from backend.meme_radar import get_meme_radar_overview, diagnose_stock_meme
from backend.strategy_ledger import get_strategy_performance, snapshot_strategies
from backend.strong_herd import mutate_herd_pool
from backend.trade_calendar import cn_now_str, cn_today, get_market_calendar_snapshot
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
    limits_cls = getattr(httpx, "Limits", None)
    http_kwargs: dict[str, object] = {}
    if callable(limits_cls):
        http_kwargs["limits"] = limits_cls(max_connections=80, max_keepalive_connections=40)
    app.state.http = httpx.AsyncClient(
        timeout=httpx.Timeout(timeout),
        follow_redirects=True,
        trust_env=False,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "*/*",
        },
        **http_kwargs,
    )

    async def _warmup_market_caches() -> None:
        await asyncio.sleep(0.8)
        try:
            await get_limitup_pool(http_client=app.state.http)
        except Exception:
            pass

    warmup_task: Optional[asyncio.Task] = None
    if os.getenv("TSTOCK_DISABLE_WARMUP") != "1":
        warmup_task = asyncio.create_task(_warmup_market_caches())
    try:
        yield
    finally:
        if warmup_task and not warmup_task.done():
            warmup_task.cancel()
        await app.state.http.aclose()


app = FastAPI(title="TStock Data API", version="1.1.0", lifespan=lifespan)
origins = _cors_origins()
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def _extract_token(request: Request) -> Optional[str]:
    auth_hdr = request.headers.get("authorization") or ""
    if auth_hdr.lower().startswith("bearer "):
        tok = auth_hdr[7:].strip()
        if tok:
            return tok
    cookie_tok = request.cookies.get(COOKIE_NAME)
    if cookie_tok:
        return cookie_tok.strip()
    return None


def _client_ip(request: Request) -> str:
    real_ip = request.headers.get("x-real-ip")
    if real_ip:
        return real_ip.strip()
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _require_user(request: Request) -> dict[str, Any]:
    user = verify_session_token(_extract_token(request))
    if not user:
        raise HTTPException(status_code=401, detail="登录状态已失效或尚未登录，请先登录账号")
    return user


def _require_owner(request: Request) -> dict[str, Any]:
    user = _require_user(request)
    if user.get("role") != "owner":
        raise HTTPException(status_code=403, detail="仅主理人主账号可执行该管理操作")
    return user


def _json_with_session_cookie(payload: dict[str, Any], token: str) -> JSONResponse:
    resp = JSONResponse(content=payload)
    resp.set_cookie(
        key=COOKIE_NAME,
        value=token,
        max_age=SESSION_TTL_SECONDS,
        path="/",
        httponly=True,
        samesite="lax",
    )
    return resp


# ==================== 多账号鉴权与邀请码管理接口 ====================


class AuthSetupOwnerReq(BaseModel):
    username: str = Field(..., min_length=2, max_length=24)
    displayName: str = ""
    salt: Optional[str] = None
    storedKey: Optional[str] = None
    password: Optional[str] = None


class AuthRegisterReq(BaseModel):
    username: str = Field(..., min_length=2, max_length=24)
    displayName: str = ""
    inviteCode: str = Field(default="", max_length=40)
    salt: Optional[str] = None
    storedKey: Optional[str] = None
    password: Optional[str] = None


class AuthSettingsReq(BaseModel):
    allowOpenRegister: bool


class AuthLoginReq(BaseModel):
    username: str = Field(..., min_length=2, max_length=24)
    nonce: str = Field(..., min_length=16, max_length=128)
    clientProof: str = Field(..., min_length=64, max_length=64)


class AuthChangePwdReq(BaseModel):
    nonce: str = Field(..., min_length=16, max_length=128)
    currentProof: str = Field(..., min_length=64, max_length=64)
    newSalt: Optional[str] = None
    newStoredKey: Optional[str] = None
    newPassword: Optional[str] = None


class AuthInviteMutateReq(BaseModel):
    action: str = Field(..., pattern="^(create|revoke|delete)$")
    code: str = ""
    note: str = ""
    maxUses: int = 5


class AuthUserMutateReq(BaseModel):
    action: str = Field(..., pattern="^(reset_password|delete)$")
    username: str = Field(..., min_length=2, max_length=24)
    newSalt: Optional[str] = None
    newStoredKey: Optional[str] = None
    newPassword: Optional[str] = None


@app.get("/api/auth/status")
async def auth_status_api(request: Request) -> dict[str, Any]:
    """查询当前会话登录态、是否处于首次主账号初始化阶段及脱敏旧版金库摘要"""
    return get_auth_status(token=_extract_token(request))


@app.get("/api/auth/challenge")
async def auth_challenge_api(username: str = Query(..., min_length=2, max_length=24)) -> dict[str, Any]:
    """获取单次 90 秒有效的随机登录挑战 Nonce 与账号盐值（HTTP 防嗅探重放）"""
    try:
        return create_login_challenge(username=username)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/auth/setup_owner")
async def auth_setup_owner_api(req: AuthSetupOwnerReq) -> JSONResponse:
    """首次初始化主理人主账号，并自动将原有 data/user_vault.json 绑定迁移至该主账号"""
    try:
        res = setup_initial_owner(
            username=req.username,
            display_name=req.displayName,
            salt=req.salt,
            stored_key=req.storedKey,
            password=req.password,
        )
        return _json_with_session_cookie(res, res["token"])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/auth/register")
async def auth_register_api(request: Request, req: AuthRegisterReq) -> JSONResponse:
    """凭有效邀请码注册独立子账号，并自动创建干净物理隔离的专属金库"""
    try:
        res = register_with_invite(
            username=req.username,
            invite_code=req.inviteCode,
            display_name=req.displayName,
            salt=req.salt,
            stored_key=req.storedKey,
            password=req.password,
            client_ip=_client_ip(request),
        )
        return _json_with_session_cookie(res, res["token"])
    except PermissionError as exc:
        msg = str(exc)
        code = 429 if "频繁" in msg else 403
        raise HTTPException(status_code=code, detail=msg) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/auth/login")
async def auth_login_api(request: Request, req: AuthLoginReq) -> JSONResponse:
    """校验挑战证明并签发 30 天长效会话"""
    try:
        res = login_with_challenge(
            username=req.username,
            nonce=req.nonce,
            client_proof=req.clientProof,
            client_ip=_client_ip(request),
        )
        return _json_with_session_cookie(res, res["token"])
    except PermissionError as exc:
        msg = str(exc)
        code = 429 if "频繁" in msg else 401
        raise HTTPException(status_code=code, detail=msg) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/auth/logout")
async def auth_logout_api() -> JSONResponse:
    """退出当前会话并清除 Cookie"""
    resp = JSONResponse(content={"ok": True})
    resp.delete_cookie(key=COOKIE_NAME, path="/")
    return resp


@app.post("/api/auth/change_password")
async def auth_change_password_api(request: Request, req: AuthChangePwdReq) -> JSONResponse:
    """修改当前登录账号的密码并立即吊销该账号旧会话"""
    user = _require_user(request)
    try:
        res = change_user_password(
            username=user["username"],
            nonce=req.nonce,
            current_proof=req.currentProof,
            new_salt=req.newSalt,
            new_stored_key=req.newStoredKey,
            new_password=req.newPassword,
        )
        return _json_with_session_cookie(res, res["token"])
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/auth/invites")
async def auth_list_invites_api(request: Request) -> dict[str, Any]:
    """主理人查看全部邀请码与当前开放注册设置"""
    _require_owner(request)
    return {"ok": True, "invites": list_invites(), "settings": get_auth_settings()}


@app.post("/api/auth/settings")
async def auth_update_settings_api(request: Request, req: AuthSettingsReq) -> dict[str, Any]:
    """主理人一键开启或关闭免邀请码开放注册"""
    _require_owner(request)
    return update_auth_settings(allow_open_register=req.allowOpenRegister)


@app.post("/api/auth/invites")
async def auth_mutate_invite_api(request: Request, req: AuthInviteMutateReq) -> dict[str, Any]:
    """主理人生成新邀请码、作废或删除邀请码"""
    _require_owner(request)
    try:
        return mutate_invite(
            action=req.action,
            code=req.code,
            note=req.note,
            max_uses=req.maxUses,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/auth/users")
async def auth_list_users_api(request: Request) -> dict[str, Any]:
    """主理人查看全部注册账号及各自金库持仓/流水概览（不含他人私密明细）"""
    _require_owner(request)
    return {"ok": True, "users": list_users_with_vault_stats()}


@app.post("/api/auth/users")
async def auth_mutate_users_api(request: Request, req: AuthUserMutateReq) -> dict[str, Any]:
    """主理人重置成员密码或移除成员账号"""
    owner = _require_owner(request)
    try:
        res = owner_mutate_user(
            owner_username=owner["username"],
            action=req.action,
            target_username=req.username,
            new_salt=req.newSalt,
            new_stored_key=req.newStoredKey,
            new_password=req.newPassword,
        )
        return {**res, "users": list_users_with_vault_stats()}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# ==================== 股票数据与业务接口 ====================


class HerdActionReq(BaseModel):
    action: str = Field(..., pattern="^(add|remove|restore|pin)$")
    code: str = Field(..., min_length=6, max_length=6, pattern="^[0-9]{6}$")
    name: str = ""
    hybk: str = ""
    price: float = 0.0
    reason: str = ""


class IgnitionTrackActionReq(BaseModel):
    action: str = Field(..., pattern="^(add|remove)$")
    code: str = Field(..., min_length=6, max_length=6, pattern="^[0-9]{6}$")
    name: str = ""
    hybk: str = ""
    price: float = 0.0
    strategy: str = "ignition"
    subType: str = ""
    verdict: str = ""


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
    return {
        "ok": True,
        "service": "tstock-data",
        "upstreams": len(ALLOWED_HOSTS),
        "tradeCalendar": get_market_calendar_snapshot(),
    }


@app.get("/api/stock/trade_calendar")
async def stock_trade_calendar(
    date: str | None = Query(None, min_length=8, max_length=10),
) -> dict[str, object]:
    """查询指定日期或当前北京时间的 A 股交易日历、法定节假日休市标签及前后交易日"""
    return {"ok": True, **get_market_calendar_snapshot(date)}


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

    today_dt = cn_today()
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
        "checkedAt": cn_now_str("%H:%M:%S"),
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
async def stock_herd_action(request: Request, payload: HerdActionReq) -> dict[str, object]:
    """抱团自动跟踪池的手动干预接口（需登录权限）"""
    _require_user(request)
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
    """四维策略推荐战绩与胜率统计"""
    try:
        http_client = getattr(request.app.state, "http", None)
        return await get_strategy_performance(http_client=http_client, force_snapshot=refresh)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"策略战绩统计失败: {exc}") from exc


@app.post("/api/stock/strategy_snapshot")
async def stock_strategy_snapshot(request: Request) -> dict[str, object]:
    """触发一次全策略建档快照并更新 data/strategy_ledger.json（本机定时任务免鉴权，外部需登录）"""
    client_host = (request.client.host if request.client else "") or ""
    if client_host not in ("127.0.0.1", "::1", "localhost"):
        _require_user(request)
    try:
        http_client = getattr(request.app.state, "http", None)
        return await snapshot_strategies(http_client=http_client)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"策略建档失败: {exc}") from exc


@app.get("/api/stock/klines")
async def stock_klines(
    request: Request,
    code: str = Query(..., min_length=6, max_length=12),
    period: str = Query("day"),
    count: int = Query(120, ge=5, le=1200),
) -> dict[str, object]:
    """统一多源前复权 K 线接口（供选股引擎、回算台账与前端共用，内置缓存与防 501 容灾）"""
    from backend.market_data import to_tcode

    tc = to_tcode(code)
    klt_map = {"day": 101, "week": 102, "month": 103}
    p = period if period in klt_map else "day"
    bars = await fetch_em_klines(
        request.app.state.http,
        to_em_secid(tc),
        klt=klt_map[p],
        lmt=count,
        tcode_fallback=tc,
    )
    return {
        "ok": bool(bars),
        "code": tc,
        "period": p,
        "count": len(bars),
        "bars": bars,
    }


@app.get("/api/stock/ignition_pool")
async def stock_ignition_pool(
    request: Request,
    include_cyb: bool = Query(False),
    lookback_days: int = Query(20, ge=5, le=30),
    sector_dd_min: float = Query(30.0, ge=10.0, le=70.0),
    stock_dd_min: float = Query(40.0, ge=15.0, le=80.0),
    custom_mappings: str | None = Query(None, max_length=4000),
    refresh: bool = Query(False),
    fast_snapshot: bool = Query(False),
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
            fast_snapshot=fast_snapshot,
            http_client=http_client,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"起爆挖掘扫描失败: {exc}") from exc


@app.get("/api/stock/ignition_tracking")
async def stock_ignition_tracking(request: Request) -> dict[str, object]:
    """获取起爆挖掘与抗跌抄底在轨生命周期跟踪池"""
    try:
        http_client = getattr(request.app.state, "http", None)
        return await get_ignition_tracking_pool(http_client=http_client)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"起爆在轨跟踪获取失败: {exc}") from exc


@app.post("/api/stock/ignition_tracking_action")
async def stock_ignition_tracking_action(request: Request, payload: IgnitionTrackActionReq) -> dict[str, object]:
    """手动加入或移出在轨生命周期跟踪池（需登录权限）"""
    _require_user(request)
    try:
        return await mutate_ignition_tracking(
            action=payload.action,
            code=payload.code,
            name=payload.name,
            hybk=payload.hybk,
            price=payload.price,
            strategy=payload.strategy,
            sub_type=payload.subType,
            verdict=payload.verdict,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"在轨跟踪池更新失败: {exc}") from exc


@app.get("/api/stock/ignition_diagnose")
async def stock_ignition_diagnose(request: Request, query: str = Query(..., min_length=1, max_length=50)) -> dict[str, object]:
    """诊断自选横盘标的的起爆成色"""
    try:
        http_client = getattr(request.app.state, "http", None)
        return await diagnose_ignition_stock(query=query, http_client=http_client)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"起爆成色体检异常: {exc}") from exc


@app.get("/api/stock/meme_radar")
async def stock_meme_radar() -> dict[str, Any]:
    """获取全市场玄学字辈共振全景榜单"""
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
async def run_tail_scan_api(request: Request, force: bool = Query(default=True)) -> dict[str, object]:
    """一键触发全市场尾盘黑马实时选股扫描并更新契约（需登录权限）"""
    _require_user(request)
    if _tail_scan_lock.locked():
        return {
            "ok": False,
            "busy": True,
            "message": "全市场尾盘黑马扫描正在执行中，请稍候刷新结果…",
        }

    async with _tail_scan_lock:
        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        task_script = os.path.join(project_root, "timing_task", "tasks", "task_tail.js")

        cmd = ["node", task_script, "--skip-snapshot"]
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

            # 后台非阻塞触发策略战绩建档，避免阻塞前端尾盘扫描按钮返回
            http_client = getattr(request.app.state, "http", None)

            async def _bg_snapshot() -> None:
                try:
                    await snapshot_strategies(http_client=http_client)
                except Exception:
                    pass

            asyncio.create_task(_bg_snapshot())

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
async def get_user_vault_api(request: Request) -> dict[str, Any]:
    """读取当前登录账号的独立持久化金库（不同账号物理隔离）"""
    user = _require_user(request)
    res = load_user_vault(username=user["username"])
    return {**res, "user": user}


@app.post("/api/user/vault")
async def save_user_vault_api(request: Request, req: UserVaultSaveReq) -> dict[str, Any]:
    """原子双写当前登录账号的专属金库至磁盘，并自动生成按账号隔离的每日备份"""
    user = _require_user(request)
    try:
        res = save_user_vault(
            payload=req.model_dump(),
            force=bool(req.force),
            username=user["username"],
        )
        return {**res, "user": user}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"云端金库写入失败: {exc}") from exc


@app.get("/api/coach/config")
async def coach_config_api(request: Request) -> dict[str, Any]:
    """获取天翼云大模型配置状态与可用参数（需登录权限）"""
    _require_user(request)
    return get_coach_config()


@app.post("/api/coach/test")
async def coach_test_api(request: Request, req: CoachTestReq) -> dict[str, Any]:
    """测试天翼云 / OpenAI 兼容接口连接性与模型延迟（需登录权限）"""
    _require_user(request)
    try:
        return await test_coach_connection(
            api_key=req.apiKey,
            api_url=req.apiUrl,
            model=req.model,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/coach/review")
async def coach_review_api(request: Request, req: CoachReviewReq) -> dict[str, Any]:
    """调用大模型或内置量化规则教练执行今日操盘与做T实战复盘诊断（需登录权限）"""
    _require_user(request)
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

    parsed_up = urlsplit(upstream)
    host = parsed_up.hostname or ""
    is_fqkline = "/appstock/app/fqkline/get" in parsed_up.path
    synthesized_bytes: Optional[bytes] = None

    try:
        if is_fqkline and host in ("ifzq.gtimg.cn", "web.ifzq.gtimg.cn"):
            qq_proxy_url = f"https://proxy.finance.qq.com/ifzqgtimg{parsed_up.path}?{parsed_up.query}"
            result = await request.app.state.http.get(
                qq_proxy_url,
                headers={"Referer": "https://gu.qq.com/"},
            )
        else:
            result = await request.app.state.http.get(
                upstream,
                headers={"Referer": "https://gu.qq.com/" if "ifzq.gtimg.cn" in host else f"https://{host}/"},
            )
            if result.status_code == 501 and host in ("ifzq.gtimg.cn", "web.ifzq.gtimg.cn"):
                alt_host = "web.ifzq.gtimg.cn" if host == "ifzq.gtimg.cn" else "ifzq.gtimg.cn"
                for cand_url in (
                    f"https://proxy.finance.qq.com/ifzqgtimg{parsed_up.path}?{parsed_up.query}",
                    upstream.replace(f"https://{host}/", f"https://{alt_host}/", 1),
                ):
                    alt_res = await request.app.state.http.get(
                        cand_url,
                        headers={"Referer": "https://gu.qq.com/"},
                    )
                    if 200 <= alt_res.status_code < 300:
                        result = alt_res
                        break
    except httpx.TimeoutException as exc:
        if not is_fqkline:
            raise HTTPException(status_code=504, detail="股票数据源请求超时") from exc
        result = None
    except httpx.HTTPError as exc:
        if not is_fqkline:
            raise HTTPException(status_code=502, detail="股票数据源暂时不可用") from exc
        result = None

    if is_fqkline and (result is None or not (200 <= result.status_code < 300) or not result.text.lstrip().startswith("{")):
        from urllib.parse import parse_qs

        qs_map = parse_qs(parsed_up.query)
        param_raw = (qs_map.get("param") or [""])[0]
        parts = [p.strip() for p in param_raw.split(",")]
        tc = parts[0] if len(parts) >= 1 else ""
        period = parts[1] if len(parts) >= 2 and parts[1] in ("day", "week", "month") else "day"
        try:
            lmt = int(parts[4]) if len(parts) >= 5 and parts[4] else 120
        except ValueError:
            lmt = 120
        if tc:
            klt_map = {"day": 101, "week": 102, "month": 103}
            bars = await fetch_em_klines(
                request.app.state.http,
                to_em_secid(tc),
                klt=klt_map.get(period, 101),
                lmt=lmt,
                tcode_fallback=tc,
            )
            if bars:
                payload = build_tencent_fqkline_payload(tc, period, lmt, bars)
                synthesized_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    if synthesized_bytes is not None:
        entry = CacheEntry(
            expires_at=now + _cache_ttl(upstream),
            status_code=200,
            content=synthesized_bytes,
            content_type="application/json",
        )
        async with _cache_lock:
            _cache[upstream] = entry
        return Response(
            content=synthesized_bytes,
            status_code=200,
            media_type="application/json",
            headers={"X-TStock-Cache": "FALLBACK"},
        )
    if result is None:
        raise HTTPException(status_code=502, detail="K线数据源暂时不可用")

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
