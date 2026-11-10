from __future__ import annotations

import asyncio
import datetime
import re
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx
from .limitup import get_limitup_pool

# 内存缓存，避免频繁请求上游 (TTL 15 秒)
_DIAGNOSIS_CACHE: Dict[str, Tuple[float, dict]] = {}
_DIAG_CACHE_LOCK = asyncio.Lock()
CACHE_TTL_SECONDS = 15.0


def calc_ema(values: List[float], period: int) -> List[float]:
    if not values:
        return []
    k = 2.0 / (period + 1)
    emas = [values[0]]
    for v in values[1:]:
        emas.append(v * k + emas[-1] * (1.0 - k))
    return emas


def calc_macd(closes: List[float]) -> Dict[str, Any]:
    if len(closes) < 26:
        return {"dif": 0.0, "dea": 0.0, "hist": 0.0, "isGolden": False, "isBullHist": False, "isDead": False}
    ema12 = calc_ema(closes, 12)
    ema26 = calc_ema(closes, 26)
    difs = [a - b for a, b in zip(ema12, ema26)]
    deas = calc_ema(difs, 9)
    hists = [(d - e) * 2.0 for d, e in zip(difs, deas)]
    dif, dea, hist = difs[-1], deas[-1], hists[-1]
    prev_dif = difs[-2] if len(difs) >= 2 else dif
    prev_dea = deas[-2] if len(deas) >= 2 else dea
    prev_hist = hists[-2] if len(hists) >= 2 else hist
    is_golden = (prev_dif <= prev_dea and dif > dea) or (dif > dea and hist > prev_hist and hist > 0)
    is_dead = (prev_dif >= prev_dea and dif < dea) or (dif < dea and hist < 0)
    return {
        "dif": round(dif, 3),
        "dea": round(dea, 3),
        "hist": round(hist, 3),
        "isGolden": is_golden,
        "isBullHist": hist > 0 and hist >= prev_hist,
        "isDead": is_dead,
    }


def calc_rsi(closes: List[float], period: int = 6) -> float:
    if len(closes) < period + 1:
        return 50.0
    deltas = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    recent = deltas[-period:]
    gains = [d for d in recent if d > 0]
    losses = [-d for d in recent if d < 0]
    avg_gain = sum(gains) / period
    avg_loss = sum(losses) / period
    if avg_loss == 0:
        return 100.0 if avg_gain > 0 else 50.0
    rs = avg_gain / avg_loss
    return round(100.0 - (100.0 / (1.0 + rs)), 1)


def classify_announcement(title: str) -> Tuple[str, str]:
    """根据公告标题分类并评级：返回 (level, tag)"""
    red_keywords = [
        ("减持", "减持风险"),
        ("立案", "立案调查"),
        ("警示函", "监管警示"),
        ("退市", "退市风险"),
        ("亏损", "业绩预亏"),
        ("下修", "业绩下修"),
        ("冻结", "司法冻结"),
        ("诉讼", "重大诉讼"),
        ("违规", "违规问责"),
        ("逾期", "债务逾期"),
        ("强制执行", "司法风险"),
        ("重整", "破产重整"),
    ]
    yellow_keywords = [
        ("质押", "股权质押"),
        ("解禁", "解禁提示"),
        ("异常波动", "异动警示"),
        ("严重异常波动", "异动监管"),
        ("停牌", "停牌核查"),
        ("询价", "转让提示"),
        ("问询函", "监管问询"),
        ("关注函", "交易所关注"),
    ]
    green_keywords = [
        ("预增", "业绩预增"),
        ("扭亏", "业绩扭亏"),
        ("中标", "重大中标"),
        ("合同", "重大合同"),
        ("增持", "股东增持"),
        ("回购", "回购股份"),
        ("投资设立", "对外投资"),
        ("合作", "战略合作"),
        ("获批", "产品获批"),
        ("分红", "权益分派"),
    ]

    # 若为“减持结果/实施完毕/时间届满/不减持”，实属利空出尽或已落地历史，降级为提示而非高危否决雷
    if "减持" in title and any(k in title for k in ("结果", "完毕", "届满", "终止", "放弃", "不减持", "未减持")):
        return "yellow", "减持完结"

    for kw, tag in red_keywords:
        if kw in title:
            return "red", tag
    for kw, tag in green_keywords:
        if kw in title:
            return "green", tag
    for kw, tag in yellow_keywords:
        if kw in title:
            return "yellow", tag
    return "gray", "常规"


