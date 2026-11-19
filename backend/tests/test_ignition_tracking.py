import asyncio
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

if "httpx" not in sys.modules:
    _httpx_stub = types.ModuleType("httpx")
    _httpx_stub.AsyncClient = object
    _httpx_stub.Response = object
    _httpx_stub.Timeout = lambda *a, **kw: None
    sys.modules["httpx"] = _httpx_stub

from backend import ignition


class TestIgnitionTracking(unittest.TestCase):
    def test_mutate_and_load_tracking_across_all_boards(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            ledger_file = Path(tmpdir) / "strategy_ledger.json"
            cache_file = Path(tmpdir) / "ignition_latest.json"

            async def _fake_quotes(_client, codes):
                return {
                    c: {
                        "code": c,
                        "name": f"测试{c[-2:]}",
                        "price": 21.0,
                        "chg": 3.5,
                        "high": 21.5,
                        "low": 20.1,
                        "open": 20.2,
                    }
                    for c in codes
                }

            with (
                patch.object(ignition, "DATA_DIR", Path(tmpdir)),
                patch.object(ignition, "STRATEGY_LEDGER_FILE", ledger_file),
                patch.object(ignition, "IGNITION_CACHE_FILE", cache_file),
                patch.object(ignition, "_fetch_batch_quotes", side_effect=_fake_quotes),
            ):
                # 1. 支持同时添加 00 主板、30 创业板、688 科创板及尾盘/字辈策略
                r1 = asyncio.run(
                    ignition.mutate_ignition_tracking(
                        action="add",
                        code="000417",
                        name="合百集团",
                        hybk="商业百货",
                        price=20.0,
                        strategy="ignition",
                        verdict="震仓完成·待起爆",
                    )
                )
                self.assertTrue(r1["ok"])
                self.assertIn("000417", r1["codes"])

                r2 = asyncio.run(
                    ignition.mutate_ignition_tracking(
                        action="add",
                        code="300502",
                        name="新易盛",
                        hybk="CPO",
                        price=20.0,
                        strategy="bottom",
                        verdict="利空抗跌·底部试探",
                    )
                )
                self.assertTrue(r2["ok"])
                self.assertIn("300502", r2["codes"])

                r3 = asyncio.run(
                    ignition.mutate_ignition_tracking(
                        action="add",
                        code="600120",
                        name="浙江东方",
                        hybk="东方系",
                        price=20.0,
                        strategy="tail_watch",
                        verdict="尾盘黑马·可挂",
                    )
                )
                self.assertEqual(r3["activeCount"], 3)

                pool = asyncio.run(ignition.get_ignition_tracking_pool(http_client=object()))
                self.assertTrue(pool["ok"])
                self.assertEqual(pool["summary"]["totalCount"], 3)
                labels = {it["code"]: it["strategyLabel"] for it in pool["items"]}
                self.assertEqual(labels["000417"], "横盘待起爆")
                self.assertEqual(labels["300502"], "抗跌抄底")
                self.assertEqual(labels["600120"], "尾盘潜伏")

                # 2. 手动移出后不再出现在在轨池中
                rem = asyncio.run(
                    ignition.mutate_ignition_tracking(action="remove", code="300502")
                )
                self.assertTrue(rem["ok"])
                self.assertNotIn("300502", rem["codes"])

                pool_after = asyncio.run(ignition.get_ignition_tracking_pool(http_client=object()))
                self.assertEqual(pool_after["summary"]["totalCount"], 2)
                remaining_codes = {it["code"] for it in pool_after["items"]}
                self.assertEqual(remaining_codes, {"000417", "600120"})

                # 校验磁盘 JSON 原子持久化结构合法
                saved = json.loads(ledger_file.read_text(encoding="utf-8"))
                self.assertIn("signals", saved)


if __name__ == "__main__":
    unittest.main()
