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
    _aggregate_daily_bars,
    build_tencent_fqkline_payload,
    parse_em_klines,
    parse_tencent_fqkline_node,
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
        self.assertEqual(to_tcode("1.000001"), "sh000001")
        self.assertEqual(to_em_secid("600519"), "1.600519")
        self.assertEqual(to_em_secid("300750"), "0.300750")
        # 沪市核心指数 sh000001 / sh000688 必须保留沪市 1. 前缀，不能误判成深市 0.000001 平安银行
        self.assertEqual(to_em_secid("sh000001"), "1.000001")
        self.assertEqual(to_em_secid("sh000688"), "1.000688")
        self.assertEqual(to_em_secid("sz399006"), "0.399006")
        bars = parse_em_klines(["2025-12-01,10.0,10.5,10.8,9.9,12345,1234567,9.0,5.0,0.5,2.1"])
        self.assertEqual(len(bars), 1)
        self.assertAlmostEqual(bars[0]["close"], 10.5)
        self.assertAlmostEqual(bars[0]["pctChg"], 5.0)

        # 验证腾讯 fqkline 同构合成与双向解析闭环（兼容日/周/月及指数）
        payload = build_tencent_fqkline_payload("sh605128", "week", 20, bars)
        self.assertEqual(payload["code"], 0)
        node = payload["data"]["sh605128"]
        self.assertIn("qfqweek", node)
        self.assertIn("week", node)
        parsed_back = parse_tencent_fqkline_node(node, period="week")
        self.assertEqual(len(parsed_back), 1)
        self.assertAlmostEqual(parsed_back[0]["close"], 10.5)

        # 验证日线兜底源向周K/月K聚合
        d_bars = [
            _make_bar("2026-10-12", 10.0, 10.4, 10.6, 9.8, 1000.0),
            _make_bar("2026-10-13", 10.4, 10.8, 11.0, 10.2, 1500.0),
            _make_bar("2026-11-02", 11.0, 11.5, 11.7, 10.9, 2000.0),
        ]
        m_agg = _aggregate_daily_bars(d_bars, "month")
        self.assertEqual(len(m_agg), 2)
        self.assertAlmostEqual(m_agg[0]["open"], 10.0)
        self.assertAlmostEqual(m_agg[0]["close"], 10.8)
        self.assertAlmostEqual(m_agg[0]["high"], 11.0)
        self.assertAlmostEqual(m_agg[0]["low"], 9.8)
        self.assertAlmostEqual(m_agg[0]["vol"], 2500.0)

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


