from __future__ import annotations

import asyncio
import datetime
import json
import os
import statistics
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx

from .limitup import get_limitup_pool

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE_OUT_DIR = os.path.join(BASE_DIR, "选股引擎", "out")
DATA_DIR = os.path.join(BASE_DIR, "data")
STRATEGY_LEDGER_FILE = os.path.join(DATA_DIR, "strategy_ledger.json")

STRATEGY_BASELINE_DATE = "2026-11-10"
ROUND_TRIP_FEE = 0.00102  # 买入佣万2.5+过户万0.1 + 卖出佣万2.5+印花税千0.5+过户万0.1 ≈ 0.102%

_LEDGER_LOCK = asyncio.Lock()
_PERF_CACHE: Dict[str, Tuple[float, dict]] = {}
_KLINE_MEM_CACHE: Dict[str, Tuple[float, List[dict]]] = {}
PERF_CACHE_TTL = 45.0
KLINE_CACHE_TTL = 120.0


def _sf(v: Any, default: float = 0.0) -> float:
    try:
        if v in (None, "", "-", "--", "—"):
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def _to_six(code_raw: Any) -> str:
    s = str(code_raw or "").strip()
    if "." in s:
        s = s.split(".", 1)[0]
    for pfx in ("sh", "sz", "bj", "SH", "SZ", "BJ"):
        if s.startswith(pfx):
            s = s[2:]
            break
    return s.zfill(6)


def _to_tcode(code6: str) -> str:
    c = _to_six(code6)
    if c.startswith(("6", "9")):
        return f"sh{c}"
    if c.startswith(("4", "8")) or c.startswith("92"):
        return f"bj{c}"
    return f"sz{c}"


def _to_em_secid(code6: str) -> str:
    c = _to_six(code6)
    return f"1.{c}" if c.startswith(("6", "9")) else f"0.{c}"


def _norm_iso_date(raw: Any) -> str:
    s = str(raw or "").strip()
    if len(s) == 8 and s.isdigit():
        return f"{s[0:4]}-{s[4:6]}-{s[6:8]}"
    return s[:10]


def _load_ledger_sync() -> dict:
    if os.path.exists(STRATEGY_LEDGER_FILE):
        try:
            with open(STRATEGY_LEDGER_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict) and isinstance(data.get("signals"), dict):
                    return data
        except Exception:
            pass
    return {
        "baselineDate": STRATEGY_BASELINE_DATE,
        "updatedAt": "",
        "signals": {},
    }


def _save_ledger_sync(state: dict) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp_path = f"{STRATEGY_LEDGER_FILE}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, STRATEGY_LEDGER_FILE)


def _read_json_safe(path: str) -> Optional[dict]:
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _upsert_signal(signals: Dict[str, dict], record: dict, update_if_same_day: bool = False) -> bool:
    sid = record["id"]
    if sid not in signals:
        signals[sid] = record
        return True
    if update_if_same_day:
        existing = signals[sid]
        merged = {**existing, **record}
        if merged != existing:
            signals[sid] = merged
            return True
    return False


