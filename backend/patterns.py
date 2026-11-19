from __future__ import annotations

"""
A股 K 线形态与缺口状态机引擎 (backend/patterns.py)

提供无外部 I/O 依赖的纯函数形态识别，支持 list ([date, o, c, h, l, vol]) 与 dict 两种日K格式：
1. 缺口状态机（有效向上/向下缺口、一字板过滤、回补状态追踪、3日不补确认、最近支撑/压力缺口）
2. 顶部岛形反转 (TOP_ISLAND) —— 高危一票否决信号
3. 底部岛形反转 (BOTTOM_ISLAND) —— 高胜率趋势反转信号
4. 高位天量避雷针 / 墓碑线 (HIGH_GRAVESTONE)
5. 高位放量阴包阳 / 穿头破脚 (BEARISH_ENGULFING)
6. 仙人指路 (IMMORTAL_GUIDE)
"""

from typing import Any, Dict, List, Optional, Sequence, Tuple


def _sf(v: Any, default: float = 0.0) -> float:
    try:
        return float(v) if v not in (None, "", "-") else default
    except (ValueError, TypeError):
        return default


def limit_pct_for_stock(code: str = "", name: str = "") -> float:
    """按 A 股板块与 ST 规则返回涨跌幅限制百分比。"""
    c = str(code or "").strip().replace("sh", "").replace("sz", "").replace("bj", "").zfill(6)
    n = str(name or "").upper()
    if "ST" in n:
        return 5.0
    if c.startswith(("4", "8", "92")):
        return 30.0
    if c.startswith(("300", "301", "302", "688", "689")):
        return 20.0
    return 10.0


def normalize_bars(raw_bars: Sequence[Any]) -> List[dict]:
    """统一将 list 或 dict 格式的前复权日K归一化为标准字典列表。"""
    out: List[dict] = []
    for row in raw_bars or []:
        if isinstance(row, dict):
            date_s = str(row.get("date") or "")[:10]
            o = _sf(row.get("open"))
            c = _sf(row.get("close"))
            h = _sf(row.get("high"))
            lo = _sf(row.get("low"))
            vol = _sf(row.get("vol"))
        elif isinstance(row, (list, tuple)) and len(row) >= 6:
            # 腾讯/东财本项目约定顺序: [date, open, close, high, low, vol]
            date_s = str(row[0])[:10]
            o = _sf(row[1])
            c = _sf(row[2])
            h = _sf(row[3])
            lo = _sf(row[4])
            vol = _sf(row[5])
        else:
            continue

        if c <= 0 or h <= 0 or lo <= 0:
            continue
        out.append({
            "date": date_s,
            "open": o if o > 0 else c,
            "close": c,
            "high": h,
            "low": lo,
            "vol": max(0.0, vol),
        })
    return out


def is_one_word_limit_bar(bar: dict, prev_close: float, code: str = "", name: str = "") -> bool:
    """判断是否为一字涨停或一字跌停（高=低且涨跌幅接近板块涨跌停上限）。"""
    if prev_close <= 0:
        return False
    if abs(bar["high"] - bar["low"]) > max(0.005, prev_close * 0.001):
        return False
    pct = abs((bar["close"] - prev_close) / prev_close * 100.0)
    lim = limit_pct_for_stock(code, name)
    return pct >= lim - 0.6


def calc_atr_series(bars: List[dict], period: int = 14) -> List[float]:
    """计算与 bars 等长的 ATR 序列（前 period 根使用可用均值）。"""
    n = len(bars)
    if n == 0:
        return []
    trs: List[float] = [bars[0]["high"] - bars[0]["low"]]
    for i in range(1, n):
        pc = bars[i - 1]["close"]
        h, lo = bars[i]["high"], bars[i]["low"]
        trs.append(max(h - lo, abs(h - pc), abs(lo - pc)))

    atrs: List[float] = []
    running = 0.0
    for i, tr in enumerate(trs):
        if i < period:
            running += tr
            atrs.append(running / (i + 1))
        else:
            prev_atr = atrs[-1]
            atrs.append((prev_atr * (period - 1) + tr) / period)
    return atrs


def _price_percentile(bars: List[dict], end_idx: int, price: float, window: int = 60) -> float:
    """计算 price 在 [end_idx - window + 1, end_idx] 区间内的相对位置分位 (0~100)。"""
    start = max(0, end_idx - window + 1)
    seg = bars[start : end_idx + 1]
    if not seg:
        return 50.0
    hi = max(b["high"] for b in seg)
    lo = min(b["low"] for b in seg)
    if hi <= lo:
        return 50.0
    return max(0.0, min(100.0, (price - lo) / (hi - lo) * 100.0))