def build_comprehensive_decision(
    quote: dict,
    chips: dict,
    technicals: dict,
    intraday: dict,
    second_wave: dict,
    sector_ecology: dict,
    matched_hot_themes: list,
    red_flags: list,
    yellow_alerts: list,
    green_catalysts: list,
    market_sentiment: dict,
    atr_profile: Optional[dict] = None,
    experimental_dna: Optional[dict] = None,
) -> dict:
    """
    结合公告排雷、技术均线趋势、筹码位置、日内分时VWAP与板块/大盘情绪，
    综合评估：1.综合评分(0-100)；2.能不能买；3.风险如何；4.现在是不是买点及挂单计划。
    """
    cur_px = float(quote.get("price", 0.0) or 0.0)
    pe = float(quote.get("pe", 0.0) or 0.0)
    buy_ratio = float(quote.get("buyRatio", 50.0) or 50.0)

    positive_points: List[str] = []
    risk_points: List[str] = []

    # ---- 维度1：基本面与公告排雷 (满分 20) ----
    fund_score = 16
    if green_catalysts:
        fund_score += 3
        positive_points.append(f"近期存在利好催化公告（{green_catalysts[0]['tag']}：{green_catalysts[0]['title'][:20]}）")
    else:
        positive_points.append("近30天未排查到减持、立案调查或退市类高危利空公告")

    if yellow_alerts:
        fund_score -= 3
        risk_points.append(f"存在 {len(yellow_alerts)} 条提示性公告（如{yellow_alerts[0]['tag']}），需留意资金态度")
    if red_flags:
        fund_score -= 13
        risk_points.append(f"🚨 高危公告雷区（{red_flags[0]['tag']}）：{red_flags[0]['title'][:24]}")
    if pe < 0:
        fund_score -= 3
        risk_points.append("当前动态市盈率为负（公司业绩处于亏损区间）")
    elif pe > 120:
        fund_score -= 1
        risk_points.append(f"当前市盈率偏高（PE {pe:.1f}），估值安全边际较薄")
    fund_score = max(0, min(20, fund_score))
    fund_desc = "存在严重利空雷区" if red_flags else ("有催化且无重大雷区" if green_catalysts else "基本面公告整体平稳")

    # ---- 维度2：技术趋势与均线安全 (满分 25) ----
    trend_status = technicals.get("trendStatus", "均线交织整理")
    is_bull = bool(technicals.get("isBullAlign", False))
    is_broken = bool(technicals.get("isBrokenDown", False))
    is_doji = bool(technicals.get("isBottomDoji", False))
    is_ignition = bool(technicals.get("isVolIgnition", False))
    is_macd_golden = bool(technicals.get("isMacdGolden", False))
    rsi6 = float(technicals.get("rsi6", 50.0) or 50.0)

    if is_bull:
        trend_score = 21
        positive_points.append("日线处于多头主升排列（MA5 > MA10 > MA20），中期趋势占优")
    elif trend_status == "回踩支撑震荡":
        trend_score = 17
        positive_points.append("现价稳站在 20 日均线生命线上方，属于趋势内回踩支撑区")
    elif is_broken:
        trend_score = 5
        risk_points.append("🚨 跌破 MA20 与 MA60 形成破位空头下行，均线系统呈反压态，严禁左侧盲目抄底")
        if is_doji:
            trend_score += 4
            positive_points.append("破位下方出现缩量止跌十字星/长下影试探信号，存在反抽修复预期")
        if rsi6 <= 25:
            trend_score += 3
            positive_points.append(f"6日 RSI 跌至 {rsi6:.1f}（深度超卖区），短线乖离存在超跌反弹需求")
    else:
        trend_score = 13

    if is_macd_golden or is_ignition:
        trend_score += 2
        if is_ignition:
            positive_points.append("日K线呈现放量阳线点火启动形态")
        elif is_macd_golden:
            positive_points.append("MACD 呈现金叉或红柱放大，短期多头动能恢复")

    if rsi6 >= 78:
        trend_score -= 4
        risk_points.append(f"6日 RSI 达 {rsi6:.1f}（短线严重超买钝化），追高极易触发回吐")
    trend_score = max(0, min(25, trend_score))
    trend_desc = f"{trend_status} · RSI6={rsi6:.1f}"

    # ---- 维度3：筹码结构与量价配合 (满分 20) ----
    box_pos = float(chips.get("boxPos", 50.0) or 50.0)
    profit_ratio = float(chips.get("profitRatio", 50.0) or 50.0)
    stage_tag = second_wave.get("stageTag", "normal")
    is_stagnation = bool(technicals.get("isHighStagnation", False))
    chg5d = float(technicals.get("chg5d", 0.0) or 0.0)

    chip_score = 13
    if stage_tag == "golden_second":
        chip_score += 6
        positive_points.append("二波黄金蓄势形态（首轮主升后缩量回踩支撑，抛压已充分沉淀）")
    elif stage_tag == "dead":
        chip_score -= 6
        risk_points.append("高位深度回撤破位，二波逻辑已被证伪，上方套牢盘解套抛压沉重")

    if box_pos <= 42 and not is_broken:
        chip_score += 3
        positive_points.append(f"当前股价处于 20 日箱体中下沿（{box_pos:.0f}%分位），上方阻力距离较充裕")

    if is_stagnation or (chg5d >= 20.0 and profit_ratio >= 88.0):
        chip_score -= 7
        risk_points.append(f"近5日涨幅 {chg5d:+.1f}% 且高位放量滞涨/获利盘高达 {profit_ratio:.0f}%，谨防主力高位派发接盘")

    if profit_ratio < 20.0 and is_broken:
        chip_score -= 4
        risk_points.append(f"当前获利筹码不足 {profit_ratio:.1f}%，上方 80% 筹码处于套牢状态，反弹阻力大")

    chip_score = max(0, min(20, chip_score))
    chip_desc = f"箱体分位 {box_pos:.0f}% · 获利盘 {profit_ratio:.0f}%"

    # ---- 维度4：分时盘口与资金承接 (满分 20) ----
    p_type = intraday.get("patternType", "chop")
    vwap_diff = float(intraday.get("vwapDiff", 0.0) or 0.0)
    intraday_amp = float(intraday.get("amp", 0.0) or 0.0)

    if p_type in ("rebound", "bull"):
        if vwap_diff >= 3.0:
            intraday_score = 12
            risk_points.append(f"现价偏离分时黄线（VWAP）达 +{vwap_diff:.2f}%，日内追高乖离率过大")
        else:
            intraday_score = 17 + (2 if buy_ratio >= 53 else 0)
            positive_points.append(f"日内分时站稳 VWAP 均价线（外盘主动买盘占比 {buy_ratio:.1f}%），承接良好")
    elif p_type == "chop":
        intraday_score = 12 + (2 if buy_ratio >= 52 else 0)
    elif p_type == "flat":
        intraday_score = 9
        risk_points.append(f"今日分时振幅仅 {intraday_amp:.2f}%，波动空间太窄导致做T和短线难以盈利")
    elif p_type in ("dump", "bear"):
        intraday_score = 4
        if p_type == "dump":
            risk_points.append("🚨 早盘脉冲拉升后跌破分时均价黄线（典型钓鱼诱多出货形态），分时受压明显")
        else:
            risk_points.append("全天分时白线被均价黄线反压，日内空头主导下跌中继")
    else:
        intraday_score = 11

    intraday_score = max(0, min(20, intraday_score))
    intraday_desc = intraday.get("pattern", "分时数据有限")[:18]

    # ---- 维度5：题材风口与大盘情绪共振 (满分 15) ----
    sec_role = sector_ecology.get("role", "")
    sec_chg = float(sector_ecology.get("sectorChg", 0.0) or 0.0)
    risk_valve = market_sentiment.get("riskValve", "GREEN") if market_sentiment else "GREEN"
    broken_rate = float(market_sentiment.get("brokenRate", 0.0) or 0.0) if market_sentiment else 0.0

    env_score = 8
    if matched_hot_themes:
        env_score += 4
        positive_points.append(f"属于今日热门题材【{matched_hot_themes[0]['name']}】")
        if "龙头" in sec_role or "中军" in sec_role:
            env_score += 2
            positive_points.append(f"在板块中处于核心领涨身位（{sec_role}）")
        elif "杂毛" in sec_role:
            env_score -= 2
            risk_points.append("在板块中处于后排跟风滞涨杂毛身位，缺乏主力核心呵护")
    elif sec_chg <= -1.5:
        env_score -= 2
        risk_points.append(f"所属行业今日整体弱势回调（{sec_chg:.2f}%）")

    if risk_valve == "RED":
        env_score -= 4
        risk_points.append(f"🚨 今日全市场风控总阀亮红灯（炸板率 {broken_rate:.1f}%），系统性退潮拖累大")
    elif risk_valve == "YELLOW":
        env_score -= 1
        risk_points.append(f"大盘情绪总阀处于黄灯分歧状态（炸板率 {broken_rate:.1f}%），须收敛仓位")
    elif risk_valve == "GREEN":
        env_score += 1

    env_score = max(0, min(15, env_score))
    env_desc = f"{'热点主线' if matched_hot_themes else '非主线'} · 大盘{market_sentiment.get('valveLabel', '正常') if market_sentiment else '平稳'}"

    # 总分汇总
    total_score = fund_score + trend_score + chip_score + intraday_score + env_score

    # ---- 实验性弱参考指标提取（股性适配、左侧胜率防御与追高纠偏） ----
    t3_pct = int(experimental_dna["tFriendly3Pct"]) if experimental_dna and "tFriendly3Pct" in experimental_dna else None
    dip_tot = int(experimental_dna.get("dipTotal", 0) or 0) if experimental_dna else 0
    dip_win_rate = int(experimental_dna.get("dipWinRate", 50) or 0) if experimental_dna else 50
    dip_avg_reb = float(experimental_dna.get("dipAvgRebound", 0.0) or 0.0) if experimental_dna else 0.0
    gap_up_tot = int(experimental_dna.get("gapUpTotal", 0) or 0) if experimental_dna else 0
    gap_up_smash = int(experimental_dna.get("gapUpSmashRate", 0) or 0) if experimental_dna else 0
    dna_tag = str(experimental_dna.get("dnaTag", "") or "") if experimental_dna else ""

    atr14_val = float(atr_profile.get("atr14", 0.0) or 0.0) if atr_profile else 0.0
    atr_pct_val = float(atr_profile.get("atrPct", 0.0) or 0.0) if atr_profile else 0.0
    avg_amp14 = float(atr_profile.get("avgIntraAmp14", 0.0) or 0.0) if atr_profile else 0.0
    adaptive_grid_val = float(atr_profile.get("adaptiveGrid", 1.33) or 1.33) if atr_profile else 1.33

    style_fit = ""
    style_fit_level = "balanced"
    if (t3_pct is not None and t3_pct < 35) or (atr_profile and avg_amp14 < 2.2):
        style_fit_level = "narrow"
        low_pct_txt = f"近半年仅 {t3_pct}% 交易日振幅≥3%" if t3_pct is not None else f"14日均振幅仅 {avg_amp14:.2f}%"
        style_fit = f"🛡️ 稳健慢波股（{low_pct_txt}，不适合高频做T或超短追涨）"
    elif (t3_pct is not None and t3_pct >= 65) or (atr_profile and avg_amp14 >= 4.8):
        style_fit_level = "high_vol"
        amp_txt = f"14日均振幅 {avg_amp14:.2f}%" if atr_profile else f"近半年振幅≥3%占 {t3_pct}%"
        style_fit = f"⚡ 高弹性活跃股（{amp_txt}，做T空间充裕但止损需防宽幅洗盘）"
    elif atr_profile or experimental_dna:
        style_fit_level = "balanced"
        amp_txt = f"14日均振幅 {avg_amp14:.2f}% / 适配网格 {adaptive_grid_val:.2f}%" if atr_profile else f"振幅达标率 {t3_pct}%"
        style_fit = f"⚖️ 均衡波动股（{amp_txt}，适配常规波段与日内做T）"

    if style_fit_level == "narrow":
        narrow_reason = f"近半年仅{t3_pct}%日振幅≥3%" if t3_pct is not None else f"14日ATR仅{atr_pct_val:.2f}%"
        risk_points.append(f"🐢 [弱参考·股性偏慢] {narrow_reason}，短线弹性不足，频繁做T易被规费磨损")
    if dip_tot >= 6 and dip_win_rate <= 35:
        risk_points.append(f"🧊 [弱参考·左侧慎抄底] 近半年深探≥1.8%共{dip_tot}次，当日反抽胜率仅{dip_win_rate}%，少做左侧接飞刀")
    if gap_up_tot >= 6 and gap_up_smash >= 62:
        risk_points.append(f"🎭 [弱参考·忌高开追涨] 近半年高开{gap_up_tot}次有{gap_up_smash}%收阴回落，切忌早盘追高接盘")
    if dip_tot >= 6 and dip_win_rate >= 62 and not red_flags and not is_broken:
        positive_points.append(f"🧬 [弱参考·抗跌基因] 近半年深探{dip_tot}次有{dip_win_rate}%当日V起反抽≥1.2%（均抽+{dip_avg_reb:.2f}%）")

    # ---- 核心判定：能不能买？现在是不是买点？风险如何？ ----
    is_buy_point_now = False
    can_buy_level = "WAIT"
    can_buy_verdict = "👀 暂以观望为主"
    timing_headline = "⏳ 当前暂非理想买点"
    timing_analysis = ""
    risk_rating = "中等风险"
    risk_color = "yellow"
    suggested_position = "0% ~ 15%"

    if red_flags:
        can_buy_level = "NO_BUY"
        can_buy_verdict = "🚫 存在高危公告雷区 · 严禁买入"
        is_buy_point_now = False
        timing_headline = "❌ 明确非买点（基本面公告一票否决）"
        timing_analysis = f"近30天检测到重大利空（{red_flags[0]['tag']}），随时面临机构踩踏与估值重杀，无论技术形态如何均禁止接入！"
        risk_rating = "极高风险"
        risk_color = "red"
        suggested_position = "0% (空仓回避)"
    elif is_broken and not (is_doji or is_ignition):
        can_buy_level = "NO_BUY"
        can_buy_verdict = "🚫 技术破位下行 · 严禁盲目抄底"
        is_buy_point_now = False
        timing_headline = "❌ 当前不是买点（处于破位下降通道）"
        timing_analysis = "现价跌破 MA20 与 MA60 关键支撑，均线空头排列反压。左侧无底不言底，建议等待放量重新站回 MA20 之上再评估！"
        risk_rating = "高风险"
        risk_color = "red"
        suggested_position = "0% (空仓等待止跌)"
    elif p_type in ("dump", "bear"):
        can_buy_level = "WAIT"
        can_buy_verdict = "⚠️ 日内分时受压/诱多 · 暂勿介入"
        is_buy_point_now = False
        timing_headline = "❌ 此刻不是买点（分时被黄线压制 / 疑似诱多）"
        timing_analysis = (
            f"分时图显示现价运行在 VWAP 均价线（¥{intraday.get('vwap', cur_px):.2f}）下方且承接乏力"
            + ("，早盘脉冲诱多后持续滑落" if p_type == "dump" else "")
            + "，此时买入极易被套在日内高点！请等放量站稳均价黄线后再看。"
        )
        risk_rating = "偏高风险"
        risk_color = "red"
        suggested_position = "0% (等待分时转强)"
    elif is_stagnation or rsi6 >= 80 or vwap_diff >= 3.0:
        can_buy_level = "WAIT"
        can_buy_verdict = "👀 短期偏热过乖离 · 切忌追高接盘"
        is_buy_point_now = False
        timing_headline = "⏳ 标的较强但“现在不是追涨买点”"
        timing_analysis = (
            f"当前存在追高风险（"
            + (f"偏离分时黄线 +{vwap_diff:.2f}%" if vwap_diff >= 3.0 else f"6日RSI={rsi6:.1f}超买/高位放量滞涨")
            + f"），贸然入场容易买在情绪高潮点。耐心等待回踩分时均线 ¥{intraday.get('vwap', cur_px):.2f} 或 MA5 支撑再考虑低吸。"
        )
        risk_rating = "中高风险"
        risk_color = "yellow"
        suggested_position = "0% ~ 10% (等回踩再买)"
    elif risk_valve == "RED" and total_score < 78:
        can_buy_level = "WAIT"
        can_buy_verdict = "🟡 大盘红灯退潮 · 暂缓新开仓"
        is_buy_point_now = False
        timing_headline = "⏳ 个股尚可但大盘亮红灯，暂缓买入"
        timing_analysis = f"全市场炸板率高达 {broken_rate:.1f}% 处于系统性退潮期，泥沙俱下环境下即便个股不差也容易补跌，建议管住手等待情绪回暖。"
        risk_rating = "偏高风险"
        risk_color = "yellow"
        suggested_position = "0% ~ 10% (防守观望)"
    elif total_score >= 75:
        can_buy_level = "STRONG_BUY"
        can_buy_verdict = "🔥 综合评优 · 具备较高介入价值"
        is_buy_point_now = True
        timing_headline = "✅ 当前正处于高胜率买点窗口"
        timing_analysis = (
            f"多方维度综合得分 {total_score} 分：无公告地雷，日线趋势稳健，筹码位置合理，且日内分时站稳黄线承接良好（主动买盘占比 {buy_ratio:.0f}%）。可依托理想区间分批低吸介入。"
        )
        risk_rating = "中低风险" if risk_valve == "GREEN" else "中等风险"
        risk_color = "green"
        suggested_position = "30% ~ 50% (分批介入，严守止损)" if risk_valve == "GREEN" else "20% ~ 30% (轻仓试错)"
    elif total_score >= 60:
        if dip_tot >= 6 and dip_win_rate <= 35:
            can_buy_level = "WAIT"
            can_buy_verdict = "👀 历史单边阴跌基因 · 建议等待右侧放量确认"
            is_buy_point_now = False
            timing_headline = "⏳ 暂缓左侧低吸（等右侧放量确认）"
            timing_analysis = (
                f"综合评分虽达 {total_score} 分，但近半年 {dip_tot} 次深水探底后当日反抽胜率仅 {dip_win_rate}%（承接惯性偏弱）。"
                "为防左侧接飞刀，建议耐心等待分时放量站稳均价黄线后再行右侧跟随。"
            )
            risk_rating = "偏高风险"
            risk_color = "yellow"
            suggested_position = "0% ~ 15% (等右侧放量确认)"
        else:
            can_buy_level = "BUY_DIP"
            can_buy_verdict = "🎯 可择机低吸试错 · 严守止损"
            is_buy_point_now = True
            timing_headline = "✅ 具备分时回踩低吸试错条件"
            timing_analysis = (
                f"综合评分 {total_score} 分（合格偏强），未见严重破位与主力出货信号。建议不要市价急躁追高，挂单在分时均线与箱体支撑交汇区间轻仓试错。"
            )
            risk_rating = "中等风险"
            risk_color = "green"
            suggested_position = "20% ~ 30% (轻仓低吸试错)"
    else:
        can_buy_level = "WAIT" if total_score >= 45 else "NO_BUY"
        can_buy_verdict = "👀 综合评分平庸 · 建议继续观望" if total_score >= 45 else "🚫 评分不及格 · 回避不买"
        is_buy_point_now = False
        timing_headline = "⏳ 暂未形成明确买点（共振不足）"
        timing_analysis = f"综合得分仅 {total_score} 分，趋势、量能或题材共振力度不够，强行买入缺乏盈亏比优势，建议筛选更高分标的。"
        risk_rating = "中高风险" if total_score >= 45 else "高风险"
        risk_color = "yellow" if total_score >= 45 else "red"
        suggested_position = "0% (观望为主)"

    # 软性纪律附加提醒（绝不推翻一票否决结论）
    if gap_up_tot >= 6 and gap_up_smash >= 62 and can_buy_level in ("STRONG_BUY", "BUY_DIP", "WAIT"):
        timing_analysis += f" 【基因提醒】近半年高开后有{gap_up_smash}%概率冲高回落，切忌早盘高开追买，仅限分时回踩承接位挂单。"
    if style_fit_level == "narrow" and can_buy_level in ("STRONG_BUY", "BUY_DIP"):
        pct_hint = f"{t3_pct}%" if t3_pct is not None else "偏少数"
        timing_analysis += f" 【股性提醒】近半年仅{pct_hint}交易日振幅≥3%，更适合中线波段持有，不适合高频做T。"

    # ---- 实战参考价位带 (Trade Plan，优先结合 14日ATR 动态校准) ----
    vwap = float(intraday.get("vwap", 0.0) or cur_px)
    ma5 = float(chips.get("ma5", 0.0) or cur_px)
    ma20 = float(chips.get("ma20", 0.0) or cur_px)
    box_bot = float(chips.get("boxBot", 0.0) or cur_px * 0.94)
    box_top = float(chips.get("boxTop", 0.0) or cur_px * 1.08)
    avg_cost = float(chips.get("avgCost", 0.0) or cur_px)

    if cur_px > 0:
        vwap_ref = vwap if vwap > 0 else cur_px
        ideal_high = round(min(cur_px, vwap_ref) * 1.002, 2)
        if atr14_val > 0:
            support_anchor = min(ma20, ma5, vwap_ref)
            ideal_low = round(max(box_bot * 0.992, support_anchor - 0.50 * atr14_val), 2)
            if ideal_low >= ideal_high:
                ideal_low = round(ideal_high - max(0.45 * atr14_val, ideal_high * 0.012), 2)
            ideal_low = max(round(cur_px * 0.88, 2), ideal_low)
            stop_loss = round(min(box_bot, ma20) - 1.20 * atr14_val, 2)
            if stop_loss >= ideal_low * 0.985:
                stop_loss = round(ideal_low - max(1.00 * atr14_val, ideal_low * 0.025), 2)
            stop_loss = max(0.01, stop_loss)
            target_1 = round(max(box_top, cur_px + 1.80 * atr14_val, avg_cost * 1.02), 2)
            calibration_note = (
                f"已按 14日ATR (¥{atr14_val:.2f} / {atr_pct_val:.2f}%) 动态校准低吸缓冲与 1.2×ATR 抗洗盘止损带宽"
                + (f" · 基因：{dna_tag}" if dna_tag else "")
            )
        else:
            ideal_low = round(max(box_bot * 0.995, min(ma20, ma5, vwap_ref) * 0.985), 2)
            if ideal_low > ideal_high:
                ideal_low = round(ideal_high * 0.975, 2)
            stop_loss = round(min(box_bot, ma20) * 0.97, 2)
            if stop_loss >= ideal_low:
                stop_loss = round(ideal_low * 0.96, 2)
            target_1 = round(max(box_top, cur_px * 1.05, avg_cost * 1.02), 2)
            calibration_note = "按默认均线与箱体百分比区间测算（K线样本不足暂未启用 ATR 动态校准）"
    else:
        ideal_low = ideal_high = stop_loss = target_1 = 0.0
        calibration_note = ""

    score_breakdown = [
        {"name": "基本面与排雷", "score": fund_score, "max": 20, "desc": fund_desc},
        {"name": "趋势与均线安全", "score": trend_score, "max": 25, "desc": trend_desc},
        {"name": "筹码与量价结构", "score": chip_score, "max": 20, "desc": chip_desc},
        {"name": "分时盘口与承接", "score": intraday_score, "max": 20, "desc": intraday_desc},
        {"name": "题材与大盘环境", "score": env_score, "max": 15, "desc": env_desc},
    ]

    return {
        "totalScore": total_score,
        "scoreBreakdown": score_breakdown,
        "canBuyLevel": can_buy_level,
        "canBuyVerdict": can_buy_verdict,
        "isBuyPointNow": is_buy_point_now,
        "timingHeadline": timing_headline,
        "timingAnalysis": timing_analysis,
        "riskRating": risk_rating,
        "riskColor": risk_color,
        "styleFit": style_fit,
        "styleFitLevel": style_fit_level,
        "positivePoints": positive_points[:6],
        "riskPoints": risk_points[:6],
        "tradePlan": {
            "currentPrice": round(cur_px, 2),
            "idealBuyLow": ideal_low,
            "idealBuyHigh": ideal_high,
            "stopLossPrice": stop_loss,
            "targetPrice1": target_1,
            "suggestedPosition": suggested_position,
            "calibrationNote": calibration_note,
        },
    }


