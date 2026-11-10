from __future__ import annotations

import asyncio
import datetime
import json
import os
import re
import statistics
import time
from collections import defaultdict
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import httpx

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
HERD_POOL_FILE = DATA_DIR / "herd_pool.json"
_HERD_FILE_LOCK = asyncio.Lock()

# 进程内短周期缓存，避免频繁请求上游行情
_HIST_ZT_CACHE: Dict[str, Tuple[float, List[dict]]] = {}
_RECENT_ZT_CACHE: Dict[str, Tuple[float, List[Tuple[str, List[dict]]]]] = {}
_KLINE_CACHE: Dict[str, Tuple[float, List[list]]] = {}
_HERD_CACHE_LOCK = asyncio.Lock()

HIST_ZT_TTL = 3600.0
KLINE_TTL = 180.0

NOISE_CONCEPT_KEYWORDS = (
    "昨日",
    "连板",
    "涨停",
    "触板",
    "新高",
    "ST股",
    "HS300",
    "沪股通",
    "深股通",
    "融资融券",
    "转融券",
    "富时",
    "标普",
    "MSCI",
    "百元股",
    "高价股",
    "低价股",
    "破净",
    "微盘股",
    "QFII",
    "证金",
    "社保",
    "央视50",
    "B股",
    "AB股",
    "预盈预增",
    "茅指数",
    "宁组合",
    "GDR",
    "AH股",
    "标准普尔",
)

DEFAULT_MYSTIC_ROOTS: Tuple[str, ...] = (
    "东方",
    "阳",
    "洋",
    "祥",
    "羊",
    "龙",
    "凤",
    "福",
    "瑞",
    "泰",
    "昌",
    "盛",
    "金",
    "马",
    "猴",
)

# 同音/同系字辈归并映射，让「光洋股份 / 盛洋科技 / 九阳股份 / 祥xxx」能聚合成同一条暗线
MYSTIC_HOMOPHONE_FAMILY: Dict[str, str] = {
    "羊": "羊/洋/阳系",
    "阳": "羊/洋/阳系",
    "洋": "羊/洋/阳系",
    "祥": "羊/洋/阳系",
    "东方": "东方系",
}

NAME_STOPWORDS = {
    "股份", "科技", "电子", "新材", "能源", "新能", "控股", "集团", "智能", "医药",
    "化工", "汽车", "电气", "机械", "装备", "材料", "信息", "软件", "传媒", "文化",
    "实业", "发展", "国际", "中国", "中华", "有限", "公司", "重工", "生物", "环保",
    "精密", "通信", "网络", "高科", "制造", "技术", "工业", "食品", "药业", "航空",
    "航天", "电力", "建设", "投资", "贸易", "资源", "环境", "工程", "光电", "微电",
    "医疗", "健康", "物流", "交通", "黄金", "金属", "有色", "钢铁", "煤炭", "燃气",
}


def parse_mystic_roots(raw_roots: Optional[str]) -> List[str]:
    """解析自定义玄学字根配置（支持逗号/空格/顿号分隔），空值回退默认词表。"""
    if not raw_roots or not str(raw_roots).strip():
        return list(DEFAULT_MYSTIC_ROOTS)
    tokens = [t.strip() for t in re.split(r"[\s,，、;；]+", str(raw_roots)) if t.strip()]
    seen = set()
    out: List[str] = []
    for tok in tokens:
        if tok not in seen and len(tok) <= 6:
            seen.add(tok)
            out.append(tok)
    return out or list(DEFAULT_MYSTIC_ROOTS)


def _cluster_label_for_root(root: str) -> str:
    return MYSTIC_HOMOPHONE_FAMILY.get(root, f"{root}字辈" if len(root) == 1 else f"{root}系")


def _detect_mystic_clusters(
    zt_by_code: Dict[str, dict],
    mystic_roots: List[str],
) -> Tuple[List[dict], Dict[str, dict]]:
    """
    基于当日涨停池扫描「配置玄学字根 + 自动双字前缀字辈共振」：
    - 返回 (mystic_clusters, code_mystic_map)
    - 仅统计当日真实封板的 00/60 主板标的，防止普通股干扰字辈共振判断
    """
    cluster_members: Dict[str, Dict[str, Any]] = {}

    def _add_member(cluster_name: str, root: str, st: dict, is_auto: bool) -> None:
        bucket = cluster_members.setdefault(
            cluster_name,
            {"name": cluster_name, "root": root, "isAuto": is_auto, "stocks": {}},
        )
        bucket["stocks"][st["code"]] = st

    # 1) 匹配内置/用户配置的玄学字根（先长词后短词，防止单字重复盖住双字）
    sorted_roots = sorted(mystic_roots, key=lambda x: (-len(x), x))
    for code, st in zt_by_code.items():
        nm = st.get("name", "")
        for rt in sorted_roots:
            if rt and rt in nm:
                _add_member(_cluster_label_for_root(rt), rt, st, False)

    # 2) 自动发现当日涨停股名中的「双字非行业通用词前缀/词根」共振（>=2只同日涨停自动浮现）
    token_hits: Dict[str, List[dict]] = defaultdict(list)
    for st in zt_by_code.values():
        nm = re.sub(r"[A-Za-z0-9\*\s]+", "", st.get("name", ""))
        if len(nm) >= 2:
            prefix2 = nm[:2]
            if prefix2 not in NAME_STOPWORDS and not any(prefix2 in s for s in NAME_STOPWORDS):
                token_hits[prefix2].append(st)

    for tok, members in token_hits.items():
        if len(members) >= 2:
            c_name = _cluster_label_for_root(tok)
            if c_name not in cluster_members:
                for st in members:
                    _add_member(c_name, tok, st, True)

    clusters_out: List[dict] = []
    code_mystic_map: Dict[str, dict] = {}
    for c_name, info in cluster_members.items():
        st_list = list(info["stocks"].values())
        st_list.sort(key=lambda x: (-x.get("lbc", 1), x.get("fbtSec", 999999)))
        zt_cnt = len(st_list)
        max_lbc = max((x.get("lbc", 1) for x in st_list), default=1)
        if zt_cnt >= 2:
            clusters_out.append({
                "name": c_name,
                "root": info["root"],
                "ztCount": zt_cnt,
                "maxLbc": max_lbc,
                "leader": st_list[0]["name"] if st_list else "",
                "isAuto": info["isAuto"],
                "codes": [x["code"] for x in st_list],
            })
        for st in st_list:
            c = st["code"]
            prev = code_mystic_map.get(c)
            if not prev or zt_cnt > prev["clusterZtCount"]:
                code_mystic_map[c] = {
                    "matchedRoots": list(dict.fromkeys((prev["matchedRoots"] if prev else []) + [info["root"]])),
                    "clusterName": c_name,
                    "clusterZtCount": zt_cnt,
                    "isResonant": zt_cnt >= 2,
                }
            elif info["root"] not in prev["matchedRoots"]:
                prev["matchedRoots"].append(info["root"])

    clusters_out.sort(key=lambda x: (-x["ztCount"], -x["maxLbc"], x["name"]))
    return clusters_out, code_mystic_map


def _match_stock_mystic(
    code: str,
    name: str,
    mystic_roots: List[str],
    code_mystic_map: Dict[str, dict],
    active_cluster_by_root: Dict[str, dict],
) -> Optional[dict]:
    """为任意强势股/抱团股匹配玄学字根或今日共振字辈。"""
    if code in code_mystic_map:
        return code_mystic_map[code]
    matched: List[str] = []
    best_cluster: Optional[dict] = None
    for rt in sorted(mystic_roots, key=lambda x: (-len(x), x)):
        if rt and rt in (name or ""):
            matched.append(rt)
            c_info = active_cluster_by_root.get(_cluster_label_for_root(rt))
            if c_info and (not best_cluster or c_info["ztCount"] > best_cluster["ztCount"]):
                best_cluster = c_info
    if not matched:
        return None
    return {
        "matchedRoots": matched,
        "clusterName": best_cluster["name"] if best_cluster else _cluster_label_for_root(matched[0]),
        "clusterZtCount": best_cluster["ztCount"] if best_cluster else 0,
        "isResonant": bool(best_cluster and best_cluster["ztCount"] >= 2),
    }


