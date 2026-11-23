"""backend/trade_calendar.py

A股交易日历与盘中时段统一工具模块（与 data/trade_calendar.json、timing_task 及前端同源）：
1. 读取项目根目录 data/trade_calendar.json（带 mtime 热更新缓存与内置 2024-2026 权威兜底表）；
2. 严格遵循沪深北交易所规则：周六、周日恒休市（即使遇国务院调休补班日亦不开市）；
3. 统一以北京时间 (Asia/Shanghai, UTC+8) 归一计算日期与连续竞价窗口，消除跨时区偏差；
4. 提供复盘与诊断所需的上一/下一交易日、最近 N 个交易日序列、跨假期交易日计数及动态休市持久化。
"""

from __future__ import annotations

import datetime
import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CALENDAR_FILE = PROJECT_ROOT / "data" / "trade_calendar.json"
PUBLIC_CALENDAR_FILE = PROJECT_ROOT / "public" / "data" / "trade_calendar.json"

CN_TZ = datetime.timezone(datetime.timedelta(hours=8), name="Asia/Shanghai")

BUILTIN_HOLIDAY_RANGES: Tuple[Dict[str, str], ...] = (
    {"start": "2024-01-01", "end": "2024-01-01", "name": "元旦"},
    {"start": "2024-02-09", "end": "2024-02-17", "name": "春节"},
    {"start": "2024-04-04", "end": "2024-04-06", "name": "清明节"},
    {"start": "2024-05-01", "end": "2024-05-05", "name": "劳动节"},
    {"start": "2024-06-08", "end": "2024-06-10", "name": "端午节"},
    {"start": "2024-09-15", "end": "2024-09-17", "name": "中秋节"},
    {"start": "2024-10-01", "end": "2024-10-07", "name": "国庆节"},
    {"start": "2025-01-01", "end": "2025-01-01", "name": "元旦"},
    {"start": "2025-01-28", "end": "2025-02-04", "name": "春节"},
    {"start": "2025-04-04", "end": "2025-04-06", "name": "清明节"},
    {"start": "2025-05-01", "end": "2025-05-05", "name": "劳动节"},
    {"start": "2025-05-31", "end": "2025-06-02", "name": "端午节"},
    {"start": "2025-10-01", "end": "2025-10-08", "name": "国庆中秋"},
    {"start": "2026-01-01", "end": "2026-01-03", "name": "元旦"},
    {"start": "2026-02-15", "end": "2026-02-23", "name": "春节"},
    {"start": "2026-04-04", "end": "2026-04-06", "name": "清明节"},
    {"start": "2026-05-01", "end": "2026-05-05", "name": "劳动节"},
    {"start": "2026-06-19", "end": "2026-06-21", "name": "端午节"},
    {"start": "2026-09-25", "end": "2026-09-27", "name": "中秋节"},
    {"start": "2026-10-01", "end": "2026-10-07", "name": "国庆节"},
    {"start": "2027-01-01", "end": "2027-01-03", "name": "元旦"},
    {"start": "2027-02-05", "end": "2027-02-13", "name": "春节"},
    {"start": "2027-04-03", "end": "2027-04-05", "name": "清明节"},
    {"start": "2027-05-01", "end": "2027-05-05", "name": "劳动节"},
    {"start": "2027-06-09", "end": "2027-06-09", "name": "端午节"},
    {"start": "2027-09-15", "end": "2027-09-15", "name": "中秋节"},
    {"start": "2027-10-01", "end": "2027-10-07", "name": "国庆节"},
)

_CACHED_HOLIDAY_MAP: Optional[Dict[str, str]] = None
_CACHED_MTIME_NS: int = -1
_CACHED_PATH: Optional[Path] = None


def _expand_holiday_map(
    ranges: List[Dict[str, Any]],
    learned: Optional[Dict[str, Any]] = None,
) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for item in ranges or []:
        if not isinstance(item, dict):
            continue
        s_raw = str(item.get("start") or "").strip()[:10]
        e_raw = str(item.get("end") or "").strip()[:10]
        name = str(item.get("name") or "节假日").strip() or "节假日"
        try:
            cur = datetime.date.fromisoformat(s_raw)
            end = datetime.date.fromisoformat(e_raw)
        except ValueError:
            continue
        while cur <= end:
            out[cur.isoformat()] = name
            cur += datetime.timedelta(days=1)

    if isinstance(learned, dict):
        for ds, label in learned.items():
            clean = str(ds or "").strip()[:10]
            if re.match(r"^\d{4}-\d{2}-\d{2}$", clean) and label:
                out[clean] = str(label).strip()
    return out


