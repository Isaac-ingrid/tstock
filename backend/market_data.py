from __future__ import annotations

"""
统一行情网关与带容量上限的 TTL 缓存层 (backend/market_data.py)

收口 diagnosis.py / ignition.py / strong_herd.py 中重复的东财与腾讯行情抓取逻辑：
1. BoundedTTLCache: 协程安全、带最大容量 (LRU) 与 TTL 的内存缓存，防止长期运行内存泄漏
2. fetch_em_klines: 东方财富前复权 K 线主用 + 腾讯多节点自动回退（返回标准 dict 列表）
3. fetch_kline_rows: 兼容旧调用方的 list 列表格式 [date, open, close, high, low, vol]
4. fetch_batch_quotes: 腾讯 60 只/批实时快照拉取
"""

import asyncio
import datetime
import json
import time
from collections import OrderedDict
from typing import Any, Dict, Generic, List, Optional, Tuple, TypeVar

import httpx

K = TypeVar("K")
V = TypeVar("V")


def safe_float(v: Any, default: float = 0.0) -> float:
    try:
        return float(v) if v not in (None, "", "-") else default
    except (ValueError, TypeError):
        return default


def to_tcode(code: str) -> str:
    c = str(code or "").strip().lower()
    if c.startswith(("sh", "sz", "bj")) and len(c) == 8:
        return c
    if "." in c:
        mkt, num = c.split(".", 1)
        c6 = num.strip().zfill(6)
        if mkt == "1":
            return f"sh{c6}"
        if mkt == "0":
            return f"bj{c6}" if c6.startswith(("4", "8")) else f"sz{c6}"
    c6 = c.replace("sh", "").replace("sz", "").replace("bj", "").zfill(6)
    if c6.startswith(("6", "9")):
        return f"sh{c6}"
    if c6.startswith(("4", "8")):
        return f"bj{c6}"
    return f"sz{c6}"


def to_em_secid(code: str) -> str:
    raw = str(code or "").strip()
    if "." in raw:
        return raw
    low = raw.lower()
    if low.startswith("sh"):
        return f"1.{low[2:].zfill(6)}"
    if low.startswith(("sz", "bj")):
        return f"0.{low[2:].zfill(6)}"
    c = low.zfill(6)
    return f"{'1' if c.startswith(('6', '9')) else '0'}.{c}"


class BoundedTTLCache(Generic[K, V]):
    """协程安全、带最大容量上限 (LRU) 与过期时间 (TTL) 的内存缓存。"""

    def __init__(self, maxsize: int = 512, default_ttl: float = 180.0) -> None:
        self._maxsize = max(1, int(maxsize))
        self._default_ttl = float(default_ttl)
        self._store: "OrderedDict[K, Tuple[float, V]]" = OrderedDict()
        self._lock = asyncio.Lock()

    async def get(self, key: K) -> Optional[V]:
        now = time.monotonic()
        async with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return None
            exp, val = entry
            if exp <= now:
                self._store.pop(key, None)
                return None
            self._store.move_to_end(key)
            return val

    async def set(self, key: K, value: V, ttl: Optional[float] = None) -> None:
        exp = time.monotonic() + (self._default_ttl if ttl is None else float(ttl))
        async with self._lock:
            self._store[key] = (exp, value)
            self._store.move_to_end(key)
            if len(self._store) > self._maxsize:
                now = time.monotonic()
                expired = [k for k, (e, _) in self._store.items() if e <= now]
                for k in expired:
                    self._store.pop(k, None)
                while len(self._store) > self._maxsize:
                    self._store.popitem(last=False)

    async def clear(self) -> None:
        async with self._lock:
            self._store.clear()

    def __len__(self) -> int:
        return len(self._store)


_KLINE_CACHE: BoundedTTLCache[Tuple[str, int, int], List[dict]] = BoundedTTLCache(maxsize=1024, default_ttl=300.0)
_QUOTE_CACHE: BoundedTTLCache[str, dict] = BoundedTTLCache(maxsize=2048, default_ttl=4.0)

# 东财 push2his 连续超时自动熔断状态（避免批量扫盘逐只卡在 15s 连接超时）
_EM_HIS_FAIL_COUNT = 0
_EM_HIS_COOLDOWN_UNTIL = 0.0


