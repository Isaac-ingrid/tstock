import React, { useState, useMemo, useEffect, useRef } from 'react';
import { f2, money, todayStr, toastOk, toastErr, copyPlain } from '../services/utils.js';
import { fetchCoachConfig, testCoachConnection, fetchCoachReview, MKT } from '../services/api.js';
import { resolveSystemBenchmark, auditTradeExecution, computeDisciplineScorecard } from '../services/ledger.js';

/* 结构化交易失误归因基因字典 */
export const MISTAKE_DICTIONARY = [
  { id: 'fomo_chase', category: '买入心理', name: '追高天花板', icon: '🚀', desc: '未等缩量回踩，看到分时拉升冲动追买在全天高位或越过倒T高抛线' },
  { id: 'no_stoploss', category: '纪律执行', name: '破位死扛不认输', icon: '🛡️', desc: '触及纪律止损位心存侥幸不斩仓，亏损扩大后才被迫割肉' },
  { id: 't_to_add', category: '定位混乱', name: '做T做反变加仓', icon: '🔄', desc: '正T买入后未冲高，尾盘舍不得平仓导致日内T仓变成隔夜加仓' },
  { id: 'early_exit', category: '持股耐心', name: '过早卖飞大肉', icon: '🕊️', desc: '分时均线平稳未破，远低于第一止盈位就恐慌抛光，错失日内主波段' },
  { id: 'against_trend', category: '大局观', name: '逆市顶风作案', icon: '🚨', desc: '大盘环境亮红灯 BAD（双破 MA20/60）或个股触发破位锁时强行做多' },
  { id: 'heavy_gamble', category: '仓位控制', name: '短线重仓单赌', icon: '💣', desc: '单笔短线仓位过重，导致盘中心态严重变形' },
  { id: 'impulse_t', category: '节奏失序', name: '无量冲动乱T', icon: '⚡', desc: '日内振幅不足 2.6 格、无量织布时强行开仓磨损手续费' },
  { id: 'revenge_trade', category: '心态失衡', name: '报复性交易', icon: '💢', desc: '当日连续亏损后急于翻本，盲目逆向高频开新仓' },
  { id: 'lone_wolf', category: '共振失误', name: '孤狼单打一日游', icon: '🐺', desc: '板块或同字辈宗族无跟风，单兵脉冲自拉自唱，次日熄火被套' },
  { id: 'late_chase', category: '节奏失序', name: '滞后接盘高潮棒', icon: '⏰', desc: '全网明牌高潮狂欢时才后知后觉追高，接在主力分歧出货末端' },
];

const LOCAL_AI_KEY = 'tstock_ai_coach_config';