def get_holiday_map(calendar_path: Optional[Path] = None) -> Dict[str, str]:
    """读取并缓存法定节假日与动态学习休市映射（YYYY-MM-DD -> 节假日名称）。"""
    global _CACHED_HOLIDAY_MAP, _CACHED_MTIME_NS, _CACHED_PATH
    target_path = Path(calendar_path) if calendar_path is not None else CALENDAR_FILE

    try:
        if target_path.exists():
            st_ns = target_path.stat().st_mtime_ns
            if (
                _CACHED_HOLIDAY_MAP is not None
                and _CACHED_PATH == target_path
                and st_ns == _CACHED_MTIME_NS
            ):
                return _CACHED_HOLIDAY_MAP

            raw = json.loads(target_path.read_text(encoding="utf-8"))
            merged_ranges = [*BUILTIN_HOLIDAY_RANGES, *(raw.get("holidayRanges") or [])]
            learned = raw.get("learnedClosedDates") or {}
            built = _expand_holiday_map(merged_ranges, learned)
            if calendar_path is None:
                _CACHED_HOLIDAY_MAP = built
                _CACHED_MTIME_NS = st_ns
                _CACHED_PATH = target_path
            return built
    except Exception:
        pass

    if _CACHED_HOLIDAY_MAP is None or calendar_path is not None:
        fallback = _expand_holiday_map(list(BUILTIN_HOLIDAY_RANGES), {})
        if calendar_path is None:
            _CACHED_HOLIDAY_MAP = fallback
            _CACHED_MTIME_NS = -1
            _CACHED_PATH = target_path
        return fallback
    return _CACHED_HOLIDAY_MAP


def cn_now(dt: Optional[datetime.datetime] = None) -> datetime.datetime:
    """获取当前或指定时刻对应的北京时间 (UTC+8) aware datetime。"""
    if dt is None:
        return datetime.datetime.now(CN_TZ)
    if dt.tzinfo is None:
        return dt.astimezone(CN_TZ)
    return dt.astimezone(CN_TZ)


def cn_now_str(fmt: str = "%Y-%m-%d %H:%M:%S", dt: Optional[datetime.datetime] = None) -> str:
    return cn_now(dt).strftime(fmt)


def parse_cn_date(val: Any = None) -> datetime.date:
    """将 None / datetime / date / 'YYYY-MM-DD' / 'YYYYMMDD' 统一解析为北京时间 date。"""
    if val is None:
        return cn_now().date()
    if isinstance(val, datetime.datetime):
        return cn_now(val).date()
    if isinstance(val, datetime.date):
        return val
    s = str(val).strip()
    if not s:
        return cn_now().date()
    digits = re.sub(r"\D", "", s)
    if len(s) >= 10 and s[4] == "-" and s[7] == "-":
        try:
            return datetime.date.fromisoformat(s[:10])
        except ValueError:
            pass
    if len(digits) >= 8:
        try:
            return datetime.date(int(digits[0:4]), int(digits[4:6]), int(digits[6:8]))
        except ValueError:
            pass
    return cn_now().date()


def cn_today(ref: Any = None) -> datetime.date:
    return parse_cn_date(ref)


def cn_today_iso(ref: Any = None) -> str:
    return parse_cn_date(ref).isoformat()


def cn_today_ymd(ref: Any = None) -> str:
    return parse_cn_date(ref).strftime("%Y%m%d")


def get_trade_day_status(
    val: Any = None,
    calendar_path: Optional[Path] = None,
) -> Dict[str, Any]:
    """查询指定日期是否为 A 股交易日及具体休市标签（与 JS getTradeDayStatus 字段对齐）。"""
    d = parse_cn_date(val)
    ds = d.isoformat()
    ymd = d.strftime("%Y%m%d")
    iso_wd = d.isoweekday()  # 1=Mon .. 7=Sun
    js_wd = 0 if iso_wd == 7 else iso_wd  # 0=Sun .. 6=Sat（对齐前端与 Node）
    is_weekend = iso_wd in (6, 7)

    hmap = get_holiday_map(calendar_path=calendar_path)
    holiday_name = hmap.get(ds)

    if holiday_name:
        clean_label = holiday_name if holiday_name.endswith("休市") else f"{holiday_name}休市"
        return {
            "dateStr": ds,
            "ymd": ymd,
            "weekday": js_wd,
            "isoWeekday": iso_wd,
            "isTradeDay": False,
            "isWeekend": is_weekend,
            "isHoliday": True,
            "holidayName": holiday_name,
            "label": clean_label,
        }

    if is_weekend:
        return {
            "dateStr": ds,
            "ymd": ymd,
            "weekday": js_wd,
            "isoWeekday": iso_wd,
            "isTradeDay": False,
            "isWeekend": True,
            "isHoliday": False,
            "holidayName": None,
            "label": "周末休市",
        }

    return {
        "dateStr": ds,
        "ymd": ymd,
        "weekday": js_wd,
        "isoWeekday": iso_wd,
        "isTradeDay": True,
        "isWeekend": False,
        "isHoliday": False,
        "holidayName": None,
        "label": "交易日",
    }


