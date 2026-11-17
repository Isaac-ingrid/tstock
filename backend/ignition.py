from __future__ import annotations

import asyncio
import datetime
import json
import os
import re
import time
import urllib.parse
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx

from .diagnosis import classify_announcement
from .strong_herd import (
    NOISE_CONCEPT_KEYWORDS,
    _fetch_batch_quotes,
    _sf,
    _shift_date_str,
    _to_tcode,
    is_mainboard_10cm,
)

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
IGNITION_CACHE_FILE = DATA_DIR / "ignition_latest.json"
STRATEGY_LEDGER_FILE = DATA_DIR / "strategy_ledger.json"

_CACHE_LOCK = asyncio.Lock()
_RESULT_CACHE: Dict[str, Tuple[float, dict]] = {}
_KLINE_CACHE: Dict[Tuple[str, int, int], Tuple[float, List[dict]]] = {}
_ZT_DAY_CACHE: Dict[str, Tuple[float, List[dict]]] = {}
_NOTICE_CACHE: Dict[str, Tuple[float, dict]] = {}
_BOARD_LIST_CACHE: Dict[str, Tuple[float, List[dict]]] = {}
_US_CACHE: Dict[str, Tuple[float, List[dict]]] = {}

RESULT_TTL = 150.0
KLINE_TTL = 300.0
ZT_DAY_TTL = 3600.0
NOTICE_TTL = 1800.0
BOARD_LIST_TTL = 1800.0
US_TTL = 180.0

EXTRA_NOISE_BOARDS = (
    "科技风格",
    "活跃股",
    "高换手",
    "反转股",
    "趋势股",
    "次新股",
    "基金重仓",
    "机构重仓",
    "股权转让",
    "央企国企改革",
    "昨日高换手",
    "微盘",
    "标准普尔",
)

# 内置「美股/外盘风向标 <-> A股概念板块」映射表，供方向二「利空抗跌抄底」扫描联动
DEFAULT_US_A_MAPPINGS: List[dict] = [
    {
        "themeId": "cpo",
        "themeName": "CPO / 光模块",
        "usSymbols": [
            {"secid": "105.NVDA", "symbol": "NVDA", "label": "英伟达"},
            {"secid": "106.COHR", "symbol": "COHR", "label": "Coherent"},
            {"secid": "105.LITE", "symbol": "LITE", "label": "Lumentum"},
            {"secid": "105.AVGO", "symbol": "AVGO", "label": "博通"},
        ],
        "boardKeywords": ["CPO", "光通信", "光纤"],
    },
    {
        "themeId": "ai_chip",
        "themeName": "AI算力 / 半导体",
        "usSymbols": [
            {"secid": "105.AMD", "symbol": "AMD", "label": "AMD"},
            {"secid": "106.TSM", "symbol": "TSM", "label": "台积电"},
            {"secid": "105.MU", "symbol": "MU", "label": "美光科技"},
            {"secid": "105.NVDA", "symbol": "NVDA", "label": "英伟达"},
        ],
        "boardKeywords": ["半导体", "算力", "高带宽内存", "存储芯片"],
    },
    {
        "themeId": "robotics",
        "themeName": "人形机器人 / 智驾",
        "usSymbols": [
            {"secid": "105.TSLA", "symbol": "TSLA", "label": "特斯拉"},
        ],
        "boardKeywords": ["人形机器人", "机器人执行器", "无人驾驶", "汽车热管理"],
    },
    {
        "themeId": "apple_chain",
        "themeName": "消费电子 / 果链",
        "usSymbols": [
            {"secid": "105.AAPL", "symbol": "AAPL", "label": "苹果"},
        ],
        "boardKeywords": ["消费电子", "苹果", "AI手机"],
    },
    {
        "themeId": "new_energy",
        "themeName": "锂电 / 光伏储能",
        "usSymbols": [
            {"secid": "105.ENPH", "symbol": "ENPH", "label": "Enphase"},
            {"secid": "105.TSLA", "symbol": "TSLA", "label": "特斯拉"},
        ],
        "boardKeywords": ["锂电池", "光伏", "固态电池", "储能"],
    },
    {
        "themeId": "metals_oil",
        "themeName": "黄金 / 有色资源",
        "usSymbols": [
            {"secid": "106.NEM", "symbol": "NEM", "label": "纽蒙特矿业"},
            {"secid": "106.FCX", "symbol": "FCX", "label": "自由港铜业"},
        ],
        "boardKeywords": ["黄金", "有色", "贵金属", "铜缆"],
    },
]


def _is_noise_board(name: str) -> bool:
    s = str(name or "").strip()
    if not s:
        return True
    return any(k in s for k in NOISE_CONCEPT_KEYWORDS) or any(k in s for k in EXTRA_NOISE_BOARDS)


