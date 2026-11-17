from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"
OUT_DIR = ROOT_DIR / "选股引擎" / "out"

# A股知名玄学字辈与情绪模因谱系注册表
CLAN_REGISTRY = [
    {
        "key": "dongfang",
        "name": "东方系",
        "pattern": r"东方",
        "desc": "A股历史最悠久的知名妖股宗族，从东方通信、东方财富到东方精工、东方锆业、日出东方",
        "icon": "🌅",
    },
    {
        "key": "ri_yang",
        "name": "日/阳字辈",
        "pattern": r"[日阳]",
        "desc": "光耀大地与朝阳情绪代表，日出东方、阳光照明、日盈电子、阳谷华泰等",
        "icon": "☀️",
    },
    {
        "key": "guang",
        "name": "光字辈",
        "pattern": r"光",
        "desc": "光学、光伏、光刻机跨题材穿透宗族，欧菲光、波长光电、光华科技等",
        "icon": "⚡",
    },
    {
        "key": "hua",
        "name": "华字辈",
        "pattern": r"华",
        "desc": "中华国运与硬核自主代表，华映科技、华力创通、华胜天成、华西股份、华锡有色等",
        "icon": "🇨🇳",
    },
    {
        "key": "zhong",
        "name": "中字头/中系",
        "pattern": r"^中",
        "desc": "国家队巨无霸与防守反击锚点，中科曙光、中兴通讯、中国卫通、中际旭创等",
        "icon": "🏛️",
    },
    {
        "key": "long",
        "name": "生肖·龙族",
        "pattern": r"龙",
        "desc": "A股图腾级炒作宗族，圣龙股份、天龙股份、锋龙股份、川发龙蟒、飞龙股份等",
        "icon": "🐉",
    },
    {
        "key": "she_chuan",
        "name": "生肖·蛇/川系",
        "pattern": r"[蛇蟒川]",
        "desc": "蛇年预期与西南资本先锋，川发龙蟒、川润股份、长川科技等",
        "icon": "🐍",
    },
    {
        "key": "hai",
        "name": "海字辈",
        "pattern": r"海",
        "desc": "海纳百川大游资偏爱族群，海能达、海立股份、东方海洋、海欣食品等",
        "icon": "🌊",
    },
    {
        "key": "tong_xin",
        "name": "通/信家族",
        "pattern": r"[通信]",
        "desc": "算力通信与信息主升暗线，常山北明、广联达、烽火通信、剑桥科技等",
        "icon": "📡",
    },
    {
        "key": "jin",
        "name": "金字辈",
        "pattern": r"金",
        "desc": "富贵金运与周期弹性宗族，金杯汽车、汇金科技、金鸿顺、金龙汽车等",
        "icon": "🪙",
    },
    {
        "key": "bao",
        "name": "宝字辈",
        "pattern": r"宝",
        "desc": "跨年吉祥物与跨年妖股常客，兔宝宝、恒宝股份、宝鼎科技、宝丽迪等",
        "icon": "💎",
    },
    {
        "key": "heng_tai_sheng",
        "name": "恒/泰/盛字辈",
        "pattern": r"[恒泰盛]",
        "desc": "永恒昌盛与民营龙脉，盛合晶微、泰豪科技、恒久科技等",
        "icon": "🏮",
    },
    {
        "key": "ke_chuang",
        "name": "科字辈",
        "pattern": r"科",
        "desc": "硬核科技与泛科技连板常客，科森科技、欧陆通、科创信息等",
        "icon": "🔬",
    },
    {
        "key": "di_fang",
        "name": "地脉概念(川/港/洲/江)",
        "pattern": r"[川港洲江]",
        "desc": "地域抱团与政策风口映射，川大智胜、连云港、株洲冶炼等",
        "icon": "🗺️",
    },
]

# 编译正则提高速度
for item in CLAN_REGISTRY:
    item["_regex"] = re.compile(item["pattern"])