def is_trade_day(val: Any = None, calendar_path: Optional[Path] = None) -> bool:
    return bool(get_trade_day_status(val, calendar_path=calendar_path)["isTradeDay"])


def next_trade_day(
    val: Any = None,
    fmt: str = "%Y-%m-%d",
    calendar_path: Optional[Path] = None,
) -> str:
    """获取指定日期之后的下一个 A 股交易日。"""
    cur = parse_cn_date(val)
    for _ in range(45):
        cur += datetime.timedelta(days=1)
        if is_trade_day(cur, calendar_path=calendar_path):
            return cur.strftime(fmt)
    return cur.strftime(fmt)


def prev_trade_day(
    val: Any = None,
    fmt: str = "%Y-%m-%d",
    calendar_path: Optional[Path] = None,
) -> str:
    """获取指定日期之前的上一个 A 股交易日。"""
    cur = parse_cn_date(val)
    for _ in range(45):
        cur -= datetime.timedelta(days=1)
        if is_trade_day(cur, calendar_path=calendar_path):
            return cur.strftime(fmt)
    return cur.strftime(fmt)


def latest_or_current_trade_day(
    val: Any = None,
    fmt: str = "%Y-%m-%d",
    calendar_path: Optional[Path] = None,
) -> str:
    """若当日为交易日则返回当日，若为周末或法定节假日则回退至最近一个已开市交易日。"""
    cur = parse_cn_date(val)
    if is_trade_day(cur, calendar_path=calendar_path):
        return cur.strftime(fmt)
    return prev_trade_day(cur, fmt=fmt, calendar_path=calendar_path)


def recent_trade_dates(
    count: int,
    ref: Any = None,
    include_ref: bool = True,
    fmt: str = "%Y-%m-%d",
    calendar_path: Optional[Path] = None,
) -> List[str]:
    """按时间倒序生成最近 count 个真实 A 股交易日（自动跳过周末与长假，消除无效轮询）。"""
    if count <= 0:
        return []
    cur = parse_cn_date(ref)
    if not include_ref:
        cur -= datetime.timedelta(days=1)
    out: List[str] = []
    steps = 0
    while len(out) < count and steps < count * 5 + 45:
        if is_trade_day(cur, calendar_path=calendar_path):
            out.append(cur.strftime(fmt))
        cur -= datetime.timedelta(days=1)
        steps += 1
    return out


def shift_trade_days(
    val: Any,
    delta_trade_days: int,
    fmt: str = "%Y-%m-%d",
    calendar_path: Optional[Path] = None,
) -> str:
    """从指定日期向前或向后推算 N 个真实交易日（delta=0 时归一化到当日或最近交易日）。"""
    cur = parse_cn_date(val)
    if delta_trade_days == 0:
        return latest_or_current_trade_day(cur, fmt=fmt, calendar_path=calendar_path)
    step = 1 if delta_trade_days > 0 else -1
    remaining = abs(int(delta_trade_days))
    guard = 0
    while remaining > 0 and guard < remaining * 5 + 60:
        cur += datetime.timedelta(days=step)
        if is_trade_day(cur, calendar_path=calendar_path):
            remaining -= 1
        guard += 1
    return cur.strftime(fmt)


def count_trade_days_between(
    start_val: Any,
    end_val: Any,
    inclusive: bool = True,
    calendar_path: Optional[Path] = None,
) -> int:
    """统计两个日期之间的真实 A 股交易日天数（避免跨春节/国庆长假虚增跟踪天数）。"""
    d_start = parse_cn_date(start_val)
    d_end = parse_cn_date(end_val)
    if d_end < d_start:
        return 0
    cur = d_start if inclusive else (d_start + datetime.timedelta(days=1))
    cnt = 0
    while cur <= d_end:
        if is_trade_day(cur, calendar_path=calendar_path):
            cnt += 1
        cur += datetime.timedelta(days=1)
    return cnt


