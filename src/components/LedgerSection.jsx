import React, { useState, useMemo, useEffect } from 'react';
import { f2, money, pct, todayStr, toast, toastOk, toastErr, copyPlain } from '../services/utils.js';
import { fetchCoachConfig, testCoachConnection, fetchCoachReview } from '../services/api.js';

/* 结构化交易失误归因基因字典 */
export const MISTAKE_DICTIONARY = [
  { id: 'fomo_chase', category: '买入心理', name: '追高天花板', icon: '🚀', desc: '未等缩量回踩，看到分时拉升冲动追买在全天最高位' },
  { id: 'no_stoploss', category: '纪律执行', name: '破位死扛不认输', icon: '🛡️', desc: '触及纪律止损位或跌破均价线心存侥幸不斩仓，被动躺平' },
  { id: 't_to_add', category: '定位混乱', name: '做T做反变加仓', icon: '🔄', desc: '正T买入后未冲高，尾盘舍不得平仓导致日内T仓变成隔夜加仓' },
  { id: 'early_exit', category: '持股耐心', name: '过早卖飞大肉', icon: '🕊️', desc: '分时均线平稳未破，刚涨 1% 就恐慌抛光，错失后续大波段' },
  { id: 'against_trend', category: '大局观', name: '逆市顶风作案', icon: '🚨', desc: '大盘环境已亮红灯 BAD（双破 MA20），仍强行开仓做多' },
  { id: 'heavy_gamble', category: '仓位控制', name: '短线重仓单赌', icon: '💣', desc: '超过系统建议的 10% 顶格仓位，单票重仓导致心理严重变形' },
  { id: 'impulse_t', category: '节奏失序', name: '无量冲动乱T', icon: '⚡', desc: '无关键支撑压力位、量比平平无奇时频繁开仓磨损手续费' },
  { id: 'revenge_trade', category: '心态失衡', name: '报复性交易', icon: '💢', desc: '前一笔刚亏损，急于回本立刻盲目开新仓' },
  { id: 'lone_wolf', category: '共振失误', name: '孤狼单打一日游', icon: '🐺', desc: '板块或同字辈宗族无跟风，单兵脉冲自拉自唱，次日熄火被套' },
  { id: 'late_chase', category: '节奏失序', name: '滞后接盘高潮棒', icon: '⏰', desc: '全网明牌高潮狂欢时才后知后觉追高，刚好接在主力分歧出货末端' },
];

const LOCAL_AI_KEY = 'tstock_ai_coach_config';