async def _ingest_node_engine_outputs(signals: Dict[str, dict], today_iso: str) -> int:
    """从选股引擎/out 抓取 >= STRATEGY_BASELINE_DATE 的短线 plan、尾盘 tail 与稳健 steady 信号。"""
    added = 0
    if not os.path.exists(ENGINE_OUT_DIR):
        return 0

    files = sorted(os.listdir(ENGINE_OUT_DIR))

    # 1. 短线做T候选 (plan-YYYY-MM-DD.json)
    for fname in files:
        if not (fname.startswith("plan-") and fname.endswith(".json")):
            continue
        p_data = _read_json_safe(os.path.join(ENGINE_OUT_DIR, fname))
        if not p_data or not p_data.get("rows"):
            continue
        sig_date = _norm_iso_date(p_data.get("date") or fname[5:15])
        if sig_date < STRATEGY_BASELINE_DATE:
            continue
        env_level = str((p_data.get("env") or {}).get("level") or "OK").upper()
        for row in p_data["rows"]:
            code6 = _to_six(row.get("code"))
            if not code6.isdigit() or code6.startswith("30"):
                continue
            pc = _sf(row.get("pc"))
            buy_px = round(_sf(row.get("expOpen"), pc), 2)
            if buy_px <= 0:
                continue
            buy_lo = round(buy_px * 0.995, 2)
            buy_hi = round(buy_px * 1.005, 2)
            rec = {
                "id": f"short:{sig_date}:{code6}",
                "strategy": "short",
                "subType": str(row.get("verdict") or "短线"),
                "signalDate": sig_date,
                "code": code6,
                "tcode": _to_tcode(code6),
                "name": str(row.get("name") or code6).replace(" ", ""),
                "score": _sf(row.get("score")),
                "verdict": str(row.get("verdict") or ""),
                "action": str(row.get("action") or ""),
                "env": env_level,
                "refPrice": round(pc, 2),
                "buy": buy_px,
                "buyLo": buy_lo,
                "buyHi": buy_hi,
                "sell1": round(_sf(row.get("sell1"), buy_px * 1.015), 2),
                "sell2": round(_sf(row.get("sell2"), buy_px * 1.028), 2),
                "stop": round(_sf(row.get("stop"), buy_px * 0.985), 2),
                "amp": round(_sf(row.get("amp"), 3.0), 2),
            }
            if _upsert_signal(signals, rec, update_if_same_day=(sig_date == today_iso)):
                added += 1

    # 2. 尾盘黑马 (tail-YYYY-MM-DD.json)
    for fname in files:
        if not (fname.startswith("tail-") and fname.endswith(".json") and "snapshot" not in fname):
            continue
        t_data = _read_json_safe(os.path.join(ENGINE_OUT_DIR, fname))
        if not t_data or not t_data.get("picks"):
            continue
        sig_date = _norm_iso_date(t_data.get("date") or fname[5:15])
        if sig_date < STRATEGY_BASELINE_DATE:
            continue
        env_level = str((t_data.get("env") or {}).get("level") or "OK").upper()
        for row in t_data["picks"]:
            code6 = _to_six(row.get("code"))
            if not code6.isdigit() or code6.startswith("30"):
                continue
            px = round(_sf(row.get("price")), 2)
            if px <= 0:
                continue
            rec = {
                "id": f"tail:{sig_date}:{code6}",
                "strategy": "tail",
                "subType": str(row.get("verdict") or "尾盘黑马"),
                "signalDate": sig_date,
                "scanTime": str(t_data.get("scanTime") or "14:30"),
                "code": code6,
                "tcode": _to_tcode(code6),
                "name": str(row.get("name") or code6).replace(" ", ""),
                "score": _sf(row.get("score")),
                "verdict": str(row.get("verdict") or "可挂"),
                "env": env_level,
                "refPrice": px,
                "buy": px,
                "sell1": round(px * 1.025, 2),
                "sell2": round(px * 1.045, 2),
                "stop": round(px * 0.985, 2),
                "chgPctAtScan": round(_sf(row.get("chgPct")), 2),
                "limitRoom": round(_sf(row.get("limitRoom")), 2),
            }
            if _upsert_signal(signals, rec, update_if_same_day=(sig_date == today_iso)):
                added += 1

    # 3. 稳健底仓长线 (steady.json / steady-YYYY-MM-DD.json)
    steady_sources: List[Tuple[str, dict]] = []
    for fname in files:
        if fname.startswith("steady-") and fname.endswith(".json") and fname != "steady-pool.json":
            sd = _read_json_safe(os.path.join(ENGINE_OUT_DIR, fname))
            if sd:
                steady_sources.append((fname, sd))
    main_steady = _read_json_safe(os.path.join(ENGINE_OUT_DIR, "steady.json"))
    if main_steady:
        steady_sources.append(("steady.json", main_steady))

    has_steady_already = any(v.get("strategy") == "steady" for v in signals.values())
    for fname, sd in steady_sources:
        raw_date = _norm_iso_date(sd.get("date"))
        # 从今天起建档：如果仅有上周五(11-06)稳健清单且尚未建基线，则以 STRATEGY_BASELINE_DATE 作为起点建基线
        if raw_date >= STRATEGY_BASELINE_DATE:
            sig_date = raw_date
        elif fname == "steady.json" and not has_steady_already:
            sig_date = STRATEGY_BASELINE_DATE
        else:
            continue

        pick_rows = sd.get("top") or (sd.get("rows") or [])[:15]
        for row in pick_rows:
            code6 = _to_six(row.get("code"))
            if not code6.isdigit() or code6.startswith("30"):
                continue
            close_px = round(_sf(row.get("close")), 2)
            if close_px <= 0:
                continue
            rec = {
                "id": f"steady:{sig_date}:{code6}",
                "strategy": "steady",
                "subType": "稳健底仓",
                "signalDate": sig_date,
                "sourceDate": raw_date,
                "code": code6,
                "tcode": _to_tcode(code6),
                "name": str(row.get("name") or code6).replace(" ", ""),
                "score": _sf(row.get("score")),
                "verdict": "稳健底仓",
                "env": "OK",
                "refPrice": close_px,
                "buy": close_px,
                "amp20": round(_sf(row.get("amp20"), 2.5), 2),
                "atrPct": round(_sf(row.get("atrPct"), 2.5), 2),
                "div": round(_sf(row.get("div"), 0.0), 2),
                "roe": round(_sf(row.get("roe"), 0.0), 2),
                "trend": str(row.get("trend") or ""),
            }
            if _upsert_signal(signals, rec, update_if_same_day=(sig_date == today_iso)):
                added += 1
                has_steady_already = True

    return added


