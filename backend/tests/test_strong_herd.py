import unittest

from backend.strong_herd import _detect_mystic_clusters, parse_mystic_roots


class StrongHerdMysticClusterTests(unittest.TestCase):
    def test_mystic_clusters_include_concrete_leaders_details(self):
        zt_by_code = {
            "002553": {
                "code": "002553",
                "name": "南方轴承",
                "lbc": 3,
                "fbtSec": 93100,
                "hybk": "通用设备",
                "price": 18.66,
                "chg": 10.02,
            },
            "603166": {
                "code": "603166",
                "name": "福达股份",
                "lbc": 2,
                "fbtSec": 93500,
                "hybk": "汽车零部",
                "price": 12.10,
                "chg": 10.0,
            },
            "002703": {
                "code": "002703",
                "name": "浙江世宝",
                "lbc": 1,
                "fbtSec": 100500,
                "hybk": "汽车零部",
                "price": 14.50,
                "chg": 10.02,
            },
            "603319": {
                "code": "603319",
                "name": "湘油泵",
                "lbc": 1,
                "fbtSec": 101200,
                "hybk": "汽车零部",
                "price": 22.30,
                "chg": 9.96,
            },
            "002241": {
                "code": "002241",
                "name": "歌尔福盛",
                "lbc": 1,
                "fbtSec": 103000,
                "hybk": "消费电子",
                "price": 24.80,
                "chg": 10.0,
            },
        }
        roots = parse_mystic_roots("福,盛")
        clusters, code_map = _detect_mystic_clusters(zt_by_code, roots)

        fu_cluster = next((c for c in clusters if c["name"] == "福字辈"), None)
        self.assertIsNotNone(fu_cluster)
        self.assertEqual(fu_cluster["ztCount"], 2)
        self.assertIn("leaders", fu_cluster)
        self.assertEqual(len(fu_cluster["leaders"]), 2)
        self.assertEqual(fu_cluster["leaders"][0]["code"], "603166")
        self.assertEqual(fu_cluster["leaders"][0]["name"], "福达股份")
        self.assertEqual(fu_cluster["leaders"][0]["lbc"], 2)
        self.assertIn("002241", [x["code"] for x in fu_cluster["leaders"]])
        self.assertTrue(code_map["603166"]["isResonant"])