def is_last_trade_day_of_week(
    val: Any = None,
    calendar_path: Optional[Path] = None,
) -> bool:
    """判断是否为当周最后一个 A 股交易日（兼容周五遇法定节假日休市提前至周四/周三收官）。"""
    cur = parse_cn_date(val)
    if not is_trade_day(cur, calendar_path=calendar_path):
        return False
    nxt = datetime.date.fromisoformat(next_trade_day(cur, calendar_path=calendar_path))
    return (nxt - cur).days >= 3


def get_session_phase(
    dt: Optional[datetime.datetime] = None,
    calendar_path: Optional[Path] = None,
) -> Tuple[str, str, bool]:
    """返回北京时间当前时段枚举：(session, sessionLabel, isTradingNow)。"""
    now_cn = cn_now(dt)
    st = get_trade_day_status(now_cn.date(), calendar_path=calendar_path)
    if not st["isTradeDay"]:
        return "closed", st["label"], False

    mins = now_cn.hour * 60 + now_cn.minute
    if mins < 9 * 60 + 15:
        return "pre_open", "盘前待开盘", False
    if mins < 9 * 60 + 30:
        return "call_auction", "集合竞价", False
    if mins <= 11 * 60 + 30:
        return "morning", "早盘连续竞价", True
    if mins < 13 * 60:
        return "lunch_break", "午间休市", False
    if mins <= 15 * 60:
        return "afternoon", "午盘连续竞价", True
    return "post_close", "已收盘", False


def is_trading_session_now(
    dt: Optional[datetime.datetime] = None,
    include_auction: bool = False,
    calendar_path: Optional[Path] = None,
) -> bool:
    session, _, is_trading = get_session_phase(dt, calendar_path=calendar_path)
    if include_auction and session == "call_auction":
        return True
    return is_trading


def _inspect_closure_block_at(
    seed_closed_date: datetime.date,
    calendar_path: Optional[Path] = None,
) -> Optional[Dict[str, Any]]:
    """提取包含 seed_closed_date 的整段连续休市区间，并校验其中是否含法定节假日（合并相连周末、排除普通双休）。"""
    start = seed_closed_date
    end = seed_closed_date
    for _ in range(25):
        prev_d = start - datetime.timedelta(days=1)
        if not is_trade_day(prev_d, calendar_path=calendar_path):
            start = prev_d
        else:
            break
    for _ in range(25):
        next_d = end + datetime.timedelta(days=1)
        if not is_trade_day(next_d, calendar_path=calendar_path):
            end = next_d
        else:
            break

    hmap = get_holiday_map(calendar_path=calendar_path)
    holiday_name: Optional[str] = None
    cur = start
    while cur <= end:
        raw_name = hmap.get(cur.isoformat())
        if raw_name and not holiday_name:
            holiday_name = re.sub(r"休市$", "", str(raw_name).strip()) or "节假日"
        cur += datetime.timedelta(days=1)

    if not holiday_name:
        return None

    closed_days = (end - start).days + 1
    reopen_date = (end + datetime.timedelta(days=1)).isoformat()
    last_pre_td = (start - datetime.timedelta(days=1)).isoformat()
    return {
        "holidayName": holiday_name,
        "closureStart": start.isoformat(),
        "closureEnd": end.isoformat(),
        "closedDays": closed_days,
        "reopenDate": reopen_date,
        "lastPreHolidayTradeDate": last_pre_td,
        "isLongHoliday": closed_days >= 3,
    }


