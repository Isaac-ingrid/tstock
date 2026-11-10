from __future__ import annotations

import asyncio
import contextlib
import datetime
import time
from typing import Any, Dict, List, Optional, Tuple
import httpx

from .strong_herd import build_strong_herd_and_themes, parse_mystic_roots

# 内存缓存，TTL 8 秒（盘中毫秒级更新，盘后快速响应）
_LIMITUP_CACHE: Dict[str, Tuple[float, dict]] = {}
_CACHE_LOCK = asyncio.Lock()
CACHE_TTL = 8.0


async def invalidate_limitup_cache() -> None:
    """手动变更抱团跟踪池后立刻失效连板聚合缓存。"""
    async with _CACHE_LOCK:
        _LIMITUP_CACHE.clear()


def format_time_str(val: Any) -> str:
    """格式化 HHMMSS 格式的时间戳为 HH:MM:SS"""
    if not val:
        return "—"
    s = str(val).zfill(6)
    if len(s) >= 6:
        return f"{s[0:2]}:{s[2:4]}:{s[4:6]}"
    return str(val)


async def get_limitup_pool(
    date_str: Optional[str] = None,
    mystic_roots: Optional[str] = None,
    http_client: Optional[httpx.AsyncClient] = None,
) -> dict:
    """
    获取全市场连板天梯、09:25 集合竞价可买池、09:30 开盘冲板扫板池与打板量化推荐
    数据源：
    1. 东方财富涨停题材股池 (getTopicZTPool)
    2. 东方财富全市场 A 股极速行情 (clist/get，用于捕获正在冲击涨停的临界打板票)
    """
    now_ts = time.monotonic()
    today_dt = datetime.date.today()
    today_code = today_dt.strftime("%Y%m%d")
    is_history_mode = bool(date_str and date_str.strip() != today_code)
    target_date = date_str.strip() if date_str else today_code
    roots_list = parse_mystic_roots(mystic_roots)
    roots_key = ",".join(roots_list)

    cache_key = f"limitup_{target_date}_{roots_key}_{1 if is_history_mode else 0}"
    async with _CACHE_LOCK:
        if cache_key in _LIMITUP_CACHE:
            exp, data = _LIMITUP_CACHE[cache_key]
            if exp > now_ts:
                return data
            _LIMITUP_CACHE.pop(cache_key, None)

    client_cm = (
        contextlib.nullcontext(http_client)
        if http_client is not None
        else httpx.AsyncClient(
            timeout=httpx.Timeout(10.0),
            trust_env=False,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Referer": "https://quote.eastmoney.com/",
            },
        )
    )
    async with client_cm as client:
        dates_to_try = [target_date]
        if not date_str:
            for days_back in range(1, 6):
                prev_d = (today_dt - datetime.timedelta(days=days_back)).strftime("%Y%m%d")
                dates_to_try.append(prev_d)

        raw_pool: List[dict] = []
        actual_date = target_date

        # 并行拉取：涨停股池 + 全市场冲板股票（已去除创业板 m:0+t:80 及北交所）
        clist_url = "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:1+t:2,m:1+t:23&fields=f12,f14,f2,f3,f4,f5,f6,f7,f8,f10,f15,f16,f17,f18,f100"

        res_clist = None
        for d_try in dates_to_try:
            zt_url = f"https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=150&sort=fbt:asc&date={d_try}"
            try:
                if res_clist is None or isinstance(res_clist, Exception):
                    res_zt, res_clist = await asyncio.gather(
                        client.get(zt_url),
                        client.get(clist_url),
                        return_exceptions=True,
                    )
                else:
                    res_zt = await client.get(zt_url)
                if not isinstance(res_zt, Exception) and res_zt.status_code == 200:
                    j = res_zt.json()
                    if j.get("rc") == 0 and j.get("data") and j["data"].get("pool"):
                        raw_pool = j["data"]["pool"]
                        actual_date = d_try if date_str else str(j["data"].get("qdate") or d_try)
                        break
            except Exception:
                continue

        if res_clist is None or isinstance(res_clist, Exception):
            try:
                res_clist = await client.get(clist_url)
            except Exception:
                res_clist = None

        # 解析冲板中的临界标的
        raw_rushing: List[dict] = []
        if res_clist is not None and not isinstance(res_clist, Exception) and res_clist.status_code == 200:
            try:
                cj = res_clist.json()
                diff = (cj.get("data") or {}).get("diff", [])
                raw_rushing = diff
            except Exception:
                pass

        # 并行拉取：炸板池(ZBPool)、跌停池(DTPool)、两市涨跌家数(ulist)
        zb_url = f"https://push2ex.eastmoney.com/getTopicZBPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=150&sort=fbt:asc&date={actual_date}"
        dt_url = f"https://push2ex.eastmoney.com/getTopicDTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=150&sort=fund:asc&date={actual_date}"
        breadth_url = "https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=1.000001,0.399001&fields=f104,f105,f106"

        res_zb, res_dt, res_breadth, herd_payload = await asyncio.gather(
            client.get(zb_url),
            client.get(dt_url),
            client.get(breadth_url),
            build_strong_herd_and_themes(
                client,
                actual_date,
                raw_pool,
                mystic_roots=roots_list,
                compute_yesterday_stats=(not is_history_mode),
                read_only_herd=is_history_mode,
            ),
            return_exceptions=True,
        )

        zb_raw_pool: List[dict] = []
        zb_tc = 0
        if not isinstance(res_zb, Exception) and res_zb.status_code == 200:
            try:
                zb_j = res_zb.json()
                if zb_j.get("rc") == 0 and zb_j.get("data"):
                    zb_raw_pool = zb_j["data"].get("pool") or []
                    zb_tc = int(zb_j["data"].get("tc") or len(zb_raw_pool))
            except Exception:
                pass

        dt_tc = 0
        if not isinstance(res_dt, Exception) and res_dt.status_code == 200:
            try:
                dt_j = res_dt.json()
                if dt_j.get("rc") == 0 and dt_j.get("data"):
                    dt_tc = int(dt_j["data"].get("tc") or len(dt_j["data"].get("pool") or []))
            except Exception:
                pass

        up_count = 0
        down_count = 0
        flat_count = 0
        if not isinstance(res_breadth, Exception) and res_breadth.status_code == 200:
            try:
                bj = res_breadth.json()
                b_diff = (bj.get("data") or {}).get("diff", [])
                for row in b_diff:
                    up_count += int(row.get("f104") or 0)
                    down_count += int(row.get("f105") or 0)
                    flat_count += int(row.get("f106") or 0)
            except Exception:
                pass

    # 已涨停标的集合
    zt_codes = set(str(row.get("c", "")).zfill(6) for row in raw_pool)

    # 1. 解析已封板标的 (Limit-Up Pool)
    items = []
    themes_map: Dict[str, List[dict]] = {}

    for row in raw_pool:
        code = str(row.get("c", "")).zfill(6)
        # 去除创业板 (30开头)
        if code.startswith("30"):
            continue
        name = row.get("n", "")
        mkt_code = "sh" if str(row.get("m")) == "1" else ("bj" if str(row.get("m")) == "2" else "sz")
        tcode = f"{mkt_code}{code}"

        raw_px = float(row.get("p", 0.0))
        px = round(raw_px / 1000.0, 2)
        chg = round(float(row.get("zdp", 0.0)), 2)
        amount = float(row.get("amount", 0.0))
        ltsz = float(row.get("ltsz", 0.0))
        hs = round(float(row.get("hs", 0.0)), 2)

        lbc = int(row.get("lbc", 1) or 1)
        fbt_raw = int(row.get("fbt") or 0)
        lbt_raw = int(row.get("lbt") or 0)
        fbt = format_time_str(fbt_raw)
        lbt = format_time_str(lbt_raw)

        fund = float(row.get("fund", 0.0))
        zbc = int(row.get("zbc", 0) or 0)
        hybk = row.get("hybk", "其他板块") or "其他板块"

        zttj = row.get("zttj") or {}
        days_cnt = zttj.get("days", lbc)
        board_cnt = zttj.get("ct", lbc)
        tag_streak = f"{lbc}连板" if lbc > 1 else "首板"
        tag_stat = f"{days_cnt}天{board_cnt}板" if (days_cnt and board_cnt and days_cnt > lbc) else tag_streak

        seal_ratio = round((fund / amount), 2) if amount > 0 else 0.0

        # 实战买入时点分类 (Buy Window Classification)
        # ① 09:25一字顶死（散户根本买不进）
        is_locked_one_word = (fbt_raw <= 92500 and (fund >= 6.0e7 or hs <= 2.5) and zbc == 0)

        # ② 09:25 集合竞价可买（竞价高开放量弱转强/抢筹）
        is_auction_buy = (fbt_raw <= 93200 and hs >= 4.0 and not is_locked_one_word)

        # ③ 09:30~09:40 开盘秒板扫板（极速冲板买点）
        is_rush_buy = (93000 < fbt_raw <= 94000 and zbc == 0)

        # ④ 炸板回封买点（打回封）
        is_reseal_buy = (zbc > 0 and lbt_raw <= 113000)

        # ⑤ 尾盘最后30分钟偷袭板（14:30 及以后首次封板）
        is_late_board = (fbt_raw >= 143000)

        if is_locked_one_word:
            buy_window = "LOCKED"
            buy_tag = "🔒 一字封死 (买不进)"
            buy_action = "主力顶板锁死流动性，场外排单极难成交；切勿追高挂单接飞刀！"
            buy_level = "不可买"
        elif is_auction_buy:
            buy_window = "AUCTION"
            buy_tag = "🌅 09:25 竞价可买"
            buy_action = "09:25 竞价定盘放量超预期，09:30 开盘第一秒直接挂市价单抢筹打入！"
            buy_level = "极佳买点"
        elif is_rush_buy:
            buy_window = "RUSH"
            buy_tag = "⚡ 09:30-09:40 开盘秒板扫板"
            buy_action = "开盘放量直冲涨停，现价达 +8.5%~+9.5% 瞬间挂涨停价扫板打入！"
            buy_level = "极佳买点"
        elif is_reseal_buy:
            buy_window = "RESEAL"
            buy_tag = "🔄 炸板回封打板"
            buy_action = "早盘炸板换手洗盘，分时黄线不破、二次万手大单回封瞬间打板！"
            buy_level = "次优买点"
        elif is_late_board:
            buy_window = "LATE"
            buy_tag = "⚠️ 尾盘偷袭 (不建议打)"
            buy_action = "14:30 以后（最后30分钟）偷袭封单虚弱，次日低开核按钮风险高，严禁打板！"
            buy_level = "观望"
        elif fbt_raw >= 130000:
            buy_window = "NORMAL"
            buy_tag = "⏳ 午后冲板封板"
            buy_action = "午后合力封板（13:00~14:29），关注买一封单硬度与板块助攻，次日防分化。"
            buy_level = "午后观察"
        else:
            buy_window = "NORMAL"
            buy_tag = "🎯 上午冲板封板"
            buy_action = "上午合力封死，观察买一封单变动，次日视开盘竞价决定去留。"
            buy_level = "常规买点"

        # 量化打分 (0 - 100)
        time_score = (
            40 if fbt_raw <= 92500
            else (36 if fbt_raw <= 93500
            else (30 if fbt_raw <= 94000
            else (22 if fbt_raw <= 113000
            else (15 if fbt_raw < 143000 else 8))))
        )
        seal_score = 30 if (seal_ratio >= 1.5 or fund >= 1.5e8) else (24 if (seal_ratio >= 0.8 or fund >= 6.0e7) else (18 if seal_ratio >= 0.3 else 12))
        height_score = 20 if lbc >= 4 else (18 if lbc == 3 else (16 if lbc == 2 else 12))
        to_score = 10 if (5.0 <= hs <= 25.0) else (4 if hs > 35.0 else 6)
        deduct = 8 if zbc == 1 else (18 if zbc >= 2 else 0)
        total_score = max(20, min(100, time_score + seal_score + height_score + to_score - deduct))

        if total_score >= 82 and zbc == 0 and not is_locked_one_word:
            verdict = "🔥 极力推荐打板"
            verdict_cls = "rec-strong"
            risk_level = "低"
            risk_desc = "早盘极速封死且封单巨量，资金合力坚决，次日享受高溢价"
        elif total_score >= 70:
            verdict = "🎯 连板观察接力"
            verdict_cls = "rec-good"
            risk_level = "中"
            risk_desc = "换手良性，梯队身位居前，适合次日冲高做T或排单打板接力"
        elif is_locked_one_word:
            verdict = "💎 一字封死锁筹"
            verdict_cls = "rec-locked"
            risk_level = "低(持股)"
            risk_desc = "全天缩量一字顶死，场外买不进，持股者享受主升溢价"
        elif total_score >= 55:
            verdict = "👀 观望排单"
            verdict_cls = "rec-watch"
            risk_level = "中偏高"
            risk_desc = f"盘中曾有分歧，炸板 {zbc} 次，封成比 {seal_ratio:.2f}倍，防尾盘漏单"
        else:
            verdict = "⚠️ 慎打（弱板防炸）"
            verdict_cls = "rec-warn"
            risk_level = "高"
            risk_desc = f"封单偏弱且炸板 {zbc} 次，午后封板溢价率低，谨防次日核按钮"

        stock_item = {
            "code": code,
            "tcode": tcode,
            "name": name,
            "price": px,
            "chg": chg,
            "amount": amount,
            "mcap": ltsz,
            "turnover": hs,
            "lbc": lbc,
            "fbt": fbt,
            "lbt": lbt,
            "fund": fund,
            "zbc": zbc,
            "hybk": hybk,
            "streakTag": tag_streak,
            "statTag": tag_stat,
            "sealRatio": seal_ratio,
            "score": total_score,
            "verdict": verdict,
            "verdictCls": verdict_cls,
            "riskLevel": risk_level,
            "riskDesc": risk_desc,
            "buyWindow": buy_window,
            "buyTag": buy_tag,
            "buyAction": buy_action,
            "buyLevel": buy_level,
        }
        items.append(stock_item)

        if hybk not in themes_map:
            themes_map[hybk] = []
        themes_map[hybk].append(stock_item)

    items.sort(key=lambda x: (-x["lbc"], x["fbt"], -x["score"]))

    # 2. 解析盘中【冲板临界池】(已去除创业板 30开头；历史复盘日期时不混入今日实时 clist 盘口行情)
    rushing_items = []
    for row in ([] if is_history_mode else raw_rushing):
        code = str(row.get("f12", "")).zfill(6)
        name = str(row.get("f14", ""))
        if code in zt_codes or code.startswith("30") or "ST" in name.upper():
            continue
        if row.get("f2") in (None, "-") or row.get("f3") in (None, "-") or row.get("f18") in (None, "-"):
            continue
        try:
            px = float(row.get("f2", 0.0))
            chg = float(row.get("f3", 0.0))
            prev_close = float(row.get("f18", 0.0))
        except (ValueError, TypeError):
            continue
        if px <= 0 or prev_close <= 0:
            continue

        is_20cm = code.startswith("68")
        ceiling = round(prev_close * (1.20 if is_20cm else 1.10), 2)
        dist_ceiling_pct = round(((ceiling - px) / ceiling) * 100, 2)

        # 满足冲板门槛：主板在 7.0% ~ 9.8% 之间，或科创板在 14.0% ~ 19.8% 之间
        is_rushing_target = (not is_20cm and 7.0 <= chg <= 9.8) or (is_20cm and 14.0 <= chg <= 19.8)
        if not is_rushing_target:
            continue

        turnover = float(row.get("f8", 0.0)) if row.get("f8") not in (None, "-") else 0.0
        amt = float(row.get("f6", 0.0)) if row.get("f6") not in (None, "-") else 0.0
        vr = float(row.get("f10", 1.0)) if row.get("f10") not in (None, "-") else 1.0
        hybk = str(row.get("f100") or "其他板块")

        mkt_code = "sh" if code.startswith(("6", "9")) else "sz"
        tcode = f"{mkt_code}{code}"

        rushing_items.append({
            "code": code,
            "tcode": tcode,
            "name": name,
            "price": px,
            "chg": chg,
            "ceiling": ceiling,
            "distCeiling": dist_ceiling_pct,
            "amount": amt,
            "turnover": turnover,
            "vr": vr,
            "hybk": hybk,
            "buyTag": "⚡ 冲板临界点 (现距涨停仅差 " + f"{dist_ceiling_pct:.1f}%)",
            "buyAction": f"现价 ¥{px:.2f} 距涨停价 ¥{ceiling:.2f} 仅差 {dist_ceiling_pct:.1f}%！若买一买二万手大单推动，挂涨停价 ¥{ceiling:.2f} 扫板打入！",
            "score": round(chg * 8),
            "verdict": "⚡ 冲击涨停中",
        })

    rushing_items.sort(key=lambda x: (x["distCeiling"], -x["amount"]))

    # 按买点窗口快速分类分组
    buy_windows = {
        "auctionBuy": [x for x in items if x["buyWindow"] == "AUCTION"],
        "rushBuy": [x for x in items if x["buyWindow"] == "RUSH"],
        "reSealBuy": [x for x in items if x["buyWindow"] == "RESEAL"],
        "lateBuy": [x for x in items if x["buyWindow"] == "LATE"],
        "locked": [x for x in items if x["buyWindow"] == "LOCKED"],
        "rushing": rushing_items,
    }

    # 天梯分组
    ladder_groups = {
        "high": [x for x in items if x["lbc"] >= 4],
        "board3": [x for x in items if x["lbc"] == 3],
        "board2": [x for x in items if x["lbc"] == 2],
        "board1": [x for x in items if x["lbc"] == 1],
    }

    # 题材风口
    hot_themes = []
    for theme_name, t_stocks in themes_map.items():
        max_lbc = max(s["lbc"] for s in t_stocks) if t_stocks else 1
        t_stocks.sort(key=lambda s: (-s["lbc"], s["fbt"]))
        hot_themes.append({
            "name": theme_name,
            "count": len(t_stocks),
            "maxLbc": max_lbc,
            "leader": t_stocks[0]["name"] if t_stocks else "",
            "stocks": t_stocks,
        })
    hot_themes.sort(key=lambda t: (-t["count"], -t["maxLbc"]))

    max_lbc_val = max((x["lbc"] for x in items), default=1)
    broken_pool_cnt = sum(1 for x in items if x["zbc"] > 0)

    # 3. 解析曾涨停炸板池（ZBPool，剔除创业板 30开头）与市场情绪温度计
    zb_items = []
    for row in zb_raw_pool:
        code = str(row.get("c", "")).zfill(6)
        if code.startswith("30"):
            continue
        name = row.get("n", "")
        px = round(float(row.get("p", 0.0)) / 1000.0, 2)
        ztp = round(float(row.get("ztp", 0.0)) / 1000.0, 2)
        chg = round(float(row.get("zdp", 0.0)), 2)
        hs = round(float(row.get("hs", 0.0)), 2)
        zbc = int(row.get("zbc", 1) or 1)
        hybk = row.get("hybk", "其他板块") or "其他板块"
        drop_pct = round(((px - ztp) / ztp) * 100, 1) if ztp > 0 else 0.0
        zb_items.append({
            "code": code,
            "name": name,
            "price": px,
            "ztPrice": ztp,
            "chg": chg,
            "dropFromTop": drop_pct,
            "hs": hs,
            "zbc": zbc,
            "hybk": hybk,
            "fbt": format_time_str(row.get("fbt", 0)),
        })

    # 情绪统计口径保持全市场真实温度，但连板打板操作池已严格剔除创业板
    zt_count = len(raw_pool)
    zb_count = zb_tc if zb_tc > 0 else len(zb_raw_pool)
    dt_count = dt_tc
    total_zt_attempts = zt_count + zb_count
    broken_rate = round((zb_count / total_zt_attempts) * 100, 1) if total_zt_attempts > 0 else 0.0
    up_ratio = round((up_count / (up_count + down_count)) * 100, 1) if (up_count + down_count) > 0 else 50.0

    # 计算情绪温度计 (0 ~ 100°C)
    breadth_score = max(0.0, min(40.0, (up_ratio - 15.0) * (40.0 / 65.0)))
    zt_score = max(0.0, min(25.0, (zt_count / 80.0) * 25.0))
    ladder_score = max(0.0, min(10.0, (max_lbc_val - 1) * 2.5))
    zb_penalty = max(0.0, (broken_rate - 20.0) * 0.6)
    dt_penalty = min(20.0, dt_count * 1.5)
    stability_score = max(0.0, 25.0 - zb_penalty - dt_penalty)
    temperature = int(round(max(0.0, min(100.0, breadth_score + zt_score + ladder_score + stability_score))))

    # 情绪周期与风控总阀 (GREEN / YELLOW / RED)
    if broken_rate >= 42.0 or dt_count >= 12 or up_ratio < 22.0:
        risk_valve = "RED"
        valve_label = "🔴 红灯退潮熔断"
        valve_action = "全市场严重退潮或系统性杀跌！风控总阀强介入：严禁新开打板仓，底仓做T仅允许逢反抽高抛减仓，切忌抄底接飞刀！"
        cycle_phase = "退潮冰点期" if (dt_count >= 12 or up_ratio < 22.0) else "分歧退潮期"
        valve_color = "#dc2626"
        valve_bg = "#fef2f2"
        valve_border = "#fca5a5"
    elif broken_rate >= 30.0 or dt_count >= 6 or up_ratio < 38.0:
        risk_valve = "YELLOW"
        valve_label = "🟡 黄灯分歧警戒"
        valve_action = "市场分歧炸板抬头（炸板率偏高或局部亏钱效应）！收紧打板标准，仅核心前排可看；做T需严格依托分时均线支撑低吸，不追高。"
        cycle_phase = "高位分歧期" if zt_count >= 45 else "弱势震荡分歧期"
        valve_color = "#d97706"
        valve_bg = "#fffbeb"
        valve_border = "#fde68a"
    else:
        risk_valve = "GREEN"
        valve_label = "🟢 绿灯良性进攻"
        if temperature >= 82 and zt_count >= 85:
            cycle_phase = "高潮过热期"
            valve_action = "情绪高潮普涨（温度≥82°C）！谨防次日一致转分歧，持仓短线股冲高可逐步止盈，不追后排跟风。"
        elif temperature >= 62:
            cycle_phase = "主升发酵期"
            valve_action = "情绪温暖且炸板率受控，赚钱效应极佳！积极抓主流风口主升做T，打板可看前排弱转强。"
        else:
            cycle_phase = "温和启动期"
            valve_action = "市场结构性轮动为主，紧盯强势题材做日内波段T与1进2先锋接力。"
        valve_color = "#16a34a"
        valve_bg = "#f0fdf4"
        valve_border = "#86efac"

    herd_extra = herd_payload if isinstance(herd_payload, dict) else {
        "strongPool": [],
        "strongCount": 0,
        "herdPool": [],
        "herdCount": 0,
        "evictedPool": [],
        "evictedCount": 0,
        "mainThemes": {"marketOverview": {}, "themes": []},
        "mysticClusters": [],
        "mysticRootsUsed": roots_list,
        "yesterdayStats": {},
    }
    y_stats = herd_extra.get("yesterdayStats") or {}
    y_med = y_stats.get("premiumMedian")

    if risk_valve == "RED":
        do_action = "保留现金、逢反抽高抛减仓或做T降本"
        dont_action = "严禁新开打板、禁止高位连板接力、不接飞刀"
    elif risk_valve == "YELLOW":
        do_action = "聚焦抱团高横活口与前排核心，均线低吸做T"
        dont_action = "回避中后排跟风首板、禁止高开无承接硬顶"
        if y_med is not None and y_med <= -1.5 and broken_rate >= 32.0:
            valve_action += "（昨日涨停中位数负溢价，核按钮抬头，务必控仓防面！）"
    else:
        if cycle_phase == "高潮过热期":
            do_action = "持仓前排趁高潮分批兑现、锁住先手利润"
            dont_action = "不追日内后排补涨跟风、警惕次日一致性兑现"
        else:
            do_action = "主线前排弱转强、1进2先锋与抱团中军均线低吸"
            dont_action = "不买无辨识度后排杂毛、规避尾盘偷袭烂板"

    # 按当日情绪总阀与周期阶段校准强势池接力分（cycle 维度）与周期应对建议
    for sp_item in herd_extra.get("strongPool") or []:
        lbc_s = int(sp_item.get("lbc") or 0)
        is_zt_s = bool(sp_item.get("isLimitUp", False))
        in_herd_s = bool(sp_item.get("inHerdPool", False))
        h_stat_s = str(sp_item.get("herdHealth") or "")
        fbt_sec_s = int(sp_item.get("fbtSec") or 999999)
        to_s = float(sp_item.get("turnover") or 0.0)
        zbc_s = int(sp_item.get("zbc") or 0)
        is_one_word = is_zt_s and fbt_sec_s <= 92500 and to_s <= 2.5 and zbc_s == 0

        if risk_valve == "RED":
            if not is_zt_s and in_herd_s and h_stat_s == "healthy":
                c_dim, c_adv = 15, "红灯退潮下的抱团抗跌活口，仅依托均线低吸做T"
            elif lbc_s >= 3:
                c_dim, c_adv = 4, "红灯退潮熔断期，高位连板极易核按钮，严禁接力"
            elif is_zt_s:
                c_dim, c_adv = 6, "红灯退潮熔断期，新开打板赔率极差，观望防补跌"
            else:
                c_dim, c_adv = 8, "红灯退潮熔断期，严控回撤优先保留现金"
        elif risk_valve == "YELLOW":
            if is_one_word:
                c_dim, c_adv = 8, "分歧期一字买不进，开板极易放量补分歧勿硬顶"
            elif not is_zt_s and h_stat_s == "healthy":
                c_dim, c_adv = 16, "黄灯分歧下抱团高横抗跌，均线低吸优于追板"
            elif lbc_s >= 3 and zbc_s == 0:
                c_dim, c_adv = 13, "分歧期前排强活口，高开爆量不封勿追"
            elif lbc_s == 1 and zbc_s >= 2:
                c_dim, c_adv = 8, "分歧期多次炸板首板，次日兑现压力较大"
            elif y_med is not None and y_med <= -1.5 and lbc_s >= 2:
                c_dim, c_adv = 9, "昨日涨停中位数负溢价，警惕次日低开闷杀"
            else:
                c_dim, c_adv = 11, "黄灯分歧去弱留强，仅看前排换手硬板与承接"
        else:
            if cycle_phase == "高潮过热期":
                if is_one_word:
                    c_dim, c_adv = 10, "高潮一致一字无参与点，谨防次日一致转分歧"
                elif lbc_s >= 3:
                    c_dim, c_adv = 14, "高潮期高位辨识度核心，持筹可待次日冲高分化"
                elif is_zt_s and fbt_sec_s >= 143000:
                    c_dim, c_adv = 9, "高潮期尾盘（14:30后）偷袭后排板，次日溢价无保障"
                else:
                    c_dim, c_adv = 13, "高潮过热期（≥82°C），前排待兑现不追后排"
            else:
                if is_one_word:
                    c_dim, c_adv = 12, "进攻期一字领涨定方向，等换手分歧再伺机介入"
                elif lbc_s >= 2 and zbc_s == 0:
                    c_dim, c_adv = 18, "绿灯进攻期前排无炸硬板，主流换手接力首选"
                elif is_zt_s and fbt_sec_s <= 103000:
                    c_dim, c_adv = 16, "早盘主动抢筹封板，良性周期重点跟踪弱转强"
                elif not is_zt_s and h_stat_s == "healthy":
                    c_dim, c_adv = 15, "进攻期抱团高横趋势核心，均线低吸做T皆宜"
                else:
                    c_dim, c_adv = 13, "良性周期聚焦主线前排与量价配合标的"

        s_dims = sp_item.get("scoreDims") or {}
        r_dims = s_dims.get("relay") or {}
        old_c = int(r_dims.get("cycle", 12))
        r_dims["cycle"] = c_dim
        sp_item["relayScore"] = max(10, min(100, int(sp_item.get("relayScore") or 50) + (c_dim - old_c)))
        sp_item["cycleAdvice"] = c_adv

    if herd_extra.get("strongPool"):
        herd_extra["strongPool"].sort(
            key=lambda x: (-len(x.get("tags") or []), -int(x.get("relayScore") or 0), -int(x.get("identityScore") or 0), -float(x.get("amount") or 0))
        )

    sentiment = {
        "temperature": temperature,
        "cyclePhase": cycle_phase,
        "riskValve": risk_valve,
        "valveLabel": valve_label,
        "valveAction": valve_action,
        "doAction": do_action,
        "dontAction": dont_action,
        "valveColor": valve_color,
        "valveBg": valve_bg,
        "valveBorder": valve_border,
        "limitUpCount": zt_count,
        "brokenBoardCount": zb_count,
        "brokenRate": broken_rate,
        "limitDownCount": dt_count,
        "upCount": up_count,
        "downCount": down_count,
        "flatCount": flat_count,
        "upRatio": up_ratio,
        "maxLadder": max_lbc_val,
        "yesterdayPremiumMean": y_stats.get("premiumMean"),
        "yesterdayPremiumMedian": y_stats.get("premiumMedian"),
        "yesterdayPremiumSample": y_stats.get("premiumSample", 0),
        "promotionRate": y_stats.get("promotionRate"),
        "promotionSample": y_stats.get("promotionSample", "0/0"),
        "consecPromotionRate": y_stats.get("consecPromotionRate"),
        "consecPromotionSample": y_stats.get("consecPromotionSample", "0/0"),
    }

    result = {
        "ok": True,
        "date": actual_date,
        "isHistory": is_history_mode,
        "totalCount": len(items),
        "rushingCount": len(rushing_items),
        "maxLadder": max_lbc_val,
        "brokenCount": broken_pool_cnt,
        "zbCount": zb_count,
        "dtCount": dt_count,
        "sentiment": sentiment,
        "items": items,
        "rushingPool": rushing_items,
        "zbPool": zb_items,
        "buyWindows": buy_windows,
        "ladder": ladder_groups,
        "hotThemes": hot_themes,
        **herd_extra,
        "updatedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }

    async with _CACHE_LOCK:
        _LIMITUP_CACHE[cache_key] = (now_ts + CACHE_TTL, result)

    return result