def parse_em_klines(klines: List[Any]) -> List[dict]:
    out: List[dict] = []
    for row in klines or []:
        pts = str(row).split(",")
        if len(pts) < 6:
            continue
        o = safe_float(pts[1])
        c = safe_float(pts[2])
        h = safe_float(pts[3])
        lo = safe_float(pts[4])
        vol = safe_float(pts[5])
        if c <= 0 or h <= 0 or lo <= 0:
            continue
        out.append({
            "date": pts[0][:10],
            "open": o,
            "close": c,
            "high": h,
            "low": lo,
            "vol": vol,
            "amount": safe_float(pts[6]) if len(pts) > 6 else 0.0,
            "amp": safe_float(pts[7]) if len(pts) > 7 else ((h - lo) / max(1e-6, o) * 100.0),
            "pctChg": safe_float(pts[8]) if len(pts) > 8 else None,
            "turnover": safe_float(pts[10]) if len(pts) > 10 else None,
        })
    return out


def parse_tencent_fqkline_node(jd: dict, period: str = "day") -> List[dict]:
    if not isinstance(jd, dict):
        return []
    arr = jd.get(f"qfq{period}") or jd.get(period) or []
    bars: List[dict] = []
    for row in arr:
        if not isinstance(row, list) or len(row) < 6:
            continue
        o = safe_float(row[1])
        c = safe_float(row[2])
        h = safe_float(row[3])
        lo = safe_float(row[4])
        if c <= 0 or h <= 0 or lo <= 0:
            continue
        bars.append({
            "date": str(row[0])[:10],
            "open": o,
            "close": c,
            "high": h,
            "low": lo,
            "vol": safe_float(row[5]),
            "amount": 0.0,
            "amp": ((h - lo) / max(1e-6, o) * 100.0),
            "pctChg": None,
            "turnover": None,
        })
    return bars


def _aggregate_daily_bars(daily_bars: List[dict], period: str) -> List[dict]:
    if period == "day" or not daily_bars:
        return daily_bars
    buckets: "OrderedDict[str, dict]" = OrderedDict()
    for b in daily_bars:
        dt_str = str(b.get("date") or "")[:10]
        if len(dt_str) < 10:
            continue
        if period == "month":
            bkey = dt_str[:7]
        else:
            try:
                iso_y, iso_w, _ = datetime.date.fromisoformat(dt_str).isocalendar()
                bkey = f"{iso_y}-W{iso_w:02d}"
            except Exception:
                bkey = dt_str[:7]
        cur = buckets.get(bkey)
        if cur is None:
            buckets[bkey] = {
                "date": dt_str,
                "open": b["open"],
                "close": b["close"],
                "high": b["high"],
                "low": b["low"],
                "vol": b["vol"],
                "amount": b.get("amount", 0.0),
                "amp": 0.0,
                "pctChg": None,
                "turnover": None,
            }
        else:
            cur["date"] = dt_str
            cur["close"] = b["close"]
            cur["high"] = max(cur["high"], b["high"])
            cur["low"] = min(cur["low"], b["low"])
            cur["vol"] += b["vol"]
            cur["amount"] += b.get("amount", 0.0)
    out = list(buckets.values())
    for item in out:
        item["amp"] = (item["high"] - item["low"]) / max(1e-6, item["open"]) * 100.0
    return out


