from __future__ import annotations

import asyncio
import datetime
import json
from pathlib import Path
import re
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx
from .limitup import get_limitup_pool
from .market_data import BoundedTTLCache, _aggregate_daily_bars, fetch_em_klines, fetch_kline_rows
from .patterns import analyze_kline_patterns
from .trade_calendar import cn_today, cn_today_iso, get_market_calendar_snapshot

# 带容量上限的内存缓存，避免频繁请求上游与内存泄漏 (TTL 15 秒，上限 256 支)
CACHE_TTL_SECONDS = 15.0
_DIAGNOSIS_CACHE = BoundedTTLCache(maxsize=256, default_ttl=CACHE_TTL_SECONDS)
_DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def _normalize_bars_for_ignition(days: List[Any], default_turnover: float = 2.5) -> List[dict]:
    """将 dict 或 list 格式日K统一归一化为 evaluate_ignition_six_dims 所需标准结构。"""
    norm: List[dict] = []
    for idx, b in enumerate(days or []):
        try:
            if isinstance(b, dict):
                d_str = str(b.get("date") or "")[:10]
                o = float(b.get("open") or 0.0)
                c = float(b.get("close") or 0.0)
                h = float(b.get("high") or max(o, c))
                lo = float(b.get("low") or min(o, c))
                v = float(b.get("vol") or 0.0)
                amt = float(b.get("amount") or (v * c * 100.0))
                to_v = float(b.get("turnover") if b.get("turnover") is not None else default_turnover)
                pct = float(b["pctChg"]) if b.get("pctChg") is not None else None
            else:
                d_str = str(b[0])[:10]
                o, c, h, lo = float(b[1]), float(b[2]), float(b[3]), float(b[4])
                v = float(b[5]) if len(b) > 5 else 0.0
                amt = v * c * 100.0
                to_v = float(b[6]) if len(b) > 6 and b[6] is not None else default_turnover
                pct = None
            if c <= 0 or not d_str:
                continue
            if pct is None and norm and norm[-1]["close"] > 0:
                pct = ((c - norm[-1]["close"]) / norm[-1]["close"]) * 100.0
            amp = ((h - lo) / max(1e-6, norm[-1]["close"] if norm else o)) * 100.0
            norm.append({
                "date": d_str,
                "open": o,
                "close": c,
                "high": h,
                "low": lo,
                "vol": v,
                "amount": amt,
                "amp": round(amp, 2),
                "pctChg": round(pct, 2) if pct is not None else None,
                "turnover": to_v,
            })
        except Exception:
            continue
    return norm


def _lookup_pool_provenance(code: str) -> dict:
    """毫秒级读取本地起爆池、尾盘黑马池与在轨跟踪台账，识别该股在全站选股漏斗中的在榜状态。"""
    c6 = str(code or "").strip().zfill(6)
    prov: Dict[str, Any] = {
        "inBreakoutPool": False,
        "breakoutItem": None,
        "inDipPool": False,
        "dipItem": None,
        "inTailPool": False,
        "tailItem": None,
        "inPreMarketPool": False,
        "inTrackingPool": False,
        "trackingItem": None,
        "badges": [],
    }
    try:
        ign_file = _DATA_DIR / "ignition_latest.json"
        if ign_file.exists():
            ign_data = json.loads(ign_file.read_text(encoding="utf-8"))
            for it in ((ign_data.get("breakout") or {}).get("items") or []):
                if str(it.get("code") or "").zfill(6) == c6:
                    prov["inBreakoutPool"] = True
                    prov["breakoutItem"] = {
                        "stageLabel": it.get("stageLabel", ""),
                        "ignitionScore": it.get("ignitionScore"),
                        "dragonStars": it.get("dragonStars"),
                        "rs5d": it.get("rs5d"),
                        "entryModeLabel": it.get("entryModeLabel", ""),
                        "supportFloor": it.get("supportFloor"),
                    }
                    prov["badges"].append(f"🔥 起爆池·{it.get('stageLabel') or '在榜'}")
                    break
            for it in ((ign_data.get("dipLeaders") or {}).get("items") or []):
                if str(it.get("code") or "").zfill(6) == c6:
                    prov["inDipPool"] = True
                    prov["dipItem"] = {
                        "dipLabel": it.get("dipLabel", ""),
                        "dipScore": it.get("dipScore"),
                        "stockDrawdownPct": it.get("stockDrawdownPct"),
                    }
                    prov["badges"].append(f"🛟 深跌抄底池·{it.get('dipLabel') or '在榜'}")
                    break
    except Exception:
        pass

    try:
        wb_file = _DATA_DIR / "latest.json"
        if wb_file.exists():
            wb_data = json.loads(wb_file.read_text(encoding="utf-8"))
            for it in (wb_data.get("tail") or []):
                if str(it.get("code") or "").zfill(6) == c6:
                    prov["inTailPool"] = True
                    prov["tailItem"] = {
                        "score": it.get("score"),
                        "stop": it.get("stop"),
                        "tp1": it.get("tp1"),
                        "date": wb_data.get("tailScannedAt") or wb_data.get("date", ""),
                    }
                    prov["badges"].append("🌙 尾盘黑马在选")
                    break
            for it in (wb_data.get("candidates") or []):
                if str(it.get("code") or "").zfill(6) == c6:
                    prov["inPreMarketPool"] = True
                    prov["badges"].append("📋 盘前优选契约")
                    break
    except Exception:
        pass

    try:
        ledger_file = _DATA_DIR / "strategy_ledger.json"
        if ledger_file.exists():
            lg_data = json.loads(ledger_file.read_text(encoding="utf-8"))
            sigs = (lg_data.get("signals") or {}).values()
            matched_sigs = [
                v for v in sigs
                if isinstance(v, dict)
                and str(v.get("code") or "").zfill(6) == c6
                and v.get("strategy") in ("ignition", "bottom", "meme", "tail_watch")
                and not v.get("manualRemoved")
            ]
            if matched_sigs:
                matched_sigs.sort(key=lambda s: (1 if s.get("manualPinned") else 0, str(s.get("signalDate") or "")), reverse=True)
                top_s = matched_sigs[0]
                prov["inTrackingPool"] = True
                prov["trackingItem"] = {
                    "strategy": top_s.get("strategy", "ignition"),
                    "signalDate": top_s.get("signalDate", ""),
                    "refPrice": top_s.get("refPrice") or top_s.get("buy") or 0.0,
                    "verdict": top_s.get("verdict", "在轨跟踪"),
                }
                prov["badges"].append(f"🎯 在轨跟踪({top_s.get('signalDate') or '活跃'})")
    except Exception:
        pass

    return prov


def _build_five_step_review(
    code: str,
    quote_data: dict,
    days: List[Any],
    chips_data: dict,
    technicals_data: dict,
    kline_patterns: dict,
    limitup_data: dict,
    market_sentiment: dict,
    company_info: dict,
    all_concepts: List[str],
    matched_hot_themes: List[dict],
    risk_level: str,
    red_flags: List[dict],
    yellow_alerts: List[dict],
) -> dict:
    """
    将五步交易系统（「1.顺天时 → 2.抓主线 → 3.五星游龙/起爆六维 → 4.严执行硬止损」）
    与起爆挖掘/尾盘黑马/在轨跟踪池来源完整汇聚到全景诊股报告，彻底消除双端口径割裂。
    """
    cur_px = float(quote_data.get("price") or 0.0)
    day_chg = float(quote_data.get("chg") or 0.0)
    chg_5d = float(technicals_data.get("chg5d") or 0.0)
    ma5 = float(chips_data.get("ma5") or cur_px)
    ma20 = float(chips_data.get("ma20") or cur_px)

    # Step 1: 顺天时（上证结构 + 相对大盘超额抗跌度 RS）
    macro_timing = (limitup_data or {}).get("macroTiming") or (market_sentiment or {}).get("macroTiming") or {}
    risk_valve = str((market_sentiment or {}).get("riskValve") or "GREEN")
    sh_struct = str(macro_timing.get("structure") or "RANGE")
    sh_struct_label = str(macro_timing.get("structureLabel") or "震荡结构")
    sh_chg_1d = float(macro_timing.get("anchorChg") or 0.0)
    sh_chg_5d = float(macro_timing.get("anchorChg5d") or 0.0)
    sh_bot_div = bool(macro_timing.get("bottomDivergence"))
    sh_top_div = bool(macro_timing.get("topDivergence"))

    rs_5d = round(chg_5d - sh_chg_5d, 2)
    rs_1d = round(day_chg - sh_chg_1d, 2)
    above_ma20 = bool(cur_px >= ma20 * 0.995) if (cur_px > 0 and ma20 > 0) else True
    right_side_confirm = bool(
        cur_px > 0
        and cur_px >= ma5 * 0.998
        and day_chg >= 0.8
        and cur_px >= float(quote_data.get("open") or cur_px) * 0.999
    )
    is_resilient = bool((rs_5d >= 2.5 and above_ma20) or (rs_5d >= 4.0 and above_ma20))

    if sh_struct == "DOWNTREND" or risk_valve == "RED":
        regime_mode = "BEAR_STRICT"
        regime_label = "🎯 指数底背离·逆势严选" if sh_bot_div else "🛡️ 大盘下行·逆势严选"
    elif sh_struct == "RANGE" or risk_valve == "YELLOW" or sh_top_div:
        regime_mode = "RANGE_SELECTIVE"
        regime_label = "⚖️ 大盘震荡·去弱留强"
    else:
        regime_mode = "BULL_NORMAL"
        regime_label = "🔥 大盘顺势·常态出击"

    # Step 2: 抓主线（匹配看板 Top 主线板块与周期阶段）
    main_themes = ((limitup_data or {}).get("mainThemes") or {}).get("themes") or []
    matched_main_theme: Optional[dict] = None
    ind_name = str((company_info or {}).get("industry") or "").strip()
    cand_names = [ind_name, *(all_concepts or []), *[t.get("name", "") for t in (matched_hot_themes or [])]]
    for th in main_themes:
        th_stocks = th.get("stocks") or []
        if any(str(s.get("code") or "").zfill(6) == code for s in th_stocks):
            matched_main_theme = th
            break
    if not matched_main_theme:
        for th in main_themes:
            tname = str(th.get("name") or "").strip()
            if tname and any(cn and (tname in cn or cn in tname) for cn in cand_names):
                matched_main_theme = th
                break

    # Step 3: 择良标（复用 ignition.evaluate_ignition_six_dims 计算五星游龙与涨停回调六维）
    ignition_eval: Optional[dict] = None
    norm_daily = _normalize_bars_for_ignition(days, default_turnover=float(quote_data.get("turnover") or 2.5))
    if len(norm_daily) >= 25:
        try:
            from .ignition import evaluate_ignition_six_dims
            w_bars = _aggregate_daily_bars(norm_daily, "week")
            m_bars = _aggregate_daily_bars(norm_daily, "month")
            ignition_eval = evaluate_ignition_six_dims(
                code,
                norm_daily,
                w_bars,
                m_bars,
                cur_price=cur_px,
                day_chg=day_chg,
                lookback_days=60,
                notice={"riskLevel": risk_level, "redFlags": red_flags, "yellowAlerts": yellow_alerts},
                name=str(quote_data.get("name") or code),
                float_cap_yi=float(quote_data.get("cap") or 0.0),
                turnover_pct=float(quote_data.get("turnover") or 0.0),
                main_theme_info=matched_main_theme,
            )
        except Exception:
            ignition_eval = None

    if regime_mode == "BEAR_STRICT":
        entry_mode_label = "✅ 右侧阳线确认" if right_side_confirm else "⏳ 禁早潜伏·等右侧阳线"
    elif regime_mode == "RANGE_SELECTIVE":
        entry_mode_label = "✅ 右侧转强" if right_side_confirm else "👀 回踩均线等拐头"
    else:
        entry_mode_label = "✅ 右侧点火" if right_side_confirm else "🎯 缩量回踩低吸窗口"

    provenance = _lookup_pool_provenance(code)

    return {
        "step1Timing": {
            "regimeMode": regime_mode,
            "regimeLabel": regime_label,
            "indexStructure": sh_struct,
            "indexStructureLabel": sh_struct_label,
            "positionPlan": macro_timing.get("positionPlan") or "",
            "shChg1d": sh_chg_1d,
            "shChg5d": sh_chg_5d,
            "rs1d": rs_1d,
            "rs5d": rs_5d,
            "aboveMa20": above_ma20,
            "isResilient": is_resilient,
            "rightSideConfirm": right_side_confirm,
            "entryModeLabel": entry_mode_label,
            "indexBottomDivergence": sh_bot_div,
            "indexTopDivergence": sh_top_div,
        },
        "step2MainTheme": {
            "isMainTheme": matched_main_theme is not None,
            "themeName": (matched_main_theme or {}).get("name") or (matched_hot_themes[0]["name"] if matched_hot_themes else ""),
            "cycleStage": (matched_main_theme or {}).get("cycleStage") or "",
            "cycleStageLabel": (matched_main_theme or {}).get("cycleStageLabel") or ("🔥 热门题材" if matched_hot_themes else "⚪ 非当前主线"),
            "rsVsIndex": (matched_main_theme or {}).get("rsVsIndex"),
            "ztCount": (matched_main_theme or {}).get("ztCount"),
        },
        "step3Dragon": {
            "available": ignition_eval is not None,
            "dragonStars": (ignition_eval or {}).get("dragonStars"),
            "dragonLabel": (ignition_eval or {}).get("dragonLabel") or "—",
            "dragonDims": (ignition_eval or {}).get("dragonDims") or [],
            "ignitionScore": (ignition_eval or {}).get("ignitionScore"),
            "stage": (ignition_eval or {}).get("stage") or "",
            "stageLabel": (ignition_eval or {}).get("stageLabel") or "—",
            "stageTip": (ignition_eval or {}).get("stageTip") or "",
            "checklist": (ignition_eval or {}).get("checklist") or [],
            "supportFloor": (ignition_eval or {}).get("supportFloor") or 0.0,
            "volShrinkPct": (ignition_eval or {}).get("volShrinkPct"),
            "monthVolRatio": (ignition_eval or {}).get("monthVolRatio"),
            "maSpreadPct": (ignition_eval or {}).get("maSpreadPct"),
            "shakeoutSignals": (ignition_eval or {}).get("shakeoutSignals") or [],
        },
        "provenance": provenance,
    }


def calc_ema(values: List[float], period: int) -> List[float]:
    if not values:
        return []
    k = 2.0 / (period + 1)
    emas = [values[0]]
    for v in values[1:]:
        emas.append(v * k + emas[-1] * (1.0 - k))
    return emas