def _compute_dual_scores(
    *,
    lbc: int,
    zttj_ct: int,
    sector_zt_count: int,
    pop_rank: Optional[int],
    amount: float,
    turnover: float,
    chg: float,
    is_new_high: bool,
    is_limit_up: bool,
    in_herd_pool: bool,
    health_status: str,
    fbt_sec: int,
    fund: float,
    seal_ratio: float,
    zbc: int,
    mystic_info: Optional[dict],
) -> Tuple[int, int, dict]:
    """
    计算正交双轨评分：
    - identityScore (身份分 0-100): 它是谁（连板高度 / 多板记忆 / 板块效应 / 人气与字辈辨识度）
    - relayScore (接力分 0-100): 明天能不能接（首封速度 / 封板或承接质量 / 可交易性 / 周期交互 / 日内强度）
    """
    # --- 1. 身份分 (0 - 100) ---
    if lbc >= 5:
        dim_height = 35
    elif lbc == 4:
        dim_height = 30
    elif lbc == 3:
        dim_height = 25
    elif lbc == 2:
        dim_height = 18
    elif lbc == 1:
        dim_height = 10
    else:
        dim_height = 4

    if zttj_ct >= 5:
        dim_memory = 20
    elif zttj_ct == 4:
        dim_memory = 18
    elif zttj_ct == 3:
        dim_memory = 15
    elif zttj_ct == 2:
        dim_memory = 9
    else:
        dim_memory = 2
    if in_herd_pool and health_status in ("healthy", "accelerating"):
        dim_memory = min(20, dim_memory + 3)

    if sector_zt_count >= 5:
        dim_sector = 20
    elif sector_zt_count >= 3:
        dim_sector = 15
    elif sector_zt_count >= 2:
        dim_sector = 10
    else:
        dim_sector = 4

    dim_pop = 4
    if pop_rank is not None:
        if pop_rank <= 10:
            dim_pop = 18
        elif pop_rank <= 30:
            dim_pop = 14
        elif pop_rank <= 60:
            dim_pop = 10
        elif pop_rank <= 100:
            dim_pop = 6
    if amount >= 2.5e9:
        dim_pop += 4
    elif amount >= 1.2e9:
        dim_pop += 2
    if is_new_high:
        dim_pop += 3

    mystic_bonus = 0
    if mystic_info:
        if mystic_info.get("isResonant"):
            mystic_bonus = 3
        elif lbc >= 2 or in_herd_pool:
            mystic_bonus = 1
    dim_pop = min(25, dim_pop + mystic_bonus)

    identity_score = max(10, min(100, dim_height + dim_memory + dim_sector + dim_pop))

    # --- 2. 接力分 (0 - 100)，其中周期交互默认给中性分 12，由 limitup.py 按实时情绪校准 ---
    if is_limit_up:
        if fbt_sec <= 92500:
            dim_first = 24
        elif fbt_sec <= 93500:
            dim_first = 22
        elif fbt_sec <= 94500:
            dim_first = 19
        elif fbt_sec <= 103000:
            dim_first = 15
        elif fbt_sec <= 133000:
            dim_first = 11
        elif fbt_sec < 143000:
            dim_first = 8
        else:
            dim_first = 5

        if (seal_ratio >= 1.2 or fund >= 1.2e8) and zbc == 0:
            dim_seal = 24
        elif (seal_ratio >= 0.6 or fund >= 5.0e7) and zbc <= 1:
            dim_seal = 19
        elif zbc == 0 and seal_ratio >= 0.25:
            dim_seal = 15
        elif zbc >= 2:
            dim_seal = 7
        else:
            dim_seal = 11

        is_locked_one_word = (fbt_sec <= 92500 and turnover <= 2.5 and zbc == 0)
        if is_locked_one_word:
            dim_trade = 6  # 一字顶死通道买不进，压低可交易性
        elif 5.0 <= turnover <= 22.0:
            dim_trade = 20
        elif 2.5 < turnover < 5.0 or 22.0 < turnover <= 30.0:
            dim_trade = 14
        else:
            dim_trade = 8
    else:
        # 未涨停抱团/趋势强势股：评估次日低吸/反包可接力性
        dim_first = 14 if (health_status == "healthy" and chg >= 1.5) else (11 if health_status == "healthy" else 7)
        dim_seal = 19 if health_status == "healthy" else (12 if health_status == "warning" else 8)
        dim_trade = 18 if (amount >= 5.0e8 and 3.0 <= turnover <= 22.0) else 13

    dim_cycle = 12  # 中性基准，后续由 limitup.py 结合风险总阀再精确加减
    dim_strength = 4
    if chg >= 9.5:
        dim_strength += 6
    elif chg >= 4.0:
        dim_strength += 5
    elif chg >= 0:
        dim_strength += 3
    if amount >= 1.5e9:
        dim_strength += 4
    elif amount >= 6.0e8:
        dim_strength += 2
    dim_strength = min(14, dim_strength)

    relay_score = max(10, min(100, dim_first + dim_seal + dim_trade + dim_cycle + dim_strength))

    score_dims = {
        "identity": {
            "height": dim_height,
            "memory": dim_memory,
            "sector": dim_sector,
            "popularity": dim_pop,
            "mysticBonus": mystic_bonus,
        },
        "relay": {
            "firstSeal": dim_first,
            "sealQuality": dim_seal,
            "tradability": dim_trade,
            "cycle": dim_cycle,
            "strength": dim_strength,
        },
    }
    return identity_score, relay_score, score_dims


def is_mainboard_10cm(code: str, name: str = "") -> bool:
    """严格筛选 10cm 主板标的：剔除创业板(30)、科创板(68)、北交所(8/4/92)及 ST/退市风险股。"""
    c = str(code or "").strip().zfill(6)
    n = str(name or "").upper()
    return c.startswith(("00", "60")) and ("ST" not in n) and ("退" not in n)


def _to_tcode(code: str) -> str:
    c = str(code).strip().zfill(6)
    return f"{'sh' if c.startswith(('6', '9')) else 'sz'}{c}"


def _sf(v: Any, default: float = 0.0) -> float:
    try:
        return float(v) if v not in (None, "", "-") else default
    except (ValueError, TypeError):
        return default


def _shift_date_str(date_str: str, days: int) -> str:
    dt = datetime.datetime.strptime(date_str, "%Y%m%d").date()
    return (dt + datetime.timedelta(days=days)).strftime("%Y%m%d")


def _load_herd_state_sync() -> dict:
    if not HERD_POOL_FILE.exists():
        return {"version": 1, "lastRunDate": "", "active": {}, "evicted": []}
    try:
        with HERD_POOL_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise ValueError("Invalid herd pool json")
        data.setdefault("version", 1)
        data.setdefault("lastRunDate", "")
        data.setdefault("active", {})
        data.setdefault("evicted", [])
        return data
    except Exception:
        return {"version": 1, "lastRunDate": "", "active": {}, "evicted": []}