def _avg_vol(bars: List[dict], end_idx: int, period: int) -> float:
    """计算 [end_idx - period, end_idx - 1]（不含 end_idx 当日）的均量。"""
    start = max(0, end_idx - period)
    seg = bars[start:end_idx]
    if not seg:
        return bars[end_idx]["vol"] if 0 <= end_idx < len(bars) else 0.0
    return sum(b["vol"] for b in seg) / len(seg)


def detect_gaps(
    bars: List[dict],
    atrs: List[float],
    code: str = "",
    name: str = "",
    lookback: int = 45,
) -> List[dict]:
    """
    缺口状态机：
    - 识别有效向上缺口 (low[t] > high[t-1]) 与有效向下缺口 (high[t] < low[t-1])
    - 过滤幅度小于 max(0.5% * prev_close, 0.3 * ATR14) 的微噪声缺口
    - 剔除一字涨停/一字跌停产生的通道缺口
    - 追踪缺口是否已被后续 K 线完全回补、以及是否满足「3日不补确认」
    """
    n = len(bars)
    if n < 3:
        return []

    start_idx = max(1, n - lookback)
    gaps: List[dict] = []

    for i in range(start_idx, n):
        prev_b = bars[i - 1]
        cur_b = bars[i]
        pc = prev_b["close"]
        if pc <= 0:
            continue
        if is_one_word_limit_bar(cur_b, pc, code, name):
            continue

        atr_i = atrs[i - 1] if i - 1 < len(atrs) else 0.0
        min_gap = max(pc * 0.005, 0.30 * atr_i)

        direction: Optional[str] = None
        gap_low = 0.0
        gap_high = 0.0
        if cur_b["low"] > prev_b["high"] and (cur_b["low"] - prev_b["high"]) >= min_gap:
            direction = "up"
            gap_low = prev_b["high"]
            gap_high = cur_b["low"]
        elif cur_b["high"] < prev_b["low"] and (prev_b["low"] - cur_b["high"]) >= min_gap:
            direction = "down"
            gap_low = cur_b["high"]
            gap_high = prev_b["low"]

        if not direction:
            continue

        gap_pct = round(((gap_high - gap_low) / pc) * 100.0, 2)
        filled = False
        filled_idx: Optional[int] = None
        filled_within_3d = False
        for j in range(i + 1, n):
            if direction == "up" and bars[j]["low"] <= gap_low:
                filled = True
                filled_idx = j
                if j - i <= 3:
                    filled_within_3d = True
                break
            if direction == "down" and bars[j]["high"] >= gap_high:
                filled = True
                filled_idx = j
                if j - i <= 3:
                    filled_within_3d = True
                break

        age_days = (n - 1) - i
        confirmed_3d = (not filled) and (age_days >= 3)
        gaps.append({
            "index": i,
            "date": cur_b["date"],
            "direction": direction,
            "gapLow": round(gap_low, 2),
            "gapHigh": round(gap_high, 2),
            "gapPct": gap_pct,
            "filled": filled,
            "filledDate": bars[filled_idx]["date"] if filled_idx is not None else None,
            "filledWithin3d": filled_within_3d,
            "ageDays": age_days,
            "confirmed3d": confirmed_3d,
        })

    return gaps


