"""backend/coach.py

智策战情室 · AI 交易复盘教练引擎
支持天翼云 OpenAI 兼容接口 (https://ai.ctaigw.cn/v1/chat/completions) 及自定义大模型网关。
"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Dict, List, Optional
import httpx

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
    """获取当前 AI 教练的大模型配置状态"""
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
    raw_key = (api_key or "").strip() or os.getenv("AI_COACH_API_KEY", "").strip() or os.getenv("TIANYI_API_KEY", "").strip() or os.getenv("OPENAI_API_KEY", "").strip()
    final_key = _clean_api_key(raw_key)
    final_url = (api_url or "").strip() or cfg["apiUrl"]
    final_model = (model or "").strip() or cfg["model"]

    if not final_key:
        raise ValueError("尚未配置 API 密钥，请在项目根目录 .env 中填入 AI_COACH_API_KEY，或在弹窗中直接输入。")

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
            raise ConnectionError(f"无法连接到天翼云接口 ({final_url})，请检查网络或 URL: {exc}") from exc
        except httpx.TimeoutException as exc:
            raise TimeoutError("天翼云 API 请求超时 (20s)，请检查网络状况或稍候重试") from exc

    latency_ms = int((time.monotonic() - t0) * 1000)

    if resp.status_code != 200:
        err_msg = resp.text
        try:
            err_json = resp.json()
            err_msg = err_json.get("error", {}).get("message") or err_json.get("message") or resp.text
        except Exception:
            pass
        raise RuntimeError(f"天翼云 API 返回错误 HTTP {resp.status_code}: {err_msg}")

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


COACH_SYSTEM_PROMPT = """你是由顶级对冲基金操盘手与资深A股游资共同打造的「智策战情室 · 顶级职业交易教练 (AI Trading Coach)」。
你的职责：以犀利、客观、专业、不留情面的实战视角，对交易员今日的实盘操作进行深度复盘诊断。
你深刻理解：
1. A股交易制度与做T本质：日内做T以回踩VWAP分时均价线为准绳，绝不追高，破位坚决止损，绝不让做T变成被动隔夜加仓；
2. 大盘环境闸门：大盘破位MA20（BAD环境）时逆市开仓九死一生，宁缺毋滥；
3. 交易心魔与人性弱点：贪婪（追高天花板）、恐惧（刚回调就抢跑割肉）、侥幸（破位死扛不认输）、报复性交易（亏钱后冲动开仓试图翻本）；
4. 人机对决与摩擦成本：必须明确计算由于交易员“主观情绪犯错（未按系统推荐点位挂单）”造成的真金白银亏损（即主观情绪摩擦损耗）；
5. A股情绪模因与玄学共振：深刻理解东方系、日/阳字辈、华字辈、龙蛇生肖、中字头等名字字辈炒作背后的行为金融学本质（低成本共识与模因溢价）。对交易进行「五维共振」检验（个股 × 板块/宗族 × 指数 × 情绪 × 空间梯队），警惕孤狼单打（板块无跟风、一日游）与滞后接盘（高潮末期最后一棒）。

