import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { f2, pct, money, money$, toastOk, toastErr, toastWarn, copyPlain } from '../services/utils.js';
import { fetchStockDiagnosis, searchTencent, postHerdAction, loadChart, loadStock, refreshSingleFastRt, isAShareTradingNow } from '../services/api.js';
import ChartCanvas from '../components/ChartCanvas.jsx';

const QUICK_PRESETS = [
  { code: '002085', name: '万丰奥威' },
  { code: '300059', name: '东方财富' },
  { code: '600519', name: '贵州茅台' },
  { code: '002594', name: '比亚迪' },
  { code: '601127', name: '赛力斯' },
];

function extractCodeFromInput(raw) {
  const s = String(raw || '').trim();
  const mExact = s.match(/^(?:sh|sz|bj)?(\d{6})$/i);
  if (mExact) return mExact[1];
  const mSuffix = s.match(/\((\d{6})\)$/);
  if (mSuffix) return mSuffix[1];
  return null;
}

function fmtPct(v, signed = false, digits = null) {
  if (v === null || v === undefined || v === '') return '—';
  const num = Number(v);
  if (!Number.isFinite(num)) return '—';
  const s = digits !== null ? num.toFixed(digits) : String(num);
  return signed && num >= 0 ? `+${s}%` : `${s}%`;
}

