from __future__ import annotations

import datetime
import sys
import types
import unittest

if "httpx" not in sys.modules:
    try:
        import httpx  # noqa: F401
    except ModuleNotFoundError:
        _httpx_stub = types.ModuleType("httpx")
        _httpx_stub.AsyncClient = object  # type: ignore[attr-defined]
        _httpx_stub.Timeout = object  # type: ignore[attr-defined]
        _httpx_stub.Response = object  # type: ignore[attr-defined]
        sys.modules["httpx"] = _httpx_stub

from backend.diagnosis import build_comprehensive_decision
from backend.strong_herd import _eval_herd_health
from backend.patterns import (
    analyze_kline_patterns,
    calc_atr_series,
    detect_gaps,
    is_one_word_limit_bar,
    normalize_bars,
)


def _make_bar(day_offset: int, o: float, c: float, h: float, lo: float, vol: float = 10000.0) -> dict:
    dt = datetime.date(2026, 7, 1) + datetime.timedelta(days=day_offset)
    return {
        "date": dt.isoformat(),
        "open": round(o, 2),
        "close": round(c, 2),
        "high": round(h, 2),
        "low": round(lo, 2),
        "vol": vol,
    }


def _make_base_trend(start_px: float, step: float, count: int, vol: float = 10000.0) -> list[dict]:
    bars = []
    px = start_px
    for i in range(count):
        o = px
        c = px + step
        h = max(o, c) + 0.08
        lo = min(o, c) - 0.08
        bars.append(_make_bar(i, o, c, h, lo, vol=vol))
        px = c
    return bars