async def _fetch_sina_klines(
    client: httpx.AsyncClient,
    tc: str,
    period: str = "day",
    lmt: int = 120,
) -> List[dict]:
    if not tc or tc.startswith("bj"):
        return []
    raw_len = lmt if period == "day" else (min(1000, lmt * 6) if period == "week" else min(1200, lmt * 23))
    sina_path = f"/CN_MarketDataService.getKLineData?symbol={tc}&scale=240&ma=no&datalen={raw_len}"
    sina_hosts = (
        f"https://quotes.sina.cn/cn/api/json_v2.php{sina_path}",
        f"https://money.finance.sina.com.cn/quotes_service/api/json_v2.php{sina_path}",
    )
    for u in sina_hosts:
        try:
            r = await client.get(
                u,
                headers={"Referer": "https://finance.sina.com.cn/"},
                timeout=4.5,
            )
            if r.status_code != 200:
                continue
            txt = r.text.strip()
            if not txt.startswith("["):
                continue
            arr = json.loads(txt)
            if not isinstance(arr, list) or not arr:
                continue
            bars: List[dict] = []
            for row in arr:
                if not isinstance(row, dict):
                    continue
                o = safe_float(row.get("open"))
                c = safe_float(row.get("close"))
                h = safe_float(row.get("high"))
                lo = safe_float(row.get("low"))
                vol_shares = safe_float(row.get("volume"))
                if c <= 0 or h <= 0 or lo <= 0:
                    continue
                bars.append({
                    "date": str(row.get("day") or "")[:10],
                    "open": o,
                    "close": c,
                    "high": h,
                    "low": lo,
                    "vol": round(vol_shares / 100.0, 2),
                    "amount": 0.0,
                    "amp": ((h - lo) / max(1e-6, o) * 100.0),
                    "pctChg": None,
                    "turnover": None,
                })
            if bars:
                return _aggregate_daily_bars(bars, period)[-lmt:]
        except Exception:
            continue
    return []


def build_tencent_fqkline_payload(
    tcode: str,
    period: str,
    lmt: int,
    bars: List[dict],
) -> dict:
    p = period if period in ("day", "week", "month") else "day"
    qfq_key = f"qfq{p}"
    rows = [
        [
            str(b["date"])[:10],
            f"{float(b['open']):.2f}",
            f"{float(b['close']):.2f}",
            f"{float(b['high']):.2f}",
            f"{float(b['low']):.2f}",
            f"{float(b.get('vol') or 0.0):.0f}",
        ]
        for b in (bars or [])[-max(1, int(lmt)) :]
    ]
    return {
        "code": 0,
        "msg": "",
        "data": {
            tcode: {
                qfq_key: rows,
                p: rows,
            }
        },
    }


async def fetch_em_klines(
    client: httpx.AsyncClient,
    secid: str,
    klt: int = 101,
    lmt: int = 120,
    sem: Optional[asyncio.Semaphore] = None,
    tcode_fallback: Optional[str] = None,
    ttl: float = 300.0,
) -> List[dict]:
    """统一拉取前复权 K 线（klt: 101日/102周/103月）：腾讯免 WAF 代理主用 + 东财短超时熔断 + 新浪兜底。"""
    global _EM_HIS_FAIL_COUNT, _EM_HIS_COOLDOWN_UNTIL

    cache_key = (secid, klt, lmt)
    cached = await _KLINE_CACHE.get(cache_key)
    if cached is not None:
        return cached

    p_map = {101: "day", 102: "week", 103: "month"}
    period = p_map.get(klt, "day")
    is_board = str(secid).startswith("90.")

    tc = tcode_fallback
    if not tc and not is_board:
        tc = to_tcode(secid)

    async def _try_tencent_url(u: str, req_timeout: float = 4.5) -> List[dict]:
        if not tc:
            return []
        try:
            rt = await client.get(
                u,
                headers={"Referer": "https://gu.qq.com/"},
                timeout=req_timeout,
            )
            if rt.status_code == 200 and rt.text.lstrip().startswith("{"):
                jd = (rt.json().get("data") or {}).get(tc) or {}
                return parse_tencent_fqkline_node(jd, period=period)
        except Exception:
            pass
        return []

    async def _try_eastmoney() -> List[dict]:
        global _EM_HIS_FAIL_COUNT, _EM_HIS_COOLDOWN_UNTIL
        if not is_board and time.monotonic() < _EM_HIS_COOLDOWN_UNTIL:
            return []
        url = (
            "https://push2his.eastmoney.com/api/qt/stock/kline/get"
            f"?secid={secid}&fields1=f1,f2,f3,f4,f5,f6"
            f"&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt={klt}&fqt=1&end=20500101&lmt={lmt}"
        )
        try:
            r = await client.get(
                url,
                headers={"Referer": "https://quote.eastmoney.com/"},
                timeout=3.5,
            )
            if r.status_code == 200 and r.text.lstrip().startswith("{"):
                raw = ((r.json().get("data") or {}).get("klines")) or []
                parsed = parse_em_klines(raw)
                if parsed:
                    _EM_HIS_FAIL_COUNT = 0
                    return parsed
        except Exception:
            _EM_HIS_FAIL_COUNT += 1
            if _EM_HIS_FAIL_COUNT >= 3:
                _EM_HIS_COOLDOWN_UNTIL = time.monotonic() + 120.0
        return []

    async def _do_one() -> List[dict]:
        if tc and not is_board:
            primary_qq = f"https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get?param={tc},{period},,,{lmt},qfq"
            bars = await _try_tencent_url(primary_qq, req_timeout=4.5)
            if bars:
                return bars

        bars = await _try_eastmoney()
        if bars:
            return bars

        if tc and not is_board:
            bars = await _fetch_sina_klines(client, tc, period=period, lmt=lmt)
            if bars:
                return bars
            for alt_u in (
                f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={tc},{period},,,{lmt},qfq",
                f"https://ifzq.gtimg.cn/appstock/app/fqkline/get?param={tc},{period},,,{lmt},qfq",
            ):
                bars = await _try_tencent_url(alt_u, req_timeout=3.0)
                if bars:
                    return bars
        return []

    if sem is not None:
        async with sem:
            bars = await _do_one()
    else:
        bars = await _do_one()

    if bars:
        await _KLINE_CACHE.set(cache_key, bars, ttl=ttl)
    return bars


