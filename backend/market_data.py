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
    c6 = c.zfill(6)
    if c6.startswith(("6", "9")):
        return f"sh{c6}"
    if c6.startswith(("4", "8")):
        return f"bj{c6}"
    return f"sz{c6}"


def to_em_secid(code: str) -> str:
    raw = str(code or "").strip()
    if "." in raw:
        return raw
    c = raw.lower().replace("sh", "").replace("sz", "").replace("bj", "").zfill(6)
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


async def fetch_em_klines(
    client: httpx.AsyncClient,
    secid: str,
    klt: int = 101,
    lmt: int = 120,
    sem: Optional[asyncio.Semaphore] = None,
    tcode_fallback: Optional[str] = None,
    ttl: float = 300.0,
) -> List[dict]:
    """统一拉取东方财富前复权 K 线（klt: 101日/102周/103月），失败自动回退腾讯多节点。"""
    cache_key = (secid, klt, lmt)
    cached = await _KLINE_CACHE.get(cache_key)
    if cached is not None:
        return cached

    url = (
        "https://push2his.eastmoney.com/api/qt/stock/kline/get"
        f"?secid={secid}&fields1=f1,f2,f3,f4,f5,f6"
        f"&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt={klt}&fqt=1&end=20500101&lmt={lmt}"
    )

    async def _do_one() -> List[dict]:
        try:
            r = await client.get(url, headers={"Referer": "https://quote.eastmoney.com/"})
            if r.status_code == 200 and r.text.lstrip().startswith("{"):
                raw = ((r.json().get("data") or {}).get("klines")) or []
                parsed = parse_em_klines(raw)
                if parsed:
                    return parsed
        except Exception:
            pass

        tc = tcode_fallback
        if not tc and ("." in secid) and not secid.startswith("90."):
            c_part = secid.split(".")[-1]
            if len(c_part) == 6 and c_part.isdigit():
                tc = to_tcode(c_part)

        if tc:
            p_map = {101: "day", 102: "week", 103: "month"}
            period = p_map.get(klt, "day")
            urls = [
                f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={tc},{period},,,{lmt},qfq",
                f"https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get?param={tc},{period},,,{lmt},qfq",
                f"https://ifzq.gtimg.cn/appstock/app/fqkline/get?param={tc},{period},,,{lmt},qfq",
            ]
            for u in urls:
                try:
                    rt = await client.get(u, headers={"Referer": "https://gu.qq.com/"})
                    if rt.status_code == 200 and rt.text.lstrip().startswith("{"):
                        jd = (rt.json().get("data") or {}).get(tc) or {}
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
                                "amp": 0.0,
                                "pctChg": None,
                                "turnover": None,
                            })
                        if bars:
                            return bars
                except Exception:
                    continue
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
    em_secid = to_em_secid(code_or_tcode)
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