class TestKlinePatterns(unittest.TestCase):
    def test_gap_state_machine_confirmed_3d_and_filled(self) -> None:
        # 构造 20 根平稳日K + 1 根向上跳空缺口 + 4 根未回补 K 线
        bars = _make_base_trend(10.0, 0.02, 20)
        # idx 20: 向上跳空（前高 ~10.48，当日低点 10.90）
        bars.append(_make_bar(20, 11.0, 11.2, 11.3, 10.9, vol=18000.0))
        for k in range(1, 5):
            bars.append(_make_bar(20 + k, 11.1, 11.25, 11.35, 11.05, vol=11000.0))

        atrs = calc_atr_series(bars, 14)
        gaps = detect_gaps(bars, atrs, code="600519")
        self.assertEqual(len(gaps), 1)
        self.assertEqual(gaps[0]["direction"], "up")
        self.assertFalse(gaps[0]["filled"])
        self.assertTrue(gaps[0]["confirmed3d"])

        # 再追加一根向下回补缺口的 K 线
        bars.append(_make_bar(25, 11.0, 10.4, 11.05, 10.35, vol=15000.0))
        atrs2 = calc_atr_series(bars, 14)
        gaps2 = detect_gaps(bars, atrs2, code="600519")
        self.assertTrue(gaps2[0]["filled"])
        self.assertFalse(gaps2[0]["confirmed3d"])

    def test_one_word_limit_up_filtered_from_gaps(self) -> None:
        bars = _make_base_trend(10.0, 0.0, 15)
        pc = bars[-1]["close"]
        zt_px = round(pc * 1.10, 2)
        # 一字涨停板 (open == close == high == low)
        one_word = _make_bar(15, zt_px, zt_px, zt_px, zt_px, vol=5000.0)
        self.assertTrue(is_one_word_limit_bar(one_word, pc, code="000001"))
        bars.append(one_word)
        atrs = calc_atr_series(bars, 14)
        gaps = detect_gaps(bars, atrs, code="000001")
        self.assertEqual(len(gaps), 0)

    def test_top_island_reversal_detected_and_vetoes_decision(self) -> None:
        # 上涨趋势至高位 (10 -> 15)
        bars = _make_base_trend(10.0, 0.12, 42)
        # idx 42: 左侧向上跳空缺口形成孤岛（3 天悬空）
        prev_h = bars[-1]["high"]
        island_base = round(prev_h + 0.80, 2)
        bars.append(_make_bar(42, island_base + 0.1, island_base + 0.3, island_base + 0.4, island_base, vol=20000.0))
        bars.append(_make_bar(43, island_base + 0.25, island_base + 0.2, island_base + 0.45, island_base + 0.05, vol=18000.0))
        bars.append(_make_bar(44, island_base + 0.15, island_base + 0.1, island_base + 0.35, island_base + 0.02, vol=16000.0))
        # idx 45: 右侧向下跳空缺口，高点严格低于孤岛最低价
        drop_h = round(island_base - 0.55, 2)
        bars.append(_make_bar(45, drop_h - 0.05, drop_h - 0.35, drop_h, drop_h - 0.45, vol=24000.0))

        res = analyze_kline_patterns(bars, code="600100")
        self.assertTrue(res["hasTopIsland"])
        self.assertFalse(res["hasBottomIsland"])
        self.assertTrue(any(p["code"] == "TOP_ISLAND" for p in res["vetoSignals"]))

        # 验证接入 diagnosis.build_comprehensive_decision 后直接触发 NO_BUY 一票否决
        decision = build_comprehensive_decision(
            quote={"price": drop_h - 0.35, "pe": 25.0, "buyRatio": 55.0},
            chips={"boxPos": 50.0, "profitRatio": 55.0, "ma5": drop_h, "ma20": drop_h - 0.5, "boxBot": drop_h - 1.0, "boxTop": island_base},
            technicals={"trendStatus": "多头主升排列", "isBullAlign": True, "rsi6": 52.0},
            intraday={"isToday": True, "patternType": "bull", "vwap": drop_h - 0.4, "vwapDiff": 0.5, "amp": 3.5},
            second_wave={"stageTag": "normal"},
            sector_ecology={"role": "板块同步中坚标的", "sectorChg": 1.2},
            matched_hot_themes=[{"name": "算力"}],
            red_flags=[],
            yellow_alerts=[],
            green_catalysts=[],
            market_sentiment={"riskValve": "GREEN", "brokenRate": 10.0},
            kline_patterns=res,
        )
        self.assertEqual(decision["canBuyLevel"], "NO_BUY")
        self.assertFalse(decision["isBuyPointNow"])
        self.assertIn("顶部岛形反转", decision["canBuyVerdict"])

    def test_bottom_island_reversal_requires_volume_and_low_position(self) -> None:
        # 下跌趋势至低位 (20 -> 13)
        bars = _make_base_trend(20.0, -0.16, 42, vol=10000.0)
        # idx 42: 左侧向下衰竭缺口形成底部孤岛（2 天）
        prev_l = bars[-1]["low"]
        island_top = round(prev_l - 0.70, 2)
        bars.append(_make_bar(42, island_top - 0.1, island_top - 0.25, island_top, island_top - 0.4, vol=9000.0))
        bars.append(_make_bar(43, island_top - 0.2, island_top - 0.1, island_top - 0.02, island_top - 0.35, vol=7000.0))
        # idx 44: 右侧向上突破缺口，缩量版本不应触发
        up_low = round(island_top + 0.55, 2)
        bars_low_vol = list(bars) + [_make_bar(44, up_low + 0.05, up_low + 0.35, up_low + 0.45, up_low, vol=10000.0)]
        res_low_vol = analyze_kline_patterns(bars_low_vol, code="000858")
        self.assertFalse(res_low_vol["hasBottomIsland"])

        # 放量 2.2 倍版本应精确触发底部岛形反转
        bars_high_vol = list(bars) + [_make_bar(44, up_low + 0.05, up_low + 0.45, up_low + 0.50, up_low, vol=22000.0)]
        res_high_vol = analyze_kline_patterns(bars_high_vol, code="000858")
        self.assertTrue(res_high_vol["hasBottomIsland"])
        self.assertTrue(any(p["code"] == "BOTTOM_ISLAND" for p in res_high_vol["bullSignals"]))

    def test_high_gravestone_and_bearish_engulfing_and_immortal_guide(self) -> None:
        # 1) 高位天量避雷针
        bars_gs = _make_base_trend(10.0, 0.10, 40, vol=10000.0)
        pc = bars_gs[-1]["close"]
        bars_gs.append(_make_bar(40, pc + 0.02, pc + 0.05, pc + 0.85, pc - 0.05, vol=22000.0))
        res_gs = analyze_kline_patterns(bars_gs, code="600000")
        self.assertTrue(res_gs["hasHighGravestone"])

        # 2) 高位放量阴包阳
        bars_be = _make_base_trend(10.0, 0.10, 40, vol=10000.0)
        pc2 = bars_be[-1]["close"]
        bars_be.append(_make_bar(40, pc2, pc2 + 0.30, pc2 + 0.35, pc2 - 0.05, vol=12000.0))
        bars_be.append(_make_bar(41, pc2 + 0.32, pc2 - 0.15, pc2 + 0.35, pc2 - 0.20, vol=22000.0))
        res_be = analyze_kline_patterns(bars_be, code="600000")
        self.assertTrue(res_be["hasBearishEngulfing"])

        # 3) 仙人指路：先拉再温和回调至中位，前日温和放量长上影试盘 + 次日不破前低收阳反包
        bars_ig = _make_base_trend(10.0, 0.10, 30, vol=10000.0)
        # 顶部更高点以保证试盘日分位 < 85%
        bars_ig.append(_make_bar(30, 13.0, 14.2, 14.5, 12.9, vol=12000.0))
        for k in range(1, 10):
            bars_ig.append(_make_bar(30 + k, 12.6, 12.65, 12.75, 12.5, vol=10000.0))
        # 前日试盘长上影（温和放量 1.5x）
        bars_ig.append(_make_bar(40, 12.65, 12.75, 13.30, 12.60, vol=15000.0))
        # 次日不破前低收阳反包
        bars_ig.append(_make_bar(41, 12.72, 13.05, 13.15, 12.68, vol=14000.0))
        res_ig = analyze_kline_patterns(bars_ig, code="600000")
        self.assertTrue(res_ig["hasImmortalGuide"])

    def test_list_format_compatibility(self) -> None:
        raw_list = [["2026-07-01", "10.0", "10.2", "10.3", "9.9", "12000"]]
        norm = normalize_bars(raw_list)
        self.assertEqual(len(norm), 1)
        self.assertAlmostEqual(norm[0]["close"], 10.2)

    def test_strong_herd_health_top_island_evict_and_gravestone_warning(self) -> None:
        # 1) 顶部岛形反转：尚未跌破MA20或回撤20%，也应提前触发抱团池淘汰
        bars = _make_base_trend(10.0, 0.12, 42)
        prev_h = bars[-1]["high"]
        island_base = round(prev_h + 0.80, 2)
        bars.append(_make_bar(42, island_base + 0.1, island_base + 0.3, island_base + 0.4, island_base, vol=20000.0))
        bars.append(_make_bar(43, island_base + 0.25, island_base + 0.2, island_base + 0.45, island_base + 0.05, vol=18000.0))
        drop_h = round(island_base - 0.55, 2)
        bars.append(_make_bar(44, drop_h - 0.05, drop_h - 0.30, drop_h, drop_h - 0.40, vol=24000.0))
        days_list = [[b["date"], b["open"], b["close"], b["high"], b["low"], b["vol"]] for b in bars]
        last_date = bars[-1]["date"].replace("-", "")
        h1 = _eval_herd_health(
            code="600100",
            cur_px=drop_h - 0.30,
            today_high=drop_h,
            chg=-4.0,
            days=days_list,
            actual_date=last_date,
            entry_date=bars[40]["date"].replace("-", ""),
            stored_peak=island_base + 0.45,
            pop_rank=15,
        )
        self.assertTrue(h1["evict"])
        self.assertIn("顶部岛形反转", h1["evictReason"])

        # 2) 高位天量避雷针：即便仍站稳均线，也应提前触发黄牌预警
        bars_gs = _make_base_trend(10.0, 0.10, 40, vol=10000.0)
        pc = bars_gs[-1]["close"]
        bars_gs.append(_make_bar(40, pc + 0.02, pc + 0.05, pc + 0.85, pc - 0.05, vol=22000.0))
        days_gs = [[b["date"], b["open"], b["close"], b["high"], b["low"], b["vol"]] for b in bars_gs]
        last_gs_date = bars_gs[-1]["date"].replace("-", "")
        h2 = _eval_herd_health(
            code="600000",
            cur_px=pc + 0.05,
            today_high=pc + 0.85,
            chg=0.4,
            days=days_gs,
            actual_date=last_gs_date,
            entry_date=bars_gs[38]["date"].replace("-", ""),
            stored_peak=pc + 0.85,
            pop_rank=10,
        )
        self.assertFalse(h2["evict"])
        self.assertEqual(h2["healthStatus"], "warning")
        self.assertIn("高位天量避雷针", h2["healthDesc"])


if __name__ == "__main__":
    unittest.main()