async def _ingest_board_signals(signals: Dict[str, dict], today_iso: str, http_client: Optional[httpx.AsyncClient] = None) -> dict:
    """
    从连板打板池建档当日打板信号：
    - 严格遵循规则：自动剔除 `LOCKED` (09:25 一字封死) 与 `LATE` (14:30+ 尾盘偷袭)！
    - 记录可买打板窗口 (AUCTION / RUSH / RESEAL / NORMAL<14:30) 与当天风控总阀 (GREEN / YELLOW / RED) 作对照。
    """
    lp = await get_limitup_pool(date_str=None, http_client=http_client)
    if not isinstance(lp, dict) or not lp.get("ok"):
        return {"added": 0, "excludedLocked": 0, "excludedLate": 0}

    sig_date = _norm_iso_date(lp.get("date"))
    if not sig_date or sig_date < STRATEGY_BASELINE_DATE:
        return {"added": 0, "excludedLocked": 0, "excludedLate": 0}

    sentiment = lp.get("sentiment") or {}
    valve = str(sentiment.get("riskValve") or "GREEN").upper()
    sp_by_code = {str(x.get("code", "")).zfill(6): x for x in (lp.get("strongPool") or [])}

    added = 0
    excluded_locked = 0
    excluded_late = 0

    for item in lp.get("items") or []:
        code6 = _to_six(item.get("code"))
        if not code6.startswith(("00", "60")):
            continue
        bw = str(item.get("buyWindow") or "").upper()
        if bw == "LOCKED":
            excluded_locked += 1
            continue
        if bw == "LATE":
            excluded_late += 1
            continue

        px = round(_sf(item.get("price")), 2)
        if px <= 0:
            continue
        sp = sp_by_code.get(code6) or {}
        rec = {
            "id": f"board:{sig_date}:{code6}",
            "strategy": "board",
            "subType": bw or "NORMAL",
            "signalDate": sig_date,
            "code": code6,
            "tcode": _to_tcode(code6),
            "name": str(item.get("name") or code6),
            "hybk": str(item.get("hybk") or "其他板块"),
            "lbc": int(item.get("lbc") or 1),
            "statTag": str(item.get("statTag") or ""),
            "fbt": str(item.get("fbt") or "—"),
            "sealRatio": round(_sf(item.get("sealRatio")), 2),
            "zbc": int(item.get("zbc") or 0),
            "buyWindow": bw,
            "buyTag": str(item.get("buyTag") or ""),
            "score": _sf(item.get("score")),
            "identityScore": sp.get("identityScore"),
            "relayScore": sp.get("relayScore"),
            "isMysticResonant": bool(sp.get("isMysticResonant")),
            "mysticCluster": str(sp.get("mysticCluster") or ""),
            "verdict": str(item.get("verdict") or ""),
            "env": valve,
            "refPrice": px,
            "buy": px,
        }
        if _upsert_signal(signals, rec, update_if_same_day=(sig_date == today_iso)):
            added += 1

    return {"added": added, "excludedLocked": excluded_locked, "excludedLate": excluded_late, "signalDate": sig_date}