请根据用户提供的交易流水、盘面数据、失误归因、玄学字辈共振背景与心得，给出结构化、深度透彻的复盘诊断报告。
报告语气：如严师般冷静、客观、直指命门，但同时给出清晰、可执行的下一步修正SOP。"""


async def generate_coach_review(
    trades: List[Dict[str, Any]],
    date: str,
    market_env: Optional[Dict[str, Any]] = None,
    user_notes: Optional[str] = None,
    api_key: Optional[str] = None,
    api_url: Optional[str] = None,
    model: Optional[str] = None,
) -> Dict[str, Any]:
    """调用天翼云 OpenAI 接口生成专业级每日操盘复盘诊断"""
    cfg = get_coach_config()
    raw_key = (api_key or "").strip() or os.getenv("AI_COACH_API_KEY", "").strip() or os.getenv("TIANYI_API_KEY", "").strip() or os.getenv("OPENAI_API_KEY", "").strip()
    final_key = _clean_api_key(raw_key)
    final_url = (api_url or "").strip() or cfg["apiUrl"]
    final_model = (model or "").strip() or cfg["model"]

    if not final_key:
        raise ValueError("尚未配置天翼云 API 秘钥，请在 .env 中设置 AI_COACH_API_KEY 或在页面输入。")

    if not trades:
        raise ValueError("复盘流水记录为空，请至少录入一笔交易记录后再呼叫 AI 复盘教练。")

    # 格式化流水供 Prompt 使用
    trades_text_list = []
    total_net = 0.0
    for idx, t in enumerate(trades, 1):
        stock = t.get("stock", "未知标的")
        track = "长线做T轨" if t.get("track") == "long_t" else ("短线攻防轨" if t.get("track") == "short_swing" else "通用流水")
        dir_name = t.get("dir", "做T")
        buy_px = t.get("buy", 0)
        sell_px = t.get("sell", 0)
        qty = t.get("qty", 0)
        net_val = float(t.get("net", 0) or 0)
        total_net += net_val
        plan_stat = t.get("plan", "计划内")
        basis = t.get("basis", "技术信号")
        mistakes = t.get("mistakeTags", [])
        mistakes_str = "、".join(mistakes) if mistakes else "无明显打标"
        note = t.get("note", "") or t.get("reflection", "") or "无"
        
        # 提取系统理论基准点位（若有）
        bench = t.get("systemBenchmark") or {}
        bench_str = ""
        if bench.get("sysBuy"):
            bench_str = f" ｜ 系统推荐买入区间: {bench.get('sysBuy')}, 冲高目标1: {bench.get('sysSell1')}, 止损线: {bench.get('sysStop')}"

        # 尝试进行玄学宗族与共振背景检测
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

        trades_text_list.append(
            f"第{idx}笔: 【{stock}】（{track} · {dir_name}）\n"
            f"  - 成交参数: 买入价 ¥{buy_px:.2f} ｜ 卖出价 ¥{sell_px:.2f} ｜ 股数 {qty} 股\n"
            f"  - 净套利额: {'+' if net_val >= 0 else ''}{net_val:.2f} 元 ｜ 决策计划: {plan_stat} ({basis})\n"
            f"  - 交易员归因失误标签: [{mistakes_str}]\n"
            f"  - 交易员个人反思心得: {note}{bench_str}{meme_diag_str}"
        )

    trades_summary_text = "\n\n".join(trades_text_list)

    env_desc = "正常/平稳"
    env_level = "OK"
    if market_env:
        env_level = market_env.get("level", "OK")
        env_desc = f"环境评级 {env_level}（{market_env.get('text', '')}）"

    prompt = f"""【交易员今日实盘复盘诊断请求】
- 复盘日期: {date}
- 当日大盘风控环境: {env_desc}
- 今日实盘总净收益: {'+' if total_net >= 0 else ''}{total_net:.2f} 元 (共 {len(trades)} 笔操作)
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
  - 止损硬纪律分（是否破位死扛、是否坚决执行1.5%止损）：X/25
  - 大局观与仓位分（是否遵从大盘环境、仓位是否失控）：X/25

### 🔍 逐笔实操切片诊断
（针对提供的每一笔操作逐一分析：点位质量、与系统理论SOP的偏离度、心魔归因、产生了多少由于追高/死扛造成的主观情绪摩擦损耗金额）

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
    async with httpx.AsyncClient(timeout=httpx.Timeout(90.0), trust_env=False) as client:
        try:
            resp = await client.post(final_url, json=payload, headers=headers)
        except httpx.ConnectError as exc:
            raise ConnectionError(f"连接天翼云 API 失败 ({final_url}): {exc}") from exc
        except httpx.TimeoutException as exc:
            raise TimeoutError("AI 复盘请求超时 (90s)，天翼云大模型正在繁忙，请稍候重试") from exc

    latency_ms = int((time.monotonic() - t0) * 1000)

    if resp.status_code != 200:
        err_msg = resp.text
        try:
            err_json = resp.json()
            err_msg = err_json.get("error", {}).get("message") or err_json.get("message") or resp.text
        except Exception:
            pass
        raise RuntimeError(f"天翼云 API 报错 HTTP {resp.status_code}: {err_msg}")

    data = resp.json()
    choices = data.get("choices", [])
    if not choices or not isinstance(choices, list):
        raise ValueError(f"天翼云 API 返回格式异常: {data}")

    msg = choices[0].get("message", {})
    review_content = (msg.get("content") or "").strip()
    if not review_content and msg.get("reasoning_content"):
        review_content = msg.get("reasoning_content", "").strip()

    return {
        "ok": True,
        "date": date,
        "model": final_model,
        "latencyMs": latency_ms,
        "totalTrades": len(trades),
        "totalNet": round(total_net, 2),
        "review": review_content,
    }