export default function DiagnosisPage({
  pool = [],
  tradeLogs = [],
  initialCode = '',
  onAddStockToPool,
  onSelectStockInPool,
  fastRefresh = true,
  onToggleFastRefresh,
}) {
  const defaultCode = initialCode || pool[0]?.code || '002085';
  const [activeCode, setActiveCode] = useState(defaultCode);
  const [inputText, setInputText] = useState(defaultCode);
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [annFilter, setAnnFilter] = useState('all'); // all | red | green
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggest, setShowSuggest] = useState(false);
  const [searching, setSearching] = useState(false);
  const [addingHerd, setAddingHerd] = useState(false);
  const [addedHerdCode, setAddedHerdCode] = useState('');
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const [diagChartStock, setDiagChartStock] = useState(null);
  const searchBoxRef = useRef(null);
  const suppressSuggestRef = useRef(false);

  const localLookup = useMemo(() => {
    const map = new Map();
    [...(pool || []), ...QUICK_PRESETS].forEach((s) => {
      const c = String(s.code || '').padStart(6, '0');
      if (/^\d{6}$/.test(c) && !map.has(c)) {
        map.set(c, { code: c, name: s.name || c, market: s.market || '' });
      }
    });
    return Array.from(map.values());
  }, [pool]);

  const matchLocal = useCallback((q) => {
    const k = String(q || '').trim().toLowerCase();
    if (!k) return [];
    return localLookup.filter(
      (s) => s.code.includes(k) || String(s.name || '').toLowerCase().includes(k)
    );
  }, [localLookup]);

  const runDiagnosis = useCallback(async (codeToRun, displayName = '') => {
    const c = extractCodeFromInput(codeToRun) || String(codeToRun || '').trim().replace(/^(sh|sz|bj)/i, '');
    if (!/^\d{6}$/.test(c)) {
      toastWarn('请输入有效的 6 位股票代码或股票名称（如 万丰奥威）');
      return;
    }
    setActiveCode(c);
    suppressSuggestRef.current = true;
    setInputText(displayName && displayName !== c ? `${displayName} (${c})` : c);
    setShowSuggest(false);
    setLoading(true);
    setErrorMsg('');
    try {
      const data = await fetchStockDiagnosis(c);
      if (data && data.ok) {
        setReport(data);
        const realName = data?.quote?.name || displayName;
        if (realName) {
          suppressSuggestRef.current = true;
          setInputText(`${realName} (${c})`);
        }
      } else {
        throw new Error(data?.message || '获取体检数据失败');
      }
    } catch (err) {
      setErrorMsg(err.message || '诊断服务暂时不可用，请确认后端已启动');
      toastErr('体检失败：' + err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const target = initialCode || pool[0]?.code || '002085';
    const localHit = localLookup.find((x) => x.code === String(target).padStart(6, '0'));
    runDiagnosis(target, localHit?.name || '');
  }, [initialCode]);

  // 点击外部关闭联想下拉框
  useEffect(() => {
    const onDocDown = (e) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target)) {
        setShowSuggest(false);
      }
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, []);

  // 输入股票代码/名称/拼音时防抖联想 A 股候选
  useEffect(() => {
    if (suppressSuggestRef.current) {
      suppressSuggestRef.current = false;
      return undefined;
    }
    const q = inputText.trim();
    if (!q || extractCodeFromInput(q)) {
      setSuggestions([]);
      setShowSuggest(false);
      setHighlightIdx(-1);
      return undefined;
    }
    const localHits = matchLocal(q).slice(0, 5);
    if (localHits.length > 0) {
      setSuggestions(localHits);
      setShowSuggest(true);
      setHighlightIdx(0);
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const remote = await searchTencent(q);
        if (cancelled) return;
        const merged = [];
        const seen = new Set();
        [...localHits, ...(remote || [])].forEach((item) => {
          const code = String(item.code || '').padStart(6, '0');
          if (/^\d{6}$/.test(code) && !seen.has(code)) {
            seen.add(code);
            merged.push({ code, name: item.name || code, market: item.market || '' });
          }
        });
        const topList = merged.slice(0, 8);
        setSuggestions(topList);
        setShowSuggest(topList.length > 0);
        setHighlightIdx(topList.length > 0 ? 0 : -1);
      } catch {
        if (!cancelled && localHits.length === 0) {
          setSuggestions([]);
          setShowSuggest(false);
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 260);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [inputText, matchLocal]);

  const handleSubmitSearch = useCallback(async () => {
    const q = inputText.trim();
    if (!q) {
      toastWarn('请输入 6 位股票代码、股票名称或拼音首字母');
      return;
    }
    const directCode = extractCodeFromInput(q);
    if (directCode) {
      const hit = localLookup.find((x) => x.code === directCode);
      await runDiagnosis(directCode, hit?.name || '');
      return;
    }
    const qLower = q.toLowerCase();
    const localHits = matchLocal(q);
    const localExact = localHits.find((x) => String(x.name || '').toLowerCase() === qLower);
    if (localExact) {
      await runDiagnosis(localExact.code, localExact.name);
      return;
    }
    setSearching(true);
    try {
      const remote = await searchTencent(q);
      const merged = [];
      const seen = new Set();
      [...localHits, ...(remote || [])].forEach((item) => {
        const code = String(item.code || '').padStart(6, '0');
        if (/^\d{6}$/.test(code) && !seen.has(code)) {
          seen.add(code);
          merged.push({ code, name: item.name || code, market: item.market || '' });
        }
      });
      if (merged.length === 0) {
        toastWarn(`未找到与「${q}」匹配的 A 股标的，请尝试输入完整股票名或 6 位代码`);
        return;
      }
      const exactMatch = merged.find((x) => String(x.name || '').toLowerCase() === qLower);
      if (exactMatch || merged.length === 1) {
        const picked = exactMatch || merged[0];
        await runDiagnosis(picked.code, picked.name);
        return;
      }
      setSuggestions(merged.slice(0, 8));
      setShowSuggest(true);
      setHighlightIdx(0);
      toastWarn(`匹配到 ${merged.length} 只相似标的，请在下拉框中点选确认`);
    } catch (err) {
      if (localHits.length === 1) {
        await runDiagnosis(localHits[0].code, localHits[0].name);
      } else {
        toastErr(`名称检索失败：${err?.message || '请直接输入6位股票代码'}`);
      }
    } finally {
      setSearching(false);
    }
  }, [inputText, localLookup, matchLocal, runDiagnosis]);

  const handlePresetClick = (code, name = '') => {
    const hit = name || localLookup.find((x) => x.code === code)?.name || '';
    runDiagnosis(code, hit);
  };

  const handleCopySummary = () => {
    if (!report || !report.wechatSummary) return;
    copyPlain(report.wechatSummary, '✓ 已复制完整体检报告！可直接粘贴至微信回复朋友');
  };

  const isInPool = report && pool.some(s => String(s.code).padStart(6, '0') === String(report.code).padStart(6, '0'));

  // 当诊断报告切换新标的时，构造交互式股票对象并加载分时+日K用于买卖点画图
  useEffect(() => {
    if (!report || !report.ok || !report.code) {
      setDiagChartStock(null);
      return undefined;
    }
    let cancelled = false;
    const code6 = String(report.code).padStart(6, '0');
    const poolMatch = (pool || []).find(s => String(s.code).padStart(6, '0') === code6);
    const rq = report.quote || {};
    const rChips = report.chips || {};
    const rIntra = report.intraday || {};
    const tcode = rq.tcode || ((code6.startsWith('6') || code6.startsWith('9')) ? `sh${code6}` : `sz${code6}`);
    const st = {
      code: code6,
      tcode,
      name: rq.name || poolMatch?.name || code6,
      prevClose: +rq.prevClose || poolMatch?.prevClose || 0,
      open: +rq.open || poolMatch?.open || 0,
      high: +rq.high || poolMatch?.high || 0,
      low: +rq.low || poolMatch?.low || 0,
      price: +rq.price || poolMatch?.price || 0,
      avg: +rIntra.vwap || poolMatch?.avg || +rq.price || 0,
      vr: +rq.vr || poolMatch?.vr || 1.0,
      ma5: +rChips.ma5 || poolMatch?.ma5 || 0,
      ma10: +rChips.ma10 || poolMatch?.ma10 || 0,
      ma20: +rChips.ma20 || poolMatch?.ma20 || 0,
      shares: poolMatch?.shares || 0,
      cost: poolMatch?.cost || 0,
      bePrice: poolMatch?.bePrice || 0,
      cap: poolMatch?.cap || 0,
      p: 'rt',
      ovRt: { cost: 1, be: 1, zones: 1, signal: 1, actual: 1, radar: 1 },
      _k: poolMatch?._k ? { ...poolMatch._k } : {},
      _ks: poolMatch?._ks || null,
    };
    setDiagChartStock(prev => (prev && prev.code === code6
      ? { ...st, p: prev.p || 'rt', ov: prev.ov || st.ov, ovRt: prev.ovRt || st.ovRt, _k: prev._k || st._k, _ks: prev._ks || st._ks }
      : st));

    Promise.allSettled([loadStock(st), loadChart(st, true)]).then(() => {
      if (!cancelled) {
        setDiagChartStock(prev => {
          const keepPeriod = (prev && prev.code === code6 && prev.p) ? prev.p : 'rt';
          return {
            ...st,
            p: keepPeriod,
            ov: prev?.ov,
            ovRt: (prev && prev.code === code6 && prev.ovRt) ? prev.ovRt : st.ovRt,
          };
        });
      }
    });
    return () => { cancelled = true; };
  }, [report?.code, report?.quote?.price]);

  // 持仓或成本变化时轻同步到诊断图（不清空用户已选周期）
  useEffect(() => {
    if (!report?.code) return;
    const code6 = String(report.code).padStart(6, '0');
    const poolMatch = (pool || []).find(s => String(s.code).padStart(6, '0') === code6);
    if (!poolMatch) return;
    setDiagChartStock(prev => {
      if (!prev || prev.code !== code6) return prev;
      if (prev.shares === (poolMatch.shares || 0) && prev.cost === (poolMatch.cost || 0)) return prev;
      return { ...prev, shares: poolMatch.shares || 0, cost: poolMatch.cost || 0, bePrice: poolMatch.bePrice || 0 };
    });
  }, [pool, report?.code]);

  const diagStockRef = useRef(diagChartStock);
  diagStockRef.current = diagChartStock;

  /* 诊断页分时图：开启 8 秒极速轮询时在交易时段增量刷新现价与分时 */
  useEffect(() => {
    if (!fastRefresh || !diagChartStock?.code || (diagChartStock.p || 'rt') !== 'rt') return undefined;
    let inFlight = false;
    const timer = setInterval(async () => {
      const target = diagStockRef.current;
      if (inFlight || !target || (target.p || 'rt') !== 'rt') return;
      if (!isAShareTradingNow()) return;
      inFlight = true;
      try {
        await refreshSingleFastRt(target);
        setDiagChartStock(prev => (prev && prev.code === target.code ? { ...target } : prev));
      } catch (_) {
        // 静默跳过单次极速超时
      } finally {
        inFlight = false;
      }
    }, 8000);
    return () => clearInterval(timer);
  }, [fastRefresh, diagChartStock?.code, diagChartStock?.p]);

  const q = report?.quote || {};
  const comp = report?.company || {};
  const chips = report?.chips || {};
  const sec = report?.sectorEcology || {};
  const wave = report?.secondWave || {};
  const intra = report?.intraday || {};
  const dec = report?.decision || null;
  const tech = report?.technicals || {};
  const mkt = report?.marketContext || {};
  const sts = report?.shortTermStatus || null;
  const isUp = q.chg >= 0;

  const handleQuickAddHerd = async () => {
    if (!report?.code) return;
    const c6 = String(report.code).padStart(6, '0');
    if (!(c6.startsWith('00') || c6.startsWith('60'))) {
      toastWarn('抱团跟踪池仅支持 00/60 主板股票');
      return;
    }
    try {
      setAddingHerd(true);
      await postHerdAction({
        action: 'add',
        code: c6,
        name: q.name || '',
        hybk: comp.industry || '',
        price: q.price || 0,
        reason: '全景诊断一键加入抱团跟踪',
      });
      setAddedHerdCode(c6);
      toastOk(`已将 ${q.name || c6} 加入抱团跟踪池`);
    } catch (err) {
      toastErr(err?.message || '加入抱团跟踪池失败');
    } finally {
      setAddingHerd(false);
    }
  };

  // 公告筛选
  const filteredAnnouncements = (report?.announcements || []).filter(a => {
    if (annFilter === 'red') return a.level === 'red';
    if (annFilter === 'green') return a.level === 'green';
    return true;
  });

  return (
    <div className="page-diagnosis" style={{ marginTop: '12px' }}>
      {/* 1. 顶部检索与快速切换栏 */}
      <section style={{ padding: '16px 20px', marginBottom: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '20px' }}>🩺</span>
            <div>
              <h2 style={{ fontSize: '16px', margin: 0, fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
                任意股票全景体检报告
                <span style={{ fontSize: '11.5px', fontWeight: 400, color: 'var(--mute)', background: 'var(--surface2)', padding: '2px 8px', borderRadius: '4px' }}>
                  二波预期 · 板块生态 · 分时VWAP · 排雷自救
                </span>
              </h2>
              <p style={{ margin: '3px 0 0', fontSize: '12.5px', color: 'var(--sub)' }}>
                临时看股、朋友问股、深套自救诊断 —— 深度透视板块二轮预期、日内分时黄白线、套牢盘筹码与做T处方
              </p>
            </div>
          </div>

          {/* 搜索框：支持6位代码 / 股票名 / 拼音首字母联想与回车自动解析 */}
          <div ref={searchBoxRef} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ position: 'relative' }}>
              <input
                type="text"
                placeholder="输入代码 / 股票名 / 拼音（如 日出东方）"
                value={inputText}
                onFocus={() => {
                  if (suggestions.length > 0 && !extractCodeFromInput(inputText)) {
                    setShowSuggest(true);
                  }
                }}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => {
                  if (showSuggest && suggestions.length > 0) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setHighlightIdx((i) => (i + 1) % suggestions.length);
                      return;
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setHighlightIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
                      return;
                    }
                    if (e.key === 'Escape') {
                      setShowSuggest(false);
                      return;
                    }
                    if (e.key === 'Enter' && highlightIdx >= 0 && suggestions[highlightIdx]) {
                      e.preventDefault();
                      const picked = suggestions[highlightIdx];
                      runDiagnosis(picked.code, picked.name);
                      return;
                    }
                  }
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleSubmitSearch();
                  }
                }}
                style={{
                  width: '250px',
                  padding: '7px 26px 7px 12px',
                  fontSize: '13px',
                  borderRadius: '6px',
                  border: '1px solid var(--line)',
                  outline: 'none',
                  background: 'var(--surface)'
                }}
              />
              {inputText && (
                <button
                  type="button"
                  title="清空"
                  onClick={() => {
                    suppressSuggestRef.current = true;
                    setInputText('');
                    setSuggestions([]);
                    setShowSuggest(false);
                  }}
                  style={{
                    position: 'absolute',
                    right: '6px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--mute)',
                    cursor: 'pointer',
                    fontSize: '13px',
                    padding: '0 3px',
                  }}
                >
                  ✕
                </button>
              )}

              {showSuggest && suggestions.length > 0 && (
                <div
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 4px)',
                    left: 0,
                    right: 0,
                    minWidth: '260px',
                    zIndex: 99,
                    background: 'var(--surface)',
                    border: '1px solid var(--line)',
                    borderRadius: '8px',
                    boxShadow: '0 8px 24px rgba(15, 23, 42, 0.14)',
                    overflow: 'hidden',
                  }}
                >
                  <div style={{ padding: '4px 10px', fontSize: '10.5px', color: 'var(--mute)', background: 'var(--surface2)', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between' }}>
                    <span>点击或 ↑↓ 选择 A 股标的</span>
                    {searching && <span>检索中…</span>}
                  </div>
                  {suggestions.map((cand, idx) => (
                    <button
                      key={cand.code}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        runDiagnosis(cand.code, cand.name);
                      }}
                      onMouseEnter={() => setHighlightIdx(idx)}
                      style={{
                        width: '100%',
                        border: 'none',
                        borderBottom: idx === suggestions.length - 1 ? 'none' : '1px solid var(--line)',
                        padding: '7px 10px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '8px',
                        fontSize: '12.5px',
                        cursor: 'pointer',
                        textAlign: 'left',
                        background: highlightIdx === idx ? '#eff6ff' : 'var(--surface)',
                        color: 'var(--text)',
                      }}
                    >
                      <span style={{ fontWeight: 700 }}>{cand.name}</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        {cand.market && (
                          <span style={{ fontSize: '10.5px', padding: '1px 5px', borderRadius: '4px', background: 'var(--surface2)', color: 'var(--sub)' }}>
                            {cand.market}
                          </span>
                        )}
                        <span style={{ fontFamily: 'ui-monospace, Consolas, monospace', color: 'var(--mute)', fontSize: '12px' }}>
                          {cand.code}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              onClick={handleSubmitSearch}
              disabled={loading || searching}
              style={{
                padding: '7px 16px',
                background: 'var(--info)',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                fontSize: '13px',
                fontWeight: 600,
                cursor: (loading || searching) ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}
            >
              {loading ? '🔍 正在体检…' : searching ? '🔎 匹配中…' : '🔍 立即体检'}
            </button>
          </div>
        </div>

        {/* 快速选择候选池 */}
        <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px dashed var(--line)', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '12px' }}>
          <span style={{ color: 'var(--mute)' }}>⚡ 快捷诊断:</span>
          {pool.length > 0 && pool.slice(0, 5).map(s => (
            <button
              key={s.code}
              onClick={() => handlePresetClick(s.code, s.name)}
              style={{
                padding: '2px 9px',
                borderRadius: '12px',
                border: '1px solid var(--line)',
                background: activeCode === s.code ? 'var(--info-bg)' : 'var(--surface)',
                color: activeCode === s.code ? 'var(--info)' : 'var(--text)',
                cursor: 'pointer',
                fontSize: '12px'
              }}
            >
              自选: {s.name} ({s.code})
            </button>
          ))}
          {QUICK_PRESETS.map(p => (
            <button
              key={p.code}
              onClick={() => handlePresetClick(p.code, p.name)}
              style={{
                padding: '2px 9px',
                borderRadius: '12px',
                border: '1px solid var(--line)',
                background: activeCode === p.code ? 'var(--surface2)' : 'var(--surface)',
                color: 'var(--sub)',
                cursor: 'pointer',
                fontSize: '12px'
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      </section>

      {/* 2. 诊断报告正文 */}
      {loading ? (
        <section style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--sub)' }}>
          <div style={{ fontSize: '32px', marginBottom: '12px' }}>⏳</div>
          <div style={{ fontSize: '15px', fontWeight: 600 }}>正在并发扫描公告、板块二波预期、分时VWAP与做T自救处方…</div>
          <div style={{ fontSize: '12px', color: 'var(--mute)', marginTop: '6px' }}>连接东方财富公告与板块热点 + 腾讯日K与分钟级别VWAP</div>
        </section>
      ) : errorMsg ? (
        <section style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--up)' }}>
          <div style={{ fontSize: '28px', marginBottom: '8px' }}>⚠️</div>
          <div style={{ fontWeight: 600 }}>诊断数据获取失败</div>
          <div style={{ fontSize: '12px', color: 'var(--sub)', marginTop: '4px' }}>{errorMsg}</div>
          <button
            onClick={() => runDiagnosis(activeCode)}
            style={{ marginTop: '14px', padding: '6px 14px', background: 'var(--surface2)', border: '1px solid var(--line)', borderRadius: '6px', cursor: 'pointer' }}
          >
            重试
          </button>
        </section>
      ) : report ? (
        <div>
          {/* A. 标的概览头部卡 */}
          <section style={{ padding: '16px 20px', marginBottom: '14px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '14px' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <h1 style={{ fontSize: '22px', fontWeight: 800, margin: 0 }}>{q.name}</h1>
                  <span style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '15px', color: 'var(--sub)' }}>
                    {report.code}
                  </span>
                  <span style={{ fontSize: '11px', padding: '2px 7px', borderRadius: '4px', background: 'var(--surface2)', color: 'var(--mute)' }}>
                    {comp.industry && !['-', '--', '—'].includes(comp.industry) ? comp.industry : '行业未归类'}
                  </span>
                  {isInPool ? (
                    <span style={{ fontSize: '11px', padding: '2px 7px', borderRadius: '4px', background: 'var(--accent-bg)', color: 'var(--accent)', fontWeight: 600 }}>
                      ✓ 已在做T池
                    </span>
                  ) : onAddStockToPool ? (
                    <button
                      onClick={() => onAddStockToPool(report.code)}
                      style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px', background: 'var(--surface2)', border: '1px solid var(--line)', cursor: 'pointer' }}
                    >
                      + 加入自选
                    </button>
                  ) : null}
                </div>
                <div style={{ marginTop: '8px', fontSize: '12.5px', color: 'var(--sub)', lineHeight: 1.6, maxWidth: '750px' }}>
                  <b>公司主营定位：</b>{comp.summary || '暂无主营介绍'}
                </div>
              </div>

              {/* 现价与关键指标 */}
              <div style={{ textAlign: 'right' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', justifyContent: 'flex-end' }}>
                  <span style={{ fontSize: '26px', fontWeight: 800, fontFamily: 'ui-monospace, Consolas, monospace', color: isUp ? 'var(--up)' : 'var(--down)' }}>
                    ¥{f2(q.price)}
                  </span>
                  <span style={{ fontSize: '15px', fontWeight: 700, fontFamily: 'ui-monospace, Consolas, monospace', color: isUp ? 'var(--up)' : 'var(--down)' }}>
                    {q.chg >= 0 ? `+${f2(q.chg)}%` : `${f2(q.chg)}%`}
                  </span>
                </div>
                <div style={{ fontSize: '12px', color: 'var(--sub)', marginTop: '4px', display: 'flex', gap: '10px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                  <span>换手: <b style={{ fontFamily: 'ui-monospace, monospace' }}>{f2(q.turnover)}%</b></span>
                  {q.vr > 0 && <span>量比: <b style={{ fontFamily: 'ui-monospace, monospace' }}>{f2(q.vr)}倍</b></span>}
                  {q.buyRatio > 0 && (
                    <span>外盘买比: <b style={{ fontFamily: 'ui-monospace, monospace', color: q.buyRatio >= 52 ? 'var(--up)' : 'var(--down)' }}>{q.buyRatio}%</b></span>
                  )}
                  <span>流通: <b style={{ fontFamily: 'ui-monospace, monospace' }}>{f2(q.cap)}亿</b></span>
                  <span>PE: <b style={{ fontFamily: 'ui-monospace, monospace' }}>{f2(q.pe)}</b></span>
                  <span>PB: <b style={{ fontFamily: 'ui-monospace, monospace' }}>{f2(q.pb)}</b></span>
                </div>
              </div>
            </div>

            {/* 顶栏公告雷达横幅 */}
            <div style={{
              marginTop: '14px',
              padding: '10px 14px',
              borderRadius: '8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              background: report.riskColor === 'red' ? 'var(--up-bg)' : report.riskColor === 'yellow' ? 'var(--warn-bg)' : 'var(--down-bg)',
              border: `1px solid ${report.riskColor === 'red' ? 'var(--up-b)' : report.riskColor === 'yellow' ? 'var(--warn-b)' : 'var(--down-b)'}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontSize: '16px' }}>
                  {report.riskColor === 'red' ? '🚨' : report.riskColor === 'yellow' ? '⚠️' : '🟢'}
                </span>
                <div>
                  <span style={{ fontWeight: 700, fontSize: '13px', color: report.riskColor === 'red' ? 'var(--up-d)' : report.riskColor === 'yellow' ? 'var(--warn-d)' : 'var(--down-d)' }}>
                    【公告排雷雷达】{report.riskLevel}
                  </span>
                  <span style={{ fontSize: '12px', marginLeft: '8px', color: 'var(--text)' }}>
                    {report.redFlags?.length > 0
                      ? `近30天检测到 ${report.redFlags.length} 条高危公告，存在潜在雷区，切忌逆势盲目补仓！`
                      : report.yellowAlerts?.length > 0
                      ? `近期存在 ${report.yellowAlerts.length} 条关注类公告（如质押/异动），需留意主力动态。`
                      : '近30天未排查到重大减持、立案调查、违规警示或退市风险，公告面雷达处于安全区。'}
                  </span>
                </div>
              </div>
              <button
                onClick={handleCopySummary}
                style={{
                  padding: '5px 12px',
                  borderRadius: '6px',
                  background: '#fff',
                  border: '1px solid var(--line)',
                  fontSize: '12px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px'
                }}
              >
                📋 复制微信结论
              </button>
            </div>
          </section>

          {/* A2. 🎯 多维综合诊股决策与买点评估中心（回答：能不能买、评分多少、风险如何、现在是不是买点） */}
          {dec && (
            <section
              style={{
                padding: '18px 20px',
                marginBottom: '14px',
                border: '1.5px solid',
                borderColor: dec.canBuyLevel === 'STRONG_BUY' ? '#86efac' : dec.canBuyLevel === 'BUY_DIP' ? '#7dd3fc' : dec.canBuyLevel === 'WAIT' ? '#fde68a' : '#fca5a5',
                background: 'linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)',
                boxShadow: '0 4px 16px rgba(0, 0, 0, 0.05)'
              }}
            >
              {/* 第一层：总分仪 + 能不能买结论 + 风险评级 + 当前大盘背景 */}
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1fr)', gap: '16px', alignItems: 'start' }}>
                {/* 左侧：核心结论与买入时机判定 */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap', marginBottom: '12px' }}>
                    {/* 综合评分徽章 */}
                    <div
                      style={{
                        width: '74px',
                        height: '74px',
                        borderRadius: '14px',
                        background: dec.totalScore >= 75 ? 'linear-gradient(135deg, #16a34a, #15803d)' : dec.totalScore >= 60 ? 'linear-gradient(135deg, #0284c7, #0369a1)' : dec.totalScore >= 45 ? 'linear-gradient(135deg, #d97706, #b45309)' : 'linear-gradient(135deg, #dc2626, #991b1b)',
                        color: '#fff',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        boxShadow: '0 4px 10px rgba(0,0,0,0.12)',
                        flexShrink: 0
                      }}
                    >
                      <span style={{ fontSize: '26px', fontWeight: 900, lineHeight: 1, fontFamily: 'monospace' }}>
                        {dec.totalScore}
                      </span>
                      <span style={{ fontSize: '10.5px', opacity: 0.9, marginTop: '3px' }}>综合评分/100</span>
                    </div>

                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <span
                          style={{
                            fontSize: '16px',
                            fontWeight: 800,
                            color: dec.canBuyLevel === 'STRONG_BUY' ? '#15803d' : dec.canBuyLevel === 'BUY_DIP' ? '#0369a1' : dec.canBuyLevel === 'WAIT' ? '#b45309' : '#cf1322'
                          }}
                        >
                          {dec.canBuyVerdict}
                        </span>
                        <span
                          style={{
                            fontSize: '11.5px',
                            fontWeight: 700,
                            padding: '2px 8px',
                            borderRadius: '4px',
                            background: dec.riskColor === 'red' ? '#fef2f2' : dec.riskColor === 'yellow' ? '#fffbeb' : '#f0fdf4',
                            color: dec.riskColor === 'red' ? '#dc2626' : dec.riskColor === 'yellow' ? '#d97706' : '#16a34a',
                            border: `1px solid ${dec.riskColor === 'red' ? '#fca5a5' : dec.riskColor === 'yellow' ? '#fde68a' : '#86efac'}`
                          }}
                        >
                          综合风险：{dec.riskRating}
                        </span>
                      </div>

                      {/* 关键技术 & 市场辅助标签 */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '6px', fontSize: '11.5px', color: 'var(--sub)' }}>
                        <span>📈 趋势: <b>{tech.trendStatus || '—'}</b></span>
                        <span>· 6日RSI: <b style={{ color: (tech.rsi6 ?? 50) >= 78 ? 'var(--up)' : (tech.rsi6 ?? 50) <= 25 ? 'var(--down)' : 'var(--text)' }}>{tech.rsi6 != null ? Number(tech.rsi6).toFixed(1) : '—'}</b></span>
                        <span>· 近5日: <b style={{ color: (tech.chg5d ?? 0) >= 0 ? 'var(--up)' : 'var(--down)' }}>{fmtPct(tech.chg5d, true)}</b></span>
                        {mkt.valveLabel && (
                          <span style={{ padding: '1px 6px', borderRadius: '4px', background: mkt.valveBg, color: mkt.valveColor, border: `1px solid ${mkt.valveBorder}`, fontWeight: 600 }}>
                            大盘环境：{mkt.valveLabel}{mkt.brokenRate != null ? ` (炸板${fmtPct(mkt.brokenRate)})` : ''}
                          </span>
                        )}
                      </div>
                      {dec.styleFit && (
                        <div
                          style={{
                            marginTop: '6px',
                            display: 'inline-block',
                            fontSize: '11.5px',
                            fontWeight: 600,
                            padding: '2px 8px',
                            borderRadius: '4px',
                            background: dec.styleFitLevel === 'narrow' ? '#f1f5f9' : dec.styleFitLevel === 'high_vol' ? '#fffbeb' : '#f0f9ff',
                            color: dec.styleFitLevel === 'narrow' ? '#475569' : dec.styleFitLevel === 'high_vol' ? '#b45309' : '#0369a1',
                            border: `1px solid ${dec.styleFitLevel === 'narrow' ? '#cbd5e1' : dec.styleFitLevel === 'high_vol' ? '#fde68a' : '#bae6fd'}`
                          }}
                        >
                          {dec.styleFit}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 现在是不是买点判定框 */}
                  <div
                    style={{
                      padding: '10px 14px',
                      borderRadius: '8px',
                      background: dec.isBuyPointNow ? '#f0fdf4' : '#fff7ed',
                      border: `1px solid ${dec.isBuyPointNow ? '#86efac' : '#fdba74'}`,
                      marginBottom: '12px'
                    }}
                  >
                    <div style={{ fontSize: '13.5px', fontWeight: 800, color: dec.isBuyPointNow ? '#15803d' : '#c2410c', marginBottom: '4px' }}>
                      ⏱️ 【时点判定】{dec.timingHeadline}
                    </div>
                    <div style={{ fontSize: '12.5px', color: '#334155', lineHeight: 1.55 }}>
                      {dec.timingAnalysis}
                    </div>
                  </div>

                  {/* 参考交易价格带 (Trade Plan) */}
                  {dec.tradePlan && (
                    <div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
                        <div style={{ padding: '8px 10px', background: '#f8fafc', borderRadius: '6px', border: '1px solid var(--line)' }}>
                          <div style={{ fontSize: '11px', color: 'var(--mute)' }}>建议仓位配比</div>
                          <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text)', marginTop: '2px' }}>
                            {dec.tradePlan.suggestedPosition}
                          </div>
                        </div>
                        <div style={{ padding: '8px 10px', background: '#f0fdf4', borderRadius: '6px', border: '1px solid #bbf7d0' }}>
                          <div style={{ fontSize: '11px', color: '#15803d' }}>理想低吸区间</div>
                          <div style={{ fontSize: '12.5px', fontWeight: 800, fontFamily: 'monospace', color: '#15803d', marginTop: '2px' }}>
                            ¥{f2(dec.tradePlan.idealBuyLow)}~¥{f2(dec.tradePlan.idealBuyHigh)}
                          </div>
                        </div>
                        <div style={{ padding: '8px 10px', background: '#fef2f2', borderRadius: '6px', border: '1px solid #fecaca' }}>
                          <div style={{ fontSize: '11px', color: '#dc2626' }}>破位防套止损线</div>
                          <div style={{ fontSize: '12.5px', fontWeight: 800, fontFamily: 'monospace', color: '#dc2626', marginTop: '2px' }}>
                            ¥{f2(dec.tradePlan.stopLossPrice)}
                          </div>
                        </div>
                        <div style={{ padding: '8px 10px', background: '#eff6ff', borderRadius: '6px', border: '1px solid #bfdbfe' }}>
                          <div style={{ fontSize: '11px', color: '#1d4ed8' }}>上方压力/目标位</div>
                          <div style={{ fontSize: '12.5px', fontWeight: 800, fontFamily: 'monospace', color: '#1d4ed8', marginTop: '2px' }}>
                            ¥{f2(dec.tradePlan.targetPrice1)}
                          </div>
                        </div>
                      </div>
                      {dec.tradePlan.calibrationNote && (
                        <div style={{ marginTop: '6px', fontSize: '11px', color: 'var(--mute)' }}>
                          📏 {dec.tradePlan.calibrationNote}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* 右侧：5 维量化评分拆解条 */}
                <div style={{ padding: '12px 14px', background: '#fff', borderRadius: '8px', border: '1px solid var(--line)' }}>
                  <div style={{ fontSize: '13px', fontWeight: 700, marginBottom: '10px', color: 'var(--text)', display: 'flex', justifyContent: 'space-between' }}>
                    <span>📊 五维量化得分拆解</span>
                    <span style={{ fontSize: '11.5px', fontWeight: 400, color: 'var(--mute)' }}>总分 {dec.totalScore}/100</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {(dec.scoreBreakdown || []).map((item, idx) => {
                      const ratio = item.max > 0 ? (item.score / item.max) * 100 : 0;
                      const barCol = ratio >= 75 ? '#16a34a' : ratio >= 55 ? '#0284c7' : ratio >= 40 ? '#d97706' : '#dc2626';
                      return (
                        <div key={idx}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11.5px', marginBottom: '3px' }}>
                            <span style={{ fontWeight: 600, color: 'var(--text)' }}>{item.name}</span>
                            <span>
                              <b style={{ fontFamily: 'monospace', color: barCol }}>{item.score}</b>
                              <span style={{ color: 'var(--mute)', fontSize: '11px' }}>/{item.max} · {item.desc}</span>
                            </span>
                          </div>
                          <div style={{ height: '6px', background: '#f1f5f9', borderRadius: '3px', overflow: 'hidden' }}>
                            <div style={{ width: `${ratio}%`, height: '100%', background: barCol, borderRadius: '3px', transition: 'width 0.4s ease' }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* 第二层：支撑买入依据 vs 风险隐患提示 双栏明细 */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '14px', paddingTop: '12px', borderTop: '1px dashed var(--line)' }}>
                <div style={{ padding: '10px 12px', background: '#f0fdf4', borderRadius: '6px', border: '1px solid #dcfce7' }}>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: '#15803d', marginBottom: '6px' }}>
                    ✅ 积极加分与买入依据 ({dec.positivePoints?.length || 0})
                  </div>
                  {dec.positivePoints && dec.positivePoints.length > 0 ? (
                    <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '12px', color: '#166534', lineHeight: 1.6 }}>
                      {dec.positivePoints.map((pt, idx) => <li key={idx}>{pt}</li>)}
                    </ul>
                  ) : (
                    <div style={{ fontSize: '12px', color: 'var(--mute)' }}>暂无明显突出多头优势依据</div>
                  )}
                </div>

                <div style={{ padding: '10px 12px', background: '#fef2f2', borderRadius: '6px', border: '1px solid #fee2e2' }}>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: '#cf1322', marginBottom: '6px' }}>
                    ⚠️ 核心隐患与风险排查 ({dec.riskPoints?.length || 0})
                  </div>
                  {dec.riskPoints && dec.riskPoints.length > 0 ? (
                    <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '12px', color: '#991b1b', lineHeight: 1.6 }}>
                      {dec.riskPoints.map((pt, idx) => <li key={idx}>{pt}</li>)}
                    </ul>
                  ) : (
                    <div style={{ fontSize: '12px', color: '#166534' }}>当前多维度排查暂无显著硬伤风险</div>
                  )}
                </div>
              </div>
            </section>
          )}

          {/* ⚡ 今日短线身位与连板/抱团/字辈联动雷达 */}
          {sts && (
            <section style={{
              padding: '14px 18px',
              marginBottom: '14px',
              background: sts.isBrokenBoard ? '#fffafa' : 'linear-gradient(135deg, #f8fafc 0%, #f5f3ff 100%)',
              border: sts.isBrokenBoard ? '1.5px solid #ffa39e' : '1.5px solid #c4b5fd',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '15px', fontWeight: 800, color: '#4c1d95' }}>
                    ⚡ 今日短线身位与连板 / 抱团雷达
                  </span>
                  {sts.statTag && (
                    <span style={{ fontSize: '11.5px', fontWeight: 800, padding: '2px 8px', borderRadius: '4px', background: sts.isLimitUp ? '#cf1322' : '#475569', color: '#fff' }}>
                      {sts.statTag}
                    </span>
                  )}
                  {sts.isBrokenBoard && (
                    <span style={{ fontSize: '11.5px', fontWeight: 800, padding: '2px 8px', borderRadius: '4px', background: '#fff1f0', color: '#cf1322', border: '1px solid #ffa39e' }}>
                      💥 曾涨停炸板 (回落 {sts.dropFromTop != null ? `${Number(sts.dropFromTop).toFixed(1)}%` : '—'} · 炸{sts.zbc}次)
                    </span>
                  )}
                  {sts.isRushing && (
                    <span style={{ fontSize: '11.5px', fontWeight: 800, padding: '2px 8px', borderRadius: '4px', background: '#e0f2fe', color: '#0284c7', border: '1px solid #38bdf8' }}>
                      ⚡ 冲板临界中 (距涨停 {sts.distCeiling != null ? `${Number(sts.distCeiling).toFixed(1)}%` : '—'})
                    </span>
                  )}
                  {sts.inHerdPool && (
                    <span style={{ fontSize: '11.5px', fontWeight: 800, padding: '2px 8px', borderRadius: '4px', background: '#f5f3ff', color: '#6d28d9', border: '1px solid #c4b5fd' }}>
                      {sts.herdLabel || '🤝 自动抱团跟踪中'}
                    </span>
                  )}
                  {sts.isMysticResonant && sts.mysticCluster && (
                    <span style={{ fontSize: '11.5px', fontWeight: 800, padding: '2px 8px', borderRadius: '4px', background: '#faf5ff', color: '#7c3aed', border: '1px solid #d8b4fe' }}>
                      🔮 {sts.mysticCluster} ({sts.mysticZtCount}板共振)
                    </span>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {sts.inHerdPool || addedHerdCode === String(report.code).padStart(6, '0') ? (
                    <a href="#/board" style={{ fontSize: '11.5px', fontWeight: 700, color: '#6d28d9', textDecoration: 'none', padding: '3px 8px', borderRadius: '5px', background: '#f5f3ff', border: '1px solid #c4b5fd' }}>
                      ✓ 已在抱团池 · 去看板查看 →
                    </a>
                  ) : (String(report.code).startsWith('00') || String(report.code).startsWith('60')) && (
                    <button
                      type="button"
                      className="mini"
                      disabled={addingHerd}
                      onClick={handleQuickAddHerd}
                      style={{ fontSize: '11.5px', color: '#6d28d9', borderColor: '#c4b5fd', background: '#fff', fontWeight: 700 }}
                    >
                      {addingHerd ? '加入中…' : '📌 加入抱团跟踪池'}
                    </button>
                  )}
                </div>
              </div>

              {sts.tags && sts.tags.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap', marginBottom: '10px' }}>
                  {sts.tags.map((tg, idx) => (
                    <span
                      key={`${tg.key}_${idx}`}
                      style={{
                        fontSize: '11px',
                        fontWeight: 700,
                        padding: '1px 7px',
                        borderRadius: '4px',
                        background: tg.bg || '#f1f5f9',
                        color: tg.color || '#334155',
                        border: `1px solid ${tg.border || '#cbd5e1'}`,
                      }}
                    >
                      {tg.label}
                    </span>
                  ))}
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px', marginBottom: '8px' }}>
                {sts.identityScore != null && (
                  <div style={{ padding: '8px 12px', borderRadius: '8px', background: '#eff6ff', border: '1px solid #bfdbfe' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                      <span style={{ fontSize: '12px', fontWeight: 800, color: '#1d4ed8' }}>👑 身份分（市场地位）</span>
                      <span style={{ fontSize: '17px', fontWeight: 900, fontFamily: 'monospace', color: '#1d4ed8' }}>{sts.identityScore}</span>
                    </div>
                    <div style={{ fontSize: '11px', color: '#1e40af' }}>
                      连板{sts.scoreDims?.identity?.height ?? 0} · 记忆{sts.scoreDims?.identity?.memory ?? 0} · 板块{sts.scoreDims?.identity?.sector ?? 0} · 人气{sts.scoreDims?.identity?.popularity ?? 0}
                    </div>
                  </div>
                )}
                {sts.relayScore != null && (
                  <div style={{ padding: '8px 12px', borderRadius: '8px', background: '#fff1f2', border: '1px solid #fecdd3' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                      <span style={{ fontSize: '12px', fontWeight: 800, color: '#be123c' }}>⚡ 接力分（次日赔率）</span>
                      <span style={{ fontSize: '17px', fontWeight: 900, fontFamily: 'monospace', color: '#be123c' }}>{sts.relayScore}</span>
                    </div>
                    <div style={{ fontSize: '11px', color: '#9f1239' }}>
                      首封{sts.scoreDims?.relay?.firstSeal ?? 0} · 封质{sts.scoreDims?.relay?.sealQuality ?? 0} · 换手{sts.scoreDims?.relay?.tradability ?? 0} · 周期{sts.scoreDims?.relay?.cycle ?? 0} · 强度{sts.scoreDims?.relay?.strength ?? 0}
                    </div>
                  </div>
                )}
                <div style={{ padding: '8px 12px', borderRadius: '8px', background: '#fff', border: '1px solid var(--line)', fontSize: '12px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '3px' }}>
                  {sts.isLimitUp ? (
                    <>
                      <div>首封 <b>{sts.fbt || '—'}</b> · 买一封单 <b>{sts.fund >= 1e6 ? money$(sts.fund) : '弱封'}</b></div>
                      <div style={{ fontSize: '11px', color: 'var(--sub)' }}>{sts.buyTag || `封成比 ${Number(sts.sealRatio || 0).toFixed(2)}x`}</div>
                    </>
                  ) : (
                    <>
                      <div>MA5偏离 <b>{fmtPct(sts.vsMa5, true)}</b> · 峰值回撤 <b>{fmtPct(sts.ddFromPeak)}</b></div>
                      <div style={{ fontSize: '11px', color: 'var(--sub)' }}>
                        {sts.cumReturnPct != null ? `入池累计收益 ${fmtPct(sts.cumReturnPct, true)}` : (sts.buyTag || '活跃跟踪状态')}
                      </div>
                    </>
                  )}
                </div>
              </div>

              {(sts.cycleAdvice || sts.buyAction || sts.herdDesc) && (
                <div style={{ fontSize: '12px', padding: '7px 10px', borderRadius: '6px', background: '#fff', border: '1px dashed #c4b5fd', color: '#334155', lineHeight: 1.55 }}>
                  🧭 <b>短线窗口应对：</b>{sts.cycleAdvice || sts.buyAction || sts.herdDesc}
                </div>
              )}
            </section>
          )}

          {/* A4. 📈 分时图买卖点 & 多周期K线交互看盘 */}
          {diagChartStock && (
            <section style={{ padding: '14px 16px', marginBottom: '14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
                <h3 style={{ fontSize: '14px', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span>📈</span> {diagChartStock.name} ({diagChartStock.code}) · 分时推荐买卖点与实盘标注看盘
                </h3>
                <span style={{ fontSize: '11px', color: 'var(--mute)' }}>
                  默认展示「分时」：已叠加推荐买/卖区带、ATR+DNA动态推荐买卖点、以及当日台账实盘成交标注
                </span>
              </div>
              <ChartCanvas
                stock={diagChartStock}
                poolIndex={99}
                tradeLogs={tradeLogs}
                onUpdateStock={(updated) => setDiagChartStock({ ...updated })}
                fastRefresh={fastRefresh}
                onToggleFastRefresh={onToggleFastRefresh}
              />
            </section>
          )}

          {/* B. 两列主网格：左侧板块/二波/分时/筹码，右侧排雷公告雷达 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.15fr) minmax(0, 0.85fr)', gap: '14px', marginBottom: '14px' }}>
            {/* 左列：板块生态 + 二波预期 + 分时VWAP + 筹码处方 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              
              {/* 1. 板块身位与今日生态 */}
              <section style={{ padding: '16px 18px', margin: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                  <h3 style={{ fontSize: '14px', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span>🌊</span> 板块生态与身位层级
                  </h3>
                  {sec.sectorName && !['-', '--', '—'].includes(sec.sectorName) && (
                    <span style={{ fontSize: '11.5px', color: 'var(--sub)' }}>
                      主线归属: <b>{sec.sectorName}</b> ({fmtPct(sec.sectorChg, true, 2)})
                    </span>
                  )}
                </div>

                {/* 板块身位卡 */}
                <div style={{
                  padding: '10px 12px',
                  borderRadius: '6px',
                  background: 'var(--surface)',
                  border: '1px solid var(--line)',
                  marginBottom: '10px',
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: '10px',
                  textAlign: 'center'
                }}>
                  <div>
                    <div style={{ fontSize: '11px', color: 'var(--mute)' }}>板块今日生态</div>
                    <div style={{ fontSize: '13px', fontWeight: 700, color: (sec.sectorChg ?? 0) >= 0 ? 'var(--up)' : 'var(--down)', marginTop: '2px' }}>
                      {fmtPct(sec.sectorChg, true, 2)}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--sub)' }}>
                      {sec.upCount ? `${sec.upCount}涨 / ${sec.downCount}跌 (${sec.breadth})` : '非主线板块'}
                    </div>
                  </div>

                  <div>
                    <div style={{ fontSize: '11px', color: 'var(--mute)' }}>个股身位定位</div>
                    <div style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--text)', marginTop: '2px' }}>
                      {sec.role || '普通标的'}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--sub)' }}>
                      相对弹性: {fmtPct(sec.relativeElasticity, true)}
                    </div>
                  </div>

                  <div>
                    <div style={{ fontSize: '11px', color: 'var(--mute)' }}>板块领涨龙头</div>
                    <div style={{ fontSize: '13px', fontWeight: 700, fontFamily: 'monospace', color: 'var(--info)', marginTop: '2px' }}>
                      {sec.leader || '—'}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--sub)' }}>
                      {sec.sectorRank ? `行业排名前 ${sec.sectorRank} 位` : '无排名'}
                    </div>
                  </div>
                </div>

                <div style={{ fontSize: '12px', color: 'var(--sub)', marginBottom: '8px' }}>
                  <b>核心概念题材 ({report.concepts?.length || 0}):</b>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {(report.concepts || []).map((c, i) => {
                    const isHot = (report.matchedHotThemes || []).some(m => m.name === c);
                    return (
                      <span
                        key={i}
                        style={{
                          fontSize: '12px',
                          padding: '3px 8px',
                          borderRadius: '4px',
                          background: isHot ? 'var(--up-bg)' : 'var(--surface2)',
                          color: isHot ? 'var(--up-d)' : 'var(--text)',
                          border: `1px solid ${isHot ? 'var(--up-b)' : 'var(--line)'}`,
                          fontWeight: isHot ? 700 : 400
                        }}
                      >
                        {isHot ? '🔥 ' : ''}{c}
                      </span>
                    );
                  })}
                </div>
              </section>

              {/* 2. 板块二轮 / 二波潜力预期时钟 */}
              <section style={{ padding: '16px 18px', margin: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                  <h3 style={{ fontSize: '14px', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span>🔄</span> 板块二轮 / 二波预期时钟
                  </h3>
                  <span style={{
                    fontSize: '11.5px',
                    fontWeight: 700,
                    padding: '2px 8px',
                    borderRadius: '4px',
                    background: wave.stageTag === 'golden_second' ? 'var(--down-bg)' : wave.stageTag === 'dead' ? 'var(--up-bg)' : 'var(--surface2)',
                    color: wave.stageTag === 'golden_second' ? 'var(--down-d)' : wave.stageTag === 'dead' ? 'var(--up-d)' : 'var(--sub)',
                    border: `1px solid ${wave.stageTag === 'golden_second' ? 'var(--down-b)' : wave.stageTag === 'dead' ? 'var(--up-b)' : 'var(--line)'}`
                  }}>
                    二波潜力: {wave.secondWavePotential || '普通'}
                  </span>
                </div>

                {wave.stage ? (
                  <div>
                    {/* 二波四项指标 */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', textAlign: 'center', marginBottom: '10px' }}>
                      <div style={{ padding: '6px', background: 'var(--surface)', borderRadius: '6px', border: '1px solid var(--line)' }}>
                        <div style={{ fontSize: '11px', color: 'var(--mute)' }}>首轮最大波幅</div>
                        <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--up)' }}>{fmtPct(wave.wave1Amplitude, true)}</div>
                      </div>
                      <div style={{ padding: '6px', background: 'var(--surface)', borderRadius: '6px', border: '1px solid var(--line)' }}>
                        <div style={{ fontSize: '11px', color: 'var(--mute)' }}>高位最高价</div>
                        <div style={{ fontSize: '13px', fontWeight: 700, fontFamily: 'monospace' }}>¥{f2(wave.maxHigh)}</div>
                      </div>
                      <div style={{ padding: '6px', background: 'var(--surface)', borderRadius: '6px', border: '1px solid var(--line)' }}>
                        <div style={{ fontSize: '11px', color: 'var(--mute)' }}>高位回撤深度</div>
                        <div style={{ fontSize: '13px', fontWeight: 700, color: (wave.drawdown ?? 0) < -28 ? 'var(--up)' : 'var(--sub)' }}>
                          {fmtPct(wave.drawdown)}
                        </div>
                      </div>
                      <div style={{ padding: '6px', background: 'var(--surface)', borderRadius: '6px', border: '1px solid var(--line)' }}>
                        <div style={{ fontSize: '11px', color: 'var(--mute)' }}>量能萎缩沉淀</div>
                        <div style={{ fontSize: '13px', fontWeight: 700, color: (wave.volShrink ?? 100) <= 50 ? 'var(--down)' : 'var(--sub)' }}>
                          {fmtPct(wave.volShrink)}
                        </div>
                      </div>
                    </div>

                    <div style={{
                      padding: '8px 12px',
                      borderRadius: '6px',
                      background: wave.stageTag === 'golden_second' ? 'var(--down-bg)' : 'var(--surface)',
                      border: `1px solid ${wave.stageTag === 'golden_second' ? 'var(--down-b)' : 'var(--line)'}`,
                      fontSize: '12.5px',
                      lineHeight: 1.6
                    }}>
                      <b>当前生命周期：</b><span style={{ fontWeight: 700 }}>{wave.stage}</span>
                      <div style={{ color: 'var(--sub)', marginTop: '3px' }}>{wave.desc}</div>
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: '12px', color: 'var(--mute)' }}>暂无二波统计数据</div>
                )}
              </section>

              {/* 3. 全天分时态势与 VWAP 均价线 */}
              <section style={{ padding: '16px 18px', margin: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                  <h3 style={{ fontSize: '14px', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span>📈</span> 全天分时态势与 VWAP 均价线
                  </h3>
                  <span style={{ fontSize: '11.5px', color: 'var(--sub)' }}>
                    日内振幅: <b style={{ color: (intra.amp ?? 99) < 2.0 ? 'var(--warn)' : 'var(--text)' }}>{fmtPct(intra.amp, false, 2)}</b>
                    {intra.amp != null && intra.amp < 2.0 && <span style={{ color: 'var(--warn)', marginLeft: '4px' }}>(振幅过窄)</span>}
                  </span>
                </div>

                {intra.vwap ? (
                  <div>
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(3, 1fr)',
                      gap: '8px',
                      textAlign: 'center',
                      marginBottom: '10px'
                    }}>
                      <div style={{ padding: '6px', background: 'var(--surface)', borderRadius: '6px', border: '1px solid var(--line)' }}>
                        <div style={{ fontSize: '11px', color: 'var(--mute)' }}>分时VWAP均价</div>
                        <div style={{ fontSize: '13px', fontWeight: 700, fontFamily: 'monospace' }}>¥{f2(intra.vwap)}</div>
                        <div style={{ fontSize: '11px', color: (intra.vwapDiff ?? 0) >= 0 ? 'var(--up)' : 'var(--down)' }}>
                          现价偏离: {fmtPct(intra.vwapDiff, true)}
                        </div>
                      </div>

                      <div style={{ padding: '6px', background: 'var(--surface)', borderRadius: '6px', border: '1px solid var(--line)' }}>
                        <div style={{ fontSize: '11px', color: 'var(--mute)' }}>站上均价线时间</div>
                        <div style={{ fontSize: '13px', fontWeight: 700, color: (intra.aboveRatio ?? 50) >= 60 ? 'var(--up)' : (intra.aboveRatio ?? 50) <= 30 ? 'var(--down)' : 'var(--sub)' }}>
                          {fmtPct(intra.aboveRatio)}
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--sub)' }}>
                          {(intra.aboveRatio ?? 50) >= 60 ? '多头全天控盘' : (intra.aboveRatio ?? 50) <= 30 ? '空头全程压制' : '中性多空拉锯'}
                        </div>
                      </div>

                      <div style={{ padding: '6px', background: 'var(--surface)', borderRadius: '6px', border: '1px solid var(--line)' }}>
                        <div style={{ fontSize: '11px', color: 'var(--mute)' }}>日内高低极值</div>
                        <div style={{ fontSize: '13px', fontWeight: 700, fontFamily: 'monospace' }}>¥{f2(intra.lowPrice)} ~ ¥{f2(intra.highPrice)}</div>
                        <div style={{ fontSize: '11px', color: 'var(--sub)' }}>日内区间波幅</div>
                      </div>
                    </div>

                    {/* 分时进度条 */}
                    <div style={{ marginBottom: '10px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11.5px', marginBottom: '3px', color: 'var(--sub)' }}>
                        <span>均价线上方占比: {fmtPct(intra.aboveRatio)}</span>
                        <span>均价线下方占比: {intra.aboveRatio != null ? `${(100 - intra.aboveRatio).toFixed(1)}%` : '—'}</span>
                      </div>
                      <div style={{ height: '6px', background: 'var(--down-bg)', borderRadius: '3px', overflow: 'hidden', display: 'flex' }}>
                        <div style={{ width: `${intra.aboveRatio ?? 50}%`, background: 'var(--up)', height: '100%' }} />
                        <div style={{ width: `${100 - (intra.aboveRatio ?? 50)}%`, background: 'var(--down)', height: '100%' }} />
                      </div>
                    </div>

                    <div style={{
                      padding: '8px 12px',
                      borderRadius: '6px',
                      background: intra.patternType === 'dump' ? 'var(--warn-bg)' : intra.patternType === 'bull' ? 'var(--up-bg)' : 'var(--surface)',
                      border: `1px solid ${intra.patternType === 'dump' ? 'var(--warn-b)' : intra.patternType === 'bull' ? 'var(--up-b)' : 'var(--line)'}`,
                      fontSize: '12.5px'
                    }}>
                      <b>日内形态归属：</b><span style={{ fontWeight: 700 }}>{intra.pattern}</span>
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: '12px', color: 'var(--mute)' }}>分时数据暂不可用</div>
                )}
              </section>

              {/* 4. 技术结构与筹码套牢盘诊断 */}
              <section style={{ padding: '16px 18px', margin: 0 }}>
                <h3 style={{ fontSize: '14px', fontWeight: 700, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span>🎯</span> 筹码结构与技术位透视
                </h3>

                {chips && chips.ma5 > 0 ? (
                  <div>
                    {/* 均线矩阵 */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', textAlign: 'center', marginBottom: '12px' }}>
                      <div style={{ padding: '6px', background: 'var(--surface)', borderRadius: '6px', border: '1px solid var(--line)' }}>
                        <div style={{ fontSize: '11px', color: 'var(--mute)' }}>MA5 均线</div>
                        <div style={{ fontSize: '13px', fontWeight: 700, fontFamily: 'monospace' }}>¥{f2(chips.ma5)}</div>
                      </div>
                      <div style={{ padding: '6px', background: 'var(--surface)', borderRadius: '6px', border: '1px solid var(--line)' }}>
                        <div style={{ fontSize: '11px', color: 'var(--mute)' }}>MA10 均线</div>
                        <div style={{ fontSize: '13px', fontWeight: 700, fontFamily: 'monospace' }}>¥{f2(chips.ma10)}</div>
                      </div>
                      <div style={{ padding: '6px', background: 'var(--surface)', borderRadius: '6px', border: '1px solid var(--line)' }}>
                        <div style={{ fontSize: '11px', color: 'var(--mute)' }}>MA20 均线</div>
                        <div style={{ fontSize: '13px', fontWeight: 700, fontFamily: 'monospace' }}>¥{f2(chips.ma20)}</div>
                      </div>
                      <div style={{ padding: '6px', background: 'var(--surface)', borderRadius: '6px', border: '1px solid var(--line)' }}>
                        <div style={{ fontSize: '11px', color: 'var(--mute)' }}>MA60 均线</div>
                        <div style={{ fontSize: '13px', fontWeight: 700, fontFamily: 'monospace' }}>¥{f2(chips.ma60)}</div>
                      </div>
                    </div>

                    {/* 20日箱体条 */}
                    <div style={{ marginBottom: '12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '4px' }}>
                        <span>20日箱体结构: <b>¥{f2(chips.boxBot)} ~ ¥{f2(chips.boxTop)}</b></span>
                        <span style={{ color: (chips.boxPos ?? 50) >= 75 ? 'var(--warn)' : (chips.boxPos ?? 50) <= 25 ? 'var(--down)' : 'var(--mute)' }}>
                          当前处于箱内 <b>{fmtPct(chips.boxPos)}</b>
                        </span>
                      </div>
                      <div style={{ height: '7px', background: 'var(--surface2)', borderRadius: '4px', position: 'relative', overflow: 'hidden' }}>
                        <div
                          style={{
                            height: '100%',
                            width: `${Math.max(0, Math.min(100, chips.boxPos ?? 50))}%`,
                            background: (chips.boxPos ?? 50) >= 75 ? 'var(--warn)' : (chips.boxPos ?? 50) <= 25 ? 'var(--down)' : 'var(--info)',
                            borderRadius: '4px'
                          }}
                        />
                      </div>
                    </div>

                    {/* 筹码成本与获利盘 */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', fontSize: '12.5px', padding: '10px', background: 'var(--surface)', borderRadius: '6px', border: '1px solid var(--line)' }}>
                      <div>
                        <div style={{ color: 'var(--mute)', fontSize: '11.5px' }}>近60日筹码均价:</div>
                        <div style={{ fontWeight: 700, fontSize: '15px', fontFamily: 'monospace' }}>
                          ¥{f2(chips.avgCost)}
                        </div>
                        <div style={{ fontSize: '11px', color: (chips.diffFromCost ?? 0) >= 0 ? 'var(--up)' : 'var(--down)' }}>
                          现价距均价: {fmtPct(chips.diffFromCost, true)}
                        </div>
                      </div>
                      <div>
                        <div style={{ color: 'var(--mute)', fontSize: '11.5px' }}>当前获利筹码估算:</div>
                        <div style={{ fontWeight: 700, fontSize: '15px', fontFamily: 'monospace', color: (chips.profitRatio ?? 50) <= 20 ? 'var(--down)' : (chips.profitRatio ?? 50) >= 80 ? 'var(--up)' : 'var(--text)' }}>
                          {fmtPct(chips.profitRatio)}
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--mute)' }}>
                          {chips.profitRatio <= 20 ? '80%以上筹码被套 (超跌深水区)' : chips.profitRatio >= 80 ? '获利盘主导 (注意兑现抛压)' : '多空换手均衡区'}
                        </div>
                      </div>
                    </div>

                    {/* 🧬 实验性弱参考：14日 ATR 波动率 + 近120日个股历史基因概率回测 */}
                    {(report.atrProfile || report.experimentalDNA) && (
                      <details style={{ marginTop: '10px', padding: '7px 10px', background: '#f8fafc', border: '1px dashed #cbd5e1', borderRadius: '6px', fontSize: '11.5px', color: 'var(--sub)' }}>
                        <summary style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '4px', userSelect: 'none' }}>
                          <span>
                            <b style={{ color: '#0369a1' }}>🧬 [实验·弱参考] 波动与基因:</b>
                            {report.atrProfile && (
                              <> ATR(14) <b>¥{f2(report.atrProfile.atr14)}</b> ({report.atrProfile.atrPct}%) · 建议格距 <b>{report.atrProfile.adaptiveGrid}%</b></>
                            )}
                            {report.atrProfile && report.experimentalDNA && ' ｜ '}
                            {report.experimentalDNA && (
                              <>{report.experimentalDNA.dnaTag} · 低吸胜率 <b>{report.experimentalDNA.dipWinRate}%</b></>
                            )}
                          </span>
                          <span style={{ color: '#0369a1', fontSize: '11px', fontWeight: 600 }}>▾ 展开</span>
                        </summary>
                        <div style={{ marginTop: '6px', paddingTop: '6px', borderTop: '1px dashed #e2e8f0', lineHeight: 1.55 }}>
                          {report.atrProfile && (
                            <div style={{ marginBottom: report.experimentalDNA ? '4px' : 0 }}>
                              <b>📏 ATR 波动剖面 ({report.atrProfile.sampleDays}日):</b> {report.atrProfile.volType} ·
                              14日ATR <b>¥{f2(report.atrProfile.atr14)}</b> ({report.atrProfile.atrPct}%) ·
                              14日日均振幅 <b>{report.atrProfile.avgIntraAmp14}%</b> ·
                              自适应做T格距 <b>{report.atrProfile.adaptiveGrid}%</b>
                            </div>
                          )}
                          {report.experimentalDNA && (
                            <>
                              <div>
                                <b>🧬 历史基因 ({report.experimentalDNA.sampleDays}日):</b> 振幅≥3% 占比 <b>{report.experimentalDNA.tFriendly3Pct}%</b> ｜
                                深跌反抽≥1.2% 胜率 <b>{report.experimentalDNA.dipWinRate}%</b> ({report.experimentalDNA.dipWin}/{report.experimentalDNA.dipTotal}次，均抽 +{report.experimentalDNA.dipAvgRebound}%) ｜
                                高开砸盘率 <b>{report.experimentalDNA.gapUpSmashRate}%</b>
                              </div>
                              <div style={{ color: '#475569', marginTop: '3px' }}>
                                💡 {report.experimentalDNA.dnaDesc} <span style={{ color: '#94a3b8' }}>（仅弱参考/校准辅助，不推翻一票否决结论）</span>
                              </div>
                            </>
                          )}
                        </div>
                      </details>
                    )}
                  </div>
                ) : (
                  <div style={{ fontSize: '12px', color: 'var(--mute)' }}>日K筹码数据暂不可用</div>
                )}
              </section>

              {/* 5. 做T自救与二波解套处方 */}
              <section style={{ padding: '16px 18px', margin: 0 }}>
                <h3 style={{ fontSize: '14px', fontWeight: 700, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span>💡</span> 做T自救与二波解套处方
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {(report.prescriptions || []).map((p, idx) => (
                    <div
                      key={idx}
                      style={{
                        padding: '8px 12px',
                        borderRadius: '6px',
                        background: 'var(--surface)',
                        border: '1px solid var(--line)',
                        fontSize: '12.5px',
                        lineHeight: 1.6
                      }}
                    >
                      {p}
                    </div>
                  ))}
                </div>
              </section>
            </div>

            {/* 右列：实时公告雷达（排雷与催化） */}
            <section style={{ padding: '16px 18px', margin: 0, height: 'fit-content' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                <h3 style={{ fontSize: '14px', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span>📰</span> 近30天公告雷达
                  <span style={{ fontSize: '11.5px', fontWeight: 400, color: 'var(--mute)' }}>
                    ({report.announcements?.length || 0}条)
                  </span>
                </h3>

                {/* 筛选按钮 */}
                <div style={{ display: 'flex', gap: '4px' }}>
                  <button
                    onClick={() => setAnnFilter('all')}
                    style={{
                      fontSize: '11px',
                      padding: '2px 7px',
                      borderRadius: '4px',
                      border: '1px solid var(--line)',
                      background: annFilter === 'all' ? 'var(--info)' : 'var(--surface)',
                      color: annFilter === 'all' ? '#fff' : 'var(--sub)',
                      cursor: 'pointer'
                    }}
                  >
                    全部
                  </button>
                  <button
                    onClick={() => setAnnFilter('red')}
                    style={{
                      fontSize: '11px',
                      padding: '2px 7px',
                      borderRadius: '4px',
                      border: '1px solid var(--line)',
                      background: annFilter === 'red' ? 'var(--up)' : 'var(--surface)',
                      color: annFilter === 'red' ? '#fff' : 'var(--sub)',
                      cursor: 'pointer'
                    }}
                  >
                    利空 ({report.redFlags?.length || 0})
                  </button>
                  <button
                    onClick={() => setAnnFilter('green')}
                    style={{
                      fontSize: '11px',
                      padding: '2px 7px',
                      borderRadius: '4px',
                      border: '1px solid var(--line)',
                      background: annFilter === 'green' ? 'var(--down)' : 'var(--surface)',
                      color: annFilter === 'green' ? '#fff' : 'var(--sub)',
                      cursor: 'pointer'
                    }}
                  >
                    催化 ({report.greenCatalysts?.length || 0})
                  </button>
                </div>
              </div>

              {/* 公告信息流 */}
              <div style={{ maxHeight: '720px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px', paddingRight: '4px' }}>
                {filteredAnnouncements.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '30px 0', fontSize: '12px', color: 'var(--mute)' }}>
                    此分类下暂无公告
                  </div>
                ) : (
                  filteredAnnouncements.map((ann, idx) => {
                    const isRed = ann.level === 'red';
                    const isYellow = ann.level === 'yellow';
                    const isGreen = ann.level === 'green';

                    return (
                      <div
                        key={idx}
                        style={{
                          padding: '9px 12px',
                          borderRadius: '6px',
                          background: isRed ? 'var(--up-bg)' : isYellow ? 'var(--warn-bg)' : isGreen ? 'var(--down-bg)' : 'var(--surface)',
                          border: `1px solid ${isRed ? 'var(--up-b)' : isYellow ? 'var(--warn-b)' : isGreen ? 'var(--down-b)' : 'var(--line)'}`,
                          fontSize: '12.5px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                          <span style={{
                            fontSize: '11px',
                            fontWeight: 700,
                            padding: '1px 6px',
                            borderRadius: '3px',
                            background: isRed ? 'var(--up)' : isYellow ? 'var(--warn)' : isGreen ? 'var(--down)' : 'var(--surface2)',
                            color: (isRed || isYellow || isGreen) ? '#fff' : 'var(--mute)'
                          }}>
                            {ann.tag}
                          </span>
                          <span style={{ fontSize: '11px', color: 'var(--mute)', fontFamily: 'monospace' }}>
                            {ann.date}
                          </span>
                        </div>
                        <div style={{ color: isRed ? 'var(--up-d)' : 'var(--text)', fontWeight: isRed ? 600 : 400, lineHeight: 1.5 }}>
                          {ann.title}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          </div>
        </div>
      ) : null}
    </div>
  );
}