def build_wechat_summary(diag: dict) -> str:
    """生成排版精美的微信问股/诊断回复文本"""
    q = diag.get("quote", {})
    comp = diag.get("company", {})
    chips = diag.get("chips", {})
    intra = diag.get("intraday", {})
    wave = diag.get("secondWave", {})
    sec = diag.get("sectorEcology", {})
    dec = diag.get("decision", {})
    ap = diag.get("atrProfile") or {}

    name = q.get("name", "该股")
    code = q.get("code", "")
    px = q.get("price", 0.0)
    chg = q.get("chg", 0.0)
    to = q.get("turnover", 0.0)
    cap = q.get("cap", 0.0)

    lines = [
        f"📊【{name} ({code}) 智能诊股报告】",
        f"🔹 现价: ¥{px:.2f} ({chg:+.2f}%) ｜ 换手: {to:.2f}% ｜ 流通: {cap:.1f}亿",
    ]

    if dec:
        tp = dec.get("tradePlan", {})
        lines.extend([
            "",
            f"🏆 综合评分: {dec.get('totalScore', 0)}/100分 ｜ 风险: {dec.get('riskRating', '—')}",
            f"🎯 买入建议: {dec.get('canBuyVerdict', '—')}",
            *( [f"🎭 股性适配: {dec['styleFit']}"] if dec.get("styleFit") else [] ),
            f"⏱️ 时点判断: {dec.get('timingHeadline', '—')}",
            f"  └ {dec.get('timingAnalysis', '')}",
            f"📌 参考计划: 低吸参考 ¥{tp.get('idealBuyLow', 0):.2f}~¥{tp.get('idealBuyHigh', 0):.2f} ｜ 止损 ¥{tp.get('stopLossPrice', 0):.2f} ｜ 压力 ¥{tp.get('targetPrice1', 0):.2f}",
            *( [f"📏 ATR参考: 14日ATR ¥{ap.get('atr14', 0):.2f} ({ap.get('atrPct', 0):.2f}%) ｜ 适配格距 {ap.get('adaptiveGrid', 1.33):.2f}%"] if ap else [] ),
        ])

    lines.extend([
        "",
        f"🌊【板块生态与二波预期】:",
        f"  · 题材风口: {diag.get('themeStatus', '—')}",
    ])

    if sec:
        lines.append(f"  · 板块生态: 今日涨跌 {sec.get('sectorChg', 0):+.2f}% ({sec.get('upCount', 0)}涨/{sec.get('downCount', 0)}跌) ｜ 个股定位: {sec.get('role', '—')}")

    if wave:
        lines.append(f"  · 轮动周期: {wave.get('stage', '—')}")
        lines.append(f"  · 二波潜力: {wave.get('secondWavePotential', '—')} (首轮波幅 +{wave.get('wave1Amplitude', 0)}%, 高位回撤 {wave.get('drawdown', 0)}%)")

    if intra:
        lines.append("")
        lines.append("📈【全天分时日内态势】:")
        lines.append(f"  · VWAP均价: ¥{intra.get('vwap', 0):.2f} (偏离 {intra.get('vwapDiff', 0):+.2f}%) ｜ 振幅: {intra.get('amp', 0):.2f}%")
        lines.append(f"  · 分时形态: {intra.get('pattern', '—')} (线上占比 {intra.get('aboveRatio', 0):.0f}%)")

    lines.append("")
    lines.append(f"🚨【排雷评级】: {diag.get('riskLevel', '—')}")

    if diag.get("redFlags"):
        lines.append("  ⚠️ 近期利空预警:")
        for rf in diag["redFlags"][:2]:
            lines.append(f"   · [{rf['date']}] {rf['title'][:26]}")
    elif diag.get("riskLevel") == "安全":
        lines.append("  🟢 近30天无重大立案、减持违规或退市风险。")

    if chips:
        lines.append("")
        lines.append("🎯【筹码与技术结构】:")
        lines.append(f"  · 20日箱体: ¥{chips.get('boxBot', 0):.2f} ~ ¥{chips.get('boxTop', 0):.2f} (位置 {chips.get('boxPos', 50):.0f}%)")
        lines.append(f"  · 筹码均价: ¥{chips.get('avgCost', 0):.2f} ｜ 获利盘: {chips.get('profitRatio', 0):.1f}%")

    sts = diag.get("shortTermStatus")
    if sts:
        lines.append("")
        lines.append("⚡【今日短线身位与接力雷达】:")
        status_parts = []
        if sts.get("statTag"):
            status_parts.append(sts["statTag"])
        if sts.get("identityScore") is not None and sts.get("relayScore") is not None:
            status_parts.append(f"身份分 {sts['identityScore']} / 接力分 {sts['relayScore']}")
        if sts.get("inHerdPool"):
            status_parts.append(f"抱团池:{sts.get('herdLabel', '跟踪中')}")
        if sts.get("isMysticResonant") and sts.get("mysticCluster"):
            status_parts.append(f"玄学字辈:{sts['mysticCluster']}({sts.get('mysticZtCount', 0)}板)")
        if sts.get("isBrokenBoard"):
            status_parts.append(f"曾炸板{sts.get('zbc', 0)}次")
        if status_parts:
            lines.append("  · 状态: " + " ｜ ".join(status_parts))
        if sts.get("cycleAdvice"):
            lines.append(f"  · 周期应对: {sts['cycleAdvice']}")

    lines.append("")
    lines.append("💡【做T自救与操作处方】:")
    for adv in diag.get("prescriptions", [])[:3]:
        lines.append(f"  {adv}")

    lines.append("")
    lines.append("—— 来自 T-Stock 个股全景诊断工具")
    return "\n".join(lines)