export default function LedgerSection({
  logs = [],
  wbLatest = null,
  onAddLog,
  onUpdateLog,
  onDeleteLog,
  pool = [],
  totalAssets = 100000,
  vaultStatus = null,
  onForceSyncVault,
  onRestoreVault,
  onOpenEodModal,
  todayArchived = false,
  onExport,
  onImportClick
}) {
  // 核心导航轨制：'ALL' | 'long_t' | 'short_swing' | 'BENCHMARK'
  const [activeTrackTab, setActiveTrackTab] = useState('ALL');
  // 流水展示模式：'auto'（桌面宽表 + 手机窄屏自动卡片）| 'card' | 'table'
  const [logViewMode, setLogViewMode] = useState('auto');
  // 移动端单手防误删二次确认 ID（3秒自动复位）
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const deleteTimerRef = useRef(null);

  const [showAddModal, setShowAddModal] = useState(false);
  const [showCoachModal, setShowCoachModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [editingLog, setEditingLog] = useState(null);
  const [selectedChartStock, setSelectedChartStock] = useState('ALL');
  const [hoverIdx, setHoverIdx] = useState(null);
  const svgRef = useRef(null);

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
  const [coachDate, setCoachDate] = useState(() => {
    const today = todayStr();
    if ((logs || []).some(l => l.date === today)) return today;
    return (logs && logs[0]?.date) || today;
  });
  const [coachNotes, setCoachNotes] = useState('');
  const [coachLoading, setCoachLoading] = useState(false);
  const [coachReviewResult, setCoachReviewResult] = useState(null);

  // 手工记账表单状态
  const [form, setForm] = useState({
    date: todayStr(),
    track: 'long_t',
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

  useEffect(() => () => {
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
  }, []);

  const requestDeleteLog = (id) => {
    if (confirmDeleteId === id) {
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
      setConfirmDeleteId(null);
      onDeleteLog(id);
      return;
    }
    setConfirmDeleteId(id);
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
    deleteTimerRef.current = setTimeout(() => {
      setConfirmDeleteId(prev => (prev === id ? null : prev));
    }, 3200);
  };

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

  const hasAiKey = Boolean((aiConfig.apiKey && aiConfig.apiKey.trim()) || aiConfig.configuredInEnv);

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

  // 全量流水自动回溯补齐人机基准、偏离度与四维纪律评分
  const fullScorecard = useMemo(
    () => computeDisciplineScorecard(logs, pool, wbLatest),
    [logs, pool, wbLatest]
  );

  const enrichedAllLogs = fullScorecard.enrichedLogs;

  // 按轨制筛选流水
  const filteredLogs = useMemo(() => {
    return enrichedAllLogs.filter(lg => {
      const track = lg.track || 'long_t';
      if (activeTrackTab === 'long_t') return track === 'long_t';
      if (activeTrackTab === 'short_swing') return track === 'short_swing';
      return true;
    });
  }, [enrichedAllLogs, activeTrackTab]);

  // 当前视图下的四维纪律评分卡
  const scorecard = useMemo(
    () => computeDisciplineScorecard(filteredLogs, pool, wbLatest),
    [filteredLogs, pool, wbLatest]
  );

  const handleRunCoach = async (mode = 'auto') => {
    const targetTrades = enrichedAllLogs.filter(l => l.date === coachDate);
    if (!targetTrades.length) {
      toastErr(`日期 ${coachDate} 暂无任何成交流水记录，请先完成或录入该日交易！`);
      return;
    }

    setCoachLoading(true);
    setCoachReviewResult(null);
    try {
      const liveGate = MKT?.gate ? { level: MKT.gate.level, text: String(MKT.gate.title || '').replace(/<[^>]+>/g, '') } : null;
      const marketEnv = wbLatest?.env || liveGate || { level: 'OK', text: '大盘平稳' };
      const res = await fetchCoachReview({
        trades: targetTrades,
        date: coachDate,
        marketEnv,
        userNotes: coachNotes,
        apiKey: aiConfig.apiKey,
        apiUrl: aiConfig.apiUrl,
        model: aiConfig.model,
        mode,
      });
      setCoachReviewResult(res);
      toastOk(res.engine === 'llm' ? '🧠 大模型深度复盘诊断书已生成！' : '⚡ 量化规则复盘诊断书已秒级生成！');
    } catch (err) {
      toastErr(err.message || '复盘报告生成失败');
    } finally {
      setCoachLoading(false);
    }
  };

  // 手工录入表单实时匹配系统标准点位（使用统一 calc 引擎）
  const matchedSysBenchmark = useMemo(() => {
    if (!form.stock) return null;
    const { benchmark } = resolveSystemBenchmark({
      stockText: form.stock,
      dir: form.dir,
      qty: parseInt(form.qty, 10) || 500,
      wbLatest,
      poolList: pool,
    });
    return benchmark;
  }, [form.stock, form.dir, form.qty, wbLatest, pool]);

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

  const openEditLogModal = (lg) => {
    if (!onUpdateLog) return;
    setEditingLog({
      ...lg,
      mistakeTags: Array.isArray(lg.mistakeTags) ? [...lg.mistakeTags] : [],
      reflection: lg.reflection || '',
      plan: lg.plan || '计划内',
      track: lg.track || 'long_t',
    });
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const b = parseFloat(form.buy) || 0;
    const s = parseFloat(form.sell) || 0;
    const q = parseInt(form.qty, 10) || 0;
    if (b <= 0 || s <= 0 || q <= 0) {
      toastErr('请输入正确的买卖价格与股数');
      return;
    }
    const gross = (s - b) * q;
    const buyFee = Math.max(5, b * q * 0.00025) + b * q * 0.00001;
    const sellFee = Math.max(5, s * q * 0.00025) + s * q * 0.00051;
    const fee = Math.round((buyFee + sellFee) * 100) / 100;
    const net = Math.round((gross - fee) * 100) / 100;

    const audit = auditTradeExecution({
      stockText: form.stock,
      dir: form.dir,
      track: form.track,
      buy: b,
      sell: s,
      qty: q,
      net,
      plan: form.plan,
      basis: form.basis,
      mistakeTags: form.mistakeTags,
      prevLogs: logs,
      wbLatest,
      poolList: pool,
      totalAssets,
      date: form.date,
    });

    onAddLog({
      id: Date.now(),
      date: form.date,
      track: audit.track,
      stock: form.stock,
      dir: form.dir,
      buy: b,
      sell: s,
      qty: q,
      gross,
      fee,
      net,
      plan: audit.plan,
      basis: audit.basis,
      mistakeTags: audit.mistakeTags,
      note: form.note,
      reflection: form.reflection,
      satisfaction: form.satisfaction,
      systemBenchmark: audit.systemBenchmark,
      alphaNet: audit.alphaNet,
      buyDevPct: audit.buyDevPct,
      sellDevPct: audit.sellDevPct,
      disciplineScore: audit.disciplineScore,
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

  // 保存已有流水的复盘打标与反思编辑
  const handleSaveEditLog = (e) => {
    e.preventDefault();
    if (!editingLog || !onUpdateLog) return;
    const audit = auditTradeExecution({
      stockText: editingLog.stock,
      code: editingLog.code,
      dir: editingLog.dir,
      track: editingLog.track,
      buy: editingLog.buy,
      sell: editingLog.sell,
      qty: editingLog.qty,
      net: editingLog.net,
      plan: editingLog.plan,
      basis: editingLog.basis,
      mistakeTags: editingLog.mistakeTags || [],
      wbLatest,
      poolList: pool,
      totalAssets,
      date: editingLog.date,
    });
    onUpdateLog({
      ...editingLog,
      plan: editingLog.plan,
      track: editingLog.track,
      mistakeTags: editingLog.mistakeTags || [],
      reflection: editingLog.reflection || '',
      note: editingLog.note || '',
      systemBenchmark: editingLog.systemBenchmark || audit.systemBenchmark,
      alphaNet: editingLog.alphaNet !== undefined ? editingLog.alphaNet : audit.alphaNet,
      buyDevPct: editingLog.buyDevPct !== undefined ? editingLog.buyDevPct : audit.buyDevPct,
      sellDevPct: editingLog.sellDevPct !== undefined ? editingLog.sellDevPct : audit.sellDevPct,
      disciplineScore: audit.disciplineScore,
    });
    setEditingLog(null);
  };

  // 提取已平仓闭环交易记录
  const closedTLogs = useMemo(() => {
    return filteredLogs.filter(lg => {
      const isPureBuy = lg.dir === '买入建仓' || lg.dir === '买入加仓' || lg.dir === '直接买入' || lg.dir === '尾盘买入';
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
    const lossCount = closedTLogs.filter(lg => (+lg.net || 0) < 0).length;
    const winRate = closedTLogs.length > 0 ? (winCount / closedTLogs.length) * 100 : 0;
    const plannedCount = filteredLogs.filter(lg => lg.plan !== '计划外').length;
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

    // 失误标签频次与损耗金额统计（含自动识别标签）
    const mistakeMap = {};
    filteredLogs.forEach(lg => {
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
          label: `${(lg.date || '').slice(5)} · ${(lg.stock || '').split(' ')[0]}`,
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
          label: `${(lg.date || '').slice(5)} (${lg.dir})`,
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

  // 手机端触屏在 SVG 曲线上横向滑动跟手查点
  const handleCurveTouch = (e) => {
    const pts = chartData.points || [];
    if (pts.length < 2 || !svgRef.current) return;
    const touch = e.touches && e.touches[0];
    if (!touch) return;
    const rect = svgRef.current.getBoundingClientRect();
    if (!rect.width) return;
    const W = 760, PL = 58, PR = 26;
    const svgX = ((touch.clientX - rect.left) / rect.width) * W;
    const ratio = Math.max(0, Math.min(1, (svgX - PL) / (W - PL - PR)));
    const nearestIdx = Math.round(ratio * (pts.length - 1));
    setHoverIdx(nearestIdx);
  };

  const renderCurveSvg = () => {
    const pts = chartData.points || [];
    if (pts.length < 2) {
      return (
        <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--mute)', fontSize: '12px', background: 'var(--surface2)', borderRadius: '8px', border: '1px dashed var(--line)' }}>
          暂无足够的闭环平仓流水绘制曲线。通过作战台「⚡ 记T」或上方「＋ 记一笔」产生平仓记录后，将自动绘制资金与成本摊薄轨迹。
        </div>
      );
    }

    const W = 760, H = 185, PL = 58, PR = 26, PT = 22, PB = 28;
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
      <div style={{ position: 'relative', width: '100%' }}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          onTouchStart={handleCurveTouch}
          onTouchMove={handleCurveTouch}
          style={{ width: '100%', height: 'auto', display: 'block', touchAction: 'pan-y', userSelect: 'none' }}
        >
          <line x1={PL} y1={PT} x2={W - PR} y2={PT} stroke="var(--line)" strokeDasharray="3 3" />
          <line x1={PL} y1={PT + innerH / 2} x2={W - PR} y2={PT + innerH / 2} stroke="var(--line)" strokeDasharray="3 3" />
          <line x1={PL} y1={PT + innerH} x2={W - PR} y2={PT + innerH} stroke="var(--line)" />
          <line x1={PL} y1={PT} x2={PL} y2={PT + innerH} stroke="var(--line)" />

          <text x={PL - 8} y={PT + 4} textAnchor="end" fontSize="10" fill="var(--mute)">{f2(maxV)}</text>
          <text x={PL - 8} y={PT + innerH / 2 + 3} textAnchor="end" fontSize="10" fill="var(--mute)">{f2((maxV + minV) / 2)}</text>
          <text x={PL - 8} y={PT + innerH} textAnchor="end" fontSize="10" fill="var(--mute)">{f2(minV)}</text>

          <path d={pathD} fill="none" stroke={strokeColor} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

          {hoverIdx !== null && pts[hoverIdx] && (
            <line
              x1={xCoord(hoverIdx)}
              y1={PT}
              x2={xCoord(hoverIdx)}
              y2={PT + innerH}
              stroke={strokeColor}
              strokeDasharray="3 3"
              strokeOpacity="0.45"
            />
          )}

          {pts.map((p, i) => (
            <g
              key={i}
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx(null)}
              onClick={() => setHoverIdx(i)}
              style={{ cursor: 'pointer' }}
            >
              <circle
                cx={xCoord(i)}
                cy={yCoord(p.val)}
                r={hoverIdx === i ? 6 : 3.8}
                fill={hoverIdx === i ? '#fff' : strokeColor}
                stroke={strokeColor}
                strokeWidth={hoverIdx === i ? 2.6 : 1.5}
              />
            </g>
          ))}
        </svg>

        {hoverIdx !== null && pts[hoverIdx] && (
          <div className="ledger-curve-tip">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
              <b>{pts[hoverIdx].label}</b>
              <button
                type="button"
                className="ledger-tip-close"
                onClick={() => setHoverIdx(null)}
                aria-label="关闭曲线浮窗"
              >
                ✕
              </button>
            </div>
            <div>{isCostMode ? '摊薄成本: ' : '累计套利: '}<b>{f2(pts[hoverIdx].val)}</b></div>
            {pts[hoverIdx].delta !== 0 && (
              <div style={{ color: pts[hoverIdx].delta > 0 ? 'var(--up)' : 'var(--down)', fontWeight: 700 }}>
                单笔影响: {pts[hoverIdx].delta > 0 ? '+' : ''}{money(pts[hoverIdx].delta)}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const scoreColor =
    scorecard.totalScore >= 85 ? '#15803d' : scorecard.totalScore >= 70 ? '#0958d9' : scorecard.totalScore >= 55 ? '#d97706' : '#cf1322';

  return (
    <div className="ledger-wrap" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* 🛡️ 本地磁盘自动双写金库防丢保护提示横幅 */}
      {vaultStatus?.guarded && vaultStatus?.remoteSummary && (
        <div className="ledger-vault-guard">
          <div style={{ color: '#92400e' }}>
            <b>🛡️ 本地磁盘金库防误删保护已触发：</b>
            检测到本机 <code>data/user_vault.json</code> 存有 <b>{vaultStatus.remoteSummary.logCount}</b> 笔成交流水与 <b>{vaultStatus.remoteSummary.snapshotCount}</b> 条净值快照（更新于 {vaultStatus.remoteSummary.updatedAt}），已阻止当前空白浏览器缓存覆盖磁盘。
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {onRestoreVault && (
              <button
                type="button"
                className="primary"
                onClick={onRestoreVault}
                style={{ fontSize: '12px', padding: '5px 12px', background: '#d97706', border: 'none', color: '#fff', fontWeight: 700 }}
              >
                🔄 立即从本地磁盘恢复数据
              </button>
            )}
            {onForceSyncVault && (
              <button
                type="button"
                onClick={() => onForceSyncVault(true)}
                style={{ fontSize: '12px', padding: '5px 10px' }}
              >
                强制以当前状态覆盖磁盘
              </button>
            )}
          </div>
        </div>
      )}

      <section className="card ledger-main-card">
        {/* 顶部标题栏 + 本地磁盘双写状态 + 单手操作按钮区 */}
        <div className="ledger-head-bar">
          <div>
            <h2 className="ledger-head-title">
              <span>📒</span> 实盘交易台账与人机对决复盘系统
              <span className="tag ledger-sub-badge">全链路点位审计 · 本地磁盘双写</span>
              {vaultStatus && (
                <span
                  style={{
                    fontSize: '11px',
                    padding: '2px 8px',
                    borderRadius: '999px',
                    fontWeight: 600,
                    background: vaultStatus.connected ? '#f0fdf4' : '#f8fafc',
                    color: vaultStatus.connected ? '#15803d' : '#64748b',
                    border: `1px solid ${vaultStatus.connected ? '#86efac' : '#cbd5e1'}`,
                  }}
                  title={
                    vaultStatus.connected
                      ? `已开启浏览器 localStorage + 本机磁盘 data/user_vault.json 自动双写（留存 ${vaultStatus.backupCount || 1} 份按日快照）`
                      : '后端服务未连接，当前使用浏览器本地存储（启动 FastAPI 后自动开启本地磁盘双写备份）'
                  }
                >
                  {vaultStatus.syncing
                    ? '💾 磁盘同步中…'
                    : vaultStatus.connected
                    ? `💾 金库已同步 ${vaultStatus.updatedAt ? vaultStatus.updatedAt.slice(11, 19) : ''}`
                    : '💾 仅浏览器缓存'}
                </span>
              )}
            </h2>
            <div className="ledger-head-desc">
              作战台快捷记T、建仓加仓与尾盘交割均自动计算【系统SOP点位偏离度%】与【主观情绪摩擦损耗】，支持免密钥秒级量化复盘与大模型深度剖析。
            </div>
          </div>

          <div className="ledger-head-acts">
            {onOpenEodModal && (
              <button
                type="button"
                onClick={onOpenEodModal}
                className="ledger-btn-eod"
                style={{
                  background: todayArchived ? '#f0fdf4' : '#0f766e',
                  color: todayArchived ? '#15803d' : '#fff',
                  border: todayArchived ? '1px solid #86efac' : 'none',
                }}
                title="15:05 盘后一键收盘归档（同步收盘价 · 排查未平T · 净值快照 · 复盘简报 · 本地金库落盘）"
              >
                <span>{todayArchived ? '✅' : '🏁'}</span> {todayArchived ? '今日已归档' : '15:05 收盘归档'}
              </button>
            )}
            <button
              type="button"
              className="primary ledger-btn-coach"
              onClick={() => setShowCoachModal(true)}
            >
              <span>🤖</span> 呼叫复盘教练
            </button>
            <button
              type="button"
              className="ledger-btn-add"
              onClick={() => setShowAddModal(true)}
            >
              ＋ 记一笔
            </button>
            <button
              type="button"
              onClick={() => setShowSettingsModal(true)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              title="配置天翼云/DeepSeek 大模型密钥（未配置时自动使用内置量化规则教练）"
            >
              <span>⚙️</span> {hasAiKey ? 'AI已就绪' : 'AI配置'}
            </button>
            {vaultStatus?.connected && onForceSyncVault && (
              <button
                type="button"
                onClick={() => onForceSyncVault(false)}
                title="立即将全部持仓、现金总账、风控配置与成交流水写入本地磁盘金库"
              >
                💾 落盘备份
              </button>
            )}
            <button type="button" onClick={onExport}>⬇ 导出</button>
            <button type="button" onClick={onImportClick}>⬆ 导入</button>
          </div>
        </div>

        {/* 🏅 四维操盘纪律与计划偏离度量化评分卡（响应式无挤压布局） */}
        <div className="ledger-scorecard-grid">
          <div className="ledger-score-main">
            <div style={{ fontSize: '11.5px', color: 'var(--sub)', fontWeight: 600 }}>🛡️ 操盘纪律与偏离度评分</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginTop: '4px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '28px', fontWeight: 900, fontFamily: 'monospace', color: scoreColor, lineHeight: 1 }}>
                {scorecard.totalScore}
              </span>
              <span style={{ fontSize: '12px', color: 'var(--mute)' }}>/ 100</span>
              <span style={{
                fontSize: '11px',
                padding: '2px 7px',
                borderRadius: '4px',
                fontWeight: 700,
                background: '#fff',
                color: scoreColor,
                border: `1px solid ${scoreColor}`
              }}>
                {scorecard.grade}
              </span>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--sub)', marginTop: '6px' }}>
              买点均偏:{' '}
              <b style={{ fontFamily: 'monospace', color: scorecard.avgBuyDevPct != null && scorecard.avgBuyDevPct > 0.6 ? '#cf1322' : '#15803d' }}>
                {scorecard.avgBuyDevPct != null ? `${scorecard.avgBuyDevPct >= 0 ? '+' : ''}${scorecard.avgBuyDevPct.toFixed(2)}%` : '0.00%'}
              </b>
              {' ｜ '}摩擦损耗:{' '}
              <b style={{ fontFamily: 'monospace', color: scorecard.frictionLoss > 0 ? '#cf1322' : '#15803d' }}>
                ¥{money(scorecard.frictionLoss)}
              </b>
            </div>
          </div>

          <div className="ledger-dim-grid">
            {[
              { label: '🎯 买点精准度', val: scorecard.buyScore, max: 25, desc: '防追高/锚定低吸区', color: '#0284c7' },
              { label: '💰 止盈兑现度', val: scorecard.sellScore, max: 25, desc: '按目标分批锁盈', color: '#16a34a' },
              { label: '🛡️ 止损铁律度', val: scorecard.stopScore, max: 25, desc: '破位秒砍绝不死扛', color: '#dc2626' },
              { label: '🧭 环境与仓位', val: scorecard.envScore, max: 25, desc: '顺应大盘防报复单', color: '#7c3aed' },
            ].map((dim) => (
              <div key={dim.label} style={{ background: '#fff', padding: '8px 10px', borderRadius: '8px', border: '1px solid #e2e8f0', minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11.5px', fontWeight: 700, gap: '4px' }}>
                  <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{dim.label}</span>
                  <span style={{ fontFamily: 'monospace', color: dim.color, flexShrink: 0 }}>{dim.val}/{dim.max}</span>
                </div>
                <div style={{ height: '6px', background: '#f1f5f9', borderRadius: '999px', overflow: 'hidden', margin: '6px 0 4px' }}>
                  <div style={{ width: `${(dim.val / dim.max) * 100}%`, height: '100%', background: dim.color, borderRadius: '999px' }} />
                </div>
                <div style={{ fontSize: '10.5px', color: 'var(--mute)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{dim.desc}</div>
              </div>
            ))}
          </div>
        </div>

        {/* 🔀 双轨分仓导航切换栏（窄屏单行丝滑横滑） */}
        <div className="ledger-track-tabs">
          {[
            { id: 'ALL', label: `📊 全部流水 (${enrichedAllLogs.length}笔)` },
            { id: 'long_t', label: `🛡️ 长线做T轨 (${enrichedAllLogs.filter(x => (x.track || 'long_t') === 'long_t').length}笔)` },
            { id: 'short_swing', label: `⚡ 短线攻防轨 (${enrichedAllLogs.filter(x => x.track === 'short_swing').length}笔)` },
            { id: 'BENCHMARK', label: `⚖️ 人机对决战报 (${stats.benchmarkCompareCount}笔对照)` },
          ].map(tab => (
            <button
              key={tab.id}
              type="button"
              className={`ledger-track-tab ${activeTrackTab === tab.id ? 'primary active' : ''}`}
              onClick={() => setActiveTrackTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* 🏆 4 维核心绩效战报 KPI 卡片（手机端紧凑 2×2 双列宫格） */}
        <div className="ledger-kpi-grid">
          <div className="card ledger-kpi-card" style={{ borderLeft: `4px solid ${stats.todayNet >= 0 ? '#cf1322' : '#0a7f42'}` }}>
            <div className="ledger-kpi-k">☀️ 今日净落袋 ({stats.todayCount}笔)</div>
            <div className={`ledger-kpi-v ${stats.todayNet >= 0 ? 'up' : 'down'}`}>
              {stats.todayNet >= 0 ? '+' : ''}{money(stats.todayNet)}
            </div>
          </div>

          <div className="card ledger-kpi-card" style={{ borderLeft: `4px solid ${stats.totalNet >= 0 ? '#cf1322' : '#0a7f42'}` }}>
            <div className="ledger-kpi-k">
              {activeTrackTab === 'long_t' ? '💰 累计做T套利' : activeTrackTab === 'short_swing' ? '⚡ 短线闭环净利' : '💰 历史累计落袋'}
            </div>
            <div className={`ledger-kpi-v ${stats.totalNet >= 0 ? 'up' : 'down'}`}>
              {stats.totalNet >= 0 ? '+' : ''}{money(stats.totalNet)}
            </div>
          </div>

          <div className="card ledger-kpi-card" style={{ borderLeft: '4px solid #0958d9' }}>
            <div className="ledger-kpi-k">🎯 综合平仓胜率</div>
            <div className="ledger-kpi-v" style={{ color: '#0958d9' }}>
              {stats.winRate.toFixed(1)}%
              <span className="ledger-kpi-sub">
                ({stats.winCount}胜/{stats.lossCount}负)
              </span>
            </div>
          </div>

          <div className="card ledger-kpi-card" style={{ borderLeft: '4px solid #7c3aed' }}>
            <div className="ledger-kpi-k">🛡️ 计划内纪律率</div>
            <div className="ledger-kpi-v" style={{ color: '#7c3aed' }}>
              {stats.disciplineRate.toFixed(0)}%
              {stats.bestTrade && (
                <span className="ledger-kpi-sub">
                  最佳 +{money(stats.bestTrade.net)}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* ⚖️ 人机对决收益对照专区 */}
        {activeTrackTab === 'BENCHMARK' && (
          <div style={{ background: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: '10px', padding: '14px', marginBottom: '16px' }}>
            <div style={{ fontSize: '14px', fontWeight: 800, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span>⚖️</span> 【人机对决战报】：交易员实操净利 vs 系统量化网格 SOP 理论基准
            </div>
            <div style={{ fontSize: '12px', color: 'var(--sub)', marginBottom: '12px' }}>
              逐笔比对实盘成交价与当时系统推荐低吸买点 (`inA`)、冲高止盈位 (`tp1 / outA`) 及纪律止损线 (`slA`)，精准剥离出「主观情绪摩擦账单」。
            </div>

            <div className="ledger-bench-grid">
              <div style={{ padding: '10px 12px', background: '#fff', borderRadius: '6px', border: '1px solid var(--line)' }}>
                <div style={{ fontSize: '11.5px', color: 'var(--mute)' }}>🤖 系统理论 SOP 预期净收益 ({stats.benchmarkCompareCount}笔)</div>
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
                  {stats.emotionFrictionCost > 0 ? '🚨 主观情绪净摩擦损耗 (少赚/多亏)' : '🌟 交易员超额 Alpha 收益'}
                </div>
                <div style={{ fontSize: '18px', fontWeight: 800, fontFamily: 'monospace', marginTop: '4px', color: stats.emotionFrictionCost > 0 ? '#cf1322' : '#15803d' }}>
                  {stats.emotionFrictionCost > 0 ? '-' : '+'}{money(Math.abs(stats.emotionFrictionCost))}
                </div>
              </div>
            </div>

            {/* 失误归因排行 */}
            <div style={{ background: '#fff', borderRadius: '6px', padding: '10px 12px', border: '1px solid var(--line)' }}>
              <div style={{ fontSize: '12.5px', fontWeight: 700, marginBottom: '8px' }}>🏷️ 高频失误类型损耗排行（含系统盘口自动审计识别）：</div>
              {stats.mistakeRank.length ? (
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {stats.mistakeRank.map(m => (
                    <div key={m.id} style={{ fontSize: '11.5px', padding: '4px 10px', background: 'var(--surface2)', borderRadius: '6px', border: '1px solid var(--line)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                      <span>{m.icon}</span>
                      <b>{m.name}</b>: <span>{m.count}次</span>
                      {m.lossSum > 0 && <span style={{ color: 'var(--up)', fontWeight: 700 }}>(涉亏 ¥{money(m.lossSum)})</span>}
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: '12px', color: 'var(--mute)' }}>当前暂无失误记录，继续保持铁血执行纪律！点击任意流水的「复盘」可随时补充归因标签。</div>
              )}
            </div>
          </div>
        )}

        {/* 📈 成本摊薄与累计套利曲线看板（支持触屏跟手滑动查数） */}
        {activeTrackTab !== 'BENCHMARK' && (
          <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '10px', padding: '12px 14px', marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
              <div style={{ fontSize: '13.5px', fontWeight: 800, color: 'var(--text)' }}>
                {selectedChartStock === 'ALL'
                  ? '📈 账户累计净套利资金曲线'
                  : `📉 【${selectedChartStock}】底仓每股成本下降轨迹`}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                <span className="ledger-chart-hint">手指横滑曲线可查点 · 标的：</span>
                <select
                  value={selectedChartStock}
                  onChange={e => { setSelectedChartStock(e.target.value); setHoverIdx(null); }}
                  className="ledger-stock-select"
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

        {/* 📋 流水明细视图切换工具条（手机端默认单手复盘卡片，支持随时切宽表） */}
        <div className="ledger-list-toolbar">
          <div style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--sub)' }}>
            📋 成交流水与纪律审计明细（共 <b>{filteredLogs.length}</b> 笔）
          </div>
          <div className="ledger-view-switch" role="group" aria-label="流水视图切换">
            {[
              { id: 'auto', label: '✨ 自适应' },
              { id: 'card', label: '📱 复盘卡' },
              { id: 'table', label: '📋 全宽表' },
            ].map(m => (
              <button
                key={m.id}
                type="button"
                className={logViewMode === m.id ? 'active' : ''}
                onClick={() => setLogViewMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {/* 📱 移动端原生单手复盘卡片流（窄屏默认开启，零横向滚动） */}
        <div className={`ledger-log-cards mode-${logViewMode}`}>
          {filteredLogs.length > 0 ? (
            filteredLogs.map(lg => {
              const tagList = (lg.mistakeTags || []).map(id => {
                const item = MISTAKE_DICTIONARY.find(m => m.id === id);
                return item ? `${item.icon} ${item.name}` : id;
              });
              const dScore = lg.disciplineScore ?? 100;
              const isOpenHold = (lg.dir || '').includes('建仓') || (lg.dir || '').includes('加仓') || lg.dir === '尾盘买入';
              const isBuyDir = (lg.dir || '').includes('买') || (lg.dir || '').includes('正T') || (lg.dir || '').includes('潜伏');
              const isConfirmingDel = confirmDeleteId === lg.id;

              return (
                <div key={lg.id} className="ledger-log-card">
                  {/* 第一行：标的 + 轨制/方向 + 右侧大号净落袋 */}
                  <div className="llc-top">
                    <div className="llc-ident">
                      <div className="llc-stock">{lg.stock}</div>
                      <div className="llc-badges">
                        <span className={`llc-track ${lg.track === 'short_swing' ? 'short' : 'long'}`}>
                          {lg.track === 'short_swing' ? '⚡ 短线攻防' : '🛡️ 长线做T'}
                        </span>
                        <span className={`pill ${isBuyDir ? 'p-buy' : 'p-sell'}`} style={{ fontSize: '11px', padding: '1px 7px' }}>
                          {lg.dir}
                        </span>
                        <span className="llc-date">{lg.date}{lg.time ? ` ${lg.time}` : ''}</span>
                      </div>
                    </div>

                    <div className="llc-pnl">
                      {isOpenHold ? (
                        <span className="llc-hold-tag">开仓持仓中</span>
                      ) : (
                        <>
                          <span className={`llc-net ${lg.net >= 0 ? 'up' : 'down'}`}>
                            {lg.net >= 0 ? '+' : ''}{money(lg.net)}
                          </span>
                          <span className="llc-net-lbl">净落袋(元)</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* 第二行：买价 / 卖价 / 股数 紧凑三宫格 */}
                  <div className="llc-prices">
                    <div className="llc-px-cell">
                      <span>买入价</span>
                      <b>{lg.buy > 0 ? `¥${f2(lg.buy)}` : '—'}</b>
                    </div>
                    <div className="llc-px-cell">
                      <span>卖出价</span>
                      <b>{lg.sell > 0 ? `¥${f2(lg.sell)}` : '—'}</b>
                    </div>
                    <div className="llc-px-cell">
                      <span>成交数量</span>
                      <b>{lg.qty}股</b>
                    </div>
                  </div>

                  {/* 第三行：SOP 人机对决 & 纪律评分 & 失误标签 */}
                  <div className="llc-audit">
                    <div className="llc-tags-row">
                      <span
                        className="llc-score-pill"
                        style={{
                          background: dScore >= 85 ? '#f0fdf4' : dScore >= 70 ? '#eff6ff' : '#fffbeb',
                          color: dScore >= 85 ? '#15803d' : dScore >= 70 ? '#1d4ed8' : '#b45309',
                          border: `1px solid ${dScore >= 85 ? '#86efac' : dScore >= 70 ? '#bfdbfe' : '#fcd34d'}`
                        }}
                      >
                        🛡️ {dScore}分 · {lg.plan || '计划内'}
                      </span>
                      {tagList.map((t, idx) => (
                        <span key={idx} className="llc-mistake-pill">{t}</span>
                      ))}
                    </div>

                    {lg.systemBenchmark && (
                      <div className="llc-sop-row">
                        <span>
                          SOP买 <b>¥{f2(lg.systemBenchmark.sysBuy)}</b>
                          {lg.buyDevPct != null && (
                            <em style={{ color: lg.buyDevPct > 0.6 ? '#cf1322' : '#15803d' }}>
                              ({lg.buyDevPct >= 0 ? '+' : ''}{lg.buyDevPct.toFixed(1)}%)
                            </em>
                          )}
                          {' ｜ '}目标 <b>¥{f2(lg.systemBenchmark.sysSell1)}</b>
                        </span>
                        {lg.alphaNet != null && (
                          <b style={{ color: lg.alphaNet >= 0 ? '#15803d' : '#cf1322' }}>
                            {lg.alphaNet >= 0 ? `跑赢SOP +¥${money(lg.alphaNet)}` : `情绪损耗 -¥${money(Math.abs(lg.alphaNet))}`}
                          </b>
                        )}
                      </div>
                    )}
                  </div>

                  {/* 第四行：反思心得（不省略截断，完整呈现） */}
                  {(lg.reflection || lg.note) && (
                    <div className="llc-note">
                      📝 {lg.reflection || lg.note}
                    </div>
                  )}

                  {/* 第五行：底部单手大拇指操作区 */}
                  <div className="llc-foot">
                    <span style={{ fontSize: '11px', color: 'var(--mute)' }}>
                      依据：{lg.basis || '客观信号'}
                    </span>
                    <div className="llc-actions">
                      {onUpdateLog && (
                        <button
                          type="button"
                          className="llc-btn-review"
                          onClick={() => openEditLogModal(lg)}
                        >
                          ✏️ 复盘打标
                        </button>
                      )}
                      <button
                        type="button"
                        className={`llc-btn-del ${isConfirmingDel ? 'confirm' : ''}`}
                        onClick={() => requestDeleteLog(lg.id)}
                      >
                        {isConfirmingDel ? '确认删除?' : '删除'}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          ) : (
            <div style={{ textAlign: 'center', padding: '28px 16px', color: 'var(--mute)', background: 'var(--surface)', borderRadius: '10px', border: '1px dashed var(--line)' }}>
              暂无符合条件的交易流水记录。
            </div>
          )}
        </div>

        {/* 📋 桌面端 12 列完整专业宽表（桌面默认开启，窄屏也可手动切换查看） */}
        <div className={`tbl-scroll ledger-table-wrap mode-${logViewMode}`} style={{ maxHeight: '440px' }}>
          <table>
            <thead>
              <tr>
                <th>日期/时间</th>
                <th>轨制</th>
                <th>标的名称</th>
                <th>方向</th>
                <th>买入价</th>
                <th>卖出价</th>
                <th>股数</th>
                <th>净落袋</th>
                <th>纪律/失误归因</th>
                <th>人机对决 & 点位偏离</th>
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
                  const dScore = lg.disciplineScore ?? 100;
                  const isConfirmingDel = confirmDeleteId === lg.id;

                  return (
                    <tr key={lg.id}>
                      <td style={{ fontSize: '11.5px', color: 'var(--mute)', whiteSpace: 'nowrap' }}>
                        <div>{lg.date}</div>
                        {lg.time && <div style={{ fontSize: '10px', opacity: 0.8 }}>{lg.time}</div>}
                      </td>
                      <td>
                        <span style={{
                          fontSize: '10.5px',
                          padding: '1px 6px',
                          borderRadius: '4px',
                          background: lg.track === 'short_swing' ? '#faf5ff' : '#f0f9ff',
                          color: lg.track === 'short_swing' ? '#7c3aed' : '#0369a1',
                          border: `1px solid ${lg.track === 'short_swing' ? '#d8b4fe' : '#bae6fd'}`,
                          fontWeight: 600,
                          whiteSpace: 'nowrap'
                        }}>
                          {lg.track === 'short_swing' ? '⚡ 短线攻防' : '🛡️ 长线做T'}
                        </span>
                      </td>
                      <td style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{lg.stock}</td>
                      <td>
                        <span className={`pill ${
                          (lg.dir || '').includes('买') || (lg.dir || '').includes('正T') || (lg.dir || '').includes('潜伏') ? 'p-buy' : 'p-sell'
                        }`}>
                          {lg.dir}
                        </span>
                      </td>
                      <td className="num">{lg.buy > 0 ? f2(lg.buy) : '—'}</td>
                      <td className="num">{lg.sell > 0 ? f2(lg.sell) : '—'}</td>
                      <td className="num">{lg.qty}</td>
                      <td className="num">
                        {(lg.dir || '').includes('建仓') || (lg.dir || '').includes('加仓') || lg.dir === '尾盘买入' ? (
                          <span style={{ color: '#1677ff', fontSize: '11px', fontWeight: 600 }}>开仓持仓中</span>
                        ) : (
                          <b className={lg.net >= 0 ? 'up' : 'down'}>{lg.net >= 0 ? '+' : ''}{money(lg.net)}</b>
                        )}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap', alignItems: 'center' }}>
                          <span style={{
                            fontSize: '10px',
                            padding: '1px 5px',
                            borderRadius: '3px',
                            fontWeight: 700,
                            background: dScore >= 85 ? '#f0fdf4' : dScore >= 70 ? '#eff6ff' : '#fffbeb',
                            color: dScore >= 85 ? '#15803d' : dScore >= 70 ? '#1d4ed8' : '#b45309',
                            border: `1px solid ${dScore >= 85 ? '#86efac' : dScore >= 70 ? '#bfdbfe' : '#fcd34d'}`
                          }}>
                            {dScore}分·{lg.plan || '计划内'}
                          </span>
                          {tagList.map((t, idx) => (
                            <span key={idx} style={{ fontSize: '10.5px', padding: '1px 5px', borderRadius: '3px', background: '#fff1f0', color: '#cf1322', border: '1px solid #ffa39e' }}>
                              {t}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td>
                        {lg.systemBenchmark ? (
                          <div style={{ fontSize: '11px', lineHeight: 1.35, whiteSpace: 'nowrap' }}>
                            <div style={{ color: 'var(--sub)' }}>
                              SOP买 <b>{f2(lg.systemBenchmark.sysBuy)}</b>
                              {lg.buyDevPct != null && (
                                <span style={{ marginLeft: '3px', color: lg.buyDevPct > 0.6 ? '#cf1322' : '#15803d', fontFamily: 'monospace' }}>
                                  ({lg.buyDevPct >= 0 ? '+' : ''}{lg.buyDevPct.toFixed(1)}%)
                                </span>
                              )}
                              {' ｜ '}标 <b>{f2(lg.systemBenchmark.sysSell1)}</b>
                            </div>
                            {lg.alphaNet != null && (
                              <div style={{ color: lg.alphaNet >= 0 ? '#15803d' : '#cf1322', fontWeight: 700 }}>
                                {lg.alphaNet >= 0 ? `跑赢SOP +¥${money(lg.alphaNet)}` : `情绪损耗 -¥${money(Math.abs(lg.alphaNet))}`}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span style={{ color: 'var(--mute)', fontSize: '11px' }}>—</span>
                        )}
                      </td>
                      <td style={{ fontSize: '11.5px', color: 'var(--sub)', maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={lg.reflection || lg.note}>
                        {lg.reflection || lg.note || '—'}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'inline-flex', gap: '4px' }}>
                          {onUpdateLog && (
                            <button
                              type="button"
                              className="mini"
                              onClick={() => openEditLogModal(lg)}
                              style={{ color: '#0958d9', marginLeft: 0 }}
                              title="补充或修改本笔成交的失误归因标签与复盘心得"
                            >
                              复盘
                            </button>
                          )}
                          <button
                            type="button"
                            className="mini"
                            onClick={() => requestDeleteLog(lg.id)}
                            style={{
                              marginLeft: 0,
                              color: isConfirmingDel ? '#fff' : 'var(--up)',
                              background: isConfirmingDel ? '#cf1322' : '#fff',
                              borderColor: isConfirmingDel ? '#cf1322' : 'var(--line)'
                            }}
                          >
                            {isConfirmingDel ? '确认删?' : '删除'}
                          </button>
                        </div>
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

      {/* ✏️ 单笔成交复盘打标与反思编辑弹窗（移动端自动贴底抽屉 + 大拇指归因胶囊） */}
      {editingLog && (
        <div className="modal-mask" onClick={() => setEditingLog(null)}>
          <div className="modal-box ledger-modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: '540px' }}>
            <div className="modal-hd">
              <h3 style={{ margin: 0 }}>✏️ 复盘归因与心得编辑 · {editingLog.stock}</h3>
              <button className="modal-close" onClick={() => setEditingLog(null)}>×</button>
            </div>
            <form onSubmit={handleSaveEditLog} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
              <div className="modal-bd" style={{ display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '12.5px' }}>
                <div style={{ padding: '8px 10px', borderRadius: '6px', background: 'var(--surface2)', fontSize: '12px', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '6px' }}>
                  <span><b>{editingLog.date} {editingLog.time || ''}</b> · {editingLog.dir} {editingLog.qty}股</span>
                  <span>买 ¥{f2(editingLog.buy)} / 卖 {editingLog.sell > 0 ? `¥${f2(editingLog.sell)}` : '—'} ｜ 净额 <b>{editingLog.net >= 0 ? '+' : ''}¥{money(editingLog.net)}</b></span>
                </div>

                <div className="ledger-form-grid-2">
                  <div className="fld">
                    <label style={{ fontWeight: 600 }}>交易轨制归属</label>
                    <select
                      value={editingLog.track || 'long_t'}
                      onChange={e => setEditingLog(prev => ({ ...prev, track: e.target.value }))}
                    >
                      <option value="long_t">🛡️ 长线做T轨（底仓降本）</option>
                      <option value="short_swing">⚡ 短线攻防轨（尾盘·连板）</option>
                    </select>
                  </div>
                  <div className="fld">
                    <label style={{ fontWeight: 600 }}>计划执行定性</label>
                    <select
                      value={editingLog.plan || '计划内'}
                      onChange={e => setEditingLog(prev => ({ ...prev, plan: e.target.value }))}
                    >
                      <option value="计划内">✅ 计划内（严格按SOP信号）</option>
                      <option value="计划外">⚠️ 计划外（盘中临时冲动）</option>
                    </select>
                  </div>
                </div>

                <div className="fld">
                  <label style={{ fontWeight: 600 }}>失误归因标签（单手轻点即可切换勾选）</label>
                  <div className="ledger-mistake-picker">
                    {MISTAKE_DICTIONARY.map(m => {
                      const selected = (editingLog.mistakeTags || []).includes(m.id);
                      return (
                        <button
                          key={m.id}
                          type="button"
                          className={`ledger-mistake-btn ${selected ? 'selected' : ''}`}
                          onClick={() => {
                            setEditingLog(prev => {
                              const cur = prev.mistakeTags || [];
                              return {
                                ...prev,
                                mistakeTags: cur.includes(m.id) ? cur.filter(x => x !== m.id) : [...cur, m.id]
                              };
                            });
                          }}
                          title={m.desc}
                        >
                          {m.icon} {m.name}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="fld">
                  <label style={{ fontWeight: 600 }}>盘后复盘反思笔记</label>
                  <textarea
                    rows={3}
                    value={editingLog.reflection}
                    onChange={e => setEditingLog(prev => ({ ...prev, reflection: e.target.value }))}
                    placeholder="记录本笔买卖当时的心理活动、盘口观察与下次改进要点…"
                    className="ledger-textarea"
                  />
                </div>
              </div>
              <div className="modal-ft ledger-modal-ft">
                <button type="button" className="btn-cancel" onClick={() => setEditingLog(null)}>取消</button>
                <button type="submit" className="primary">保存复盘归因</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 🤖 双模复盘教练诊断弹窗（内置零延迟量化规则教练 + 天翼云大模型） */}
      {showCoachModal && (
        <div className="modal-mask" onClick={() => setShowCoachModal(false)}>
          <div className="modal-box ledger-modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: '800px' }}>
            <div className="modal-hd" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '20px' }}>🤖</span>
                <h3 style={{ margin: 0 }}>智策战情室 · 交易复盘教练</h3>
                <span style={{
                  fontSize: '11px',
                  padding: '2px 8px',
                  borderRadius: '4px',
                  background: hasAiKey ? '#eff6ff' : '#f0fdf4',
                  color: hasAiKey ? '#1d4ed8' : '#15803d',
                  border: `1px solid ${hasAiKey ? '#bfdbfe' : '#86efac'}`
                }}>
                  {hasAiKey ? `双引擎：${aiConfig.model} + 量化规则` : '⚡ 内置量化规则教练就绪'}
                </span>
              </div>
              <button className="modal-close" onClick={() => setShowCoachModal(false)}>×</button>
            </div>

            <div className="modal-bd" style={{ padding: '16px' }}>
              <div className="ledger-coach-inputs">
                <div>
                  <label style={{ fontSize: '11.5px', color: 'var(--mute)', display: 'block', marginBottom: '4px' }}>复盘日期</label>
                  <input
                    type="date"
                    value={coachDate}
                    onChange={e => setCoachDate(e.target.value)}
                    style={{ width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--line)' }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '11.5px', color: 'var(--mute)', display: 'block', marginBottom: '4px' }}>交易员整体心态备注（可选补充）</label>
                  <input
                    type="text"
                    value={coachNotes}
                    onChange={e => setCoachNotes(e.target.value)}
                    placeholder="如：早盘脉冲没忍住追了一笔，午后按均线做T挽回部分损耗..."
                    style={{ width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--line)' }}
                  />
                </div>
              </div>

              <div style={{ marginBottom: '14px' }}>
                <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '6px' }}>
                  📋 诊断标的范围：{coachDate} 共 {enrichedAllLogs.filter(l => l.date === coachDate).length} 笔流水
                </div>
                {!enrichedAllLogs.filter(l => l.date === coachDate).length ? (
                  <div style={{ fontSize: '12px', color: 'var(--warn)', padding: '8px', background: '#fffbe6', borderRadius: '4px' }}>
                    ⚠️ {coachDate} 暂无任何成交流水记录，请切换有交易的日期或先录入今日买卖记录！
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {enrichedAllLogs.filter(l => l.date === coachDate).map(t => (
                      <span key={t.id} style={{ fontSize: '11.5px', padding: '3px 8px', borderRadius: '4px', background: 'var(--surface)', border: '1px solid var(--line)' }}>
                        <b>{t.stock}</b> ({t.dir}): {t.net >= 0 ? '+' : ''}{f2(t.net)}元
                        {t.buyDevPct != null && <span style={{ color: 'var(--sub)', marginLeft: '4px' }}>[买偏 {t.buyDevPct >= 0 ? '+' : ''}{t.buyDevPct}%]</span>}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* 双模触发按钮 */}
              <div className="ledger-coach-btns">
                <button
                  type="button"
                  onClick={() => handleRunCoach('rule')}
                  disabled={coachLoading || !enrichedAllLogs.filter(l => l.date === coachDate).length}
                  style={{
                    padding: '9px 16px',
                    fontSize: '13px',
                    fontWeight: 700,
                    borderRadius: '7px',
                    background: '#0f766e',
                    border: 'none',
                    color: '#fff',
                    cursor: coachLoading ? 'not-allowed' : 'pointer'
                  }}
                >
                  ⚡ 秒级量化规则诊断（免Key）
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => handleRunCoach('auto')}
                  disabled={coachLoading || !enrichedAllLogs.filter(l => l.date === coachDate).length}
                  style={{
                    padding: '9px 18px',
                    fontSize: '13px',
                    fontWeight: 700,
                    borderRadius: '7px',
                    background: 'linear-gradient(135deg, #1d4ed8 0%, #7c3aed 100%)',
                    border: 'none',
                    color: '#fff',
                    cursor: coachLoading ? 'not-allowed' : 'pointer'
                  }}
                >
                  {coachLoading
                    ? '⏳ 正在深度切片复盘中…'
                    : hasAiKey
                    ? `🧠 启动大模型深度复盘 (${aiConfig.model})`
                    : '🚀 一键智能复盘（自动量化教练）'}
                </button>
              </div>

              {coachReviewResult && (
                <div style={{ marginTop: '16px', background: '#fdfdfe', border: '1px solid #bfdbfe', borderRadius: '8px', padding: '14px', lineHeight: 1.65 }}>
                  {coachReviewResult.fallbackReason && (
                    <div style={{ marginBottom: '10px', padding: '6px 10px', borderRadius: '6px', background: '#fffbeb', border: '1px solid #fcd34d', color: '#92400e', fontSize: '11.5px' }}>
                      ℹ️ {coachReviewResult.fallbackReason}
                    </div>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', borderBottom: '1px dashed #cbd5e1', paddingBottom: '8px', marginBottom: '12px' }}>
                    <div style={{ fontWeight: 800, fontSize: '14px', color: '#1e3a8a' }}>
                      📋 【交易教练操盘诊断报告】· {coachReviewResult.date}
                      <span style={{ fontSize: '11px', fontWeight: 600, color: '#64748b', marginLeft: '8px' }}>
                        引擎: {coachReviewResult.model}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => { copyPlain(coachReviewResult.review, '诊断书已复制到剪贴板！'); }}
                      style={{ padding: '4px 10px', fontSize: '11.5px' }}
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
          <div className="modal-box ledger-modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: '520px' }}>
            <div className="modal-hd">
              <h3>⚙️ AI 交易复盘教练大模型配置</h3>
              <button className="modal-close" onClick={() => setShowSettingsModal(false)}>×</button>
            </div>
            <div className="modal-bd" style={{ display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '12.5px' }}>
              <div style={{ background: '#f0f9ff', padding: '10px 12px', borderRadius: '6px', border: '1px solid #bae6fd', color: '#0369a1', lineHeight: 1.5 }}>
                💡 <b>双模说明</b>：不配置密钥时，系统默认启用<b>内置量化规则教练 v2</b>（毫秒级精准计算四维纪律分与点位偏离）；填入天翼云或任意 OpenAI 兼容 API Key 后，可解锁大模型自然语言深度心理剖析。
              </div>

              <div>
                <label style={{ fontWeight: 600, display: 'block', marginBottom: '4px' }}>大模型接口地址 (API URL)</label>
                <input
                  type="text"
                  value={aiConfig.apiUrl}
                  onChange={e => setAiConfig(prev => ({ ...prev, apiUrl: e.target.value }))}
                  placeholder="https://ai.ctaigw.cn/v1/chat/completions"
                  style={{ width: '100%', padding: '6px 10px', borderRadius: '5px', border: '1px solid var(--line)' }}
                />
              </div>

              <div>
                <label style={{ fontWeight: 600, display: 'block', marginBottom: '4px' }}>API 密钥 (API Key)</label>
                <input
                  type="password"
                  value={aiConfig.apiKey}
                  onChange={e => setAiConfig(prev => ({ ...prev, apiKey: e.target.value }))}
                  placeholder={aiConfig.configuredInEnv ? `已由 .env 环境变量注入 (${aiConfig.maskedEnvKey})` : '输入天翼云 / DeepSeek API Key（可选）'}
                  style={{ width: '100%', padding: '6px 10px', borderRadius: '5px', border: '1px solid var(--line)' }}
                />
              </div>

              <div>
                <label style={{ fontWeight: 600, display: 'block', marginBottom: '4px' }}>模型标识 (Model)</label>
                <input
                  type="text"
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

            <div className="modal-ft" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', padding: '10px 14px', borderTop: '1px solid var(--line)' }}>
              <button
                type="button"
                onClick={handleTestAi}
                disabled={testingAi}
                style={{ fontSize: '12px', padding: '5px 12px' }}
              >
                {testingAi ? '⏳ 测试连接中…' : '⚡ 测试连通性'}
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

      {/* ＋ 新增台账 Modal（新增自选池一键选股筹码 + SOP 价格/手数一键点填） */}
      {showAddModal && (
        <div className="modal-mask" onClick={() => setShowAddModal(false)}>
          <div className="modal-box ledger-modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: '580px' }}>
            <div className="modal-hd">
              <h3 style={{ margin: 0 }}>＋ 手工新增交易台账记录</h3>
              <button className="modal-close" onClick={() => setShowAddModal(false)}>×</button>
            </div>
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
              <div className="modal-bd ledger-add-bd">
                <div className="fld" style={{ gridColumn: '1 / -1' }}>
                  <label style={{ fontWeight: 700 }}>交易轨制定位</label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '4px' }}>
                    <button
                      type="button"
                      onClick={() => handleFormChange('track', 'long_t')}
                      style={{
                        padding: '8px 10px',
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
                        padding: '8px 10px',
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
                  <input type="text" value={form.stock} onChange={e => handleFormChange('stock', e.target.value)} placeholder="如：上海沿浦 (605128)" required />
                </div>

                {/* 单手快捷选股：从自选/持仓池一键填入，免去手机端切换括号与数字键盘 */}
                {pool.length > 0 && (
                  <div style={{ gridColumn: '1 / -1', marginTop: '-4px' }}>
                    <div className="qt-quick-chips" style={{ flexWrap: 'nowrap', overflowX: 'auto', paddingBottom: '2px' }}>
                      {pool.map(p => {
                        const label = `${p.name} (${p.code})`;
                        const isCur = form.stock === label;
                        return (
                          <button
                            key={p.code}
                            type="button"
                            className={`qt-chip ${isCur ? 'accent' : ''}`}
                            onClick={() => handleFormChange('stock', label)}
                          >
                            {p.shares > 0 ? '持·' : ''}{p.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {matchedSysBenchmark && (
                  <div style={{ gridColumn: '1 / -1', padding: '7px 10px', borderRadius: '6px', background: '#f0fdf4', border: '1px solid #86efac', color: '#15803d', fontSize: '11.5px', lineHeight: 1.45 }}>
                    🎯 <b>已匹配【{matchedSysBenchmark.source}】量化点位</b>：
                    买价 <b>¥{f2(matchedSysBenchmark.sysBuy)}</b> ｜ 止盈1 <b>¥{f2(matchedSysBenchmark.sysSell1)}</b> ｜ 止损 <b>¥{f2(matchedSysBenchmark.sysStop)}</b>
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
                        <option value="尾盘平仓">尾盘黑马隔夜平仓</option>
                        <option value="连板追涨">连板起爆打板</option>
                        <option value="龙头抄底">超跌龙头反弹低吸</option>
                        <option value="冲高止盈">短线冲高兑现落袋</option>
                        <option value="破位止损">纪律止损平仓</option>
                      </>
                    )}
                  </select>
                </div>
                <div className="fld">
                  <label>计划属性</label>
                  <select value={form.plan} onChange={e => handleFormChange('plan', e.target.value)}>
                    <option value="计划内">✅ 计划内（符合预案信号）</option>
                    <option value="计划外">⚠️ 计划外（盘中主观临时下单）</option>
                  </select>
                </div>
                <div className="fld">
                  <label>成交股数</label>
                  <input type="number" inputMode="numeric" step="100" value={form.qty} onChange={e => handleFormChange('qty', e.target.value)} required />
                  <div className="qt-quick-chips">
                    {[100, 300, 500, 1000].map(q => (
                      <button key={q} type="button" className="qt-chip" onClick={() => handleFormChange('qty', String(q))}>
                        {q}股
                      </button>
                    ))}
                  </div>
                </div>
                <div className="fld">
                  <label>决策依据</label>
                  <select value={form.basis} onChange={e => handleFormChange('basis', e.target.value)}>
                    <option value="客观信号">客观技术信号 (量价/分时均线)</option>
                    <option value="系统SOP">系统SOP推荐 (尾盘/打板/起爆)</option>
                    <option value="情绪模因/字辈共振">🎭 情绪模因/字辈共振</option>
                    <option value="主观判断">主观盘感 / 消息驱动</option>
                  </select>
                </div>
                <div className="fld">
                  <label>买入价 (元)</label>
                  <input type="number" inputMode="decimal" step="0.01" value={form.buy} onChange={e => handleFormChange('buy', e.target.value)} required />
                  {matchedSysBenchmark?.sysBuy > 0 && (
                    <div className="qt-quick-chips">
                      <button type="button" className="qt-chip buy" onClick={() => handleFormChange('buy', f2(matchedSysBenchmark.sysBuy))}>
                        SOP买 {f2(matchedSysBenchmark.sysBuy)}
                      </button>
                    </div>
                  )}
                </div>
                <div className="fld">
                  <label>卖出价 (元)</label>
                  <input type="number" inputMode="decimal" step="0.01" value={form.sell} onChange={e => handleFormChange('sell', e.target.value)} required />
                  {matchedSysBenchmark && (
                    <div className="qt-quick-chips">
                      {matchedSysBenchmark.sysSell1 > 0 && (
                        <button type="button" className="qt-chip sell" onClick={() => handleFormChange('sell', f2(matchedSysBenchmark.sysSell1))}>
                          止盈 {f2(matchedSysBenchmark.sysSell1)}
                        </button>
                      )}
                      {matchedSysBenchmark.sysStop > 0 && (
                        <button type="button" className="qt-chip" onClick={() => handleFormChange('sell', f2(matchedSysBenchmark.sysStop))}>
                          止损 {f2(matchedSysBenchmark.sysStop)}
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <div className="fld" style={{ gridColumn: '1 / -1' }}>
                  <label style={{ fontWeight: 600 }}>失误归因标签（可多选，未勾选项也会按盘口点位自动审计）</label>
                  <div className="ledger-mistake-picker">
                    {MISTAKE_DICTIONARY.map(m => {
                      const selected = form.mistakeTags.includes(m.id);
                      return (
                        <button
                          key={m.id}
                          type="button"
                          className={`ledger-mistake-btn ${selected ? 'selected' : ''}`}
                          onClick={() => toggleMistakeTag(m.id)}
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
                    placeholder="如：严格等缩量回踩第一买点挂单成交，冲高第一目标位果断止盈..."
                    className="ledger-textarea"
                  />
                </div>
              </div>
              <div className="modal-ft ledger-modal-ft">
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