def _load_latest_market_snapshot() -> List[Dict[str, Any]]:
    """寻找并加载全市场最新快照行情（优先 选股引擎/out/tail-snapshot-*.json，降级 data/latest.json）"""
    snapshot_files = sorted(
        [f for f in os.listdir(OUT_DIR) if f.startswith("tail-snapshot-") and f.endswith(".json")],
        reverse=True,
    ) if OUT_DIR.exists() else []

    if snapshot_files:
        latest_file = OUT_DIR / snapshot_files[0]
        try:
            with open(latest_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                rows = data.get("rows", [])
                if rows:
                    return rows
        except Exception:
            pass

    # 降级从 data/latest.json 提取 candidates, tail 等
    latest_json_path = DATA_DIR / "latest.json"
    if latest_json_path.exists():
        try:
            with open(latest_json_path, "r", encoding="utf-8") as f:
                lj = json.load(f)
                merged: Dict[str, Dict[str, Any]] = {}
                for k in ["tail", "candidates", "recommendations", "steady"]:
                    for item in lj.get(k, []):
                        code = item.get("code") or item.get("raw")
                        if code and code not in merged:
                            merged[code] = {
                                "code": code,
                                "raw": re.sub(r"\D", "", str(code)),
                                "name": item.get("name", ""),
                                "price": float(item.get("price") or item.get("buy") or 0),
                                "chgPct": float(item.get("changePct") or item.get("chgPct") or 0),
                                "turnover": float(item.get("turnover") or 0),
                                "amount": float(item.get("amount") or 0),
                                "volRatio": float(item.get("volRatio") or 1.0),
                            }
                return list(merged.values())
        except Exception:
            pass

    return []


def get_meme_radar_overview() -> Dict[str, Any]:
    """生成全市场玄学字辈共振全景榜单"""
    rows = _load_latest_market_snapshot()
    total_market_stocks = len(rows)

    clan_stats: List[Dict[str, Any]] = []

    for item in CLAN_REGISTRY:
        reg = item["_regex"]
        matches = [r for r in rows if reg.search(r.get("name", ""))]
        if not matches:
            continue

        count = len(matches)
        ups = [m for m in matches if (m.get("chgPct") or 0) > 0]
        downs = [m for m in matches if (m.get("chgPct") or 0) < 0]
        zts = [m for m in matches if (m.get("chgPct") or 0) >= 9.8]
        dts = [m for m in matches if (m.get("chgPct") or 0) <= -9.8]

        up_ratio = round((len(ups) / count) * 100, 1)
        avg_chg = round(sum((m.get("chgPct") or 0) for m in matches) / count, 2)
        total_amount = sum((m.get("amount") or 0) for m in matches)
        total_amount_yi = round(total_amount / 1e8, 2)

        # 排序寻找龙头
        sorted_by_gain = sorted(matches, key=lambda x: (x.get("chgPct") or 0), reverse=True)
        leader = sorted_by_gain[0] if sorted_by_gain else None

        # 筛选低位蓄势潜伏小弟（涨幅在 -2% ~ +5.5% 之间，未大幅透支，换手适中）
        ambush_candidates = []
        for m in sorted_by_gain:
            chg = m.get("chgPct") or 0
            to = m.get("turnover") or 0
            px = m.get("price") or 0
            # 排除已涨停或冲高过大的
            if -3.0 <= chg <= 5.5 and px > 0:
                ambush_candidates.append({
                    "code": m.get("code") or m.get("raw"),
                    "raw": m.get("raw") or re.sub(r"\D", "", str(m.get("code"))),
                    "name": m.get("name"),
                    "price": round(px, 2),
                    "chgPct": round(chg, 2),
                    "turnover": round(to, 2),
                    "volRatio": round(m.get("volRatio") or 1.0, 2),
                })
                if len(ambush_candidates) >= 5:
                    break

        # 综合热度评分 (涨停权重最高 + 上涨比例 + 均涨 + 成交额)
        heat_score = (
            len(zts) * 35.0
            + up_ratio * 0.4
            + (avg_chg + 5.0) * 2.5
            + min(total_amount_yi / 20.0, 15.0)
        )

        # 判定宗族共振状态
        if len(zts) >= 2 or (len(zts) >= 1 and up_ratio >= 35.0):
            status = "🔥 宗族爆发 (全族共振)"
            status_tag = "BOOM"
            status_desc = f"族内有 {len(zts)} 只封板，红盘率 {up_ratio}%，主线资金形成强共识合力！"
        elif len(zts) >= 1 and up_ratio < 28.0:
            status = "⚡ 龙头独秀 (注意防孤狼)"
            status_tag = "LONE_LEADER"
            status_desc = f"带头大哥强势，但族内小弟跟风一般（红盘率仅{up_ratio}%），谨防小弟跟不上导致龙头分歧！"
        elif avg_chg > -1.0 and up_ratio >= 30.0:
            status = "🌱 蓄势待发"
            status_tag = "WARM"
            status_desc = f"族内红盘率稳定在 {up_ratio}%，平均跌幅收窄，具备底部补涨轮动潜力。"
        else:
            status = "❄️ 冰点分歧"
            status_tag = "COLD"
            status_desc = f"当前缺乏主线资金聚焦，板块整体跟随大盘弱势整理。"

        clan_stats.append({
            "key": item["key"],
            "name": item["name"],
            "desc": item["desc"],
            "icon": item["icon"],
            "total": count,
            "ups": len(ups),
            "downs": len(downs),
            "limitUps": len(zts),
            "limitDowns": len(dts),
            "upRatio": up_ratio,
            "avgChg": avg_chg,
            "totalAmountYi": total_amount_yi,
            "heatScore": round(heat_score, 1),
            "status": status,
            "statusTag": status_tag,
            "statusDesc": status_desc,
            "leader": {
                "code": leader.get("code") or leader.get("raw"),
                "raw": leader.get("raw") or re.sub(r"\D", "", str(leader.get("code"))),
                "name": leader.get("name"),
                "price": round(leader.get("price") or 0, 2),
                "chgPct": round(leader.get("chgPct") or 0, 2),
                "turnover": round(leader.get("turnover") or 0, 2),
            } if leader else None,
            "topStocks": [
                {
                    "code": s.get("code") or s.get("raw"),
                    "raw": s.get("raw") or re.sub(r"\D", "", str(s.get("code"))),
                    "name": s.get("name"),
                    "price": round(s.get("price") or 0, 2),
                    "chgPct": round(s.get("chgPct") or 0, 2),
                    "turnover": round(s.get("turnover") or 0, 2),
                }
                for s in sorted_by_gain[:4]
            ],
            "ambushCandidates": ambush_candidates,
        })

    # 按热度降序排列
    clan_stats.sort(key=lambda x: x["heatScore"], reverse=True)

    return {
        "ok": True,
        "marketTotalStocks": total_market_stocks,
        "clansCount": len(clan_stats),
        "clans": clan_stats,
        "topClan": clan_stats[0] if clan_stats else None,
    }


def diagnose_stock_meme(query: str) -> Dict[str, Any]:
    """诊断任意单只股票的玄学宗族血统、共振强度与是否属于孤狼自嗨"""
    q = (query or "").strip().upper()
    if not q:
        return {"ok": False, "message": "请输入股票代码或名称"}

    rows = _load_latest_market_snapshot()
    if not rows:
        return {"ok": False, "message": "未找到市场快照行情数据"}

    # 定位个股
    target = None
    for r in rows:
        raw_code = str(r.get("raw", "")).upper()
        full_code = str(r.get("code", "")).upper()
        name = str(r.get("name", "")).upper()
        if q == raw_code or q in full_code or q in name:
            target = r
            break

    if not target:
        return {"ok": False, "message": f"未在全市场快照中找到标的: {query}"}

    target_name = target.get("name", "")
    target_raw = target.get("raw") or re.sub(r"\D", "", str(target.get("code", "")))
    target_chg = target.get("chgPct") or 0.0
    target_price = target.get("price") or 0.0

    # 匹配其属于的所有宗族
    matched_clans: List[Dict[str, Any]] = []
    for item in CLAN_REGISTRY:
        if item["_regex"].search(target_name):
            # 获取该宗族在该快照中的所有其他股票
            brothers = [r for r in rows if item["_regex"].search(r.get("name", ""))]
            zts = [b for b in brothers if (b.get("chgPct") or 0) >= 9.8]
            ups = [b for b in brothers if (b.get("chgPct") or 0) > 0]
            avg_chg = sum((b.get("chgPct") or 0) for b in brothers) / len(brothers) if brothers else 0
            
            # 寻找大哥
            sorted_brothers = sorted(brothers, key=lambda x: (x.get("chgPct") or 0), reverse=True)
            leader = sorted_brothers[0] if sorted_brothers else None
            is_leader = leader and (leader.get("raw") == target_raw or leader.get("name") == target_name)

            matched_clans.append({
                "clanKey": item["key"],
                "clanName": item["name"],
                "icon": item["icon"],
                "totalBrothers": len(brothers),
                "risingBrothers": len(ups),
                "limitUpBrothers": len(zts),
                "clanAvgChg": round(avg_chg, 2),
                "isLeader": is_leader,
                "leader": {
                    "name": leader.get("name") if leader else "",
                    "raw": leader.get("raw") if leader else "",
                    "chgPct": leader.get("chgPct") if leader else 0,
                } if leader else None,
            })

    # 综合体检判定
    if not matched_clans:
        verdict_type = "NEUTRAL"
        verdict_title = "⚪ 独立特行标的（无显著字辈玄学标签）"
        verdict_sop = "该股不依赖名字或字辈玄学共振，其走势主要由自身基本面、所属行业板块景气度或技术面量价驱动。操作时请完全依据七格箱体、做T点位与均线系统严格执行。"
    else:
        primary_clan = matched_clans[0]
        # 判断是孤狼还是真共振
        if target_chg >= 5.0 and primary_clan["limitUpBrothers"] <= 1 and primary_clan["risingBrothers"] <= 3:
            verdict_type = "LONE_WOLF"
            verdict_title = "⚠️ 警惕孤狼单打（假玄学冲高一日游风险）"
            verdict_sop = f"【{target_name}】今日大幅脉冲，但同宗【{primary_clan['clanName']}】无其他兄弟跟风（仅{primary_clan['risingBrothers']}只红盘），属于典型的七哥所说的‘孤狼共振’！主力单兵突进自拉自唱，次日冲高回落熄火概率极高，切忌追高，持有者宜见好就收分批冲高做T减仓！"
        elif primary_clan["isLeader"] and target_chg >= 9.8:
            verdict_type = "FLAGSHIP_LEADER"
            verdict_title = f"👑 宗族空间盘眼 / {primary_clan['clanName']}带头大哥"
            verdict_sop = f"【{target_name}】今日强势封板，成功扛起【{primary_clan['clanName']}】领头大旗！只要该股明日不出现无量跌停或大幅开板，整个【{primary_clan['clanName']}】的低位蓄势小弟都将拥有溢价轮动补涨预期。"
        elif primary_clan["limitUpBrothers"] >= 1 and target_chg < 5.0 and target_chg >= -2.0:
            verdict_type = "AMBUSH_OPPORTUNITY"
            verdict_title = f"🌱 宗族共振支撑 · 低位补涨蓄势标的"
            verdict_sop = f"【{target_name}】所属的【{primary_clan['clanName']}】已有大哥【{primary_clan['leader']['name']}】涨停打开空间，而该股目前涨幅仅 {target_chg:+.2f}%，处在安全防守区，兼具宗族共振溢价与盈亏比安全垫，适合依托五日线低吸潜伏或日内做T！"
        else:
            verdict_type = "NORMAL_CLAN"
            verdict_title = f"🏷️ 归属【{primary_clan['clanName']}】宗族体系"
            verdict_sop = f"该股具备【{primary_clan['clanName']}】模因属性，当前宗族平均涨跌幅为 {primary_clan['clanAvgChg']:+.2f}%。建议密切盯防宗族龙头【{primary_clan['leader']['name']}】的连板高度与换手走势。"

    return {
        "ok": True,
        "stock": {
            "name": target_name,
            "raw": target_raw,
            "price": target_price,
            "chgPct": target_chg,
        },
        "matchedClans": matched_clans,
        "verdict": {
            "type": verdict_type,
            "title": verdict_title,
            "sop": verdict_sop,
        },
    }