export default function LedgerSection({
  logs = [],
  wbLatest = null,
  onAddLog,
  onDeleteLog,
  pool = [],
  onExport,
  onImportClick
}) {
  // 核心导航轨制：'ALL' | 'long_t' | 'short_swing' | 'BENCHMARK'
  const [activeTrackTab, setActiveTrackTab] = useState('ALL');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showCoachModal, setShowCoachModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [selectedChartStock, setSelectedChartStock] = useState('ALL');
  const [hoverIdx, setHoverIdx] = useState(null);

  // AI 配置状态
  const [aiConfig, setAiConfig] = useState({
    apiUrl: 'https://ai.ctaigw.cn/v1/chat/completions',
    apiKey: '',
    model: 'deepseek-chat',
    configuredInEnv: false,
    maskedEnvKey: ''
  });
  const [testingAi, setTestingAi] = useState(false);
  const [testResult, setTestResult] = useState(null);

  // AI 复盘对话状态
  const [coachDate, setCoachDate] = useState(todayStr());
  const [coachNotes, setCoachNotes] = useState('');
  const [coachLoading, setCoachLoading] = useState(false);
  const [coachReviewResult, setCoachReviewResult] = useState(null);

  // 表单状态
  const [form, setForm] = useState({
    date: todayStr(),
    track: 'long_t', // 'long_t' | 'short_swing'
    stock: pool.length ? `${pool[0].name} (${pool[0].code})` : '',
    dir: '正T',
    buy: '',
    sell: '',
    qty: '500',
    plan: '计划内',
    basis: '客观信号',
    mistakeTags: [],
    note: '',
    reflection: '',
    satisfaction: 5
  });

  // 读取后端与本地 AI 配置
  useEffect(() => {
    let localSaved = {};
    try {
      const raw = localStorage.getItem(LOCAL_AI_KEY);
      if (raw) localSaved = JSON.parse(raw);
    } catch {}

    fetchCoachConfig().then(cfg => {
      setAiConfig(prev => ({
        ...prev,
        apiUrl: localSaved.apiUrl || cfg.apiUrl || 'https://ai.ctaigw.cn/v1/chat/completions',
        apiKey: localSaved.apiKey || '',
        model: localSaved.model || cfg.model || 'deepseek-chat',
        configuredInEnv: cfg.configured,
        maskedEnvKey: cfg.maskedKey || ''
      }));
    }).catch(() => {
      setAiConfig(prev => ({
        ...prev,
        apiUrl: localSaved.apiUrl || 'https://ai.ctaigw.cn/v1/chat/completions',
        apiKey: localSaved.apiKey || '',
        model: localSaved.model || 'deepseek-chat'
      }));
    });
  }, []);

  const handleSaveAiConfig = (newCfg) => {
    setAiConfig(prev => ({ ...prev, ...newCfg }));
    try {
      localStorage.setItem(LOCAL_AI_KEY, JSON.stringify({
        apiUrl: newCfg.apiUrl,
        apiKey: newCfg.apiKey,
        model: newCfg.model
      }));
      toastOk('AI 教练配置已保存！');
    } catch {}
  };

  const handleTestAi = async () => {
    setTestingAi(true);
    setTestResult(null);
    try {
      const res = await testCoachConnection({
        apiKey: aiConfig.apiKey,
        apiUrl: aiConfig.apiUrl,
        model: aiConfig.model
      });
      setTestResult({ ok: true, text: `✅ 连通成功！延迟 ${res.latencyMs}ms ｜ 模型返回: "${res.reply}"` });
    } catch (err) {
      setTestResult({ ok: false, text: `❌ 连接失败: ${err.message}` });
    } finally {
      setTestingAi(false);
    }
  };

  const handleRunCoach = async () => {
    const targetTrades = (logs || []).filter(l => l.date === coachDate);
    if (!targetTrades.length) {
      toastErr(`日期 ${coachDate} 暂无任何成交流水记录，请先录入该日的交易！`);
      return;
    }

    setCoachLoading(true);
    setCoachReviewResult(null);
    try {
      const marketEnv = wbLatest?.env || { level: 'OK', text: '大盘平稳' };
      const res = await fetchCoachReview({
        trades: targetTrades,
        date: coachDate,
        marketEnv,
        userNotes: coachNotes,
        apiKey: aiConfig.apiKey,
        apiUrl: aiConfig.apiUrl,
        model: aiConfig.model
      });
      setCoachReviewResult(res);
      toastOk('AI 复盘诊断书已生成！');
    } catch (err) {
      toastErr(err.message || 'AI 复盘生成失败');
    } finally {
      setCoachLoading(false);
    }
  };

  // 标的匹配系统标准点位
  const matchedSysBenchmark = useMemo(() => {
    if (!form.stock) return null;
    const cleanStock = form.stock.replace(/[()（）\s]/g, '');
    
    // 1. 优先查当期做T候选池
    const cands = wbLatest?.candidates || [];
    const hitCand = cands.find(c => cleanStock.includes(c.code) || cleanStock.includes(c.name));
    if (hitCand) {
      return {
        source: '做T短线候选',
        sysBuy: hitCand.buy || hitCand.buyLo || hitCand.price,
        sysSell1: hitCand.sell1 || hitCand.target || +(hitCand.price * 1.025).toFixed(2),
        sysSell2: hitCand.sell2 || +(hitCand.price * 1.045).toFixed(2),
        sysStop: hitCand.stop || +(hitCand.price * 0.985).toFixed(2),
        verdict: hitCand.verdict || '可做'
      };
    }

    // 2. 查尾盘黑马
    const tails = wbLatest?.tail || [];
    const hitTail = tails.find(t => cleanStock.includes(t.code) || cleanStock.includes(t.name));
    if (hitTail) {
      return {
        source: '尾盘黑马',
        sysBuy: hitTail.price,
        sysSell1: hitTail.sell1 || +(hitTail.price * 1.025).toFixed(2),
        sysSell2: hitTail.sell2 || +(hitTail.price * 1.045).toFixed(2),
        sysStop: hitTail.stop || +(hitTail.price * 0.985).toFixed(2),
        verdict: hitTail.verdict || '可挂'
      };
    }

    // 3. 查自选池底仓参考价
    const hitPool = pool.find(p => cleanStock.includes(p.code) || cleanStock.includes(p.name));
    if (hitPool) {
      return {
        source: '自选底仓',
        sysBuy: hitPool.bePrice || hitPool.cost || 0,
        sysSell1: hitPool.targetPrice || +(hitPool.cost * 1.03).toFixed(2),
        sysSell2: +(hitPool.cost * 1.05).toFixed(2),
        sysStop: hitPool.stopLoss || +(hitPool.cost * 0.985).toFixed(2),
        verdict: '底仓持仓'
      };
    }

    return null;
  }, [form.stock, wbLatest, pool]);

  const handleFormChange = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

  const toggleMistakeTag = (tagId) => {
    setForm(prev => {
      const exists = prev.mistakeTags.includes(tagId);
      return {
        ...prev,
        mistakeTags: exists
          ? prev.mistakeTags.filter(id => id !== tagId)
          : [...prev.mistakeTags, tagId]
      };
    });
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const b = parseFloat(form.buy) || 0;
    const s = parseFloat(form.sell) || 0;
    const q = parseInt(form.qty, 10) || 0;
    if (b <= 0 || s <= 0 || q <= 0) {
      alert('请输入正确的买卖价格与股数');
      return;
    }
    const gross = (s - b) * q;
    const buyFee = Math.max(5, b * q * 0.00025) + b * q * 0.00001;
    const sellFee = Math.max(5, s * q * 0.00025) + s * q * 0.00051;
    const fee = Math.round((buyFee + sellFee) * 100) / 100;
    const net = Math.round((gross - fee) * 100) / 100;

    // 计算系统理论基准净收益对比
    let sysBenchmark = null;
    let alphaNet = 0;
    if (matchedSysBenchmark && matchedSysBenchmark.sysBuy > 0) {
      const sysBuyPx = matchedSysBenchmark.sysBuy;
      const sysSellPx = matchedSysBenchmark.sysSell1;
      const sysGross = (sysSellPx - sysBuyPx) * q;
      const sysFee = Math.round(((Math.max(5, sysBuyPx * q * 0.00025)) + (Math.max(5, sysSellPx * q * 0.00025) + sysSellPx * q * 0.00051)) * 100) / 100;
      const sysNet = Math.round((sysGross - sysFee) * 100) / 100;
      sysBenchmark = {
        ...matchedSysBenchmark,
        sysNet
      };
      alphaNet = Math.round((net - sysNet) * 100) / 100; // >0 说明跑赢系统理论，<0 为主观情绪损耗
    }

    onAddLog({
      id: Date.now(),
      date: form.date,
      track: form.track,
      stock: form.stock,
      dir: form.dir,
      buy: b,
      sell: s,
      qty: q,
      gross,
      fee,
      net,
      plan: form.plan,
      basis: form.basis,
      mistakeTags: form.mistakeTags,
      note: form.note,
      reflection: form.reflection,
      satisfaction: form.satisfaction,
      systemBenchmark: sysBenchmark,
      alphaNet
    });

    setShowAddModal(false);
    setForm(prev => ({
      ...prev,
      buy: '',
      sell: '',
      mistakeTags: [],
      note: '',
      reflection: ''
    }));
  };

  // 僵尸股筛查
  const zombieStocks = pool.filter(s => {
    const amp = s.prevClose > 0 && s.high && s.low ? ((s.high - s.low) / s.prevClose) * 100 : 0;
    return amp > 0 && amp < 3.5;
  });

  // 按轨制筛选流水
  const filteredLogs = useMemo(() => {
    return (logs || []).filter(lg => {
      const track = lg.track || 'long_t';
      if (activeTrackTab === 'long_t') return track === 'long_t';
      if (activeTrackTab === 'short_swing') return track === 'short_swing';
      return true;
    });
  }, [logs, activeTrackTab]);

  // 提取已平仓做T闭环交易记录
  const closedTLogs = useMemo(() => {
    return filteredLogs.filter(lg => {
      const isPureBuy = lg.dir === '买入建仓' || lg.dir === '买入加仓' || lg.dir === '直接买入';
      return !isPureBuy && (lg.buy > 0 && lg.sell > 0);
    });
  }, [filteredLogs]);

  // 综合战报统计
  const stats = useMemo(() => {
    const today = todayStr();
    const todayLogs = closedTLogs.filter(lg => lg.date === today);
    const todayNet = todayLogs.reduce((acc, lg) => acc + (+lg.net || 0), 0);
    const totalNet = closedTLogs.reduce((acc, lg) => acc + (+lg.net || 0), 0);
    const winCount = closedTLogs.filter(lg => (+lg.net || 0) > 0).length;
    const lossCount = closedTLogs.length - winCount;
    const winRate = closedTLogs.length > 0 ? (winCount / closedTLogs.length) * 100 : 0;
    const plannedCount = filteredLogs.filter(lg => lg.plan === '计划内').length;
    const disciplineRate = filteredLogs.length > 0 ? (plannedCount / filteredLogs.length) * 100 : 100;
    
    // 人机对决数据统计
    let benchmarkCompareCount = 0;
    let benchmarkTotalNet = 0;
    let realMatchedNet = 0;
    closedTLogs.forEach(lg => {
      if (lg.systemBenchmark && lg.systemBenchmark.sysNet != null) {
        benchmarkCompareCount++;
        benchmarkTotalNet += lg.systemBenchmark.sysNet;
        realMatchedNet += (+lg.net || 0);
      }
    });
    const emotionFrictionCost = Math.round((benchmarkTotalNet - realMatchedNet) * 100) / 100;

    // 失误标签频次与损耗金额统计
    const mistakeMap = {};
    closedTLogs.forEach(lg => {
      const tags = lg.mistakeTags || [];
      tags.forEach(tId => {
        if (!mistakeMap[tId]) mistakeMap[tId] = { count: 0, lossSum: 0 };
        mistakeMap[tId].count += 1;
        if ((+lg.net || 0) < 0) {
          mistakeMap[tId].lossSum += Math.abs(+lg.net || 0);
        }
      });
    });

    const mistakeRank = Object.entries(mistakeMap).map(([id, info]) => {
      const def = MISTAKE_DICTIONARY.find(m => m.id === id) || { name: id, icon: '⚠️' };
      return { id, name: def.name, icon: def.icon, count: info.count, lossSum: info.lossSum };
    }).sort((a, b) => b.lossSum - a.lossSum || b.count - a.count);

    const bestTrade = closedTLogs.length > 0
      ? closedTLogs.reduce((best, cur) => ((+cur.net || 0) > (+best.net || -Infinity) ? cur : best), closedTLogs[0])
      : null;

    // 标的清单
    const stockSet = new Set();
    closedTLogs.forEach(lg => {
      if (lg.stock) stockSet.add(lg.stock);
    });

    return {
      todayNet,
      todayCount: todayLogs.length,
      totalNet,
      totalCount: closedTLogs.length,
      winCount,
      lossCount,
      winRate,
      disciplineRate,
      bestTrade,
      benchmarkCompareCount,
      benchmarkTotalNet: Math.round(benchmarkTotalNet * 100) / 100,
      realMatchedNet: Math.round(realMatchedNet * 100) / 100,
      emotionFrictionCost,
      mistakeRank,
      stockOptions: Array.from(stockSet)
    };
  }, [closedTLogs, filteredLogs]);

  // 构建图表数据
  const chartData = useMemo(() => {
    const sorted = [...closedTLogs].sort((a, b) => {
      const d = (a.date || '').localeCompare(b.date || '');
      return d !== 0 ? d : (a.id || 0) - (b.id || 0);
    });

    if (selectedChartStock === 'ALL') {
      if (sorted.length === 0) return { mode: 'ALL', points: [] };
      let cum = 0;
      const points = [{ idx: 0, label: '起点', date: sorted[0].date, val: 0, delta: 0, stock: '账户起步' }];
      sorted.forEach((lg, i) => {
        cum += (+lg.net || 0);
        points.push({
          idx: i + 1,
          label: `${lg.date.slice(5)} · ${lg.stock.split(' ')[0]}`,
          date: lg.date,
          val: Math.round(cum * 100) / 100,
          delta: +lg.net || 0,
          stock: lg.stock,
          dir: lg.dir
        });
      });
      return { mode: 'ALL', points, totalNet: cum };
    } else {
      const sLogs = sorted.filter(lg => lg.stock === selectedChartStock);
      if (sLogs.length === 0) return { mode: 'STOCK', points: [] };

      const matched = pool.find(p => selectedChartStock.includes(p.code) || selectedChartStock.includes(p.name));
      const baseShares = (matched && matched.shares > 0) ? matched.shares : Math.max(sLogs[0].qty || 500, 1000);
      const totalStockProfit = sLogs.reduce((acc, lg) => acc + (+lg.net || 0), 0);
      const curBrokerCost = (matched && matched.cost > 0) ? +matched.cost : sLogs[0].buy;
      const initialRefCost = Math.round((curBrokerCost + (totalStockProfit / baseShares)) * 100) / 100;

      let cum = 0;
      const points = [{
        idx: 0,
        label: '建仓原点',
        date: sLogs[0].date,
        val: initialRefCost,
        cumNet: 0,
        delta: 0
      }];

      sLogs.forEach((lg, i) => {
        cum += (+lg.net || 0);
        const dilutedCost = Math.round((initialRefCost - (cum / baseShares)) * 100) / 100;
        points.push({
          idx: i + 1,
          label: `${lg.date.slice(5)} (${lg.dir})`,
          date: lg.date,
          val: dilutedCost,
          cumNet: Math.round(cum * 100) / 100,
          delta: +lg.net || 0,
          dir: lg.dir
        });
      });

      const finalCost = points[points.length - 1].val;
      const costReduced = Math.round((initialRefCost - finalCost) * 100) / 100;
      const reducePct = initialRefCost > 0 ? (costReduced / initialRefCost) * 100 : 0;

      return {
        mode: 'STOCK',
        points,
        initialRefCost,
        finalCost,
        costReduced,
        reducePct,
        baseShares,
        totalStockProfit
      };
    }
  }, [closedTLogs, selectedChartStock, pool]);

  // 渲染 SVG 折线图
  const renderCurveSvg = () => {
    const pts = chartData.points || [];
    if (pts.length < 2) {
      return (
        <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--mute)', fontSize: '12px', background: 'var(--surface2)', borderRadius: '8px', border: '1px dashed var(--line)' }}>
          暂无足够的闭环流水数据用于绘制曲线。点击上方「＋ 新增交易记录」录入至少 1 笔平仓记录，系统将自动生成成本摊薄与资金曲线！
        </div>
      );
    }

    const W = 760, H = 190, PL = 58, PR = 26, PT = 22, PB = 28;
    const innerW = W - PL - PR;
    const innerH = H - PT - PB;
    const vals = pts.map(p => p.val);
    const minV = Math.min(...vals);
    const maxV = Math.max(...vals);
    const span = maxV === minV ? 1 : maxV - minV;

    const xCoord = idx => PL + (idx / (pts.length - 1)) * innerW;
    const yCoord = val => PT + innerH - ((val - minV) / span) * innerH;

    const pathD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xCoord(i).toFixed(1)} ${yCoord(p.val).toFixed(1)}`).join(' ');
    const isCostMode = chartData.mode === 'STOCK';
    const strokeColor = isCostMode ? '#0a7f42' : '#cf1322';

    return (
      <div style={{ position: 'relative', width: '100%', overflowX: 'auto' }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
          <line x1={PL} y1={PT} x2={W - PR} y2={PT} stroke="var(--line)" strokeDasharray="3 3" />
          <line x1={PL} y1={PT + innerH / 2} x2={W - PR} y2={PT + innerH / 2} stroke="var(--line)" strokeDasharray="3 3" />
          <line x1={PL} y1={PT + innerH} x2={W - PR} y2={PT + innerH} stroke="var(--line)" />
          <line x1={PL} y1={PT} x2={PL} y2={PT + innerH} stroke="var(--line)" />

          <text x={PL - 8} y={PT + 4} textAnchor="end" fontSize="10" fill="var(--mute)">{f2(maxV)}</text>
          <text x={PL - 8} y={PT + innerH / 2 + 3} textAnchor="end" fontSize="10" fill="var(--mute)">{f2((maxV + minV) / 2)}</text>
          <text x={PL - 8} y={PT + innerH} textAnchor="end" fontSize="10" fill="var(--mute)">{f2(minV)}</text>

          <path d={pathD} fill="none" stroke={strokeColor} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

          {pts.map((p, i) => (
            <g key={i} onMouseEnter={() => setHoverIdx(i)} onMouseLeave={() => setHoverIdx(null)} style={{ cursor: 'pointer' }}>
              <circle
                cx={xCoord(i)}
                cy={yCoord(p.val)}
                r={hoverIdx === i ? 5.5 : 3.5}
                fill={hoverIdx === i ? '#fff' : strokeColor}
                stroke={strokeColor}
                strokeWidth={hoverIdx === i ? 2.5 : 1.5}
              />
            </g>
          ))}
        </svg>

        {hoverIdx !== null && pts[hoverIdx] && (
          <div style={{
            position: 'absolute',
            top: '8px',
            right: '12px',
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            borderRadius: '6px',
            padding: '6px 10px',
            fontSize: '11.5px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
            pointerEvents: 'none',
            zIndex: 10
          }}>
            <div style={{ fontWeight: 700 }}>{pts[hoverIdx].label}</div>
            <div>{isCostMode ? '摊薄成本: ' : '累计套利: '}<b>{f2(pts[hoverIdx].val)}</b></div>
            {pts[hoverIdx].delta !== 0 && (
              <div style={{ color: pts[hoverIdx].delta > 0 ? 'var(--up)' : 'var(--down)' }}>
                单笔影响: {pts[hoverIdx].delta > 0 ? '+' : ''}{money(pts[hoverIdx].delta)}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="ledger-wrap" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <section className="card" style={{ padding: '16px' }}>
        {/* 顶部标题栏 + 轨制切换 Tab + 功能操作区 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px', marginBottom: '14px', borderBottom: '1px solid var(--line)', paddingBottom: '12px' }}>
          <div>
            <h2 style={{ fontSize: '18px', fontWeight: 800, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>📒</span> 实盘交易台账与复盘系统
              <span className="tag" style={{ fontSize: '11px', background: 'var(--surface2)', color: 'var(--sub)' }}>双轨分仓 · 闭环反思</span>
            </h2>
            <div style={{ fontSize: '12px', color: 'var(--sub)', marginTop: '3px' }}>
              物理隔离【长线底仓降本做T】与【短线攻防冲板】，量化主观情绪摩擦成本，由天翼云大模型直击操作心魔。
            </div>
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="primary"
              onClick={() => setShowCoachModal(true)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', background: 'linear-gradient(135deg, #1d4ed8 0%, #7c3aed 100%)', border: 'none', color: '#fff', fontWeight: 700 }}
            >
              <span>🤖</span> 一键呼叫 AI 交易教练
            </button>
            <button
              type="button"
              onClick={() => setShowSettingsModal(true)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              title="配置天翼云 OpenAI 兼容大模型秘钥与参数"
            >
              <span>⚙️</span> AI 配置
            </button>
            <button type="button" onClick={() => setShowAddModal(true)} style={{ fontWeight: 600 }}>
              ＋ 记一笔
            </button>
            <button type="button" onClick={onExport}>⬇ 导出</button>
            <button type="button" onClick={onImportClick}>⬆ 导入</button>
          </div>
        </div>

        {/* 🔀 双轨分仓导航切换栏 */}
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '14px' }}>
          {[
            { id: 'ALL', label: `📊 全部流水 (${logs.length}笔)` },
            { id: 'long_t', label: '🛡️ 长线做T轨（底仓降本专区）' },
            { id: 'short_swing', label: '⚡ 短线攻防轨（尾盘·连板专区）' },
            { id: 'BENCHMARK', label: `⚖️ 人机对决战报 (${stats.benchmarkCompareCount}笔对照)` },
          ].map(tab => (
            <button
              key={tab.id}
              type="button"
              className={activeTrackTab === tab.id ? 'primary' : ''}
              onClick={() => setActiveTrackTab(tab.id)}
              style={{
                fontSize: '12px',
                padding: '4px 12px',
                borderRadius: '6px',
                border: activeTrackTab === tab.id ? '1px solid var(--accent)' : '1px solid var(--line)',
                fontWeight: activeTrackTab === tab.id ? 700 : 500
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* 🏆 4 维核心绩效战报 KPI 卡片 */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px', marginBottom: '16px' }}>
          <div className="card" style={{ padding: '12px 14px', background: 'var(--surface2)', borderLeft: `4px solid ${stats.todayNet >= 0 ? '#cf1322' : '#0a7f42'}` }}>
            <div style={{ fontSize: '11.5px', color: 'var(--mute)' }}>☀️ 今日净落袋 ({stats.todayCount}笔已平仓)</div>
            <div className={stats.todayNet >= 0 ? 'up' : 'down'} style={{ fontSize: '20px', fontWeight: 800, fontFamily: 'monospace', marginTop: '4px' }}>
              {stats.todayNet >= 0 ? '+' : ''}{money(stats.todayNet)}
            </div>
          </div>

          <div className="card" style={{ padding: '12px 14px', background: 'var(--surface2)', borderLeft: `4px solid ${stats.totalNet >= 0 ? '#cf1322' : '#0a7f42'}` }}>
            <div style={{ fontSize: '11.5px', color: 'var(--mute)' }}>
              {activeTrackTab === 'long_t' ? '💰 累计做T降本套利额' : activeTrackTab === 'short_swing' ? '⚡ 短线累计闭环净利' : '💰 历史累计净落袋'}
            </div>
            <div className={stats.totalNet >= 0 ? 'up' : 'down'} style={{ fontSize: '20px', fontWeight: 800, fontFamily: 'monospace', marginTop: '4px' }}>
              {stats.totalNet >= 0 ? '+' : ''}{money(stats.totalNet)}
            </div>
          </div>

          <div className="card" style={{ padding: '12px 14px', background: 'var(--surface2)', borderLeft: '4px solid #0958d9' }}>
            <div style={{ fontSize: '11.5px', color: 'var(--mute)' }}>🎯 综合平仓胜率</div>
            <div style={{ fontSize: '20px', fontWeight: 800, fontFamily: 'monospace', marginTop: '4px', color: '#0958d9' }}>
              {stats.winRate.toFixed(1)}%
              <span style={{ fontSize: '11.5px', fontWeight: 500, color: 'var(--sub)', marginLeft: '6px' }}>
                ({stats.winCount}胜 / {stats.lossCount}负)
              </span>
            </div>
          </div>

          <div className="card" style={{ padding: '12px 14px', background: 'var(--surface2)', borderLeft: '4px solid #7c3aed' }}>
            <div style={{ fontSize: '11.5px', color: 'var(--mute)' }}>🛡️ 计划内纪律执行率</div>
            <div style={{ fontSize: '20px', fontWeight: 800, fontFamily: 'monospace', marginTop: '4px', color: '#7c3aed' }}>
              {stats.disciplineRate.toFixed(0)}%
              {stats.bestTrade && (
                <span style={{ fontSize: '11px', fontWeight: 500, color: 'var(--sub)', marginLeft: '6px' }}>
                  最佳 +{money(stats.bestTrade.net)}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* ⚖️ 人机对决收益对照专区（当处于 BENCHMARK tab 时突出展示） */}
        {activeTrackTab === 'BENCHMARK' && (
          <div style={{ background: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: '10px', padding: '14px', marginBottom: '16px' }}>
            <div style={{ fontSize: '14px', fontWeight: 800, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span>⚖️</span> 【人机对决战报】：交易员实操净利 vs 系统理论 SOP 基准预期
            </div>
            <div style={{ fontSize: '12px', color: 'var(--sub)', marginBottom: '12px' }}>
              自动对比您实际买卖点位与系统给出的建议区间（回踩挂单位、T1/T2 冲高目标位、1.5% 止损线），量化由于主观情绪犯错（追高、抢跑、死扛）吞噬的真金白银。
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px', marginBottom: '14px' }}>
              <div style={{ padding: '10px 12px', background: '#fff', borderRadius: '6px', border: '1px solid var(--line)' }}>
                <div style={{ fontSize: '11.5px', color: 'var(--mute)' }}>🤖 系统理论标杆预期收益</div>
                <div style={{ fontSize: '18px', fontWeight: 800, fontFamily: 'monospace', marginTop: '4px', color: stats.benchmarkTotalNet >= 0 ? 'var(--up)' : 'var(--down)' }}>
                  {stats.benchmarkTotalNet >= 0 ? '+' : ''}{money(stats.benchmarkTotalNet)}
                </div>
              </div>
              <div style={{ padding: '10px 12px', background: '#fff', borderRadius: '6px', border: '1px solid var(--line)' }}>
                <div style={{ fontSize: '11.5px', color: 'var(--mute)' }}>👤 交易员实盘实际落袋</div>
                <div style={{ fontSize: '18px', fontWeight: 800, fontFamily: 'monospace', marginTop: '4px', color: stats.realMatchedNet >= 0 ? 'var(--up)' : 'var(--down)' }}>
                  {stats.realMatchedNet >= 0 ? '+' : ''}{money(stats.realMatchedNet)}
                </div>
              </div>
              <div style={{ padding: '10px 12px', background: stats.emotionFrictionCost > 0 ? '#fff1f0' : '#f0fdf4', borderRadius: '6px', border: `1px solid ${stats.emotionFrictionCost > 0 ? '#ffa39e' : '#86efac'}` }}>
                <div style={{ fontSize: '11.5px', color: stats.emotionFrictionCost > 0 ? '#cf1322' : '#15803d', fontWeight: 700 }}>
                  {stats.emotionFrictionCost > 0 ? '🚨 主观情绪摩擦成本 (少赚/多亏)' : '🌟 超额 Alpha 认知收益'}
                </div>
                <div style={{ fontSize: '18px', fontWeight: 800, fontFamily: 'monospace', marginTop: '4px', color: stats.emotionFrictionCost > 0 ? '#cf1322' : '#15803d' }}>
                  {stats.emotionFrictionCost > 0 ? '-' : '+'}{money(Math.abs(stats.emotionFrictionCost))}
                </div>
              </div>
            </div>

            {/* 失误归因排行 */}
            <div style={{ background: '#fff', borderRadius: '6px', padding: '10px 12px', border: '1px solid var(--line)' }}>
              <div style={{ fontSize: '12.5px', fontWeight: 700, marginBottom: '8px' }}>🏷️ 高频失误类型损耗排行：</div>
              {stats.mistakeRank.length ? (
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {stats.mistakeRank.map(m => (
                    <div key={m.id} style={{ fontSize: '11.5px', padding: '4px 10px', background: 'var(--surface2)', borderRadius: '6px', border: '1px solid var(--line)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                      <span>{m.icon}</span>
                      <b>{m.name}</b>: <span>{m.count}次</span>
                      {m.lossSum > 0 && <span style={{ color: 'var(--up)', fontWeight: 700 }}>(亏损 ¥{money(m.lossSum)})</span>}
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: '12px', color: 'var(--mute)' }}>暂无失误打标记录，录入新交易时勾选失误标签即可量化心魔！</div>
              )}
            </div>
          </div>
        )}

        {/* 📈 成本摊薄曲线看板 */}
        {activeTrackTab !== 'BENCHMARK' && (
          <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '10px', padding: '14px', marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
              <div style={{ fontSize: '13.5px', fontWeight: 800, color: 'var(--text)' }}>
                {selectedChartStock === 'ALL'
                  ? '📈 账户累计净套利资金曲线'
                  : `📉 【${selectedChartStock}】底仓每股成本动态下降轨迹`}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '12px', color: 'var(--mute)' }}>切换标的维度：</span>
                <select
                  value={selectedChartStock}
                  onChange={e => { setSelectedChartStock(e.target.value); setHoverIdx(null); }}
                  style={{ padding: '4px 10px', fontSize: '12px', borderRadius: '6px', border: '1px solid var(--line)', background: 'var(--surface2)', color: 'var(--text)', fontWeight: 600 }}
                >
                  <option value="ALL">📊 全部标的 · 累计资金曲线</option>
                  {stats.stockOptions.map(st => (
                    <option key={st} value={st}>🎯 {st} · 成本摊薄轨迹</option>
                  ))}
                </select>
              </div>
            </div>
            {renderCurveSvg()}
          </div>
        )}

        {/* 流水明细表格 */}
        <div className="tbl-scroll" style={{ maxHeight: '380px' }}>
          <table>
            <thead>
              <tr>
                <th>日期</th>
                <th>轨制</th>
                <th>标的名称</th>
                <th>方向</th>
                <th>买入价</th>
                <th>卖出价</th>
                <th>股数</th>
                <th>净落袋</th>
                <th>失误归因标签</th>
                <th>人机对比 (SOP)</th>
                <th>反思心得</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.length > 0 ? (
                filteredLogs.map(lg => {
                  const tagList = (lg.mistakeTags || []).map(id => {
                    const item = MISTAKE_DICTIONARY.find(m => m.id === id);
                    return item ? `${item.icon} ${item.name}` : id;
                  });

                  return (
                    <tr key={lg.id}>
                      <td style={{ fontSize: '11.5px', color: 'var(--mute)' }}>{lg.date}</td>
                      <td>
                        <span style={{
                          fontSize: '10.5px',
                          padding: '1px 6px',
                          borderRadius: '4px',
                          background: lg.track === 'short_swing' ? '#faf5ff' : '#f0f9ff',
                          color: lg.track === 'short_swing' ? '#7c3aed' : '#0369a1',
                          border: `1px solid ${lg.track === 'short_swing' ? '#d8b4fe' : '#bae6fd'}`,
                          fontWeight: 600
                        }}>
                          {lg.track === 'short_swing' ? '⚡ 短线攻防' : '🛡️ 长线做T'}
                        </span>
                      </td>
                      <td style={{ fontWeight: 700 }}>{lg.stock}</td>
                      <td>
                        <span className={`pill ${
                          lg.dir.includes('买') || lg.dir.includes('正T') || lg.dir.includes('潜伏') ? 'p-buy' : 'p-sell'
                        }`}>
                          {lg.dir}
                        </span>
                      </td>
                      <td className="num">{lg.buy > 0 ? f2(lg.buy) : '—'}</td>
                      <td className="num">{lg.sell > 0 ? f2(lg.sell) : '—'}</td>
                      <td className="num">{lg.qty}</td>
                      <td className="num">
                        {lg.dir.includes('建仓') || lg.dir.includes('加仓') ? (
                          <span style={{ color: '#1677ff', fontSize: '11px', fontWeight: 600 }}>持仓增厚</span>
                        ) : (
                          <b className={lg.net >= 0 ? 'up' : 'down'}>{lg.net >= 0 ? '+' : ''}{money(lg.net)}</b>
                        )}
                      </td>
                      <td>
                        {tagList.length ? (
                          <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap' }}>
                            {tagList.map((t, idx) => (
                              <span key={idx} style={{ fontSize: '10.5px', padding: '1px 5px', borderRadius: '3px', background: '#fff1f0', color: '#cf1322', border: '1px solid #ffa39e' }}>
                                {t}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span style={{ color: 'var(--mute)', fontSize: '11px' }}>—</span>
                        )}
                      </td>
                      <td>
                        {lg.systemBenchmark ? (
                          <div style={{ fontSize: '11px', lineHeight: 1.3 }}>
                            <div>建议买: {f2(lg.systemBenchmark.sysBuy)} ｜ 目标: {f2(lg.systemBenchmark.sysSell1)}</div>
                            {lg.alphaNet != null && (
                              <div style={{ color: lg.alphaNet >= 0 ? 'var(--ok)' : 'var(--up)', fontWeight: 600 }}>
                                情绪偏差: {lg.alphaNet >= 0 ? '+' : ''}{money(lg.alphaNet)}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span style={{ color: 'var(--mute)', fontSize: '11px' }}>无基准</span>
                        )}
                      </td>
                      <td style={{ fontSize: '11.5px', color: 'var(--sub)', maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={lg.reflection || lg.note}>
                        {lg.reflection || lg.note || '—'}
                      </td>
                      <td>
                        <button className="mini" onClick={() => onDeleteLog(lg.id)} style={{ color: 'var(--up)' }}>删除</button>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan="12" style={{ textAlign: 'center', padding: '24px', color: 'var(--mute)' }}>
                    暂无符合条件的交易流水记录。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* 🤖 AI 复盘教练诊断弹窗 (天翼云大模型驱动) */}
      {showCoachModal && (
        <div className="modal-mask" onClick={() => setShowCoachModal(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: '780px', width: '92%' }}>
            <div className="modal-hd" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '20px' }}>🤖</span>
                <h3 style={{ margin: 0 }}>智策战情室 · AI 交易复盘教练</h3>
                <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px', background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>
                  天翼云 ({aiConfig.model})
                </span>
              </div>
              <button className="modal-close" onClick={() => setShowCoachModal(false)}>×</button>
            </div>

            <div className="modal-bd" style={{ maxHeight: '70vh', overflowY: 'auto', padding: '16px' }}>
              {/* 复盘参数栏 */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '10px', background: 'var(--surface2)', padding: '10px', borderRadius: '8px', marginBottom: '14px' }}>
                <div>
                  <label style={{ fontSize: '11.5px', color: 'var(--mute)', display: 'block', marginBottom: '4px' }}>复盘日期</label>
                  <input
                    type="date"
                    value={coachDate}
                    onChange={e => setCoachDate(e.target.value)}
                    style={{ width: '100%', padding: '4px 8px', borderRadius: '4px', border: '1px solid var(--line)' }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '11.5px', color: 'var(--mute)', display: 'block', marginBottom: '4px' }}>交易员整体反思（可选补充）</label>
                  <input
                    value={coachNotes}
                    onChange={e => setCoachNotes(e.target.value)}
                    placeholder="如：今天大盘跳水时心态有点慌，没有严格执行止损线..."
                    style={{ width: '100%', padding: '4px 8px', borderRadius: '4px', border: '1px solid var(--line)' }}
                  />
                </div>
              </div>

              {/* 当日待诊断流水预览 */}
              <div style={{ marginBottom: '14px' }}>
                <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '6px' }}>
                  📋 诊断标的范围：{coachDate} 共 {(logs || []).filter(l => l.date === coachDate).length} 笔流水
                </div>
                {!(logs || []).filter(l => l.date === coachDate).length ? (
                  <div style={{ fontSize: '12px', color: 'var(--warn)', padding: '8px', background: '#fffbe6', borderRadius: '4px' }}>
                    ⚠️ {coachDate} 暂无任何成交流水记录，请先在台账录入今日的买卖记录！
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {(logs || []).filter(l => l.date === coachDate).map(t => (
                      <span key={t.id} style={{ fontSize: '11.5px', padding: '3px 8px', borderRadius: '4px', background: 'var(--surface)', border: '1px solid var(--line)' }}>
                        <b>{t.stock}</b> ({t.dir}): {t.net >= 0 ? '+' : ''}{f2(t.net)}元
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* 生成诊断按钮 */}
              <div style={{ textAlign: 'center', margin: '14px 0' }}>
                <button
                  type="button"
                  className="primary"
                  onClick={handleRunCoach}
                  disabled={coachLoading || !(logs || []).filter(l => l.date === coachDate).length}
                  style={{
                    padding: '8px 24px',
                    fontSize: '13.5px',
                    fontWeight: 700,
                    borderRadius: '7px',
                    background: 'linear-gradient(135deg, #1d4ed8 0%, #7c3aed 100%)',
                    border: 'none',
                    color: '#fff',
                    cursor: coachLoading ? 'not-allowed' : 'pointer'
                  }}
                >
                  {coachLoading ? '⏳ 天翼云大模型正在深度切片复盘中…（约 10~20 秒）' : '🚀 启动 AI 交易教练深度复盘诊断'}
                </button>
              </div>

              {/* AI 诊断结果展示区 */}
              {coachReviewResult && (
                <div style={{ marginTop: '16px', background: '#fdfdfe', border: '1px solid #bfdbfe', borderRadius: '8px', padding: '16px', lineHeight: 1.6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px dashed #cbd5e1', paddingBottom: '8px', marginBottom: '12px' }}>
                    <div style={{ fontWeight: 800, fontSize: '14px', color: '#1e3a8a' }}>
                      📋 【AI 交易教练操盘诊断报告】· {coachReviewResult.date}
                    </div>
                    <button
                      type="button"
                      onClick={() => { copyPlain(coachReviewResult.review); toastOk('诊断书已复制到剪贴板！'); }}
                      style={{ padding: '3px 8px', fontSize: '11px' }}
                    >
                      📋 复制诊断书
                    </button>
                  </div>
                  <div style={{ fontSize: '12.5px', whiteSpace: 'pre-wrap', color: 'var(--text)' }}>
                    {coachReviewResult.review}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ⚙️ 天翼云大模型配置 Modal */}
      {showSettingsModal && (
        <div className="modal-mask" onClick={() => setShowSettingsModal(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: '520px' }}>
            <div className="modal-hd">
              <h3>⚙️ AI 交易复盘教练大模型配置</h3>
              <button className="modal-close" onClick={() => setShowSettingsModal(false)}>×</button>
            </div>
            <div className="modal-bd" style={{ display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '12.5px' }}>
              <div style={{ background: '#f0f9ff', padding: '10px 12px', borderRadius: '6px', border: '1px solid #bae6fd', color: '#0369a1', lineHeight: 1.5 }}>
                💡 <b>配置提示</b>：本系统已接入天翼云 OpenAI 兼容大模型接口。您可在此填入天翼云 API 秘钥，亦可在项目根目录 <code>.env</code> 文件中持久化配置。
              </div>

              <div>
                <label style={{ fontWeight: 600, display: 'block', marginBottom: '4px' }}>天翼云接口地址 (API URL)</label>
                <input
                  value={aiConfig.apiUrl}
                  onChange={e => setAiConfig(prev => ({ ...prev, apiUrl: e.target.value }))}
                  placeholder="https://ai.ctaigw.cn/v1/chat/completions"
                  style={{ width: '100%', padding: '6px 10px', borderRadius: '5px', border: '1px solid var(--line)' }}
                />
              </div>

              <div>
                <label style={{ fontWeight: 600, display: 'block', marginBottom: '4px' }}>天翼云 API 密钥 (API Key)</label>
                <input
                  type="password"
                  value={aiConfig.apiKey}
                  onChange={e => setAiConfig(prev => ({ ...prev, apiKey: e.target.value }))}
                  placeholder={aiConfig.configuredInEnv ? `已由 .env 环境变量注入 (${aiConfig.maskedEnvKey})` : '输入天翼云 API Key'}
                  style={{ width: '100%', padding: '6px 10px', borderRadius: '5px', border: '1px solid var(--line)' }}
                />
              </div>

              <div>
                <label style={{ fontWeight: 600, display: 'block', marginBottom: '4px' }}>天翼云模型标识 (Model)</label>
                <input
                  value={aiConfig.model}
                  onChange={e => setAiConfig(prev => ({ ...prev, model: e.target.value }))}
                  placeholder="deepseek-chat 或 qwen-plus"
                  style={{ width: '100%', padding: '6px 10px', borderRadius: '5px', border: '1px solid var(--line)' }}
                />
              </div>

              {testResult && (
                <div style={{
                  padding: '8px 10px',
                  borderRadius: '5px',
                  fontSize: '12px',
                  background: testResult.ok ? '#f0fdf4' : '#fff1f0',
                  color: testResult.ok ? '#15803d' : '#cf1322',
                  border: `1px solid ${testResult.ok ? '#86efac' : '#ffa39e'}`
                }}>
                  {testResult.text}
                </div>
              )}
            </div>

            <div className="modal-ft" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderTop: '1px solid var(--line)' }}>
              <button
                type="button"
                onClick={handleTestAi}
                disabled={testingAi}
                style={{ fontSize: '12px', padding: '4px 12px' }}
              >
                {testingAi ? '⏳ 正在测试连接…' : '⚡ 一键测试连通性'}
              </button>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button type="button" className="btn-cancel" onClick={() => setShowSettingsModal(false)}>取消</button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    handleSaveAiConfig(aiConfig);
                    setShowSettingsModal(false);
                  }}
                >
                  保存配置
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ＋ 新增台账 Modal（支持双轨分流 + 失误归因 + 系统点位匹配） */}
      {showAddModal && (
        <div className="modal-mask" onClick={() => setShowAddModal(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: '580px', width: '92%' }}>
            <div className="modal-hd">
              <h3 style={{ margin: 0 }}>＋ 手工新增交易台账记录</h3>
              <button className="modal-close" onClick={() => setShowAddModal(false)}>×</button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-bd" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', fontSize: '12.5px', maxHeight: '72vh', overflowY: 'auto' }}>
                {/* 轨制选择 */}
                <div className="fld" style={{ gridColumn: '1 / -1' }}>
                  <label style={{ fontWeight: 700 }}>交易轨制定位</label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '4px' }}>
                    <button
                      type="button"
                      onClick={() => handleFormChange('track', 'long_t')}
                      style={{
                        padding: '7px 10px',
                        borderRadius: '6px',
                        border: form.track === 'long_t' ? '2px solid #0369a1' : '1px solid var(--line)',
                        background: form.track === 'long_t' ? '#f0f9ff' : 'var(--surface)',
                        color: form.track === 'long_t' ? '#0369a1' : 'var(--text)',
                        fontWeight: form.track === 'long_t' ? 700 : 500,
                        cursor: 'pointer'
                      }}
                    >
                      🛡️ 长线做T轨（底仓降本）
                    </button>
                    <button
                      type="button"
                      onClick={() => handleFormChange('track', 'short_swing')}
                      style={{
                        padding: '7px 10px',
                        borderRadius: '6px',
                        border: form.track === 'short_swing' ? '2px solid #7c3aed' : '1px solid var(--line)',
                        background: form.track === 'short_swing' ? '#faf5ff' : 'var(--surface)',
                        color: form.track === 'short_swing' ? '#7c3aed' : 'var(--text)',
                        fontWeight: form.track === 'short_swing' ? 700 : 500,
                        cursor: 'pointer'
                      }}
                    >
                      ⚡ 短线攻防轨（尾盘·连板）
                    </button>
                  </div>
                </div>

                <div className="fld">
                  <label>交易日期</label>
                  <input type="date" value={form.date} onChange={e => handleFormChange('date', e.target.value)} required />
                </div>
                <div className="fld">
                  <label>交易标的</label>
                  <input value={form.stock} onChange={e => handleFormChange('stock', e.target.value)} placeholder="如：华锡有色 (600301)" required />
                </div>

                {/* 系统标准SOP匹配提示 */}
                {matchedSysBenchmark && (
                  <div style={{ gridColumn: '1 / -1', padding: '6px 10px', borderRadius: '5px', background: '#f0fdf4', border: '1px solid #86efac', color: '#15803d', fontSize: '11.5px', lineHeight: 1.4 }}>
                    🎯 <b>已自动匹配系统【{matchedSysBenchmark.source}】策略基准</b>：
                    建议买入参考价 <b>¥{f2(matchedSysBenchmark.sysBuy)}</b> ｜ T1止盈位 <b>¥{f2(matchedSysBenchmark.sysSell1)}</b> ｜ 纪律止损线 <b>¥{f2(matchedSysBenchmark.sysStop)}</b>
                  </div>
                )}

                <div className="fld">
                  <label>操作方向</label>
                  <select value={form.dir} onChange={e => handleFormChange('dir', e.target.value)}>
                    {form.track === 'long_t' ? (
                      <>
                        <option value="正T">正T（先低吸后高抛）</option>
                        <option value="倒T">倒T（先高抛后低吸）</option>
                        <option value="底仓建仓">底仓建仓（新增底仓）</option>
                        <option value="底仓减持">底仓减持（长线分批卖出）</option>
                      </>
                    ) : (
                      <>
                        <option value="尾盘买入">尾盘黑马潜伏 (14:30)</option>
                        <option value="连板追涨">连板起爆打板</option>
                        <option value="龙头抄底">超跌龙头反弹低吸</option>
                        <option value="冲高止盈">短线冲高兑现落袋</option>
                        <option value="破位止损">纪律止损平仓</option>
                      </>
                    )}
                  </select>
                </div>
                <div className="fld">
                  <label>决策依据</label>
                  <select value={form.basis} onChange={e => handleFormChange('basis', e.target.value)}>
                    <option value="系统SOP">系统SOP推荐 (尾盘/打板/起爆)</option>
                    <option value="客观信号">客观技术信号 (量价/分时均线)</option>
                    <option value="情绪模因/字辈共振">🎭 情绪模因/字辈共振 (东方系/日阳/生肖等)</option>
                    <option value="主观判断">主观盘感 / 消息驱动</option>
                  </select>
                </div>
                <div className="fld">
                  <label>成交股数</label>
                  <input type="number" step="100" value={form.qty} onChange={e => handleFormChange('qty', e.target.value)} required />
                </div>
                <div className="fld">
                  <label>买入价 (元)</label>
                  <input type="number" step="0.01" value={form.buy} onChange={e => handleFormChange('buy', e.target.value)} required />
                </div>
                <div className="fld">
                  <label>卖出价 (元)</label>
                  <input type="number" step="0.01" value={form.sell} onChange={e => handleFormChange('sell', e.target.value)} required />
                </div>

                {/* 结构化失误标签归因 */}
                <div className="fld" style={{ gridColumn: '1 / -1' }}>
                  <label style={{ fontWeight: 600 }}>失误归因标签（可多选）</label>
                  <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap', marginTop: '4px' }}>
                    {MISTAKE_DICTIONARY.map(m => {
                      const selected = form.mistakeTags.includes(m.id);
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => toggleMistakeTag(m.id)}
                          style={{
                            padding: '3px 8px',
                            fontSize: '11px',
                            borderRadius: '4px',
                            border: selected ? '1px solid #cf1322' : '1px solid var(--line)',
                            background: selected ? '#fff1f0' : 'var(--surface)',
                            color: selected ? '#cf1322' : 'var(--sub)',
                            fontWeight: selected ? 700 : 400,
                            cursor: 'pointer'
                          }}
                          title={m.desc}
                        >
                          {m.icon} {m.name}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="fld" style={{ gridColumn: '1 / -1' }}>
                  <label>反思心得与教训记录</label>
                  <textarea
                    rows={2}
                    value={form.reflection}
                    onChange={e => handleFormChange('reflection', e.target.value)}
                    placeholder="如：没有按计划等待回踩均价线，看到分时快速拉升心急追高，下次必须管住手..."
                    style={{ width: '100%', padding: '6px 8px', borderRadius: '4px', border: '1px solid var(--line)', fontSize: '12px' }}
                  />
                </div>
              </div>
              <div className="modal-ft" style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '10px 14px', borderTop: '1px solid var(--line)' }}>
                <button type="button" className="btn-cancel" onClick={() => setShowAddModal(false)}>取消</button>
                <button type="submit" className="primary">确认入账</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
