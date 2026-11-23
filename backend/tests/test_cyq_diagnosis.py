import asyncio
import datetime
import sys
import types
import unittest
from unittest.mock import patch

# 本地离线环境若未安装 httpx，注入轻量桩模块以便直接运行单元测试
if "httpx" not in sys.modules:
    _httpx_stub = types.ModuleType("httpx")
    _httpx_stub.AsyncClient = object
    _httpx_stub.Response = object
    _httpx_stub.Timeout = lambda *a, **kw: None
    sys.modules["httpx"] = _httpx_stub

from backend.diagnosis import (  # noqa: E402
    build_comprehensive_decision,
    build_wechat_summary,
    calc_cyq_chips,
    get_stock_diagnosis,
)


def _bar_dict(
    date_s: str,
    o: float,
    c: float,
    h: float,
    lo: float,
    vol: float,
    turnover: float = None,
    amount: float = 0.0,
) -> dict:
    return {
        "date": date_s,
        "open": o,
        "close": c,
        "high": h,
        "low": lo,
        "vol": vol,
        "amount": amount or (vol * c * 100.0),
        "turnover": turnover,
    }


class TestCyqChipDistribution(unittest.TestCase):
    def test_turnover_decay_washes_out_old_chips(self):
        """
        核心验证：早期在 ¥20.0 附近长期堆积筹码后，近期在 ¥10.0 附近连续高换手充分洗盘，
        210日换手衰减 CYQ 的平均成本与筹码主峰必须下移至 ¥10.x（旧版简单均量加权会严重高估在 ¥14+）。
        """
        start = datetime.date(2026, 1, 1)
        bars = []
        # 前 160 个交易日：在 19.6 ~ 20.4 温和换手（每日 2% 换手，量 20000 手）
        for i in range(160):
            d = (start + datetime.timedelta(days=i)).isoformat()
            bars.append(_bar_dict(d, 19.9, 20.0, 20.4, 19.6, vol=20000.0, turnover=2.0))

        # 最近 20 个交易日：跌至 9.8 ~ 10.2 底部区间并连续放巨量高换手（每日 15% 换手，量 150000 手）
        # (1 - 0.15)^20 ≈ 3.88%，意味着早期 ¥20 套牢筹码已有 96%+ 被充分换手沉淀到底部
        for j in range(20):
            d = (start + datetime.timedelta(days=160 + j)).isoformat()
            bars.append(_bar_dict(d, 9.95, 10.05, 10.20, 9.80, vol=150000.0, turnover=15.0))

        res = calc_cyq_chips(bars, cur_price=10.10, period=210)
        self.assertEqual(res["cyqDays"], 180)
        self.assertLess(res["avgCost"], 10.80, "高换手充分洗盘后，CYQ 平均成本应已下移贴近 10 元区")
        self.assertAlmostEqual(res["peakPrice"], 10.0, delta=0.35)
        self.assertGreater(res["profitRatio"], 55.0, "现价 10.10 高于底部密集峰中心，获利盘应过半")
        self.assertLess(res["concentration90"], 8.0, "筹码96%汇聚在 9.8~10.2，90%集中度应高度密集(<8%)")
        self.assertEqual(res["concentrationTag"], "tight")

    def test_low_turnover_retains_historical_trapped_peak(self):
        """
        对照验证：若跌至 ¥10.0 后极度缩量（每日仅 0.4% 换手），高位 ¥20.0 老筹码未挥发，
        CYQ 应准确反映出获利盘极低、筹码双峰发散（90%集中度很高）。
        """
        start = datetime.date(2026, 1, 1)
        bars = []
        for i in range(120):
            d = (start + datetime.timedelta(days=i)).isoformat()
            bars.append(_bar_dict(d, 19.8, 20.0, 20.3, 19.7, vol=40000.0, turnover=4.0))
        for j in range(20):
            d = (start + datetime.timedelta(days=120 + j)).isoformat()
            bars.append(_bar_dict(d, 9.95, 10.0, 10.15, 9.85, vol=4000.0, turnover=0.4))

        res = calc_cyq_chips(bars, cur_price=10.05, period=210)
        self.assertGreater(res["avgCost"], 18.0, "缩量阴跌未换手，高位套牢筹码仍在，均价应高于 18 元")
        self.assertLess(res["profitRatio"], 15.0, "现价 10.05 远低于 20 元主峰，获利盘应不足 15%")
        self.assertGreater(res["concentration90"], 25.0, "高低双峰跨度大，90%集中度应显著发散(>25%)")
        self.assertEqual(res["concentrationTag"], "dispersed")

    def test_tencent_list_bars_fallback_with_float_cap_and_edge_cases(self):
        """验证兼容腾讯无换手率 list 格式 K 线（通过流通市值反推换手率）及一字板零振幅边界。"""
        start = datetime.date(2026, 5, 1)
        # [date, open, close, high, low, vol] 格式，流通市值 50 亿，现价 10 元 => 流通盘 500 万手
        list_bars = []
        for i in range(30):
            d = (start + datetime.timedelta(days=i)).isoformat()
            # 每日 25 万手 => 约 5% 换手率
            list_bars.append([d, "9.90", "10.00", "10.20", "9.80", "250000"])
        # 追加一根一字涨停板（high == low == 11.00）
        list_bars.append(["2026-06-05", "11.00", "11.00", "11.00", "11.00", "50000"])

        res = calc_cyq_chips(list_bars, cur_price=11.00, float_cap_yi=55.0, latest_turnover_pct=1.0)
        self.assertEqual(res["cyqDays"], 31)
        self.assertGreaterEqual(res["profitRatio"], 95.0)
        self.assertLessEqual(res["cost70High"] - res["cost70Low"], res["cost90High"] - res["cost90Low"] + 1e-6)
        self.assertLessEqual(res["concentration70"], res["concentration90"] + 1e-6)

        # 全程一字横盘零振幅极端边界不除零
        flat_bars = [["2026-06-01", "5.00", "5.00", "5.00", "5.00", "10000"] for _ in range(20)]
        flat_res = calc_cyq_chips(flat_bars, cur_price=5.00)
        self.assertEqual(flat_res["avgCost"], 5.00)
        self.assertEqual(flat_res["concentration90"], 0.0)

    def test_decision_and_diagnosis_pipeline_integration(self):
        """验证 build_comprehensive_decision、build_wechat_summary 与 get_stock_diagnosis 全链路输出新 CYQ 字段。"""
        start = datetime.date(2026, 2, 1)
        mock_days = []
        for i in range(215):
            d = (start + datetime.timedelta(days=i)).isoformat()
            px = round(12.0 + (i % 5) * 0.06, 2)
            mock_days.append(_bar_dict(d, px - 0.05, px, px + 0.12, px - 0.10, vol=30000.0, turnover=3.2))

        class _FakeResp:
            def __init__(self, status_code=200, text="", json_data=None):
                self.status_code = status_code
                self.text = text
                self._json = json_data or {}

            def json(self):
                return self._json

        # 构造 50+ 字段腾讯实时行情串
        q_parts = ["0"] * 52
        q_parts[1] = "测试股份"
        q_parts[2] = "600001"
        q_parts[3] = "12.25"
        q_parts[4] = "12.10"
        q_parts[5] = "12.12"
        q_parts[7] = "18000"
        q_parts[8] = "12000"
        q_parts[32] = "1.24"
        q_parts[33] = "12.35"
        q_parts[34] = "12.05"
        q_parts[37] = "36000"
        q_parts[38] = "3.50"
        q_parts[39] = "22.5"
        q_parts[44] = "100.0"
        q_parts[45] = "100.0"
        q_parts[46] = "2.1"
        q_parts[49] = "1.25"
        q_text = "v_sh600001=\"" + "~".join(q_parts) + "\";"

        class _FakeClient:
            async def get(self, url, **kwargs):
                if "qt.gtimg.cn" in url:
                    return _FakeResp(200, text=q_text)
                return _FakeResp(200, text="{}", json_data={})

            async def aclose(self):
                return None

        async def _fake_kline_days(client, tcode, em_secid, limit=210):
            return mock_days[-limit:]

        async def _fake_limitup(http_client=None):
            return {"ok": True, "sentiment": {"riskValve": "GREEN", "valveLabel": "绿灯进攻", "brokenRate": 18.0}}

        async def _run():
            with patch("backend.diagnosis._fetch_diag_kline_days", side_effect=_fake_kline_days), patch(
                "backend.diagnosis.get_limitup_pool", side_effect=_fake_limitup
            ):
                diag = await get_stock_diagnosis("600001", http_client=_FakeClient())
                self.assertTrue(diag["ok"])
                chips = diag["chips"]
                self.assertEqual(chips["cyqDays"], 210)
                self.assertIn("concentration90", chips)
                self.assertIn("concentration70", chips)
                self.assertIn("peakPrice", chips)
                self.assertIn("cyqProfile", chips)
                self.assertEqual(len(chips["cyqProfile"]), 44)
                prof_pct_sum = sum(item["pct"] for item in chips["cyqProfile"])
                self.assertAlmostEqual(prof_pct_sum, 100.0, delta=0.15)
                prof_prices = [item["p"] for item in chips["cyqProfile"]]
                self.assertEqual(prof_prices, sorted(prof_prices))
                self.assertLess(chips["concentration90"], 5.0)
                self.assertIn("90%成本区间", diag["wechatSummary"])
                dec = build_comprehensive_decision(
                    quote=diag["quote"],
                    chips=chips,
                    technicals=diag["technicals"],
                    intraday=diag["intraday"],
                    second_wave=diag["secondWave"],
                    sector_ecology=diag["sectorEcology"],
                    matched_hot_themes=[],
                    red_flags=[],
                    yellow_alerts=[],
                    green_catalysts=[],
                    market_sentiment={"riskValve": "GREEN", "brokenRate": 15.0},
                )
                self.assertTrue(any("CYQ 筹码高度集中" in pt for pt in dec["positivePoints"]))
                summary_txt = build_wechat_summary(diag)
                self.assertIn("CYQ筹码均价", summary_txt)

        asyncio.run(_run())


if __name__ == "__main__":
    unittest.main()
