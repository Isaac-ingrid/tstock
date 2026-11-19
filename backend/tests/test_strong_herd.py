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


if __name__ == "__main__":
    unittest.main()