def calc_macd(closes: List[float]) -> Dict[str, Any]:
    if len(closes) < 26:
        return {"dif": 0.0, "dea": 0.0, "hist": 0.0, "isGolden": False, "isBullHist": False, "isDead": False}
    ema12 = calc_ema(closes, 12)
    ema26 = calc_ema(closes, 26)
    difs = [a - b for a, b in zip(ema12, ema26)]
    deas = calc_ema(difs, 9)
    hists = [(d - e) * 2.0 for d, e in zip(difs, deas)]
    dif, dea, hist = difs[-1], deas[-1], hists[-1]
    prev_dif = difs[-2] if len(difs) >= 2 else dif
    prev_dea = deas[-2] if len(deas) >= 2 else dea
    prev_hist = hists[-2] if len(hists) >= 2 else hist
    is_golden = (prev_dif <= prev_dea and dif > dea) or (dif > dea and hist > prev_hist and hist > 0)
    is_dead = (prev_dif >= prev_dea and dif < dea) or (dif < dea and hist < 0)
    return {
        "dif": round(dif, 3),
        "dea": round(dea, 3),
        "hist": round(hist, 3),
        "isGolden": is_golden,
        "isBullHist": hist > 0 and hist >= prev_hist,
        "isDead": is_dead,
    }