async def snapshot_strategies(http_client: Optional[httpx.AsyncClient] = None) -> dict:
    """触发一次全策略建档快照并原子落盘至 data/strategy_ledger.json。"""
    today_iso = datetime.date.today().strftime("%Y-%m-%d")
    async with _LEDGER_LOCK:
        state = _load_ledger_sync()
        signals: Dict[str, dict] = state.get("signals", {})
        # 清理任何早于基准日的旧杂项（保证严格自 2026-11-10 起建档）
        for sid in list(signals.keys()):
            if str(signals[sid].get("signalDate") or "") < STRATEGY_BASELINE_DATE:
                signals.pop(sid, None)

        eng_added = await _ingest_node_engine_outputs(signals, today_iso)
        board_info = await _ingest_board_signals(signals, today_iso, http_client=http_client)

        state["baselineDate"] = STRATEGY_BASELINE_DATE
        state["updatedAt"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        state["lastBoardExclude"] = {
            "date": board_info.get("signalDate", today_iso),
            "excludedLocked": board_info["excludedLocked"],
            "excludedLate": board_info["excludedLate"],
        }
        state["signals"] = signals
        _save_ledger_sync(state)
        _PERF_CACHE.clear()
        return {
            "ok": True,
            "totalSignals": len(signals),
            "engineAdded": eng_added,
            "boardAdded": board_info["added"],
            "excludedLocked": board_info["excludedLocked"],
            "excludedLate": board_info["excludedLate"],
            "updatedAt": state["updatedAt"],
        }


async def _fetch_daily_bars(client: httpx.AsyncClient, code6: str, sem: asyncio.Semaphore) -> List[dict]:
    now_ts = time.monotonic()
    cached = _KLINE_MEM_CACHE.get(code6)
    if cached and cached[0] > now_ts:
        return cached[1]

    tcode = _to_tcode(code6)
    em_secid = _to_em_secid(code6)
    em_url = (
        f"https://push2his.eastmoney.com/api/qt/stock/kline/get"
        f"?secid={em_secid}&fields1=f1,f2,f3,f4,f5,f6"
        f"&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&end=20500101&lmt=120"
    )
    bars: List[dict] = []
    async with sem:
        try:
            r = await client.get(em_url, headers={"Referer": "https://quote.eastmoney.com/"})
            if r.status_code == 200 and r.text.lstrip().startswith("{"):
                klines = (r.json().get("data") or {}).get("klines") or []
                for row in klines:
                    p = str(row).split(",")
                    if len(p) >= 6:
                        bars.append({
                            "date": p[0][:10],
                            "open": float(p[1]),
                            "close": float(p[2]),
                            "high": float(p[3]),
                            "low": float(p[4]),
                            "vol": float(p[5]),
                        })
        except Exception:
            bars = []

        if not bars:
            for host in ("web.ifzq.gtimg.cn", "ifzq.gtimg.cn"):
                u = f"https://{host}/appstock/app/fqkline/get?param={tcode},day,,,120,qfq"
                try:
                    rt = await client.get(u, headers={"Referer": "https://gu.qq.com/"})
                    if rt.status_code == 200 and rt.text.lstrip().startswith("{"):
                        node = (rt.json().get("data") or {}).get(tcode) or {}
                        arr = node.get("qfqday") or node.get("day") or []
                        for row in arr:
                            if len(row) >= 6:
                                bars.append({
                                    "date": str(row[0])[:10],
                                    "open": float(row[1]),
                                    "close": float(row[2]),
                                    "high": float(row[3]),
                                    "low": float(row[4]),
                                    "vol": float(row[5]),
                                })
                        if bars:
                            break
                except Exception:
                    continue

    if bars:
        _KLINE_MEM_CACHE[code6] = (now_ts + KLINE_CACHE_TTL, bars)
    return bars


def _pct(px_end: float, px_start: float, fee: float = ROUND_TRIP_FEE) -> Optional[float]:
    if px_start <= 0 or px_end <= 0:
        return None
    return round(((px_end / px_start - 1.0) - fee) * 100.0, 2)


def _find_anchor_idx(bars: List[dict], sig_date: str) -> Tuple[int, str]:
    """在日K序列中找到信号基准日（或此前最近交易日，针对周末基线如 11-06 -> 11-10）。"""
    for i, b in enumerate(bars):
        if b["date"] == sig_date:
            return i, "exact"
    # 若信号日在周末或尚未找到精确日，回落到 <= sig_date 的最后一根收盘K线
    idx = -1
    for i, b in enumerate(bars):
        if b["date"] <= sig_date:
            idx = i
    if idx >= 0:
        return idx, "prev_bar"
    return -1, "missing"


def _sim_daily_t_short(sig: dict, hold_bars: List[dict], prev_close_init: float) -> dict:
    """日K保守双口径正T模拟：仅看入场后最多5个交易日（T+1..T+5）逐日K路径。"""
    buy_anchor = _sf(sig.get("buy"), prev_close_init)
    sell1 = _sf(sig.get("sell1"), buy_anchor * 1.015)
    stop_px = _sf(sig.get("stop"), buy_anchor * 0.985)
    tp_ratio = max(0.008, min(0.035, (sell1 / buy_anchor - 1.0) if buy_anchor > 0 else 0.015))
    sl_ratio = max(-0.030, min(-0.010, (stop_px / buy_anchor - 1.0) if buy_anchor > 0 else -0.015))

    cum_t = 0.0
    trig_cnt = 0
    win_cnt = 0
    pc = prev_close_init

    for day_idx, bar in enumerate(hold_bars[:5]):
        o, h, l, c = bar["open"], bar["high"], bar["low"], bar["close"]
        if pc <= 0 or o <= 0:
            pc = c
            continue
        # 触发低吸正T买点：T+1 若踩入 buyHi，后续交易日若回踩昨收下方 0.4%
        dip_target = _sf(sig.get("buyHi"), pc * 0.996) if day_idx == 0 else pc * 0.996
        if l <= dip_target:
            trig_cnt += 1
            buy_t = min(o, dip_target)
            tp_px = buy_t * (1.0 + tp_ratio)
            sl_px = buy_t * (1.0 + sl_ratio)
            # 保守路径判定：阴线优先检查止损，阳线/探底回升才记止盈
            if c < o and l <= sl_px:
                day_ret = (sl_px / buy_t - 1.0 - ROUND_TRIP_FEE) * 100.0
            elif (c >= pc * 0.998 or (min(o, c) - l) > (h - max(o, c))) and h >= tp_px:
                day_ret = (tp_px / buy_t - 1.0 - ROUND_TRIP_FEE) * 100.0
                win_cnt += 1
            else:
                day_ret = (c / buy_t - 1.0 - ROUND_TRIP_FEE) * 100.0
                if day_ret > 0:
                    win_cnt += 1
            cum_t += day_ret
        pc = c

    return {
        "tTriggeredDays": trig_cnt,
        "tWinDays": win_cnt,
        "tAlphaPct": round(cum_t, 2),
    }


def _sim_daily_t_steady(sig: dict, hold_bars: List[dict], prev_close_init: float) -> dict:
    """稳健底仓逐日倒T保守模拟：仅当冲高后未收在全天最高附近时才记成功收敛。"""
    vol_pct = max(1.8, min(6.0, _sf(sig.get("atrPct"), _sf(sig.get("amp20"), 2.5))))
    step = max(0.011, min(0.028, (vol_pct / 100.0) * 0.48))

    cum_t = 0.0
    trig_cnt = 0
    win_cnt = 0
    pc = prev_close_init

    for bar in hold_bars[:20]:
        o, h, l, c = bar["open"], bar["high"], bar["low"], bar["close"]
        if pc <= 0 or h <= 0:
            pc = c
            continue
        sell_px = pc * (1.0 + step)
        if h >= sell_px:
            trig_cnt += 1
            sell_fill = max(o, sell_px)
            # 若收盘贴近最高点（>= 卖价 99.6%），视为单边强势挤空飞T，收盘追回计略微负磨损
            if c >= sell_fill * 0.996:
                day_ret = (sell_fill / c - 1.0 - ROUND_TRIP_FEE) * 100.0
            elif l <= pc * (1.0 + step * 0.35):
                buy_back = max(l, min(c, pc * (1.0 + step * 0.35)))
                day_ret = (sell_fill / buy_back - 1.0 - ROUND_TRIP_FEE) * 100.0
                if day_ret > 0:
                    win_cnt += 1
            else:
                day_ret = (sell_fill / c - 1.0 - ROUND_TRIP_FEE) * 100.0
                if day_ret > 0:
                    win_cnt += 1
            cum_t += day_ret
        pc = c

    return {
        "tTriggeredDays": trig_cnt,
        "tWinDays": win_cnt,
        "tAlphaPct": round(cum_t, 2),
    }


def _evaluate_signal_record(sig: dict, bars: List[dict]) -> dict:
    """对单条策略信号按日K序列逐日计算可实现买入口径、T+1..T+20 节点收益、极值回撤与做T增厚。"""
    strategy = sig["strategy"]
    sig_date = sig["signalDate"]
    anchor_idx, anchor_kind = _find_anchor_idx(bars, sig_date)

    out = {
        **sig,
        "status": "pending",  # pending (T+0等待次日) | active (已成交追踪中) | missed (短线回踩未踩到踏空)
        "entryDate": None,
        "entryPrice": None,
        "latestPrice": _sf(sig.get("refPrice")),
        "latestDate": sig_date,
        "holdDays": 0,
        "retLatest": None,
        "retAltLatest": None,  # 对短线：列B(回踩买入)最新收益
        "pullbackFilled": None,
        "pullbackEntryPrice": None,
        "horizons": {},        # {t1, t2, t3, t5, t10, t20, t1Open, t1High, t1RuleExit, promotedT1}
        "horizonsAlt": {},     # 对短线回踩口径的节点收益
        "maxGainPct": None,
        "maxDrawdownPct": None,
        "tTriggeredDays": 0,
        "tWinDays": 0,
        "tAlphaPct": 0.0,
        "totalReturnWithT": None,
    }

    if anchor_idx < 0 or not bars:
        return out

    future_bars = bars[anchor_idx + 1 :]
    last_bar = bars[-1]
    out["latestPrice"] = round(last_bar["close"], 2)
    out["latestDate"] = last_bar["date"]
    out["holdDays"] = len(future_bars)

    if strategy == "short":
        if not future_bars:
            return out
        b1 = future_bars[0]
        entry_open = round(b1["open"], 2)
        out["entryDate"] = b1["date"]
        out["entryPrice"] = entry_open
        out["status"] = "active"
        out["retLatest"] = _pct(last_bar["close"], entry_open)

        # 并列口径B：T+1 低点是否回踩进入建议 buyHi
        buy_hi = _sf(sig.get("buyHi"), _sf(sig.get("buy"), entry_open) * 1.005)
        if b1["low"] <= buy_hi and buy_hi > 0:
            pb_entry = round(min(b1["open"], buy_hi), 2)
            out["pullbackFilled"] = True
            out["pullbackEntryPrice"] = pb_entry
            out["retAltLatest"] = _pct(last_bar["close"], pb_entry)
        else:
            out["pullbackFilled"] = False
            out["pullbackEntryPrice"] = None
            out["retAltLatest"] = None

        horizons: Dict[str, Any] = {}
        horizons_alt: Dict[str, Any] = {}
        for h in (1, 2, 3, 5, 10, 20):
            if len(future_bars) >= h:
                hb = future_bars[h - 1]
                horizons[f"t{h}"] = _pct(hb["close"], entry_open)
                if out["pullbackFilled"] and out["pullbackEntryPrice"]:
                    horizons_alt[f"t{h}"] = _pct(hb["close"], out["pullbackEntryPrice"])
        horizons["t1High"] = _pct(b1["high"], entry_open)
        if out["pullbackFilled"] and out["pullbackEntryPrice"]:
            horizons_alt["t1High"] = _pct(b1["high"], out["pullbackEntryPrice"])
        out["horizons"] = horizons
        out["horizonsAlt"] = horizons_alt

        hi_max = max(b["high"] for b in future_bars)
        lo_min = min(b["low"] for b in future_bars)
        out["maxGainPct"] = _pct(hi_max, entry_open)
        out["maxDrawdownPct"] = _pct(lo_min, entry_open)

        t_res = _sim_daily_t_short(sig, future_bars, bars[anchor_idx]["close"])
        out.update(t_res)
        if out["retLatest"] is not None:
            out["totalReturnWithT"] = round(out["retLatest"] + out["tAlphaPct"], 2)
        return out

    if strategy == "steady":
        # 稳健长线：若已有 T+1 则用 T+1 开盘，T+0 展示当前收盘基准待次日开盘
        if not future_bars:
            return out
        b1 = future_bars[0]
        entry_px = round(b1["open"], 2)
        out["entryDate"] = b1["date"]
        out["entryPrice"] = entry_px
        out["status"] = "active"
        out["retLatest"] = _pct(last_bar["close"], entry_px)

        horizons = {}
        for h in (1, 3, 5, 10, 20):
            if len(future_bars) >= h:
                horizons[f"t{h}"] = _pct(future_bars[h - 1]["close"], entry_px)
        out["horizons"] = horizons
        hi_max = max(b["high"] for b in future_bars)
        lo_min = min(b["low"] for b in future_bars)
        out["maxGainPct"] = _pct(hi_max, entry_px)
        out["maxDrawdownPct"] = _pct(lo_min, entry_px)

        t_res = _sim_daily_t_steady(sig, future_bars, bars[anchor_idx]["close"])
        out.update(t_res)
        if out["retLatest"] is not None:
            out["totalReturnWithT"] = round(out["retLatest"] + out["tAlphaPct"], 2)
        return out

    if strategy == "tail":
        # 尾盘黑马：当日 14:30 扫出并在尾盘接入，买入锚 = 扫描价（或同日收盘确认）
        entry_px = round(_sf(sig.get("refPrice"), bars[anchor_idx]["close"]), 2)
        out["entryDate"] = bars[anchor_idx]["date"]
        out["entryPrice"] = entry_px
        out["status"] = "active" if future_bars else "pending"
        out["retLatest"] = _pct(last_bar["close"], entry_px) if future_bars else None
        horizons = {
            "t0Close": _pct(bars[anchor_idx]["close"], entry_px),
        }
        if future_bars:
            b1 = future_bars[0]
            horizons["t1Open"] = _pct(b1["open"], entry_px)
            horizons["t1High"] = _pct(b1["high"], entry_px)
            horizons["t1"] = _pct(b1["close"], entry_px)
            # 次日按规则 (+2.5%止盈 / -1.5%止损 / 否则收盘平) 出场净收益
            tp_px = entry_px * 1.025
            sl_px = entry_px * 0.985
            if b1["open"] >= tp_px:
                rule_px = b1["open"]
            elif b1["open"] <= sl_px:
                rule_px = b1["open"]
            elif b1["close"] < b1["open"] and b1["low"] <= sl_px:
                rule_px = sl_px
            elif b1["high"] >= tp_px:
                rule_px = tp_px
            else:
                rule_px = b1["close"]
            horizons["t1RuleExit"] = _pct(rule_px, entry_px)
            horizons["hitTp1"] = bool(b1["high"] >= tp_px)
            horizons["hitSl"] = bool(b1["open"] <= sl_px or (b1["close"] < b1["open"] and b1["low"] <= sl_px))
        if len(future_bars) >= 2:
            horizons["t2"] = _pct(future_bars[1]["close"], entry_px)
        if len(future_bars) >= 3:
            horizons["t3"] = _pct(future_bars[2]["close"], entry_px)
        out["horizons"] = horizons
        if future_bars:
            out["maxGainPct"] = _pct(max(b["high"] for b in future_bars), entry_px)
            out["maxDrawdownPct"] = _pct(min(b["low"] for b in future_bars), entry_px)
        return out

    if strategy == "board":
        # 连板打板（已剔除 LOCKED 与 LATE）：当日(T+0)涨停价打板接入
        entry_px = round(_sf(sig.get("refPrice"), bars[anchor_idx]["close"]), 2)
        out["entryDate"] = bars[anchor_idx]["date"]
        out["entryPrice"] = entry_px
        out["status"] = "active" if future_bars else "pending"
        out["retLatest"] = _pct(last_bar["close"], entry_px) if future_bars else None
        horizons = {}
        if future_bars:
            b1 = future_bars[0]
            horizons["t1Open"] = _pct(b1["open"], entry_px)
            horizons["t1High"] = _pct(b1["high"], entry_px)
            horizons["t1"] = _pct(b1["close"], entry_px)
            horizons["promotedT1"] = bool(b1["close"] >= entry_px * 1.095)
        if len(future_bars) >= 2:
            horizons["t2"] = _pct(future_bars[1]["close"], entry_px)
        if len(future_bars) >= 3:
            horizons["t3"] = _pct(future_bars[2]["close"], entry_px)
        if len(future_bars) >= 5:
            horizons["t5"] = _pct(future_bars[4]["close"], entry_px)
        out["horizons"] = horizons
        if future_bars:
            out["maxGainPct"] = _pct(max(b["high"] for b in future_bars), entry_px)
            out["maxDrawdownPct"] = _pct(min(b["low"] for b in future_bars), entry_px)
        return out

    return out


def _agg_numeric(vals: List[float], big_loss_thresh: float = -6.0) -> dict:
    if not vals:
        return {
            "count": 0,
            "winRate": None,
            "mean": None,
            "median": None,
            "profitFactor": None,
            "bigLossRate": None,
        }
    wins = [v for v in vals if v > 0]
    losses = [v for v in vals if v <= 0]
    pos_sum = sum(wins)
    neg_sum = abs(sum(losses))
    pf = round(pos_sum / neg_sum, 2) if neg_sum > 0 else (99.0 if pos_sum > 0 else 0.0)
    big_losses = sum(1 for v in vals if v <= big_loss_thresh)
    return {
        "count": len(vals),
        "winRate": round((len(wins) / len(vals)) * 100.0, 1),
        "mean": round(sum(vals) / len(vals), 2),
        "median": round(statistics.median(vals), 2),
        "profitFactor": pf,
        "bigLossRate": round((big_losses / len(vals)) * 100.0, 1),
    }


def _build_strategy_summaries(evaluated: List[dict], last_exclude: dict) -> dict:
    by_strat: Dict[str, List[dict]] = {"steady": [], "short": [], "tail": [], "board": []}
    for r in evaluated:
        if r["strategy"] in by_strat:
            by_strat[r["strategy"]].append(r)

    # 1. 稳健长线总结
    steady_all = by_strat["steady"]
    steady_active = [r for r in steady_all if r["retLatest"] is not None]
    steady_summary = {
        "totalSignals": len(steady_all),
        "activeCount": len(steady_active),
        "pendingCount": len(steady_all) - len(steady_active),
        "holdStats": _agg_numeric([r["retLatest"] for r in steady_active], -5.0),
        "withTStats": _agg_numeric([r["totalReturnWithT"] for r in steady_active if r["totalReturnWithT"] is not None], -5.0),
        "avgTAlpha": round(sum(r["tAlphaPct"] for r in steady_active) / len(steady_active), 2) if steady_active else None,
        "byHorizon": {
            k: _agg_numeric([r["horizons"][k] for r in steady_active if r["horizons"].get(k) is not None])
            for k in ("t1", "t3", "t5", "t10", "t20")
        },
    }

    # 2. 短线做T总结（两列并列：次日开盘基准 vs 回踩区间成交 + 环境闸门对照）
    short_all = by_strat["short"]
    short_exec = [r for r in short_all if r["env"] != "BAD" and r["verdict"] in ("可做", "小做")]
    short_bad_ctrl = [r for r in short_all if r["env"] == "BAD"]
    short_open_active = [r for r in short_exec if r["retLatest"] is not None]
    short_pb_pool = [r for r in short_exec if r["status"] == "active"]
    short_pb_filled = [r for r in short_pb_pool if r["pullbackFilled"] is True and r["retAltLatest"] is not None]
    short_bad_active = [r for r in short_bad_ctrl if r["retLatest"] is not None]

    t_trig_list = [r for r in short_open_active if r["tTriggeredDays"] > 0]
    short_summary = {
        "totalSignals": len(short_all),
        "execSignals": len(short_exec),
        "badBlockedSignals": len(short_bad_ctrl),
        "openCol": {
            "label": "次日开盘买入(全成交)",
            "stats": _agg_numeric([r["retLatest"] for r in short_open_active]),
            "withTStats": _agg_numeric([r["totalReturnWithT"] for r in short_open_active if r["totalReturnWithT"] is not None]),
            "byHorizon": {
                k: _agg_numeric([r["horizons"][k] for r in short_open_active if r["horizons"].get(k) is not None])
                for k in ("t1High", "t1", "t3", "t5")
            },
        },
        "pullbackCol": {
            "label": "回踩建议区间(buyHi)买入",
            "fillRate": round((len(short_pb_filled) / len(short_pb_pool)) * 100.0, 1) if short_pb_pool else None,
            "filledCount": len(short_pb_filled),
            "missedCount": len(short_pb_pool) - len(short_pb_filled),
            "stats": _agg_numeric([r["retAltLatest"] for r in short_pb_filled]),
            "byHorizon": {
                k: _agg_numeric([r["horizonsAlt"][k] for r in short_pb_filled if r["horizonsAlt"].get(k) is not None])
                for k in ("t1High", "t1", "t3", "t5")
            },
        },
        "tAlpha": {
            "triggeredCount": len(t_trig_list),
            "avgTAlpha": round(sum(r["tAlphaPct"] for r in short_open_active) / len(short_open_active), 2) if short_open_active else None,
            "tDayWinRate": round(
                (sum(r["tWinDays"] for r in short_open_active) / max(1, sum(r["tTriggeredDays"] for r in short_open_active))) * 100.0, 1
            ) if sum(r["tTriggeredDays"] for r in short_open_active) > 0 else None,
        },
        "badControlStats": _agg_numeric([r["retLatest"] for r in short_bad_active]),
    }

    # 3. 尾盘黑马总结
    tail_all = by_strat["tail"]
    tail_active = [r for r in tail_all if r["status"] == "active"]
    tail_rule_vals = [r["horizons"]["t1RuleExit"] for r in tail_active if r["horizons"].get("t1RuleExit") is not None]
    tail_tp_hits = sum(1 for r in tail_active if r["horizons"].get("hitTp1"))
    tail_summary = {
        "totalSignals": len(tail_all),
        "activeCount": len(tail_active),
        "pendingCount": len(tail_all) - len(tail_active),
        "t0DriftStats": _agg_numeric([r["horizons"]["t0Close"] for r in tail_all if r["horizons"].get("t0Close") is not None], -3.0),
        "t1OpenStats": _agg_numeric([r["horizons"]["t1Open"] for r in tail_active if r["horizons"].get("t1Open") is not None], -3.0),
        "t1HighStats": _agg_numeric([r["horizons"]["t1High"] for r in tail_active if r["horizons"].get("t1High") is not None], -3.0),
        "t1RuleStats": _agg_numeric(tail_rule_vals, -3.0),
        "tpHitRate": round((tail_tp_hits / len(tail_active)) * 100.0, 1) if tail_active else None,
        "byHorizon": {
            k: _agg_numeric([r["horizons"][k] for r in tail_active if r["horizons"].get(k) is not None], -5.0)
            for k in ("t1", "t2", "t3")
        },
    }

    # 4. 连板打板总结（已剔除 LOCKED 与 LATE，带总阀红/黄/绿灯对照）
    board_all = by_strat["board"]
    board_active = [r for r in board_all if r["status"] == "active"]
    board_ok = [r for r in board_active if r["env"] != "RED"]
    board_red = [r for r in board_active if r["env"] == "RED"]
    board_promo = [r for r in board_active if r["horizons"].get("promotedT1") is not None]
    promo_cnt = sum(1 for r in board_promo if r["horizons"].get("promotedT1"))
    board_summary = {
        "totalSignals": len(board_all),
        "activeCount": len(board_active),
        "pendingCount": len(board_all) - len(board_active),
        "lastExclude": last_exclude,
        "t1OpenStats": _agg_numeric([r["horizons"]["t1Open"] for r in board_active if r["horizons"].get("t1Open") is not None], -6.0),
        "t1CloseStats": _agg_numeric([r["horizons"]["t1"] for r in board_active if r["horizons"].get("t1") is not None], -6.0),
        "latestStats": _agg_numeric([r["retLatest"] for r in board_active if r["retLatest"] is not None], -6.0),
        "promoRateT1": round((promo_cnt / len(board_promo)) * 100.0, 1) if board_promo else None,
        "greenYellowStats": _agg_numeric([r["horizons"]["t1"] for r in board_ok if r["horizons"].get("t1") is not None], -6.0),
        "redControlStats": _agg_numeric([r["horizons"]["t1"] for r in board_red if r["horizons"].get("t1") is not None], -6.0),
        "byWindow": {
            bw: _agg_numeric([r["horizons"]["t1"] for r in board_active if r.get("buyWindow") == bw and r["horizons"].get("t1") is not None], -6.0)
            for bw in ("AUCTION", "RUSH", "RESEAL", "NORMAL")
        },
        "byHorizon": {
            k: _agg_numeric([r["horizons"][k] for r in board_active if r["horizons"].get(k) is not None], -6.0)
            for k in ("t1", "t2", "t3", "t5")
        },
    }

    return {
        "steady": steady_summary,
        "short": short_summary,
        "tail": tail_summary,
        "board": board_summary,
    }


async def get_strategy_performance(
    http_client: Optional[httpx.AsyncClient] = None,
    force_snapshot: bool = False,
) -> dict:
    """获取四维策略推荐胜率、收益节点矩阵与逐只信号明细（自动自 2026-11-10 起建档）。"""
    now_ts = time.monotonic()
    if force_snapshot or not os.path.exists(STRATEGY_LEDGER_FILE):
        await snapshot_strategies(http_client=http_client)
    else:
        cached = _PERF_CACHE.get("perf")
        if cached and cached[0] > now_ts:
            return cached[1]
        # 每日懒触发一次当日新产出检查，保证盘中/盘后自动把当天新出来的 plan / tail / board 纳入档案
        await snapshot_strategies(http_client=http_client)

    state = _load_ledger_sync()
    signals_map: Dict[str, dict] = state.get("signals", {})
    all_signals = list(signals_map.values())
    unique_codes = sorted({s["code"] for s in all_signals})

    bars_by_code: Dict[str, List[dict]] = {}
    if unique_codes:
        sem = asyncio.Semaphore(10)
        if http_client is not None:
            results = await asyncio.gather(
                *[_fetch_daily_bars(http_client, c, sem) for c in unique_codes],
                return_exceptions=True,
            )
        else:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(10.0),
                trust_env=False,
                headers={"User-Agent": "Mozilla/5.0"},
            ) as client:
                results = await asyncio.gather(
                    *[_fetch_daily_bars(client, c, sem) for c in unique_codes],
                    return_exceptions=True,
                )
        for c, res in zip(unique_codes, results):
            bars_by_code[c] = res if isinstance(res, list) else []

    evaluated = [
        _evaluate_signal_record(sig, bars_by_code.get(sig["code"], []))
        for sig in all_signals
    ]
    evaluated.sort(key=lambda x: (x["signalDate"], -(x.get("score") or 0), x["code"]), reverse=True)

    summaries = _build_strategy_summaries(evaluated, state.get("lastBoardExclude") or {})
    out = {
        "ok": True,
        "baselineDate": STRATEGY_BASELINE_DATE,
        "updatedAt": state.get("updatedAt", ""),
        "evaluatedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "feeRatePct": round(ROUND_TRIP_FEE * 100.0, 3),
        "totalSignals": len(evaluated),
        "summaries": summaries,
        "records": evaluated,
    }
    _PERF_CACHE["perf"] = (time.monotonic() + PERF_CACHE_TTL, out)
    return out
