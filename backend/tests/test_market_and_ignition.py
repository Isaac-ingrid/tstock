import asyncio
import datetime
import sys
import types
import unittest

# 本地离线环境若未安装 httpx，注入轻量桩模块以便直接运行单元测试
if "httpx" not in sys.modules:
    _httpx_stub = types.ModuleType("httpx")
    _httpx_stub.AsyncClient = object
    _httpx_stub.Response = object
    _httpx_stub.Timeout = lambda *a, **kw: None
    sys.modules["httpx"] = _httpx_stub

from backend.ignition import (  # noqa: E402
    _eval_daily_breakout_precheck,
    _eval_weekly_monthly,
    evaluate_ignition_six_dims,
)
from backend.market_data import (  # noqa: E402
    BoundedTTLCache,
    parse_em_klines,
    to_em_secid,
    to_tcode,
)


def _make_bar(date_str: str, o: float, c: float, h: float, lo: float, vol: float) -> dict:
    return {
        "date": date_str,
        "open": o,
        "close": c,
        "high": h,
        "low": lo,
        "vol": vol,
        "amount": vol * c * 100.0,
        "amp": ((h - lo) / max(1e-6, o)) * 100.0,
        "pctChg": None,
        "turnover": 3.5,
    }


def _build_ignition_fixture():
    """构造一组标准横盘试盘起爆日/周/月 K 线样例（横盘底座 -> 涨停试盘 -> 缩量下影震仓）。"""
    start_dt = datetime.date(2025, 11, 1)
    daily = []
    # 35 天横盘底座（价格在 10.0 ~ 10.4 窄幅波动）
    for i in range(35):
        d = (start_dt + datetime.timedelta(days=i)).isoformat()
        px = 10.0 + (i % 4) * 0.08
        daily.append(_make_bar(d, px - 0.05, px, px + 0.10, px - 0.12, 10000.0))

    # 第 36 天：首板试盘涨停（涨幅 ~10%，放量 35000）
    prev_c = daily[-1]["close"]
    zt_c = round(prev_c * 1.10, 2)
    daily.append(_make_bar("2025-12-08", prev_c, zt_c, zt_c, prev_c * 0.995, 35000.0))

    # 第 37~40 天：连续缩量洗盘回踩 + 第 39 天带下影震仓收回
    daily.append(_make_bar("2025-12-09", zt_c, round(zt_c * 0.985, 2), round(zt_c * 1.01, 2), round(zt_c * 0.975, 2), 20000.0))
    daily.append(_make_bar("2025-12-10", round(zt_c * 0.985, 2), round(zt_c * 0.975, 2), round(zt_c * 0.99, 2), round(zt_c * 0.965, 2), 16000.0))
    # 下影探底收回（最低触及均线附近，下影占振幅 > 45%）
    c39 = round(zt_c * 0.985, 2)
    daily.append(_make_bar("2025-12-11", round(c39 * 0.996, 2), c39, round(c39 * 1.008, 2), round(c39 * 0.935, 2), 13000.0))
    daily.append(_make_bar("2025-12-12", c39, round(c39 * 1.012, 2), round(c39 * 1.018, 2), round(c39 * 0.995, 2), 11000.0))

    # 12 周上升趋势周 K
    weekly = []
    for i in range(12):
        d = (datetime.date(2025, 9, 26) + datetime.timedelta(days=7 * i)).isoformat()
        c = round(9.2 + i * 0.18, 2)
        weekly.append(_make_bar(d, c - 0.1, c, c + 0.15, c - 0.20, 50000.0 + i * 3000.0))

    # 8 月放量月 K（近两月较前 5 月显著放量）
    monthly = []
    months = [
        "2025-05-30", "2025-06-30", "2025-07-31", "2025-08-29",
        "2025-09-30", "2025-10-31", "2025-11-28", "2025-12-12",
    ]
    for idx, d in enumerate(months):
        c = round(9.0 + idx * 0.25, 2)
        vol = 420000.0 if idx >= 6 else 180000.0
        monthly.append(_make_bar(d, c - 0.2, c, c + 0.4, c - 0.35, vol))

    return daily, weekly, monthly