def _save_latest_sync(payload: dict) -> None:
    b_count = len((payload.get("breakout") or {}).get("items") or [])
    d_count = len((payload.get("dipLeaders") or {}).get("items") or [])
    if b_count == 0 and d_count == 0:
        # 绝不将 0 结果的空数据或限流响应覆盖已有优质本地快照
        return
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp_path = IGNITION_CACHE_FILE.with_suffix(".json.tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, IGNITION_CACHE_FILE)


def load_saved_ignition() -> Optional[dict]:
    """读取最近一次持久化落盘的起爆挖掘结果（供策略战绩快照离线建档）。"""
    if not IGNITION_CACHE_FILE.exists():
        return None
    try:
        with IGNITION_CACHE_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else None
    except Exception:
        return None


def _parse_em_klines(klines: List[Any]) -> List[dict]:
    out: List[dict] = []
    for row in klines:
        pts = str(row).split(",")
        if len(pts) < 6:
            continue
        o = _sf(pts[1])
        c = _sf(pts[2])
        h = _sf(pts[3])
        lo = _sf(pts[4])
        vol = _sf(pts[5])
        if c <= 0 or h <= 0 or lo <= 0:
            continue
        out.append({
            "date": pts[0][:10],
            "open": o,
            "close": c,
            "high": h,
            "low": lo,
            "vol": vol,
            "amount": _sf(pts[6]) if len(pts) > 6 else 0.0,
            "amp": _sf(pts[7]) if len(pts) > 7 else ((h - lo) / max(1e-6, o) * 100.0),
            "pctChg": _sf(pts[8]) if len(pts) > 8 else None,
            "turnover": _sf(pts[10]) if len(pts) > 10 else None,
        })
    return out


async def _fetch_em_klines(
    client: httpx.AsyncClient,
    secid: str,
    klt: int,
    lmt: int,
    sem: Optional[asyncio.Semaphore] = None,
    tcode_fallback: Optional[str] = None,
) -> List[dict]:
    """拉取东方财富前复权K线（klt: 101日/102周/103月），日K失败时自动回退腾讯。"""
    cache_key = (secid, klt, lmt)
    now_ts = time.monotonic()
    async with _CACHE_LOCK:
        cached = _KLINE_CACHE.get(cache_key)
        if cached and cached[0] > now_ts:
            return cached[1]

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
                parsed = _parse_em_klines(raw)
                if parsed:
                    return parsed
        except Exception:
            pass

        tc = tcode_fallback
        if not tc and ("." in secid) and not secid.startswith("90."):
            c_part = secid.split(".")[-1]
            if len(c_part) == 6 and c_part.isdigit():
                tc = _to_tcode(c_part)

        if tc:
            p_map = {101: "day", 102: "week", 103: "month"}
            period = p_map.get(klt, "day")
            urls = [
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
                            bars.append({
                                "date": str(row[0])[:10],
                                "open": _sf(row[1]),
                                "close": _sf(row[2]),
                                "high": _sf(row[3]),
                                "low": _sf(row[4]),
                                "vol": _sf(row[5]),
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
        async with _CACHE_LOCK:
            _KLINE_CACHE[cache_key] = (now_ts + KLINE_TTL, bars)
    return bars


async def _fetch_stock_notice_risk(
    client: httpx.AsyncClient,
    code: str,
    sem: asyncio.Semaphore,
) -> dict:
    """拉取个股近35天公告排雷状态，复用 diagnosis.classify_announcement 口径。"""
    now_ts = time.monotonic()
    async with _CACHE_LOCK:
        cached = _NOTICE_CACHE.get(code)
        if cached and cached[0] > now_ts:
            return cached[1]

    url = f"https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=25&page_index=1&ann_type=A&stock_list={code}"
    red_flags: List[dict] = []
    yellow_alerts: List[dict] = []
    async with sem:
        try:
            r = await client.get(url, headers={"Referer": "https://data.eastmoney.com/"})
            if r.status_code == 200 and r.text.lstrip().startswith("{"):
                items = ((r.json().get("data") or {}).get("list")) or []
                today_dt = datetime.date.today()
                for item in items:
                    title = str(item.get("title") or "")
                    n_date_str = str(item.get("notice_date") or "")[:10]
                    is_recent = False
                    try:
                        is_recent = (today_dt - datetime.date.fromisoformat(n_date_str)).days <= 35
                    except Exception:
                        is_recent = False
                    if not is_recent:
                        continue
                    level, tag = classify_announcement(title)
                    entry = {"date": n_date_str, "title": title, "tag": tag}
                    if level == "red":
                        red_flags.append(entry)
                    elif level == "yellow":
                        yellow_alerts.append(entry)
        except Exception:
            pass

    risk_level = "高风险" if red_flags else ("留意" if yellow_alerts else "安全")
    res = {
        "riskLevel": risk_level,
        "redFlags": red_flags[:3],
        "yellowAlerts": yellow_alerts[:3],
    }
    async with _CACHE_LOCK:
        _NOTICE_CACHE[code] = (now_ts + NOTICE_TTL, res)
    return res


def _sma(vals: List[float], period: int) -> Optional[float]:
    if len(vals) < period or period <= 0:
        return None
    w = vals[-period:]
    return sum(w) / len(w)


def _daily_pct_chg(bars: List[dict], idx: int) -> float:
    b = bars[idx]
    if b.get("pctChg") is not None:
        return float(b["pctChg"])
    if idx > 0 and bars[idx - 1]["close"] > 0:
        return ((b["close"] - bars[idx - 1]["close"]) / bars[idx - 1]["close"]) * 100.0
    return ((b["close"] - b["open"]) / max(1e-6, b["open"])) * 100.0


def _is_zt_bar(bars: List[dict], idx: int, code: str) -> bool:
    pct = _daily_pct_chg(bars, idx)
    thresh = 19.2 if code.startswith(("30", "688")) else 9.4
    b = bars[idx]
    return pct >= thresh and b["close"] >= b["high"] * 0.992


def _eval_daily_breakout_precheck(
    code: str,
    daily_bars: List[dict],
    lookback_days: int,
) -> Optional[dict]:
    """方向一第一阶段：从日K定位最近一次试盘涨停，并核验横盘底座、涨停后缩量及均线形态。"""
    n = len(daily_bars)
    if n < 35:
        return None

    # 寻找最近 2 ~ lookback_days 个交易日内出现的试盘涨停（留至少2天观察缩量）
    min_idx = max(15, n - lookback_days - 2)
    max_idx = n - 3
    zt_idx = -1
    for i in range(max_idx, min_idx - 1, -1):
        if _is_zt_bar(daily_bars, i, code):
            zt_idx = i
            break
    if zt_idx < 0:
        return None

    zt_bar = daily_bars[zt_idx]
    post = daily_bars[zt_idx + 1 :]
    bars_after_zt = len(post)
    if bars_after_zt < 2:
        return None

    # 涨停前横盘底座区间（最多回看35天）
    pre_slice = daily_bars[max(0, zt_idx - 35) : zt_idx]
    if len(pre_slice) < 12:
        return None
    pre_hi = max(b["high"] for b in pre_slice)
    pre_lo = min(b["low"] for b in pre_slice)
    pre_box_amp = ((pre_hi - pre_lo) / max(1e-6, pre_lo)) * 100.0
    pre_mid = (pre_hi + pre_lo) / 2.0
    zt_prev_close = daily_bars[zt_idx - 1]["close"]
    early_min = min(b["low"] for b in pre_slice[: min(10, len(pre_slice))])
    pre_runup = ((zt_prev_close - early_min) / max(1e-6, early_min)) * 100.0

    # 剔除试盘前已经暴涨主升过的鱼尾标（预拉超过55%不属于“长时间横盘试水”）
    if pre_runup > 55.0:
        return None

    # 涨停后缩量核验
    cur_bar = daily_bars[-1]
    cur_close = cur_bar["close"]
    zt_vol = max(1.0, zt_bar["vol"])
    recent_post = post[-min(3, len(post)) :]
    recent_avg_vol = sum(b["vol"] for b in recent_post) / len(recent_post)
    vol_shrink_ratio = recent_avg_vol / zt_vol

    # 连续缩量/逐步递减判断
    first_half_avg = sum(b["vol"] for b in post[: max(1, len(post) // 2)]) / max(1, len(post) // 2)
    is_gradual_shrink = (vol_shrink_ratio <= 0.72) or (recent_avg_vol < first_half_avg * 0.85 and vol_shrink_ratio <= 0.85)
    if vol_shrink_ratio > 0.88:
        return None

    # 支撑防守检验：不能有效跌破试盘涨停当日起点
    support_floor = min(zt_bar["open"], zt_bar["low"])
    if cur_close < support_floor * 0.965:
        return None

    closes = [b["close"] for b in daily_bars]
    ma5 = _sma(closes, 5) or cur_close
    ma10 = _sma(closes, 10) or cur_close
    ma20 = _sma(closes, 20) or cur_close
    ma_spread_pct = ((max(ma5, ma10, ma20) - min(ma5, ma10, ma20)) / max(1e-6, cur_close)) * 100.0
    bias_ma5 = ((cur_close - ma5) / max(1e-6, ma5)) * 100.0
    gain_since_zt = ((cur_close - zt_bar["close"]) / max(1e-6, zt_bar["close"])) * 100.0
    dist_to_start_pct = ((cur_close - support_floor) / max(1e-6, support_floor)) * 100.0

    # 统计近5日量能连续递减天数
    shrink_streak = 0
    for idx in range(n - 1, max(zt_idx + 1, n - 7), -1):
        if daily_bars[idx]["vol"] <= daily_bars[idx - 1]["vol"] * 1.05:
            shrink_streak += 1
        else:
            break

    # 20日箱体位置
    box20 = daily_bars[-20:]
    b20_hi = max(b["high"] for b in box20)
    b20_lo = min(b["low"] for b in box20)
    box_pos_pct = ((cur_close - b20_lo) / max(1e-6, b20_hi - b20_lo)) * 100.0

    # 识别「震仓特征」：盘中吓人砸穿均线收回长下影 / 破位阴线迅速反包 / 极缩地量小阳抬头
    shakeout_signals: List[str] = []
    scan_tail = post[-min(6, len(post)) :]
    for j, bar in enumerate(scan_tail):
        rng = max(1e-6, bar["high"] - bar["low"])
        lower_shadow_ratio = (min(bar["open"], bar["close"]) - bar["low"]) / rng
        if bar["low"] <= min(ma10, ma20) * 1.008 and lower_shadow_ratio >= 0.38 and bar["close"] >= bar["open"] * 0.99:
            if "下影探底收回" not in shakeout_signals:
                shakeout_signals.append("下影探底收回")
        if j >= 1:
            prev_b = scan_tail[j - 1]
            prev_chg = ((prev_b["close"] - prev_b["open"]) / max(1e-6, prev_b["open"])) * 100.0
            if prev_chg <= -1.8 and prev_b["low"] <= ma10 * 1.005 and bar["close"] > prev_b["open"] * 0.995:
                if "砸破阴线反包" not in shakeout_signals:
                    shakeout_signals.append("砸破阴线反包")

    cur_pct = _daily_pct_chg(daily_bars, n - 1)
    if vol_shrink_ratio <= 0.48 and 0.3 <= cur_pct <= 6.2 and cur_close >= ma5 * 0.995:
        shakeout_signals.append("地量小阳抬头")

    return {
        "ztDate": zt_bar["date"],
        "daysSinceZt": bars_after_zt,
        "ztClose": round(zt_bar["close"], 2),
        "supportFloor": round(support_floor, 2),
        "distToStartPct": round(dist_to_start_pct, 2),
        "gainSinceZt": round(gain_since_zt, 2),
        "preBoxAmp": round(pre_box_amp, 1),
        "preRunup": round(pre_runup, 1),
        "volShrinkRatio": round(vol_shrink_ratio, 2),
        "volShrinkPct": round(vol_shrink_ratio * 100.0, 1),
        "isGradualShrink": is_gradual_shrink,
        "shrinkStreak": shrink_streak,
        "ma5": round(ma5, 2),
        "ma10": round(ma10, 2),
        "ma20": round(ma20, 2),
        "maSpreadPct": round(ma_spread_pct, 2),
        "biasMa5": round(bias_ma5, 2),
        "boxPosPct": round(box_pos_pct, 1),
        "shakeoutSignals": shakeout_signals,
        "curDayChg": round(cur_pct, 2),
        "_preMid": pre_mid,
    }


def _eval_weekly_monthly(
    daily_bars: List[dict],
    weekly_bars: List[dict],
    monthly_bars: List[dict],
) -> Optional[dict]:
    """方向一第二阶段：校验月线放量底色与周线向上趋势。"""
    if len(weekly_bars) < 10 or len(monthly_bars) < 4:
        return None

    w_closes = [b["close"] for b in weekly_bars]
    w_cur = w_closes[-1]
    w_ma5 = _sma(w_closes, 5) or w_cur
    w_ma10 = _sma(w_closes, 10) or w_cur
    w_ma5_prev = _sma(w_closes[:-1], 5) or w_ma5
    w_ma10_prev = _sma(w_closes[:-1], 10) or w_ma10

    w_low_recent = min(b["low"] for b in weekly_bars[-4:])
    w_low_prior = min(b["low"] for b in weekly_bars[-10:-4]) if len(weekly_bars) >= 10 else w_low_recent
    weekly_higher_low = w_low_recent >= w_low_prior * 0.97
    weekly_up = (
        w_cur >= w_ma10 * 0.985
        and (w_ma5 >= w_ma10 * 0.985 or w_ma5 > w_ma5_prev)
        and (w_ma5 >= w_ma5_prev * 0.995 or w_ma10 >= w_ma10_prev * 0.995)
    )
    if not weekly_up:
        return None

    if w_ma5 > w_ma10 and w_ma5 > w_ma5_prev:
        weekly_desc = "周MA5>MA10多头"
    elif w_cur > w_ma10 and w_ma5 > w_ma5_prev:
        weekly_desc = "周线MA5上拐"
    else:
        weekly_desc = "周MA10上方震荡"

    # 月线放量测算：当月按已交易日折算全月成交量，并与上月取较大者对比前 3~6 个月均量
    cur_ym = monthly_bars[-1]["date"][:7]
    cur_m_trading_days = max(1, sum(1 for b in daily_bars if b["date"][:7] == cur_ym))
    cur_m_scaled_vol = monthly_bars[-1]["vol"] * max(1.0, 21.0 / min(21, cur_m_trading_days))
    prev_full_m_vol = monthly_bars[-2]["vol"]
    recent_m_peak = max(cur_m_scaled_vol, prev_full_m_vol)

    base_slice = monthly_bars[-7:-2] if len(monthly_bars) >= 7 else monthly_bars[:-2]
    if not base_slice:
        base_slice = monthly_bars[:-1]
    base_avg_vol = sum(b["vol"] for b in base_slice) / max(1, len(base_slice))
    month_vol_ratio = recent_m_peak / max(1.0, base_avg_vol)

    # 月线近15月价位分位，防高位派发陷阱
    m_hi = max(b["high"] for b in monthly_bars)
    m_lo = min(b["low"] for b in monthly_bars)
    m_pos_pct = ((w_cur - m_lo) / max(1e-6, m_hi - m_lo)) * 100.0

    month_vol_ok = month_vol_ratio >= 1.25
    if not month_vol_ok:
        return None

    return {
        "monthVolRatio": round(month_vol_ratio, 2),
        "monthPricePosPct": round(m_pos_pct, 1),
        "monthHighWarn": m_pos_pct >= 88.0,
        "weeklyUp": weekly_up,
        "weeklyHigherLow": weekly_higher_low,
        "weeklyTrendDesc": weekly_desc,
        "wMa5": round(w_ma5, 2),
        "wMa10": round(w_ma10, 2),
    }


def _classify_and_score_ignition(pre: dict, wm: dict) -> dict:
    """结合日线震仓/粘合信号与月周底色，划分阶段标签并打分。"""
    bias_ma5 = pre["biasMa5"]
    gain_zt = pre["gainSinceZt"]
    ma_spread = pre["maSpreadPct"]
    shrink_r = pre["volShrinkRatio"]
    shakeouts = pre["shakeoutSignals"]

    if bias_ma5 > 5.0 or gain_zt > 15.0:
        stage = "PULLBACK_RISK"
        stage_label = "⚠️ 急拉防回调"
        stage_tip = f"试盘后偏离5日线 +{bias_ma5:.1f}%，短线获利盘较重，等回踩粘合均线消化抛压再低吸"
        stage_bonus = -8
    elif shakeouts and shrink_r <= 0.68 and ma_spread <= 8.0:
        stage = "SHAKEOUT_READY"
        stage_label = "🔥 震仓完成·待起爆"
        stage_tip = f"存在【{'/'.join(shakeouts)}】震仓动作且缩量至板 {pre['volShrinkPct']:.0f}%，二次起爆概率高"
        stage_bonus = 16
    elif ma_spread <= 4.8 and shrink_r <= 0.68:
        stage = "CONVERGED_WAIT"
        stage_label = "⏳ 均线粘合·缩量蓄势"
        stage_tip = f"MA5/10/20 极差仅 {ma_spread:.1f}% + 缩量洗盘中，盯紧放量中阳启动信号"
        stage_bonus = 10
    else:
        stage = "DIGESTING"
        stage_label = "👀 试盘缩量消化"
        stage_tip = "涨停试水后缩量回踩整理，观察是否出现下影震仓或均线进一步收拢"
        stage_bonus = 4

    s_month = 26 if wm["monthVolRatio"] >= 1.8 else (22 if wm["monthVolRatio"] >= 1.4 else 17)
    s_week = 22 if (wm["weeklyUp"] and wm["weeklyHigherLow"]) else 17
    if shrink_r <= 0.40:
        s_shrink = 25
    elif shrink_r <= 0.55:
        s_shrink = 21
    elif shrink_r <= 0.70:
        s_shrink = 16
    else:
        s_shrink = 10
    s_box = 14 if pre["preBoxAmp"] <= 24.0 else (10 if pre["preBoxAmp"] <= 34.0 else 5)
    s_high_pen = -8 if wm["monthHighWarn"] else 0

    score = max(20, min(99, s_month + s_week + s_shrink + s_box + stage_bonus + s_high_pen))

    return {
        "stage": stage,
        "stageLabel": stage_label,
        "stageTip": stage_tip,
        "ignitionScore": score,
    }


async def _fetch_zt_pool_day(
    client: httpx.AsyncClient,
    date_str: str,
    sem: asyncio.Semaphore,
) -> Tuple[str, List[dict]]:
    """拉取东财指定交易日涨停池（不因响应头 qdate 仍打印最新日期而丢弃历史池）。"""
    now_ts = time.monotonic()
    async with _CACHE_LOCK:
        cached = _ZT_DAY_CACHE.get(date_str)
        if cached and cached[0] > now_ts:
            return date_str, cached[1]

    url = (
        "https://push2ex.eastmoney.com/getTopicZTPool"
        f"?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=180&sort=lbc:desc&date={date_str}"
    )
    pool: List[dict] = []
    async with sem:
        try:
            r = await client.get(url, headers={"Referer": "https://quote.eastmoney.com/"})
            if r.status_code == 200 and r.text.lstrip().startswith("{"):
                j = r.json()
                if j.get("rc") == 0 and isinstance(j.get("data"), dict):
                    raw = j["data"].get("pool") or []
                    if isinstance(raw, list) and raw:
                        pool = raw
        except Exception:
            pool = []

    if pool:
        async with _CACHE_LOCK:
            _ZT_DAY_CACHE[date_str] = (now_ts + ZT_DAY_TTL, pool)
    return date_str, pool


async def scan_breakout_ignition(
    http_client: httpx.AsyncClient,
    include_cyb: bool = False,
    lookback_days: int = 20,
) -> dict:
    """
    方向一：多周期共振「横盘试盘起爆」全市场漏斗挖掘。
    1. 拉取近 N 日涨停池作为种子（默认仅 00/60 主板，include_cyb=True 纳入 30/688）；
    2. 腾讯批量快照过滤 ST / 停牌 / 流动性极差股；
    3. 日K筛选“横向试盘板后逐步缩量、未破启动位”标的；
    4. 对过日K初筛的标的并发拉取周K+月K，校验月放量+周向上并产出震仓/粘合/防回调分档。
    """
    today_str = datetime.date.today().strftime("%Y%m%d")
    cal_lookback = max(25, lookback_days + 12)
    cand_dates = [_shift_date_str(today_str, -d) for d in range(0, cal_lookback)]

    sem_zt = asyncio.Semaphore(3)
    zt_results = await asyncio.gather(
        *[_fetch_zt_pool_day(http_client, d, sem_zt) for d in cand_dates],
        return_exceptions=True,
    )

    valid_days: List[Tuple[str, List[dict]]] = []
    for item in zt_results:
        if isinstance(item, tuple) and item[1]:
            valid_days.append(item)
    valid_days.sort(key=lambda x: x[0], reverse=True)
    valid_days = valid_days[:lookback_days]

    seed_meta: Dict[str, dict] = {}
    for day_idx, (d_str, pool_rows) in enumerate(valid_days):
        for row in pool_rows:
            code = str(row.get("c") or "").strip().zfill(6)
            name = str(row.get("n") or "").strip()
            if not code.isdigit() or code.startswith(("4", "8", "92")):
                continue
            if "ST" in name.upper() or "退" in name:
                continue
            if not include_cyb and not is_mainboard_10cm(code, name):
                continue
            if code not in seed_meta:
                seed_meta[code] = {
                    "code": code,
                    "name": name,
                    "hybk": str(row.get("hybk") or "其他"),
                    "lastZtDateHint": f"{d_str[:4]}-{d_str[4:6]}-{d_str[6:8]}",
                    "ztCountRecent": 1,
                    "dayIdxHint": day_idx,
                }
            else:
                seed_meta[code]["ztCountRecent"] += 1

    # 优先取“最近涨停发生在 2~20 个交易日前”的历史试盘股，再按流动性过滤最多 220 只做日K精算
    sorted_seeds = sorted(
        seed_meta.values(),
        key=lambda x: (0 if 2 <= x["dayIdxHint"] <= 20 else 1, x["dayIdxHint"], -x["ztCountRecent"]),
    )[:240]
    seed_codes = [s["code"] for s in sorted_seeds]
    quotes = await _fetch_batch_quotes(http_client, seed_codes)

    active_codes = [
        c for c in seed_codes
        if c in quotes and quotes[c]["price"] > 0 and quotes[c]["amount"] >= 4e7
    ][:200]

    # Step 3A: 拉取日K初筛
    sem_k = asyncio.Semaphore(4)
    daily_tasks = [
        _fetch_em_klines(
            http_client,
            f"{'1' if c.startswith(('6', '9')) else '0'}.{c}",
            101,
            95,
            sem_k,
            tcode_fallback=_to_tcode(c),
        )
        for c in active_codes
    ]
    daily_res = await asyncio.gather(*daily_tasks, return_exceptions=True)

    daily_passed: List[Tuple[str, List[dict], dict]] = []
    for c, dbars in zip(active_codes, daily_res):
        if not isinstance(dbars, list) or not dbars:
            continue
        pre = _eval_daily_breakout_precheck(c, dbars, lookback_days)
        if pre is not None:
            daily_passed.append((c, dbars, pre))

    # Step 3B: 仅对通过日K缩量试盘筛查的标的拉周K+月K，大幅降低东财限流风险
    sem_wm = asyncio.Semaphore(3)

    async def _fetch_wm(code: str) -> Tuple[List[dict], List[dict]]:
        em_secid = f"{'1' if code.startswith(('6', '9')) else '0'}.{code}"
        tc = _to_tcode(code)
        w_bars, m_bars = await asyncio.gather(
            _fetch_em_klines(http_client, em_secid, 102, 26, sem_wm, tcode_fallback=tc),
            _fetch_em_klines(http_client, em_secid, 103, 15, sem_wm, tcode_fallback=tc),
        )
        return w_bars, m_bars

    wm_results = await asyncio.gather(*[_fetch_wm(c) for c, _, _ in daily_passed], return_exceptions=True)

    # Step 4: 对入选股票补充公告排雷
    qualified: List[dict] = []
    for (c, dbars, pre), wm_res in zip(daily_passed, wm_results):
        if not isinstance(wm_res, tuple):
            continue
        w_bars, m_bars = wm_res
        wm = _eval_weekly_monthly(dbars, w_bars, m_bars)
        if wm is None:
            continue
        scored = _classify_and_score_ignition(pre, wm)
        q = quotes.get(c) or {}
        s_info = seed_meta.get(c) or {}
        qualified.append({
            "code": c,
            "tcode": _to_tcode(c),
            "name": str(q.get("name") or s_info.get("name") or c).replace(" ", ""),
            "hybk": s_info.get("hybk") or "其他",
            "latestDate": dbars[-1]["date"],
            "price": round(q.get("price") or dbars[-1]["close"], 2),
            "chg": round(q.get("chg") if q.get("chg") is not None else pre["curDayChg"], 2),
            "turnover": round(q.get("turnover") or 0.0, 2),
            "amountYi": round((q.get("amount") or 0.0) / 1e8, 2),
            "mcapYi": round((q.get("mcap") or 0.0) / 1e8, 1),
            "ztCountRecent": s_info.get("ztCountRecent", 1),
            **{k: v for k, v in pre.items() if not k.startswith("_")},
            **wm,
            **scored,
        })

    # 补充公告排雷（小并发）
    sem_notice = asyncio.Semaphore(4)
    notice_list = await asyncio.gather(
        *[_fetch_stock_notice_risk(http_client, item["code"], sem_notice) for item in qualified[:45]],
        return_exceptions=True,
    )
    for idx, nres in enumerate(notice_list):
        if isinstance(nres, dict):
            qualified[idx].update(nres)

    stage_order = {"SHAKEOUT_READY": 0, "CONVERGED_WAIT": 1, "DIGESTING": 2, "PULLBACK_RISK": 3}
    qualified.sort(
        key=lambda x: (
            1 if x.get("riskLevel") == "高风险" else 0,
            stage_order.get(x["stage"], 9),
            -x["ignitionScore"],
            x["volShrinkRatio"],
        )
    )

    counts = {
        "total": len(qualified),
        "shakeoutReady": sum(1 for x in qualified if x["stage"] == "SHAKEOUT_READY"),
        "convergedWait": sum(1 for x in qualified if x["stage"] == "CONVERGED_WAIT"),
        "digesting": sum(1 for x in qualified if x["stage"] == "DIGESTING"),
        "pullbackRisk": sum(1 for x in qualified if x["stage"] == "PULLBACK_RISK"),
    }
    return {
        "items": qualified[:50],
        "stats": {
            "seedCount": len(seed_meta),
            "dailyPassedCount": len(daily_passed),
            "counts": counts,
            "includeCyb": include_cyb,
            "lookbackDays": lookback_days,
        },
    }


async def _fetch_us_benchmarks(
    client: httpx.AsyncClient,
    mappings: List[dict],
) -> Tuple[List[dict], Dict[str, dict]]:
    """拉取美股/外盘风向标实时或最近收盘涨跌幅，并与 A 股题材绑定。"""
    secids: List[str] = []
    sym_to_secid: Dict[str, str] = {}
    for m in mappings:
        for u in m.get("usSymbols") or []:
            sid = str(u.get("secid") or "").strip()
            sym = str(u.get("symbol") or "").strip().upper()
            if not sid and sym:
                # 自定义美股代码自动构造 105.(纳斯达克) 和 106.(纽交所) 探测候选
                sid = f"105.{sym}"
                sym_to_secid[f"106.{sym}"] = f"106.{sym}"
                secids.append(f"106.{sym}")
            if sid:
                secids.append(sid)
                sym_to_secid[sid] = sid

    unique_secids = list(dict.fromkeys(secids))
    cache_key = ",".join(sorted(unique_secids))
    now_ts = time.monotonic()

    quotes_by_secid: Dict[str, dict] = {}
    async with _CACHE_LOCK:
        cached = _US_CACHE.get(cache_key)
        if cached and cached[0] > now_ts:
            quotes_by_secid = {q["secid"]: q for q in cached[1]}

    if not quotes_by_secid and unique_secids:
        url = (
            "https://push2.eastmoney.com/api/qt/ulist.np/get"
            f"?fltt=2&invt=2&fields=f12,f13,f14,f2,f3,f4,f15,f16,f17,f18&secids={','.join(unique_secids)}"
        )
        try:
            r = await client.get(url, headers={"Referer": "https://quote.eastmoney.com/"})
            if r.status_code == 200 and r.text.lstrip().startswith("{"):
                for row in ((r.json().get("data") or {}).get("diff")) or []:
                    mkt = row.get("f13")
                    sym = str(row.get("f12") or "").strip().upper()
                    sid = f"{mkt}.{sym}"
                    px = _sf(row.get("f2"))
                    chg = _sf(row.get("f3"), None)
                    if px <= 0 or chg is None:
                        continue
                    quotes_by_secid[sid] = {
                        "secid": sid,
                        "symbol": sym,
                        "name": str(row.get("f14") or sym),
                        "price": round(px, 2),
                        "chg": round(float(chg), 2),
                    }
        except Exception:
            pass

        if quotes_by_secid:
            async with _CACHE_LOCK:
                _US_CACHE[cache_key] = (now_ts + US_TTL, list(quotes_by_secid.values()))

    radar_cards: List[dict] = []
    theme_shocks: Dict[str, dict] = {}
    for m in mappings:
        matched_quotes: List[dict] = []
        for u in m.get("usSymbols") or []:
            sym = str(u.get("symbol") or "").strip().upper()
            sid = str(u.get("secid") or "").strip()
            q = (
                quotes_by_secid.get(sid)
                or quotes_by_secid.get(f"105.{sym}")
                or quotes_by_secid.get(f"106.{sym}")
            )
            if q:
                matched_quotes.append({**q, "label": u.get("label") or q["name"]})

        if matched_quotes:
            min_q = min(matched_quotes, key=lambda x: x["chg"])
            avg_chg = round(sum(x["chg"] for x in matched_quotes) / len(matched_quotes), 2)
            min_chg = min_q["chg"]
            alert = "BIG_DROP" if min_chg <= -3.0 else ("MOD_DROP" if min_chg <= -1.5 else "NORMAL")
            info = {
                "themeId": m["themeId"],
                "themeName": m["themeName"],
                "boardKeywords": m.get("boardKeywords") or [],
                "usMinChg": min_chg,
                "usAvgChg": avg_chg,
                "worstSymbol": min_q["symbol"],
                "worstLabel": min_q["label"],
                "alertLevel": alert,
                "quotes": matched_quotes,
            }
            radar_cards.append(info)
            theme_shocks[m["themeId"]] = info

    return radar_cards, theme_shocks


async def _fetch_all_boards(client: httpx.AsyncClient) -> List[dict]:
    """拉取东财概念+行业板块（按 pz=100 分页 + 60日/年内跌幅榜排序），解决东财单页100截断限制。"""
    now_ts = time.monotonic()
    async with _CACHE_LOCK:
        cached = _BOARD_LIST_CACHE.get("all")
        if cached and cached[0] > now_ts:
            return cached[1]

    queries: List[Tuple[str, str]] = [
        ("concept", "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=0&np=1&fltt=2&invt=2&fid=f24&fs=m:90+t:3+f:!50&fields=f12,f14,f2,f3,f20,f24,f25"),
        ("concept", "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=0&np=1&fltt=2&invt=2&fid=f25&fs=m:90+t:3+f:!50&fields=f12,f14,f2,f3,f20,f24,f25"),
        ("industry", "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=0&np=1&fltt=2&invt=2&fid=f24&fs=m:90+t:2+f:!50&fields=f12,f14,f2,f3,f20,f24,f25"),
        ("industry", "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=0&np=1&fltt=2&invt=2&fid=f25&fs=m:90+t:2+f:!50&fields=f12,f14,f2,f3,f20,f24,f25"),
    ]
    # 补充全部概念板块各分页（531个概念分6页），确保 CPO/算力/机器人/有色等外盘映射概念全命中
    for pn in range(1, 7):
        queries.append((
            "concept",
            f"https://push2.eastmoney.com/api/qt/clist/get?pn={pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:3+f:!50&fields=f12,f14,f2,f3,f20,f24,f25",
        ))

    sem_b = asyncio.Semaphore(2)

    async def _get_page(btype: str, url: str) -> Tuple[str, Optional[httpx.Response]]:
        async with sem_b:
            try:
                r = await client.get(url, headers={"Referer": "https://quote.eastmoney.com/"})
                return btype, r
            except Exception:
                return btype, None

    resps = await asyncio.gather(*[_get_page(bt, u) for bt, u in queries], return_exceptions=True)

    by_code: Dict[str, dict] = {}
    for item in resps:
        if not isinstance(item, tuple):
            continue
        btype, r = item
        if r is None or r.status_code != 200 or not r.text.lstrip().startswith("{"):
            continue
        for row in ((r.json().get("data") or {}).get("diff")) or []:
            bk_code = str(row.get("f12") or "").strip()
            bk_name = str(row.get("f14") or "").strip()
            if not bk_code or _is_noise_board(bk_name):
                continue
            by_code[bk_code] = {
                "bkCode": bk_code,
                "bkName": bk_name,
                "boardType": btype,
                "price": _sf(row.get("f2")),
                "chg": round(_sf(row.get("f3")), 2),
                "chg60d": round(_sf(row.get("f24")), 2),
                "chgYtd": round(_sf(row.get("f25")), 2),
                "mcap": _sf(row.get("f20")),
            }

    out = list(by_code.values())
    if out:
        async with _CACHE_LOCK:
            _BOARD_LIST_CACHE["all"] = (now_ts + BOARD_LIST_TTL, out)
    return out


async def scan_dip_leaders(
    http_client: httpx.AsyncClient,
    sector_dd_min: float = 30.0,
    stock_dd_min: float = 40.0,
    custom_us_mappings: Optional[List[dict]] = None,
) -> dict:
    """
    方向二：板块深跌腰斩龙头 + 外部利空/板块大跌抗跌抄底挖掘。
    1. 拉取美股外盘风向标（如 NVDA/COHR/LITE/TSLA/AAPL/AMD），标出隔夜大跌线；
    2. 从东财概念+行业板块筛选 60日/年内回撤最深板块 + 外盘关联板块；
    3. 拉取板块 180日日K精准核验「距阶段高点真实回撤幅度」；
    4. 取深跌板块中成交额居前核心龙头 + 180日K + 公告排雷，计算量能枯竭比与抗跌剪刀差。
    """
    mappings = list(DEFAULT_US_A_MAPPINGS)
    if custom_us_mappings:
        for idx, cm in enumerate(custom_us_mappings):
            if cm.get("usSymbols") and cm.get("boardKeywords"):
                mappings.append({
                    "themeId": str(cm.get("themeId") or f"custom_{idx}"),
                    "themeName": str(cm.get("themeName") or "自定义映射"),
                    "usSymbols": cm["usSymbols"],
                    "boardKeywords": cm["boardKeywords"],
                })

    radar_cards, theme_shocks = await _fetch_us_benchmarks(http_client, mappings)
    all_boards = await _fetch_all_boards(http_client)

    # 给每个板块关联对应外盘映射（动态关键词匹配，避免硬编码 BK 号码漂移）
    board_shock_map: Dict[str, dict] = {}
    mapped_boards: List[dict] = []
    for b in all_boards:
        bname = b["bkName"]
        for th in theme_shocks.values():
            if any(kw.lower() in bname.lower() for kw in th["boardKeywords"]):
                existing = board_shock_map.get(b["bkCode"])
                if existing is None or th["usMinChg"] < existing["usMinChg"]:
                    board_shock_map[b["bkCode"]] = th
                if b not in mapped_boards:
                    mapped_boards.append(b)

    # 筛选待检查 180日高点回撤的候选板块池：
    # ① 60日跌幅前22名 ② 年内跌幅前15名 ③ 今日板块大跌前10名 ④ 关联美股隔夜大跌的板块
    by_60d = sorted(all_boards, key=lambda x: x["chg60d"])[:22]
    by_ytd = sorted(all_boards, key=lambda x: x["chgYtd"])[:15]
    by_today = sorted(all_boards, key=lambda x: x["chg"])[:10]
    cand_board_map: Dict[str, dict] = {}
    for b in [*by_60d, *by_ytd, *by_today, *mapped_boards]:
        cand_board_map[b["bkCode"]] = b
    cand_boards = list(cand_board_map.values())[:38]

    sem_bk = asyncio.Semaphore(4)
    bk_klines = await asyncio.gather(
        *[_fetch_em_klines(http_client, f"90.{b['bkCode']}", 101, 180, sem_bk) for b in cand_boards],
        return_exceptions=True,
    )

    qualifying_boards: List[dict] = []
    for b, bars in zip(cand_boards, bk_klines):
        shock = board_shock_map.get(b["bkCode"])
        has_us_shock = bool(shock and shock["usMinChg"] <= -2.0)

        if isinstance(bars, list) and len(bars) >= 25:
            peak_hi = max(bar["high"] for bar in bars)
            cur_close = b["price"] if b["price"] > 0 else bars[-1]["close"]
            dd_pct = ((cur_close - peak_hi) / max(1e-6, peak_hi)) * 100.0  # 负数，如 -38.5
        else:
            # 若板块历史K线受阻，使用东财板块直出的 60日/年内跌幅作为保底
            dd_pct = min(b.get("chg60d") or 0.0, b.get("chgYtd") or 0.0)

        # 入选门槛：板块真实高点回撤达标（如 >= 30%），或关联外盘暴跌且回撤 >= max(18, sector_dd_min - 12)%
        min_req = max(18.0, sector_dd_min - 12.0) if has_us_shock else sector_dd_min
        if -dd_pct >= min_req:
            qualifying_boards.append({
                **b,
                "boardDrawdownPct": round(dd_pct, 1),
                "usShock": shock,
            })

    # 优先挑回撤最深 + 带外盘冲击的板块前 12 个抽取龙头
    qualifying_boards.sort(
        key=lambda x: (
            0 if (x.get("usShock") and x["usShock"]["usMinChg"] <= -2.0) else 1,
            x["boardDrawdownPct"],
        )
    )
    top_boards = qualifying_boards[:12]

    # 拉取每个深跌板块的成交额 Top 5 龙头股
    async def _fetch_board_leaders(bk: dict) -> List[dict]:
        bk_code = bk["bkCode"]
        url = (
            "https://push2.eastmoney.com/api/qt/clist/get"
            f"?pn=1&pz=8&po=1&np=1&fltt=2&invt=2&fid=f6&fs=b:{bk_code}+f:!50"
            "&fields=f12,f14,f2,f3,f6,f8,f15,f16,f17,f18,f20,f21"
        )
        try:
            async with sem_bk:
                r = await http_client.get(url, headers={"Referer": "https://quote.eastmoney.com/"})
            if r.status_code != 200 or not r.text.lstrip().startswith("{"):
                return []
            diff = ((r.json().get("data") or {}).get("diff")) or []
            leaders: List[dict] = []
            for row in diff:
                code = str(row.get("f12") or "").strip().zfill(6)
                name = str(row.get("f14") or "").strip()
                px = _sf(row.get("f2"))
                if not code.isdigit() or code.startswith(("4", "8", "92")):
                    continue
                if "ST" in name.upper() or "退" in name or px <= 0:
                    continue
                leaders.append({
                    "code": code,
                    "name": name,
                    "price": round(px, 2),
                    "chg": round(_sf(row.get("f3")), 2),
                    "amountYi": round(_sf(row.get("f6")) / 1e8, 2),
                    "turnover": round(_sf(row.get("f8")), 2),
                    "mcapYi": round(_sf(row.get("f20")) / 1e8, 1),
                    "board": bk,
                })
                if len(leaders) >= 4:
                    break
            return leaders
        except Exception:
            return []

    leader_groups = await asyncio.gather(*[_fetch_board_leaders(b) for b in top_boards], return_exceptions=True)

    # 按股票去重，保留其归属的全部深跌板块与最重外盘利空对照
    merged_leaders: Dict[str, dict] = {}
    for grp in leader_groups:
        if not isinstance(grp, list):
            continue
        for item in grp:
            c = item["code"]
            bk = item["board"]
            entry = merged_leaders.get(c)
            if entry is None:
                entry = {
                    **{k: v for k, v in item.items() if k != "board"},
                    "tcode": _to_tcode(c),
                    "matchedBoards": [],
                    "worstBoardDd": bk["boardDrawdownPct"],
                    "worstBoardChg": bk["chg"],
                    "primaryBoardName": bk["bkName"],
                    "usShock": bk.get("usShock"),
                }
                merged_leaders[c] = entry
            entry["matchedBoards"].append({
                "bkCode": bk["bkCode"],
                "bkName": bk["bkName"],
                "boardDrawdownPct": bk["boardDrawdownPct"],
                "boardChg": bk["chg"],
            })
            if bk["boardDrawdownPct"] < entry["worstBoardDd"]:
                entry["worstBoardDd"] = bk["boardDrawdownPct"]
                entry["primaryBoardName"] = bk["bkName"]
                entry["worstBoardChg"] = bk["chg"]
            if bk.get("usShock"):
                if not entry["usShock"] or bk["usShock"]["usMinChg"] < entry["usShock"]["usMinChg"]:
                    entry["usShock"] = bk["usShock"]

    leader_list = sorted(merged_leaders.values(), key=lambda x: -x["mcapYi"])[:42]

    # 并发拉取龙头股 180日日K与公告排雷
    sem_k = asyncio.Semaphore(4)
    sem_notice = asyncio.Semaphore(4)
    k_tasks = [
        _fetch_em_klines(
            http_client,
            f"{'1' if x['code'].startswith(('6', '9')) else '0'}.{x['code']}",
            101,
            180,
            sem_k,
            tcode_fallback=x["tcode"],
        )
        for x in leader_list
    ]
    n_tasks = [_fetch_stock_notice_risk(http_client, x["code"], sem_notice) for x in leader_list]
    k_res, n_res = await asyncio.gather(
        asyncio.gather(*k_tasks, return_exceptions=True),
        asyncio.gather(*n_tasks, return_exceptions=True),
    )

    picks: List[dict] = []
    for item, bars, n_info in zip(leader_list, k_res, n_res):
        if not isinstance(bars, list) or len(bars) < 30:
            continue
        cur_bar = bars[-1]
        cur_px = item["price"] or cur_bar["close"]
        high_180 = max(b["high"] for b in bars)
        stock_dd_pct = ((cur_px - high_180) / max(1e-6, high_180)) * 100.0
        if -stock_dd_pct < stock_dd_min:
            continue

        # 计算量能枯竭度：近5日均量 vs 阶段10日窗口峰值均量
        vols = [b["vol"] for b in bars]
        avg_vol_5 = sum(vols[-min(5, len(vols)):]) / max(1, min(5, len(vols)))
        peak_roll_10 = max(
            sum(vols[i : i + 10]) / 10.0
            for i in range(0, max(1, len(vols) - 9))
        ) if len(vols) >= 10 else max(vols)
        vol_exhaust_ratio = avg_vol_5 / max(1.0, peak_roll_10)

        # 不破近5日新低 / 下影承接韧性
        prev_5_low = min(b["low"] for b in bars[-min(6, len(bars)) : -1]) if len(bars) >= 2 else cur_bar["low"]
        not_new_low = cur_px >= prev_5_low * 0.992
        cur_chg = item["chg"]
        day_rng = max(1e-6, cur_bar["high"] - cur_bar["low"])
        lower_shadow_ratio = (min(cur_bar["open"], cur_bar["close"]) - cur_bar["low"]) / day_rng
        intraday_resilient = (cur_bar["close"] >= cur_bar["open"] * 0.996) or (lower_shadow_ratio >= 0.35)

        board_chg = item["worstBoardChg"]
        us_shock = item.get("usShock")
        us_min_chg = us_shock["usMinChg"] if us_shock else None

        sector_alpha = round(cur_chg - board_chg, 2)
        us_alpha = round(cur_chg - us_min_chg, 2) if us_min_chg is not None else None

        risk_info = n_info if isinstance(n_info, dict) else {"riskLevel": "安全", "redFlags": [], "yellowAlerts": []}
        avg_vol_10 = sum(vols[-min(10, len(vols)):]) / max(1, min(10, len(vols)))
        heavy_dump = cur_bar["vol"] > avg_vol_10 * 1.25 and cur_chg <= -2.5 and not not_new_low

        us_bad_hit = us_min_chg is not None and us_min_chg <= -2.0 and cur_chg >= -2.5 and (us_alpha or 0.0) >= 2.0
        sector_bad_hit = board_chg <= -1.2 and sector_alpha >= 1.2 and cur_chg >= -2.2

        if risk_info["riskLevel"] == "高风险" or heavy_dump:
            dip_signal = "FALLING_KNIFE"
            dip_label = "🔴 放量下杀/避雷"
            dip_tip = (
                "近35天存在公告利空红牌，避免将基本面暴雷误判为板块见底"
                if risk_info["riskLevel"] == "高风险"
                else "仍处于放量破位寻底中，严禁左侧硬接飞刀"
            )
            signal_bonus = -25
        elif vol_exhaust_ratio <= 0.62 and (us_bad_hit or sector_bad_hit) and not_new_low and intraday_resilient:
            dip_signal = "ANTI_DROP_BOTTOM"
            dip_label = "🟢 利空抗跌·底部试探"
            if us_bad_hit:
                dip_tip = f"外盘{us_shock['worstLabel']}跌{us_min_chg:+.2f}%但本股抗住({cur_chg:+.2f}%)，卖盘枯竭、利空钝化"
            else:
                dip_tip = f"所属{item['primaryBoardName']}跌{board_chg:+.2f}%而龙头抗跌({cur_chg:+.2f}%)，抛压出清试探筑底"
            signal_bonus = 24
        elif vol_exhaust_ratio <= 0.55:
            dip_signal = "SHRINK_WATCH"
            dip_label = "🟡 深跌缩量·磨底观察"
            dip_tip = f"距高点回撤{stock_dd_pct:.1f}%且量能缩至峰值{vol_exhaust_ratio*100:.0f}%，放入观察等“利空砸不动”确认日"
            signal_bonus = 10
        else:
            dip_signal = "DIGESTING_DROP"
            dip_label = "⚪ 深跌观察·等待缩量"
            dip_tip = "回撤幅度已足但成交量尚未完全枯竭，需继续等缩量止跌"
            signal_bonus = 0

        # 抄底评分 0~100
        s_dd = min(30, int(abs(stock_dd_pct) * 0.45))
        s_vol = 28 if vol_exhaust_ratio <= 0.35 else (22 if vol_exhaust_ratio <= 0.50 else 12)
        s_alpha = 18 if us_bad_hit else (14 if sector_bad_hit else 4)
        s_mcap = 10 if item["mcapYi"] >= 150 else (6 if item["mcapYi"] >= 60 else 2)
        dip_score = max(10, min(99, s_dd + s_vol + s_alpha + s_mcap + signal_bonus))

        picks.append({
            "code": item["code"],
            "tcode": item["tcode"],
            "name": str(item["name"]).replace(" ", ""),
            "price": cur_px,
            "chg": cur_chg,
            "amountYi": item["amountYi"],
            "mcapYi": item["mcapYi"],
            "turnover": item["turnover"],
            "primaryBoardName": item["primaryBoardName"],
            "worstBoardDd": item["worstBoardDd"],
            "worstBoardChg": board_chg,
            "matchedBoards": item["matchedBoards"][:3],
            "stockDrawdownPct": round(stock_dd_pct, 1),
            "high180": round(high_180, 2),
            "volExhaustRatio": round(vol_exhaust_ratio, 2),
            "volExhaustPct": round(vol_exhaust_ratio * 100.0, 1),
            "sectorAlpha": sector_alpha,
            "usAlpha": us_alpha,
            "usShock": us_shock,
            "notNewLow": not_new_low,
            "dipSignal": dip_signal,
            "dipLabel": dip_label,
            "dipTip": dip_tip,
            "dipScore": dip_score,
            **risk_info,
        })

    sig_order = {"ANTI_DROP_BOTTOM": 0, "SHRINK_WATCH": 1, "DIGESTING_DROP": 2, "FALLING_KNIFE": 3}
    picks.sort(
        key=lambda x: (
            sig_order.get(x["dipSignal"], 9),
            -x["dipScore"],
            x["stockDrawdownPct"],
        )
    )

    counts = {
        "total": len(picks),
        "antiDrop": sum(1 for x in picks if x["dipSignal"] == "ANTI_DROP_BOTTOM"),
        "shrinkWatch": sum(1 for x in picks if x["dipSignal"] == "SHRINK_WATCH"),
        "fallingKnife": sum(1 for x in picks if x["dipSignal"] == "FALLING_KNIFE"),
    }
    return {
        "usRadar": radar_cards,
        "deepBoards": top_boards[:12],
        "items": picks[:40],
        "stats": {
            "sectorDdMin": sector_dd_min,
            "stockDdMin": stock_dd_min,
            "qualifyingBoards": len(qualifying_boards),
            "counts": counts,
        },
    }


async def get_ignition_tracking_pool(
    http_client: Optional[httpx.AsyncClient] = None,
    fresh_breakout_items: Optional[List[dict]] = None,
    fresh_date: Optional[str] = None,
) -> dict:
    """
    拉取所有已入库的起爆推荐与抗跌抄底标的，
    实时获取最新行情数据，计算当前收益率、在轨生命周期阶段（已起爆/持续蓄势/触及防守/达成大胜）及专属操盘 SOP 指引。
    """
    signals_map: Dict[str, dict] = {}
    ledger_state: dict = {}
    if STRATEGY_LEDGER_FILE.exists():
        try:
            with open(STRATEGY_LEDGER_FILE, "r", encoding="utf-8") as f:
                ledger_state = json.load(f)
            signals_map = ledger_state.get("signals") or {}
        except Exception:
            signals_map = {}

    # 若传入了当日最新扫描出的起爆标的，自动保全入库，确保次日绝不丢失
    if fresh_breakout_items and fresh_date:
        modified = False
        for it in fresh_breakout_items:
            stg = it.get("stage")
            if stg not in ("SHAKEOUT_READY", "CONVERGED_WAIT"):
                continue
            c6 = str(it.get("code") or "").strip().zfill(6)
            px = _sf(it.get("price"))
            if not c6.isdigit() or px <= 0:
                continue
            sig_id = f"ignition:{fresh_date}:{c6}"
            if sig_id not in signals_map:
                signals_map[sig_id] = {
                    "id": sig_id,
                    "strategy": "ignition",
                    "subType": str(stg),
                    "signalDate": fresh_date,
                    "code": c6,
                    "tcode": _to_tcode(c6),
                    "name": str(it.get("name") or c6).replace(" ", ""),
                    "hybk": str(it.get("hybk") or "其他"),
                    "score": _sf(it.get("ignitionScore")),
                    "verdict": str(it.get("stageLabel") or "起爆潜伏"),
                    "ztDate": str(it.get("ztDate") or ""),
                    "volShrinkPct": round(_sf(it.get("volShrinkPct")), 1),
                    "monthVolRatio": round(_sf(it.get("monthVolRatio")), 2),
                    "env": "OK",
                    "refPrice": round(px, 2),
                    "buy": round(px, 2),
                }
                modified = True
        if modified and ledger_state:
            try:
                ledger_state["signals"] = signals_map
                ledger_state["updatedAt"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                with open(STRATEGY_LEDGER_FILE, "w", encoding="utf-8") as f:
                    json.dump(ledger_state, f, ensure_ascii=False, indent=2)
            except Exception:
                pass

    tracking_sigs = [
        v for v in signals_map.values()
        if isinstance(v, dict) and v.get("strategy") in ("ignition", "bottom") and v.get("code")
    ]

    # 若账本暂无或初次运行，回退至最新扫描落盘文件
    if not tracking_sigs and IGNITION_CACHE_FILE.exists():
        try:
            with open(IGNITION_CACHE_FILE, "r", encoding="utf-8") as f:
                cache_payload = json.load(f)
            b_items = (cache_payload.get("breakout") or {}).get("items") or []
            sig_date = cache_payload.get("date") or datetime.date.today().strftime("%Y-%m-%d")
            for it in b_items:
                c6 = str(it.get("code") or "").strip().zfill(6)
                if c6.isdigit():
                    tracking_sigs.append({
                        "id": f"ignition:{sig_date}:{c6}",
                        "strategy": "ignition",
                        "signalDate": sig_date,
                        "code": c6,
                        "name": it.get("name") or c6,
                        "hybk": it.get("hybk") or "其他",
                        "refPrice": _sf(it.get("price")),
                        "subType": it.get("stage") or "CONVERGED_WAIT",
                        "verdict": it.get("stageLabel") or "起爆潜伏",
                        "ztDate": it.get("ztDate") or "",
                    })
        except Exception:
            pass

    if not tracking_sigs:
        return {
            "ok": True,
            "updatedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "summary": {
                "totalCount": 0,
                "ignitedCount": 0,
                "waitingCount": 0,
                "stoppedCount": 0,
                "avgGainPct": 0.0,
                "winRate": 0.0,
            },
            "items": [],
        }

    codes = list({s["code"] for s in tracking_sigs})

    async def _fetch_q(client: httpx.AsyncClient) -> Dict[str, dict]:
        return await _fetch_batch_quotes(client, codes)

    if http_client is not None:
        quotes = await _fetch_q(http_client)
    else:
        async with httpx.AsyncClient(timeout=httpx.Timeout(8.0), trust_env=False) as client:
            quotes = await _fetch_q(client)

    items: List[dict] = []
    for s in tracking_sigs:
        c6 = s["code"]
        q = quotes.get(c6) or {}
        ref_px = _sf(s.get("refPrice") or s.get("buy"))
        cur_px = _sf(q.get("price"), ref_px)
        day_chg = _sf(q.get("chg"), 0.0)
        gain_pct = round(((cur_px / ref_px) - 1.0) * 100.0, 2) if ref_px > 0 else 0.0

        if gain_pct >= 8.0 or day_chg >= 9.5:
            track_stage = "TARGET_REACHED"
            stage_desc = "🚀 达成大胜"
            stage_color = "#b45309"
            stage_bg = "#fef3c7"
            stage_border = "#fde68a"
            advice = "已达成波段启动大胜目标；封死涨停则持股躺平，一旦冲高滞涨或开板分批倒T止盈兑现，将保本线上移至 +5%"
        elif gain_pct >= 2.5 or day_chg >= 3.0:
            track_stage = "IGNITED"
            stage_desc = "🔥 放量起爆"
            stage_color = "#b91c1c"
            stage_bg = "#fee2e2"
            stage_border = "#fca5a5"
            advice = "已启动放量拉升，持有安全垫利润；以昨日收盘价或5日均线设移动防守，冲高至目标位可做倒T减半"
        elif gain_pct <= -4.5:
            track_stage = "STOPPED"
            stage_desc = "🛑 触及防守"
            stage_color = "#374151"
            stage_bg = "#f3f4f6"
            stage_border = "#d1d5db"
            advice = "极度贴近或跌破防守底线，形态若有效破位请严格执行纪律认错离场，坚决防范深套"
        else:
            track_stage = "WAITING"
            stage_desc = "⏳ 持续蓄势"
            stage_color = "#0369a1"
            stage_bg = "#e0f2fe"
            stage_border = "#bae6fd"
            advice = "处于横盘蓄势吸筹期，底仓拿好；日内分时踩均线可做正T低吸，建议观察周期 3~5 个交易日，等待二次起爆"

        items.append({
            "id": s.get("id") or f"ignition:{s.get('signalDate')}:{c6}",
            "strategy": s.get("strategy") or "ignition",
            "strategyLabel": "横盘待起爆" if (s.get("strategy") or "ignition") == "ignition" else "抗跌抄底",
            "code": c6,
            "name": s.get("name") or c6,
            "hybk": s.get("hybk") or "其他",
            "signalDate": s.get("signalDate") or "",
            "subType": s.get("subType") or "CONVERGED_WAIT",
            "verdict": s.get("verdict") or "起爆潜伏",
            "refPrice": round(ref_px, 2),
            "curPrice": round(cur_px, 2),
            "dayChg": round(day_chg, 2),
            "gainPct": gain_pct,
            "high": _sf(q.get("high"), cur_px),
            "low": _sf(q.get("low"), cur_px),
            "open": _sf(q.get("open"), cur_px),
            "trackStage": track_stage,
            "stageDesc": stage_desc,
            "stageColor": stage_color,
            "stageBg": stage_bg,
            "stageBorder": stage_border,
            "sop": {
                "defensePrice": round(ref_px * 0.955, 2),
                "targetT1": round(ref_px * 1.05, 2),
                "targetT2": round(ref_px * 1.10, 2),
                "maxDays": 5,
                "advice": advice,
            },
        })

    items.sort(key=lambda x: (x["signalDate"], x["gainPct"]), reverse=True)
    total_cnt = len(items)
    ignited_cnt = sum(1 for x in items if x["trackStage"] in ("TARGET_REACHED", "IGNITED"))
    waiting_cnt = sum(1 for x in items if x["trackStage"] == "WAITING")
    stopped_cnt = sum(1 for x in items if x["trackStage"] == "STOPPED")
    avg_gain = round(sum(x["gainPct"] for x in items) / total_cnt, 2) if total_cnt else 0.0
    win_cnt = sum(1 for x in items if x["gainPct"] > 0)
    win_rate = round((win_cnt / total_cnt) * 100.0, 1) if total_cnt else 0.0

    return {
        "ok": True,
        "updatedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "summary": {
            "totalCount": total_cnt,
            "ignitedCount": ignited_cnt,
            "waitingCount": waiting_cnt,
            "stoppedCount": stopped_cnt,
            "avgGainPct": avg_gain,
            "winRate": win_rate,
        },
        "items": items,
    }


async def get_ignition_pool(
    include_cyb: bool = False,
    lookback_days: int = 20,
    sector_dd_min: float = 30.0,
    stock_dd_min: float = 40.0,
    custom_us_mappings: Optional[List[dict]] = None,
    force_refresh: bool = False,
    http_client: Optional[httpx.AsyncClient] = None,
) -> dict:
    """
    统一聚合「起爆点挖掘」双方向结果：
    - breakout: 横盘试盘涨停 + 月放量 + 周向上 + 日缩量起爆潜伏池
    - dipLeaders: 板块深跌腰斩龙头 + 外盘/板块利空抗跌抄底池
    """
    custom_key = json.dumps(custom_us_mappings or [], sort_keys=True, ensure_ascii=False)
    cache_key = f"{int(include_cyb)}:{lookback_days}:{sector_dd_min}:{stock_dd_min}:{custom_key}"
    now_ts = time.monotonic()

    # 1. 内存缓存命中直接返回
    if not force_refresh:
        async with _CACHE_LOCK:
            cached = _RESULT_CACHE.get(cache_key)
            if cached and cached[0] > now_ts:
                return cached[1]

    # 2. 若非强制刷新，优先尝试使用本地落盘优质快照并毫秒更新实时现价（极速响应且防限流）
    saved_payload = load_saved_ignition() if not force_refresh else None
    if saved_payload and not force_refresh:
        b_items = (saved_payload.get("breakout") or {}).get("items") or []
        d_items = (saved_payload.get("dipLeaders") or {}).get("items") or []
        if len(b_items) > 0 or len(d_items) > 0:
            # 批量刷新最新现价
            all_codes = list({x["code"] for x in [*b_items, *d_items] if x.get("code")})
            try:
                if http_client:
                    quotes = await _fetch_batch_quotes(http_client, all_codes)
                else:
                    async with httpx.AsyncClient(timeout=8.0, trust_env=False) as c:
                        quotes = await _fetch_batch_quotes(c, all_codes)
                for it in b_items:
                    q = quotes.get(it["code"])
                    if q and q.get("price", 0) > 0:
                        it["price"] = round(q["price"], 2)
                        it["chg"] = round(q["chg"], 2)
                for it in d_items:
                    q = quotes.get(it["code"])
                    if q and q.get("price", 0) > 0:
                        it["price"] = round(q["price"], 2)
                        it["chg"] = round(q["chg"], 2)
            except Exception:
                pass

            try:
                saved_payload["trackingPool"] = await get_ignition_tracking_pool(
                    http_client=http_client,
                    fresh_breakout_items=b_items,
                    fresh_date=saved_payload.get("date"),
                )
            except Exception:
                pass

            async with _CACHE_LOCK:
                _RESULT_CACHE[cache_key] = (now_ts + RESULT_TTL, saved_payload)
            return saved_payload

    async def _run_both(client: httpx.AsyncClient) -> Tuple[dict, dict]:
        b_res = await scan_breakout_ignition(client, include_cyb=include_cyb, lookback_days=lookback_days)
        d_res = await scan_dip_leaders(
            client,
            sector_dd_min=sector_dd_min,
            stock_dd_min=stock_dd_min,
            custom_us_mappings=custom_us_mappings,
        )
        return b_res, d_res

    if http_client is not None:
        breakout_res, dip_res = await _run_both(http_client)
    else:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(15.0),
            trust_env=False,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "*/*",
            },
        ) as client:
            breakout_res, dip_res = await _run_both(client)

    # 3. 若实时扫描因三方网络拦截或限流出现 0 结果，自动保底回退至本地已有优质快照
    b_len = len((breakout_res or {}).get("items") or [])
    d_len = len((dip_res or {}).get("items") or [])
    if b_len == 0 and d_len == 0:
        fallback = load_saved_ignition()
        if fallback and (len((fallback.get("breakout") or {}).get("items") or []) > 0 or len((fallback.get("dipLeaders") or {}).get("items") or []) > 0):
            breakout_res = fallback.get("breakout") or breakout_res
            dip_res = fallback.get("dipLeaders") or dip_res

    # 优先采用日K样本/扫描中的真实最新交易日（防周末/盘前日期偏移）
    trade_date = (
        next((b.get("latestDate") for b in (breakout_res.get("items") or []) if b.get("latestDate")), None)
        or datetime.date.today().strftime("%Y-%m-%d")
    )
    payload = {
        "ok": True,
        "date": trade_date,
        "scannedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "params": {
            "includeCyb": include_cyb,
            "lookbackDays": lookback_days,
            "sectorDdMin": sector_dd_min,
            "stockDdMin": stock_dd_min,
        },
        "breakout": breakout_res,
        "dipLeaders": dip_res,
    }

    try:
        tracking_pool_res = await get_ignition_tracking_pool(
            http_client=http_client,
            fresh_breakout_items=breakout_res.get("items"),
            fresh_date=trade_date,
        )
        payload["trackingPool"] = tracking_pool_res
    except Exception:
        payload["trackingPool"] = {"ok": False, "summary": {}, "items": []}

    async with _CACHE_LOCK:
        _RESULT_CACHE[cache_key] = (time.monotonic() + RESULT_TTL, payload)

    # 默认口径或首次落盘时保存，供策略战绩账本归档使用
    is_default = (
        not custom_us_mappings
        and not include_cyb
        and abs(sector_dd_min - 30.0) < 0.01
        and abs(stock_dd_min - 40.0) < 0.01
    )
    if is_default or not IGNITION_CACHE_FILE.exists():
        try:
            _save_latest_sync(payload)
        except Exception:
            pass

    return payload


async def diagnose_ignition_stock(query: str, http_client: Optional[httpx.AsyncClient] = None) -> dict:
    """
    自选横盘标的·专属起爆成色全息体检引擎：
    接收用户任意输入的股票代码或名称，全面核验：
    1. 试盘涨停：近60日内是否出现涨停试水、距今天数、板前横盘底座振幅与前期涨幅；
    2. 月线放量：月成交量放大倍数及近15月历史价位分位（安全边际）；
    3. 周线趋势：周MA5/MA10均线形态、周线更高低点抬升；
    4. 日线缩量：较涨停日量能萎缩比率、连缩天数、阶梯洗盘递减特征；
    5. 均线粘合与震仓：MA5/10/20极差（粘合度）、下影洗盘针/均线反包信号；
    6. 底座防守：试盘起点防守位、距起点空间与破位风险。
    输出：综合起爆评分 (0~100)、在轨阶段判定、六维条件核对清单与专属操盘 SOP 预案。
    """
    q_str = str(query or "").strip()
    if not q_str:
        return {"ok": False, "detail": "请输入股票代码或名称"}

    close_client = False
    if http_client is None:
        http_client = httpx.AsyncClient(timeout=12.0, trust_env=False)
        close_client = True

    try:
        m = re.search(r"\d{6}", q_str)
        c6 = m.group(0) if m else None
        if not c6:
            search_url = f"https://proxy.finance.qq.com/ifzqgtimg/appstock/smartbox/search/get?q={urllib.parse.quote(q_str)}&t=all"
            try:
                sr = await http_client.get(search_url, headers={"Referer": "https://gu.qq.com/"})
                if sr.status_code == 200:
                    stocks = (sr.json().get("data") or {}).get("stock") or []
                    for item in stocks:
                        if isinstance(item, list) and len(item) >= 3:
                            cand = str(item[1]).zfill(6)
                            if cand.isdigit() and len(cand) == 6:
                                c6 = cand
                                break
            except Exception:
                pass

        if not c6:
            return {"ok": False, "detail": f"未能检索到股票「{q_str}」，请确认代码或名称正确"}

        tc = _to_tcode(c6)
        prefix = "1" if c6.startswith(("6", "9")) else "0"
        em_secid = f"{prefix}.{c6}"

        sem = asyncio.Semaphore(4)
        results = await asyncio.gather(
            _fetch_batch_quotes(http_client, [c6]),
            _fetch_em_klines(http_client, em_secid, 101, 95, sem, tc),
            _fetch_em_klines(http_client, em_secid, 102, 26, sem, tc),
            _fetch_em_klines(http_client, em_secid, 103, 15, sem, tc),
            _fetch_stock_notice_risk(http_client, c6, sem),
            return_exceptions=True,
        )

        quotes = results[0] if isinstance(results[0], dict) else {}
        dbars = results[1] if isinstance(results[1], list) else []
        wbars = results[2] if isinstance(results[2], list) else []
        mbars = results[3] if isinstance(results[3], list) else []
        notice = results[4] if isinstance(results[4], dict) else {}

        if len(dbars) < 25:
            return {"ok": False, "detail": f"标的 {c6} 日K历史数据不足，上市交易时间过短"}

        q = quotes.get(c6) or {}
        cur_price = round(_sf(q.get("price"), dbars[-1]["close"]), 2)
        day_chg = round(_sf(q.get("chg"), 0.0), 2)
        name = str(q.get("name") or c6).replace(" ", "")
        turnover = round(_sf(q.get("turnover"), 0.0), 2)
        amount_yi = round(_sf(q.get("amount"), 0.0) / 1e8, 2)
        mcap_yi = round(_sf(q.get("mcap"), 0.0) / 1e8, 1)

        n = len(dbars)

        # 维度一：试盘涨停与前置横盘
        zt_indices = [i for i in range(max(0, n - 60), n) if _is_zt_bar(dbars, i, c6)]
        has_zt = len(zt_indices) > 0
        last_zt_idx = zt_indices[-1] if has_zt else -1
        zt_bar = dbars[last_zt_idx] if has_zt else None
        zt_date = zt_bar["date"] if zt_bar else ""
        days_since_zt = (n - 1 - last_zt_idx) if has_zt else 999

        pre_box_amp = 0.0
        pre_runup = 0.0
        if has_zt and last_zt_idx >= 8:
            pre_slice = dbars[max(0, last_zt_idx - 35) : last_zt_idx]
            if len(pre_slice) >= 8:
                pre_hi = max(b["high"] for b in pre_slice)
                pre_lo = min(b["low"] for b in pre_slice)
                pre_box_amp = round(((pre_hi - pre_lo) / max(1e-6, pre_lo)) * 100.0, 1)
                early_min = min(b["low"] for b in pre_slice[: min(10, len(pre_slice))])
                pre_runup = round(((dbars[last_zt_idx - 1]["close"] - early_min) / max(1e-6, early_min)) * 100.0, 1)

        if not has_zt:
            d1_pass = False
            d1_title = "试盘涨停"
            d1_label = "近60日无试水涨停"
            d1_val = "无涨停板"
            d1_detail = "近60日未出现首板涨停试水，属于常态震荡，尚缺主力首板试盘测压信号"
        elif days_since_zt == 0:
            d1_pass = True
            d1_title = "试盘涨停"
            d1_label = "今日涨停试水"
            d1_val = f"今日首板 ({zt_date})"
            d1_detail = "今日放量拉涨停试盘，重点观察后续 2~3 个交易日能否缩量企稳不破起点"
        elif 2 <= days_since_zt <= 22 and pre_runup <= 55.0:
            d1_pass = True
            d1_title = "试盘涨停"
            d1_label = "标准首板试水"
            d1_val = f"{zt_date} ({days_since_zt}天前)"
            d1_detail = f"板前横盘振幅 {pre_box_amp}%，试水前未大幅暴涨透支，符合主力试水逻辑"
        elif days_since_zt > 22:
            d1_pass = "warn"
            d1_title = "试盘涨停"
            d1_label = "试盘时隔较长"
            d1_val = f"{zt_date} ({days_since_zt}天前)"
            d1_detail = f"试盘涨停距今已 {days_since_zt} 天，时间稍偏长，需重点确认底座防守"
        else:
            d1_pass = "warn"
            d1_title = "试盘涨停"
            d1_label = "刚涨停1天"
            d1_val = f"{zt_date} (昨日涨停)"
            d1_detail = "昨日刚完成试水涨停，需留至少 2 天观察洗盘缩量情况"

        # 维度二：月线放量与历史估值位
        month_vol_ratio = 1.0
        month_pos_pct = 50.0
        if len(mbars) >= 4:
            cur_ym = mbars[-1]["date"][:7]
            cur_m_trading_days = max(1, sum(1 for b in dbars if b["date"][:7] == cur_ym))
            cur_m_scaled_vol = mbars[-1]["vol"] * max(1.0, 21.0 / min(21, cur_m_trading_days))
            prev_full_m_vol = mbars[-2]["vol"] if len(mbars) >= 2 else mbars[-1]["vol"]
            recent_m_peak = max(cur_m_scaled_vol, prev_full_m_vol)
            base_slice = mbars[-7:-2] if len(mbars) >= 7 else mbars[:-2]
            base_avg_vol = sum(b["vol"] for b in base_slice) / max(1, len(base_slice))
            month_vol_ratio = round(recent_m_peak / max(1.0, base_avg_vol), 2)
            m_hi = max(b["high"] for b in mbars)
            m_lo = min(b["low"] for b in mbars)
            month_pos_pct = round(((cur_price - m_lo) / max(1e-6, m_hi - m_lo)) * 100.0, 1)

        if month_vol_ratio >= 1.25 and month_pos_pct <= 80.0:
            d2_pass = True
            d2_title = "月线放量"
            d2_label = "放量蓄势充分"
            d2_val = f"{month_vol_ratio}x (月位 {month_pos_pct}%)"
            d2_detail = f"月成交量达基准 {month_vol_ratio} 倍且处于中低位，大资金长期建仓底色良好"
        elif month_vol_ratio >= 1.10:
            d2_pass = "warn"
            d2_title = "月线放量"
            d2_label = "温和放量"
            d2_val = f"{month_vol_ratio}x (月位 {month_pos_pct}%)"
            d2_detail = f"月线量能微增 {month_vol_ratio} 倍，中长期大级别异动尚在酝酿中"
        elif month_pos_pct > 85.0:
            d2_pass = "warn"
            d2_title = "月线放量"
            d2_label = "高位注意派发"
            d2_val = f"{month_vol_ratio}x (月位 {month_pos_pct}%)"
            d2_detail = f"月成交量虽放大但处于近15月极高位({month_pos_pct}%)，需谨防主力拉高出货"
        else:
            d2_pass = False
            d2_title = "月线放量"
            d2_label = "月量低迷"
            d2_val = f"{month_vol_ratio}x (月位 {month_pos_pct}%)"
            d2_detail = f"月成交量仅为基准的 {month_vol_ratio} 倍，中长线大资金介入迹象不明显"

        # 维度三：周线趋势
        weekly_up = False
        weekly_higher_low = False
        weekly_desc = "周线均线整理"
        if len(wbars) >= 10:
            w_closes = [b["close"] for b in wbars]
            w_cur = w_closes[-1]
            w_ma5 = _sma(w_closes, 5) or w_cur
            w_ma10 = _sma(w_closes, 10) or w_cur
            w_ma5_prev = _sma(w_closes[:-1], 5) or w_ma5
            w_low_recent = min(b["low"] for b in wbars[-4:])
            w_low_prior = min(b["low"] for b in wbars[-10:-4])
            weekly_higher_low = w_low_recent >= w_low_prior * 0.97
            weekly_up = (w_cur >= w_ma10 * 0.985) and (w_ma5 >= w_ma10 * 0.985 or w_ma5 > w_ma5_prev)
            if w_ma5 > w_ma10 and w_ma5 > w_ma5_prev:
                weekly_desc = "周MA5>MA10多头向上"
            elif w_cur > w_ma10 and w_ma5 > w_ma5_prev:
                weekly_desc = "周线MA5上拐支撑"
            elif w_cur >= w_ma10:
                weekly_desc = "周MA10上方震荡"
            else:
                weekly_desc = "周线下行破位承压"

        if weekly_up and weekly_higher_low:
            d3_pass = True
            d3_title = "周线趋势"
            d3_label = "趋势向上"
            d3_val = weekly_desc
            d3_detail = f"{weekly_desc}，且周低点逐级抬升，中期趋势保持向上动能"
        elif weekly_up:
            d3_pass = "warn"
            d3_title = "周线趋势"
            d3_label = "震荡企稳"
            d3_val = weekly_desc
            d3_detail = f"{weekly_desc}，中期趋势止跌走平，等待进一步放量走强"
        else:
            d3_pass = False
            d3_title = "周线趋势"
            d3_label = "中期承压"
            d3_val = weekly_desc
            d3_detail = f"{weekly_desc}，跌破周MA10均线，中期趋势偏弱"

        # 维度四：日线缩量
        vol_shrink_pct = 100.0
        shrink_streak = 0
        if has_zt and days_since_zt > 0:
            post = dbars[last_zt_idx + 1 :]
            zt_vol = max(1.0, zt_bar["vol"])
            recent_post = post[-min(3, len(post)) :]
            recent_avg_vol = sum(b["vol"] for b in recent_post) / len(recent_post)
            vol_shrink_pct = round((recent_avg_vol / zt_vol) * 100.0, 1)
            for idx in range(n - 1, max(last_zt_idx + 1, n - 7), -1):
                if dbars[idx]["vol"] <= dbars[idx - 1]["vol"] * 1.05:
                    shrink_streak += 1
                else:
                    break
        else:
            vol5 = sum(b["vol"] for b in dbars[-5:]) / 5.0
            vol20 = sum(b["vol"] for b in dbars[-20:]) / 20.0
            vol_shrink_pct = round((vol5 / max(1.0, vol20)) * 100.0, 1)

        if has_zt and days_since_zt > 0:
            if vol_shrink_pct <= 70.0:
                d4_pass = True
                d4_title = "日线缩量"
                d4_label = "缩量衰竭"
                d4_val = f"缩至试盘日 {vol_shrink_pct}%"
                d4_detail = f"较涨停日缩量至 {vol_shrink_pct}%（连缩{shrink_streak}日），浮筹清洗彻底，抛压基本出清"
            elif vol_shrink_pct <= 85.0:
                d4_pass = "warn"
                d4_title = "日线缩量"
                d4_label = "温和缩量"
                d4_val = f"缩至试盘日 {vol_shrink_pct}%"
                d4_detail = f"缩量至 {vol_shrink_pct}%，浮筹在洗盘中，仍在寻找极致地量契机"
            else:
                d4_pass = False
                d4_title = "日线缩量"
                d4_label = "未见明显缩量"
                d4_val = f"为试盘日 {vol_shrink_pct}%"
                d4_detail = f"量能高达涨停日 {vol_shrink_pct}%，多空分歧巨大，尚未形成缩量防守"
        else:
            if vol_shrink_pct <= 75.0:
                d4_pass = True
                d4_title = "日线缩量"
                d4_label = "地量沉寂"
                d4_val = f"为20日均量 {vol_shrink_pct}%"
                d4_detail = f"近期成交量仅为20日均量的 {vol_shrink_pct}%，处于地量蛰伏期"
            else:
                d4_pass = "warn"
                d4_title = "日线缩量"
                d4_label = "常态量能"
                d4_val = f"为20日均量 {vol_shrink_pct}%"
                d4_detail = f"近5日量能为均量的 {vol_shrink_pct}%，常态波动"

        # 维度五：均线粘合与震仓信号
        closes = [b["close"] for b in dbars]
        ma5 = _sma(closes, 5) or cur_price
        ma10 = _sma(closes, 10) or cur_price
        ma20 = _sma(closes, 20) or cur_price
        ma_spread_pct = round(((max(ma5, ma10, ma20) - min(ma5, ma10, ma20)) / max(1e-6, cur_price)) * 100.0, 1)
        bias_ma5 = round(((cur_price - ma5) / max(1e-6, ma5)) * 100.0, 1)

        shakeout_signals = []
        check_slice = dbars[last_zt_idx + 1 :] if (has_zt and days_since_zt > 0) else dbars[-8:]
        for b in check_slice:
            body = abs(b["close"] - b["open"])
            lo_shadow = min(b["close"], b["open"]) - b["low"]
            if lo_shadow >= body * 1.6 and lo_shadow >= b["low"] * 0.015:
                if "下影探底收回" not in shakeout_signals:
                    shakeout_signals.append("下影探底收回")
            if b["low"] < ma10 and b["close"] > ma10:
                if "砸破均线反包" not in shakeout_signals:
                    shakeout_signals.append("砸破均线反包")

        if ma_spread_pct <= 3.5 and shakeout_signals:
            d5_pass = True
            d5_title = "均线粘合与震仓"
            d5_label = "粘合+探底针"
            d5_val = f"极差 {ma_spread_pct}% · {shakeout_signals[0]}"
            d5_detail = f"MA5/10/20极差仅 {ma_spread_pct}%，且出现【{' + '.join(shakeout_signals)}】，震仓洗盘特征显著"
        elif ma_spread_pct <= 4.0:
            d5_pass = True
            d5_title = "均线粘合与震仓"
            d5_label = "均线紧密粘合"
            d5_val = f"极差 {ma_spread_pct}%"
            d5_detail = f"MA5/10/20极差 {ma_spread_pct}%，均线束高度收敛，筹码成本集中"
        elif ma_spread_pct <= 6.5:
            d5_pass = "warn"
            d5_title = "均线粘合与震仓"
            d5_label = "均线逐步收敛"
            d5_val = f"极差 {ma_spread_pct}%"
            d5_detail = f"均线极差 {ma_spread_pct}%，处于收拢阶段，尚未形成极致合力"
        else:
            d5_pass = False
            d5_title = "均线粘合与震仓"
            d5_label = "均线分散发散"
            d5_val = f"极差 {ma_spread_pct}%"
            d5_detail = f"均线极差 {ma_spread_pct}%，短期乖离过大，缺乏均线共振"

        # 维度六：底座防守
        support_floor = round(min(zt_bar["open"], zt_bar["low"]), 2) if zt_bar else round(min(b["low"] for b in dbars[-20:]), 2)
        dist_floor_pct = round(((cur_price - support_floor) / max(1e-6, support_floor)) * 100.0, 1)

        if cur_price >= support_floor * 0.99:
            d6_pass = True
            d6_title = "底座防守"
            d6_label = "守住防守底线"
            d6_val = f"支撑位 ¥{support_floor} (+{dist_floor_pct}%)"
            d6_detail = f"现价稳稳站在起涨防守线 ¥{support_floor} 之上，主力试盘成本区支撑有效"
        else:
            d6_pass = False
            d6_title = "底座防守"
            d6_label = "跌破防守线"
            d6_val = f"破位 ¥{support_floor} ({dist_floor_pct}%)"
            d6_detail = f"现价已跌破防守线 ¥{support_floor}，起涨底座受损，存在深套破位风险"

        # 综合评分 (0~100)
        score = 0
        score += 25 if d1_pass is True else (12 if d1_pass == "warn" else 0)
        score += 20 if d2_pass is True else (10 if d2_pass == "warn" else 0)
        score += 20 if d3_pass is True else (10 if d3_pass == "warn" else 0)
        score += 15 if d4_pass is True else (8 if d4_pass == "warn" else 0)
        score += 15 if d5_pass is True else (8 if d5_pass == "warn" else 0)
        score += 5 if d6_pass is True else -20
        if notice.get("riskLevel") == "高风险":
            score -= 15
        ignition_score = max(0, min(100, score))

        # 状态判定
        if day_chg >= 9.5 or (dist_floor_pct >= 25.0 and vol_shrink_pct >= 130.0):
            stage = "IGNITING"
            stage_label = "🚀 放量起爆拉升中"
            stage_tip = "已启动放量主升行情，持有者转入移动倒T止盈模式，未持仓切勿盲目追高"
            badge_bg = "#fee2e2"
            badge_color = "#b91c1c"
            badge_border = "#fca5a5"
        elif ignition_score >= 80 and shakeout_signals:
            stage = "SHAKEOUT_READY"
            stage_label = "🔥 震仓完成·待起爆"
            stage_tip = "试水后缩量洗盘到位，出现下影探底震仓针，主力控盘良好随时起爆"
            badge_bg = "#fff1f0"
            badge_color = "#cf1322"
            badge_border = "#ffa39e"
        elif ignition_score >= 70 and ma_spread_pct <= 4.0:
            stage = "CONVERGED_WAIT"
            stage_label = "⏳ 均线粘合·缩量蓄势"
            stage_tip = "均线系统高度粘合收敛，量能温和萎缩，处于极佳的右侧起爆潜伏窗口"
            badge_bg = "#fffbeb"
            badge_color = "#b45309"
            badge_border = "#fcd34d"
        elif has_zt and vol_shrink_pct <= 85.0:
            stage = "DIGESTING"
            stage_label = "👀 试盘缩量消化"
            stage_tip = "涨停试盘后进行正常的缩量消化回踩，关注能否回踩分时均价线企稳"
            badge_bg = "#f0f9ff"
            badge_color = "#0369a1"
            badge_border = "#bae6fd"
        elif not d6_pass:
            stage = "BREAKDOWN_RISK"
            stage_label = "🛑 破位防守风险"
            stage_tip = "价格已跌破起涨试盘底线，短期形态破位，严禁盲目抄底接飞刀"
            badge_bg = "#fef2f2"
            badge_color = "#dc2626"
            badge_border = "#fecaca"
        else:
            stage = "INCUBATING"
            stage_label = "🌱 横盘蓄势孕育中"
            stage_tip = "处于大周期横盘无量整理期，尚未出现首板点火试水信号，建议入池保持雷达跟踪"
            badge_bg = "#f8fafc"
            badge_color = "#475569"
            badge_border = "#cbd5e1"

        # 操盘 SOP
        def_px = round(max(support_floor * 0.985, cur_price * 0.955), 2)
        sop = {
            "refPrice": cur_price,
            "defensePrice": def_px,
            "targetT1": round(cur_price * 1.05, 2),
            "targetT2": round(cur_price * 1.10, 2),
            "maxDays": 5,
            "advice": (
                f"【{name} 操盘建议】：当前处于「{stage_label}」阶段。"
                + ("若有底仓：在第一倒T位 ¥" + str(round(cur_price*1.05, 2)) + " 附近倒T锁半，回踩均价线接回；" if stage in ("IGNITING", "SHAKEOUT_READY") else "若试仓潜伏：沿日内分时均线分批低吸，")
                + f"严格以 ¥{def_px} 设防守底线，跌破执行纪律认错离场。"
            ),
        }

        # 诊断总结
        summary = (
            f"【{name} ({c6}) 起爆成色体检报告】综合评分：{ignition_score} 分（{stage_label}）。\n"
            f"① 试盘涨停：{d1_detail}；\n"
            f"② 月线放量：{d2_detail}；\n"
            f"③ 周线趋势：{d3_detail}；\n"
            f"④ 日线缩量：{d4_detail}；\n"
            f"⑤ 均线震仓：{d5_detail}；\n"
            f"⑥ 底座防守：{d6_detail}。"
        )

        checklist = [
            {"id": "zt", "title": d1_title, "passed": d1_pass, "badge": d1_label, "val": d1_val, "detail": d1_detail},
            {"id": "month", "title": d2_title, "passed": d2_pass, "badge": d2_label, "val": d2_val, "detail": d2_detail},
            {"id": "week", "title": d3_title, "passed": d3_pass, "badge": d3_label, "val": d3_val, "detail": d3_detail},
            {"id": "daily", "title": d4_title, "passed": d4_pass, "badge": d4_label, "val": d4_val, "detail": d4_detail},
            {"id": "ma", "title": d5_title, "passed": d5_pass, "badge": d5_label, "val": d5_val, "detail": d5_detail},
            {"id": "floor", "title": d6_title, "passed": d6_pass, "badge": d6_label, "val": d6_val, "detail": d6_detail},
        ]

        return {
            "ok": True,
            "code": c6,
            "name": name,
            "price": cur_price,
            "dayChg": day_chg,
            "turnover": turnover,
            "amountYi": amount_yi,
            "mcapYi": mcap_yi,
            "ignitionScore": ignition_score,
            "stage": stage,
            "stageLabel": stage_label,
            "stageTip": stage_tip,
            "badgeBg": badge_bg,
            "badgeColor": badge_color,
            "badgeBorder": badge_border,
            "summaryText": summary,
            "checklist": checklist,
            "sop": sop,
            "notice": notice,
        }
    finally:
        if close_client:
            await http_client.aclose()