def get_upcoming_holiday_reminder(
    val: Any = None,
    lookahead_trade_days: int = 5,
    max_scan_days: int = 40,
    calendar_path: Optional[Path] = None,
) -> Optional[Dict[str, Any]]:
    """与前端 getUpcomingHolidayReminder 同构的节前法定节假日倒计时与连续长假（>=3天）控仓预警。"""
    lookahead = lookahead_trade_days if lookahead_trade_days and lookahead_trade_days > 0 else 5
    scan_limit = max_scan_days if max_scan_days and max_scan_days > 0 else 40
    today_d = parse_cn_date(val)
    today_iso = today_d.isoformat()

    scan_cursor = today_d
    if not is_trade_day(today_d, calendar_path=calendar_path):
        cur_block = _inspect_closure_block_at(today_d, calendar_path=calendar_path)
        if cur_block:
            end_d = datetime.date.fromisoformat(cur_block["closureEnd"])
            rem_closed = (end_d - today_d).days + 1
            max_pos = 30 if cur_block["closedDays"] >= 7 else 50
            pos_label = "≤3成" if cur_block["closedDays"] >= 7 else "3~5成"
            return {
                **cur_block,
                "today": today_iso,
                "phase": "in_holiday",
                "level": "in_holiday",
                "remainingTradeDays": 0,
                "remainingClosedDays": rem_closed,
                "isHighAlert": False,
                "suggestedMaxPosPct": max_pos,
                "posRangeLabel": pos_label,
                "chipText": f"🏮 {cur_block['holidayName']}休市中（连休{cur_block['closedDays']}天 · {cur_block['reopenDate'][5:]} 开市）",
                "headline": f"{cur_block['holidayName']}休市期（{cur_block['closureStart'][5:]} ~ {cur_block['closureEnd'][5:]} 共 {cur_block['closedDays']} 天）",
                "advice": f"A股将于 {cur_block['reopenDate']} 恢复交易，可趁休市复盘持仓筹码峰与节后竞价预案。",
            }
        while not is_trade_day(scan_cursor, calendar_path=calendar_path):
            scan_cursor += datetime.timedelta(days=1)

    trade_days_count = 0
    cursor = scan_cursor
    for _ in range(scan_limit):
        if is_trade_day(cursor, calendar_path=calendar_path):
            trade_days_count += 1
            if trade_days_count > lookahead:
                return None
            cursor += datetime.timedelta(days=1)
            continue

        block = _inspect_closure_block_at(cursor, calendar_path=calendar_path)
        if block:
            remaining_td = trade_days_count
            if remaining_td < 1 or remaining_td > lookahead:
                return None

            is_high_alert = bool(block["isLongHoliday"] and remaining_td <= 2)
            suggested_max_pct = 30 if block["closedDays"] >= 7 else 50
            pos_range_label = "≤3成" if block["closedDays"] >= 7 else "3~5成"

            level = "countdown"
            chip_text = f"📅 距{block['holidayName']}休市({block['closedDays']}天)剩 {remaining_td} 个交易日"
            if is_high_alert and remaining_td == 1:
                level = "imminent_1d"
                chip_text = f"🏮 {block['holidayName']}前最后 1 个交易日（连休{block['closedDays']}天 · 严控隔夜仓位）"
                headline = f"{block['holidayName']}长假收官日预警 · 明起连休 {block['closedDays']} 天（{block['closureStart'][5:]} ~ {block['closureEnd'][5:]}，{block['reopenDate'][5:]} 开市）"
                advice = (
                    f"今日新买入筹码受 T+1 限制将锁定跨越整个 {block['closedDays']} 天假期至 {block['reopenDate'][5:]} 才能卖出；"
                    f"建议将隔夜总仓位控制在 {pos_range_label}，日内优先逢冲高倒T锁利降仓，切忌尾盘重仓赌节后消息。"
                )
            elif is_high_alert and remaining_td == 2:
                level = "imminent_2d"
                chip_text = f"🏮 距{block['holidayName']}长假({block['closedDays']}天)仅剩 2 个交易日 · 节前取现控仓窗"
                headline = f"距{block['holidayName']}连续 {block['closedDays']} 天长假仅剩 2 个交易日（{block['closureStart'][5:]} ~ {block['closureEnd'][5:]} 休市，{block['reopenDate'][5:]} 开市）"
                advice = (
                    f"今日为节前资金取现最后卖出窗口，午后易出现避险兑现抛压；建议提前去弱留强、"
                    f"将隔夜仓位收敛至 {pos_range_label}，严控追高新开仓以规避跨假外围不确定性。"
                )
            else:
                headline = f"距{block['holidayName']}休市还有 {remaining_td} 个交易日（{block['closureStart'][5:]} ~ {block['closureEnd'][5:]} 休市 {block['closedDays']} 天）"
                advice = (
                    f"长假临近（{block['reopenDate'][5:]} 开市），可提前规划持仓做T降本与节前减仓节奏。"
                    if block["isLongHoliday"]
                    else f"单日休市（{block['reopenDate'][5:]} 恢复开市），留意节前一日下午流动性微幅收敛。"
                )

            return {
                **block,
                "today": today_iso,
                "phase": "pre_holiday_urgent" if is_high_alert else "pre_holiday_countdown",
                "level": level,
                "remainingTradeDays": remaining_td,
                "remainingClosedDays": block["closedDays"],
                "isHighAlert": is_high_alert,
                "suggestedMaxPosPct": suggested_max_pct,
                "posRangeLabel": pos_range_label,
                "chipText": chip_text,
                "headline": headline,
                "advice": advice,
            }

        while not is_trade_day(cursor, calendar_path=calendar_path):
            cursor += datetime.timedelta(days=1)

    return None


