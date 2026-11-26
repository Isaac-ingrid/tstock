import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

if "httpx" not in sys.modules:
    _httpx_stub = types.ModuleType("httpx")
    _httpx_stub.AsyncClient = object
    _httpx_stub.Response = object
    _httpx_stub.Timeout = lambda *a, **kw: None
    sys.modules["httpx"] = _httpx_stub

from backend import five_step, strategy_ledger


class TestFiveStepAndAttribution(unittest.TestCase):
    def test_lookup_pool_provenance_and_five_step_review(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            base = Path(tmpdir)
            (base / "ignition_latest.json").write_text(
                json.dumps(
                    {
                        "breakout": {
                            "items": [
                                {
                                    "code": "600519",
                                    "stageLabel": "🔥 震仓完成·待起爆",
                                    "ignitionScore": 91,
                                    "dragonStars": 4.5,
                                    "rs5d": 4.2,
                                    "entryModeLabel": "✅ 右侧阳线确认",
                                    "supportFloor": 1480.0,
                                }
                            ]
                        },
                        "dipLeaders": {"items": []},
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            (base / "latest.json").write_text(
                json.dumps(
                    {
                        "date": "2026-11-25",
                        "tail": [{"code": "600519", "score": 88, "stop": 1490.0, "tp1": 1560.0}],
                        "candidates": [{"code": "600519"}],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            (base / "strategy_ledger.json").write_text(
                json.dumps(
                    {
                        "signals": {
                            "ignition:2026-11-25:600519": {
                                "code": "600519",
                                "strategy": "ignition",
                                "signalDate": "2026-11-25",
                                "refPrice": 1500.0,
                                "verdict": "震仓起爆",
                                "manualPinned": True,
                                "manualRemoved": False,
                            }
                        }
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            prov = five_step.lookup_pool_provenance("600519", data_dir=base)
            self.assertTrue(prov["inBreakoutPool"])
            self.assertTrue(prov["inTailPool"])
            self.assertTrue(prov["inPreMarketPool"])
            self.assertTrue(prov["inTrackingPool"])
            self.assertEqual(len(prov["badges"]), 4)

            # 构造 40 根日K校验大盘下行期 RS 抗跌 + 右侧确认识别
            days = []
            px = 10.0
            for idx in range(40):
                d = f"2026-10-{(idx % 28) + 1:02d}"
                if idx == 30:
                    o, c, h, lo, v = px, round(px * 1.10, 2), round(px * 1.10, 2), px, 50000
                elif idx > 30 and idx < 39:
                    o, c, h, lo, v = px, round(px * 0.998, 2), round(px * 1.005, 2), round(px * 0.99, 2), 20000
                elif idx == 39:
                    o, c, h, lo, v = px, round(px * 1.028, 2), round(px * 1.032, 2), px, 26000
                else:
                    o, c, h, lo, v = px, round(px * 1.004, 2), round(px * 1.01, 2), round(px * 0.995, 2), 22000
                days.append({"date": d, "open": o, "close": c, "high": h, "low": lo, "vol": v, "turnover": 3.0})
                px = c

            review = five_step.build_five_step_review(
                code="600519",
                quote_data={"name": "贵州茅台", "price": px, "open": days[-1]["open"], "chg": 2.8, "cap": 200.0, "turnover": 3.0},
                days=days,
                chips_data={"ma5": round(px * 0.99, 2), "ma20": round(px * 0.96, 2)},
                technicals_data={"chg5d": 3.2},
                kline_patterns={},
                limitup_data={
                    "macroTiming": {"structure": "DOWNTREND", "structureLabel": "下跌结构", "anchorChg": -1.1, "anchorChg5d": -2.6},
                    "mainThemes": {"themes": [{"name": "大消费主线", "cycleStage": "MAIN_RISE", "cycleStageLabel": "🔥 主升期", "stocks": [{"code": "600519"}]}]},
                },
                market_sentiment={"riskValve": "YELLOW"},
                company_info={"industry": "酿酒行业"},
                all_concepts=["白酒"],
                matched_hot_themes=[],
                risk_level="安全",
                red_flags=[],
                yellow_alerts=[],
                data_dir=base,
            )
            self.assertEqual(review["step1Timing"]["regimeMode"], "BEAR_STRICT")
            self.assertTrue(review["step1Timing"]["isResilient"])
            self.assertTrue(review["step1Timing"]["rightSideConfirm"])
            self.assertTrue(review["step2MainTheme"]["isMainTheme"])
            self.assertTrue(review["step3Dragon"]["available"])

    def test_factor_attribution_stratifies_win_rate_and_alpha(self):
        evaluated = [
            {
                "id": "ignition:2026-11-18:000001",
                "strategy": "ignition",
                "status": "active",
                "env": "OK",
                "regimeMode": "BULL_NORMAL",
                "isMainTheme": True,
                "dragonStars": 4.5,
                "rightSideConfirm": True,
                "isResilient": True,
                "retLatest": 6.8,
                "horizons": {"t1": 2.4, "t3": 5.1, "t5": 6.8},
            },
            {
                "id": "tail:2026-11-19:000002",
                "strategy": "tail",
                "status": "active",
                "env": "WARN",
                "regimeMode": "RANGE_SELECTIVE",
                "isMainTheme": True,
                "dragonStars": 4.0,
                "rightSideConfirm": True,
                "isResilient": True,
                "retLatest": 3.2,
                "horizons": {"t1": 2.1, "t3": 3.2},
            },
            {
                "id": "ignition:2026-11-20:000003",
                "strategy": "ignition",
                "status": "active",
                "env": "BAD",
                "regimeMode": "BEAR_STRICT",
                "isMainTheme": False,
                "dragonStars": 3.0,
                "rightSideConfirm": False,
                "isResilient": False,
                "retLatest": -4.2,
                "horizons": {"t1": -1.8, "t3": -3.5, "t5": -4.2},
            },
            {
                "id": "short:2026-11-21:000004",
                "strategy": "short",
                "status": "active",
                "env": "RED",
                "regimeMode": "BEAR_STRICT",
                "isMainTheme": False,
                "dragonStars": 3.0,
                "rightSideConfirm": False,
                "isResilient": False,
                "retLatest": -2.6,
                "horizons": {"t1": -1.2, "t3": -2.6},
            },
        ]
        attr = strategy_ledger._build_factor_attribution(evaluated)
        self.assertEqual(attr["totalTacticalSignals"], 4)
        self.assertEqual(attr["settledTacticalSignals"], 4)
        self.assertEqual(len(attr["factors"]), 4)
        by_id = {f["id"]: f for f in attr["factors"]}
        self.assertEqual(by_id["macro_timing"]["status"], "verified")
        self.assertGreater(by_id["macro_timing"]["meanSpread"], 5.0)
        self.assertEqual(by_id["main_theme"]["posGroup"]["latest"]["winRate"], 100.0)
        self.assertEqual(by_id["dragon_quality"]["posGroup"]["latest"]["count"], 2)
        self.assertEqual(by_id["right_confirm"]["negGroup"]["latest"]["winRate"], 0.0)


if __name__ == "__main__":
    unittest.main()