def calc_rsi(closes: List[float], period: int = 6) -> float:
    """标准 Wilder 平滑 RSI（与前端 api.js rsiArr 及同花顺/东方财富口径一致）。"""
    if len(closes) <= period:
        return 50.0
    g = 0.0
    l = 0.0
    for i in range(1, period + 1):
        d = closes[i] - closes[i - 1]
        if d > 0:
            g += d
        else:
            l -= d
    ag = g / period
    al = l / period
    for i in range(period + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        ag = (ag * (period - 1) + (d if d > 0 else 0.0)) / period
        al = (al * (period - 1) + (-d if d < 0 else 0.0)) / period
    if al == 0:
        return 100.0 if ag > 0 else 50.0
    rs = ag / al
    return round(100.0 - (100.0 / (1.0 + rs)), 1)


def calc_cyq_chips(
    raw_bars: List[Any],
    cur_price: Optional[float] = None,
    float_cap_yi: float = 0.0,
    latest_turnover_pct: float = 0.0,
    period: int = 210,
    bins: int = 150,
    decay_coeff: float = 1.0,
    profile_bins: int = 44,
) -> Dict[str, Any]:
    """
    210日换手衰减筹码分布（CYQ / Position Cost Distribution）计算器：
    参考 InStock 与东方财富 CYQ 标准模型（默认 210 个交易日、150 档价格栅格）：
    1. 历史筹码挥发衰减：每日存量筹码按 (1 - 当日换手率 × 衰减系数) 自然衰减，近期换手自动洗出远期老筹码；
    2. 日内三角形分布：当日新增换手筹码在 [最低价, 典型均价, 最高价] 区间按三角形概率密度分配（一字板归入单档）；
    3. 输出指标：CYQ 加权筹码均价 (avgCost)、主峰成本 (peakPrice)、获利比例 (profitRatio)、
       90%/70% 筹码成本区间及集中度 ((高值 - 低值) / (高值 + 低值))。
    """
    def _f(v: Any, d: float = 0.0) -> float:
        try:
            return float(v) if v not in (None, "", "-", "--", "—") else d
        except (TypeError, ValueError):
            return d

    norm: List[Dict[str, Any]] = []
    for row in raw_bars or []:
        if isinstance(row, dict):
            o = _f(row.get("open"))
            c = _f(row.get("close"))
            h = _f(row.get("high"))
            lo = _f(row.get("low"))
            vol = _f(row.get("vol"))
            amt = _f(row.get("amount"))
            raw_to = row.get("turnover")
            to_val = _f(raw_to, -1.0) if raw_to is not None else -1.0
        elif isinstance(row, (list, tuple)) and len(row) >= 6:
            o = _f(row[1])
            c = _f(row[2])
            h = _f(row[3])
            lo = _f(row[4])
            vol = _f(row[5])
            amt = _f(row[6]) if len(row) > 6 else 0.0
            to_val = _f(row[7], -1.0) if len(row) > 7 and row[7] is not None else -1.0
        else:
            continue

        if c <= 0 or h <= 0 or lo <= 0:
            continue
        if h < lo:
            h, lo = lo, h
        norm.append({
            "open": o if o > 0 else c,
            "close": c,
            "high": max(h, c),
            "low": min(lo, c),
            "vol": max(0.0, vol),
            "amount": max(0.0, amt),
            "turnover": to_val if to_val > 0 else None,
        })

    if not norm:
        px0 = round(float(cur_price or 0.0), 2)
        return {
            "cyqDays": 0,
            "avgCost": px0,
            "peakPrice": px0,
            "profitRatio": 50.0,
            "diffFromCost": 0.0,
            "cost90Low": px0,
            "cost90High": px0,
            "concentration90": 0.0,
            "cost70Low": px0,
            "cost70High": px0,
            "concentration70": 0.0,
            "concentrationTag": "moderate",
            "concentrationLabel": "筹码适度集中",
            "cyqProfile": [],
        }

    window_bars = norm[-max(1, int(period)) :]
    px = float(cur_price) if (cur_price is not None and float(cur_price) > 0) else window_bars[-1]["close"]

    # 推算流通股本（单位：手），用于腾讯免 WAF 源缺失单日换手率字段时精确还原历史换手率
    float_lots = 0.0
    for b in reversed(window_bars[-20:]):
        if b["turnover"] is not None and b["turnover"] > 0.02 and b["vol"] > 0:
            float_lots = b["vol"] / (b["turnover"] / 100.0)
            break
    if float_lots <= 0 and float_cap_yi > 0 and px > 0:
        float_lots = (float(float_cap_yi) * 1.0e6) / px

    pos_vols = [b["vol"] for b in window_bars if b["vol"] > 0]
    avg_vol = (sum(pos_vols) / len(pos_vols)) if pos_vols else 0.0

    min_p = min(b["low"] for b in window_bars)
    max_p = max(b["high"] for b in window_bars)
    num_bins = max(20, int(bins))

    if max_p - min_p < 1e-6:
        flat_cost = round(min_p, 2)
        p_ratio = 100.0 if px > min_p else (50.0 if abs(px - min_p) <= 1e-6 else 0.0)
        diff_pct = round(((px - flat_cost) / flat_cost) * 100.0, 2) if flat_cost > 0 else 0.0
        return {
            "cyqDays": len(window_bars),
            "avgCost": flat_cost,
            "peakPrice": flat_cost,
            "profitRatio": p_ratio,
            "diffFromCost": diff_pct,
            "cost90Low": flat_cost,
            "cost90High": flat_cost,
            "concentration90": 0.0,
            "cost70Low": flat_cost,
            "cost70High": flat_cost,
            "concentration70": 0.0,
            "concentrationTag": "tight",
            "concentrationLabel": "单峰高度密集",
            "cyqProfile": [{"p": flat_cost, "pct": 100.0}],
        }

    step = (max_p - min_p) / (num_bins - 1)
    grid = [min_p + k * step for k in range(num_bins)]
    chip_mass = [0.0] * num_bins
    coeff = max(0.1, float(decay_coeff))
    last_idx = len(window_bars) - 1

    for idx_b, b in enumerate(window_bars):
        vol_b = b["vol"]
        if vol_b <= 0:
            continue
        if b["turnover"] is not None and b["turnover"] > 0:
            turn_pct = b["turnover"]
        elif idx_b == last_idx and latest_turnover_pct > 0:
            turn_pct = float(latest_turnover_pct)
        elif float_lots > 0:
            turn_pct = (vol_b / float_lots) * 100.0
        elif avg_vol > 0:
            turn_pct = (vol_b / avg_vol) * 2.0
        else:
            turn_pct = 2.0

        hsl = min(0.99, max(0.0005, (turn_pct / 100.0) * coeff))
        remain = 1.0 - hsl
        for k in range(num_bins):
            chip_mass[k] *= remain

        lo, hi, o, c = b["low"], b["high"], b["open"], b["close"]
        if b["amount"] > 0 and vol_b > 0:
            vwap_b = b["amount"] / (vol_b * 100.0)
            avg_p = vwap_b if (lo <= vwap_b <= hi) else ((o + c + hi + lo) / 4.0)
        else:
            avg_p = (o + c + hi + lo) / 4.0
        avg_p = max(lo, min(hi, avg_p))

        if hi - lo <= step * 0.5:
            k_idx = max(0, min(num_bins - 1, int(round((c - min_p) / step))))
            chip_mass[k_idx] += hsl
            continue

        k_start = max(0, int((lo - min_p) / step) - 1)
        k_end = min(num_bins - 1, int((hi - min_p) / step) + 1)
        weights: List[Tuple[int, float]] = []
        w_sum = 0.0
        for k in range(k_start, k_end + 1):
            seg_lo = max(lo, grid[k] - 0.5 * step)
            seg_hi = min(hi, grid[k] + 0.5 * step)
            if seg_hi <= seg_lo:
                continue
            mid = 0.5 * (seg_lo + seg_hi)
            if mid <= avg_p:
                height = ((mid - lo) / (avg_p - lo)) if (avg_p - lo) > 1e-9 else 1.0
            else:
                height = ((hi - mid) / (hi - avg_p)) if (hi - avg_p) > 1e-9 else 1.0
            w = max(0.0, height) * (seg_hi - seg_lo)
            if w > 0:
                weights.append((k, w))
                w_sum += w

        if w_sum > 0:
            scale = hsl / w_sum
            for k, w in weights:
                chip_mass[k] += w * scale
        else:
            k_idx = max(0, min(num_bins - 1, int(round((c - min_p) / step))))
            chip_mass[k_idx] += hsl

    total_mass = sum(chip_mass)
    if total_mass <= 0:
        pdf = [1.0 / num_bins] * num_bins
    else:
        pdf = [m / total_mass for m in chip_mass]

    avg_cost = sum(p * w for p, w in zip(grid, pdf))

    profit_mass = 0.0
    for k, w in enumerate(pdf):
        if w <= 0:
            continue
        b_lo = grid[k] - 0.5 * step
        b_hi = grid[k] + 0.5 * step
        if px >= b_hi:
            profit_mass += w
        elif px > b_lo:
            profit_mass += w * ((px - b_lo) / step)
    profit_ratio = max(0.0, min(100.0, profit_mass * 100.0))

    def _quantile(q: float) -> float:
        cum = 0.0
        for k, w in enumerate(pdf):
            nxt = cum + w
            if nxt >= q and w > 0:
                b_lo = max(min_p, grid[k] - 0.5 * step)
                b_hi = min(max_p, grid[k] + 0.5 * step)
                frac = max(0.0, min(1.0, (q - cum) / w))
                return b_lo + frac * (b_hi - b_lo)
            cum = nxt
        return max_p

    cost90_low = _quantile(0.05)
    cost90_high = _quantile(0.95)
    cost70_low = _quantile(0.15)
    cost70_high = _quantile(0.85)

    conc90 = ((cost90_high - cost90_low) / (cost90_high + cost90_low) * 100.0) if (cost90_high + cost90_low) > 0 else 0.0
    conc70 = ((cost70_high - cost70_low) / (cost70_high + cost70_low) * 100.0) if (cost70_high + cost70_low) > 0 else 0.0

    smooth_pdf = (
        [0.65 * pdf[0] + 0.35 * pdf[1]]
        + [0.25 * pdf[k - 1] + 0.50 * pdf[k] + 0.25 * pdf[k + 1] for k in range(1, num_bins - 1)]
        + [0.35 * pdf[-2] + 0.65 * pdf[-1]]
    )
    peak_idx = max(range(num_bins), key=lambda k: smooth_pdf[k])
    peak_price = grid[peak_idx]

    if conc90 <= 10.0 or (conc90 <= 12.0 and conc70 <= 6.5):
        conc_tag = "tight"
        conc_label = "单峰高度密集"
    elif conc90 <= 18.0:
        conc_tag = "moderate"
        conc_label = "筹码适度集中"
    else:
        conc_tag = "dispersed"
        conc_label = "多峰发散博弈"

    # 区间重叠守恒重采样：将 150 档精细密度无锯齿聚合为精简版横向筹码柱数组（默认 44 档，低价->高价）
    cyq_profile: List[Dict[str, float]] = []
    m_bins = min(num_bins, max(0, int(profile_bins))) if profile_bins and profile_bins > 0 else 0
    if m_bins >= 8:
        p_step = (max_p - min_p) / m_bins
        coarse_mass = [0.0] * m_bins
        for k, w in enumerate(pdf):
            if w <= 0:
                continue
            f_lo = max(min_p, grid[k] - 0.5 * step)
            f_hi = min(max_p, grid[k] + 0.5 * step)
            f_w = f_hi - f_lo
            if f_w <= 1e-12:
                j_idx = min(m_bins - 1, max(0, int((grid[k] - min_p) / p_step)))
                coarse_mass[j_idx] += w
                continue
            j_start = max(0, int((f_lo - min_p) / p_step))
            j_end = min(m_bins - 1, int((f_hi - min_p) / p_step))
            for j in range(j_start, j_end + 1):
                c_lo = min_p + j * p_step
                c_hi = c_lo + p_step
                ov = min(f_hi, c_hi) - max(f_lo, c_lo)
                if ov > 0:
                    coarse_mass[j] += w * (ov / f_w)
        c_tot = sum(coarse_mass) or 1.0
        for j in range(m_bins):
            p_mid = min_p + (j + 0.5) * p_step
            cyq_profile.append({
                "p": round(p_mid, 2),
                "pct": round((coarse_mass[j] / c_tot) * 100.0, 3),
            })

    return {
        "cyqDays": len(window_bars),
        "avgCost": round(avg_cost, 2),
        "peakPrice": round(peak_price, 2),
        "profitRatio": round(profit_ratio, 1),
        "diffFromCost": round(((px - avg_cost) / avg_cost) * 100.0, 2) if avg_cost > 0 else 0.0,
        "cost90Low": round(cost90_low, 2),
        "cost90High": round(cost90_high, 2),
        "concentration90": round(conc90, 2),
        "cost70Low": round(cost70_low, 2),
        "cost70High": round(cost70_high, 2),
        "concentration70": round(conc70, 2),
        "concentrationTag": conc_tag,
        "concentrationLabel": conc_label,
        "cyqProfile": cyq_profile,
    }


def classify_announcement(title: str) -> Tuple[str, str]:
    """根据公告标题分类并评级：返回 (level, tag)"""
    red_keywords = [
        ("减持", "减持风险"),
        ("立案", "立案调查"),
        ("警示函", "监管警示"),
        ("退市", "退市风险"),
        ("亏损", "业绩预亏"),
        ("下修", "业绩下修"),
        ("冻结", "司法冻结"),
        ("诉讼", "重大诉讼"),
        ("违规", "违规问责"),
        ("逾期", "债务逾期"),
        ("强制执行", "司法风险"),
        ("重整", "破产重整"),
    ]
    yellow_keywords = [
        ("质押", "股权质押"),
        ("解禁", "解禁提示"),
        ("异常波动", "异动警示"),
        ("严重异常波动", "异动监管"),
        ("停牌", "停牌核查"),
        ("询价", "转让提示"),
        ("问询函", "监管问询"),
        ("关注函", "交易所关注"),
    ]
    green_keywords = [
        ("预增", "业绩预增"),
        ("扭亏", "业绩扭亏"),
        ("中标", "重大中标"),
        ("合同", "重大合同"),
        ("增持", "股东增持"),
        ("回购", "回购股份"),
        ("投资设立", "对外投资"),
        ("合作", "战略合作"),
        ("获批", "产品获批"),
        ("分红", "权益分派"),
    ]

    # 若为“减持结果/实施完毕/时间届满/不减持”，实属利空出尽或已落地历史，降级为提示而非高危否决雷
    if "减持" in title and any(k in title for k in ("结果", "完毕", "届满", "终止", "放弃", "不减持", "未减持")):
        return "yellow", "减持完结"

    for kw, tag in red_keywords:
        if kw in title:
            return "red", tag
    for kw, tag in green_keywords:
        if kw in title:
            return "green", tag
    for kw, tag in yellow_keywords:
        if kw in title:
            return "yellow", tag
    return "gray", "常规"


def build_comprehensive_decision(
    quote: dict,
    chips: dict,
    technicals: dict,
    intraday: dict,
    second_wave: dict,
    sector_ecology: dict,
    matched_hot_themes: list,
    red_flags: list,
    yellow_alerts: list,
    green_catalysts: list,
    market_sentiment: dict,
    atr_profile: Optional[dict] = None,
    experimental_dna: Optional[dict] = None,
    kline_patterns: Optional[dict] = None,
    trade_calendar: Optional[dict] = None,
    five_step_review: Optional[dict] = None,
) -> dict:
    """
    结合公告排雷、技术均线趋势、筹码位置、日内分时VWAP与板块/大盘情绪，
    综合评估：1.综合评分(0-100)；2.能不能买；3.风险如何；4.现在是不是买点及挂单计划。
    """
    cur_px = float(quote.get("price", 0.0) or 0.0)
    pe = float(quote.get("pe", 0.0) or 0.0)
    buy_ratio = float(quote.get("buyRatio", 50.0) or 50.0)

    positive_points: List[str] = []
    risk_points: List[str] = []

    # ---- 维度1：基本面与公告排雷 (满分 20) ----
    fund_score = 16
    if green_catalysts:
        fund_score += 3
        positive_points.append(f"近期存在利好催化公告（{green_catalysts[0]['tag']}：{green_catalysts[0]['title'][:20]}）")
    else:
        positive_points.append("近30天未排查到减持、立案调查或退市类高危利空公告")

    if yellow_alerts:
        fund_score -= 3
        risk_points.append(f"存在 {len(yellow_alerts)} 条提示性公告（如{yellow_alerts[0]['tag']}），需留意资金态度")
    if red_flags:
        fund_score -= 13
        risk_points.append(f"🚨 高危公告雷区（{red_flags[0]['tag']}）：{red_flags[0]['title'][:24]}")
    if pe < 0:
        fund_score -= 3
        risk_points.append("当前动态市盈率为负（公司业绩处于亏损区间）")
    elif pe > 120:
        fund_score -= 1
        risk_points.append(f"当前市盈率偏高（PE {pe:.1f}），估值安全边际较薄")
    fund_score = max(0, min(20, fund_score))
    fund_desc = "存在严重利空雷区" if red_flags else ("有催化且无重大雷区" if green_catalysts else "基本面公告整体平稳")

    # ---- 维度2：技术趋势与均线安全 (满分 25) ----
    trend_status = technicals.get("trendStatus", "均线交织整理")
    is_bull = bool(technicals.get("isBullAlign", False))
    is_broken = bool(technicals.get("isBrokenDown", False))
    is_doji = bool(technicals.get("isBottomDoji", False))
    is_ignition = bool(technicals.get("isVolIgnition", False))
    is_macd_golden = bool(technicals.get("isMacdGolden", False))
    rsi6 = float(technicals.get("rsi6", 50.0) or 50.0)

    if is_bull:
        trend_score = 21
        positive_points.append("日线处于多头主升排列（MA5 > MA10 > MA20），中期趋势占优")
    elif trend_status == "回踩支撑震荡":
        trend_score = 17
        positive_points.append("现价稳站在 20 日均线生命线上方，属于趋势内回踩支撑区")
    elif is_broken:
        trend_score = 5
        risk_points.append("🚨 跌破 MA20 与 MA60 形成破位空头下行，均线系统呈反压态，严禁左侧盲目抄底")
        if is_doji:
            trend_score += 4
            positive_points.append("破位下方出现缩量止跌十字星/长下影试探信号，存在反抽修复预期")
        if rsi6 <= 25:
            trend_score += 3
            positive_points.append(f"6日 RSI 跌至 {rsi6:.1f}（深度超卖区），短线乖离存在超跌反弹需求")
    else:
        trend_score = 13

    if is_macd_golden or is_ignition:
        trend_score += 2
        if is_ignition:
            positive_points.append("日K线呈现放量阳线点火启动形态")
        elif is_macd_golden:
            positive_points.append("MACD 呈现金叉或红柱放大，短期多头动能恢复")

    kp = kline_patterns or {}
    has_top_island = bool(kp.get("hasTopIsland", False))
    has_bottom_island = bool(kp.get("hasBottomIsland", False))
    has_gravestone = bool(kp.get("hasHighGravestone", False))
    has_bearish_engulfing = bool(kp.get("hasBearishEngulfing", False))
    has_immortal_guide = bool(kp.get("hasImmortalGuide", False))

    if has_top_island:
        trend_score -= 12
        top_p = next((p for p in kp.get("patterns", []) if p.get("code") == "TOP_ISLAND"), None)
        risk_points.append(f"🚨 K线高危【顶部岛形反转】：{(top_p or {}).get('desc', '高位向下跳空形成套牢孤岛，严禁抄底')}")
    if has_gravestone:
        trend_score -= 6
        gs_p = next((p for p in kp.get("patterns", []) if p.get("code") == "HIGH_GRAVESTONE"), None)
        risk_points.append(f"🚨 K线警示【高位天量避雷针】：{(gs_p or {}).get('desc', '高位放量长上影抛压沉重')}")
    if has_bearish_engulfing:
        trend_score -= 6
        be_p = next((p for p in kp.get("patterns", []) if p.get("code") == "BEARISH_ENGULFING"), None)
        risk_points.append(f"🚨 K线警示【高位放量阴包阳】：{(be_p or {}).get('desc', '空头放量吞没前阳')}")
    if has_bottom_island:
        trend_score += 5
        bi_p = next((p for p in kp.get("patterns", []) if p.get("code") == "BOTTOM_ISLAND"), None)
        positive_points.append(f"🔥 K线强反转【底部岛形反转】：{(bi_p or {}).get('desc', '低位放量向上跳空确立反转')}")
    if has_immortal_guide:
        trend_score += 3
        ig_p = next((p for p in kp.get("patterns", []) if p.get("code") == "IMMORTAL_GUIDE"), None)
        positive_points.append(f"✨ K线结构【仙人指路反包】：{(ig_p or {}).get('desc', '试盘长上影次日收阳反包')}")

    bd_sub = kp.get("bollDivergence") or {}
    if kp.get("hasTopDivergence") or bd_sub.get("topDivergence"):
        trend_score -= 6
        risk_points.append(f"⚠️ 卖出预警【{bd_sub.get('topDivLabel') or 'MACD顶背离'}】：{bd_sub.get('topDivDesc', '股价新高但动能背离，宜逢高锁盈减仓')}")
    if kp.get("hasBottomDivergence") or bd_sub.get("bottomDivergence"):
        trend_score += 4
        positive_points.append(f"🎯 止跌信号【{bd_sub.get('bottomDivLabel') or 'MACD底背离'}】：{bd_sub.get('bottomDivDesc', '回踩低位但空头动能衰竭，关注右侧拐头买点')}")

    if rsi6 >= 78:
        trend_score -= 4
        risk_points.append(f"6日 RSI 达 {rsi6:.1f}（短线严重超买钝化），追高极易触发回吐")
    trend_score = max(0, min(25, trend_score))
    boll_txt = f" · BOLL {bd_sub.get('structureLabel')}" if bd_sub.get("structureLabel") else ""
    trend_desc = f"{trend_status}{boll_txt} · RSI6={rsi6:.1f}"

    # ---- 维度3：筹码结构与量价配合 (满分 20，融合 210 日换手衰减 CYQ) ----
    box_pos = float(chips.get("boxPos", 50.0) or 50.0)
    profit_ratio = float(chips.get("profitRatio", 50.0) or 50.0)
    conc90 = float(chips.get("concentration90", 0.0) or 0.0)
    peak_px = float(chips.get("peakPrice", 0.0) or 0.0)
    avg_cost_val = float(chips.get("avgCost", 0.0) or 0.0)
    stage_tag = second_wave.get("stageTag", "normal")
    is_stagnation = bool(technicals.get("isHighStagnation", False))
    chg5d = float(technicals.get("chg5d", 0.0) or 0.0)

    chip_score = 13
    if stage_tag == "golden_second":
        chip_score += 6
        positive_points.append("二波黄金蓄势形态（首轮主升后缩量回踩支撑，抛压已充分沉淀）")
    elif stage_tag == "dead":
        chip_score -= 6
        risk_points.append("高位深度回撤破位，二波逻辑已被证伪，上方套牢盘解套抛压沉重")

    if box_pos <= 42 and not is_broken:
        chip_score += 3
        positive_points.append(f"当前股价处于 20 日箱体中下沿（{box_pos:.0f}%分位），上方阻力距离较充裕")

    if 0.0 < conc90 <= 10.0 and not is_broken and (avg_cost_val <= 0 or cur_px >= avg_cost_val * 0.965):
        chip_score += 3
        peak_txt = f"，主峰 ¥{peak_px:.2f}" if peak_px > 0 else ""
        positive_points.append(f"CYQ 筹码高度集中（90%集中度 {conc90:.1f}%{peak_txt}），主力锁仓合力较强")
    elif conc90 >= 22.0 and profit_ratio < 40.0:
        chip_score -= 2
        risk_points.append(f"CYQ 筹码呈宽幅发散（90%集中度 {conc90:.1f}%），上方多峰历史套牢盘阻力较重")

    if is_stagnation or (chg5d >= 20.0 and profit_ratio >= 88.0):
        chip_score -= 7
        risk_points.append(f"近5日涨幅 {chg5d:+.1f}% 且高位放量滞涨/获利盘高达 {profit_ratio:.0f}%，谨防主力高位派发接盘")

    if profit_ratio < 20.0 and is_broken:
        chip_score -= 4
        risk_points.append(f"当前获利筹码不足 {profit_ratio:.1f}%，上方 80% 筹码处于套牢状态，反弹阻力大")

    s3_drg = (five_step_review or {}).get("step3Dragon") or {}
    drg_stars = float(s3_drg.get("dragonStars") or 0.0)
    drg_stage = str(s3_drg.get("stage") or "")
    if drg_stars >= 4.0 and drg_stage in ("SHAKEOUT_READY", "CONVERGED_WAIT", "IGNITING"):
        chip_score += 3
        trend_score = min(25, trend_score + 2)
        positive_points.insert(
            0,
            f"🐉 命中【{s3_drg.get('dragonLabel') or '五星游龙'} ({drg_stars:.1f}★)】· {s3_drg.get('stageLabel')}（板后缩量至 {s3_drg.get('volShrinkPct') or '—'}%）",
        )

    chip_score = max(0, min(20, chip_score))
    chip_desc = (
        f"获利盘 {profit_ratio:.0f}% · 90%集中 {conc90:.1f}%"
        if conc90 > 0
        else f"箱体分位 {box_pos:.0f}% · 获利盘 {profit_ratio:.0f}%"
    )

    # ---- 维度4：分时盘口与资金承接 (满分 20) ----
    is_today_intraday = intraday.get("isToday", True) if intraday else False
    p_type = intraday.get("patternType", "chop") if is_today_intraday else "stale"
    vwap_diff = float(intraday.get("vwapDiff", 0.0) or 0.0) if is_today_intraday else 0.0
    intraday_amp = float(intraday.get("amp", 0.0) or 0.0)

    if not is_today_intraday:
        intraday_score = 12
        if intraday and intraday.get("date"):
            if trade_calendar and not trade_calendar.get("isTradeDay", True):
                cal_lbl = trade_calendar.get("label") or "休市"
                nxt_td = trade_calendar.get("nextTradeDate") or ""
                nxt_suffix = f"（下一交易日 {nxt_td}）" if nxt_td else ""
                risk_points.append(f"当前处于{cal_lbl}{nxt_suffix}，分时展示最近交易日（{intraday['date']}）收盘数据")
            else:
                risk_points.append(f"当前分时为历史交易日（{intraday['date']}）数据，盘口信号待开盘后更新")
    elif p_type in ("rebound", "bull"):
        if vwap_diff >= 3.0:
            intraday_score = 12
            risk_points.append(f"现价偏离分时黄线（VWAP）达 +{vwap_diff:.2f}%，日内追高乖离率过大")
        else:
            intraday_score = 17 + (2 if buy_ratio >= 53 else 0)
            positive_points.append(f"日内分时站稳 VWAP 均价线（外盘主动买盘占比 {buy_ratio:.1f}%），承接良好")
    elif p_type == "chop":
        intraday_score = 12 + (2 if buy_ratio >= 52 else 0)
    elif p_type == "flat":
        intraday_score = 9
        risk_points.append(f"今日分时振幅仅 {intraday_amp:.2f}%，波动空间太窄导致做T和短线难以盈利")
    elif p_type in ("dump", "bear"):
        intraday_score = 4
        if p_type == "dump":
            risk_points.append("🚨 早盘脉冲拉升后跌破分时均价黄线（典型钓鱼诱多出货形态），分时受压明显")
        else:
            risk_points.append("全天分时白线被均价黄线反压，日内空头主导下跌中继")
    else:
        intraday_score = 11

    intraday_score = max(0, min(20, intraday_score))
    intraday_desc = (intraday.get("pattern", "分时数据有限")[:18]) if is_today_intraday else "非今日分时·中性"

    # ---- 维度5：题材风口与大盘情绪共振 (满分 15) ----
    sec_role = sector_ecology.get("role", "")
    sec_chg = float(sector_ecology.get("sectorChg", 0.0) or 0.0)
    risk_valve = market_sentiment.get("riskValve", "GREEN") if market_sentiment else "GREEN"
    broken_rate = float(market_sentiment.get("brokenRate", 0.0) or 0.0) if market_sentiment else 0.0

    env_score = 8
    if matched_hot_themes:
        env_score += 4
        positive_points.append(f"属于今日热门题材【{matched_hot_themes[0]['name']}】")
        if "龙头" in sec_role or "中军" in sec_role:
            env_score += 2
            positive_points.append(f"在板块中处于核心领涨身位（{sec_role}）")
        elif "杂毛" in sec_role:
            env_score -= 2
            risk_points.append("在板块中处于后排跟风滞涨杂毛身位，缺乏主力核心呵护")
    elif sec_chg <= -1.5:
        env_score -= 2
        risk_points.append(f"所属行业今日整体弱势回调（{sec_chg:.2f}%）")

    if risk_valve == "RED":
        env_score -= 4
        risk_points.append(f"🚨 今日全市场风控总阀亮红灯（炸板率 {broken_rate:.1f}%），系统性退潮拖累大")
    elif risk_valve == "YELLOW":
        env_score -= 1
        risk_points.append(f"大盘情绪总阀处于黄灯分歧状态（炸板率 {broken_rate:.1f}%），须收敛仓位")
    elif risk_valve == "GREEN":
        env_score += 1

    s1_tm = (five_step_review or {}).get("step1Timing") or {}
    s2_th = (five_step_review or {}).get("step2MainTheme") or {}
    if s2_th.get("isMainTheme"):
        if s2_th.get("cycleStage") == "HIGH_CLIMAX":
            env_score -= 1
            risk_points.append(f"所属主线【{s2_th.get('themeName')}】已处高位一致区，谨防后排追高接最后一棒")
        else:
            env_score += 2
            positive_points.append(f"🎯 命中市场核心主线【{s2_th.get('themeName')}】（{s2_th.get('cycleStageLabel')}）")
    if s1_tm.get("isResilient"):
        env_score += 2
        positive_points.append(f"🛡️ 具备逆势抗跌韧性：近5日跑赢上证指数 {float(s1_tm.get('rs5d') or 0.0):+.1f}% 且站稳20日线")

    env_score = max(0, min(15, env_score))
    env_desc = f"{'核心主线' if (s2_th.get('isMainTheme') or matched_hot_themes) else '非主线'} · 大盘{market_sentiment.get('valveLabel', '正常') if market_sentiment else '平稳'}"

    # 总分汇总
    total_score = fund_score + trend_score + chip_score + intraday_score + env_score

    # ---- 实验性弱参考指标提取（股性适配、左侧胜率防御与追高纠偏） ----
    t3_pct = int(experimental_dna["tFriendly3Pct"]) if experimental_dna and "tFriendly3Pct" in experimental_dna else None
    dip_tot = int(experimental_dna.get("dipTotal", 0) or 0) if experimental_dna else 0
    dip_win_rate = int(experimental_dna.get("dipWinRate", 50) or 0) if experimental_dna else 50
    dip_avg_reb = float(experimental_dna.get("dipAvgRebound", 0.0) or 0.0) if experimental_dna else 0.0
    gap_up_tot = int(experimental_dna.get("gapUpTotal", 0) or 0) if experimental_dna else 0
    gap_up_smash = int(experimental_dna.get("gapUpSmashRate", 0) or 0) if experimental_dna else 0
    dna_tag = str(experimental_dna.get("dnaTag", "") or "") if experimental_dna else ""

    atr14_val = float(atr_profile.get("atr14", 0.0) or 0.0) if atr_profile else 0.0
    atr_pct_val = float(atr_profile.get("atrPct", 0.0) or 0.0) if atr_profile else 0.0
    avg_amp14 = float(atr_profile.get("avgIntraAmp14", 0.0) or 0.0) if atr_profile else 0.0
    adaptive_grid_val = float(atr_profile.get("adaptiveGrid", 1.33) or 1.33) if atr_profile else 1.33

    style_fit = ""
    style_fit_level = "balanced"
    if (t3_pct is not None and t3_pct < 35) or (atr_profile and avg_amp14 < 2.2):
        style_fit_level = "narrow"
        low_pct_txt = f"近半年仅 {t3_pct}% 交易日振幅≥3%" if t3_pct is not None else f"14日均振幅仅 {avg_amp14:.2f}%"
        style_fit = f"🛡️ 稳健慢波股（{low_pct_txt}，不适合高频做T或超短追涨）"
    elif (t3_pct is not None and t3_pct >= 65) or (atr_profile and avg_amp14 >= 4.8):
        style_fit_level = "high_vol"
        amp_txt = f"14日均振幅 {avg_amp14:.2f}%" if atr_profile else f"近半年振幅≥3%占 {t3_pct}%"
        style_fit = f"⚡ 高弹性活跃股（{amp_txt}，做T空间充裕但止损需防宽幅洗盘）"
    elif atr_profile or experimental_dna:
        style_fit_level = "balanced"
        amp_txt = f"14日均振幅 {avg_amp14:.2f}% / 适配网格 {adaptive_grid_val:.2f}%" if atr_profile else f"振幅达标率 {t3_pct}%"
        style_fit = f"⚖️ 均衡波动股（{amp_txt}，适配常规波段与日内做T）"

    if style_fit_level == "narrow":
        narrow_reason = f"近半年仅{t3_pct}%日振幅≥3%" if t3_pct is not None else f"14日ATR仅{atr_pct_val:.2f}%"
        risk_points.append(f"🐢 [弱参考·股性偏慢] {narrow_reason}，短线弹性不足，频繁做T易被规费磨损")
    if dip_tot >= 6 and dip_win_rate <= 35:
        risk_points.append(f"🧊 [弱参考·左侧慎抄底] 近半年深探≥1.8%共{dip_tot}次，当日反抽胜率仅{dip_win_rate}%，少做左侧接飞刀")
    if gap_up_tot >= 6 and gap_up_smash >= 62:
        risk_points.append(f"🎭 [弱参考·忌高开追涨] 近半年高开{gap_up_tot}次有{gap_up_smash}%收阴回落，切忌早盘追高接盘")
    if dip_tot >= 6 and dip_win_rate >= 62 and not red_flags and not is_broken:
        positive_points.append(f"🧬 [弱参考·抗跌基因] 近半年深探{dip_tot}次有{dip_win_rate}%当日V起反抽≥1.2%（均抽+{dip_avg_reb:.2f}%）")

    # ---- 核心判定：能不能买？现在是不是买点？风险如何？ ----
    is_buy_point_now = False
    can_buy_level = "WAIT"
    can_buy_verdict = "👀 暂以观望为主"
    timing_headline = "⏳ 当前暂非理想买点"
    timing_analysis = ""
    risk_rating = "中等风险"
    risk_color = "yellow"
    suggested_position = "0% ~ 15%"

    if red_flags:
        can_buy_level = "NO_BUY"
        can_buy_verdict = "🚫 存在高危公告雷区 · 严禁买入"
        is_buy_point_now = False
        timing_headline = "❌ 明确非买点（基本面公告一票否决）"
        timing_analysis = f"近30天检测到重大利空（{red_flags[0]['tag']}），随时面临机构踩踏与估值重杀，无论技术形态如何均禁止接入！"
        risk_rating = "极高风险"
        risk_color = "red"
        suggested_position = "0% (空仓回避)"
    elif has_top_island:
        can_buy_level = "NO_BUY"
        can_buy_verdict = "🚫 顶部岛形反转套牢区 · 严禁抄底/正T"
        is_buy_point_now = False
        timing_headline = "❌ 明确非买点（顶部岛形反转一票否决）"
        timing_analysis = "高位形成向下跳空缺口与上方悬空套牢孤岛，筹码结构已遭破坏。严禁左侧低吸或做正T，持仓者仅宜趁反抽缺口下沿果断倒T降仓止损！"
        risk_rating = "极高风险"
        risk_color = "red"
        suggested_position = "0% (空仓回避/反抽减仓)"
    elif is_broken and not (is_doji or is_ignition or has_bottom_island):
        can_buy_level = "NO_BUY"
        can_buy_verdict = "🚫 技术破位下行 · 严禁盲目抄底"
        is_buy_point_now = False
        timing_headline = "❌ 当前不是买点（处于破位下降通道）"
        timing_analysis = "现价跌破 MA20 与 MA60 关键支撑，均线空头排列反压。左侧无底不言底，建议等待放量重新站回 MA20 之上再评估！"
        risk_rating = "高风险"
        risk_color = "red"
        suggested_position = "0% (空仓等待止跌)"
    elif p_type in ("dump", "bear"):
        can_buy_level = "WAIT"
        can_buy_verdict = "⚠️ 日内分时受压/诱多 · 暂勿介入"
        is_buy_point_now = False
        timing_headline = "❌ 此刻不是买点（分时被黄线压制 / 疑似诱多）"
        timing_analysis = (
            f"分时图显示现价运行在 VWAP 均价线（¥{intraday.get('vwap', cur_px):.2f}）下方且承接乏力"
            + ("，早盘脉冲诱多后持续滑落" if p_type == "dump" else "")
            + "，此时买入极易被套在日内高点！请等放量站稳均价黄线后再看。"
        )
        risk_rating = "偏高风险"
        risk_color = "red"
        suggested_position = "0% (等待分时转强)"
    elif is_stagnation or has_gravestone or has_bearish_engulfing or rsi6 >= 80 or vwap_diff >= 3.0:
        can_buy_level = "WAIT"
        can_buy_verdict = "👀 短期偏热过乖离 · 切忌追高接盘"
        is_buy_point_now = False
        timing_headline = "⏳ 标的较强但“现在不是追涨买点”"
        timing_analysis = (
            f"当前存在追高风险（"
            + (f"偏离分时黄线 +{vwap_diff:.2f}%" if vwap_diff >= 3.0 else f"6日RSI={rsi6:.1f}超买/高位放量滞涨")
            + f"），贸然入场容易买在情绪高潮点。耐心等待回踩分时均线 ¥{intraday.get('vwap', cur_px):.2f} 或 MA5 支撑再考虑低吸。"
        )
        risk_rating = "中高风险"
        risk_color = "yellow"
        suggested_position = "0% ~ 10% (等回踩再买)"
    elif risk_valve == "RED" and total_score < 78:
        can_buy_level = "WAIT"
        can_buy_verdict = "🟡 大盘红灯退潮 · 暂缓新开仓"
        is_buy_point_now = False
        timing_headline = "⏳ 个股尚可但大盘亮红灯，暂缓买入"
        timing_analysis = f"全市场炸板率高达 {broken_rate:.1f}% 处于系统性退潮期，泥沙俱下环境下即便个股不差也容易补跌，建议管住手等待情绪回暖。"
        risk_rating = "偏高风险"
        risk_color = "yellow"
        suggested_position = "0% ~ 10% (防守观望)"
    elif total_score >= 75:
        can_buy_level = "STRONG_BUY"
        can_buy_verdict = "🔥 综合评优 · 具备较高介入价值"
        is_buy_point_now = True
        timing_headline = "✅ 当前正处于高胜率买点窗口"
        timing_analysis = (
            f"多方维度综合得分 {total_score} 分：无公告地雷，日线趋势稳健，筹码位置合理，且日内分时站稳黄线承接良好（主动买盘占比 {buy_ratio:.0f}%）。可依托理想区间分批低吸介入。"
        )
        risk_rating = "中低风险" if risk_valve == "GREEN" else "中等风险"
        risk_color = "green"
        suggested_position = "30% ~ 50% (分批介入，严守止损)" if risk_valve == "GREEN" else "20% ~ 30% (轻仓试错)"
    elif total_score >= 60:
        if dip_tot >= 6 and dip_win_rate <= 35:
            can_buy_level = "WAIT"
            can_buy_verdict = "👀 历史单边阴跌基因 · 建议等待右侧放量确认"
            is_buy_point_now = False
            timing_headline = "⏳ 暂缓左侧低吸（等右侧放量确认）"
            timing_analysis = (
                f"综合评分虽达 {total_score} 分，但近半年 {dip_tot} 次深水探底后当日反抽胜率仅 {dip_win_rate}%（承接惯性偏弱）。"
                "为防左侧接飞刀，建议耐心等待分时放量站稳均价黄线后再行右侧跟随。"
            )
            risk_rating = "偏高风险"
            risk_color = "yellow"
            suggested_position = "0% ~ 15% (等右侧放量确认)"
        else:
            can_buy_level = "BUY_DIP"
            can_buy_verdict = "🎯 可择机低吸试错 · 严守止损"
            is_buy_point_now = True
            timing_headline = "✅ 具备分时回踩低吸试错条件"
            timing_analysis = (
                f"综合评分 {total_score} 分（合格偏强），未见严重破位与主力出货信号。建议不要市价急躁追高，挂单在分时均线与箱体支撑交汇区间轻仓试错。"
            )
            risk_rating = "中等风险"
            risk_color = "green"
            suggested_position = "20% ~ 30% (轻仓低吸试错)"
    else:
        can_buy_level = "WAIT" if total_score >= 45 else "NO_BUY"
        can_buy_verdict = "👀 综合评分平庸 · 建议继续观望" if total_score >= 45 else "🚫 评分不及格 · 回避不买"
        is_buy_point_now = False
        timing_headline = "⏳ 暂未形成明确买点（共振不足）"
        timing_analysis = f"综合得分仅 {total_score} 分，趋势、量能或题材共振力度不够，强行买入缺乏盈亏比优势，建议筛选更高分标的。"
        risk_rating = "中高风险" if total_score >= 45 else "高风险"
        risk_color = "yellow" if total_score >= 45 else "red"
        suggested_position = "0% (观望为主)"

    # 第一步「顺天时」硬门禁联锁：与起爆挖掘口径 100% 同步，大盘下行期严禁左侧早潜伏
    if s1_tm.get("regimeMode") == "BEAR_STRICT" and can_buy_level in ("STRONG_BUY", "BUY_DIP"):
        rs5_v = float(s1_tm.get("rs5d") or 0.0)
        if not s1_tm.get("isResilient"):
            can_buy_level = "WAIT"
            can_buy_verdict = "🛡️ 大盘下行跟跌 · 禁左侧早潜伏"
            is_buy_point_now = False
            timing_headline = "⏳ 上证处于下跌结构，本股未形成逆势抗跌，暂缓介入"
            timing_analysis = (
                f"当前大盘处于下跌结构/退潮期，本股近5日相对上证超额 {rs5_v:+.1f}%，缺乏独立逆势护盘资金。"
                "顺天时第一条：大势不对操作白费，建议按兵不动等待指数止跌或右侧放量站回20日线。"
            )
            risk_rating = "偏高风险"
            risk_color = "yellow"
            suggested_position = "0% (大盘下行空仓观望)"
        elif not s1_tm.get("rightSideConfirm"):
            can_buy_level = "WAIT"
            can_buy_verdict = "⏳ 逆势活口观察 · 等右侧阳线确认"
            is_buy_point_now = False
            timing_headline = "⏳ 虽具逆势抗跌韧性，但弱势市须等放量阳线站上5日线再出手"
            timing_analysis = (
                f"本股近5日跑赢上证 {rs5_v:+.1f}% 且站稳20日线（可先加入在轨跟踪池），"
                "但大盘下行期禁左侧阴线早潜伏，必须等日内放量收阳站上5日线右侧确认后再轻仓试错。"
            )
            risk_rating = "中等风险"
            risk_color = "yellow"
            suggested_position = "0% ~ 10% (仅观察等右侧信号)"
        else:
            can_buy_level = "BUY_DIP"
            can_buy_verdict = "✅ 逆势抗跌+右侧确认 · 仅限先锋轻仓试错"
            timing_headline = f"✅ 弱势市稀缺右侧买点（5日跑赢指数 {rs5_v:+.1f}% + 阳线站稳5日线）"
            suggested_position = "10% ~ 20% (弱势先锋仓，破止损立斩)"

    # 软性纪律附加提醒（绝不推翻一票否决结论）
    if gap_up_tot >= 6 and gap_up_smash >= 62 and can_buy_level in ("STRONG_BUY", "BUY_DIP", "WAIT"):
        timing_analysis += f" 【基因提醒】近半年高开后有{gap_up_smash}%概率冲高回落，切忌早盘高开追买，仅限分时回踩承接位挂单。"
    if style_fit_level == "narrow" and can_buy_level in ("STRONG_BUY", "BUY_DIP"):
        pct_hint = f"{t3_pct}%" if t3_pct is not None else "偏少数"
        timing_analysis += f" 【股性提醒】近半年仅{pct_hint}交易日振幅≥3%，更适合中线波段持有，不适合高频做T。"

    # ---- 实战参考价位带 (Trade Plan，统一融合试盘涨停起点、筹码下沿、MA20 与 14日ATR 硬止损锚点) ----
    vwap = float(intraday.get("vwap", 0.0) or cur_px)
    ma5 = float(chips.get("ma5", 0.0) or cur_px)
    ma20 = float(chips.get("ma20", 0.0) or cur_px)
    box_bot = float(chips.get("boxBot", 0.0) or cur_px * 0.94)
    box_top = float(chips.get("boxTop", 0.0) or cur_px * 1.08)
    avg_cost = float(chips.get("avgCost", 0.0) or cur_px)
    c90_low = float(chips.get("cost90Low", 0.0) or 0.0)
    zt_floor = float(s3_drg.get("supportFloor") or 0.0)

    stop_anchors: List[dict] = []
    stop_anchor_label = "ATR动态止损"
    if cur_px > 0:
        vwap_ref = vwap if vwap > 0 else cur_px
        ideal_high = round(min(cur_px, vwap_ref) * 1.002, 2)
        if atr14_val > 0:
            support_anchor = min(ma20, ma5, vwap_ref)
            ideal_low = round(max(box_bot * 0.992, support_anchor - 0.50 * atr14_val), 2)
            if ideal_low >= ideal_high:
                ideal_low = round(ideal_high - max(0.45 * atr14_val, ideal_high * 0.012), 2)
            ideal_low = max(round(cur_px * 0.88, 2), ideal_low)
            stop_loss = round(min(box_bot, ma20) - 1.20 * atr14_val, 2)
            if stop_loss >= ideal_low * 0.985:
                stop_loss = round(ideal_low - max(1.00 * atr14_val, ideal_low * 0.025), 2)
            stop_loss = max(0.01, stop_loss)
            target_1 = round(max(box_top, cur_px + 1.80 * atr14_val, avg_cost * 1.02), 2)
            sup_gap = kp.get("nearestSupportGap")
            gap_hint = (
                f" · 3日不补支撑缺口 ¥{sup_gap['gapLow']:.2f}~¥{sup_gap['gapHigh']:.2f}"
                if (sup_gap and sup_gap.get("confirmed3d")) else ""
            )
            if sup_gap and sup_gap.get("confirmed3d") and sup_gap["gapHigh"] < ideal_high:
                ideal_low = round(max(ideal_low, sup_gap["gapHigh"]), 2)
            calibration_note = (
                f"已按 14日ATR (¥{atr14_val:.2f} / {atr_pct_val:.2f}%) 动态校准低吸缓冲与 1.2×ATR 抗洗盘止损带宽"
                + (f" · 基因：{dna_tag}" if dna_tag else "")
                + gap_hint
            )
        else:
            ideal_low = round(max(box_bot * 0.995, min(ma20, ma5, vwap_ref) * 0.985), 2)
            if ideal_low > ideal_high:
                ideal_low = round(ideal_high * 0.975, 2)
            stop_loss = round(min(box_bot, ma20) * 0.97, 2)
            if stop_loss >= ideal_low:
                stop_loss = round(ideal_low * 0.96, 2)
            target_1 = round(max(box_top, cur_px * 1.05, avg_cost * 1.02), 2)
            calibration_note = "按默认均线与箱体百分比区间测算（K线样本不足暂未启用 ATR 动态校准）"

        # 构建可选硬止损锚点（与起爆挖掘 supportFloor 防守口径对齐）
        if zt_floor > 0 and cur_px * 0.86 <= zt_floor <= cur_px * 0.995:
            zt_def = round(max(zt_floor * 0.985, cur_px * 0.945), 2)
            stop_anchors.append({"key": "zt_floor", "label": "试盘涨停起点", "price": zt_def})
            if drg_stage in ("SHAKEOUT_READY", "CONVERGED_WAIT", "DIGESTING"):
                stop_loss = zt_def
                stop_anchor_label = "试盘起点防守线"
                calibration_note = f"已对齐【起爆试盘起点 ¥{zt_floor:.2f}】划定硬止损 ¥{zt_def:.2f} · " + calibration_note
        if ma20 > 0 and cur_px * 0.85 <= ma20 <= cur_px * 0.998:
            stop_anchors.append({"key": "ma20", "label": "20日生命线", "price": round(ma20 * 0.99, 2)})
        if c90_low > 0 and cur_px * 0.82 <= c90_low <= cur_px * 0.995:
            stop_anchors.append({"key": "cyq90", "label": "90%筹码下沿", "price": round(c90_low * 0.99, 2)})
        stop_anchors.append({"key": "atr", "label": "ATR/固定风控(-4.5%)", "price": round(stop_loss if stop_anchor_label == "ATR动态止损" else cur_px * 0.955, 2)})
    else:
        ideal_low = ideal_high = stop_loss = target_1 = 0.0
        calibration_note = ""

    score_breakdown = [
        {"name": "基本面与排雷", "score": fund_score, "max": 20, "desc": fund_desc},
        {"name": "趋势与均线安全", "score": trend_score, "max": 25, "desc": trend_desc},
        {"name": "筹码与量价结构", "score": chip_score, "max": 20, "desc": chip_desc},
        {"name": "分时盘口与承接", "score": intraday_score, "max": 20, "desc": intraday_desc},
        {"name": "题材与大盘环境", "score": env_score, "max": 15, "desc": env_desc},
    ]

    return {
        "totalScore": total_score,
        "scoreBreakdown": score_breakdown,
        "canBuyLevel": can_buy_level,
        "canBuyVerdict": can_buy_verdict,
        "isBuyPointNow": is_buy_point_now,
        "timingHeadline": timing_headline,
        "timingAnalysis": timing_analysis,
        "riskRating": risk_rating,
        "riskColor": risk_color,
        "styleFit": style_fit,
        "styleFitLevel": style_fit_level,
        "positivePoints": positive_points[:6],
        "riskPoints": risk_points[:6],
        "tradePlan": {
            "currentPrice": round(cur_px, 2),
            "idealBuyLow": ideal_low,
            "idealBuyHigh": ideal_high,
            "stopLossPrice": stop_loss,
            "stopAnchorLabel": stop_anchor_label,
            "stopAnchors": stop_anchors,
            "targetPrice1": target_1,
            "targetPrice2": round(max(target_1 * 1.04, cur_px * 1.10), 2) if cur_px > 0 else 0.0,
            "suggestedPosition": suggested_position,
            "calibrationNote": calibration_note,
        },
    }


def build_wechat_summary(diag: dict) -> str:
    """生成排版精美的微信问股/诊断回复文本"""
    q = diag.get("quote", {})
    comp = diag.get("company", {})
    chips = diag.get("chips", {})
    intra = diag.get("intraday", {})
    wave = diag.get("secondWave", {})
    sec = diag.get("sectorEcology", {})
    dec = diag.get("decision", {})
    ap = diag.get("atrProfile") or {}

    name = q.get("name", "该股")
    code = q.get("code", "")
    px = q.get("price", 0.0)
    chg = q.get("chg", 0.0)
    to = q.get("turnover", 0.0)
    cap = q.get("cap", 0.0)

    tcal = diag.get("tradeCalendar") or {}
    cal_banner = []
    if tcal and not tcal.get("isTradeDay", True):
        cal_banner.append(
            f"📅 状态: {tcal.get('label', '休市')}（最近交易日 {tcal.get('latestTradeDate', '—')} ｜ 下一交易日 {tcal.get('nextTradeDate', '—')}）"
        )

    lines = [
        f"📊【{name} ({code}) 智能诊股报告】",
        *cal_banner,
        f"🔹 现价: ¥{px:.2f} ({chg:+.2f}%) ｜ 换手: {to:.2f}% ｜ 流通: {cap:.1f}亿",
    ]

    if dec:
        tp = dec.get("tradePlan", {})
        fs = diag.get("fiveStepSystem") or {}
        s1 = fs.get("step1Timing") or {}
        s3 = fs.get("step3Dragon") or {}
        lines.extend([
            "",
            f"🏆 综合评分: {dec.get('totalScore', 0)}/100分 ｜ 风险: {dec.get('riskRating', '—')}",
            *([f"🐉 五步终审: {s3.get('dragonLabel')} ({s3.get('dragonStars')}★) · {s3.get('stageLabel')} ｜ 5日RS {s1.get('rs5d', 0):+.1f}% ({s1.get('entryModeLabel', '')})"] if s3.get("available") else []),
            f"🎯 买入建议: {dec.get('canBuyVerdict', '—')}",
            *( [f"🎭 股性适配: {dec['styleFit']}"] if dec.get("styleFit") else [] ),
            f"⏱️ 时点判断: {dec.get('timingHeadline', '—')}",
            f"  └ {dec.get('timingAnalysis', '')}",
            f"📌 参考计划: 低吸参考 ¥{tp.get('idealBuyLow', 0):.2f}~¥{tp.get('idealBuyHigh', 0):.2f} ｜ 硬止损 ¥{tp.get('stopLossPrice', 0):.2f} ｜ 压力 ¥{tp.get('targetPrice1', 0):.2f}",
            *( [f"📏 ATR参考: 14日ATR ¥{ap.get('atr14', 0):.2f} ({ap.get('atrPct', 0):.2f}%) ｜ 适配格距 {ap.get('adaptiveGrid', 1.33):.2f}%"] if ap else [] ),
        ])

    lines.extend([
        "",
        f"🌊【板块生态与二波预期】:",
        f"  · 题材风口: {diag.get('themeStatus', '—')}",
    ])

    if sec:
        lines.append(f"  · 板块生态: 今日涨跌 {sec.get('sectorChg', 0):+.2f}% ({sec.get('upCount', 0)}涨/{sec.get('downCount', 0)}跌) ｜ 个股定位: {sec.get('role', '—')}")

    if wave:
        lines.append(f"  · 轮动周期: {wave.get('stage', '—')}")
        lines.append(f"  · 二波潜力: {wave.get('secondWavePotential', '—')} (首轮波幅 +{wave.get('wave1Amplitude', 0)}%, 高位回撤 {wave.get('drawdown', 0)}%)")

    if intra:
        lines.append("")
        lines.append("📈【全天分时日内态势】:")
        lines.append(f"  · VWAP均价: ¥{intra.get('vwap', 0):.2f} (偏离 {intra.get('vwapDiff', 0):+.2f}%) ｜ 振幅: {intra.get('amp', 0):.2f}%")
        lines.append(f"  · 分时形态: {intra.get('pattern', '—')} (线上占比 {intra.get('aboveRatio', 0):.0f}%)")

    lines.append("")
    lines.append(f"🚨【排雷评级】: {diag.get('riskLevel', '—')}")

    if diag.get("redFlags"):
        lines.append("  ⚠️ 近期利空预警:")
        for rf in diag["redFlags"][:2]:
            lines.append(f"   · [{rf['date']}] {rf['title'][:26]}")
    elif diag.get("riskLevel") == "安全":
        lines.append("  🟢 近30天无重大立案、减持违规或退市风险。")

    if chips:
        lines.append("")
        lines.append("🎯【筹码与技术结构】:")
        lines.append(f"  · 20日箱体: ¥{chips.get('boxBot', 0):.2f} ~ ¥{chips.get('boxTop', 0):.2f} (位置 {chips.get('boxPos', 50):.0f}%)")
        peak_str = f" (主峰 ¥{chips['peakPrice']:.2f})" if chips.get("peakPrice") else ""
        lines.append(f"  · CYQ筹码均价: ¥{chips.get('avgCost', 0):.2f}{peak_str} ｜ 获利盘: {chips.get('profitRatio', 0):.1f}%")
        if chips.get("concentration90") is not None:
            lines.append(
                f"  · 90%成本区间: ¥{chips.get('cost90Low', 0):.2f}~¥{chips.get('cost90High', 0):.2f} "
                f"(集中度 {chips.get('concentration90', 0):.1f}% · {chips.get('concentrationLabel', '适度集中')})"
            )

    sts = diag.get("shortTermStatus")
    if sts:
        lines.append("")
        lines.append("⚡【今日短线身位与接力雷达】:")
        status_parts = []
        if sts.get("statTag"):
            status_parts.append(sts["statTag"])
        if sts.get("identityScore") is not None and sts.get("relayScore") is not None:
            status_parts.append(f"身份分 {sts['identityScore']} / 接力分 {sts['relayScore']}")
        if sts.get("inHerdPool"):
            status_parts.append(f"抱团池:{sts.get('herdLabel', '跟踪中')}")
        if sts.get("isMysticResonant") and sts.get("mysticCluster"):
            status_parts.append(f"玄学字辈:{sts['mysticCluster']}({sts.get('mysticZtCount', 0)}板)")
        if sts.get("isBrokenBoard"):
            status_parts.append(f"曾炸板{sts.get('zbc', 0)}次")
        if status_parts:
            lines.append("  · 状态: " + " ｜ ".join(status_parts))
        if sts.get("cycleAdvice"):
            lines.append(f"  · 周期应对: {sts['cycleAdvice']}")

    lines.append("")
    lines.append("💡【做T自救与操作处方】:")
    for adv in diag.get("prescriptions", [])[:3]:
        lines.append(f"  {adv}")

    lines.append("")
    lines.append("—— 来自 T-Stock 个股全景诊断工具")
    return "\n".join(lines)


async def _fetch_diag_kline_days(
    client: httpx.AsyncClient,
    tcode: str,
    em_secid: str,
    limit: int = 210,
) -> List[dict]:
    """多源拉取前复权日K（默认 210 个交易日以支撑 CYQ 换手衰减筹码分布，保留换手率与成交额字段）。"""
    return await fetch_em_klines(client, em_secid, klt=101, lmt=limit, tcode_fallback=tcode)


async def get_stock_diagnosis(
    code: str,
    http_client: Optional[httpx.AsyncClient] = None,
) -> dict:
    """获取股票的全景诊断聚合数据（行情、排雷公告、板块风口、身位生态、二波预期、分时VWAP、筹码处方）"""
    code = str(code).strip().zfill(6)

    # 1. 查带容量上限缓存
    cached = await _DIAGNOSIS_CACHE.get(code)
    if cached is not None:
        return cached

    mkt = "sh" if code.startswith(("6", "9")) else ("sz" if code.startswith(("0", "2", "3")) else "bj")
    tcode = f"{mkt}{code}"
    secucode = f"{code}.SH" if mkt == "sh" else (f"{code}.SZ" if mkt == "sz" else f"{code}.BJ")
    em_secid = f"1.{code}" if mkt == "sh" else f"0.{code}"
    mkt_upper = mkt.upper()

    close_client = http_client is None
    client = http_client or httpx.AsyncClient(
        timeout=httpx.Timeout(9.0),
        trust_env=False,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        },
    )
    try:
        # 并发请求多维度公开数据接口（日K已切东财push2his主用 + web.ifzq回退，避免ifzq WAF 501）
        q_url = f"https://qt.gtimg.cn/q={tcode}"
        ann_url = f"https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=30&page_index=1&ann_type=A&stock_list={code}"
        concept_url = f"https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_F10_CORETHEME_BOARDTYPE&columns=SECUCODE,BOARD_NAME,BOARD_TYPE,BOARD_RANK,IS_PRECISE&filter=(SECUCODE=%22{secucode}%22)&pageSize=50&pageNumber=1&sortColumns=BOARD_RANK&sortTypes=1"
        survey_url = f"https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/CompanySurveyAjax?code={mkt_upper}{code}"
        hot_bk_url = "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=80&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:3+f:!50&fields=f12,f14,f2,f3,f62,f128,f140,f104,f105"
        min_url = f"https://ifzq.gtimg.cn/appstock/app/minute/query?code={tcode}"
        ind_url = f"https://push2.eastmoney.com/api/qt/stock/get?secid={em_secid}&fields=f57,f58,f127,f128"

        reqs = [
            client.get(q_url),
            client.get(ann_url),
            client.get(concept_url, headers={"Referer": "https://data.eastmoney.com/"}),
            client.get(survey_url, headers={"Referer": "https://emweb.securities.eastmoney.com/"}),
            client.get(hot_bk_url, headers={"Referer": "https://quote.eastmoney.com/"}),
            _fetch_diag_kline_days(client, tcode, em_secid, 210),
            client.get(min_url),
            get_limitup_pool(http_client=client),
            client.get(ind_url, headers={"Referer": "https://quote.eastmoney.com/"}),
        ]

        resps = await asyncio.gather(*reqs, return_exceptions=True)
    finally:
        if close_client:
            await client.aclose()

    def _sf(v: Any, d: float = 0.0) -> float:
        try:
            return float(v) if v not in (None, "", "-") else d
        except (ValueError, TypeError):
            return d

    # 1. 实时行情解析
    q_resp = resps[0]
    quote_data = {
        "name": "未知标的",
        "code": code,
        "tcode": tcode,
        "price": 0.0,
        "prevClose": 0.0,
        "open": 0.0,
        "high": 0.0,
        "low": 0.0,
        "chg": 0.0,
        "turnover": 0.0,
        "pe": 0.0,
        "pb": 0.0,
        "cap": 0.0,
        "totalCap": 0.0,
        "outerVol": 0.0,
        "innerVol": 0.0,
        "buyRatio": 50.0,
        "vr": 1.0,
        "amtWan": 0.0,
    }
    if not isinstance(q_resp, Exception) and q_resp.status_code == 200:
        parts = q_resp.text.split("~")
        if len(parts) > 45:
            outer_v = _sf(parts[7])
            inner_v = _sf(parts[8])
            buy_ratio = round((outer_v / (outer_v + inner_v)) * 100, 1) if (outer_v + inner_v) > 0 else 50.0
            quote_data = {
                "name": parts[1],
                "code": code,
                "tcode": tcode,
                "price": _sf(parts[3]),
                "prevClose": _sf(parts[4]),
                "open": _sf(parts[5]),
                "high": _sf(parts[33]),
                "low": _sf(parts[34]),
                "chg": _sf(parts[32]),
                "turnover": _sf(parts[38]),
                "pe": _sf(parts[39]),
                "pb": _sf(parts[46]) if len(parts) > 46 else 0.0,
                "cap": _sf(parts[45]),
                "totalCap": _sf(parts[44]),
                "outerVol": outer_v,
                "innerVol": inner_v,
                "buyRatio": buy_ratio,
                "vr": _sf(parts[49], 1.0) if len(parts) > 49 else 1.0,
                "amtWan": _sf(parts[37]),
            }

    # 2. 公告与排雷
    ann_resp = resps[1]
    announcements = []
    red_flags = []
    yellow_alerts = []
    green_catalysts = []
    if not isinstance(ann_resp, Exception) and ann_resp.status_code == 200:
        try:
            ann_json = ann_resp.json()
            raw_list = (ann_json.get("data") or {}).get("list", [])
            today_dt = cn_today()
            for item in raw_list:
                title = item.get("title", "")
                n_date_str = item.get("notice_date", "")[:10]
                is_recent_30d = False
                try:
                    n_dt = datetime.date.fromisoformat(n_date_str)
                    is_recent_30d = (today_dt - n_dt).days <= 35
                except Exception:
                    is_recent_30d = False

                level, tag = classify_announcement(title)
                entry = {
                    "date": n_date_str,
                    "title": title,
                    "level": level,
                    "tag": tag,
                    "isRecent": is_recent_30d,
                    "art_code": item.get("art_code", ""),
                }
                announcements.append(entry)
                if is_recent_30d:
                    if level == "red":
                        red_flags.append(entry)
                    elif level == "yellow":
                        yellow_alerts.append(entry)
                    elif level == "green":
                        green_catalysts.append(entry)
        except Exception:
            pass

    # 3. 概念与板块
    concept_resp = resps[2]
    all_concepts = []
    precise_concepts = []
    if not isinstance(concept_resp, Exception) and concept_resp.status_code == 200:
        try:
            c_json = concept_resp.json()
            c_items = (c_json.get("result") or {}).get("data", []) or []
            for ci in c_items:
                bname = ci.get("BOARD_NAME")
                if bname:
                    all_concepts.append(bname)
                    if str(ci.get("IS_PRECISE")) == "1":
                        precise_concepts.append(bname)
        except Exception:
            pass

    # 4. 公司业务简介与真实行业归属（自动过滤东财 sshy='--'，优先补全东财细分行业 f127）
    survey_resp = resps[3]
    ind_resp = resps[8] if len(resps) > 8 else None
    em_industry = ""
    if ind_resp is not None and not isinstance(ind_resp, Exception) and ind_resp.status_code == 200:
        try:
            ind_d = (ind_resp.json().get("data") or {})
            cand_ind = str(ind_d.get("f127") or "").strip()
            if cand_ind and cand_ind not in ("-", "--", "—"):
                em_industry = cand_ind
        except Exception:
            pass

    company_info = {
        "fullName": quote_data.get("name", ""),
        "industry": em_industry or "行业未归类",
        "summary": "暂无资料",
        "businessScope": "—",
    }
    if not isinstance(survey_resp, Exception) and survey_resp.status_code == 200:
        try:
            s_json = survey_resp.json()
            jb = s_json.get("jbzl") or {}
            if isinstance(jb, list) and len(jb):
                jb = jb[0]
            raw_sshy = str(jb.get("sshy") or "").strip()
            raw_csrc = str(jb.get("sszjhhy") or "").strip()
            valid_ind = (
                em_industry
                or (raw_sshy if raw_sshy not in ("", "-", "--", "—") else "")
                or (raw_csrc if raw_csrc not in ("", "-", "--", "—") else "")
                or "行业未归类"
            )
            company_info = {
                "fullName": jb.get("gsmc", quote_data.get("name", "")),
                "industry": valid_ind,
                "summary": jb.get("gsjj", "暂无公司简介"),
                "businessScope": jb.get("jyfw", "—"),
            }
        except Exception:
            pass

    # 5. 今日板块生态与风口匹配 (包含涨跌家数比、板块领涨与个股身位)
    hot_resp = resps[4]
    hot_bks = []
    matched_hot_themes = []
    sector_ecology = {}

    if not isinstance(hot_resp, Exception) and hot_resp.status_code == 200:
        try:
            h_json = hot_resp.json()
            diff = (h_json.get("data") or {}).get("diff", []) or []
            for b in diff:
                bname = b.get("f14", "")
                bchg = float(b.get("f3", 0.0))
                b_up = int(b.get("f104", 0) or 0)
                b_down = int(b.get("f105", 0) or 0)
                b_leader = b.get("f140", "")

                hot_entry = {
                    "name": bname,
                    "code": b.get("f12", ""),
                    "chg": bchg,
                    "upCount": b_up,
                    "downCount": b_down,
                    "leader": b_leader,
                    "rank": len(hot_bks) + 1,
                }
                hot_bks.append(hot_entry)

                if (bname in all_concepts or bname in precise_concepts) and bchg >= 0.8:
                    matched_hot_themes.append(hot_entry)
        except Exception:
            pass

    # 计算个股在主线板块里的身位
    st_chg = quote_data.get("chg", 0.0)
    st_cap = quote_data.get("cap", 0.0)
    if matched_hot_themes:
        top_sec = matched_hot_themes[0]
        sec_chg = top_sec["chg"]

        # 身位判断
        if st_chg >= 8.5 or (sec_chg > 0 and st_chg >= sec_chg * 1.8):
            role = "👑 板块领涨先锋 / 龙头"
            role_desc = "涨幅大幅超越板块指数，资金合力聚焦，享受流动性与情绪溢价"
        elif st_cap >= 150:
            role = "🛡️ 板块大容量中军"
            role_desc = "百亿级大市值中军，成交活跃，适合大资金稳健波段运作"
        elif st_chg <= 1.0 and sec_chg >= 2.5:
            role = "⚠️ 后排跟风弱势杂毛"
            role_desc = "板块大涨但该股明显滞涨，缺乏资金主攻，板块跳水时极易首当其冲"
        else:
            role = "🎯 板块同步中坚标的"
            role_desc = "涨幅跟随板块节奏，走势与板块指数共振"

        breadth = "普涨合力" if top_sec["upCount"] > top_sec["downCount"] * 2 else "分化震荡"

        sector_ecology = {
            "sectorName": top_sec["name"],
            "sectorCode": top_sec["code"],
            "sectorChg": top_sec["chg"],
            "sectorRank": top_sec["rank"],
            "upCount": top_sec["upCount"],
            "downCount": top_sec["downCount"],
            "breadth": breadth,
            "leader": top_sec["leader"],
            "role": role,
            "roleDesc": role_desc,
            "relativeElasticity": round(st_chg - sec_chg, 2),
        }
    else:
        sector_ecology = {
            "sectorName": company_info.get("industry", "普通行业"),
            "sectorChg": 0.0,
            "upCount": 0,
            "downCount": 0,
            "breadth": "非主线",
            "role": "🌲 独立震荡 / 非风口标的",
            "roleDesc": "今日未进入全市场概念热点前列，主要受个股技术面与大盘主导",
            "relativeElasticity": 0.0,
        }

    # 6. K线、筹码与【二轮/二波预期模型】+ 深度技术指标
    days = resps[5] if isinstance(resps[5], list) else []
    chips_data = {}
    second_wave_data = {}
    technicals_data = {}
    kline_patterns = analyze_kline_patterns(days, code=code, name=quote_data.get("name", ""))
    experimental_dna = None
    atr_profile = None

    if days:
        try:
            dates = [str(d["date"] if isinstance(d, dict) else d[0])[:10] for d in days]
            opens = [float(d["open"] if isinstance(d, dict) else d[1]) for d in days]
            closes = [float(d["close"] if isinstance(d, dict) else d[2]) for d in days]
            highs = [float(d["high"] if isinstance(d, dict) else d[3]) for d in days]
            lows = [float(d["low"] if isinstance(d, dict) else d[4]) for d in days]
            vols = [float((d.get("vol") or 0.0) if isinstance(d, dict) else d[5]) for d in days]

            if len(closes) >= 20:
                cur_px = quote_data["price"] if quote_data["price"] > 0 else closes[-1]

                ma5 = sum(closes[-5:]) / 5
                ma10 = sum(closes[-10:]) / 10 if len(closes) >= 10 else cur_px
                ma20 = sum(closes[-20:]) / 20 if len(closes) >= 20 else cur_px
                ma20_prev = sum(closes[-21:-1]) / 20 if len(closes) >= 21 else ma20
                ma60 = sum(closes[-60:]) / 60 if len(closes) >= 60 else cur_px

                rsi6 = calc_rsi(closes, 6)
                macd_info = calc_macd(closes)
                chg5d = round(((cur_px - closes[-6]) / closes[-6]) * 100, 2) if len(closes) >= 6 and closes[-6] > 0 else 0.0

                highs20 = highs[-20:]
                lows20 = lows[-20:]
                box_top = max(highs20)
                box_bot = min(lows20)
                box_pos = ((cur_px - box_bot) / (box_top - box_bot) * 100) if box_top > box_bot else 50.0

                cyq_info = calc_cyq_chips(
                    days,
                    cur_price=cur_px,
                    float_cap_yi=float(quote_data.get("cap") or 0.0),
                    latest_turnover_pct=float(quote_data.get("turnover") or 0.0),
                    period=210,
                )

                # 均线趋势与破位/止跌/诱多K线结构识别
                avg_vol5 = sum(vols[-6:-1]) / 5 if len(vols) >= 6 else (sum(vols) / len(vols))
                last_o = quote_data["open"] if quote_data["open"] > 0 else opens[-1]
                last_h = quote_data["high"] if quote_data["high"] > 0 else highs[-1]
                last_l = quote_data["low"] if quote_data["low"] > 0 else lows[-1]
                last_v = vols[-1] if vols else 0.0

                body_pct = abs(cur_px - last_o) / cur_px if cur_px > 0 else 0.0
                lower_shadow = (min(cur_px, last_o) - last_l) / cur_px if cur_px > 0 else 0.0
                upper_shadow = (last_h - max(cur_px, last_o)) / cur_px if cur_px > 0 else 0.0

                is_bull_align = (cur_px >= ma5 * 0.995 and ma5 > ma10 > ma20)
                is_broken_down = (cur_px < ma20 * 0.985 and cur_px < ma60 * 0.99 and ma5 < ma20)
                is_bottom_doji = (cur_px < ma20 and (body_pct <= 0.009 or lower_shadow >= 0.015) and last_v <= avg_vol5 * 0.95)
                is_vol_ignition = (quote_data.get("chg", 0.0) >= 2.0 and last_v >= avg_vol5 * 1.35 and cur_px >= ma5)
                is_high_stagnation = (box_pos >= 85 and chg5d >= 16.0 and upper_shadow >= 0.022 and last_v >= avg_vol5 * 1.45)

                if is_bull_align:
                    trend_status = "多头主升排列"
                elif is_broken_down:
                    trend_status = "破位空头下行"
                elif cur_px >= ma20 * 0.985 and ma20 >= ma20_prev * 0.995:
                    trend_status = "回踩支撑震荡"
                else:
                    trend_status = "均线交织整理"

                bd_info = (kline_patterns or {}).get("bollDivergence") or {}
                technicals_data = {
                    "rsi6": rsi6,
                    "dif": macd_info["dif"],
                    "dea": macd_info["dea"],
                    "macdHist": macd_info["hist"],
                    "isMacdGolden": macd_info["isGolden"],
                    "isMacdDead": macd_info["isDead"],
                    "chg5d": chg5d,
                    "trendStatus": trend_status,
                    "isBullAlign": is_bull_align,
                    "isBrokenDown": is_broken_down,
                    "isBottomDoji": is_bottom_doji,
                    "isVolIgnition": is_vol_ignition,
                    "isHighStagnation": is_high_stagnation,
                    "bollUpper": bd_info.get("bollUpper", 0.0),
                    "bollMid": bd_info.get("bollMid", round(ma20, 2)),
                    "bollLower": bd_info.get("bollLower", 0.0),
                    "bollPctB": bd_info.get("pctB", 50.0),
                    "bollStructure": bd_info.get("structureLabel", ""),
                    "topDivergence": bool(bd_info.get("topDivergence", False)),
                    "topDivDesc": bd_info.get("topDivDesc", ""),
                    "bottomDivergence": bool(bd_info.get("bottomDivergence", False)),
                    "bottomDivDesc": bd_info.get("bottomDivDesc", ""),
                }

                chips_data = {
                    "curPrice": cur_px,
                    "ma5": round(ma5, 2),
                    "ma10": round(ma10, 2),
                    "ma20": round(ma20, 2),
                    "ma60": round(ma60, 2),
                    "boxTop": round(box_top, 2),
                    "boxBot": round(box_bot, 2),
                    "boxPos": round(box_pos, 1),
                    **cyq_info,
                }

                # ===== 二轮 / 二波潜力与生命周期判定 =====
                lookback = min(len(days), 120)
                sub_highs = highs[-lookback:]
                sub_lows = lows[-lookback:]
                sub_vols = vols[-lookback:]
                max_h = max(sub_highs)
                max_h_idx = sub_highs.index(max_h)
                days_from_top = lookback - max_h_idx - 1

                # 见顶前的低点与首轮波幅
                valley_before_top = min(sub_lows[: max_h_idx + 1]) if max_h_idx > 0 else sub_lows[0]
                wave1_amp = ((max_h - valley_before_top) / valley_before_top) * 100 if valley_before_top > 0 else 0.0

                # 距最高点的回撤深度
                drawdown = ((cur_px - max_h) / max_h) * 100

                # 量能萎缩程度：最近5日均量 vs 见顶前5日均量
                peak_vols = sub_vols[max(0, max_h_idx - 2) : min(lookback, max_h_idx + 3)]
                peak_vol_avg = sum(peak_vols) / len(peak_vols) if peak_vols else max(sub_vols)
                cur_vol_avg = sum(vols[-5:]) / 5 if len(vols) >= 5 else vols[-1]
                vol_shrink = (cur_vol_avg / peak_vol_avg) * 100 if peak_vol_avg > 0 else 100.0

                # 二波研判逻辑（若存在顶部岛形反转，一票否决黄金二波潜伏判定）
                if wave1_amp >= 28:
                    if kline_patterns.get("hasTopIsland"):
                        stage = "⚠️ 顶部岛形反转·派发套牢区"
                        stage_tag = "high_risk"
                        potential = "极低 (顶部岛形反转否决)"
                        desc = "高位出现向下跳空顶部岛形反转，上方形成密集套牢孤岛，即便缩量回踩 MA20 也严禁误判为二波低吸点！"
                    elif days_from_top <= 3:
                        stage = "① 首轮加速高潮期"
                        stage_tag = "high_risk"
                        potential = "尚在首轮末端"
                        desc = f"首轮爆拉 +{wave1_amp:.1f}%，刚见顶 {days_from_top} 天，高位筹码剧烈派发换手，切忌追高，逢高倒T减仓！"
                    elif -25 <= drawdown <= -10 and cur_px >= ma20 * 0.95 and vol_shrink <= 65:
                        stage = "② 【二轮蓄势·黄金潜伏期】"
                        stage_tag = "golden_second"
                        potential = "极高 (二波反弹蓄势)"
                        desc = f"首轮大涨 +{wave1_amp:.1f}% 后充分洗盘 {days_from_top} 天，回踩 {drawdown:.1f}% 在 MA20/箱底附近缩量止跌(量能萎缩至 {vol_shrink:.0f}%)，具备极强【二轮反包/回流主升】潜力，被套资金切忌低位割肉！"
                    elif drawdown < -32 and cur_px < ma60:
                        stage = "③ 二波证伪·破位退潮"
                        stage_tag = "dead"
                        potential = "偏低 (二波已证伪)"
                        desc = f"高位深度回撤 {drawdown:.1f}% 并跌穿 MA60 生命线，上方堆积沉重套牢盘，二波预期已被市场否定，反弹应果断倒T离场。"
                    else:
                        stage = "④ 首轮分歧休整期"
                        stage_tag = "neutral"
                        potential = "观察中 (等待回流)"
                        desc = f"自高位回撤 {drawdown:.1f}%，多空剧烈拉锯换手，需耐心等待板块重新放量收复分时均线与短期均线。"
                else:
                    stage = "⑤ 常态波段题材"
                    stage_tag = "normal"
                    potential = "普通 (无大级别二波)"
                    desc = f"近120日未出现超 28% 的大级别主升浪（最大波幅 +{wave1_amp:.1f}%），属于常态波段轮动，按箱体网格高抛低吸即可。"

                second_wave_data = {
                    "stage": stage,
                    "stageTag": stage_tag,
                    "secondWavePotential": potential,
                    "wave1Amplitude": round(wave1_amp, 1),
                    "maxHigh": round(max_h, 2),
                    "daysFromTop": days_from_top,
                    "drawdown": round(drawdown, 1),
                    "volShrink": round(vol_shrink, 1),
                    "desc": desc,
                }

                # ===== 实验性弱参考：近14日ATR波动率 + 近120日个股历史基因概率回测 =====
                try:
                    today_iso = cn_today_iso()
                    comp_end = len(dates) - 1 if dates[-1] == today_iso else len(dates)
                    if comp_end >= 16:
                        # 1) ATR(14) 动态波动率剖面
                        tr_sum = 0.0
                        amp14_sum = 0.0
                        atr_cnt = 0
                        atr_start = max(1, comp_end - 14)
                        for idx_a in range(atr_start, comp_end):
                            pc_a = closes[idx_a - 1]
                            h_a, l_a = highs[idx_a], lows[idx_a]
                            if pc_a <= 0 or h_a <= 0 or l_a <= 0:
                                continue
                            tr_a = max(h_a - l_a, abs(h_a - pc_a), abs(l_a - pc_a))
                            tr_sum += tr_a
                            amp14_sum += ((h_a - l_a) / pc_a) * 100
                            atr_cnt += 1
                        if atr_cnt >= 5:
                            atr14_val = tr_sum / atr_cnt
                            ref_px = float(quote_data.get("prevClose") or 0.0) or closes[comp_end - 1] or cur_px
                            atr_pct_val = (atr14_val / ref_px) * 100 if ref_px > 0 else 0.0
                            avg_amp14_val = amp14_sum / atr_cnt
                            adaptive_grid_val = round(max(0.80, min(2.60, avg_amp14_val * 0.34)), 2)
                            if adaptive_grid_val < 1.05:
                                vol_type_label = "🐢 低波窄幅型"
                            elif adaptive_grid_val > 1.60:
                                vol_type_label = "⚡ 高波活跃型"
                            else:
                                vol_type_label = "⚖️ 标准均衡型"
                            atr_profile = {
                                "atr14": round(atr14_val, 2),
                                "atrPct": round(atr_pct_val, 2),
                                "avgIntraAmp14": round(avg_amp14_val, 2),
                                "adaptiveGrid": adaptive_grid_val,
                                "volType": vol_type_label,
                                "sampleDays": atr_cnt,
                            }

                        # 2) 近120日历史基因概率统计（保持近半年 120 交易日窗口，不因 CYQ 扩至 210 日而稀释近期股性）
                        tot_d = 0
                        amp3_d = 0
                        dip_tot = 0
                        dip_win = 0
                        dip_reb_sum = 0.0
                        gap_up_tot = 0
                        gap_up_smash = 0
                        dna_start = max(1, comp_end - 120)
                        for idx_k in range(dna_start, comp_end):
                            pc_k = closes[idx_k - 1]
                            o_k, c_k, h_k, l_k = opens[idx_k], closes[idx_k], highs[idx_k], lows[idx_k]
                            if pc_k <= 0 or o_k <= 0 or l_k <= 0:
                                continue
                            tot_d += 1
                            amp_k = ((h_k - l_k) / pc_k) * 100
                            gap_k = ((o_k - pc_k) / pc_k) * 100
                            dip_o_k = ((l_k - o_k) / o_k) * 100
                            dip_p_k = ((l_k - pc_k) / pc_k) * 100
                            reb_k = ((c_k - l_k) / l_k) * 100
                            if amp_k >= 3.0:
                                amp3_d += 1
                            if dip_o_k <= -1.8 or dip_p_k <= -1.8:
                                dip_tot += 1
                                dip_reb_sum += reb_k
                                if reb_k >= 1.2:
                                    dip_win += 1
                            if gap_k >= 0.8:
                                gap_up_tot += 1
                                if c_k < o_k:
                                    gap_up_smash += 1
                        if tot_d >= 15:
                            t3_pct = round((amp3_d / tot_d) * 100)
                            d_win_rate = round((dip_win / dip_tot) * 100) if dip_tot > 0 else 0
                            d_avg_reb = round((dip_reb_sum / dip_tot), 2) if dip_tot > 0 else 0.0
                            g_smash_rate = round((gap_up_smash / gap_up_tot) * 100) if gap_up_tot > 0 else 0

                            if t3_pct < 35:
                                d_tag = "🐢 窄幅织布基因"
                                d_desc = f"近{tot_d}日仅{t3_pct}%交易日振幅≥3%，波动偏窄，短线做T弹性偏弱。"
                            elif gap_up_tot >= 6 and g_smash_rate >= 62:
                                d_tag = "🎭 高开砸盘(渣男)基因"
                                d_desc = f"近半年高开{gap_up_tot}次有{g_smash_rate}%收阴回落，忌早盘追高。"
                            elif dip_tot >= 6 and d_win_rate >= 62:
                                d_tag = "⚡ 深V反弹(抗跌)基因"
                                d_desc = f"近半年深探≥1.8%共{dip_tot}次，{d_win_rate}%日内低吸反抽≥1.2%(均抽+{d_avg_reb}%)。"
                            elif dip_tot >= 6 and d_win_rate <= 35:
                                d_tag = "🧊 单边阴跌基因(慎抄底)"
                                d_desc = f"近半年深探共{dip_tot}次，反抽胜率仅{d_win_rate}%，少做日内左侧抄底。"
                            else:
                                d_tag = "⚖️ 均衡震荡基因"
                                d_desc = f"近{tot_d}日做T振幅达标率{t3_pct}%，高开回落与深水反抽表现较均衡。"

                            experimental_dna = {
                                "sampleDays": tot_d,
                                "tFriendly3Pct": t3_pct,
                                "dipTotal": dip_tot,
                                "dipWin": dip_win,
                                "dipWinRate": d_win_rate,
                                "dipAvgRebound": d_avg_reb,
                                "gapUpTotal": gap_up_tot,
                                "gapUpSmashRate": g_smash_rate,
                                "dnaTag": d_tag,
                                "dnaDesc": d_desc,
                            }
                except Exception:
                    pass
        except Exception:
            pass

    # 7. 全天分时 (VWAP 均价线与日内形态，结合同源 A 股交易日历防止周末/法定节假日/盘前误用历史分时)
    cal_snapshot = get_market_calendar_snapshot()
    min_resp = resps[6]
    intraday_data = {}
    if not isinstance(min_resp, Exception) and min_resp.status_code == 200:
        try:
            m_json = min_resp.json()
            min_node = m_json.get("data", {}).get(tcode, {}).get("data", {}) or {}
            min_arr = min_node.get("data", [])
            min_date = re.sub(r"\D", "", str(min_node.get("date") or ""))[:8]
            today_ymd = cal_snapshot["ymd"]
            is_today_min = (
                bool(cal_snapshot["isTradeDay"] and min_date == today_ymd)
                if min_date
                else bool(cal_snapshot["isTradingNow"])
            )
            if min_arr:
                m_prices = []
                m_vwap_arr = []
                above_cnt = 0
                for item in min_arr:
                    pts = item.split(" ")
                    if len(pts) >= 4:
                        m_p = float(pts[1])
                        c_vol = float(pts[2])
                        c_amt = float(pts[3])
                        m_vwap = (c_amt / (c_vol * 100)) if c_vol > 0 else m_p
                        m_prices.append(m_p)
                        m_vwap_arr.append(m_vwap)
                        if m_p >= m_vwap:
                            above_cnt += 1

                if m_prices:
                    cur_p = m_prices[-1]
                    last_v = m_vwap_arr[-1]
                    h_p = max(m_prices)
                    l_p = min(m_prices)
                    prev_c = quote_data["prevClose"] if quote_data["prevClose"] > 0 else m_prices[0]
                    amp = ((h_p - l_p) / prev_c) * 100 if prev_c > 0 else 0.0
                    above_ratio = (above_cnt / len(m_prices)) * 100

                    # 日内形态判断
                    h_idx = m_prices.index(h_p)
                    l_idx = m_prices.index(l_p)
                    tot = len(m_prices)

                    if h_idx < 35 and cur_p < last_v:
                        pattern = "早盘脉冲冲高回落 (典型诱多，受均价线压制)"
                        pattern_type = "dump"
                    elif l_idx < 35 and cur_p >= last_v and cur_p >= (h_p + l_p) / 2:
                        pattern = "探底强劲企稳回升 (下探洗盘后收复均价线)"
                        pattern_type = "rebound"
                    elif above_ratio >= 70:
                        pattern = "多头全天控盘 (分时全程稳站均价线上方)"
                        pattern_type = "bull"
                    elif above_ratio <= 30:
                        pattern = "空头全天压制 (分时白线全程被均价线压制)"
                        pattern_type = "bear"
                    elif amp < 2.0:
                        pattern = "极窄幅缩量横盘 (日内波动不足2%，做T无利可图)"
                        pattern_type = "flat"
                    else:
                        pattern = "分时震荡多空拉锯"
                        pattern_type = "chop"

                    if not is_today_min:
                        tag_prefix = cal_snapshot["label"] if not cal_snapshot["isTradeDay"] else "历史分时"
                        pattern = f"[{tag_prefix} {min_date}] {pattern}"

                    intraday_data = {
                        "date": min_date,
                        "isToday": is_today_min,
                        "marketStatus": cal_snapshot["sessionLabel"],
                        "curPrice": cur_p,
                        "vwap": round(last_v, 2),
                        "vwapDiff": round(((cur_p - last_v) / last_v) * 100, 2) if last_v > 0 else 0.0,
                        "highPrice": h_p,
                        "lowPrice": l_p,
                        "amp": round(amp, 2),
                        "aboveRatio": round(above_ratio, 1),
                        "pattern": pattern,
                        "patternType": pattern_type,
                    }
        except Exception:
            pass

    # 8. 综合评级与【做T自救新版处方】
    risk_level = "安全"
    risk_color = "green"
    if red_flags:
        risk_level = "高危利空警示"
        risk_color = "red"
    elif yellow_alerts:
        risk_level = "存在需关注事项"
        risk_color = "yellow"

    theme_status = "一般题材 / 未在今日风口"
    if matched_hot_themes:
        top_t = matched_hot_themes[0]
        theme_status = f"🔥 属于今日主线热点【{top_t['name']}】(+{top_t['chg']}%)"

    prescriptions = []

    # 1) 排雷与高危 K 线形态法则
    if red_flags:
        prescriptions.append(f"【严控风险】近1个月有高危公告（{red_flags[0]['title'][:25]}），深套切勿盲目补仓！")
    if kline_patterns.get("hasTopIsland"):
        prescriptions.append("【顶部岛形反转】高位向下跳空留下悬空套牢区，严禁正T抄底摊薄，反抽缺口下沿坚决倒T降仓！")
    elif kline_patterns.get("hasBottomIsland"):
        prescriptions.append("【底部岛形反转】低位放量向上跳空突破孤岛，趋势拐点信号明确，回踩缺口上沿不补可顺势正T！")

    # 2) 二波预期法则 (最核心的解套指引)
    if second_wave_data:
        stag_tag = second_wave_data.get("stageTag")
        if stag_tag == "golden_second":
            prescriptions.append(
                f"【二轮蓄势·坚守博弈】{second_wave_data['desc']} 深套资金切忌在地板割肉，逢缩量支撑可小仓试正T低吸！"
            )
        elif stag_tag == "dead":
            prescriptions.append(
                f"【二波证伪·坚决止损】{second_wave_data['desc']} 严禁逆势摊薄，反弹触碰上方均线必须坚决倒T减亏！"
            )
        elif stag_tag == "high_risk":
            prescriptions.append(f"【高位兑现】{second_wave_data['desc']}")

    # 3) 板块生态与身位法则
    if sector_ecology:
        sec_role = sector_ecology.get("role", "")
        if "后排跟风弱势杂毛" in sec_role:
            prescriptions.append("【杂毛警示】该股在当前板块中处于跟风滞涨身位，板块一旦冲高见顶易加速跳水，做T以逢高倒T减仓为主。")
        elif "板块大容量中军" in sec_role:
            prescriptions.append("【中军持股】作为板块大容量中军，承接力强，适合依托 20 日均线与箱体下沿做底仓波段网格T。")

    # 4) 分时日内与做T空间法则（仅对今日有效分时生效）
    if intraday_data and intraday_data.get("isToday", True):
        amp = intraday_data.get("amp", 0.0)
        p_type = intraday_data.get("patternType")
        if amp < 2.0:
            prescriptions.append("【垃圾时间】全天振幅不足 2.0%，差价无法覆盖交易税费与滑点，今日宜多看少动，坚决不盲动。")
        elif p_type == "dump":
            prescriptions.append("【冲高诱多】早盘脉冲后全天被分时均价线压制，切忌分时追高，盘中反抽触碰黄线即是倒T卖点。")
        elif p_type == "rebound":
            prescriptions.append("【探底企稳】早盘探底后午后稳步收复均价线，多头承接坚决，可顺势在均价线附近做正T低吸。")

    # 5) 筹码套牢度与单峰密集法则
    if chips_data:
        p_ratio = chips_data.get("profitRatio", 50)
        box_pos = chips_data.get("boxPos", 50)
        conc90_val = chips_data.get("concentration90", 0.0)
        if p_ratio < 20 and box_pos <= 25:
            prescriptions.append(f"【超跌箱底】CYQ获利盘仅 {p_ratio:.1f}% 且贴近 20 日箱底，筹码割无可割，若缩量企稳是左侧轻仓试正T的安全位置。")
        elif 0 < conc90_val <= 10.0 and p_ratio >= 55 and not kline_patterns.get("hasTopIsland"):
            prescriptions.append(
                f"【单峰密集锁筹】210日CYQ 90%集中度仅 {conc90_val:.1f}%（主峰 ¥{chips_data.get('peakPrice', 0):.2f}），"
                "筹码高度凝聚，回踩主峰或分时均线适合顺势做正T。"
            )

    # 9. 解析大盘环境情绪、短线连板/抱团联动身位 与 多因子综合买入决策评分引擎
    limitup_data = resps[7] if len(resps) > 7 and isinstance(resps[7], dict) and resps[7].get("ok") else {}
    market_sentiment = limitup_data.get("sentiment") or {}

    zt_item = next((x for x in (limitup_data.get("items") or []) if str(x.get("code", "")).zfill(6) == code), None)
    sp_item = next((x for x in (limitup_data.get("strongPool") or []) if str(x.get("code", "")).zfill(6) == code), None)
    herd_item = next((x for x in (limitup_data.get("herdPool") or []) if str(x.get("code", "")).zfill(6) == code), None)
    zb_item = next((x for x in (limitup_data.get("zbPool") or []) if str(x.get("code", "")).zfill(6) == code), None)
    rush_item = next((x for x in (limitup_data.get("rushingPool") or []) if str(x.get("code", "")).zfill(6) == code), None)

    short_term_status = None
    if any([zt_item, sp_item, herd_item, zb_item, rush_item]):
        short_term_status = {
            "inStrongPool": sp_item is not None,
            "inHerdPool": herd_item is not None,
            "isLimitUp": (zt_item is not None) or bool(sp_item and sp_item.get("isLimitUp")),
            "isBrokenBoard": zb_item is not None,
            "isRushing": rush_item is not None,
            "statTag": (sp_item or zt_item or herd_item or {}).get("statTag", ""),
            "lbc": int((zt_item or sp_item or herd_item or {}).get("lbc") or 0),
            "identityScore": sp_item.get("identityScore") if sp_item else None,
            "relayScore": sp_item.get("relayScore") if sp_item else None,
            "scoreDims": sp_item.get("scoreDims") if sp_item else None,
            "cycleAdvice": sp_item.get("cycleAdvice", "") if sp_item else "",
            "tags": (sp_item or herd_item or {}).get("tags", []),
            "fbt": (zt_item or sp_item or zb_item or {}).get("fbt", "—"),
            "fund": float((zt_item or sp_item or {}).get("fund") or 0.0),
            "sealRatio": float((zt_item or sp_item or {}).get("sealRatio") or 0.0),
            "zbc": int((zt_item or sp_item or zb_item or {}).get("zbc") or 0),
            "buyTag": (zt_item or rush_item or {}).get("buyTag", ""),
            "buyAction": (zt_item or rush_item or {}).get("buyAction", ""),
            "dropFromTop": zb_item.get("dropFromTop") if zb_item else None,
            "distCeiling": rush_item.get("distCeiling") if rush_item else None,
            "herdHealth": (herd_item or {}).get("healthStatus") or (sp_item or {}).get("herdHealth", ""),
            "herdLabel": (herd_item or {}).get("healthLabel") or (sp_item or {}).get("healthLabel", ""),
            "herdDesc": (herd_item or {}).get("healthDesc", ""),
            "cumReturnPct": (herd_item or {}).get("cumReturnPct"),
            "vsMa5": (herd_item or sp_item or {}).get("vsMa5"),
            "ddFromPeak": (herd_item or sp_item or {}).get("ddFromPeak"),
            "mysticRoots": (sp_item or herd_item or {}).get("mysticRoots", []),
            "mysticCluster": (sp_item or herd_item or {}).get("mysticCluster", ""),
            "mysticZtCount": int((sp_item or herd_item or {}).get("mysticZtCount") or 0),
            "isMysticResonant": bool((sp_item or herd_item or {}).get("isMysticResonant")),
        }

    five_step_system = _build_five_step_review(
        code=code,
        quote_data=quote_data,
        days=days,
        chips_data=chips_data,
        technicals_data=technicals_data,
        kline_patterns=kline_patterns,
        limitup_data=limitup_data,
        market_sentiment=market_sentiment,
        company_info=company_info,
        all_concepts=all_concepts,
        matched_hot_themes=matched_hot_themes,
        risk_level=risk_level,
        red_flags=red_flags,
        yellow_alerts=yellow_alerts,
    )

    decision_data = build_comprehensive_decision(
        quote=quote_data,
        chips=chips_data,
        technicals=technicals_data,
        intraday=intraday_data,
        second_wave=second_wave_data,
        sector_ecology=sector_ecology,
        matched_hot_themes=matched_hot_themes,
        red_flags=red_flags,
        yellow_alerts=yellow_alerts,
        green_catalysts=green_catalysts,
        market_sentiment=market_sentiment,
        atr_profile=atr_profile,
        experimental_dna=experimental_dna,
        kline_patterns=kline_patterns,
        trade_calendar=cal_snapshot,
        five_step_review=five_step_system,
    )

    tp_final = decision_data.get("tradePlan") or {}
    five_step_system["step4Execution"] = {
        "recommendedStopPrice": tp_final.get("stopLossPrice") or 0.0,
        "stopAnchorLabel": tp_final.get("stopAnchorLabel") or "ATR动态止损",
        "stopAnchors": tp_final.get("stopAnchors") or [],
        "targetPrice1": tp_final.get("targetPrice1") or 0.0,
        "targetPrice2": tp_final.get("targetPrice2") or 0.0,
        "hasTopDivergence": bool(technicals_data.get("topDivergence")),
        "hasBottomDivergence": bool(technicals_data.get("bottomDivergence")),
    }

    diag_result = {
        "ok": True,
        "code": code,
        "tradeCalendar": cal_snapshot,
        "quote": quote_data,
        "company": company_info,
        "concepts": precise_concepts or all_concepts[:12],
        "allConcepts": all_concepts,
        "matchedHotThemes": matched_hot_themes,
        "sectorEcology": sector_ecology,
        "secondWave": second_wave_data,
        "intraday": intraday_data,
        "announcements": announcements[:20],
        "redFlags": red_flags,
        "yellowAlerts": yellow_alerts,
        "greenCatalysts": green_catalysts,
        "chips": chips_data,
        "technicals": technicals_data,
        "klinePatterns": kline_patterns,
        "atrProfile": atr_profile,
        "experimentalDNA": experimental_dna,
        "marketContext": market_sentiment,
        "shortTermStatus": short_term_status,
        "mysticClusters": (limitup_data.get("mysticClusters") or [])[:5],
        "fiveStepSystem": five_step_system,
        "decision": decision_data,
        "riskLevel": risk_level,
        "riskColor": risk_color,
        "themeStatus": theme_status,
        "prescriptions": prescriptions,
    }

    # 微信复制文本
    diag_result["wechatSummary"] = build_wechat_summary(diag_result)

    # 写入带容量上限缓存
    await _DIAGNOSIS_CACHE.set(code, diag_result, ttl=CACHE_TTL_SECONDS)

    return diag_result
