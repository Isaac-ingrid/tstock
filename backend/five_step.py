from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from .market_data import _aggregate_daily_bars

_DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def normalize_bars_for_ignition(days: List[Any], default_turnover: float = 2.5) -> List[dict]:
    """将 dict 或 list 格式日K统一归一化为 evaluate_ignition_six_dims 所需标准结构。"""
    norm: List[dict] = []
    for b in days or []:
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


def lookup_pool_provenance(code: str, data_dir: Optional[Path] = None) -> dict:
    """毫秒级读取本地起爆池、尾盘黑马池与在轨跟踪台账，识别该股在全站选股漏斗中的在榜状态。"""
    base_dir = data_dir or _DATA_DIR
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
        ign_file = base_dir / "ignition_latest.json"
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
        wb_file = base_dir / "latest.json"
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
        ledger_file = base_dir / "strategy_ledger.json"
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


def build_five_step_review(
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
    data_dir: Optional[Path] = None,
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
    norm_daily = normalize_bars_for_ignition(days, default_turnover=float(quote_data.get("turnover") or 2.5))
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

    provenance = lookup_pool_provenance(code, data_dir=data_dir)

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