class TestIgnitionFreshnessAndSpeedPipeline(unittest.TestCase):
    def test_fast_snapshot_does_not_poison_live_cache_and_live_runs_parallel(self):
        import time as _time
        from unittest.mock import patch
        import backend.ignition as ign

        stale_disk = {
            "ok": True,
            "date": "2026-01-05",
            "scannedAt": "2026-01-05 15:05:00",
            "params": {
                "includeCyb": False,
                "lookbackDays": 20,
                "sectorDdMin": 30.0,
                "stockDdMin": 40.0,
            },
            "breakout": {"items": [{"code": "600977", "name": "中国电影", "price": 15.0, "chg": 1.0}], "stats": {}},
            "dipLeaders": {"items": [], "usRadar": [], "deepBoards": [], "stats": {}},
        }

        call_counts = {"breakout": 0, "dip": 0}

        async def _fake_breakout(client, include_cyb=False, lookback_days=20):
            call_counts["breakout"] += 1
            await asyncio.sleep(0.06)
            return {
                "items": [{"code": "600519", "name": "贵州茅台", "latestDate": "2026-11-23", "price": 1520.0, "chg": 2.3, "stage": "SHAKEOUT_READY"}],
                "stats": {"seedCount": 10},
            }

        async def _fake_dip(client, sector_dd_min=30.0, stock_dd_min=40.0, custom_us_mappings=None):
            call_counts["dip"] += 1
            await asyncio.sleep(0.06)
            return {
                "items": [{"code": "002594", "name": "比亚迪", "price": 268.0, "chg": 1.5}],
                "usRadar": [],
                "deepBoards": [],
                "stats": {},
            }

        async def _fake_quotes(client, codes):
            return {c: {"price": 16.66, "chg": 4.25} for c in codes}

        async def _fake_tracking(**kwargs):
            return {"ok": True, "summary": {"totalCount": 1}, "items": []}

        async def _run():
            await ign._RESULT_CACHE.clear()
            dummy_client = object()
            with (
                patch.object(ign, "load_saved_ignition", return_value=stale_disk),
                patch.object(ign, "scan_breakout_ignition", side_effect=_fake_breakout),
                patch.object(ign, "scan_dip_leaders", side_effect=_fake_dip),
                patch.object(ign, "_fetch_batch_quotes", side_effect=_fake_quotes),
                patch.object(ign, "get_ignition_tracking_pool", side_effect=_fake_tracking),
                patch.object(ign, "_save_latest_sync", side_effect=lambda payload: None),
                patch.object(ign, "latest_or_current_trade_day", return_value="2026-11-23"),
            ):
                # 1) fast_snapshot=True 返回本地快照并刷新现价，但标记 needsLiveRefresh=True 且不污染 _RESULT_CACHE
                snap = await ign.get_ignition_pool(fast_snapshot=True, http_client=dummy_client)
                self.assertTrue(snap["isSnapshot"])
                self.assertTrue(snap["needsLiveRefresh"])
                self.assertEqual(snap["breakout"]["items"][0]["price"], 16.66)
                self.assertEqual(call_counts["breakout"], 0)

                # 2) 默认调用（fast_snapshot=False）绝不被旧快照短路，而是并发跑方向一+方向二，且并发 Singleflight 只执行 1 次
                t0 = _time.monotonic()
                r1, r2 = await asyncio.gather(
                    ign.get_ignition_pool(force_refresh=False, fast_snapshot=False, http_client=dummy_client),
                    ign.get_ignition_pool(force_refresh=True, fast_snapshot=False, http_client=dummy_client),
                )
                elapsed = _time.monotonic() - t0
                # 若串行需 >= 0.12s，并发 gather 约 0.06s
                self.assertLess(elapsed, 0.11)
                self.assertEqual(call_counts["breakout"], 1)
                self.assertEqual(call_counts["dip"], 1)
                self.assertFalse(r1["isSnapshot"])
                self.assertFalse(r1["needsLiveRefresh"])
                self.assertEqual(r1["date"], "2026-11-23")
                self.assertEqual(r1["breakout"]["items"][0]["code"], "600519")
                self.assertEqual(r2["dipLeaders"]["items"][0]["code"], "002594")

        asyncio.run(_run())

    def test_kline_superslice_cache_and_board_circuit_breaker(self):
        import time as _time
        import backend.market_data as md

        bars_180 = [_make_bar(f"2026-01-{(i % 28) + 1:02d}", 10.0, 10.5, 10.8, 9.9, 5000.0) for i in range(180)]

        class _BoomClient:
            def __init__(self):
                self.calls = 0

            async def get(self, *args, **kwargs):
                self.calls += 1
                raise RuntimeError("upstream timeout")

        async def _run():
            await md._KLINE_CACHE.clear()
            await md._KLINE_SUPERSLICE_CACHE.clear()
            await md._KLINE_SUPERSLICE_CACHE.set(("1.600519", 101), (180, bars_180), ttl=300.0)

            client = _BoomClient()
            # 180 日缓存可直接切片服务 95 日请求，零网络调用
            sliced = await md.fetch_em_klines(client, "1.600519", klt=101, lmt=95, tcode_fallback="sh600519")
            self.assertEqual(len(sliced), 95)
            self.assertEqual(client.calls, 0)

            # 板块 90.BK* 在东财 push2his 熔断期内立即短路返回空，不再卡超时
            md._EM_HIS_COOLDOWN_UNTIL = _time.monotonic() + 60.0
            try:
                bk_bars = await md.fetch_em_klines(client, "90.BK0475", klt=101, lmt=180)
                self.assertEqual(bk_bars, [])
                self.assertEqual(client.calls, 0)
            finally:
                md._EM_HIS_COOLDOWN_UNTIL = 0.0

        asyncio.run(_run())

    def test_dip_leaders_falls_back_to_tencent_snapshot_when_eastmoney_blocked(self):
        import time as _time
        from unittest.mock import patch
        import backend.ignition as ign
        import backend.market_data as md

        # 构造一条从高点 40.0 回撤超过 45% 到 20.0 且量能枯竭的 60 日K线
        dip_bars = []
        for i in range(60):
            hi = 40.0 if i < 15 else 21.0
            cl = 38.0 if i < 15 else 20.0
            lo = 36.0 if i < 15 else 19.8
            vol = 10000.0 if i < 15 else 2200.0
            dip_bars.append(_make_bar(f"2026-06-{(i % 28) + 1:02d}", cl, cl, hi, lo, vol))

        fake_qq_snap = {
            "rows": [
                {"code": "603259", "tcode": "sh603259", "name": "药明康德", "hybk": "医疗服务", "price": 20.0, "chg": -1.2, "turnover": 2.4, "amount": 18e8, "mcap": 1500e8},
                {"code": "300759", "tcode": "sz300759", "name": "康龙化成", "hybk": "医疗服务", "price": 20.0, "chg": -1.8, "turnover": 2.1, "amount": 8e8, "mcap": 420e8},
                {"code": "603127", "tcode": "sh603127", "name": "昭衍新药", "hybk": "医疗服务", "price": 20.0, "chg": -2.0, "turnover": 1.9, "amount": 5e8, "mcap": 160e8},
            ],
            "upCount": 1200,
            "downCount": 3500,
            "flatCount": 100,
        }

        async def _fake_us(client, mappings):
            return [], {}

        async def _fake_boards(client):
            return []

        async def _fake_klines(*args, **kwargs):
            return dip_bars

        async def _run():
            md._EM_API_COOLDOWN_UNTIL = _time.monotonic() + 120.0
            try:
                with (
                    patch.object(ign, "_fetch_us_benchmarks", side_effect=_fake_us),
                    patch.object(ign, "_fetch_all_boards", side_effect=_fake_boards),
                    patch.object(ign, "fetch_tencent_market_snapshot", return_value=fake_qq_snap),
                    patch.object(ign, "_fetch_em_klines", side_effect=_fake_klines),
                ):
                    res = await ign.scan_dip_leaders(object(), sector_dd_min=30.0, stock_dd_min=40.0)
                    self.assertGreaterEqual(len(res["items"]), 1)
                    codes = [x["code"] for x in res["items"]]
                    self.assertIn("603259", codes)
            finally:
                md._EM_API_COOLDOWN_UNTIL = 0.0

        asyncio.run(_run())

    def test_bear_strict_regime_filters_weak_followers_and_honors_zero_survivors(self):
        from unittest.mock import patch
        import backend.ignition as ign
        import backend.limitup as lu

        strong_daily, strong_weekly, strong_monthly = _build_ignition_fixture()
        # 构造一只普通跟跌缩量股：涨停后量能仅缩至 ~78% (>65%) 且近5日跟随大盘回落
        weak_daily = [dict(b) for b in strong_daily[:-4]]
        zt_c = weak_daily[-1]["close"]
        weak_daily.append(_make_bar("2025-12-09", zt_c, round(zt_c * 0.985, 2), zt_c, round(zt_c * 0.98, 2), 28000.0))
        weak_daily.append(_make_bar("2025-12-10", round(zt_c * 0.985, 2), round(zt_c * 0.975, 2), round(zt_c * 0.99, 2), round(zt_c * 0.968, 2), 27500.0))
        weak_daily.append(_make_bar("2025-12-11", round(zt_c * 0.975, 2), round(zt_c * 0.965, 2), round(zt_c * 0.98, 2), round(zt_c * 0.958, 2), 27000.0))
        weak_daily.append(_make_bar("2025-12-12", round(zt_c * 0.965, 2), round(zt_c * 0.958, 2), round(zt_c * 0.97, 2), round(zt_c * 0.952, 2), 26800.0))

        async def _fake_zt_day(client, d_str, sem, today_compact=""):
            if d_str.endswith("08") or True:
                return d_str, [
                    {"c": "600519", "n": "强势活口", "hybk": "半导体", "lbc": 1, "p": 11.2},
                    {"c": "600001", "n": "跟跌杂毛", "hybk": "一般行业", "lbc": 1, "p": 10.8},
                ]

        async def _fake_quotes(client, codes):
            return {
                "600519": {"name": "强势活口", "price": strong_daily[-1]["close"], "chg": 1.45, "turnover": 4.2, "amount": 6e8, "mcap": 180e8},
                "600001": {"name": "跟跌杂毛", "price": weak_daily[-1]["close"], "chg": -1.80, "turnover": 3.1, "amount": 5e8, "mcap": 90e8},
            }

        async def _fake_klines(client, secid, klt, lmt, sem=None, tcode_fallback=None, ttl=300.0):
            is_strong = "600519" in secid
            if klt == 101:
                return strong_daily if is_strong else weak_daily
            if klt == 102:
                return strong_weekly
            return strong_monthly

        async def _fake_notices(client, codes, max_live=16, budget_sec=1.2):
            return [{"riskLevel": "安全", "redFlags": [], "yellowAlerts": []} for _ in codes]

        async def _fake_limitup_bear(http_client=None, **kwargs):
            return {
                "sentiment": {"riskValve": "RED"},
                "macroTiming": {
                    "structure": "DOWNTREND",
                    "structureLabel": "下跌结构",
                    "anchorChg": -1.35,
                    "anchorChg5d": -3.80,
                    "bottomDivergence": False,
                    "topDivergence": False,
                },
                "mainThemes": {
                    "themes": [{"name": "半导体", "cycleStage": "EARLY_START", "cycleStageLabel": "🌱 启动初期", "stocks": [{"code": "600519"}]}]
                },
            }

        async def _run():
            with (
                patch.object(ign, "_fetch_zt_pool_day", side_effect=_fake_zt_day),
                patch.object(ign, "_fetch_batch_quotes", side_effect=_fake_quotes),
                patch.object(ign, "_fetch_em_klines", side_effect=_fake_klines),
                patch.object(ign, "_batch_notice_fast", side_effect=_fake_notices),
                patch.object(lu, "get_limitup_pool", side_effect=_fake_limitup_bear),
            ):
                res = await ign.scan_breakout_ignition(object(), include_cyb=False, lookback_days=20)
                regime = res["stats"]["marketRegime"]
                self.assertEqual(regime["mode"], "BEAR_STRICT")
                # 初筛2只都过了常规月放量+周向上+日缩量(<88%)，但天时严选硬过滤剔除了跟跌杂毛 600001
                self.assertEqual(res["stats"]["rawQualifiedCount"], 2)
                self.assertEqual(res["stats"]["filteredOutCount"], 1)
                self.assertEqual(len(res["items"]), 1)
                survivor = res["items"][0]
                self.assertEqual(survivor["code"], "600519")
                self.assertTrue(survivor["isResilient"])
                self.assertTrue(survivor["rightSideConfirm"])
                self.assertEqual(survivor["entryMode"], "RIGHT_CONFIRMED")
                self.assertGreater(survivor["rs5d"], 2.5)

            # 验证若天时严选把候选全部淘汰为 0 只（但 seedCount > 0 代表非网络断联），绝不误回退旧落盘快照充数
            await ign._RESULT_CACHE.clear()
            with (
                patch.object(
                    ign,
                    "scan_breakout_ignition",
                    return_value={"items": [], "stats": {"seedCount": 42, "rawQualifiedCount": 5, "filteredOutCount": 5}},
                ),
                patch.object(ign, "scan_dip_leaders", return_value={"items": [], "usRadar": [], "deepBoards": [], "stats": {}}),
                patch.object(
                    ign,
                    "load_saved_ignition",
                    return_value={"breakout": {"items": [{"code": "000410", "name": "旧残留标的"}]}, "dipLeaders": {"items": []}},
                ),
                patch.object(ign, "get_ignition_tracking_pool", return_value={"ok": True, "summary": {}, "items": []}),
                patch.object(ign, "_save_latest_sync", side_effect=lambda p: None),
            ):
                pool_res = await ign.get_ignition_pool(force_refresh=True, http_client=object())
                self.assertFalse(pool_res["isSnapshot"])
                self.assertEqual(pool_res["breakout"]["items"], [])

        asyncio.run(_run())


if __name__ == "__main__":
    unittest.main()
