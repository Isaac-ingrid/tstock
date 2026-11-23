"""backend/coach.py

智策战情室 · AI 交易复盘教练引擎（大模型深度复盘 + 内置零门槛量化规则教练双引擎）
支持天翼云 OpenAI 兼容接口 (https://ai.ctaigw.cn/v1/chat/completions) 及自定义大模型网关；
当未配置 API 密钥、选择离线量化诊断或上游大模型网关超时时，自动启用确定性量化规则教练引擎，
确保「人机对决 & 计划偏离度评分 & 主观情绪摩擦损耗」100% 开箱即用。
"""

from __future__ import annotations

import os
import time
from typing import Any, Dict, List, Optional

from .trade_calendar import get_market_calendar_snapshot

try:
    import httpx  # type: ignore
except ImportError:  # pragma: no cover
    httpx = None  # type: ignore


# 尝试自动从项目根目录及 backend/ 加载 .env
def _load_env_files() -> None:
    current_dir = os.path.dirname(os.path.abspath(__file__))
    root_dir = os.path.dirname(current_dir)
    env_paths = [
        os.path.join(root_dir, ".env"),
        os.path.join(root_dir, ".env.local"),
        os.path.join(current_dir, ".env"),
    ]
    for p in env_paths:
        if os.path.isfile(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line or line.startswith("#"):
                            continue
                        if "=" in line:
                            k, v = line.split("=", 1)
                            k = k.strip()
                            v = v.strip().strip("'").strip('"')
                            if k and k not in os.environ:
                                os.environ[k] = v
            except Exception:
                pass


_load_env_files()

DEFAULT_API_URL = "https://ai.ctaigw.cn/v1/chat/completions"
DEFAULT_MODEL = "deepseek-chat"

MISTAKE_LABEL_MAP = {
    "fomo_chase": "🔥 追高天花板",
    "no_stoploss": "💣 破位死扛不认输",
    "t_to_add": "🪤 做T做反变加仓",
    "early_exit": "🏃 过早卖飞大肉",
    "against_trend": "🌪️ 逆市顶风作案",
    "heavy_gamble": "🎲 短线重仓单赌",
    "impulse_t": "⚡ 无量冲动乱T",
    "revenge_trade": "😡 报复性交易",
    "lone_wolf": "🐺 孤狼单打一日游",
    "late_chase": "🥀 滞后接盘高潮棒",
    "averaging_down": "🩸 下跌通道浮亏死补",
    "hold_past_3red": "🥀 弱势连红三日贪婪不减",
    "t1_illusion_hold": "🪞 T+1收绿幻想反包",
    "backrow_laggard": "🗑️ 看A做B买后排补涨",
    "pre_holiday_overcap": "🏮 节前长假超限建仓",
}


def _clean_api_key(raw_key: str) -> str:
    """自动清理用户误复制的前缀，如 'API KEY: ', 'Bearer ', 引号与首尾空白"""
    if not raw_key:
        return ""
    k = raw_key.strip().strip("'").strip('"')
    for prefix in ["API KEY:", "API_KEY:", "ApiKey:", "api_key:", "Bearer ", "key:"]:
        if k.lower().startswith(prefix.lower()):
            k = k[len(prefix):].strip()
    return k.strip().strip("'").strip('"')


def get_coach_config() -> Dict[str, Any]:
    """获取当前 AI 教练的大模型配置状态（同时标记内置量化规则引擎常驻就绪）"""
    _load_env_files()
    raw_key = (
        os.getenv("AI_COACH_API_KEY", "").strip()
        or os.getenv("TIANYI_API_KEY", "").strip()
        or os.getenv("OPENAI_API_KEY", "").strip()
    )
    api_key = _clean_api_key(raw_key)
    api_url = os.getenv("AI_COACH_API_URL", "").strip() or DEFAULT_API_URL
    model = os.getenv("AI_COACH_MODEL", "").strip() or DEFAULT_MODEL

    masked_key = ""
    if api_key:
        if len(api_key) <= 8:
            masked_key = "***" + api_key[-2:]
        else:
            masked_key = api_key[:4] + "****" + api_key[-4:]

    return {
        "configured": bool(api_key),
        "ruleEngineReady": True,
        "apiUrl": api_url,
        "model": model,
        "maskedKey": masked_key,
    }


async def test_coach_connection(
    api_key: Optional[str] = None,
    api_url: Optional[str] = None,
    model: Optional[str] = None,
) -> Dict[str, Any]:
    """测试天翼云 / OpenAI 兼容接口的连通性与模型响应延迟"""
    cfg = get_coach_config()
    raw_key = (
        (api_key or "").strip()
        or os.getenv("AI_COACH_API_KEY", "").strip()
        or os.getenv("TIANYI_API_KEY", "").strip()
        or os.getenv("OPENAI_API_KEY", "").strip()
    )
    final_key = _clean_api_key(raw_key)
    final_url = (api_url or "").strip() or cfg["apiUrl"]
    final_model = (model or "").strip() or cfg["model"]

    if not final_key:
        raise ValueError("尚未配置大模型 API 密钥（当前无需密钥也可直接使用内置量化规则复盘引擎；如需连接天翼云/DeepSeek 请填入密钥）。")

    headers = {
        "Authorization": f"Bearer {final_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": final_model,
        "messages": [
            {"role": "system", "content": "你是一位专业的A股职业量化交易导师。请只用简短一句话打招呼。"},
            {"role": "user", "content": "你好，请确认你已就绪。"},
        ],
        "max_tokens": 60,
        "temperature": 0.3,
    }

    t0 = time.monotonic()
    async with httpx.AsyncClient(timeout=httpx.Timeout(20.0), trust_env=False) as client:
        try:
            resp = await client.post(final_url, json=payload, headers=headers)
        except httpx.ConnectError as exc:
            raise ConnectionError(f"无法连接到大模型接口 ({final_url})，请检查网络或 URL: {exc}") from exc
        except httpx.TimeoutException as exc:
            raise TimeoutError("大模型 API 请求超时 (20s)，请检查网络状况或稍候重试") from exc

    latency_ms = int((time.monotonic() - t0) * 1000)

    if resp.status_code != 200:
        err_msg = resp.text
        try:
            err_json = resp.json()
            err_msg = err_json.get("error", {}).get("message") or err_json.get("message") or resp.text
        except Exception:
            pass
        raise RuntimeError(f"大模型 API 返回错误 HTTP {resp.status_code}: {err_msg}")

    data = resp.json()
    reply = ""
    choices = data.get("choices", [])
    if choices and isinstance(choices, list):
        reply = choices[0].get("message", {}).get("content", "").strip()

    return {
        "ok": True,
        "latencyMs": latency_ms,
        "model": final_model,
        "apiUrl": final_url,
        "reply": reply or "接口连通正常，交易教练已就绪！",
    }


def _normalize_mistake_labels(raw_tags: Any) -> List[str]:
    if not isinstance(raw_tags, list):
        return []
    out: List[str] = []
    for item in raw_tags:
        s = str(item or "").strip()
        if not s:
            continue
        out.append(MISTAKE_LABEL_MAP.get(s, s))
    return out


def build_quant_rule_review(
    trades: List[Dict[str, Any]],
    date: str,
    market_env: Optional[Dict[str, Any]] = None,
    user_notes: Optional[str] = None,
) -> Dict[str, Any]:
    """内置零延迟量化规则复盘教练：无需外部 API Key，直接基于点位偏离度、人机对决 Alpha 与失误标签生成结构化诊断"""
    if not trades:
        raise ValueError("复盘流水记录为空，请至少完成或录入一笔交易后再启动复盘。")

    cal_ctx = get_market_calendar_snapshot(date)
    next_td = cal_ctx["nextTradeDate"]
    closed_ahead = int(cal_ctx.get("closedDaysAhead") or 0)
    pre_hol = cal_ctx.get("upcomingHoliday") if isinstance(cal_ctx.get("upcomingHoliday"), dict) else None

    env_level = str((market_env or {}).get("level") or "OK").upper()
    env_text = str((market_env or {}).get("text") or "常态震荡")
    emo_cap_pct = 20 if env_level == "BAD" else (50 if env_level == "WARN" else 80)
    is_pre_hol_alert = bool(
        pre_hol
        and pre_hol.get("isHighAlert")
        and int(pre_hol.get("closedDays") or 0) >= 3
        and int(pre_hol.get("remainingTradeDays") or 0) in (1, 2)
    )
    eff_holiday_cap_pct = (
        min(
            emo_cap_pct,
            int(pre_hol.get("suggestedMaxPosPct") or (30 if int(pre_hol.get("closedDays") or 0) >= 7 else 50)),
        )
        if is_pre_hol_alert and pre_hol
        else emo_cap_pct
    )

    buy_score = 25.0
    sell_score = 25.0
    stop_score = 25.0
    env_score = 25.0

    total_net = 0.0
    total_sys_net = 0.0
    duel_count = 0
    friction_loss = 0.0
    win_count = 0
    loss_count = 0
    unplanned_count = 0
    pre_holiday_overcap_count = 0
    mistake_counter: Dict[str, int] = {}
    slice_lines: List[str] = []

    pos_build_dirs = ("买入建仓", "买入加仓", "直接买入", "尾盘买入", "底仓建仓", "连板追涨", "龙头抄底")

    for idx, t in enumerate(trades, 1):
        stock = str(t.get("stock") or t.get("code") or "未知标的")
        dir_name = str(t.get("dir") or "做T")
        track_label = "短线攻防轨" if t.get("track") == "short_swing" else "底仓做T轨"
        buy_px = float(t.get("buy") or 0.0)
        sell_px = float(t.get("sell") or 0.0)
        qty = int(float(t.get("qty") or 0))
        net_val = float(t.get("net") or 0.0)
        plan_stat = str(t.get("plan") or "计划内")
        tags_raw = t.get("mistakeTags") if isinstance(t.get("mistakeTags"), list) else []
        tag_labels = _normalize_mistake_labels(tags_raw)

        total_net += net_val
        is_closed = buy_px > 0 and sell_px > 0 and dir_name not in ("买入建仓", "买入加仓", "直接买入", "尾盘买入", "底仓建仓")
        if is_closed:
            if net_val > 0:
                win_count += 1
            elif net_val < 0:
                loss_count += 1

        raw_set = {str(x) for x in tags_raw}
        holding_float_pct = float(t.get("holdingFloatPct") or 0.0)
        red_streak = int(float(t.get("redStreak") or 0))
        post_buy_pct_raw = t.get("postBuyPosPct") if t.get("postBuyPosPct") is not None else t.get("posPctAfter")
        trade_hol_cap_raw = t.get("holidayCapPct")
        resolved_hol_cap = int(float(trade_hol_cap_raw)) if trade_hol_cap_raw is not None and float(trade_hol_cap_raw) > 0 else eff_holiday_cap_pct

        # 自动侦测「节前长假超限建仓」（即使上游流水未预打标签，只要买后总仓位超过节前上限立即捕获并归为计划外）
        if (
            is_pre_hol_alert
            and dir_name in pos_build_dirs
            and buy_px > 0
            and "pre_holiday_overcap" not in raw_set
            and post_buy_pct_raw is not None
            and float(post_buy_pct_raw) > resolved_hol_cap + 0.1
        ):
            raw_set.add("pre_holiday_overcap")
            tag_labels.append(MISTAKE_LABEL_MAP["pre_holiday_overcap"])
            if plan_stat in ("", "自动判定", "计划内"):
                plan_stat = "计划外"

        if plan_stat == "计划外":
            unplanned_count += 1
            env_score -= 3.5

        # 自动侦测「下跌通道浮亏死补」与「弱势连红3天贪婪追买」
        if env_level in ("WARN", "BAD"):
            if dir_name in ("买入加仓", "直接买入") and holding_float_pct <= -1.0 and "averaging_down" not in raw_set:
                raw_set.add("averaging_down")
                tag_labels.append(MISTAKE_LABEL_MAP.get("averaging_down", "🩸 下跌通道浮亏死补"))
            if red_streak >= 3 and dir_name in ("买入加仓", "正T", "直接买入") and "hold_past_3red" not in raw_set:
                raw_set.add("hold_past_3red")
                tag_labels.append(MISTAKE_LABEL_MAP.get("hold_past_3red", "🥀 弱势连红三日贪婪不减"))

        for lb in tag_labels:
            mistake_counter[lb] = mistake_counter.get(lb, 0) + 1

        lbl_joined = " ".join(tag_labels)
        is_pre_hol_overcap = "pre_holiday_overcap" in raw_set or "节前长假超限" in lbl_joined

        if "fomo_chase" in raw_set or "late_chase" in raw_set or "追高" in lbl_joined or "接盘" in lbl_joined:
            buy_score -= 6.5
        if "backrow_laggard" in raw_set or "后排" in lbl_joined:
            buy_score -= 7.0
        if "lone_wolf" in raw_set or "孤狼" in lbl_joined:
            buy_score -= 5.0
        if "impulse_t" in raw_set or "冲动" in lbl_joined:
            buy_score -= 4.5
        if "early_exit" in raw_set or "卖飞" in lbl_joined:
            sell_score -= 3.0 if env_level != "OK" else 6.5  # 上升通道过早卖飞重罚，弱势通道落袋轻罚
        if "hold_past_3red" in raw_set or "连红三日" in lbl_joined:
            sell_score -= 7.5
        if "no_stoploss" in raw_set or "死扛" in lbl_joined:
            stop_score -= 8.0
        if "averaging_down" in raw_set or "浮亏死补" in lbl_joined:
            stop_score -= 8.5
            env_score -= 4.5
        if "t1_illusion_hold" in raw_set or "幻想反包" in lbl_joined:
            stop_score -= 7.5
        if "t_to_add" in raw_set or "变加仓" in lbl_joined:
            stop_score -= 6.5
        if "against_trend" in raw_set or "逆市" in lbl_joined:
            env_score -= 7.0
        if "revenge_trade" in raw_set or "报复" in lbl_joined:
            env_score -= 7.5
        if "heavy_gamble" in raw_set or "重仓单赌" in lbl_joined:
            env_score -= 5.5
        if is_pre_hol_overcap:
            pre_holiday_overcap_count += 1
            rem_td_cur = int((pre_hol or {}).get("remainingTradeDays") or 1)
            env_score -= 7.5
            stop_score -= 3.5 if (rem_td_cur == 1 and dir_name == "尾盘买入") else (2.5 if rem_td_cur == 1 else 2.0)

        bench = t.get("systemBenchmark") if isinstance(t.get("systemBenchmark"), dict) else {}
        sys_buy = float(bench.get("sysBuy") or 0.0)
        sys_sell1 = float(bench.get("sysSell1") or 0.0)
        sys_stop = float(bench.get("sysStop") or 0.0)
        sys_net = bench.get("sysNet")

        buy_dev_pct = t.get("buyDevPct")
        if buy_dev_pct is None and buy_px > 0 and sys_buy > 0:
            buy_dev_pct = round((buy_px - sys_buy) / sys_buy * 100.0, 2)
        sell_dev_pct = t.get("sellDevPct")
        if sell_dev_pct is None and sell_px > 0 and sys_sell1 > 0:
            sell_dev_pct = round((sell_px - sys_sell1) / sys_sell1 * 100.0, 2)

        if buy_dev_pct is not None and dir_name != "倒T":
            b_dev = float(buy_dev_pct)
            if b_dev > 1.2:
                buy_score -= min(6.0, (b_dev - 0.8) * 2.2)
            elif b_dev <= 0.15:
                buy_score = min(25.0, buy_score + 1.0)

        if sell_dev_pct is not None and is_closed:
            s_dev = float(sell_dev_pct)
            if s_dev < -1.2 and net_val >= 0:
                sell_score -= min(4.5, abs(s_dev) * 1.5)

        if is_closed and buy_px > 0:
            ret_pct = (sell_px - buy_px) / buy_px * 100.0
            if ret_pct <= -2.0:
                stop_score -= min(7.0, abs(ret_pct + 1.5) * 2.5)

        if env_level == "BAD" and dir_name in ("正T", "买入建仓", "底仓建仓", "买入加仓", "直接买入", "尾盘买入"):
            env_score -= 6.0

        alpha_str = ""
        if is_closed and sys_net is not None:
            s_net_val = float(sys_net)
            total_sys_net += s_net_val
            duel_count += 1
            alpha = round(net_val - s_net_val, 2)
            if alpha < 0:
                friction_loss += abs(alpha)
            alpha_str = f" ｜ 系统SOP理论净利 `{'+' if s_net_val >= 0 else ''}¥{s_net_val:.0f}` → 人机Alpha `{'+' if alpha >= 0 else ''}¥{alpha:.0f}`"

        dev_parts = []
        if buy_dev_pct is not None and sys_buy > 0:
            b_d = float(buy_dev_pct)
            dev_parts.append(f"买点较系统基准(¥{sys_buy:.2f})偏离 `{b_d:+.2f}%`")
        if sell_dev_pct is not None and sys_sell1 > 0:
            s_d = float(sell_dev_pct)
            dev_parts.append(f"卖点较止盈1(¥{sys_sell1:.2f})偏离 `{s_d:+.2f}%`")
        if sys_stop > 0 and sell_px > 0 and sell_px < sys_stop:
            dev_parts.append(f"⚠️ 击穿系统止损线(¥{sys_stop:.2f})后滞后出局")
        if is_pre_hol_overcap:
            if pre_hol and pre_hol.get("holidayName"):
                pos_detail = (
                    f"买后总仓 `{float(post_buy_pct_raw):.1f}%` 突破节前控仓红线(`≤{resolved_hol_cap}%`)"
                    if post_buy_pct_raw is not None
                    else f"无视节前控仓黄牌突破上限(`≤{resolved_hol_cap}%`)"
                )
                lock_detail = (
                    f"，且受 T+1 限制跨假锁定至 `{pre_hol.get('reopenDate', next_td)}` 开市"
                    if int(pre_hol.get("remainingTradeDays") or 0) == 1
                    else "，直面节前最后取现日避险抛压"
                )
                dev_parts.append(
                    f"🏮 距{pre_hol['holidayName']}连休{pre_hol['closedDays']}天仅剩{pre_hol['remainingTradeDays']}个交易日，{pos_detail}{lock_detail}"
                )
            else:
                dev_parts.append(f"🏮 触发节前长假超上限建仓违规（控仓上限 `≤{resolved_hol_cap}%`），重仓过节暴露外围风险")

        meme_note = ""
        try:
            from backend.meme_radar import diagnose_stock_meme
            m_res = diagnose_stock_meme(stock)
            if m_res.get("ok"):
                clans = [c.get("clanName") for c in m_res.get("matchedClans", []) if c.get("clanName")]
                if clans:
                    meme_note = f" ｜ 字辈谱系: {'/'.join(clans)}"
        except Exception:
            pass

        verdict_tag = "✅ 标准纪律单"
        if tag_labels:
            verdict_tag = "⚠️ " + " / ".join(tag_labels)
        elif plan_stat == "计划外":
            verdict_tag = "⚠️ 计划外临时起意"
        elif is_closed and net_val > 0:
            verdict_tag = "🏆 顺势兑现利润"

        dev_desc = "；".join(dev_parts) if dev_parts else "按实时盘口执行，无明显点位越界"
        slice_lines.append(
            f"- **第 {idx} 笔 `{stock}`（{track_label} · {dir_name} {qty}股）**：{verdict_tag}{meme_note}\n"
            f"  - 实盘买 `¥{buy_px:.2f}` / 卖 `¥{sell_px:.2f}`，净盈亏 **`{'+' if net_val >= 0 else ''}¥{net_val:.2f}`**（{plan_stat}）{alpha_str}\n"
            f"  - 量化偏离剖析：{dev_desc}"
        )

    b_sc = max(0, min(25, round(buy_score)))
    s_sc = max(0, min(25, round(sell_score)))
    st_sc = max(0, min(25, round(stop_score)))
    e_sc = max(0, min(25, round(env_score)))
    total_score = b_sc + s_sc + st_sc + e_sc

    closed_total = win_count + loss_count
    win_rate = (closed_total > 0 and (win_count / closed_total * 100.0)) or 0.0

    # 一句话犀利定性
    if pre_holiday_overcap_count > 0 and total_score < 85:
        hol_tag = f"{pre_hol['holidayName']}连休{pre_hol['closedDays']}天" if pre_hol and pre_hol.get("holidayName") else "法定长假"
        headline = (
            f"无视节前黄牌的重仓跨假博弈：{hol_tag}临近仍触发 {pre_holiday_overcap_count} 笔超上限建仓，"
            f"综合纪律降至 {total_score}/100 分（环境与仓位分 {e_sc}/25），切忌拿跨假不确定性赌节后开门红。"
        )
    elif total_score >= 85 and total_net >= 0:
        headline = f"知行合一的机构级执行日：综合纪律 {total_score} 分，买在分歧低吸位、卖在脉冲压力区，实盘落袋 {'+' if total_net >= 0 else ''}¥{total_net:.0f} 元。"
    elif total_net > 0 and total_score < 70:
        headline = f"靠运气赚到的危险盈余：虽然账面盈利 +¥{total_net:.0f} 元，但存在计划外追高或纪律偏离（纪律分仅 {total_score} 分），切忌把行情赏饭当成实力。"
    elif friction_loss > 50 and duel_count > 0:
        headline = f"败给主观情绪摩擦的一天：{duel_count} 笔人机对照单因买点追高/止损拖延合计多亏 ¥{friction_loss:.0f} 元，系统给了买点却输在了手上。"
    elif total_net < 0 and st_sc >= 20:
        headline = f"教科书式的计划内小亏：虽然净回撤 ¥{total_net:.0f} 元，但止损果断未死扛（止损分 {st_sc}/25），这种可控成本是职业做T的正常损耗。"
    else:
        headline = f"急需刹车的逆风磨损局：当日 {len(trades)} 笔操作净盈亏 {'+' if total_net >= 0 else ''}¥{total_net:.0f} 元，综合纪律 {total_score}/100 分，核心症结在于点位偏离与盘中冲动。"

    top_mistakes = sorted(mistake_counter.items(), key=lambda x: x[1], reverse=True)
    if top_mistakes:
        psych_lines = [
            f"- **头号高频心魔**：`{m_name}`（出现 **{cnt}** 次）—— 这是吞噬你今日日内 Alpha 的最大出血点。"
            for m_name, cnt in top_mistakes[:3]
        ]
    else:
        psych_lines = [
            "- **情绪平稳度良好**：今日未触发高频主观违规标签，买卖节奏整体锚定在分时均价与七格支撑阻力带内。"
        ]

    if pre_holiday_overcap_count > 0:
        hol_ctx_str = (
            f"距{pre_hol['holidayName']}连休 {pre_hol['closedDays']} 天仅剩 {pre_hol['remainingTradeDays']} 个交易日"
            if pre_hol and pre_hol.get("holidayName")
            else "连续长假前敏感控仓窗口"
        )
        psych_lines.append(
            f"- **节前重仓博弈心魔**：{hol_ctx_str}，盘前与下单均已亮出控仓黄牌（上限 `≤{eff_holiday_cap_pct}%`），仍出现 **{pre_holiday_overcap_count}** 笔超限建仓，本质是怕节后踏空而忽视跨假 T+1 锁仓与外围波动风险。"
        )
    if unplanned_count > 0:
        psych_lines.append(
            f"- **盘中临时起意警报**：共有 **{unplanned_count}** 笔交易脱离盘前预案（计划执行率 {(1 - unplanned_count / len(trades)) * 100:.0f}%），盘中看分时脉冲临时下单极易买在情绪高点。"
        )
    if friction_loss > 0:
        psych_lines.append(
            f"- **主观情绪摩擦账单**：对比系统 SOP 标准买卖点，主观操作额外造成 **-¥{friction_loss:.0f} 元** 摩擦损耗。"
        )
    if not cal_ctx["isTradeDay"]:
        psych_lines.append(
            f"- **交易日历归属核验**：所选复盘日期 `{cal_ctx['dateStr']}` 为 **{cal_ctx['label']}**，流水归属最近交易日 `{cal_ctx['latestTradeDate']}`，下一开市交易日为 `{next_td}`。"
        )
    if user_notes and user_notes.strip():
        psych_lines.append(f"- **交易员自省印证**：你在笔记中提到 *“{user_notes.strip()}”*，建议将其固化为下一交易日（{next_td}）盘前硬约束。")

    sop_rules: List[str] = []
    if env_level == "OK":
        sop_rules.append(
            "1. **上升通道 · 格局与顺势加仓铁律**：当前双指数站稳均线（上升通道），主线前排龙头与容量中军沿 `MA5 / MA10` 拉长格局时间扩大战果，逢分时均线或五日线缩量回踩顺势加仓，切忌赚两三个点就轻易下车卖飞。"
        )
    else:
        sop_rules.append(
            f"1. **下跌/弱势通道 · 保命铁律（当前 {env_level} · 不存在踏空！）**：① **严禁浮亏补仓摊平**（杜绝一路跌一路补）；② **T+1 收盘审判**：建仓次日盘中跌了不急补不乱割，收盘若仍收绿直接割肉换票，绝不幻想第3天反包；③ **三连阳兑现**：建仓收红后连红满 3 天必须主动减仓，最迟出现**首阴收盘无条件清仓**！"
        )

    if b_sc < 20:
        sop_rules.append(
            "2. **选股严禁「看A做B」买后排补涨**：只做有持续性主线板块的前排身位龙或成交前二的容量中军，同板块已有涨停先锋时绝不因畏高去买后排跟风股；正T只预埋在 `inA / inB` 缩量回踩处。"
        )
    else:
        sop_rules.append(
            "2. **聚焦持续性主线前排**：延续先选持续性板块、再锁前排核心的选股纪律，振幅不足 3 格或散乱独苗板块全天免战。"
        )

    if st_sc < 20 or s_sc < 20:
        sop_rules.append(
            "3. **硬止损与连涨止盈闭环**：跌破系统 `slA` 止损线或 T+1 收绿无条件离场，日内正T仓位 14:50 前必须平出，绝不让做T演变成被动死扛加仓。"
        )
    else:
        sop_rules.append(
            "3. **锁死单日熔断底线**：保持当前纪律执行力，单日连续止损达 2 笔或账户回撤触及 2.0% 时立即开启作战台熔断锁休息。"
        )

    if is_pre_hol_alert and pre_hol and int(pre_hol.get("remainingTradeDays") or 0) == 2:
        sop_rules.append(
            f"4. **跨长假节前降仓铁律（明日 {next_td} 为{pre_hol['holidayName']}连休 {pre_hol['closedDays']} 天前最后 1 个交易日）**：明日新开仓受 T+1 限制将跨假锁定至 `{pre_hol['reopenDate']}` 开市；务必趁明日早盘冲高去弱留强，将隔夜总仓位压降至 **`≤{eff_holiday_cap_pct}%`（{pre_hol['posRangeLabel']}）** 以内，严禁尾盘超限偷袭赌假期消息！"
        )
    elif closed_ahead >= 3:
        hol_name_str = f"{pre_hol['holidayName']}" if pre_hol and pre_hol.get("holidayName") else "法定长假"
        overcap_extra = (
            f"今日已触发节前超限建仓违规，节后首日（{next_td}）竞价若不及预期须在 09:30~10:00 优先减回 `≤{eff_holiday_cap_pct}%` 安全线，"
            if pre_holiday_overcap_count > 0
            else f"节后首日（{next_td}）竞价严防情绪高低切兑现，"
        )
        sop_rules.append(
            f"4. **跨长假风控纪律（距下一交易日 {next_td} 迎来{hol_name_str}连续休市 {closed_ahead} 天）**：跨法定节假日期间外围市场与政策消息面不确定性较高，{overcap_extra}切忌开盘盲目顶高。"
        )

    sop_heading = f"### 🛡️ 明日必须坚守的实战行动清单 (Actionable SOP · 下一交易日 {next_td})"

    review_md = (
        f"### 🎯 一句话犀利定性\n"
        f"{headline}\n\n"
        f"### 📊 操盘纪律综合评分（满分 100 分）\n"
        f"- **综合得分**: **{total_score} 分**（平仓胜率 {win_rate:.0f}% ｜ 实盘净额 `{'+' if total_net >= 0 else ''}¥{total_net:.2f}`"
        f"{f' ｜ 系统SOP基准 `+{total_sys_net:.0f}` 元' if duel_count > 0 and total_sys_net >= 0 else (f' ｜ 系统SOP基准 `{total_sys_net:.0f}` 元' if duel_count > 0 else '')}）\n"
        f"- **四维分项剖析**:\n"
        f"  - **买点与龙头身位分**：`{b_sc} / 25`（检验是否聚焦前排龙头回踩、有无追高或看A做B买后排）\n"
        f"  - **卖点与三连阳止盈分**：`{s_sc} / 25`（检验弱势连红3天减仓/首阴清仓、上升期有无过早卖飞）\n"
        f"  - **止损与禁逆势补仓分**：`{st_sc} / 25`（检验 T+1 收绿止损、破位执行力与有无浮亏死补摊平）\n"
        f"  - **大盘通道与仓位分**：`{e_sc} / 25`（检验双通道仓位匹配度、节前长假控仓上限与防报复交易）\n\n"
        f"### 🔍 逐笔实操切片诊断\n"
        + "\n".join(slice_lines)
        + "\n\n### 🧠 交易心魔与心理博弈剖析\n"
        + "\n".join(psych_lines)
        + f"\n\n{sop_heading}\n"
        + "\n".join(sop_rules)
    )

    return {
        "ok": True,
        "engine": "quant_rule",
        "aiConfigured": False,
        "date": date,
        "calendar": cal_ctx,
        "model": "内置量化规则教练 v3 (三步实战体系双通道引擎)",
        "latencyMs": 1,
        "totalTrades": len(trades),
        "totalNet": round(total_net, 2),
        "disciplineScore": total_score,
        "subScores": {
            "buy": b_sc,
            "sell": s_sc,
            "stop": st_sc,
            "env": e_sc,
        },
        "preHolidayOvercapCount": pre_holiday_overcap_count,
        "frictionLoss": round(friction_loss, 2),
        "review": review_md,
    }


COACH_SYSTEM_PROMPT = """你是由顶级对冲基金操盘手与资深A股游资共同打造的「智策战情室 · 顶级职业交易教练 (AI Trading Coach)」。
你的职责：以犀利、客观、专业、不留情面的实战视角，对交易员今日的实盘操作进行深度复盘诊断。
你严格奉行「三步实战铁律」进行审计：
1. 第一步看大盘定双通道时钟：
   - 上升通道（OK）：逢回调顺势加仓，拉长格局时间扩大战果，严防拿震荡思维过早卖飞主升大牛股；
   - 下跌/弱势通道（WARN/BAD）：不存在踏空！严禁浮亏向下补仓摊平（防一路跌一路补深套）；建仓次日盘中跌了不急补不乱割，收盘若仍收绿必须果断割肉换票（绝不幻想第3天反包）；建仓收红后若连红满3天必须主动减仓，最多格局到收盘首阴无条件清仓，严防第4天核按钮闷杀；
2. 第二步选持续性板块：只做有持续资金流入与梯队效应的主线板块，警惕孤狼单打一日游；
3. 第三步只买前排龙头、严禁看A做B买后排补涨：前排涨得多跌得少接力多，后排跟风跌得多涨得少，绝不因畏高龙头而买后排垃圾；
4. 日内做T与人机对决：日内做T以回踩VWAP分时均价线为准绳，绝不让做T变成被动隔夜加仓，精确核算主观情绪摩擦损耗；
5. 节前长假控仓铁律：连续≥3天法定长假前1-2个交易日严控隔夜总仓位（7天以上长假≤30%，3-6天小长假≤50%，并与情绪闸门上限从严叠加），严禁无视控仓黄牌超限建仓或节前收官日尾盘重仓赌假期消息。

请根据用户提供的交易流水、盘面数据、计划偏离度%、失误归因与心得，给出结构化、深度透彻的复盘诊断报告。
报告语气：如严师般冷静、客观、直指命门，给出清晰、可执行的下一步修正SOP。"""


async def generate_coach_review(
    trades: List[Dict[str, Any]],
    date: str,
    market_env: Optional[Dict[str, Any]] = None,
    user_notes: Optional[str] = None,
    api_key: Optional[str] = None,
    api_url: Optional[str] = None,
    model: Optional[str] = None,
    mode: str = "auto",
) -> Dict[str, Any]:
    """生成专业级每日操盘复盘诊断：支持 LLM 深度诊断与内置量化规则教练自动无缝切换"""
    if not trades:
        raise ValueError("复盘流水记录为空，请至少录入一笔交易记录后再呼叫复盘教练。")

    cfg = get_coach_config()
    raw_key = (
        (api_key or "").strip()
        or os.getenv("AI_COACH_API_KEY", "").strip()
        or os.getenv("TIANYI_API_KEY", "").strip()
        or os.getenv("OPENAI_API_KEY", "").strip()
    )
    final_key = _clean_api_key(raw_key)
    final_url = (api_url or "").strip() or cfg["apiUrl"]
    final_model = (model or "").strip() or cfg["model"]

    # 先运行确定性量化规则引擎（毫秒级产出客观评分与偏离度基准）
    quant_res = build_quant_rule_review(
        trades=trades,
        date=date,
        market_env=market_env,
        user_notes=user_notes,
    )
    quant_res["aiConfigured"] = bool(final_key)

    if mode == "rule" or not final_key:
        return quant_res

    # 格式化流水供大模型 Prompt 使用（注入精确点位偏离度与客观纪律分）
    trades_text_list = []
    total_net = 0.0
    for idx, t in enumerate(trades, 1):
        stock = t.get("stock", "未知标的")
        track = "长线做T轨" if t.get("track") == "long_t" else ("短线攻防轨" if t.get("track") == "short_swing" else "通用流水")
        dir_name = t.get("dir", "做T")
        buy_px = float(t.get("buy") or 0)
        sell_px = float(t.get("sell") or 0)
        qty = t.get("qty", 0)
        net_val = float(t.get("net", 0) or 0)
        total_net += net_val
        plan_stat = t.get("plan", "计划内")
        basis = t.get("basis", "技术信号")
        mistakes = _normalize_mistake_labels(t.get("mistakeTags", []))
        mistakes_str = "、".join(mistakes) if mistakes else "无明显打标"
        note = t.get("reflection", "") or t.get("note", "") or "无"

        bench = t.get("systemBenchmark") or {}
        bench_str = ""
        if bench.get("sysBuy"):
            b_dev = t.get("buyDevPct")
            s_dev = t.get("sellDevPct")
            dev_extra = ""
            if b_dev is not None:
                dev_extra += f" (买点偏离 {float(b_dev):+.2f}%)"
            if s_dev is not None:
                dev_extra += f" (卖点偏离 {float(s_dev):+.2f}%)"
            bench_str = (
                f"\n  - 系统SOP基准: 推荐买 ¥{bench.get('sysBuy')}, 止盈1 ¥{bench.get('sysSell1')}, "
                f"止损 ¥{bench.get('sysStop')}, 理论净利 ¥{bench.get('sysNet', '—')}{dev_extra}"
            )

        meme_diag_str = ""
        try:
            from backend.meme_radar import diagnose_stock_meme
            m_res = diagnose_stock_meme(stock)
            if m_res.get("ok"):
                verdict = m_res.get("verdict", {})
                clans = [c.get("clanName") for c in m_res.get("matchedClans", [])]
                clans_desc = "、".join(clans) if clans else "独立个股"
                meme_diag_str = f"\n  - 模因与共振体检: 谱系[{clans_desc}] ｜ {verdict.get('title')}"
        except Exception:
            pass

        hol_pos_str = ""
        if t.get("postBuyPosPct") is not None:
            cap_note = f" / 节前上限 ≤{t.get('holidayCapPct')}%" if t.get("holidayCapPct") is not None else ""
            hol_pos_str = f"\n  - 买后总仓位占比: {float(t.get('postBuyPosPct')):.1f}%{cap_note}"

        trades_text_list.append(
            f"第{idx}笔: 【{stock}】（{track} · {dir_name}）\n"
            f"  - 成交参数: 买入价 ¥{buy_px:.2f} ｜ 卖出价 ¥{sell_px:.2f} ｜ 股数 {qty} 股\n"
            f"  - 净套利额: {'+' if net_val >= 0 else ''}{net_val:.2f} 元 ｜ 决策计划: {plan_stat} ({basis})\n"
            f"  - 归因失误标签: [{mistakes_str}]\n"
            f"  - 反思与备注: {note}{hol_pos_str}{bench_str}{meme_diag_str}"
        )

    trades_summary_text = "\n\n".join(trades_text_list)

    env_desc = "正常/平稳"
    if market_env:
        env_desc = f"环境评级 {market_env.get('level', 'OK')}（{market_env.get('text', '')}）"

    cal_ctx = quant_res.get("calendar") or get_market_calendar_snapshot(date)
    up_hol = cal_ctx.get("upcomingHoliday") if isinstance(cal_ctx.get("upcomingHoliday"), dict) else None
    up_hol_note = (
        f"，距{up_hol['holidayName']}连休{up_hol['closedDays']}天仅剩{up_hol['remainingTradeDays']}个交易日（建议上限≤{up_hol['suggestedMaxPosPct']}%）"
        if up_hol and up_hol.get("isHighAlert")
        else (f"，中间连续休市 {cal_ctx['closedDaysAhead']} 天" if cal_ctx.get("closedDaysAhead", 0) >= 3 else "")
    )
    cal_desc = (
        f"交易日（下一交易日 {cal_ctx['nextTradeDate']}{up_hol_note}）"
        if cal_ctx.get("isTradeDay")
        else f"{cal_ctx.get('label', '休市')}（归属最近交易日 {cal_ctx.get('latestTradeDate')}，下一交易日 {cal_ctx.get('nextTradeDate')}）"
    )

    prompt = f"""【交易员今日实盘复盘诊断请求】
- 复盘日期: {date}（A股交易日历：{cal_desc}）
- 当日大盘风控环境: {env_desc}
- 今日实盘总净收益: {'+' if total_net >= 0 else ''}{total_net:.2f} 元 (共 {len(trades)} 笔操作)
- 量化引擎客观参考纪律分: {quant_res['disciplineScore']}/100 分（主观情绪摩擦损耗 ¥{quant_res['frictionLoss']:.2f} 元）
- 交易员总体心态留言: {user_notes or '（未额外填写整体心得）'}

【今日各笔详细成交流水明细】:
{trades_summary_text}

请严格按照以下结构输出复盘诊断（使用 Markdown 格式，注重排版清晰、字字珠玑）：

### 🎯 一句话犀利定性
（用最生动且专业的量化交易行话，一语道破交易员今日操作的全局核心问题或亮点）

### 📊 操盘纪律综合评分（满分 100 分）
- **综合得分**: XX 分
- **分项剖析**:
  - 买点时机分（是否符合回踩低吸/起爆条件、有无追高）：X/25
  - 卖点与止盈分（是否贪婪未分批兑现、有无恐慌卖飞）：X/25
  - 止损硬纪律分（是否破位死扛、是否坚决执行止损）：X/25
  - 大局观与仓位分（是否遵从大盘环境、仓位是否失控）：X/25

### 🔍 逐笔实操切片诊断
（针对提供的每一笔操作逐一分析：点位质量、与系统理论SOP的偏离度%、心魔归因、主观情绪摩擦损耗金额）

### 🧠 交易心魔与心理博弈剖析
（深入分析交易员表现出的贪婪、恐惧、踏空焦虑或侥幸心理，揭示导致亏损的认知盲区）

### 🛡️ 明日必须坚守的实战行动清单 (Actionable SOP)
（给出 3 条绝不能违背的高压线或操作纪律，越明确、越量化越好）"""

    headers = {
        "Authorization": f"Bearer {final_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": final_model,
        "messages": [
            {"role": "system", "content": COACH_SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": 4096,
        "temperature": 0.35,
    }

    t0 = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(75.0), trust_env=False) as client:
            resp = await client.post(final_url, json=payload, headers=headers)
        latency_ms = int((time.monotonic() - t0) * 1000)

        if resp.status_code != 200:
            err_msg = resp.text
            try:
                err_json = resp.json()
                err_msg = err_json.get("error", {}).get("message") or err_json.get("message") or resp.text
            except Exception:
                pass
            raise RuntimeError(f"HTTP {resp.status_code}: {err_msg}")

        data = resp.json()
        choices = data.get("choices", [])
        if not choices or not isinstance(choices, list):
            raise ValueError(f"大模型返回格式异常: {data}")

        msg = choices[0].get("message", {})
        review_content = (msg.get("content") or "").strip()
        if not review_content and msg.get("reasoning_content"):
            review_content = msg.get("reasoning_content", "").strip()

        return {
            "ok": True,
            "engine": "llm",
            "aiConfigured": True,
            "date": date,
            "calendar": cal_ctx,
            "model": final_model,
            "latencyMs": latency_ms,
            "totalTrades": len(trades),
            "totalNet": round(total_net, 2),
            "disciplineScore": quant_res["disciplineScore"],
            "subScores": quant_res["subScores"],
            "frictionLoss": quant_res["frictionLoss"],
            "review": review_content,
        }
    except Exception as exc:
        # 大模型网络异常或密钥失效时，自动无缝降级至内置量化规则教练并附带原因说明
        fallback = dict(quant_res)
        fallback["fallbackReason"] = f"大模型网关暂不可用（{exc}），已自动切换至内置量化规则教练输出完整复盘报告"
        return fallback