def detect_island_reversals(
    bars: List[dict],
    gaps: List[dict],
    max_island_days: int = 15,
    recent_window: int = 5,
) -> Tuple[Optional[dict], Optional[dict]]:
    """
    识别近期出现的顶部岛形反转 (TOP_ISLAND) 与底部岛形反转 (BOTTOM_ISLAND)：
    - 右侧反转缺口需发生在最近 recent_window 个交易日内，且尚未被反向完全回补
    - 孤岛区长度在 1 ~ max_island_days 根 K 线之间，价格区间与左右两侧严格隔离
    - 顶部岛形反转要求处于 60 日相对高位 (>=60%)；底部岛形反转要求处于 60 日相对低位 (<=40%) 且右侧缺口放量并守住缺口
    """
    n = len(bars)
    if n < 10 or len(gaps) < 2:
        return None, None

    top_island: Optional[dict] = None
    bottom_island: Optional[dict] = None

    # 从最近形成的缺口往前找右侧缺口
    for right in reversed(gaps):
        r_idx = right["index"]
        if (n - 1) - r_idx > recent_window:
            break
        if right["filled"]:
            continue

        if right["direction"] == "down" and top_island is None:
            # 寻找配对的左侧向上缺口
            for left in reversed(gaps):
                l_idx = left["index"]
                if l_idx >= r_idx:
                    continue
                span = r_idx - l_idx
                if span < 1 or span > max_island_days:
                    continue
                if left["direction"] != "up":
                    continue
                island_bars = bars[l_idx:r_idx]
                island_min = min(b["low"] for b in island_bars)
                island_max = max(b["high"] for b in island_bars)
                # 严格价格隔离：孤岛最低价高于左右两侧缺口下沿
                barrier = max(bars[l_idx - 1]["high"], bars[r_idx]["high"])
                if island_min <= barrier:
                    continue
                pos60 = _price_percentile(bars, r_idx, island_max, window=60)
                if pos60 < 60.0:
                    continue
                top_island = {
                    "code": "TOP_ISLAND",
                    "name": "顶部岛形反转",
                    "side": "bearish",
                    "severity": "veto",
                    "leftGapDate": left["date"],
                    "rightGapDate": right["date"],
                    "islandDays": span,
                    "islandLow": round(island_min, 2),
                    "islandHigh": round(island_max, 2),
                    "resistanceGapLow": right["gapLow"],
                    "resistanceGapHigh": right["gapHigh"],
                    "pos60": round(pos60, 1),
                    "desc": (
                        f"高位（60日分位{pos60:.0f}%）形成{span}日悬空孤岛（{left['date']}向上跳空→{right['date']}向下跳空破位），"
                        f"上方 ¥{island_min:.2f}~¥{island_max:.2f} 形成密集套牢区，严禁左侧抄底或正T"
                    ),
                }
                break

        elif right["direction"] == "up" and bottom_island is None:
            # 寻找配对的左侧向下缺口
            for left in reversed(gaps):
                l_idx = left["index"]
                if l_idx >= r_idx:
                    continue
                span = r_idx - l_idx
                if span < 1 or span > max_island_days:
                    continue
                if left["direction"] != "down":
                    continue
                island_bars = bars[l_idx:r_idx]
                island_min = min(b["low"] for b in island_bars)
                island_max = max(b["high"] for b in island_bars)
                # 严格价格隔离：孤岛最高价低于左右两侧缺口上沿
                barrier = min(bars[l_idx - 1]["low"], bars[r_idx]["low"])
                if island_max >= barrier:
                    continue
                pos60 = _price_percentile(bars, r_idx, island_min, window=60)
                if pos60 > 40.0:
                    continue
                # 右侧向上缺口必须放量确认且收盘守住缺口
                r_bar = bars[r_idx]
                ma20_vol = _avg_vol(bars, r_idx, 20)
                vol_ratio = (r_bar["vol"] / ma20_vol) if ma20_vol > 0 else 1.0
                if vol_ratio < 1.5 or r_bar["close"] <= bars[r_idx - 1]["high"]:
                    continue
                bottom_island = {
                    "code": "BOTTOM_ISLAND",
                    "name": "底部岛形反转",
                    "side": "bullish",
                    "severity": "strong",
                    "leftGapDate": left["date"],
                    "rightGapDate": right["date"],
                    "islandDays": span,
                    "islandLow": round(island_min, 2),
                    "islandHigh": round(island_max, 2),
                    "supportGapLow": right["gapLow"],
                    "supportGapHigh": right["gapHigh"],
                    "volRatio": round(vol_ratio, 2),
                    "pos60": round(pos60, 1),
                    "desc": (
                        f"低位（60日分位{pos60:.0f}%）走出{span}日底部岛形反转（{left['date']}衰竭跳空→{right['date']}放量{vol_ratio:.1f}×向上突破），"
                        f"缺口支撑 ¥{right['gapLow']:.2f}~¥{right['gapHigh']:.2f} 未回补"
                    ),
                }
                break

        if top_island is not None and bottom_island is not None:
            break

    return top_island, bottom_island


