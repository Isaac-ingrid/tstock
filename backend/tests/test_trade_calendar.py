from __future__ import annotations

import asyncio
import datetime
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

if "httpx" not in sys.modules:
    try:
        import httpx  # noqa: F401
    except ModuleNotFoundError:
        _httpx_stub = types.ModuleType("httpx")
        _httpx_stub.AsyncClient = object  # type: ignore[attr-defined]
        _httpx_stub.Response = object  # type: ignore[attr-defined]
        _httpx_stub.Timeout = lambda *a, **kw: None  # type: ignore[attr-defined]
        sys.modules["httpx"] = _httpx_stub

from backend import trade_calendar as tc  # noqa: E402
from backend.coach import build_quant_rule_review  # noqa: E402
from backend.diagnosis import build_comprehensive_decision, build_wechat_summary  # noqa: E402


class TestBackendTradeCalendar(unittest.TestCase):
    def test_statutory_holidays_and_makeup_weekends(self) -> None:
        """验证 2025-2026 沪深北法定节假日休市标签，以及国务院周末调休补班日恒休市。"""
        holidays = [
            ("2025-01-01", "元旦休市"),
            ("2025-01-28", "春节休市"),
            ("2025-02-04", "春节休市"),
            ("2025-05-01", "劳动节休市"),
            ("2025-10-08", "国庆中秋休市"),
            ("2026-01-01", "元旦休市"),
            ("2026-01-02", "元旦休市"),
            ("2026-02-16", "春节休市"),
            ("2026-02-23", "春节休市"),
            ("2026-04-06", "清明节休市"),
            ("2026-05-01", "劳动节休市"),
            ("2026-05-05", "劳动节休市"),
            ("2026-06-19", "端午节休市"),
            ("2026-09-25", "中秋节休市"),
            ("2026-10-01", "国庆节休市"),
            ("2026-10-07", "国庆节休市"),
        ]
        for ds, expected_label in holidays:
            st = tc.get_trade_day_status(ds)
            self.assertFalse(st["isTradeDay"], f"{ds} 应判定为休市")
            self.assertTrue(st["isHoliday"], f"{ds} 应标记为法定节假日")
            self.assertEqual(st["label"], expected_label)

        makeup_weekends = [
            "2025-01-26", "2025-02-08", "2025-04-27", "2025-09-28", "2025-10-11",
            "2026-01-04", "2026-02-14", "2026-02-28", "2026-05-09", "2026-09-20", "2026-10-10",
        ]
        for ds in makeup_weekends:
            st = tc.get_trade_day_status(ds)
            self.assertFalse(st["isTradeDay"], f"调休补班周末 {ds} A股仍须休市")
            self.assertTrue(st["isWeekend"])
            self.assertEqual(st["label"], "周末休市")

    def test_cross_holiday_navigation_and_recent_trade_dates(self) -> None:
        """验证跨春节(9天)/国庆(7天)+中秋连休的前后交易日推导、交易日计数及周收官判定。"""
        self.assertEqual(tc.next_trade_day("2026-09-30"), "2026-10-08")
        self.assertEqual(tc.prev_trade_day("2026-10-08"), "2026-09-30")
        self.assertEqual(tc.latest_or_current_trade_day("2026-10-05"), "2026-09-30")
        self.assertEqual(tc.latest_or_current_trade_day("2026-10-08"), "2026-10-08")

        # 2026-10-08 往前取近 4 个真实交易日：自动跳过国庆(10.01-10.07)与中秋周末(09.25-09.27)
        recent4 = tc.recent_trade_dates(4, ref="2026-10-08", include_ref=False)
        self.assertEqual(recent4, ["2026-09-30", "2026-09-29", "2026-09-28", "2026-09-24"])

        # 跨春节 9 天长假 (2026-02-13 周五 -> 2026-02-24 周二)：真实交易日仅 2 天，而非自然日 12 天
        self.assertEqual(tc.count_trade_days_between("2026-02-13", "2026-02-24", inclusive=True), 2)
        self.assertEqual(tc.shift_trade_days("2026-02-13", 3, fmt="%Y%m%d"), "20260226")

        # 节前收官日判定
        self.assertTrue(tc.is_last_trade_day_of_week("2026-04-30"))
        self.assertTrue(tc.is_last_trade_day_of_week("2026-06-18"))
        self.assertTrue(tc.is_last_trade_day_of_week("2026-09-30"))
        self.assertFalse(tc.is_last_trade_day_of_week("2026-10-08"))
        self.assertTrue(tc.is_last_trade_day_of_week("2026-10-09"))

    def test_beijing_timezone_session_phases_and_learned_Persistence(self) -> None:
        """验证跨时区 UTC/美西时间向北京时间归一及 learnedClosedDates 热更新。"""
        # 美西周三晚 19:00 (-08:00) == 北京时间周四 2026-10-08 11:00 (节后首个交易日早盘连续竞价)
        us_west = datetime.timezone(datetime.timedelta(hours=-8))
        dt_open = datetime.datetime(2026, 10, 7, 19, 0, 0, tzinfo=us_west)
        snap_open = tc.get_market_calendar_snapshot(dt_open)
        self.assertEqual(snap_open["dateStr"], "2026-10-08")
        self.assertTrue(snap_open["isTradeDay"])
        self.assertEqual(snap_open["session"], "morning")
        self.assertTrue(snap_open["isTradingNow"])

        # 北京时间 2026-10-01 10:15 (国庆周四盘中时刻) -> 必须判定为休市，非盘中交易
        dt_holiday = datetime.datetime(2026, 10, 1, 2, 15, 0, tzinfo=datetime.timezone.utc)
        snap_hol = tc.get_market_calendar_snapshot(dt_holiday)
        self.assertFalse(snap_hol["isTradeDay"])
        self.assertFalse(snap_hol["isTradingNow"])
        self.assertEqual(snap_hol["label"], "国庆节休市")
        self.assertEqual(snap_hol["latestTradeDate"], "2026-09-30")
        self.assertEqual(snap_hol["nextTradeDate"], "2026-10-08")

        # 独立临时日历文件验证 learnedClosedDates 动态持久化
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_cal = Path(tmpdir) / "trade_calendar.json"
            tmp_cal.write_text(
                json.dumps({"holidayRanges": [], "learnedClosedDates": {}}, ensure_ascii=False),
                encoding="utf-8",
            )
            self.assertTrue(tc.is_trade_day("2028-01-03", calendar_path=tmp_cal))
            ok = tc.record_learned_closed_date("2028-01-03", "元旦休市", calendar_path=tmp_cal)
            self.assertTrue(ok)
            st_learned = tc.get_trade_day_status("2028-01-03", calendar_path=tmp_cal)
            self.assertFalse(st_learned["isTradeDay"])
            self.assertEqual(st_learned["label"], "元旦休市")

    def test_coach_and_diagnosis_holiday_integration(self) -> None:
        """验证复盘教练与全景诊断在节前收官日及法定节假日下的日历联动输出。"""
        sample_trades = [
            {
                "stock": "上海沿浦 (605128)",
                "track": "long_t",
                "dir": "正T",
                "buy": 17.10,
                "sell": 17.65,
                "qty": 500,
                "net": 265.0,
                "plan": "计划内",
                "mistakeTags": [],
            }
        ]
        # 1) 国庆前最后交易日 2026-09-30：自动锚定下一交易日 2026-10-08 并输出跨长假风控纪律
        res_pre = build_quant_rule_review(
            trades=sample_trades,
            date="2026-09-30",
            market_env={"level": "OK", "text": "节前温和缩量"},
        )
        self.assertEqual(res_pre["calendar"]["nextTradeDate"], "2026-10-08")
        self.assertEqual(res_pre["calendar"]["closedDaysAhead"], 7)
        self.assertIn("下一交易日 2026-10-08", res_pre["review"])
        self.assertIn("跨长假风控纪律", res_pre["review"])

        # 2) 节假日当天 2026-10-01 复盘：自动识别国庆节休市并归属最近交易日 2026-09-30
        res_hol = build_quant_rule_review(
            trades=sample_trades,
            date="2026-10-01",
            market_env={"level": "OK", "text": "休市复盘"},
        )
        self.assertFalse(res_hol["calendar"]["isTradeDay"])
        self.assertEqual(res_hol["calendar"]["latestTradeDate"], "2026-09-30")
        self.assertIn("国庆节休市", res_hol["review"])

        # 3) 全景诊断在法定节假日下输出明确休市说明与微信诊股头部状态行
        hol_cal = tc.get_market_calendar_snapshot("2026-10-02")
        dec = build_comprehensive_decision(
            quote={"price": 17.42, "pe": 20.0, "buyRatio": 52.0},
            chips={"boxPos": 35.0, "profitRatio": 45.0, "ma5": 17.5, "ma20": 17.8, "boxBot": 16.8, "boxTop": 18.6},
            technicals={"trendStatus": "均线交织整理", "rsi6": 48.0},
            intraday={"date": "20260930", "isToday": False, "vwap": 17.55, "amp": 2.4, "pattern": "[国庆节休市 20260930] 分时震荡"},
            second_wave={"stageTag": "normal"},
            sector_ecology={"role": "独立震荡", "sectorChg": 0.0},
            matched_hot_themes=[],
            red_flags=[],
            yellow_alerts=[],
            green_catalysts=[],
            market_sentiment={"riskValve": "GREEN", "brokenRate": 15.0},
            trade_calendar=hol_cal,
        )
        self.assertTrue(any("国庆节休市（下一交易日 2026-10-08）" in p for p in dec["riskPoints"]))
        wechat_txt = build_wechat_summary({
            "quote": {"name": "上海沿浦", "code": "605128", "price": 17.42, "chg": -1.2, "turnover": 2.5, "cap": 36.0},
            "tradeCalendar": hol_cal,
            "decision": dec,
            "riskLevel": "安全",
        })
        self.assertIn("国庆节休市", wechat_txt)
        self.assertIn("下一交易日 2026-10-08", wechat_txt)

    def test_strong_herd_recent_zt_days_skips_long_holidays(self) -> None:
        """验证节后首日（2026-10-08）探测近 3 个交易日涨停池时，直接跨过 7 天国庆假期命中 09-30/29/28。"""
        from backend import strong_herd

        queried_dates = []

        async def _fake_hist_zt(_client, d_str):
            queried_dates.append(d_str)
            return [{"c": "605128", "n": "上海沿浦", "lbc": 2}]

        async def _run():
            with patch.object(strong_herd, "_fetch_hist_zt_pool", side_effect=_fake_hist_zt):
                res = await strong_herd._fetch_recent_zt_days(object(), "20261008", max_valid_days=3)
                self.assertEqual([d for d, _ in res], ["20260930", "20260929", "20260928"])
                for d_q in queried_dates:
                    self.assertTrue(tc.is_trade_day(d_q), f"不应请求非交易日 {d_q}")

        asyncio.run(_run())


if __name__ == "__main__":
    unittest.main()