async def _fetch_diag_kline_days(
    client: httpx.AsyncClient,
    tcode: str,
    em_secid: str,
    limit: int = 120,
) -> List[list]:
    """多源拉取前复权日K（优先东方财富 push2his，回退 web.ifzq / ifzq 防腾讯云 WAF 501）。"""
    em_url = (
        f"https://push2his.eastmoney.com/api/qt/stock/kline/get"
        f"?secid={em_secid}&fields1=f1,f2,f3,f4,f5,f6"
        f"&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&end=20500101&lmt={limit}"
    )
    try:
        r_em = await client.get(em_url, headers={"Referer": "https://quote.eastmoney.com/"})
        if r_em.status_code == 200 and r_em.text.lstrip().startswith("{"):
            klines = (r_em.json().get("data") or {}).get("klines") or []
            parsed: List[list] = []
            for row in klines:
                pts = str(row).split(",")
                if len(pts) >= 6:
                    parsed.append([pts[0], pts[1], pts[2], pts[3], pts[4], pts[5]])
            if len(parsed) >= 20:
                return parsed
    except Exception:
        pass

    for host in ("web.ifzq.gtimg.cn", "ifzq.gtimg.cn"):
        u = f"https://{host}/appstock/app/fqkline/get?param={tcode},day,,,{limit},qfq"
        try:
            r_tx = await client.get(u, headers={"Referer": "https://gu.qq.com/"})
            if r_tx.status_code == 200 and r_tx.text.lstrip().startswith("{"):
                j = r_tx.json()
                node = (j.get("data") or {}).get(tcode) or {}
                days = node.get("qfqday") or node.get("day") or []
                if days:
                    return days
        except Exception:
            continue
    return []