def analyze_kline_patterns(
    raw_bars: Sequence[Any],
    code: str = "",
    name: str = "",
) -> dict:
    """
    综合分析日K形态与缺口状态机，供 diagnosis.py / ignition.py / strong_herd.py 共用。
    """
    bars = normalize_bars(raw_bars)
    n = len(bars)
    empty_res = {
        "patterns": [],
        "vetoSignals": [],
        "bullSignals": [],
        "activeGaps": [],
        "nearestSupportGap": None,
        "nearestResistanceGap": None,
        "hasTopIsland": False,
        "hasBottomIsland": False,
        "hasHighGravestone": False,
        "hasBearishEngulfing": False,
        "hasImmortalGuide": False,
        "summary": "无显著特殊K线形态",
    }
    if n < 10:
        return empty_res

    atrs = calc_atr_series(bars, period=14)
    gaps = detect_gaps(bars, atrs, code=code, name=name, lookback=45)
    top_island, bottom_island = detect_island_reversals(bars, gaps)

    patterns: List[dict] = []
    if top_island:
        patterns.append(top_island)
    if bottom_island:
        patterns.append(bottom_island)

    # ---- 单根/双根高频 A 股 K 线结构检测（最近 2 个交易日） ----
    cur_idx = n - 1
    cur_b = bars[cur_idx]
    prev_b = bars[cur_idx - 1]
    pc = prev_b["close"]
    ma5_vol = _avg_vol(bars, cur_idx, 5)
    ma20 = sum(b["close"] for b in bars[max(0, n - 20) : n]) / min(20, n)

    has_gravestone = False
    has_bearish_engulfing = False
    has_immortal_guide = False

    # 1) 高位天量避雷针 / 墓碑线 (HIGH_GRAVESTONE)
    for idx in (cur_idx, cur_idx - 1):
        if idx < 5:
            continue
        b = bars[idx]
        p_close = bars[idx - 1]["close"]
        if p_close <= 0 or is_one_word_limit_bar(b, p_close, code, name):
            continue
        rng = b["high"] - b["low"]
        if rng <= 0:
            continue
        body = abs(b["close"] - b["open"])
        upper_shadow = b["high"] - max(b["open"], b["close"])
        upper_pct = (upper_shadow / p_close) * 100.0
        pos60 = _price_percentile(bars, idx, b["high"], window=60)
        mv5 = _avg_vol(bars, idx, 5)
        vr5 = (b["vol"] / mv5) if mv5 > 0 else 1.0
        if (
            pos60 >= 70.0
            and upper_shadow >= 2.0 * max(body, p_close * 0.005)
            and (upper_shadow / rng) >= 0.50
            and upper_pct >= 2.5
            and vr5 >= 1.6
        ):
            has_gravestone = True
            patterns.append({
                "code": "HIGH_GRAVESTONE",
                "name": "高位天量避雷针",
                "side": "bearish",
                "severity": "high",
                "date": b["date"],
                "upperShadowPct": round(upper_pct, 2),
                "volRatio5": round(vr5, 2),
                "pos60": round(pos60, 1),
                "desc": (
                    f"{b['date']} 处于60日高位（{pos60:.0f}%）放出 {vr5:.1f}× 均量且留 {upper_pct:.1f}% 长上影线，"
                    "上方抛压沉重，严禁追高接盘"
                ),
            })
            break

    # 2) 高位放量阴包阳 / 穿头破脚 (BEARISH_ENGULFING)
    if pc > 0 and not is_one_word_limit_bar(cur_b, pc, code, name):
        prev_is_yang = prev_b["close"] > prev_b["open"]
        cur_is_yin = cur_b["close"] < cur_b["open"]
        cur_body_drop_pct = ((cur_b["open"] - cur_b["close"]) / pc) * 100.0
        engulfs = cur_b["open"] >= prev_b["close"] * 0.998 and cur_b["close"] <= prev_b["open"] * 1.002
        pos60_cur = _price_percentile(bars, cur_idx, max(cur_b["high"], prev_b["high"]), window=60)
        vol_expand = (prev_b["vol"] > 0 and cur_b["vol"] >= prev_b["vol"] * 1.3) or (
            ma5_vol > 0 and cur_b["vol"] >= ma5_vol * 1.4
        )
        if prev_is_yang and cur_is_yin and engulfs and cur_body_drop_pct >= 2.0 and pos60_cur >= 65.0 and vol_expand:
            has_bearish_engulfing = True
            patterns.append({
                "code": "BEARISH_ENGULFING",
                "name": "高位放量阴包阳",
                "side": "bearish",
                "severity": "high",
                "date": cur_b["date"],
                "bodyDropPct": round(cur_body_drop_pct, 2),
                "pos60": round(pos60_cur, 1),
                "desc": (
                    f"{cur_b['date']} 在60日高位（{pos60_cur:.0f}%）走出放量阴包阳（实体回落 {cur_body_drop_pct:.1f}%），"
                    "空头反扑吞没前阳，做T只宜逢高倒T减仓"
                ),
            })

    # 3) 仙人指路 (IMMORTAL_GUIDE)：前日温和放量试盘长上影 + 今日不破前低反包上攻
    if cur_idx >= 6 and cur_b["close"] >= ma20 * 0.98 and not has_gravestone and not top_island:
        p2_close = bars[cur_idx - 2]["close"]
        if p2_close > 0 and not is_one_word_limit_bar(prev_b, p2_close, code, name):
            p_rng = prev_b["high"] - prev_b["low"]
            p_body = abs(prev_b["close"] - prev_b["open"])
            p_upper = prev_b["high"] - max(prev_b["open"], prev_b["close"])
            p_mv5 = _avg_vol(bars, cur_idx - 1, 5)
            p_vr5 = (prev_b["vol"] / p_mv5) if p_mv5 > 0 else 1.0
            p_pos60 = _price_percentile(bars, cur_idx - 1, prev_b["high"], window=60)
            is_probe_bar = (
                p_rng > 0
                and p_upper >= 1.5 * max(p_body, p2_close * 0.004)
                and (p_upper / p_rng) >= 0.40
                and (p_upper / p2_close) >= 0.02
                and prev_b["close"] >= p2_close * 0.99
                and 1.15 <= p_vr5 <= 2.6
                and p_pos60 < 85.0
            )
            confirm_reclaim = (
                cur_b["close"] > cur_b["open"]
                and cur_b["low"] >= prev_b["low"] * 0.995
                and cur_b["close"] > max(prev_b["open"], prev_b["close"])
            )
            if is_probe_bar and confirm_reclaim:
                has_immortal_guide = True
                patterns.append({
                    "code": "IMMORTAL_GUIDE",
                    "name": "仙人指路反包",
                    "side": "bullish",
                    "severity": "medium",
                    "probeDate": prev_b["date"],
                    "confirmDate": cur_b["date"],
                    "desc": (
                        f"{prev_b['date']} 温和放量（{p_vr5:.1f}×）长上影试盘后，{cur_b['date']} 不破前低收阳反包，"
                        "主力向上试压清洗浮筹信号明确"
                    ),
                })

    # ---- 未回补活跃缺口与最近支撑/压力缺口 ----
    cur_px = cur_b["close"]
    active_gaps = [g for g in gaps if not g["filled"]]
    support_gaps = [g for g in active_gaps if g["direction"] == "up" and g["gapHigh"] <= cur_px * 1.01]
    resistance_gaps = [g for g in active_gaps if g["direction"] == "down" and g["gapLow"] >= cur_px * 0.99]

    nearest_support_gap = max(support_gaps, key=lambda g: g["gapHigh"]) if support_gaps else None
    nearest_resistance_gap = min(resistance_gaps, key=lambda g: g["gapLow"]) if resistance_gaps else None

    veto_signals = [p for p in patterns if p["side"] == "bearish"]
    bull_signals = [p for p in patterns if p["side"] == "bullish"]

    if patterns:
        summary = " ｜ ".join(p["name"] for p in patterns)
    elif nearest_support_gap and nearest_support_gap["confirmed3d"]:
        summary = f"下方存在3日不补支撑缺口（¥{nearest_support_gap['gapLow']:.2f}~¥{nearest_support_gap['gapHigh']:.2f}）"
    elif nearest_resistance_gap:
        summary = f"上方存在未回补压力缺口（¥{nearest_resistance_gap['gapLow']:.2f}~¥{nearest_resistance_gap['gapHigh']:.2f}）"
    else:
        summary = "无显著特殊K线形态"

    return {
        "patterns": patterns,
        "vetoSignals": veto_signals,
        "bullSignals": bull_signals,
        "activeGaps": active_gaps[-5:],
        "nearestSupportGap": nearest_support_gap,
        "nearestResistanceGap": nearest_resistance_gap,
        "hasTopIsland": top_island is not None,
        "hasBottomIsland": bottom_island is not None,
        "hasHighGravestone": has_gravestone,
        "hasBearishEngulfing": has_bearish_engulfing,
        "hasImmortalGuide": has_immortal_guide,
        "summary": summary,
    }