async def fetch_kline_rows(
    client: httpx.AsyncClient,
    code_or_tcode: str,
    lmt: int = 120,
    sem: Optional[asyncio.Semaphore] = None,
    ttl: float = 180.0,
) -> List[list]:
    """返回 [date, open, close, high, low, vol] 格式前复权日K，兼容 diagnosis.py 与 strong_herd.py。"""
    tc = to_tcode(code_or_tcode)
    em_secid = to_em_secid(tc)
    bars = await fetch_em_klines(client, em_secid, klt=101, lmt=lmt, sem=sem, tcode_fallback=tc, ttl=ttl)
    return [
        [b["date"], str(b["open"]), str(b["close"]), str(b["high"]), str(b["low"]), str(b["vol"])]
        for b in bars
    ]


async def fetch_batch_quotes(
    client: httpx.AsyncClient,
    codes: List[str],
    ttl: float = 4.0,
) -> Dict[str, dict]:
    """批量拉取多只 A 股腾讯实时行情（60只/批 + 短周期带上限缓存）。"""
    if not codes:
        return {}
    out: Dict[str, dict] = {}
    missing: List[str] = []
    unique_codes = list(dict.fromkeys(str(c).strip().replace("sh", "").replace("sz", "").replace("bj", "").zfill(6) for c in codes if c))

    for c in unique_codes:
        hit = await _QUOTE_CACHE.get(c)
        if hit is not None:
            out[c] = hit
        else:
            missing.append(c)

    for i in range(0, len(missing), 60):
        chunk = missing[i : i + 60]
        q_str = ",".join(to_tcode(c) for c in chunk)
        try:
            r = await client.get(f"https://qt.gtimg.cn/q={q_str}")
            if r.status_code != 200:
                continue
            for line in r.text.split(";"):
                if "~" not in line:
                    continue
                parts = line.split("~")
                if len(parts) <= 45:
                    continue
                code = str(parts[2]).strip().zfill(6)
                name = str(parts[1]).strip()
                px = safe_float(parts[3])
                prev_close = safe_float(parts[4])
                if px <= 0:
                    continue
                item = {
                    "code": code,
                    "tcode": to_tcode(code),
                    "name": name,
                    "price": round(px, 2),
                    "prevClose": round(prev_close, 2),
                    "open": round(safe_float(parts[5], px), 2),
                    "high": round(safe_float(parts[33], px), 2),
                    "low": round(safe_float(parts[34], px), 2),
                    "chg": round(safe_float(parts[32]), 2),
                    "amount": safe_float(parts[37]) * 10000.0,
                    "turnover": round(safe_float(parts[38]), 2),
                    "mcap": safe_float(parts[45]) * 1.0e8,
                    "vr": round(safe_float(parts[49], 1.0), 2) if len(parts) > 49 else 1.0,
                }
                out[code] = item
                await _QUOTE_CACHE.set(code, item, ttl=ttl)
        except Exception:
            continue
    return out