def _save_herd_state_sync(state: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp_path = HERD_POOL_FILE.with_suffix(".json.tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, HERD_POOL_FILE)


async def _fetch_hist_zt_pool(client: httpx.AsyncClient, date_str: str) -> List[dict]:
    now_ts = time.monotonic()
    async with _HERD_CACHE_LOCK:
        cached = _HIST_ZT_CACHE.get(date_str)
        if cached and cached[0] > now_ts:
            return cached[1]

    url = (
        "https://push2ex.eastmoney.com/getTopicZTPool"
        f"?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=180&sort=lbc:desc&date={date_str}"
    )
    pool: List[dict] = []
    try:
        r = await client.get(url)
        if r.status_code == 200:
            j = r.json()
            if j.get("rc") == 0 and j.get("data"):
                raw = j["data"].get("pool") or []
                qdate = str(j["data"].get("qdate") or "")
                if qdate == date_str:
                    pool = raw
    except Exception:
        pool = []

    if pool:
        async with _HERD_CACHE_LOCK:
            _HIST_ZT_CACHE[date_str] = (now_ts + HIST_ZT_TTL, pool)
    return pool


async def _fetch_recent_zt_days(
    client: httpx.AsyncClient, actual_date: str, lookback_cal_days: int = 7, max_valid_days: int = 3
) -> List[Tuple[str, List[dict]]]:
    """并发探测实际交易日之前的近 3 个交易日涨停池，用于自动发现昨日高标/近期抱团核。"""
    now_ts = time.monotonic()
    async with _HERD_CACHE_LOCK:
        cached_days = _RECENT_ZT_CACHE.get(actual_date)
        if cached_days and cached_days[0] > now_ts:
            return cached_days[1]

    cand_dates = [_shift_date_str(actual_date, -d) for d in range(1, lookback_cal_days + 1)]
    res_list = await asyncio.gather(
        *[_fetch_hist_zt_pool(client, d) for d in cand_dates],
        return_exceptions=True,
    )
    out: List[Tuple[str, List[dict]]] = []
    for d, res in zip(cand_dates, res_list):
        if isinstance(res, list) and res:
            out.append((d, res))
            if len(out) >= max_valid_days:
                break

    if out:
        async with _HERD_CACHE_LOCK:
            _RECENT_ZT_CACHE[actual_date] = (now_ts + HIST_ZT_TTL, out)
    return out


async def _fetch_batch_quotes(client: httpx.AsyncClient, codes: List[str]) -> Dict[str, dict]:
    """单次批量拉取多只主板股的腾讯实时行情（0.1秒级）。"""
    if not codes:
        return {}
    out: Dict[str, dict] = {}
    unique_codes = list(dict.fromkeys(str(c).zfill(6) for c in codes if c))
    for i in range(0, len(unique_codes), 60):
        chunk = unique_codes[i : i + 60]
        q_str = ",".join(_to_tcode(c) for c in chunk)
        try:
            r = await client.get(f"https://qt.gtimg.cn/q={q_str}")
            if r.status_code != 200:
                continue
            for line in r.text.split(";"):
                if "~" not in line:
                    continue
                parts = line.split("~")
                if len(parts) <= 45:
                    continue
                code = str(parts[2]).strip().zfill(6)
                name = str(parts[1]).strip()
                px = _sf(parts[3])
                prev_close = _sf(parts[4])
                if px <= 0:
                    continue
                out[code] = {
                    "code": code,
                    "tcode": _to_tcode(code),
                    "name": name,
                    "price": round(px, 2),
                    "prevClose": round(prev_close, 2),
                    "high": round(_sf(parts[33], px), 2),
                    "low": round(_sf(parts[34], px), 2),
                    "chg": round(_sf(parts[32]), 2),
                    "amount": _sf(parts[37]) * 10000.0,
                    "turnover": round(_sf(parts[38]), 2),
                    "mcap": _sf(parts[45]) * 1.0e8,
                    "vr": round(_sf(parts[49], 1.0), 2) if len(parts) > 49 else 1.0,
                }
        except Exception:
            continue
    return out


async def _fetch_daily_kline(client: httpx.AsyncClient, code: str, sem: Optional[asyncio.Semaphore] = None) -> List[list]:
    now_ts = time.monotonic()
    async with _HERD_CACHE_LOCK:
        cached = _KLINE_CACHE.get(code)
        if cached and cached[0] > now_ts:
            return cached[1]

    tcode = _to_tcode(code)
    em_secid = f"1.{code}" if str(code).startswith(("6", "9")) else f"0.{code}"
    em_kline_url = (
        f"https://push2his.eastmoney.com/api/qt/stock/kline/get"
        f"?secid={em_secid}&fields1=f1,f2,f3,f4,f5,f6"
        f"&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&end=20500101&lmt=30"
    )
    tx_urls = [
        f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={tcode},day,,,30,qfq",
        f"https://ifzq.gtimg.cn/appstock/app/fqkline/get?param={tcode},day,,,30,qfq",
        f"https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get?param={tcode},day,,,30,qfq",
    ]
    days: List[list] = []

    async def _do_fetch() -> List[list]:
        try:
            r_em = await client.get(em_kline_url, headers={"Referer": "https://quote.eastmoney.com/"})
            if r_em.status_code == 200 and r_em.text.lstrip().startswith("{"):
                klines = (r_em.json().get("data") or {}).get("klines") or []
                parsed = [str(row).split(",")[:6] for row in klines if len(str(row).split(",")) >= 6]
                if parsed:
                    return parsed
        except Exception:
            pass

        for url in tx_urls:
            try:
                r = await client.get(url, headers={"Referer": "https://gu.qq.com/"})
                if r.status_code == 200 and r.text.strip().startswith("{"):
                    j = r.json()
                    res_days = (
                        j.get("data", {}).get(tcode, {}).get("qfqday")
                        or j.get("data", {}).get(tcode, {}).get("day")
                        or []
                    )
                    if res_days:
                        return res_days
            except Exception:
                continue
        return []

    if sem is not None:
        async with sem:
            days = await _do_fetch()
    else:
        days = await _do_fetch()

    if days:
        async with _HERD_CACHE_LOCK:
            _KLINE_CACHE[code] = (now_ts + KLINE_TTL, days)
    return days


def _build_stock_tags(
    lbc: int,
    zttj_ct: int,
    zttj_days: int,
    is_new_high: bool,
    is_limit_up: bool,
    pop_rank: Optional[int],
    in_herd_pool: bool,
    amount: float,
    chg: float,
    health_status: str = "",
    mystic_info: Optional[dict] = None,
) -> List[dict]:
    """为同一只股票生成多维可叠加标签（一票多标签）。"""
    tags: List[dict] = []

    if is_limit_up and lbc >= 1:
        tags.append({
            "key": "ladder",
            "label": f"👑 {lbc}连板" if lbc > 1 else "👑 首板",
            "color": "#cf1322",
            "bg": "#fff1f0",
            "border": "#ffa39e",
        })

    is_multi_board_herd = (zttj_ct >= 3 and zttj_days <= 22) or lbc >= 3
    if is_multi_board_herd:
        herd_txt = f"🤝 {zttj_days}天{zttj_ct}板抱团" if zttj_ct >= 3 else f"🤝 {lbc}板抱团核心"
        tags.append({
            "key": "herd",
            "label": herd_txt,
            "color": "#7c3aed",
            "bg": "#f5f3ff",
            "border": "#c4b5fd",
        })
    elif in_herd_pool:
        tags.append({
            "key": "herd",
            "label": "🤝 资金抱团跟踪",
            "color": "#7c3aed",
            "bg": "#f5f3ff",
            "border": "#c4b5fd",
        })

    if pop_rank is not None and pop_rank <= 60:
        tags.append({
            "key": "popular",
            "label": f"🔥 人气#{pop_rank}",
            "color": "#c2410c",
            "bg": "#fff7ed",
            "border": "#fdba74",
        })

    if is_new_high:
        tags.append({
            "key": "newhigh",
            "label": "📈 60日新高(未板)" if not is_limit_up else "📈 60日新高",
            "color": "#0369a1",
            "bg": "#e0f2fe",
            "border": "#7dd3fc",
        })

    if not is_limit_up and in_herd_pool and health_status in ("healthy", "warning") and chg > -6.0:
        tags.append({
            "key": "highflat",
            "label": "💎 断板高横" if health_status == "healthy" else "⚠️ 断板回踩",
            "color": "#0f766e" if health_status == "healthy" else "#b45309",
            "bg": "#f0fdfa" if health_status == "healthy" else "#fffbeb",
            "border": "#5eead4" if health_status == "healthy" else "#fcd34d",
        })

    if amount >= 2.0e9 and chg >= -2.0:
        tags.append({
            "key": "capacity",
            "label": f"🐳 容量核心({amount / 1e8:.0f}亿)",
            "color": "#1d4ed8",
            "bg": "#eff6ff",
            "border": "#93c5fd",
        })

    if mystic_info:
        c_name = mystic_info.get("clusterName", "")
        c_cnt = int(mystic_info.get("clusterZtCount") or 0)
        roots = mystic_info.get("matchedRoots") or []
        if c_cnt >= 2:
            tags.append({
                "key": "mystic",
                "label": f"🔮 {c_name}({c_cnt}涨停)",
                "color": "#9d174d",
                "bg": "#fdf2f8",
                "border": "#f9a8d4",
            })
        elif roots and (lbc >= 2 or in_herd_pool):
            tags.append({
                "key": "mystic",
                "label": f"🔮 字根·{roots[0]}",
                "color": "#9d174d",
                "bg": "#fdf2f8",
                "border": "#f9a8d4",
            })

    return tags


def _eval_herd_health(
    code: str,
    cur_px: float,
    today_high: float,
    chg: float,
    days: List[list],
    actual_date: str,
    entry_date: str,
    stored_peak: float,
    pop_rank: Optional[int],
) -> dict:
    """
    评估抱团跟踪股每日均线支撑、高点回撤与宽松版破位淘汰逻辑：
    - 阶段峰值仅从入池日(entry_date)起算，避免历史前期暴跌高点误伤反包新周期
    - 今日涨停或放量强修复(+5.5%站上MA5)受豁免，不被历史均线误踢出
    - 仅在破MA20(-1.5%) / 回撤>=20% / 跌停 / 连续3日累跌>=15% / 5日弱势失守MA10且无人气 时移出
    """
    actual_iso = f"{actual_date[:4]}-{actual_date[4:6]}-{actual_date[6:8]}"
    entry_iso = f"{entry_date[:4]}-{entry_date[4:6]}-{entry_date[6:8]}" if len(entry_date) >= 8 else actual_iso
    hist_bars = [d for d in days if str(d[0])[:10] < actual_iso]
    closes_eval = [float(d[2]) for d in hist_bars if _sf(d[2]) > 0]
    post_entry_highs = [
        float(d[3]) for d in hist_bars if str(d[0])[:10] >= entry_iso and _sf(d[3]) > 0
    ]

    if cur_px > 0:
        closes_eval.append(cur_px)
        post_entry_highs.append(max(cur_px, today_high))

    if not closes_eval or cur_px <= 0:
        return {
            "ma5": cur_px,
            "ma10": cur_px,
            "ma20": cur_px,
            "vsMa5": 0.0,
            "vsMa10": 0.0,
            "vsMa20": 0.0,
            "peakPrice": max(stored_peak, cur_px),
            "ddFromPeak": 0.0,
            "belowMa10Streak": 0,
            "downStreak": 0,
            "cum3dDrop": 0.0,
            "evict": False,
            "evictReason": "",
            "healthStatus": "healthy",
            "healthLabel": "🟢 跟踪观察中",
            "healthColor": "#15803d",
            "healthBg": "#f0fdf4",
            "healthBorder": "#86efac",
            "healthDesc": "暂缺完整历史日K，持续跟踪实时承接与涨跌幅。",
        }

    ma5 = sum(closes_eval[-5:]) / min(5, len(closes_eval))
    ma10 = sum(closes_eval[-10:]) / min(10, len(closes_eval))
    ma20 = sum(closes_eval[-20:]) / min(20, len(closes_eval))

    peak_px = round(max([stored_peak, cur_px] + post_entry_highs), 2)

    vs_ma5 = round(((cur_px - ma5) / ma5) * 100, 2) if ma5 > 0 else 0.0
    vs_ma10 = round(((cur_px - ma10) / ma10) * 100, 2) if ma10 > 0 else 0.0
    vs_ma20 = round(((cur_px - ma20) / ma20) * 100, 2) if ma20 > 0 else 0.0
    dd_from_peak = round(((cur_px - peak_px) / peak_px) * 100, 2) if peak_px > 0 else 0.0

    # 统计连续收盘位于当日滚动 MA10 均线下方（宽松阈 0.99）的天数
    below_ma10_streak = 0
    for idx in range(len(closes_eval) - 1, max(-1, len(closes_eval) - 7), -1):
        sub_ma10 = sum(closes_eval[max(0, idx - 9) : idx + 1]) / min(10, idx + 1)
        if sub_ma10 > 0 and closes_eval[idx] < sub_ma10 * 0.99:
            below_ma10_streak += 1
        else:
            break

    # 统计连续下跌天数与近3日累计跌幅
    down_streak = 0
    for idx in range(len(closes_eval) - 1, 0, -1):
        if closes_eval[idx] < closes_eval[idx - 1]:
            down_streak += 1
        else:
            break
    cum_3d_drop = (
        round(((closes_eval[-1] - closes_eval[-4]) / closes_eval[-4]) * 100, 2)
        if len(closes_eval) >= 4 and closes_eval[-4] > 0
        else 0.0
    )

    is_zt = chg >= 9.6
    is_strong_repair = chg >= 5.5 and vs_ma5 >= -0.5

    # ---- 宽松版破位自动移出规则（今日涨停/放量强修复豁免） ----
    evict_reasons: List[str] = []
    if not is_zt and not is_strong_repair:
        if chg <= -9.5:
            evict_reasons.append(f"跌停核按钮({chg:.1f}%)，主力踩踏出局")
        if len(closes_eval) >= 12 and vs_ma20 <= -1.5 and cur_px < ma5:
            evict_reasons.append(f"有效跌破20日生命线(偏离{vs_ma20:.1f}%)")
        if dd_from_peak <= -20.0:
            evict_reasons.append(f"自入池后高点深度回撤{dd_from_peak:.1f}% (≥20%)")
        if below_ma10_streak >= 2 and vs_ma10 <= -3.0:
            evict_reasons.append(f"连续{below_ma10_streak}日失守10日线(偏离{vs_ma10:.1f}%)")
        if down_streak >= 3 and cum_3d_drop <= -15.0:
            evict_reasons.append(f"连续{down_streak}日连阴派发(3日累跌{cum_3d_drop:.1f}%)")
        if below_ma10_streak >= 5 and (pop_rank is None or pop_rank > 120):
            evict_reasons.append("连续5日弱势阴跌于MA10下方且跌出人气榜")

    if evict_reasons:
        return {
            "ma5": round(ma5, 2),
            "ma10": round(ma10, 2),
            "ma20": round(ma20, 2),
            "vsMa5": vs_ma5,
            "vsMa10": vs_ma10,
            "vsMa20": vs_ma20,
            "peakPrice": peak_px,
            "ddFromPeak": dd_from_peak,
            "belowMa10Streak": below_ma10_streak,
            "downStreak": down_streak,
            "cum3dDrop": cum_3d_drop,
            "evict": True,
            "evictReason": "；".join(evict_reasons[:2]),
            "healthStatus": "evicted",
            "healthLabel": "🔴 破位已移出",
            "healthColor": "#cf1322",
            "healthBg": "#fef2f2",
            "healthBorder": "#fca5a5",
            "healthDesc": "；".join(evict_reasons),
        }

    if is_zt:
        h_status = "accelerating"
        h_label = "🔥 连板涨停加速"
        h_col, h_bg, h_bd = "#cf1322", "#fff1f0", "#ffa39e"
        h_desc = f"今日涨停封板 (+{chg:.2f}%)，距MA5 +{vs_ma5:.1f}%，继续领跑抱团情绪。"
    elif not is_strong_repair and (vs_ma10 < -0.5 or dd_from_peak <= -14.0 or chg <= -6.0):
        h_status = "warning"
        h_label = "🟡 深水洗盘黄牌预警"
        h_col, h_bg, h_bd = "#b45309", "#fffbeb", "#fcd34d"
        h_desc = (
            f"当前分歧回踩（距5日/阶段高点{dd_from_peak:.1f}%，偏离MA10 {vs_ma10:+.1f}%），"
            f"尚未触及20日线/20%淘汰红线（距MA20缓冲 {vs_ma20:+.1f}%），留池观察能否企稳反包。"
        )
    elif chg >= 2.0:
        h_status = "healthy"
        h_label = "🟢 未涨停趋势走强"
        h_col, h_bg, h_bd = "#15803d", "#f0fdf4", "#86efac"
        h_desc = (
            f"今日虽未涨停 (+{chg:.2f}%) 但多头承接强劲，站在MA5({vs_ma5:+.1f}%)上方且回撤仅{dd_from_peak:.1f}%，属于典型强势抱团推升。"
        )
    else:
        h_status = "healthy"
        h_label = "🟢 断板高位横盘"
        h_col, h_bg, h_bd = "#0f766e", "#f0fdfa", "#5eead4"
        h_desc = (
            f"断板横盘换手 ({chg:+.2f}%)，稳守关键均线（MA5 {vs_ma5:+.1f}% / MA10 {vs_ma10:+.1f}%），高位分歧筹码良性消化，留意分时黄线低吸做T与反包机会。"
        )

    return {
        "ma5": round(ma5, 2),
        "ma10": round(ma10, 2),
        "ma20": round(ma20, 2),
        "vsMa5": vs_ma5,
        "vsMa10": vs_ma10,
        "vsMa20": vs_ma20,
        "peakPrice": peak_px,
        "ddFromPeak": dd_from_peak,
        "belowMa10Streak": below_ma10_streak,
        "downStreak": down_streak,
        "cum3dDrop": cum_3d_drop,
        "evict": False,
        "evictReason": "",
        "healthStatus": h_status,
        "healthLabel": h_label,
        "healthColor": h_col,
        "healthBg": h_bg,
        "healthBorder": h_bd,
        "healthDesc": h_desc,
    }


def _select_theme_roles(
    members: List[dict],
) -> Tuple[Optional[dict], Optional[dict], Optional[dict]]:
    """在同一主题材成分股中动态判定：题材龙头、阶段核心、容量核心（全部为00/60主板）。"""
    if not members:
        return None, None, None

    # 1. 题材龙头：连板高度优先 -> 今日涨停先封板 -> 涨幅最高
    leader_sorted = sorted(
        members,
        key=lambda x: (
            1 if x["isLimitUp"] else 0,
            x["lbc"],
            -x["fbtSec"] if x["isLimitUp"] else 0,
            x["chg"],
            x["amount"],
        ),
        reverse=True,
    )
    theme_leader = dict(leader_sorted[0])
    if theme_leader["lbc"] >= 2:
        l_reason = f"{theme_leader['lbc']}连板空间标杆" + (f" · {theme_leader['fbt']}封板" if theme_leader.get("fbt") not in (None, "", "—") else "")
    elif theme_leader["isLimitUp"]:
        l_reason = f"今日封板先锋 (+{theme_leader['chg']:.2f}%)" + (f" · {theme_leader['fbt']}" if theme_leader.get("fbt") not in (None, "", "—") else "")
    else:
        l_reason = f"板块领涨冲锋 (+{theme_leader['chg']:.2f}%)"
    theme_leader["roleReason"] = l_reason

    # 2. 阶段核心：多日涨停辨识度(ct) + 东财人气排名 + 近期高横持续性（若与龙头同票优先挑选次席核心以免重叠，除非无其他多板/高人气标的）
    def _phase_score(x: dict) -> float:
        pop_bonus = max(0, 110 - x["popRank"]) if x.get("popRank") else 0
        hold_bonus = 25 if x["chg"] >= -2.5 else -15
        return (x["zttjCt"] * 30.0) + (x["lbc"] * 12.0) + pop_bonus + hold_bonus + min(20.0, x["amount"] / 2.0e8)

    phase_sorted = sorted(members, key=_phase_score, reverse=True)
    phase_pick = phase_sorted[0]
    if phase_pick["code"] == theme_leader["code"] and len(phase_sorted) > 1:
        alt = phase_sorted[1]
        if alt["zttjCt"] >= 2 or (alt.get("popRank") and alt["popRank"] <= 70) or alt["amount"] >= 8.0e8:
            phase_pick = alt
    phase_core = dict(phase_pick)
    p_parts: List[str] = []
    if phase_core["zttjCt"] >= 2:
        p_parts.append(f"{phase_core['zttjDays']}天{phase_core['zttjCt']}板记忆")
    elif phase_core["lbc"] >= 2:
        p_parts.append(f"{phase_core['lbc']}连板高度")
    if phase_core.get("popRank"):
        p_parts.append(f"人气#{phase_core['popRank']}")
    if not phase_core["isLimitUp"] and phase_core["chg"] >= -2.0:
        p_parts.append("未板强势承接")
    elif phase_core["isLimitUp"]:
        p_parts.append("继续涨停巩固")
    if not p_parts:
        p_parts.append(f"近14日活跃承接 ({phase_core['chg']:+.2f}%)")
    if phase_core["code"] == theme_leader["code"]:
        p_parts.insert(0, "身兼龙头与阶段核心")
    phase_core["roleReason"] = " · ".join(p_parts)

    # 3. 容量核心：主板大成交额 + 大流通市值 + 当日跌幅受控（chg >= -2.5%）
    cap_cands = [x for x in members if x["chg"] >= -2.5 and x["amount"] >= 5.0e8]
    if not cap_cands:
        cap_cands = [x for x in members if x["chg"] >= -3.0] or members
    cap_sorted = sorted(
        cap_cands,
        key=lambda x: (
            x["amount"] * (1.25 if x["chg"] >= 3.0 else 1.0),
            x["mcap"],
        ),
        reverse=True,
    )
    cap_pick = cap_sorted[0]
    if cap_pick["code"] == theme_leader["code"] and len(cap_sorted) > 1 and cap_sorted[1]["amount"] >= 1.2e9:
        cap_pick = cap_sorted[1]
    capacity_core = dict(cap_pick)
    capacity_core["roleReason"] = (
        f"成交 {capacity_core['amount'] / 1e8:.1f}亿 · 流通 {capacity_core['mcap'] / 1e8:.0f}亿 · 今日 {capacity_core['chg']:+.2f}%"
    )

    return theme_leader, phase_core, capacity_core


async def build_strong_herd_and_themes(
    client: httpx.AsyncClient,
    actual_date: str,
    raw_zt_pool: List[dict],
    mystic_roots: Optional[List[str]] = None,
    compute_yesterday_stats: bool = True,
    read_only_herd: bool = False,
) -> dict:
    """
    构建：
    1) strongPool: 强势股与一票多标签抱团人气总池（严格剔除创业板30与科创板68）
    2) herdPool / evictedPool: 全自动抱团跟踪池（带跨天持久化与宽松版破位自动移出）
    3) mainThemes: 动态判断全市场及前4主题材的【当前主题材 / 题材龙头 / 阶段核心 / 容量核心】
    4) mysticClusters & yesterdayStats: 玄学字辈共振聚类 + 昨日涨停今日溢价/晋级率统计
    """
    active_mystic_roots = mystic_roots if mystic_roots else list(DEFAULT_MYSTIC_ROOTS)
    qs_url = (
        "https://push2ex.eastmoney.com/getTopicQSPool"
        f"?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=200&sort=zdp:desc&date={actual_date}"
    )
    pop_url = "https://emappdata.eastmoney.com/stockrank/getAllCurrentList"
    hot_bk_url = "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=30&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:3+f:!50&fields=f12,f14,f2,f3,f62,f128,f140,f104,f105"
    amt_top_url = "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=50&po=1&np=1&fltt=2&invt=2&fid=f6&fs=m:0+t:6,m:1+t:2&fields=f12,f14,f2,f3,f6,f8,f10,f21,f100"

    res_qs, res_pop, res_bk, res_amt, hist_zt_days = await asyncio.gather(
        client.get(qs_url),
        client.post(
            pop_url,
            json={
                "appId": "appId01",
                "globalId": "786e4c21-70dc-435a-93bb-38",
                "pageNo": 1,
                "pageSize": 100,
            },
        ),
        client.get(hot_bk_url),
        client.get(amt_top_url),
        _fetch_recent_zt_days(client, actual_date, lookback_cal_days=7, max_valid_days=3),
        return_exceptions=True,
    )

    # 1. 解析东财人气榜 (Top 100, 仅保留 00/60)
    pop_map: Dict[str, int] = {}
    if not isinstance(res_pop, Exception) and res_pop.status_code == 200:
        try:
            for item in (res_pop.json().get("data") or []):
                sc = str(item.get("sc") or "")
                code = sc[-6:].zfill(6) if len(sc) >= 6 else ""
                rk = int(item.get("rk") or 0)
                if code.startswith(("00", "60")) and rk > 0:
                    pop_map[code] = rk
        except Exception:
            pass

    # 2. 解析今日涨停池 (严格 00/60 非ST)
    zt_by_code: Dict[str, dict] = {}
    for row in raw_zt_pool:
        code = str(row.get("c", "")).zfill(6)
        name = str(row.get("n", ""))
        if not is_mainboard_10cm(code, name):
            continue
        zttj = row.get("zttj") or {}
        lbc = int(row.get("lbc") or 1)
        fbt_raw = int(row.get("fbt") or 999999)
        fbt_str = str(fbt_raw).zfill(6) if fbt_raw < 999999 else ""
        fbt_fmt = f"{fbt_str[0:2]}:{fbt_str[2:4]}:{fbt_str[4:6]}" if len(fbt_str) >= 6 else "—"
        amt = _sf(row.get("amount"))
        fund = _sf(row.get("fund"))
        zt_by_code[code] = {
            "code": code,
            "tcode": _to_tcode(code),
            "name": name,
            "price": round(_sf(row.get("p")) / 1000.0, 2),
            "chg": round(_sf(row.get("zdp")), 2),
            "amount": amt,
            "mcap": _sf(row.get("ltsz")),
            "turnover": round(_sf(row.get("hs")), 2),
            "lbc": lbc,
            "fbt": fbt_fmt,
            "fbtSec": fbt_raw,
            "fund": fund,
            "zbc": int(row.get("zbc") or 0),
            "sealRatio": round((fund / amt), 2) if amt > 0 else 0.0,
            "hybk": str(row.get("hybk") or "其他板块"),
            "zttjDays": int(zttj.get("days") or lbc),
            "zttjCt": int(zttj.get("ct") or lbc),
            "isNewHigh": False,
            "isLimitUp": True,
            "vr": 1.0,
        }

    # 2b. 玄学字根与同日字辈共振检测（含内置同音字辈 + 双字前缀自动共振）
    mystic_clusters, code_mystic_map = _detect_mystic_clusters(zt_by_code, active_mystic_roots)
    active_cluster_by_name = {c["name"]: c for c in mystic_clusters}
    # 统计每个行业板块当日涨停家数（供身份分板块效应维度使用）
    sector_zt_counts: Dict[str, int] = defaultdict(int)
    for st in zt_by_code.values():
        sector_zt_counts[st.get("hybk") or "其他板块"] += 1

    # 3. 解析今日强势股池 QSPool (严格 00/60 非ST，含未涨停强势股)
    qs_by_code: Dict[str, dict] = {}
    if not isinstance(res_qs, Exception) and res_qs.status_code == 200:
        try:
            qj = res_qs.json()
            qs_raw = (qj.get("data") or {}).get("pool") or []
            for row in qs_raw:
                code = str(row.get("c", "")).zfill(6)
                name = str(row.get("n", ""))
                if not is_mainboard_10cm(code, name):
                    continue
                zttj = row.get("zttj") or {}
                ct = int(zttj.get("ct") or 0)
                days_cnt = int(zttj.get("days") or 0)
                chg = round(_sf(row.get("zdp")), 2)
                nh = bool(row.get("nh"))
                is_zt = code in zt_by_code or chg >= 9.6
                if code in zt_by_code:
                    zt_by_code[code]["isNewHigh"] = nh
                    zt_by_code[code]["vr"] = round(_sf(row.get("lb"), 1.0), 2)
                    if ct > zt_by_code[code]["zttjCt"]:
                        zt_by_code[code]["zttjCt"] = ct
                        zt_by_code[code]["zttjDays"] = days_cnt
                qs_by_code[code] = {
                    "code": code,
                    "tcode": _to_tcode(code),
                    "name": name,
                    "price": round(_sf(row.get("p")) / 1000.0, 2),
                    "chg": chg,
                    "amount": _sf(row.get("amount")),
                    "mcap": _sf(row.get("ltsz")),
                    "turnover": round(_sf(row.get("hs")), 2),
                    "lbc": zt_by_code[code]["lbc"] if code in zt_by_code else 0,
                    "fbt": zt_by_code[code]["fbt"] if code in zt_by_code else "—",
                    "fbtSec": zt_by_code[code]["fbtSec"] if code in zt_by_code else 999999,
                    "fund": zt_by_code[code]["fund"] if code in zt_by_code else 0.0,
                    "sealRatio": zt_by_code[code]["sealRatio"] if code in zt_by_code else 0.0,
                    "hybk": str(row.get("hybk") or "其他板块"),
                    "zttjDays": days_cnt,
                    "zttjCt": ct,
                    "isNewHigh": nh,
                    "isLimitUp": is_zt,
                    "vr": round(_sf(row.get("lb"), 1.0), 2),
                }
        except Exception:
            pass

    # 4. 解析全市场主板成交额前50 (容量核心候选)
    amt_top_by_code: Dict[str, dict] = {}
    if not isinstance(res_amt, Exception) and res_amt.status_code == 200:
        try:
            for row in ((res_amt.json().get("data") or {}).get("diff") or []):
                code = str(row.get("f12", "")).zfill(6)
                name = str(row.get("f14", ""))
                if not is_mainboard_10cm(code, name):
                    continue
                px = _sf(row.get("f2"))
                if px <= 0:
                    continue
                chg = round(_sf(row.get("f3")), 2)
                amt = _sf(row.get("f6"))
                amt_top_by_code[code] = {
                    "code": code,
                    "tcode": _to_tcode(code),
                    "name": name,
                    "price": round(px, 2),
                    "chg": chg,
                    "amount": amt,
                    "mcap": _sf(row.get("f21")),
                    "turnover": round(_sf(row.get("f8")), 2),
                    "lbc": zt_by_code[code]["lbc"] if code in zt_by_code else 0,
                    "fbt": zt_by_code[code]["fbt"] if code in zt_by_code else "—",
                    "fbtSec": zt_by_code[code]["fbtSec"] if code in zt_by_code else 999999,
                    "fund": zt_by_code[code]["fund"] if code in zt_by_code else 0.0,
                    "sealRatio": zt_by_code[code]["sealRatio"] if code in zt_by_code else 0.0,
                    "hybk": str(row.get("f100") or "其他板块"),
                    "zttjDays": qs_by_code[code]["zttjDays"] if code in qs_by_code else 0,
                    "zttjCt": qs_by_code[code]["zttjCt"] if code in qs_by_code else 0,
                    "isNewHigh": qs_by_code[code]["isNewHigh"] if code in qs_by_code else False,
                    "isLimitUp": code in zt_by_code,
                    "vr": round(_sf(row.get("f10"), 1.0), 2),
                }
        except Exception:
            pass

    # 5. 全自动抱团跟踪池发现、每日健康体检与宽松版破位移出
    valid_hist = hist_zt_days if isinstance(hist_zt_days, list) else []
    yesterday_zt = valid_hist[0][1] if valid_hist else []
    yesterday_zt_codes = {str(r.get("c", "")).zfill(6) for r in yesterday_zt}

    async with _HERD_FILE_LOCK:
        state = _load_herd_state_sync()
        active_map: Dict[str, dict] = state.get("active", {})
        evicted_list: List[dict] = state.get("evicted", [])

        # 清理历史里非主板的脏数据（若有）
        for c_old in list(active_map.keys()):
            item_old = active_map[c_old]
            if not is_mainboard_10cm(c_old, item_old.get("name", "")):
                active_map.pop(c_old, None)

        cooldown_map: Dict[str, str] = {}
        manual_excluded_codes = set()
        for ev in evicted_list:
            ev_c = str(ev.get("code", "")).zfill(6)
            if ev.get("cooldownUntil", "") >= actual_date:
                cooldown_map[ev_c] = ev["cooldownUntil"]
            if ev.get("manualExcluded") and ev.get("cooldownUntil", "") >= actual_date:
                manual_excluded_codes.add(ev_c)

        # 自动纳新候选收集：
        # ① 今日/昨日 >=2连板高标；② 前2-3个交易日 >=3连板历史妖核；③ QSPool X天Y板(ct>=3)；④ 人气Top30 + (涨停或QSPool强势>=10亿)
        auto_candidates: Dict[str, dict] = {}

        for code, info in zt_by_code.items():
            if info["lbc"] >= 2:
                auto_candidates[code] = {
                    "code": code,
                    "name": info["name"],
                    "hybk": info["hybk"],
                    "entryPrice": info["price"],
                    "entryReason": f"{info['lbc']}连板高标自动跟踪",
                    "newHighCycle": True,
                }

        for day_idx, (_, h_pool) in enumerate(valid_hist):
            min_lbc = 2 if day_idx == 0 else 3
            for row in h_pool:
                code = str(row.get("c", "")).zfill(6)
                name = str(row.get("n", ""))
                lbc_h = int(row.get("lbc") or 1)
                if not is_mainboard_10cm(code, name) or lbc_h < min_lbc:
                    continue
                if code not in auto_candidates:
                    auto_candidates[code] = {
                        "code": code,
                        "name": name,
                        "hybk": str(row.get("hybk") or "其他板块"),
                        "entryPrice": round(_sf(row.get("p")) / 1000.0, 2),
                        "entryReason": f"近{day_idx + 1}日{lbc_h}连板龙头延续跟踪",
                        "newHighCycle": False,
                    }

        for code, info in qs_by_code.items():
            if info["zttjCt"] >= 3 and info["zttjDays"] <= 22:
                if code not in auto_candidates:
                    auto_candidates[code] = {
                        "code": code,
                        "name": info["name"],
                        "hybk": info["hybk"],
                        "entryPrice": info["price"],
                        "entryReason": f"{info['zttjDays']}天{info['zttjCt']}板核心抱团",
                        "newHighCycle": info["lbc"] >= 2,
                    }

        for code, rk in pop_map.items():
            if rk > 30:
                continue
            src = zt_by_code.get(code) or qs_by_code.get(code) or amt_top_by_code.get(code)
            if not src:
                continue
            if code in zt_by_code or (code in qs_by_code and src["amount"] >= 1.0e9) or (src["amount"] >= 2.5e9 and src["chg"] >= 3.0):
                if code not in auto_candidates:
                    auto_candidates[code] = {
                        "code": code,
                        "name": src["name"],
                        "hybk": src["hybk"],
                        "entryPrice": src["price"],
                        "entryReason": f"人气Top{rk}资金抱团核心",
                        "newHighCycle": src.get("lbc", 0) >= 2,
                    }

        # 纳新入池（跳过被手动排除或正处于冷却期的标的，除非今日重启 >=2 连板周期）
        for code, cand in auto_candidates.items():
            if code in active_map:
                if cand.get("hybk") and active_map[code].get("hybk") in ("", "其他板块"):
                    active_map[code]["hybk"] = cand["hybk"]
                continue
            if code in manual_excluded_codes:
                continue
            if code in cooldown_map and not cand.get("newHighCycle"):
                continue
            if len(active_map) >= 48:
                continue
            active_map[code] = {
                "code": code,
                "name": cand["name"],
                "hybk": cand["hybk"],
                "entryDate": actual_date,
                "entryPrice": cand["entryPrice"] if cand["entryPrice"] > 0 else 0.0,
                "entryReason": cand["entryReason"],
                "peakPriceSinceEntry": cand["entryPrice"] if cand["entryPrice"] > 0 else 0.0,
                "pinned": False,
                "autoAdded": True,
            }

        # 准备需批量体检的股票列表（自动池内全部标的 + 未拿过实时价格的人气前40主板股 + 昨日涨停股用于溢价统计）
        pop_need_quote = [
            c for c, rk in sorted(pop_map.items(), key=lambda x: x[1])[:50]
            if c not in zt_by_code and c not in qs_by_code and c not in amt_top_by_code
        ]
        yest_valid_rows = [
            r for r in yesterday_zt
            if str(r.get("c", "")).zfill(6).startswith(("00", "60", "30", "68"))
            and "ST" not in str(r.get("n", "")).upper()
        ] if compute_yesterday_stats else []
        yest_need_quote = [
            str(r.get("c", "")).zfill(6) for r in yest_valid_rows
            if str(r.get("c", "")).zfill(6) not in zt_by_code
            and str(r.get("c", "")).zfill(6) not in qs_by_code
            and str(r.get("c", "")).zfill(6) not in amt_top_by_code
        ]
        herd_codes = list(active_map.keys())
        quote_need_codes = list(dict.fromkeys(herd_codes + pop_need_quote + yest_need_quote))

        kline_sem = asyncio.Semaphore(10)
        batch_quotes, kline_results = await asyncio.gather(
            _fetch_batch_quotes(client, quote_need_codes),
            asyncio.gather(*[_fetch_daily_kline(client, c, kline_sem) for c in herd_codes], return_exceptions=True),
        )
        kline_by_code = {
            c: (res if isinstance(res, list) else [])
            for c, res in zip(herd_codes, kline_results)
        }

        herd_items: List[dict] = []
        newly_evicted: List[dict] = []
        cooldown_until = _shift_date_str(actual_date, 4)

        for code in herd_codes:
            meta = active_map[code]
            rt_q = batch_quotes.get(code)
            zt_q = zt_by_code.get(code)
            qs_q = qs_by_code.get(code)

            base_q = zt_q or qs_q or amt_top_by_code.get(code) or rt_q
            if not base_q:
                continue

            cur_px = rt_q["price"] if rt_q else base_q["price"]
            chg = rt_q["chg"] if rt_q else base_q["chg"]
            amount = rt_q["amount"] if (rt_q and rt_q["amount"] > 0) else base_q.get("amount", 0.0)
            mcap = rt_q["mcap"] if (rt_q and rt_q["mcap"] > 0) else base_q.get("mcap", 0.0)
            turnover = rt_q["turnover"] if (rt_q and rt_q["turnover"] > 0) else base_q.get("turnover", 0.0)
            today_high = rt_q["high"] if rt_q else cur_px
            hybk = (zt_q or qs_q or {}).get("hybk") or meta.get("hybk") or "其他板块"
            raw_meta_name = str(meta.get("name") or "").strip()
            resolved_name = str(base_q.get("name") or "").strip()
            if (not raw_meta_name or raw_meta_name == code) and resolved_name:
                meta["name"] = resolved_name
                name = resolved_name
            else:
                name = raw_meta_name or resolved_name or code
            pop_rk = pop_map.get(code)

            if meta.get("entryPrice", 0.0) <= 0 and cur_px > 0:
                meta["entryPrice"] = cur_px
            meta["hybk"] = hybk

            health = _eval_herd_health(
                code=code,
                cur_px=cur_px,
                today_high=today_high,
                chg=chg,
                days=kline_by_code.get(code, []),
                actual_date=actual_date,
                entry_date=meta.get("entryDate", actual_date),
                stored_peak=float(meta.get("peakPriceSinceEntry") or cur_px),
                pop_rank=pop_rk,
            )
            meta["peakPriceSinceEntry"] = health["peakPrice"]

            entry_px = float(meta.get("entryPrice") or cur_px)
            cum_ret = round(((cur_px - entry_px) / entry_px) * 100, 2) if entry_px > 0 else 0.0

            if health["evict"] and not meta.get("pinned"):
                ev_rec = {
                    "code": code,
                    "name": name,
                    "hybk": hybk,
                    "entryDate": meta.get("entryDate", actual_date),
                    "evictedDate": actual_date,
                    "entryPrice": round(entry_px, 2),
                    "evictPrice": round(cur_px, 2),
                    "returnPct": cum_ret,
                    "chg": chg,
                    "reason": health["evictReason"],
                    "manualExcluded": False,
                    "cooldownUntil": cooldown_until,
                }
                newly_evicted.append(ev_rec)
                active_map.pop(code, None)
                continue

            lbc_now = zt_q["lbc"] if zt_q else 0
            ct_now = max(lbc_now, (qs_q or {}).get("zttjCt", 0))
            days_now = max(lbc_now, (qs_q or {}).get("zttjDays", 0))
            is_nh = bool((qs_q or {}).get("isNewHigh", False))
            is_zt_now = bool(zt_q or chg >= 9.6)

            try:
                dt_e = datetime.datetime.strptime(meta.get("entryDate", actual_date), "%Y%m%d").date()
                dt_a = datetime.datetime.strptime(actual_date, "%Y%m%d").date()
                track_days = max(1, (dt_a - dt_e).days + 1)
            except Exception:
                track_days = 1

            m_info_h = _match_stock_mystic(code, name, active_mystic_roots, code_mystic_map, active_cluster_by_name)
            tags = _build_stock_tags(
                lbc=lbc_now,
                zttj_ct=ct_now,
                zttj_days=days_now,
                is_new_high=is_nh,
                is_limit_up=is_zt_now,
                pop_rank=pop_rk,
                in_herd_pool=True,
                amount=amount,
                chg=chg,
                health_status=health["healthStatus"],
                mystic_info=m_info_h,
            )

            herd_items.append({
                "code": code,
                "tcode": _to_tcode(code),
                "name": name,
                "hybk": hybk,
                "price": round(cur_px, 2),
                "chg": round(chg, 2),
                "amount": amount,
                "mcap": mcap,
                "turnover": turnover,
                "lbc": lbc_now,
                "zttjDays": days_now,
                "zttjCt": ct_now,
                "statTag": f"{days_now}天{ct_now}板" if ct_now >= 3 else (f"{lbc_now}连板" if lbc_now >= 2 else ("首板" if lbc_now == 1 else "抱团追踪")),
                "popRank": pop_rk,
                "entryDate": meta.get("entryDate", actual_date),
                "entryPrice": round(entry_px, 2),
                "entryReason": meta.get("entryReason", ""),
                "cumReturnPct": cum_ret,
                "trackDays": track_days,
                "pinned": bool(meta.get("pinned", False)),
                "autoAdded": bool(meta.get("autoAdded", True)),
                "isLimitUp": is_zt_now,
                "mysticRoots": m_info_h["matchedRoots"] if m_info_h else [],
                "mysticCluster": m_info_h["clusterName"] if m_info_h else "",
                "mysticZtCount": m_info_h["clusterZtCount"] if m_info_h else 0,
                "isMysticResonant": bool(m_info_h and m_info_h.get("isResonant")),
                "tags": tags,
                **health,
            })

        if newly_evicted:
            existing_keys = {(e.get("code"), e.get("evictedDate")) for e in evicted_list}
            for ev in newly_evicted:
                if (ev["code"], ev["evictedDate"]) not in existing_keys:
                    evicted_list.insert(0, ev)
        # 仅保留近 30 条破位淘汰历史，避免文件无限膨胀
        evicted_list = evicted_list[:30]

        state["lastRunDate"] = actual_date
        state["active"] = active_map
        state["evicted"] = evicted_list
        if not read_only_herd:
            _save_herd_state_sync(state)

    # 跟踪池排序：连板加速 / 高横健康优先 -> 警示垫后，同档按今日涨幅与人气排序
    status_order = {"accelerating": 0, "healthy": 1, "warning": 2}
    herd_items.sort(
        key=lambda x: (
            status_order.get(x["healthStatus"], 3),
            -x["lbc"],
            -(x["chg"]),
            x["popRank"] if x.get("popRank") else 999,
        )
    )
    herd_by_code = {x["code"]: x for x in herd_items}

    # 5b. 零额外链路测算【昨日涨停今日溢价（均值+中位数）& 连板晋级率】
    raw_zt_codes_all = {str(r.get("c", "")).zfill(6) for r in raw_zt_pool}
    yest_chgs: List[float] = []
    yest_total_valid = 0
    yest_promoted = 0
    yest_consec_total = 0
    yest_consec_promoted = 0
    if compute_yesterday_stats and yest_valid_rows:
        for yr in yest_valid_rows:
            yc = str(yr.get("c", "")).zfill(6)
            y_lbc = int(yr.get("lbc") or 1)
            q_src = zt_by_code.get(yc) or qs_by_code.get(yc) or amt_top_by_code.get(yc) or batch_quotes.get(yc)
            if q_src is not None:
                yest_chgs.append(round(_sf(q_src.get("chg")), 2))
            yest_total_valid += 1
            promoted = yc in raw_zt_codes_all
            if promoted:
                yest_promoted += 1
            if y_lbc >= 2:
                yest_consec_total += 1
                if promoted:
                    yest_consec_promoted += 1

    yesterday_stats = {
        "premiumMean": round(sum(yest_chgs) / len(yest_chgs), 2) if yest_chgs else None,
        "premiumMedian": round(statistics.median(yest_chgs), 2) if yest_chgs else None,
        "premiumSample": len(yest_chgs),
        "promotionRate": round((yest_promoted / yest_total_valid) * 100.0, 1) if yest_total_valid > 0 else None,
        "promotionSample": f"{yest_promoted}/{yest_total_valid}" if yest_total_valid > 0 else "0/0",
        "consecPromotionRate": round((yest_consec_promoted / yest_consec_total) * 100.0, 1) if yest_consec_total > 0 else None,
        "consecPromotionSample": f"{yest_consec_promoted}/{yest_consec_total}" if yest_consec_total > 0 else "0/0",
    }

    # 6. 构建【强势与抱团多标签总池 (strongPool)】
    strong_codes = set(zt_by_code.keys()) | set(qs_by_code.keys()) | set(herd_by_code.keys()) | {
        c for c, rk in pop_map.items() if rk <= 50
    }
    strong_pool: List[dict] = []
    for code in strong_codes:
        h_info = herd_by_code.get(code)
        zt_info = zt_by_code.get(code)
        qs_info = qs_by_code.get(code)
        amt_info = amt_top_by_code.get(code)
        rt_info = batch_quotes.get(code)

        src = h_info or zt_info or qs_info or amt_info or rt_info
        if not src:
            continue
        name = src.get("name", "")
        if not is_mainboard_10cm(code, name):
            continue

        px = _sf(src.get("price"))
        if px <= 0:
            continue
        chg = round(_sf(src.get("chg")), 2)
        amt = _sf(src.get("amount"))
        mcap = _sf(src.get("mcap"))
        to_v = round(_sf(src.get("turnover")), 2)
        lbc_v = int((zt_info or {}).get("lbc") or 0)
        ct_v = max(lbc_v, int((qs_info or {}).get("zttjCt") or (h_info or {}).get("zttjCt") or 0))
        days_v = max(lbc_v, int((qs_info or {}).get("zttjDays") or (h_info or {}).get("zttjDays") or 0))
        is_nh = bool((qs_info or {}).get("isNewHigh", False))
        is_zt = bool(zt_info or chg >= 9.6)
        pop_rk = pop_map.get(code)
        hybk = (zt_info or qs_info or h_info or amt_info or {}).get("hybk") or "其他板块"
        h_status = (h_info or {}).get("healthStatus", "")
        fbt_str = (zt_info or {}).get("fbt", "—")
        fbt_sec = int((zt_info or {}).get("fbtSec") or 999999)
        fund_v = float((zt_info or {}).get("fund") or 0.0)
        seal_ratio_v = float((zt_info or {}).get("sealRatio") or 0.0)
        zbc_v = int((zt_info or {}).get("zbc") or 0)
        m_info = _match_stock_mystic(code, name, active_mystic_roots, code_mystic_map, active_cluster_by_name)

        tags = _build_stock_tags(
            lbc=lbc_v,
            zttj_ct=ct_v,
            zttj_days=days_v,
            is_new_high=is_nh,
            is_limit_up=is_zt,
            pop_rank=pop_rk,
            in_herd_pool=(h_info is not None),
            amount=amt,
            chg=chg,
            health_status=h_status,
            mystic_info=m_info,
        )
        # 去噪净化：仅保留 >=2维共振标的，或属于自动抱团池/2板以上/人气前25/成交>=35亿/字辈共振>=2的单标签稀缺核心
        is_elite_single = (
            (h_info is not None)
            or lbc_v >= 2
            or (pop_rk is not None and pop_rk <= 25)
            or amt >= 3.5e9
            or bool(m_info and m_info.get("isResonant"))
        )
        if not tags or (len(tags) < 2 and not is_elite_single):
            continue

        id_score, relay_score, score_dims = _compute_dual_scores(
            lbc=lbc_v,
            zttj_ct=ct_v,
            sector_zt_count=sector_zt_counts.get(hybk, 1 if is_zt else 0),
            pop_rank=pop_rk,
            amount=amt,
            turnover=to_v,
            chg=chg,
            is_new_high=is_nh,
            is_limit_up=is_zt,
            in_herd_pool=(h_info is not None),
            health_status=h_status,
            fbt_sec=fbt_sec,
            fund=fund_v,
            seal_ratio=seal_ratio_v,
            zbc=zbc_v,
            mystic_info=m_info,
        )

        stat_tag = (
            f"{days_v}天{ct_v}板"
            if ct_v >= 3 and days_v > lbc_v
            else (f"{lbc_v}连板" if lbc_v >= 2 else ("首板" if lbc_v == 1 else ("60日新高" if is_nh else "强势活跃")))
        )
        strong_pool.append({
            "code": code,
            "tcode": _to_tcode(code),
            "name": name,
            "hybk": hybk,
            "price": round(px, 2),
            "chg": chg,
            "amount": amt,
            "mcap": mcap,
            "turnover": to_v,
            "lbc": lbc_v,
            "fbt": fbt_str,
            "fbtSec": fbt_sec,
            "fund": fund_v,
            "sealRatio": seal_ratio_v,
            "zbc": zbc_v,
            "zttjDays": days_v,
            "zttjCt": ct_v,
            "statTag": stat_tag,
            "popRank": pop_rk,
            "isNewHigh": is_nh,
            "isLimitUp": is_zt,
            "inHerdPool": h_info is not None,
            "herdHealth": h_status,
            "healthLabel": (h_info or {}).get("healthLabel", ""),
            "vsMa5": (h_info or {}).get("vsMa5"),
            "vsMa10": (h_info or {}).get("vsMa10"),
            "ddFromPeak": (h_info or {}).get("ddFromPeak"),
            "mysticRoots": m_info["matchedRoots"] if m_info else [],
            "mysticCluster": m_info["clusterName"] if m_info else "",
            "mysticZtCount": m_info["clusterZtCount"] if m_info else 0,
            "isMysticResonant": bool(m_info and m_info.get("isResonant")),
            "tags": tags,
            "tagCount": len(tags),
            "tagKeys": [t["key"] for t in tags],
            "identityScore": id_score,
            "relayScore": relay_score,
            "scoreDims": score_dims,
            "strongScore": len(tags) * 18 + lbc_v * 14 + ct_v * 8 + (max(0, 80 - pop_rk) if pop_rk else 0) + max(0.0, chg * 2.0),
        })

    strong_pool.sort(key=lambda x: (-len(x["tags"]), -x["relayScore"], -x["identityScore"], -x["amount"]))
    strong_by_code = {x["code"]: x for x in strong_pool}

    # 7. 动态判断【当前主题材 + 题材龙头 + 阶段核心 + 容量核心】
    raw_bks: List[dict] = []
    if not isinstance(res_bk, Exception) and res_bk.status_code == 200:
        try:
            for row in ((res_bk.json().get("data") or {}).get("diff") or []):
                bk_name = str(row.get("f14") or "")
                bk_code = str(row.get("f12") or "")
                bk_chg = _sf(row.get("f3"))
                up_c = int(row.get("f104") or 0)
                dn_c = int(row.get("f105") or 0)
                if not bk_name or not bk_code or any(kw in bk_name for kw in NOISE_CONCEPT_KEYWORDS):
                    continue
                if bk_chg < 1.5 or up_c <= dn_c:
                    continue
                raw_bks.append({
                    "bkCode": bk_code,
                    "name": bk_name,
                    "chg": round(bk_chg, 2),
                    "netFlow": _sf(row.get("f62")),
                    "upCount": up_c,
                    "downCount": dn_c,
                })
        except Exception:
            pass

    top_bks = raw_bks[:8]
    bk_member_reqs = []
    for bk in top_bks:
        bkc = bk["bkCode"]
        u_chg = f"https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=50&po=1&np=1&fltt=2&invt=2&fid=f3&fs=b:{bkc}&fields=f12,f14,f2,f3,f6,f8,f21,f100"
        u_amt = f"https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=20&po=1&np=1&fltt=2&invt=2&fid=f6&fs=b:{bkc}&fields=f12,f14,f2,f3,f6,f8,f21,f100"
        bk_member_reqs.append(client.get(u_chg))
        bk_member_reqs.append(client.get(u_amt))

    bk_resps = await asyncio.gather(*bk_member_reqs, return_exceptions=True) if bk_member_reqs else []

    def _to_role_member(code: str, name: str, px: float, chg: float, amt: float, mcap: float, to_v: float, hybk: str) -> dict:
        zt_m = zt_by_code.get(code)
        qs_m = qs_by_code.get(code)
        lbc_m = (zt_m or {}).get("lbc", 0)
        ct_m = max(lbc_m, (qs_m or {}).get("zttjCt", 0))
        days_m = max(lbc_m, (qs_m or {}).get("zttjDays", 0))
        is_zt_m = bool(zt_m or chg >= 9.6)
        pop_rk = pop_map.get(code)
        return {
            "code": code,
            "tcode": _to_tcode(code),
            "name": name,
            "price": round(px, 2),
            "chg": round(chg, 2),
            "amount": amt,
            "mcap": mcap,
            "turnover": round(to_v, 2),
            "hybk": hybk,
            "lbc": lbc_m,
            "fbt": (zt_m or {}).get("fbt", "—"),
            "fbtSec": (zt_m or {}).get("fbtSec", 999999),
            "zttjCt": ct_m,
            "zttjDays": days_m,
            "statTag": f"{days_m}天{ct_m}板" if ct_m >= 3 else (f"{lbc_m}连板" if lbc_m >= 2 else ("首板" if lbc_m == 1 else ("60日新高" if (qs_m or {}).get("isNewHigh") else "趋势核心"))),
            "isLimitUp": is_zt_m,
            "popRank": pop_rk,
            "inHerdPool": code in herd_by_code,
        }

    theme_cards: List[dict] = []
    seen_theme_signatures = set()
    code_concepts: Dict[str, List[str]] = defaultdict(list)

    for idx, bk in enumerate(top_bks):
        r_chg = bk_resps[idx * 2] if idx * 2 < len(bk_resps) else None
        r_amt = bk_resps[idx * 2 + 1] if idx * 2 + 1 < len(bk_resps) else None
        members_map: Dict[str, dict] = {}
        for resp in (r_chg, r_amt):
            if resp is None or isinstance(resp, Exception) or resp.status_code != 200:
                continue
            try:
                for row in ((resp.json().get("data") or {}).get("diff") or []):
                    code = str(row.get("f12", "")).zfill(6)
                    name = str(row.get("f14", ""))
                    if not is_mainboard_10cm(code, name):
                        continue
                    px = _sf(row.get("f2"))
                    if px <= 0:
                        continue
                    if code not in members_map:
                        members_map[code] = _to_role_member(
                            code=code,
                            name=name,
                            px=px,
                            chg=_sf(row.get("f3")),
                            amt=_sf(row.get("f6")),
                            mcap=_sf(row.get("f21")),
                            to_v=_sf(row.get("f8")),
                            hybk=str(row.get("f100") or bk["name"]),
                        )
            except Exception:
                continue

        members = list(members_map.values())
        for m in members:
            if bk["name"] not in code_concepts[m["code"]]:
                code_concepts[m["code"]].append(bk["name"])
        if len(members) < 2:
            continue
        zt_cnt = sum(1 for m in members if m["isLimitUp"])
        qs_cnt = sum(1 for m in members if m["code"] in qs_by_code and not m["isLimitUp"])
        # 若该概念没有任何主板涨停或强势票且净流出，跳过弱题材
        if zt_cnt == 0 and qs_cnt == 0 and bk["netFlow"] < 0:
            continue

        leader, phase_c, cap_c = _select_theme_roles(members)
        if not leader:
            continue
        # 去重：如果前一个题材选出的龙头与阶段核心完全相同（例如影视概念与短剧互动游戏高度重叠），优先保留最强那个
        sig = (leader["code"], phase_c["code"] if phase_c else "")
        if sig in seen_theme_signatures:
            continue
        seen_theme_signatures.add(sig)

        t_score = round(
            bk["chg"] * 3.0 + zt_cnt * 6.0 + qs_cnt * 2.5 + max(0.0, bk["netFlow"] / 2.0e8) + min(12.0, (leader["lbc"] or 0) * 3.0),
            1,
        )
        theme_cards.append({
            "name": bk["name"],
            "bkCode": bk["bkCode"],
            "sourceType": "概念风口",
            "chg": bk["chg"],
            "netFlow": bk["netFlow"],
            "upCount": bk["upCount"],
            "downCount": bk["downCount"],
            "ztCount": zt_cnt,
            "qsCount": qs_cnt,
            "themeScore": t_score,
            "themeReason": f"板块涨幅 {bk['chg']:+.2f}% · {bk['upCount']}涨/{bk['downCount']}跌 · 主板涨停{zt_cnt}家"
            + (f" · 主力净流入{bk['netFlow'] / 1e8:.1f}亿" if bk["netFlow"] >= 1e8 else ""),
            "roles": {
                "themeLeader": leader,
                "phaseCore": phase_c,
                "capacityCore": cap_c,
            },
        })

    # 同步从 ZTPool + QSPool 的主板行业方向补充前排实体主线（例如汽车零部 11涨停、通用设备 5涨停）
    hybk_groups: Dict[str, Dict[str, dict]] = defaultdict(dict)
    for m in list(zt_by_code.values()) + list(qs_by_code.values()):
        k = m.get("hybk") or "其他板块"
        if k == "其他板块":
            continue
        if m["code"] not in hybk_groups[k]:
            hybk_groups[k][m["code"]] = _to_role_member(
                code=m["code"],
                name=m["name"],
                px=m["price"],
                chg=m["chg"],
                amt=m["amount"],
                mcap=m["mcap"],
                to_v=m["turnover"],
                hybk=k,
            )

    for hy_name, mem_dict in hybk_groups.items():
        members = list(mem_dict.values())
        zt_cnt = sum(1 for m in members if m["isLimitUp"])
        qs_cnt = sum(1 for m in members if not m["isLimitUp"])
        if zt_cnt < 2 and (zt_cnt + qs_cnt) < 4:
            continue
        leader, phase_c, cap_c = _select_theme_roles(members)
        if not leader:
            continue
        sig = (leader["code"], phase_c["code"] if phase_c else "")
        if sig in seen_theme_signatures:
            continue
        seen_theme_signatures.add(sig)
        tot_amt = sum(m["amount"] for m in members)
        avg_chg = round(sum(m["chg"] for m in members) / len(members), 2)
        t_score = round(zt_cnt * 7.5 + qs_cnt * 3.0 + min(15.0, tot_amt / 1.5e9) + (leader["lbc"] or 0) * 3.0, 1)
        theme_cards.append({
            "name": hy_name,
            "bkCode": "",
            "sourceType": "涨停主线",
            "chg": avg_chg,
            "netFlow": 0.0,
            "upCount": len(members),
            "downCount": 0,
            "ztCount": zt_cnt,
            "qsCount": qs_cnt,
            "themeScore": t_score,
            "themeReason": f"主板涨停{zt_cnt}家 + 未板强势{qs_cnt}家 · 板块强势成交 {tot_amt / 1e8:.1f}亿",
            "roles": {
                "themeLeader": leader,
                "phaseCore": phase_c,
                "capacityCore": cap_c,
            },
        })

    theme_cards.sort(key=lambda t: (-t["ztCount"], -t["themeScore"]))
    top_themes = theme_cards[:4]

    # 8. 全市场四大总纲动态判定（剔除创业板/科创板后）
    all_mb_pool = list(
        {
            m["code"]: _to_role_member(
                code=m["code"],
                name=m["name"],
                px=m["price"],
                chg=m["chg"],
                amt=m["amount"],
                mcap=m["mcap"],
                to_v=m["turnover"],
                hybk=m["hybk"],
            )
            for m in (list(zt_by_code.values()) + list(qs_by_code.values()) + list(amt_top_by_code.values()))
        }.values()
    )

    height_leader = None
    phase_core_global = None
    capacity_core_global = None
    if all_mb_pool:
        height_leader = sorted(
            [m for m in all_mb_pool if m["isLimitUp"]] or all_mb_pool,
            key=lambda x: (x["lbc"], -x["fbtSec"], x["amount"]),
            reverse=True,
        )[0]
        height_leader = dict(height_leader)
        height_leader["roleReason"] = f"全场主板最高 {height_leader['lbc']}连板 · {height_leader['hybk']}" if height_leader["lbc"] >= 2 else f"今日涨停先锋 · {height_leader['hybk']}"

        phase_cands = sorted(
            all_mb_pool,
            key=lambda x: (x["zttjCt"] * 30 + x["lbc"] * 12 + (max(0, 110 - x["popRank"]) if x.get("popRank") else 0) + (20 if x["chg"] >= -2.5 else -15)),
            reverse=True,
        )
        phase_pick = phase_cands[0]
        if phase_pick["code"] == height_leader["code"] and len(phase_cands) > 1 and phase_cands[1]["zttjCt"] >= 3:
            phase_pick = phase_cands[1]
        phase_core_global = dict(phase_pick)
        phase_core_global["roleReason"] = (
            (f"{phase_core_global['zttjDays']}天{phase_core_global['zttjCt']}板妖核 · " if phase_core_global["zttjCt"] >= 2 else "")
            + (f"人气#{phase_core_global['popRank']} · " if phase_core_global.get("popRank") else "")
            + f"{phase_core_global['hybk']}"
        )

        cap_cands = [m for m in all_mb_pool if m["chg"] >= 1.0 and m["amount"] >= 1.5e9] or [m for m in all_mb_pool if m["chg"] >= -1.0] or all_mb_pool
        cap_pick = sorted(cap_cands, key=lambda x: (x["amount"] * (1.2 if x["chg"] >= 2.5 else 1.0)), reverse=True)[0]
        capacity_core_global = dict(cap_pick)
        capacity_core_global["roleReason"] = (
            f"成交 {capacity_core_global['amount'] / 1e8:.1f}亿 · 涨 {capacity_core_global['chg']:+.2f}% · {capacity_core_global['hybk']}"
        )

    main_themes = {
        "marketOverview": {
            "topThemeName": top_themes[0]["name"] if top_themes else "轮动分化",
            "topThemeReason": top_themes[0]["themeReason"] if top_themes else "暂无突出单一主线",
            "heightLeader": height_leader,
            "phaseCore": phase_core_global,
            "capacityCore": capacity_core_global,
        },
        "themes": top_themes,
    }

    for sp_item in strong_pool:
        concepts = list(code_concepts.get(sp_item["code"], []))
        if sp_item.get("isMysticResonant") and sp_item.get("mysticCluster"):
            mc_tag = f"字辈·{sp_item['mysticCluster']}"
            if mc_tag not in concepts:
                concepts.append(mc_tag)
        sp_item["concepts"] = concepts
    for h_item in herd_items:
        concepts = list(code_concepts.get(h_item["code"], []))
        if h_item.get("isMysticResonant") and h_item.get("mysticCluster"):
            mc_tag = f"字辈·{h_item['mysticCluster']}"
            if mc_tag not in concepts:
                concepts.append(mc_tag)
        h_item["concepts"] = concepts

    return {
        "strongPool": strong_pool,
        "strongCount": len(strong_pool),
        "herdPool": herd_items,
        "herdCount": len(herd_items),
        "evictedPool": evicted_list,
        "evictedCount": len(evicted_list),
        "mainThemes": main_themes,
        "mysticClusters": mystic_clusters,
        "mysticRootsUsed": active_mystic_roots,
        "yesterdayStats": yesterday_stats,
    }


async def mutate_herd_pool(action: str, code: str, name: str = "", hybk: str = "", price: float = 0.0, reason: str = "") -> dict:
    """支持在自动跟踪池基础上执行手动固定(pin)、手动移出(remove)、从破位区恢复(restore)或手动加池(add)。"""
    code = str(code).strip().zfill(6)
    today_code = datetime.date.today().strftime("%Y%m%d")
    if action in ("add", "restore") and not is_mainboard_10cm(code, name):
        raise ValueError("抱团跟踪池已严格剔除创业板(30)、科创板(68)及ST个股，仅支持00/60主板")

    async with _HERD_FILE_LOCK:
        state = _load_herd_state_sync()
        active_map: Dict[str, dict] = state.get("active", {})
        evicted_list: List[dict] = state.get("evicted", [])

        if action == "add":
            active_map[code] = {
                "code": code,
                "name": name or code,
                "hybk": hybk or "手动跟踪",
                "entryDate": today_code,
                "entryPrice": round(float(price or 0.0), 2),
                "entryReason": reason or "手动加入抱团跟踪",
                "peakPriceSinceEntry": round(float(price or 0.0), 2),
                "pinned": True,
                "autoAdded": False,
            }
            evicted_list = [e for e in evicted_list if str(e.get("code", "")).zfill(6) != code]
        elif action == "remove":
            meta = active_map.pop(code, None)
            cooldown_until = _shift_date_str(today_code, 5)
            ev_rec = {
                "code": code,
                "name": (meta or {}).get("name") or name or code,
                "hybk": (meta or {}).get("hybk") or hybk or "—",
                "entryDate": (meta or {}).get("entryDate", today_code),
                "evictedDate": today_code,
                "entryPrice": (meta or {}).get("entryPrice", 0.0),
                "evictPrice": round(float(price or 0.0), 2),
                "returnPct": 0.0,
                "reason": reason or "手动移出跟踪池",
                "manualExcluded": True,
                "cooldownUntil": cooldown_until,
            }
            evicted_list = [ev_rec] + [e for e in evicted_list if str(e.get("code", "")).zfill(6) != code]
        elif action == "restore":
            ev_match = next((e for e in evicted_list if str(e.get("code", "")).zfill(6) == code), None)
            evicted_list = [e for e in evicted_list if str(e.get("code", "")).zfill(6) != code]
            active_map[code] = {
                "code": code,
                "name": (ev_match or {}).get("name") or name or code,
                "hybk": (ev_match or {}).get("hybk") or hybk or "恢复跟踪",
                "entryDate": today_code,
                "entryPrice": round(float(price or (ev_match or {}).get("evictPrice") or 0.0), 2),
                "entryReason": "从破位淘汰区手动恢复跟踪(已锁定免自动踢出)",
                "peakPriceSinceEntry": round(float(price or (ev_match or {}).get("evictPrice") or 0.0), 2),
                "pinned": True,
                "autoAdded": False,
            }
        elif action == "pin":
            if code in active_map:
                active_map[code]["pinned"] = not bool(active_map[code].get("pinned", False))
        else:
            raise ValueError(f"不支持的操作: {action}")

        state["active"] = active_map
        state["evicted"] = evicted_list[:30]
        _save_herd_state_sync(state)

    return {"ok": True, "action": action, "code": code, "activeCount": len(state["active"])}
