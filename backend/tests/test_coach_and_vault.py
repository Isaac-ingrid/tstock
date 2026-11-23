from __future__ import annotations

import os
import tempfile
import unittest
from unittest.mock import patch

from backend.coach import build_quant_rule_review, generate_coach_review
from backend.user_vault import load_user_vault, save_user_vault


class TestCoachAndUserVault(unittest.IsolatedAsyncioTestCase):
    def test_user_vault_atomic_save_backup_and_guard(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            # 初始为空状态
            empty = load_user_vault(data_dir=tmpdir)
            self.assertTrue(empty["ok"])
            self.assertFalse(empty["exists"])

            # 写入真实持仓与成交流水（带下划线临时缓存字段应被自动剥离）
            res = save_user_vault(
                payload={
                    "pool": [
                        {
                            "code": "605128",
                            "name": "上海沿浦",
                            "shares": 1000,
                            "cost": 28.5,
                            "_k": {"day": [1, 2, 3]},
                            "_rtPts": [1, 2],
                        }
                    ],
                    "logs": [
                        {
                            "id": 101,
                            "date": "2026-04-17",
                            "stock": "上海沿浦 (605128)",
                            "dir": "正T",
                            "buy": 28.1,
                            "sell": 28.9,
                            "qty": 500,
                            "net": 384.0,
                        }
                    ],
                    "tailActives": [],
                    "snapshots": [{"date": "2026-04-17", "total": 102500}],
                    "posRules": {"maxTotalPct": 80, "maxConsecLosses": 2},
                    "initialCapital": 100000,
                    "availableCash": 73600,
                },
                data_dir=tmpdir,
            )
            self.assertTrue(res["ok"])
            self.assertFalse(res["guarded"])
            self.assertEqual(res["summary"]["logCount"], 1)
            self.assertGreaterEqual(len(res["backups"]), 1)

            loaded = load_user_vault(data_dir=tmpdir)
            self.assertTrue(loaded["exists"])
            self.assertNotIn("_k", loaded["vault"]["pool"][0])
            self.assertEqual(loaded["vault"]["availableCash"], 73600.0)

            # 模拟浏览器缓存清空后发送默认空白状态：应触发防误删保护，不覆盖磁盘真实台账
            guarded = save_user_vault(
                payload={
                    "pool": [{"code": "605128", "name": "上海沿浦", "shares": 1000, "cost": 28.5}],
                    "logs": [],
                    "tailActives": [],
                    "snapshots": [],
                    "initialCapital": 100000,
                    "availableCash": 71500,
                },
                force=False,
                data_dir=tmpdir,
            )
            self.assertFalse(guarded["ok"])
            self.assertTrue(guarded["guarded"])
            self.assertEqual(guarded["existingSummary"]["logCount"], 1)

            # 强制覆盖开关 force=True 时允许更新
            forced = save_user_vault(
                payload={
                    "pool": [{"code": "605128", "name": "上海沿浦", "shares": 1000, "cost": 28.5}],
                    "logs": [],
                    "tailActives": [],
                    "snapshots": [],
                    "initialCapital": 100000,
                    "availableCash": 71500,
                },
                force=True,
                data_dir=tmpdir,
            )
            self.assertTrue(forced["ok"])
            self.assertFalse(forced["guarded"])
            self.assertEqual(forced["summary"]["logCount"], 0)

    async def test_quant_rule_coach_without_api_key(self) -> None:
        trades = [
            {
                "stock": "上海沿浦 (605128)",
                "track": "long_t",
                "dir": "正T",
                "buy": 29.2,
                "sell": 28.5,
                "qty": 500,
                "net": -366.0,
                "plan": "计划外",
                "mistakeTags": ["fomo_chase", "no_stoploss"],
                "buyDevPct": 2.45,
                "systemBenchmark": {
                    "sysBuy": 28.5,
                    "sysSell1": 29.3,
                    "sysStop": 28.05,
                    "sysNet": 384.0,
                },
            },
            {
                "stock": "东山精密 (002384)",
                "track": "long_t",
                "dir": "正T",
                "buy": 21.0,
                "sell": 21.65,
                "qty": 600,
                "net": 376.0,
                "plan": "计划内",
                "mistakeTags": [],
                "buyDevPct": -0.1,
                "systemBenchmark": {
                    "sysBuy": 21.02,
                    "sysSell1": 21.6,
                    "sysStop": 20.7,
                    "sysNet": 334.0,
                },
            },
        ]
        with patch.dict(
            os.environ,
            {"AI_COACH_API_KEY": "", "TIANYI_API_KEY": "", "OPENAI_API_KEY": ""},
            clear=False,
        ):
            res = await generate_coach_review(
                trades=trades,
                date="2026-04-17",
                market_env={"level": "WARN", "text": "指数跌回MA20下方"},
                user_notes="早盘追高一笔很痛，下午耐心等回踩挽回。",
                api_key="",
                mode="auto",
            )
        self.assertTrue(res["ok"])
        self.assertEqual(res["engine"], "quant_rule")
        self.assertLess(res["disciplineScore"], 95)
        self.assertGreater(res["frictionLoss"], 700.0)
        self.assertIn("一句话犀利定性", res["review"])
        self.assertIn("明日必须坚守的实战行动清单", res["review"])

    def test_high_discipline_winning_day(self) -> None:
        res = build_quant_rule_review(
            trades=[
                {
                    "stock": "中际旭创 (300308)",
                    "track": "long_t",
                    "dir": "正T",
                    "buy": 110.0,
                    "sell": 113.5,
                    "qty": 300,
                    "net": 1012.0,
                    "plan": "计划内",
                    "mistakeTags": [],
                    "buyDevPct": -0.18,
                    "systemBenchmark": {
                        "sysBuy": 110.2,
                        "sysSell1": 113.2,
                        "sysStop": 108.5,
                        "sysNet": 862.0,
                    },
                }
            ],
            date="2026-04-17",
            market_env={"level": "OK", "text": "多头环境"},
        )
        self.assertGreaterEqual(res["disciplineScore"], 95)
        self.assertEqual(res["frictionLoss"], 0.0)
        self.assertIn("上升通道", res["review"])

    def test_down_channel_averaging_down_and_3red_audit(self) -> None:
        res = build_quant_rule_review(
            trades=[
                {
                    "stock": "招商轮船 (601872)",
                    "track": "short_swing",
                    "dir": "买入加仓",
                    "buy": 7.20,
                    "sell": 0.0,
                    "qty": 2000,
                    "net": -5.0,
                    "plan": "计划外",
                    "holdingFloatPct": -6.8,
                    "mistakeTags": ["backrow_laggard"],
                },
                {
                    "stock": "某连涨股 (002582)",
                    "track": "short_swing",
                    "dir": "买入加仓",
                    "buy": 10.5,
                    "sell": 0.0,
                    "qty": 1000,
                    "net": -5.0,
                    "plan": "计划外",
                    "redStreak": 3,
                    "mistakeTags": [],
                },
            ],
            date="2026-11-19",
            market_env={"level": "BAD", "text": "双指数破位下跌通道"},
        )
        self.assertTrue(res["ok"])
        self.assertLess(res["disciplineScore"], 60)
        self.assertIn("下跌通道浮亏死补", res["review"])
        self.assertIn("弱势连红三日贪婪不减", res["review"])
        self.assertIn("不存在踏空", res["review"])

    def test_pre_holiday_overcap_discipline_closed_loop(self) -> None:
        """验证连续≥3天长假前1-2个交易日超上限建仓的自动捕获、扣分、心魔剖析与SOP闭环。"""
        from backend.trade_calendar import get_upcoming_holiday_reminder

        # 1) 校验后端 get_upcoming_holiday_reminder 与前端同构一致
        r_2d = get_upcoming_holiday_reminder("2026-09-29")
        self.assertIsNotNone(r_2d)
        assert r_2d is not None
        self.assertTrue(r_2d["isHighAlert"])
        self.assertEqual(r_2d["closedDays"], 7)
        self.assertEqual(r_2d["remainingTradeDays"], 2)
        self.assertEqual(r_2d["suggestedMaxPosPct"], 30)

        r_short_1d = get_upcoming_holiday_reminder("2027-06-08")
        self.assertIsNotNone(r_short_1d)
        assert r_short_1d is not None
        self.assertEqual(r_short_1d["closedDays"], 1)
        self.assertFalse(r_short_1d["isHighAlert"])

        # 2) 国庆前2日 (2026-09-29)：上游未预打标签但买后仓位 42% > 30% -> 后端自动捕获并输出明日节前收官降仓SOP
        res_2d = build_quant_rule_review(
            trades=[
                {
                    "stock": "上海沿浦 (605128)",
                    "track": "long_t",
                    "dir": "买入加仓",
                    "buy": 25.0,
                    "sell": 0.0,
                    "qty": 1200,
                    "net": 0.0,
                    "plan": "计划内",
                    "postBuyPosPct": 42.0,
                    "mistakeTags": [],
                }
            ],
            date="2026-09-29",
            market_env={"level": "OK", "text": "节前缩量震荡"},
        )
        self.assertEqual(res_2d["preHolidayOvercapCount"], 1)
        self.assertLessEqual(res_2d["subScores"]["env"], 14)
        self.assertLessEqual(res_2d["subScores"]["stop"], 23)
        self.assertIn("🏮 节前长假超限建仓", res_2d["review"])
        self.assertIn("节前重仓博弈心魔", res_2d["review"])
        self.assertIn("跨长假节前降仓铁律", res_2d["review"])
        self.assertIn("2026-09-30", res_2d["review"])

        # 3) 国庆前最后1日 (2026-09-30)：前端已打标 pre_holiday_overcap 的尾盘潜伏单 -> 输出跨假T+1锁仓至 2026-10-08 与节后减仓SOP
        res_1d = build_quant_rule_review(
            trades=[
                {
                    "stock": "东山精密 (002384)",
                    "track": "short_swing",
                    "dir": "尾盘买入",
                    "buy": 20.0,
                    "sell": 0.0,
                    "qty": 1000,
                    "net": -6.0,
                    "plan": "计划外",
                    "postBuyPosPct": 38.0,
                    "holidayCapPct": 30,
                    "mistakeTags": ["pre_holiday_overcap"],
                }
            ],
            date="2026-09-30",
            market_env={"level": "OK", "text": "节前收官日"},
        )
        self.assertEqual(res_1d["preHolidayOvercapCount"], 1)
        self.assertEqual(res_1d["subScores"]["env"], 14)
        self.assertEqual(res_1d["subScores"]["stop"], 22)
        self.assertIn("跨假锁定至 `2026-10-08` 开市", res_1d["review"])
        self.assertIn("优先减回 `≤30%` 安全线", res_1d["review"])

        # 4) 合规控仓对比：国庆前2日买后总仓 25% <= 30% -> 不触发扣分
        res_safe = build_quant_rule_review(
            trades=[
                {
                    "stock": "上海沿浦 (605128)",
                    "track": "long_t",
                    "dir": "买入建仓",
                    "buy": 25.0,
                    "sell": 0.0,
                    "qty": 400,
                    "net": 0.0,
                    "plan": "计划内",
                    "postBuyPosPct": 25.0,
                    "mistakeTags": [],
                }
            ],
            date="2026-09-29",
            market_env={"level": "OK", "text": "节前缩量震荡"},
        )
        self.assertEqual(res_safe["preHolidayOvercapCount"], 0)
        self.assertEqual(res_safe["subScores"]["env"], 25)
        self.assertNotIn("节前长假超限建仓", res_safe["review"])


if __name__ == "__main__":
    unittest.main()