def get_market_calendar_snapshot(
    val: Any = None,
    calendar_path: Optional[Path] = None,
) -> Dict[str, Any]:
    """获取完整的交易日历与时段快照，供复盘教练、全景诊断与接口直出共用。"""
    has_clock = val is None or isinstance(val, datetime.datetime)
    now_cn = cn_now(val if isinstance(val, datetime.datetime) else None)
    target_date = now_cn.date() if has_clock else parse_cn_date(val)

    st = get_trade_day_status(target_date, calendar_path=calendar_path)
    nxt_iso = next_trade_day(target_date, calendar_path=calendar_path)
    prv_iso = prev_trade_day(target_date, calendar_path=calendar_path)
    latest_iso = st["dateStr"] if st["isTradeDay"] else prv_iso
    gap_days = max(1, (datetime.date.fromisoformat(nxt_iso) - target_date).days)
    upcoming_hol = get_upcoming_holiday_reminder(target_date, calendar_path=calendar_path)

    if has_clock and target_date == now_cn.date():
        session, session_label, is_trading_now = get_session_phase(now_cn, calendar_path=calendar_path)
        time_s = now_cn.strftime("%H:%M:%S")
    else:
        session = "post_close" if st["isTradeDay"] else "closed"
        session_label = "交易日" if st["isTradeDay"] else st["label"]
        is_trading_now = False
        time_s = ""

    return {
        **st,
        "timezone": "Asia/Shanghai",
        "timeStr": time_s,
        "session": session,
        "sessionLabel": session_label,
        "isTradingNow": is_trading_now,
        "latestTradeDate": latest_iso,
        "prevTradeDate": prv_iso,
        "nextTradeDate": nxt_iso,
        "gapDaysToNext": gap_days,
        "closedDaysAhead": max(0, gap_days - 1),
        "isPreHolidayLastDay": st["isTradeDay"] and gap_days >= 4,
        "isLastTradeDayOfWeek": is_last_trade_day_of_week(target_date, calendar_path=calendar_path),
        "upcomingHoliday": upcoming_hol,
    }


def record_learned_closed_date(
    date_str: str,
    reason: str = "法定节假日休市",
    calendar_path: Optional[Path] = None,
) -> bool:
    """将动态识别到的休市日原子写入 data/trade_calendar.json（及 public/data/ 副本）。"""
    global _CACHED_MTIME_NS
    clean = str(date_str or "").strip()[:10]
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", clean):
        return False

    target = Path(calendar_path) if calendar_path is not None else CALENDAR_FILE
    data: Dict[str, Any] = {
        "timezone": "Asia/Shanghai",
        "verifiedYears": [2024, 2025, 2026],
        "holidayRanges": list(BUILTIN_HOLIDAY_RANGES),
        "learnedClosedDates": {},
    }
    try:
        if target.exists():
            loaded = json.loads(target.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data = loaded
        learned = data.setdefault("learnedClosedDates", {})
        if learned.get(clean) == reason:
            return True
        learned[clean] = reason
        payload_txt = json.dumps(data, ensure_ascii=False, indent=2) + "\n"

        target.parent.mkdir(parents=True, exist_ok=True)
        tmp_target = target.with_suffix(".json.tmp")
        tmp_target.write_text(payload_txt, encoding="utf-8")
        os.replace(tmp_target, target)

        if calendar_path is None and PUBLIC_CALENDAR_FILE.parent.exists():
            tmp_pub = PUBLIC_CALENDAR_FILE.with_suffix(".json.tmp")
            tmp_pub.write_text(payload_txt, encoding="utf-8")
            os.replace(tmp_pub, PUBLIC_CALENDAR_FILE)

        if calendar_path is None:
            _CACHED_MTIME_NS = -1
        return True
    except Exception:
        return False