async def get_stock_diagnosis(code: str) -> dict:
    """获取股票的全景诊断聚合数据（行情、排雷公告、板块风口、身位生态、二波预期、分时VWAP、筹码处方）"""
    code = str(code).strip().zfill(6)
    now = time.monotonic()

    # 1. 查缓存
    async with _DIAG_CACHE_LOCK:
        if code in _DIAGNOSIS_CACHE:
            exp, data = _DIAGNOSIS_CACHE[code]
            if exp > now:
                return data
            _DIAGNOSIS_CACHE.pop(code, None)

    mkt = "sh" if code.startswith(("6", "9")) else ("sz" if code.startswith(("0", "2", "3")) else "bj")
    tcode = f"{mkt}{code}"
    secucode = f"{code}.SH" if mkt == "sh" else (f"{code}.SZ" if mkt == "sz" else f"{code}.BJ")
    em_secid = f"1.{code}" if mkt == "sh" else f"0.{code}"
    mkt_upper = mkt.upper()

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(9.0),
        trust_env=False,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        },
    ) as client:
        # 并发请求多维度公开数据接口（日K已切东财push2his主用 + web.ifzq回退，避免ifzq WAF 501）
        q_url = f"https://qt.gtimg.cn/q={tcode}"
        ann_url = f"https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=30&page_index=1&ann_type=A&stock_list={code}"
        concept_url = f"https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_F10_CORETHEME_BOARDTYPE&columns=SECUCODE,BOARD_NAME,BOARD_TYPE,BOARD_RANK,IS_PRECISE&filter=(SECUCODE=%22{secucode}%22)&pageSize=50&pageNumber=1&sortColumns=BOARD_RANK&sortTypes=1"
        survey_url = f"https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/CompanySurveyAjax?code={mkt_upper}{code}"
        hot_bk_url = "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=80&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:3+f:!50&fields=f12,f14,f2,f3,f62,f128,f140,f104,f105"
        min_url = f"https://ifzq.gtimg.cn/appstock/app/minute/query?code={tcode}"
        ind_url = f"https://push2.eastmoney.com/api/qt/stock/get?secid={em_secid}&fields=f57,f58,f127,f128"

        reqs = [
            client.get(q_url),
            client.get(ann_url),
            client.get(concept_url, headers={"Referer": "https://data.eastmoney.com/"}),
            client.get(survey_url, headers={"Referer": "https://emweb.securities.eastmoney.com/"}),
            client.get(hot_bk_url, headers={"Referer": "https://quote.eastmoney.com/"}),
            _fetch_diag_kline_days(client, tcode, em_secid, 120),
            client.get(min_url),
            get_limitup_pool(),
            client.get(ind_url, headers={"Referer": "https://quote.eastmoney.com/"}),
        ]

        resps = await asyncio.gather(*reqs, return_exceptions=True)

    def _sf(v: Any, d: float = 0.0) -> float:
        try:
            return float(v) if v not in (None, "", "-") else d
        except (ValueError, TypeError):
            return d

    # 1. 实时行情解析
    q_resp = resps[0]
    quote_data = {
        "name": "未知标的",
        "code": code,
        "tcode": tcode,
        "price": 0.0,
        "prevClose": 0.0,
        "open": 0.0,
        "high": 0.0,
        "low": 0.0,
        "chg": 0.0,
        "turnover": 0.0,
        "pe": 0.0,
        "pb": 0.0,
        "cap": 0.0,
        "totalCap": 0.0,
        "outerVol": 0.0,
        "innerVol": 0.0,
        "buyRatio": 50.0,
        "vr": 1.0,
        "amtWan": 0.0,
    }
    if not isinstance(q_resp, Exception) and q_resp.status_code == 200:
        parts = q_resp.text.split("~")
        if len(parts) > 45:
            outer_v = _sf(parts[7])
            inner_v = _sf(parts[8])
            buy_ratio = round((outer_v / (outer_v + inner_v)) * 100, 1) if (outer_v + inner_v) > 0 else 50.0
            quote_data = {
                "name": parts[1],
                "code": code,
                "tcode": tcode,
                "price": _sf(parts[3]),
                "prevClose": _sf(parts[4]),
                "open": _sf(parts[5]),
                "high": _sf(parts[33]),
                "low": _sf(parts[34]),
                "chg": _sf(parts[32]),
                "turnover": _sf(parts[38]),
                "pe": _sf(parts[39]),
                "pb": _sf(parts[46]) if len(parts) > 46 else 0.0,
                "cap": _sf(parts[45]),
                "totalCap": _sf(parts[44]),
                "outerVol": outer_v,
                "innerVol": inner_v,
                "buyRatio": buy_ratio,
                "vr": _sf(parts[49], 1.0) if len(parts) > 49 else 1.0,
                "amtWan": _sf(parts[37]),
            }

    # 2. 公告与排雷
    ann_resp = resps[1]
    announcements = []
    red_flags = []
    yellow_alerts = []
    green_catalysts = []
    if not isinstance(ann_resp, Exception) and ann_resp.status_code == 200:
        try:
            ann_json = ann_resp.json()
            raw_list = (ann_json.get("data") or {}).get("list", [])
            today_dt = datetime.date.today()
            for item in raw_list:
                title = item.get("title", "")
                n_date_str = item.get("notice_date", "")[:10]
                is_recent_30d = False
                try:
                    n_dt = datetime.date.fromisoformat(n_date_str)
                    is_recent_30d = (today_dt - n_dt).days <= 35
                except Exception:
                    is_recent_30d = False

                level, tag = classify_announcement(title)
                entry = {
                    "date": n_date_str,
                    "title": title,
                    "level": level,
                    "tag": tag,
                    "isRecent": is_recent_30d,
                    "art_code": item.get("art_code", ""),
                }
                announcements.append(entry)
                if is_recent_30d:
                    if level == "red":
                        red_flags.append(entry)
                    elif level == "yellow":
                        yellow_alerts.append(entry)
                    elif level == "green":
                        green_catalysts.append(entry)
        except Exception:
            pass

    # 3. 概念与板块
    concept_resp = resps[2]
    all_concepts = []
    precise_concepts = []
    if not isinstance(concept_resp, Exception) and concept_resp.status_code == 200:
        try:
            c_json = concept_resp.json()
            c_items = (c_json.get("result") or {}).get("data", []) or []
            for ci in c_items:
                bname = ci.get("BOARD_NAME")
                if bname:
                    all_concepts.append(bname)
                    if str(ci.get("IS_PRECISE")) == "1":
                        precise_concepts.append(bname)
        except Exception:
            pass

    # 4. 公司业务简介与真实行业归属（自动过滤东财 sshy='--'，优先补全东财细分行业 f127）
    survey_resp = resps[3]
    ind_resp = resps[8] if len(resps) > 8 else None
    em_industry = ""
    if ind_resp is not None and not isinstance(ind_resp, Exception) and ind_resp.status_code == 200:
        try:
            ind_d = (ind_resp.json().get("data") or {})
            cand_ind = str(ind_d.get("f127") or "").strip()
            if cand_ind and cand_ind not in ("-", "--", "—"):
                em_industry = cand_ind
        except Exception:
            pass

    company_info = {
        "fullName": quote_data.get("name", ""),
        "industry": em_industry or "行业未归类",
        "summary": "暂无资料",
        "businessScope": "—",
    }
    if not isinstance(survey_resp, Exception) and survey_resp.status_code == 200:
        try:
            s_json = survey_resp.json()
            jb = s_json.get("jbzl") or {}
            if isinstance(jb, list) and len(jb):
                jb = jb[0]
            raw_sshy = str(jb.get("sshy") or "").strip()
            raw_csrc = str(jb.get("sszjhhy") or "").strip()
            valid_ind = (
                em_industry
                or (raw_sshy if raw_sshy not in ("", "-", "--", "—") else "")
                or (raw_csrc if raw_csrc not in ("", "-", "--", "—") else "")
                or "行业未归类"
            )
            company_info = {
                "fullName": jb.get("gsmc", quote_data.get("name", "")),
                "industry": valid_ind,
                "summary": jb.get("gsjj", "暂无公司简介"),
                "businessScope": jb.get("jyfw", "—"),
            }
        except Exception:
            pass

    # 5. 今日板块生态与风口匹配 (包含涨跌家数比、板块领涨与个股身位)
    hot_resp = resps[4]
    hot_bks = []
    matched_hot_themes = []
    sector_ecology = {}

    if not isinstance(hot_resp, Exception) and hot_resp.status_code == 200:
        try:
            h_json = hot_resp.json()
            diff = (h_json.get("data") or {}).get("diff", []) or []
            for b in diff:
                bname = b.get("f14", "")
                bchg = float(b.get("f3", 0.0))
                b_up = int(b.get("f104", 0) or 0)
                b_down = int(b.get("f105", 0) or 0)
                b_leader = b.get("f140", "")

                hot_entry = {
                    "name": bname,
                    "code": b.get("f12", ""),
                    "chg": bchg,
                    "upCount": b_up,
                    "downCount": b_down,
                    "leader": b_leader,
                    "rank": len(hot_bks) + 1,
                }
                hot_bks.append(hot_entry)

                if (bname in all_concepts or bname in precise_concepts) and bchg >= 0.8:
                    matched_hot_themes.append(hot_entry)
        except Exception:
            pass

    # 计算个股在主线板块里的身位
    st_chg = quote_data.get("chg", 0.0)
    st_cap = quote_data.get("cap", 0.0)
    if matched_hot_themes:
        top_sec = matched_hot_themes[0]
        sec_chg = top_sec["chg"]

        # 身位判断
        if st_chg >= 8.5 or (sec_chg > 0 and st_chg >= sec_chg * 1.8):
            role = "👑 板块领涨先锋 / 龙头"
            role_desc = "涨幅大幅超越板块指数，资金合力聚焦，享受流动性与情绪溢价"
        elif st_cap >= 150:
            role = "🛡️ 板块大容量中军"
            role_desc = "百亿级大市值中军，成交活跃，适合大资金稳健波段运作"
        elif st_chg <= 1.0 and sec_chg >= 2.5:
            role = "⚠️ 后排跟风弱势杂毛"
            role_desc = "板块大涨但该股明显滞涨，缺乏资金主攻，板块跳水时极易首当其冲"
        else:
            role = "🎯 板块同步中坚标的"
            role_desc = "涨幅跟随板块节奏，走势与板块指数共振"

        breadth = "普涨合力" if top_sec["upCount"] > top_sec["downCount"] * 2 else "分化震荡"

        sector_ecology = {
            "sectorName": top_sec["name"],
            "sectorCode": top_sec["code"],
            "sectorChg": top_sec["chg"],
            "sectorRank": top_sec["rank"],
            "upCount": top_sec["upCount"],
            "downCount": top_sec["downCount"],
            "breadth": breadth,
            "leader": top_sec["leader"],
            "role": role,
            "roleDesc": role_desc,
            "relativeElasticity": round(st_chg - sec_chg, 2),
        }
    else:
        sector_ecology = {
            "sectorName": company_info.get("industry", "普通行业"),
            "sectorChg": 0.0,
            "upCount": 0,
            "downCount": 0,
            "breadth": "非主线",
            "role": "🌲 独立震荡 / 非风口标的",
            "roleDesc": "今日未进入全市场概念热点前列，主要受个股技术面与大盘主导",
            "relativeElasticity": 0.0,
        }

    # 6. K线、筹码与【二轮/二波预期模型】+ 深度技术指标
    days = resps[5] if isinstance(resps[5], list) else []
    chips_data = {}
    second_wave_data = {}
    technicals_data = {}
    experimental_dna = None
    atr_profile = None

    if days:
        try:
            if len(days) >= 20:
                cur_px = quote_data["price"] if quote_data["price"] > 0 else float(days[-1][2])
                opens = [float(d[1]) for d in days]
                closes = [float(d[2]) for d in days]
                highs = [float(d[3]) for d in days]
                lows = [float(d[4]) for d in days]
                vols = [float(d[5]) for d in days]

                ma5 = sum(closes[-5:]) / 5
                ma10 = sum(closes[-10:]) / 10 if len(closes) >= 10 else cur_px
                ma20 = sum(closes[-20:]) / 20 if len(closes) >= 20 else cur_px
                ma20_prev = sum(closes[-21:-1]) / 20 if len(closes) >= 21 else ma20
                ma60 = sum(closes[-60:]) / 60 if len(closes) >= 60 else cur_px

                rsi6 = calc_rsi(closes, 6)
                macd_info = calc_macd(closes)
                chg5d = round(((cur_px - closes[-6]) / closes[-6]) * 100, 2) if len(closes) >= 6 and closes[-6] > 0 else 0.0

                highs20 = highs[-20:]
                lows20 = lows[-20:]
                box_top = max(highs20)
                box_bot = min(lows20)
                box_pos = ((cur_px - box_bot) / (box_top - box_bot) * 100) if box_top > box_bot else 50.0

                vols60 = vols[-60:] if len(vols) >= 60 else vols
                closes60 = closes[-60:] if len(closes) >= 60 else closes
                sum_vol = sum(vols60)
                avg_cost = sum(c * v for c, v in zip(closes60, vols60)) / sum_vol if sum_vol > 0 else cur_px
                profit_vol = sum(v for c, v in zip(closes60, vols60) if c <= cur_px)
                profit_ratio = (profit_vol / sum_vol * 100) if sum_vol > 0 else 50.0

                # 均线趋势与破位/止跌/诱多K线结构识别
                avg_vol5 = sum(vols[-6:-1]) / 5 if len(vols) >= 6 else (sum(vols) / len(vols))
                last_o = quote_data["open"] if quote_data["open"] > 0 else opens[-1]
                last_h = quote_data["high"] if quote_data["high"] > 0 else highs[-1]
                last_l = quote_data["low"] if quote_data["low"] > 0 else lows[-1]
                last_v = vols[-1] if vols else 0.0

                body_pct = abs(cur_px - last_o) / cur_px if cur_px > 0 else 0.0
                lower_shadow = (min(cur_px, last_o) - last_l) / cur_px if cur_px > 0 else 0.0
                upper_shadow = (last_h - max(cur_px, last_o)) / cur_px if cur_px > 0 else 0.0

                is_bull_align = (cur_px >= ma5 * 0.995 and ma5 > ma10 > ma20)
                is_broken_down = (cur_px < ma20 * 0.985 and cur_px < ma60 * 0.99 and ma5 < ma20)
                is_bottom_doji = (cur_px < ma20 and (body_pct <= 0.009 or lower_shadow >= 0.015) and last_v <= avg_vol5 * 0.95)
                is_vol_ignition = (quote_data.get("chg", 0.0) >= 2.0 and last_v >= avg_vol5 * 1.35 and cur_px >= ma5)
                is_high_stagnation = (box_pos >= 85 and chg5d >= 16.0 and upper_shadow >= 0.022 and last_v >= avg_vol5 * 1.45)

                if is_bull_align:
                    trend_status = "多头主升排列"
                elif is_broken_down:
                    trend_status = "破位空头下行"
                elif cur_px >= ma20 * 0.985 and ma20 >= ma20_prev * 0.995:
                    trend_status = "回踩支撑震荡"
                else:
                    trend_status = "均线交织整理"

                technicals_data = {
                    "rsi6": rsi6,
                    "dif": macd_info["dif"],
                    "dea": macd_info["dea"],
                    "macdHist": macd_info["hist"],
                    "isMacdGolden": macd_info["isGolden"],
                    "isMacdDead": macd_info["isDead"],
                    "chg5d": chg5d,
                    "trendStatus": trend_status,
                    "isBullAlign": is_bull_align,
                    "isBrokenDown": is_broken_down,
                    "isBottomDoji": is_bottom_doji,
                    "isVolIgnition": is_vol_ignition,
                    "isHighStagnation": is_high_stagnation,
                }

                chips_data = {
                    "curPrice": cur_px,
                    "ma5": round(ma5, 2),
                    "ma10": round(ma10, 2),
                    "ma20": round(ma20, 2),
                    "ma60": round(ma60, 2),
                    "boxTop": round(box_top, 2),
                    "boxBot": round(box_bot, 2),
                    "boxPos": round(box_pos, 1),
                    "avgCost": round(avg_cost, 2),
                    "profitRatio": round(profit_ratio, 1),
                    "diffFromCost": round(((cur_px - avg_cost) / avg_cost) * 100, 2) if avg_cost > 0 else 0.0,
                }

                # ===== 二轮 / 二波潜力与生命周期判定 =====
                lookback = min(len(days), 120)
                sub_highs = highs[-lookback:]
                sub_lows = lows[-lookback:]
                sub_vols = vols[-lookback:]
                max_h = max(sub_highs)
                max_h_idx = sub_highs.index(max_h)
                days_from_top = lookback - max_h_idx - 1

                # 见顶前的低点与首轮波幅
                valley_before_top = min(sub_lows[: max_h_idx + 1]) if max_h_idx > 0 else sub_lows[0]
                wave1_amp = ((max_h - valley_before_top) / valley_before_top) * 100 if valley_before_top > 0 else 0.0

                # 距最高点的回撤深度
                drawdown = ((cur_px - max_h) / max_h) * 100

                # 量能萎缩程度：最近5日均量 vs 见顶前5日均量
                peak_vols = sub_vols[max(0, max_h_idx - 2) : min(lookback, max_h_idx + 3)]
                peak_vol_avg = sum(peak_vols) / len(peak_vols) if peak_vols else max(sub_vols)
                cur_vol_avg = sum(vols[-5:]) / 5 if len(vols) >= 5 else vols[-1]
                vol_shrink = (cur_vol_avg / peak_vol_avg) * 100 if peak_vol_avg > 0 else 100.0

                # 二波研判逻辑
                if wave1_amp >= 28:
                    if days_from_top <= 3:
                        stage = "① 首轮加速高潮期"
                        stage_tag = "high_risk"
                        potential = "尚在首轮末端"
                        desc = f"首轮爆拉 +{wave1_amp:.1f}%，刚见顶 {days_from_top} 天，高位筹码剧烈派发换手，切忌追高，逢高倒T减仓！"
                    elif -25 <= drawdown <= -10 and cur_px >= ma20 * 0.95 and vol_shrink <= 65:
                        stage = "② 【二轮蓄势·黄金潜伏期】"
                        stage_tag = "golden_second"
                        potential = "极高 (二波反弹蓄势)"
                        desc = f"首轮大涨 +{wave1_amp:.1f}% 后充分洗盘 {days_from_top} 天，回踩 {drawdown:.1f}% 在 MA20/箱底附近缩量止跌(量能萎缩至 {vol_shrink:.0f}%)，具备极强【二轮反包/回流主升】潜力，被套资金切忌低位割肉！"
                    elif drawdown < -32 and cur_px < ma60:
                        stage = "③ 二波证伪·破位退潮"
                        stage_tag = "dead"
                        potential = "偏低 (二波已证伪)"
                        desc = f"高位深度回撤 {drawdown:.1f}% 并跌穿 MA60 生命线，上方堆积沉重套牢盘，二波预期已被市场否定，反弹应果断倒T离场。"
                    else:
                        stage = "④ 首轮分歧休整期"
                        stage_tag = "neutral"
                        potential = "观察中 (等待回流)"
                        desc = f"自高位回撤 {drawdown:.1f}%，多空剧烈拉锯换手，需耐心等待板块重新放量收复分时均线与短期均线。"
                else:
                    stage = "⑤ 常态波段题材"
                    stage_tag = "normal"
                    potential = "普通 (无大级别二波)"
                    desc = f"近120日未出现超 28% 的大级别主升浪（最大波幅 +{wave1_amp:.1f}%），属于常态波段轮动，按箱体网格高抛低吸即可。"

                second_wave_data = {
                    "stage": stage,
                    "stageTag": stage_tag,
                    "secondWavePotential": potential,
                    "wave1Amplitude": round(wave1_amp, 1),
                    "maxHigh": round(max_h, 2),
                    "daysFromTop": days_from_top,
                    "drawdown": round(drawdown, 1),
                    "volShrink": round(vol_shrink, 1),
                    "desc": desc,
                }

                # ===== 实验性弱参考：近14日ATR波动率 + 近120日个股历史基因概率回测 =====
                try:
                    today_iso = datetime.date.today().isoformat()
                    comp_end = len(days) - 1 if str(days[-1][0])[:10] == today_iso else len(days)
                    if comp_end >= 16:
                        # 1) ATR(14) 动态波动率剖面
                        tr_sum = 0.0
                        amp14_sum = 0.0
                        atr_cnt = 0
                        atr_start = max(1, comp_end - 14)
                        for idx_a in range(atr_start, comp_end):
                            pc_a = closes[idx_a - 1]
                            h_a, l_a = highs[idx_a], lows[idx_a]
                            if pc_a <= 0 or h_a <= 0 or l_a <= 0:
                                continue
                            tr_a = max(h_a - l_a, abs(h_a - pc_a), abs(l_a - pc_a))
                            tr_sum += tr_a
                            amp14_sum += ((h_a - l_a) / pc_a) * 100
                            atr_cnt += 1
                        if atr_cnt >= 5:
                            atr14_val = tr_sum / atr_cnt
                            ref_px = float(quote_data.get("prevClose") or 0.0) or closes[comp_end - 1] or cur_px
                            atr_pct_val = (atr14_val / ref_px) * 100 if ref_px > 0 else 0.0
                            avg_amp14_val = amp14_sum / atr_cnt
                            adaptive_grid_val = round(max(0.80, min(2.60, avg_amp14_val * 0.34)), 2)
                            if adaptive_grid_val < 1.05:
                                vol_type_label = "🐢 低波窄幅型"
                            elif adaptive_grid_val > 1.60:
                                vol_type_label = "⚡ 高波活跃型"
                            else:
                                vol_type_label = "⚖️ 标准均衡型"
                            atr_profile = {
                                "atr14": round(atr14_val, 2),
                                "atrPct": round(atr_pct_val, 2),
                                "avgIntraAmp14": round(avg_amp14_val, 2),
                                "adaptiveGrid": adaptive_grid_val,
                                "volType": vol_type_label,
                                "sampleDays": atr_cnt,
                            }

                        # 2) 近120日历史基因概率统计
                        tot_d = 0
                        amp3_d = 0
                        dip_tot = 0
                        dip_win = 0
                        dip_reb_sum = 0.0
                        gap_up_tot = 0
                        gap_up_smash = 0
                        for idx_k in range(1, comp_end):
                            pc_k = closes[idx_k - 1]
                            o_k, c_k, h_k, l_k = opens[idx_k], closes[idx_k], highs[idx_k], lows[idx_k]
                            if pc_k <= 0 or o_k <= 0 or l_k <= 0:
                                continue
                            tot_d += 1
                            amp_k = ((h_k - l_k) / pc_k) * 100
                            gap_k = ((o_k - pc_k) / pc_k) * 100
                            dip_o_k = ((l_k - o_k) / o_k) * 100
                            dip_p_k = ((l_k - pc_k) / pc_k) * 100
                            reb_k = ((c_k - l_k) / l_k) * 100
                            if amp_k >= 3.0:
                                amp3_d += 1
                            if dip_o_k <= -1.8 or dip_p_k <= -1.8:
                                dip_tot += 1
                                dip_reb_sum += reb_k
                                if reb_k >= 1.2:
                                    dip_win += 1
                            if gap_k >= 0.8:
                                gap_up_tot += 1
                                if c_k < o_k:
                                    gap_up_smash += 1
                        if tot_d >= 15:
                            t3_pct = round((amp3_d / tot_d) * 100)
                            d_win_rate = round((dip_win / dip_tot) * 100) if dip_tot > 0 else 0
                            d_avg_reb = round((dip_reb_sum / dip_tot), 2) if dip_tot > 0 else 0.0
                            g_smash_rate = round((gap_up_smash / gap_up_tot) * 100) if gap_up_tot > 0 else 0

                            if t3_pct < 35:
                                d_tag = "🐢 窄幅织布基因"
                                d_desc = f"近{tot_d}日仅{t3_pct}%交易日振幅≥3%，波动偏窄，短线做T弹性偏弱。"
                            elif gap_up_tot >= 6 and g_smash_rate >= 62:
                                d_tag = "🎭 高开砸盘(渣男)基因"
                                d_desc = f"近半年高开{gap_up_tot}次有{g_smash_rate}%收阴回落，忌早盘追高。"
                            elif dip_tot >= 6 and d_win_rate >= 62:
                                d_tag = "⚡ 深V反弹(抗跌)基因"
                                d_desc = f"近半年深探≥1.8%共{dip_tot}次，{d_win_rate}%日内低吸反抽≥1.2%(均抽+{d_avg_reb}%)。"
                            elif dip_tot >= 6 and d_win_rate <= 35:
                                d_tag = "🧊 单边阴跌基因(慎抄底)"
                                d_desc = f"近半年深探共{dip_tot}次，反抽胜率仅{d_win_rate}%，少做日内左侧抄底。"
                            else:
                                d_tag = "⚖️ 均衡震荡基因"
                                d_desc = f"近{tot_d}日做T振幅达标率{t3_pct}%，高开回落与深水反抽表现较均衡。"

                            experimental_dna = {
                                "sampleDays": tot_d,
                                "tFriendly3Pct": t3_pct,
                                "dipTotal": dip_tot,
                                "dipWin": dip_win,
                                "dipWinRate": d_win_rate,
                                "dipAvgRebound": d_avg_reb,
                                "gapUpTotal": gap_up_tot,
                                "gapUpSmashRate": g_smash_rate,
                                "dnaTag": d_tag,
                                "dnaDesc": d_desc,
                            }
                except Exception:
                    pass
        except Exception:
            pass

    # 7. 全天分时 (VWAP 均价线与日内形态)
    min_resp = resps[6]
    intraday_data = {}
    if not isinstance(min_resp, Exception) and min_resp.status_code == 200:
        try:
            m_json = min_resp.json()
            min_arr = m_json.get("data", {}).get(tcode, {}).get("data", {}).get("data", [])
            if min_arr:
                m_prices = []
                m_vwap_arr = []
                above_cnt = 0
                for item in min_arr:
                    pts = item.split(" ")
                    if len(pts) >= 4:
                        m_p = float(pts[1])
                        c_vol = float(pts[2])
                        c_amt = float(pts[3])
                        m_vwap = (c_amt / (c_vol * 100)) if c_vol > 0 else m_p
                        m_prices.append(m_p)
                        m_vwap_arr.append(m_vwap)
                        if m_p >= m_vwap:
                            above_cnt += 1

                if m_prices:
                    cur_p = m_prices[-1]
                    last_v = m_vwap_arr[-1]
                    h_p = max(m_prices)
                    l_p = min(m_prices)
                    prev_c = quote_data["prevClose"] if quote_data["prevClose"] > 0 else m_prices[0]
                    amp = ((h_p - l_p) / prev_c) * 100 if prev_c > 0 else 0.0
                    above_ratio = (above_cnt / len(m_prices)) * 100

                    # 日内形态判断
                    h_idx = m_prices.index(h_p)
                    l_idx = m_prices.index(l_p)
                    tot = len(m_prices)

                    if h_idx < 35 and cur_p < last_v:
                        pattern = "早盘脉冲冲高回落 (典型诱多，受均价线压制)"
                        pattern_type = "dump"
                    elif l_idx < 35 and cur_p >= last_v and cur_p >= (h_p + l_p) / 2:
                        pattern = "探底强劲企稳回升 (下探洗盘后收复均价线)"
                        pattern_type = "rebound"
                    elif above_ratio >= 70:
                        pattern = "多头全天控盘 (分时全程稳站均价线上方)"
                        pattern_type = "bull"
                    elif above_ratio <= 30:
                        pattern = "空头全天压制 (分时白线全程被均价线压制)"
                        pattern_type = "bear"
                    elif amp < 2.0:
                        pattern = "极窄幅缩量横盘 (日内波动不足2%，做T无利可图)"
                        pattern_type = "flat"
                    else:
                        pattern = "分时震荡多空拉锯"
                        pattern_type = "chop"

                    intraday_data = {
                        "curPrice": cur_p,
                        "vwap": round(last_v, 2),
                        "vwapDiff": round(((cur_p - last_v) / last_v) * 100, 2) if last_v > 0 else 0.0,
                        "highPrice": h_p,
                        "lowPrice": l_p,
                        "amp": round(amp, 2),
                        "aboveRatio": round(above_ratio, 1),
                        "pattern": pattern,
                        "patternType": pattern_type,
                    }
        except Exception:
            pass

    # 8. 综合评级与【做T自救新版处方】
    risk_level = "安全"
    risk_color = "green"
    if red_flags:
        risk_level = "高危利空警示"
        risk_color = "red"
    elif yellow_alerts:
        risk_level = "存在需关注事项"
        risk_color = "yellow"

    theme_status = "一般题材 / 未在今日风口"
    if matched_hot_themes:
        top_t = matched_hot_themes[0]
        theme_status = f"🔥 属于今日主线热点【{top_t['name']}】(+{top_t['chg']}%)"

    prescriptions = []

    # 1) 排雷法则
    if red_flags:
        prescriptions.append(f"【严控风险】近1个月有高危公告（{red_flags[0]['title'][:25]}），深套切勿盲目补仓！")

    # 2) 二波预期法则 (最核心的解套指引)
    if second_wave_data:
        stag_tag = second_wave_data.get("stageTag")
        if stag_tag == "golden_second":
            prescriptions.append(
                f"【二轮蓄势·坚守博弈】{second_wave_data['desc']} 深套资金切忌在地板割肉，逢缩量支撑可小仓试正T低吸！"
            )
        elif stag_tag == "dead":
            prescriptions.append(
                f"【二波证伪·坚决止损】{second_wave_data['desc']} 严禁逆势摊薄，反弹触碰上方均线必须坚决倒T减亏！"
            )
        elif stag_tag == "high_risk":
            prescriptions.append(f"【高位兑现】{second_wave_data['desc']}")

    # 3) 板块生态与身位法则
    if sector_ecology:
        sec_role = sector_ecology.get("role", "")
        if "后排跟风弱势杂毛" in sec_role:
            prescriptions.append("【杂毛警示】该股在当前板块中处于跟风滞涨身位，板块一旦冲高见顶易加速跳水，做T以逢高倒T减仓为主。")
        elif "板块大容量中军" in sec_role:
            prescriptions.append("【中军持股】作为板块大容量中军，承接力强，适合依托 20 日均线与箱体下沿做底仓波段网格T。")

    # 4) 分时日内与做T空间法则
    if intraday_data:
        amp = intraday_data.get("amp", 0.0)
        p_type = intraday_data.get("patternType")
        if amp < 2.0:
            prescriptions.append("【垃圾时间】全天振幅不足 2.0%，差价无法覆盖交易税费与滑点，今日宜多看少动，坚决不盲动。")
        elif p_type == "dump":
            prescriptions.append("【冲高诱多】早盘脉冲后全天被分时均价线压制，切忌分时追高，盘中反抽触碰黄线即是倒T卖点。")
        elif p_type == "rebound":
            prescriptions.append("【探底企稳】早盘探底后午后稳步收复均价线，多头承接坚决，可顺势在均价线附近做正T低吸。")

    # 5) 筹码套牢度
    if chips_data:
        p_ratio = chips_data.get("profitRatio", 50)
        box_pos = chips_data.get("boxPos", 50)
        if p_ratio < 20 and box_pos <= 25:
            prescriptions.append(f"【超跌箱底】获利盘仅 {p_ratio:.1f}% 且贴近 20 日箱底，筹码割无可割，若缩量企稳是左侧轻仓试正T的安全位置。")

    # 9. 解析大盘环境情绪、短线连板/抱团联动身位 与 多因子综合买入决策评分引擎
    limitup_data = resps[7] if len(resps) > 7 and isinstance(resps[7], dict) and resps[7].get("ok") else {}
    market_sentiment = limitup_data.get("sentiment") or {}

    zt_item = next((x for x in (limitup_data.get("items") or []) if str(x.get("code", "")).zfill(6) == code), None)
    sp_item = next((x for x in (limitup_data.get("strongPool") or []) if str(x.get("code", "")).zfill(6) == code), None)
    herd_item = next((x for x in (limitup_data.get("herdPool") or []) if str(x.get("code", "")).zfill(6) == code), None)
    zb_item = next((x for x in (limitup_data.get("zbPool") or []) if str(x.get("code", "")).zfill(6) == code), None)
    rush_item = next((x for x in (limitup_data.get("rushingPool") or []) if str(x.get("code", "")).zfill(6) == code), None)

    short_term_status = None
    if any([zt_item, sp_item, herd_item, zb_item, rush_item]):
        short_term_status = {
            "inStrongPool": sp_item is not None,
            "inHerdPool": herd_item is not None,
            "isLimitUp": (zt_item is not None) or bool(sp_item and sp_item.get("isLimitUp")),
            "isBrokenBoard": zb_item is not None,
            "isRushing": rush_item is not None,
            "statTag": (sp_item or zt_item or herd_item or {}).get("statTag", ""),
            "lbc": int((zt_item or sp_item or herd_item or {}).get("lbc") or 0),
            "identityScore": sp_item.get("identityScore") if sp_item else None,
            "relayScore": sp_item.get("relayScore") if sp_item else None,
            "scoreDims": sp_item.get("scoreDims") if sp_item else None,
            "cycleAdvice": sp_item.get("cycleAdvice", "") if sp_item else "",
            "tags": (sp_item or herd_item or {}).get("tags", []),
            "fbt": (zt_item or sp_item or zb_item or {}).get("fbt", "—"),
            "fund": float((zt_item or sp_item or {}).get("fund") or 0.0),
            "sealRatio": float((zt_item or sp_item or {}).get("sealRatio") or 0.0),
            "zbc": int((zt_item or sp_item or zb_item or {}).get("zbc") or 0),
            "buyTag": (zt_item or rush_item or {}).get("buyTag", ""),
            "buyAction": (zt_item or rush_item or {}).get("buyAction", ""),
            "dropFromTop": zb_item.get("dropFromTop") if zb_item else None,
            "distCeiling": rush_item.get("distCeiling") if rush_item else None,
            "herdHealth": (herd_item or {}).get("healthStatus") or (sp_item or {}).get("herdHealth", ""),
            "herdLabel": (herd_item or {}).get("healthLabel") or (sp_item or {}).get("healthLabel", ""),
            "herdDesc": (herd_item or {}).get("healthDesc", ""),
            "cumReturnPct": (herd_item or {}).get("cumReturnPct"),
            "vsMa5": (herd_item or sp_item or {}).get("vsMa5"),
            "ddFromPeak": (herd_item or sp_item or {}).get("ddFromPeak"),
            "mysticRoots": (sp_item or herd_item or {}).get("mysticRoots", []),
            "mysticCluster": (sp_item or herd_item or {}).get("mysticCluster", ""),
            "mysticZtCount": int((sp_item or herd_item or {}).get("mysticZtCount") or 0),
            "isMysticResonant": bool((sp_item or herd_item or {}).get("isMysticResonant")),
        }

    decision_data = build_comprehensive_decision(
        quote=quote_data,
        chips=chips_data,
        technicals=technicals_data,
        intraday=intraday_data,
        second_wave=second_wave_data,
        sector_ecology=sector_ecology,
        matched_hot_themes=matched_hot_themes,
        red_flags=red_flags,
        yellow_alerts=yellow_alerts,
        green_catalysts=green_catalysts,
        market_sentiment=market_sentiment,
        atr_profile=atr_profile,
        experimental_dna=experimental_dna,
    )

    diag_result = {
        "ok": True,
        "code": code,
        "quote": quote_data,
        "company": company_info,
        "concepts": precise_concepts or all_concepts[:12],
        "allConcepts": all_concepts,
        "matchedHotThemes": matched_hot_themes,
        "sectorEcology": sector_ecology,
        "secondWave": second_wave_data,
        "intraday": intraday_data,
        "announcements": announcements[:20],
        "redFlags": red_flags,
        "yellowAlerts": yellow_alerts,
        "greenCatalysts": green_catalysts,
        "chips": chips_data,
        "technicals": technicals_data,
        "atrProfile": atr_profile,
        "experimentalDNA": experimental_dna,
        "marketContext": market_sentiment,
        "shortTermStatus": short_term_status,
        "mysticClusters": (limitup_data.get("mysticClusters") or [])[:5],
        "decision": decision_data,
        "riskLevel": risk_level,
        "riskColor": risk_color,
        "themeStatus": theme_status,
        "prescriptions": prescriptions,
    }

    # 微信复制文本
    diag_result["wechatSummary"] = build_wechat_summary(diag_result)

    # 写入缓存
    async with _DIAG_CACHE_LOCK:
        _DIAGNOSIS_CACHE[code] = (now + CACHE_TTL_SECONDS, diag_result)

    return diag_result