class LimitUpSingleflightAndFallbackTests(unittest.TestCase):
    def test_limitup_singleflight_parallel_fallback_and_stale_backup(self):
        import asyncio
        import sys
        import types
        from unittest.mock import patch

        if "httpx" not in sys.modules:
            _httpx_stub = types.ModuleType("httpx")
            _httpx_stub.AsyncClient = object
            _httpx_stub.Response = object
            _httpx_stub.Timeout = lambda *a, **kw: None
            sys.modules["httpx"] = _httpx_stub

        import backend.limitup as lu
        import backend.market_data as md

        class _FakeResp:
            def __init__(self, payload, status_code=200):
                self._payload = payload
                self.status_code = status_code
                self.text = "{}"

            def json(self):
                return self._payload

        class _FakeClient:
            def __init__(self):
                self.zt_calls = []
                self.fail_all = False

            async def get(self, url, **kwargs):
                assert kwargs.get("timeout") is not None and kwargs["timeout"] <= 3.0
                if self.fail_all:
                    raise RuntimeError("eastmoney temporary timeout")
                await asyncio.sleep(0.03)
                if "getTopicZTPool" in url:
                    d = url.split("date=")[-1][:8]
                    self.zt_calls.append(d)
                    if d == "20261123":
                        return _FakeResp({"rc": 0, "data": {"qdate": "20261123", "pool": []}})
                    if d == "20261120":
                        return _FakeResp({
                            "rc": 0,
                            "data": {
                                "qdate": "20261120",
                                "pool": [
                                    {
                                        "c": "600977",
                                        "n": "中国电影",
                                        "m": 1,
                                        "p": 15890,
                                        "zdp": 10.04,
                                        "amount": 9.5e8,
                                        "ltsz": 296e8,
                                        "hs": 6.2,
                                        "lbc": 2,
                                        "fbt": 93215,
                                        "lbt": 93215,
                                        "fund": 1.2e8,
                                        "zbc": 0,
                                        "hybk": "影视院线",
                                    }
                                ],
                            },
                        })
                    return _FakeResp({"rc": 0, "data": {"pool": []}})
                if "ulist.np/get" in url:
                    return _FakeResp({"data": {"diff": [{"f104": 1800, "f105": 1200, "f106": 90}]}})
                return _FakeResp({"rc": 0, "data": {"pool": [], "diff": [], "tc": 0}})

        async def _fake_herd(*args, **kwargs):
            return {
                "strongPool": [],
                "strongCount": 0,
                "herdPool": [],
                "herdCount": 0,
                "evictedPool": [],
                "evictedCount": 0,
                "mainThemes": {"marketOverview": {}, "themes": []},
                "mysticClusters": [],
                "mysticRootsUsed": [],
                "yesterdayStats": {},
            }

        async def _empty_qq_snap(*args, **kwargs):
            return {"rows": [], "upCount": 0, "downCount": 0, "flatCount": 0}

        async def _live_qq_snap(*args, **kwargs):
            return {
                "rows": [
                    {
                        "code": "600977",
                        "tcode": "sh600977",
                        "name": "中国电影",
                        "hybk": "影视院线",
                        "price": 15.89,
                        "prevClose": 14.45,
                        "open": 15.20,
                        "high": 15.89,
                        "low": 15.10,
                        "chg": 9.97,
                        "turnover": 6.2,
                        "amount": 9.5e8,
                        "mcap": 296e8,
                        "cmcap": 296e8,
                        "volRatio": 1.8,
                        "fund": 1.2e8,
                        "isZt": True,
                        "touchedZt": True,
                        "isDt": False,
                        "isOneWord": False,
                    }
                ],
                "upCount": 3100,
                "downCount": 1600,
                "flatCount": 120,
            }

        async def _fake_klines(*args, **kwargs):
            return [
                {"date": "2026-11-18", "open": 13.0, "close": 13.14, "high": 13.2, "low": 12.9, "vol": 1000},
                {"date": "2026-11-19", "open": 13.2, "close": 14.45, "high": 14.45, "low": 13.1, "vol": 1500},
                {"date": "2026-11-20", "open": 15.2, "close": 15.89, "high": 15.89, "low": 15.1, "vol": 1800},
            ]

        async def _run():
            await lu.invalidate_limitup_cache()
            md._EM_API_FAIL_COUNT = 0
            md._EM_API_COOLDOWN_UNTIL = 0.0
            client = _FakeClient()
            try:
                with (
                    patch.object(lu, "cn_today_ymd", return_value="20261123"),
                    patch.object(lu, "is_trade_day", return_value=True),
                    patch.object(lu, "recent_trade_dates", return_value=["20261123", "20261120", "20261119", "20261118"]),
                    patch.object(lu, "build_strong_herd_and_themes", side_effect=_fake_herd),
                ):
                    r1, r2 = await asyncio.gather(
                        lu.get_limitup_pool(http_client=client),
                        lu.get_limitup_pool(http_client=client),
                    )
                    self.assertEqual(r1["date"], "20261120")
                    self.assertEqual(r1["totalCount"], 1)
                    self.assertEqual(r2["totalCount"], 1)
                    self.assertEqual(client.zt_calls.count("20261123"), 1)

                    # 东财与腾讯均无数据时回退内存最近一次成功快照
                    lu._LIMITUP_CACHE.clear()
                    client.fail_all = True
                    with patch.object(lu, "fetch_tencent_market_snapshot", side_effect=_empty_qq_snap):
                        r3 = await lu.get_limitup_pool(http_client=client)
                        self.assertTrue(r3.get("fromStaleBackup"))
                        self.assertEqual(r3["totalCount"], 1)

                    # 东财全线被墙时，自动从腾讯全市场快照 + 14日K合成涨停连板天梯与涨跌家数
                    lu._LIMITUP_CACHE.clear()
                    lu._LIMITUP_STALE_BACKUP.clear()
                    with (
                        patch.object(lu, "fetch_tencent_market_snapshot", side_effect=_live_qq_snap),
                        patch.object(lu, "fetch_em_klines", side_effect=_fake_klines),
                    ):
                        r4 = await lu.get_limitup_pool(http_client=client)
                        self.assertEqual(r4.get("dataSource"), "tencent_realtime_fallback")
                        self.assertEqual(r4["totalCount"], 1)
                        self.assertEqual(r4["items"][0]["code"], "600977")
                        self.assertEqual(r4["items"][0]["lbc"], 2)
                        self.assertEqual(r4["sentiment"]["upCount"], 3100)
            finally:
                md._EM_API_FAIL_COUNT = 0
                md._EM_API_COOLDOWN_UNTIL = 0.0

        asyncio.run(_run())


if __name__ == "__main__":
    unittest.main()