class TestMarketData(unittest.TestCase):
    def test_code_converters_and_parse(self):
        self.assertEqual(to_tcode("600519"), "sh600519")
        self.assertEqual(to_tcode("000001"), "sz000001")
        self.assertEqual(to_em_secid("600519"), "1.600519")
        self.assertEqual(to_em_secid("300750"), "0.300750")
        bars = parse_em_klines(["2025-12-01,10.0,10.5,10.8,9.9,12345,1234567,9.0,5.0,0.5,2.1"])
        self.assertEqual(len(bars), 1)
        self.assertAlmostEqual(bars[0]["close"], 10.5)
        self.assertAlmostEqual(bars[0]["pctChg"], 5.0)

    def test_bounded_ttl_cache_lru_and_expiry(self):
        async def _run():
            cache = BoundedTTLCache(maxsize=3, default_ttl=5.0)
            await cache.set("k1", 1)
            await cache.set("k2", 2)
            await cache.set("k3", 3)
            # 访问 k1 使其刷新为最近使用，随后写入 k4 应淘汰最久未用的 k2
            self.assertEqual(await cache.get("k1"), 1)
            await cache.set("k4", 4)
            self.assertEqual(len(cache), 3)
            self.assertIsNone(await cache.get("k2"))
            self.assertEqual(await cache.get("k1"), 1)
            self.assertEqual(await cache.get("k3"), 3)
            self.assertEqual(await cache.get("k4"), 4)

            # TTL 过期自动失效
            await cache.set("short", "v", ttl=0.02)
            self.assertEqual(await cache.get("short"), "v")
            await asyncio.sleep(0.04)
            self.assertIsNone(await cache.get("short"))

        asyncio.run(_run())


class TestIgnitionUnifiedSixDims(unittest.TestCase):
    def test_scan_and_diagnose_share_identical_metrics(self):
        daily, weekly, monthly = _build_ignition_fixture()
        pre = _eval_daily_breakout_precheck("600519", daily, lookback_days=20)
        wm = _eval_weekly_monthly(daily, weekly, monthly)
        diag = evaluate_ignition_six_dims(
            "600519",
            daily,
            weekly,
            monthly,
            cur_price=daily[-1]["close"],
            day_chg=1.2,
            lookback_days=20,
            name="测试标的",
        )

        self.assertIsNotNone(pre)
        self.assertIsNotNone(wm)
        # 全市场扫描与单股体检核心口径必须完全一致
        self.assertEqual(pre["maSpreadPct"], diag["maSpreadPct"])
        self.assertEqual(pre["volShrinkPct"], diag["volShrinkPct"])
        self.assertEqual(pre["shakeoutSignals"], diag["shakeoutSignals"])
        self.assertEqual(wm["monthVolRatio"], diag["monthVolRatio"])
        self.assertIn("下影探底收回", diag["shakeoutSignals"])
        self.assertIn(diag["stage"], ("SHAKEOUT_READY", "CONVERGED_WAIT"))
        self.assertEqual(len(diag["checklist"]), 6)

    def test_top_island_vetoes_both_scan_and_diagnose(self):
        daily, weekly, monthly = _build_ignition_fixture()
        # 在末端注入高位向上跳空孤岛 + 向下跳空顶部岛形反转
        base_hi = daily[-1]["high"]
        daily.append(_make_bar("2025-12-15", round(base_hi + 0.80, 2), round(base_hi + 1.00, 2), round(base_hi + 1.20, 2), round(base_hi + 0.70, 2), 24000.0))
        daily.append(_make_bar("2025-12-16", round(base_hi + 0.90, 2), round(base_hi + 0.85, 2), round(base_hi + 1.15, 2), round(base_hi + 0.75, 2), 21000.0))
        daily.append(_make_bar("2025-12-17", round(base_hi + 0.20, 2), round(base_hi - 0.10, 2), round(base_hi + 0.25, 2), round(base_hi - 0.20, 2), 28000.0))

        pre = _eval_daily_breakout_precheck("600519", daily, lookback_days=20)
        diag = evaluate_ignition_six_dims(
            "600519",
            daily,
            weekly,
            monthly,
            cur_price=daily[-1]["close"],
            day_chg=-5.0,
            lookback_days=20,
            name="测试标的",
        )

        # 全市场扫描硬否决，单股体检同步降级为 BREAKDOWN_RISK 并透出顶部岛形反转
        self.assertIsNone(pre)
        self.assertTrue(diag["klinePatterns"]["hasTopIsland"])
        self.assertEqual(diag["stage"], "BREAKDOWN_RISK")
        ma_item = next(c for c in diag["checklist"] if c["id"] == "ma")
        self.assertIs(ma_item["passed"], False)


if __name__ == "__main__":
    unittest.main()
