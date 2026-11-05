/* ============================================================
   A股做T执行台 · 行情数据与技术分析引擎 (api.js)
   ============================================================ */

import { f2, f3, pct, money, money$, fmtIn, fvol, GRID, STOP, FLY, toast, toastOk, toastWarn, toastErr, soundChime, AUTO_FIELDS } from './utils.js';
import { ALERT_CENTER, saveAlerts, stampData, pool, SNAP } from './state.js';
import { chartInd, chartEntry, chartMeta } from './chart.js';

/* ===================== 数据层：全腾讯源（行情 / 检索 / 日K） =====================
   选源原则：实测本机到东财域名严重不稳（searchapi 首包 11s+，push2his 直接连不上），
   而腾讯 gtimg.cn 三个域名均为百毫秒级、且都带 Access-Control-Allow-Origin: *。
   故统一到腾讯单一家，彻底去掉东财依赖，降低链路数量。 */
const T_Q = 'https://qt.gtimg.cn/q=';                                  // 实时行情（fetch，CORS *）
const T_S = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/smartbox/search/get';  // 检索（JSON，CORS *）
const T_K = 'https://ifzq.gtimg.cn/appstock/app/fqkline/get';          // 前复权日K（fetch，CORS *）

/* 带超时的 fetch —— 慢接口要能主动放弃，不能挂死界面 */
export function fetchT(url, ms){
  const ctl = new AbortController();
  const t = setTimeout(()=> ctl.abort(), ms || 8000);
  return fetch(url, { cache:'no-store', signal: ctl.signal }).finally(()=> clearTimeout(t));
}

/* —— 本地代码解析：0 网络请求，纯规则。输入代码这条路完全不依赖检索接口 —— */
export function tcodeFromCode(code){
  const c = String(code).trim();
  if (!/^\d{6}$/.test(c)) return null;
  if (/^(6|9)/.test(c))      return 'sh' + c;   // 沪主板 / 科创板 / 沪B
  if (/^(0|2|3)/.test(c))    return 'sz' + c;   // 深主板 / 中小板 / 创业板 / 深B
  if (/^(4|8)/.test(c))      return 'bj' + c;   // 北交所
  return null;
}
function tcodeFromInput(v){
  const s = String(v).trim().toLowerCase().replace(/\s+/g, '');
  const m = s.match(/^(sh|sz|bj)?(\d{6})$/);
  if (!m) return null;
  return m[1] ? m[1] + m[2] : tcodeFromCode(m[2]);
}
const codeOf = tc => String(tc).replace(/^(sh|sz|bj)/, '');

/* 旧数据迁移：老版本存的是东财 secid，转成腾讯 tcode */
export function tencentCode(secid){
  const [mkt, code] = String(secid).split('.');
  if (mkt === '1') return 'sh' + code;
  if (mkt === '0') return (/^[48]/.test(code) ? 'bj' : 'sz') + code;
  return tcodeFromCode(code);
}

/* —— 检索：腾讯 proxy.finance.qq.com（JSON + CORS *）——
   踩坑记录：另一个常用源 smartbox.gtimg.cn 返回的 Content-Type 是 text/html，
   浏览器按严格 MIME 校验会拒绝把它当脚本执行，script 标签永不触发 onload，
   表现就是"检索一直转圈直到超时"。所以这里必须用 fetch + JSON，不能用 script 注入。
   返回：data.stock = [[市场, 代码, 名称, 备注, 类型], ...] */
export async function searchTencent(q){
  const r = await fetchT(T_S + '?q=' + encodeURIComponent(q) + '&t=all', 8000);
  if (!r.ok) throw new Error('http ' + r.status);
  const j = await r.json();
  const arr = (j && j.data && j.data.stock) || [];
  const seen = {}, out = [];
  arr.forEach(a=>{
    if (!Array.isArray(a) || a.length < 5) return;
    const mkt = a[0], code = String(a[1]), name = a[2], type = a[4];
    if (!/^(sh|sz|bj)$/.test(mkt)) return;      // 只留 A 股三个市场，滤掉港美股
    if (!/^GP-A/.test(type)) return;            // 滤掉 ETF / LOF / 可转债 / 指数 / B股
    if (!/^\d{6}$/.test(code) || seen[code]) return;
    seen[code] = 1;
    out.push({ name, code, tcode: mkt + code,
               market: type === 'GP-A-KCB' ? '科创板' : (/^3/.test(code) ? '创业板' : '主板') });
  });
  return out;
}
const todayStr = ()=>{ const d=new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
const nowStr = ()=> new Date().toLocaleTimeString('zh-CN',{hour12:false});

/* 实时行情（腾讯）：现价 / 昨收 / 开高低 / 分时均线 / 量比
   字段下标已逐项核对（88 个字段挤在一行，取错一位不报错、只静默算错） */
export async function fetchQuotes(codes){
  const url = T_Q + codes.join(',');
  let txt = '';
  try{
    const r = await fetchT(url, 7000);
    if (!r.ok) throw new Error('http ' + r.status);
    txt = new TextDecoder('gbk').decode(await r.arrayBuffer());
  }catch(_){
    txt = await new Promise((res, rej)=>{           // 兜底：script 标签注入（fetch 被拒时仍可取到）
      const s = document.createElement('script');
      s.src = url; s.setAttribute('charset','gbk');
      const timer = setTimeout(()=>{ cleanup(); rej(new Error('行情请求超时')); }, 9000);
      function cleanup(){ clearTimeout(timer); if (s.parentNode) s.parentNode.removeChild(s); }
      s.onload = ()=>{ cleanup(); res(codes.map(c=>'v_'+c+'="'+(window['v_'+c]||'')+'"').join('\n')); };
      s.onerror = ()=>{ cleanup(); rej(new Error('行情接口不可达')); };
      document.head.appendChild(s);
    });
  }
  const out = {};
  txt.split('\n').forEach(line=>{
    const m = line.match(/v_([a-z]{2}\d+)="([^"]*)"/);
    if (!m) return;
    const f = m[2].split('~');
    if (f.length < 52) return;
    const px = +f[3];
    out[m[1]] = { name:f[1], code:f[2], price:px, prevClose:+f[4], open:+f[5],
                  high:+f[33], low:+f[34], avg:+f[51], vr:+f[49],
                  ceiling:+f[47], floor:+f[48], amp:+f[43], time:f[30],
                  /* 下面几个字段下标同样是逐项核对过的：38 换手率% / 39 PE(TTM) / 44 流通市值亿
                     / 46 市净率 / 72 流通股本(股) / 7 外盘 / 8 内盘 / 6 成交量手 / 37 成交额万 */
                  to:+f[38], pe:+f[39], mcap:+f[44], pb:+f[46], floatSh:+f[72],
                  outer:+f[7], inner:+f[8], vol:+f[6], amt:+f[37] };
  });
  return out;
}

/* 前复权日K（腾讯）—— 一次拉 120 根完整 OHLCV，供均线 / K线图 / MACD / 箱体共用
   返回结构：data[tcode].qfqday = [[日期, 开, 收, 高, 低, 成交量(手)], ...]
   ⚠️ 字段顺序是「开/收/高/低/量」，不是常见的 OHLC —— 下标 1=开 2=收 3=高 4=低 5=量，
      末根为今日（含盘中实时值）。这个顺序取错不会报错、只会静默画反，必须按此解读。 */
const KLINE_N = 120;
export async function fetchKline(tcode){
  const r = await fetchT(T_K + '?param=' + tcode + ',day,,,' + KLINE_N + ',qfq', 12000);
  if (!r.ok) throw new Error('http ' + r.status);
  const d = await r.json();
  const node = (d && d.data && d.data[tcode]) || null;
  const ks = (node && (node.qfqday || node.day)) || [];
  return ks.map(a => ({ date:String(a[0]), open:+a[1], close:+a[2], high:+a[3], low:+a[4], vol:+a[5] }));
}

/* ===================== 多周期K线 / 分时 / 逐笔大单 ===================== */
const T_MK  = 'https://ifzq.gtimg.cn/appstock/app/kline/mkline';          // 分钟K（CORS *）
const T_MIN = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query';      // 当日分时（CORS *）
const T_DD  = 'https://stock.gtimg.cn/data/index.php';                    // 逐笔明细（无 CORS，走 script 注入）

const PERIODS = [
  ['rt','分时'], ['m1','1分'], ['m5','5分'], ['m15','15分'], ['m30','30分'], ['m60','60分'],
  ['day','日K'], ['week','周K'], ['month','月K']
];
const PERIOD_LABEL = {}; PERIODS.forEach(([k,v])=> PERIOD_LABEL[k]=v);
/* 工具条只摆 4 个常用周期，其余收进「更多 ▾」——
   原来 9 个周期 + 5 叠加 + 2 副图 ≈ 18 个 chip，窄屏会折成 4~5 行。 */
const P_MAIN = ['rt','day','week','month'];
const P_MORE = PERIODS.filter(([k])=> P_MAIN.indexOf(k) < 0);
const VIEWS = { rt:999, m1:240, m5:64, m15:64, m30:64, m60:64, day:60, week:60, month:40 };

/* 日 / 周 / 月 前复权K线（字段：日期,开,收,高,低,量手） */
export async function fetchKlineBig(tcode, period, n){
  const key = period === 'day' ? 'qfqday' : period === 'week' ? 'qfqweek' : 'qfqmonth';
  const r = await fetchT(T_K + '?param=' + tcode + ',' + period + ',,,' + (n||140) + ',qfq', 12000);
  if (!r.ok) throw new Error('http ' + r.status);
  const d = await r.json();
  const node = (d && d.data && d.data[tcode]) || null;
  const ks = (node && (node[key] || node[period])) || [];
  return ks.map(a => ({ date:String(a[0]), open:+a[1], close:+a[2], high:+a[3], low:+a[4], vol:+a[5] }));
}
/* 分钟K线 m1/m5/m15/m30/m60（字段：时间YYYYMMDDHHmm,开,收,高,低,量手,{},换手%） */
export async function fetchKlineMin(tcode, period, n){
  const r = await fetchT(T_MK + '?param=' + tcode + ',' + period + ',,,' + (n||320), 12000);
  if (!r.ok) throw new Error('http ' + r.status);
  const d = await r.json();
  const node = (d && d.data && d.data[tcode]) || null;
  const ks = (node && node[period]) || [];
  return ks.map(a => ({ date:String(a[0]), open:+a[1], close:+a[2], high:+a[3], low:+a[4],
                        vol:+a[5], to:(a[7]!==undefined ? +a[7] : null) }));
}

/* 当日分时：原始串为 "HHMM 价格 累计量(手) 累计额(元)"，需自己差分出每分钟量。
   累计额 / (累计量×100) 就是权威的分时均价，不用另算。 */
export async function fetchMinute(tcode){
  const r = await fetchT(T_MIN + '?code=' + tcode, 12000);
  if (!r.ok) throw new Error('http ' + r.status);
  const d = await r.json();
  const node = (d && d.data && d.data[tcode]) || null;
  const dd = node && node.data;
  const raw = (dd && dd.data) || [];
  const qt = (node && node.qt && node.qt[tcode]) || [];
  const prev = +qt[4] || 0;
  const pts = [];
  let lv = 0, la = 0;
  raw.forEach(s=>{
    const f = String(s).split(' ');
    const t = f[0], px = +f[1], cv = +f[2], ca = +f[3];
    if (!/^\d{4}$/.test(t) || t > '1500') return;      // 丢掉 15:00 之后的盘后重复推送
    if (!(px > 0)) return;
    const vol = Math.max(0, cv - lv), amt = Math.max(0, ca - la);
    lv = cv; la = ca;
    pts.push({ t, price:px, vol, amt, avg: cv > 0 ? ca/(cv*100) : px });
  });
  return { date:(dd && dd.date) || '', prev, pts };
}

/* 逐笔明细：响应体是 `v_detail_data_<code>=[页号,"序号/时间/价/涨跌/手数/金额/方向|..."]`
   形式的赋值语句，所以 script 注入可拿到（实测 text/html 也照样执行；fetch 会被 CORS 拦）。
   并发陷阱：所有页都写同一个全局变量名，谁后到谁覆盖。
   解法：先用 Object.defineProperty 在该变量名上挂一个 setter 劫持赋值，
   数据到达的瞬间就按页号收走 —— 于是所有页可以并行拉，实测 21 页约 240ms。 */
function ddCapture(tcode){
  const key = 'v_detail_data_' + tcode;
  const bag = {};
  try{
    Object.defineProperty(window, key, { configurable:true,
      set(v){ if (v && v[1] !== undefined) bag[v[0]] = v[1]; },
      get(){ return undefined; } });
  }catch(_){}
  return bag;
}
function ddPage(tcode, p){
  return new Promise(res=>{
    const s = document.createElement('script');
    s.src = T_DD + '?appn=detail&action=data&c=' + tcode + '&p=' + p;
    const timer = setTimeout(()=>{ done(false); }, 6000);
    function done(ok){ clearTimeout(timer); if (s.parentNode) s.parentNode.removeChild(s); res(ok); }
    s.onload  = ()=> done(true);
    s.onerror = ()=> done(false);
    document.head.appendChild(s);
  });
}
/* 拉全当天逐笔：分波并行（8 个一波），某一波一页都没回来就说明全天已取完，立即停。
   上限 60 页（≈4200 笔）是"防呆"用的：交投极活跃的票逐笔可能上万笔，
   再往上打请求会把界面拖慢，所以到顶就停，并在卡片上标注"样本覆盖率"。 */
export async function fetchDetail(tcode, maxPage){
  maxPage = maxPage || 60;
  const bag = ddCapture(tcode), W = 8;
  for (let base = 0; base < maxPage; base += W){
    const ps = [];
    for (let p = base; p < Math.min(base + W, maxPage); p++) ps.push(ddPage(tcode, p));
    await Promise.all(ps);
    if (!Object.keys(bag).some(k => +k >= base)) break;     // 本波一页都没回来 → 全天已取完
  }
  const pages = Object.keys(bag).map(Number).sort((a,b)=>a-b);
  const recs = [];
  pages.forEach(pg=>{
    String(bag[pg]).split('|').forEach(rec=>{
      const f = rec.split('/');
      if (f.length < 7) return;
      recs.push({ t:f[1], price:+f[2], chg:+f[3], vol:+f[4], amt:+f[5], dir:f[6] });
    });
  });
  return { pages:pages.length, recs };
}

/* 大单分档（口径与东财一致）：按单笔成交金额分档，净额 = 主动买 − 主动卖，M(中性)不计方向。
   特大单 ≥100万 ｜ 大单 20万–100万 ｜ 中单 4万–20万 ｜ 小单 <4万；主力 = 特大单 + 大单。 */
export function calcDD(recs){
  const T = { xl:{buy:0,sell:0,bv:0,sv:0,n:0}, l:{buy:0,sell:0,bv:0,sv:0,n:0},
              m:{buy:0,sell:0,bv:0,sv:0,n:0},  s:{buy:0,sell:0,bv:0,sv:0,n:0} };
  let amt = 0, vol = 0;
  recs.forEach(r=>{
    amt += r.amt; vol += r.vol;
    const k = r.amt >= 1000000 ? 'xl' : r.amt >= 200000 ? 'l' : r.amt >= 40000 ? 'm' : 's';
    const g = T[k]; g.n++;
    if (r.dir === 'B'){ g.buy += r.amt; g.bv += r.vol; }
    else if (r.dir === 'S'){ g.sell += r.amt; g.sv += r.vol; }
  });
  const net  = k => T[k].buy - T[k].sell;
  const netv = k => T[k].bv  - T[k].sv;
  const main = {
    buy:  T.xl.buy  + T.l.buy,  sell: T.xl.sell + T.l.sell,
    bv:   T.xl.bv   + T.l.bv,   sv:   T.xl.sv   + T.l.sv,
    n:    T.xl.n    + T.l.n,
    net:  net('xl')  + net('l'),
    netv: netv('xl') + netv('l')
  };
  // 大单流入/流出占比（分母用全天成交额，比"占大单自身的比"更能说明主力控盘度）
  const tot = (T.xl.buy+T.xl.sell+T.l.buy+T.l.sell) || 1;
  return { T, net, netv, main, total:{amt, vol, n:recs.length},
           mainIn:(main.buy/tot*100), mainShare:(tot/(amt||1)*100),
           xlNet:net('xl'), lNet:net('l'), mNet:net('m'), sNet:net('s'),
           xlNetv:netv('xl'), lNetv:netv('l'), mNetv:netv('m'), sNetv:netv('s') };
}

/* 图表数据装载：按当前周期取数并缓存。日K 直接复用 loadStock 已维护的 s._ks。 */
const CK_TTL = 45000;
export async function loadChart(s, force){
  const p = s.p || 'day';
  s._k = s._k || {};
  if (!s.tcode && s.code) {
    s.tcode = tcodeFromCode(s.code);
  }
  const c = s._k[p], now = Date.now();
  const ttl = p === 'rt' ? 20000 : CK_TTL;
  if (!force && c && now - c.at < ttl) return c;
  if (p === 'rt'){
    s._k[p] = chartEntry('line', { min: await fetchMinute(s.tcode) });
  } else if (p === 'day'){
    if (!s._ks || !s._ks.length){
      try { s._ks = await fetchKline(s.tcode); } catch(_) { s._ks = []; }
    }
    s._k[p] = chartEntry('bar', { ks: s._ks || [] });
  } else if (p === 'week' || p === 'month'){
    s._k[p] = chartEntry('bar', { ks: await fetchKlineBig(s.tcode, p, p === 'month' ? 80 : 140) });
  } else {
    s._k[p] = chartEntry('bar', { ks: await fetchKlineMin(s.tcode, p, p === 'm1' ? 320 : 240) });
  }
  return s._k[p];
}
/* 大单资金装载（偏重：一次要打二十来个请求，所以单独控制、带 90 秒节流） */
export async function loadDD(s, force){
  const now = Date.now();
  if (!force && s._dd && now - s._dd.at < 90000) return s._dd;
  const r = await fetchDetail(s.tcode);
  s._dd = { raw:r, dd:calcDD(r.recs), at:now };
  return s._dd;
}

/* ===================== 市场环境 · 估值分位 · 板块归属 =====================
   ⚠️ 数据源边界（2026-09-17 本机 curl + 无头 Chrome 双轮实测，不要再凭猜测试接口）
   ✅ 可用（带 Access-Control-Allow-Origin: *，file:// 页面可直连）
      · qt.gtimg.cn          指数行情 —— 字段与个股同构，37=成交额(万元) 43=振幅%
      · ifzq.gtimg.cn        指数日/周/月K、分钟K（sh000001 已验证通）
      · datacenter-web.eastmoney.com   历史估值序列 + 个股板块归属（0.5s，稳）
   ❌ 已排除，不要再试
      · 东财 push2 / push2his   连续 8 次请求全部超时（约十分之一概率偶通，不可依赖）
      · 同花顺 d.10jqka.com.cn  限速，连续 5 次全部超时（首次偶通，不可依赖）
      · 选股宝 flash-api、新浪 hq 系：响应无 CORS 头，fetch 必被拦且非 JSONP
      · 腾讯申万指数 sh801010：行情返回 none_match，腾讯没有申万行业指数
   由此产生两个**无法实现**的功能，本系统如实标注、不假装有：
      · 涨跌家数（市场宽度）—— 无稳定源
      · 板块指数涨跌     —— 无稳定源（同花顺被限速、东财板块行情走 push2 已废）
   板块联动改用「参照指数相对强弱(RS)」替代：RS = 个股收盘/参照指数收盘，
   它直接回答"今天是个股自己的问题，还是整个市场的问题"——这才是做T真正要剥掉的 β。 */
const T_DCW = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const MKT_IDX = [ ['sh000001','上证指数'], ['sz399001','深证成指'], ['sz399006','创业板指'], ['sh000688','科创50'] ];

/* 是否交易日：周末 + 可维护的节假日表（法定假日往 HOLIDAYS 里加一行 'YYYY-MM-DD' 即可） */
const HOLIDAYS = new Set([
  /* '2026-10-01', '2026-10-02', */
]);
function isTradeDay(d){
  d = d || new Date();
  const wd = d.getDay();
  if (wd < 1 || wd > 5) return false;
  const key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  return !HOLIDAYS.has(key);
}

/* ===================== 日内成交量分布（U 型） =====================
   原来这段是「按时间线性折算」，那是个系统性偏差，而且偏差方向不对称：
   A 股成交量是 U 型的 —— 9:30-10:00 半小时吃掉全天约 20%，10:30-11:00 只有 9%，尾盘半小时又回到 20%。
   拿线性进度去折算（9:45 认为该完成 6.3%、10:00 认为该完成 12.5%），与 U 型实际（10.0% / 20.0%）比：
     09:35–10:00　旧口径把量能放大 1.60 倍（高估 60%）
     10:30　　　　放大 1.24 倍
     11:00　　　　放大 1.07 倍
     11:30 之后　　反而低估 4%–9%，影响有限
   也就是说：开盘一小时的「放量」读数是虚的，量比 3 可能只是早盘本该有的量；
   而午后那点低估幅度小，不足以改变结论。误差集中在早盘，正是做T最需要看盘的时候。

   下表是各时段的成交量占比（经验值，不是本机回测得出；四舍五入到 1%，合计 100%）：
     09:30-10:00 20% ｜ 10:00-10:30 11% ｜ 10:30-11:00 9% ｜ 11:00-11:30 8%
     13:00-13:30 10% ｜ 13:30-14:00 10% ｜ 14:00-14:30 12% ｜ 14:30-15:00 20%
   要更准只能靠每天归档当日分时量、攒出这个账户自己的 U 型曲线，那是后话。 */
const VOL_CUM = [
  // [当日第几分钟, 到该时刻为止应完成的成交量占比]
  [570, 0.00], [600, 0.20], [630, 0.31], [660, 0.40], [690, 0.48],
  [780, 0.48], [810, 0.58], [840, 0.68], [870, 0.80], [900, 1.00],
];
function volShareAt(m){
  if (m <= 570) return 0;
  if (m >= 900) return 1;
  for (let i = 1; i < VOL_CUM.length; i++){
    const t0 = VOL_CUM[i-1][0], v0 = VOL_CUM[i-1][1];
    const t1 = VOL_CUM[i][0],   v1 = VOL_CUM[i][1];
    if (m <= t1){
      if (t1 === t0) return v1;
      return v0 + (v1 - v0) * (m - t0) / (t1 - t0);
    }
  }
  return 1;
}
/* 当前时点「应完成」的成交量占比（0~1）。盘中量能必须折算到这个口径才可比。 */
function sessionProgress(){
  const d = new Date(), m = d.getHours()*60 + d.getMinutes();
  if (!isTradeDay(d)) return 1;      // 非交易日不折算：否则周六下午打开，会把周五的成交量按"今日已过半"折，量比直接失真
  return Math.max(0.005, volShareAt(m));
}

/* ============ 分时量能（第二层：定「这一笔现在做不做」）============
   上面两条（量比 / 时段达成率）都是「日级量能投影到时间轴」，只能定今天仓位几成；
   决定做T进出点的是分钟级量能，而分钟级量能必须先解决「跨时点可比」这个前提。

   实测（上海沿浦 605128，最近 5 个交易日 m5，每根除以「全天 48 根均值」）：
     09:35 = 4.28×（含集合竞价量）｜10:30 = 1.48×｜11:15 = 0.99×｜14:55 = 1.43×
   也就是说，拿「当日均量」当分母时，同一个显示 2× 的柱子：
     在 09:35 其实只有该时段常态的 0.47 倍（是缩量，不是放量）；
     在 11:15 却是 2.02 倍（才是真放量）。
   同一根柱子被读成"缩量"还是"放量"，差 4.3 倍 —— 这就是原副图不能设阈值的原因。
   分母换成「前 5 个交易日同一时段的平均量」后，1.0 恒等于「这个时点的常态」。

   取数：腾讯 m5 单次硬上限 482 根 ≈ 10 个交易日，够算 5 日基准；
   m1 同样只有 482 根 = 2 天，不够用，所以基准只能走 m5 及以上。
   基准一天建一次落 localStorage（派生数据，不进导出备份），当日各根每 2 分钟刷一次。 */
const VM_LS = 't-system-volbase', VM_TTL = 120000, VM_MIN_BARS = 3;

const pad4 = mins => { const h = Math.floor(mins/60), m = mins % 60;
  return (h<10?'0':'')+h + (m<10?'0':'')+m; };
/* 分钟数 → 所属 5 分钟槽标签。腾讯 m5 的标签是区间末端（0935 / 1130 / 1305 / 1500），
   午休后第一根是 1305（13:00 那分钟归它），所以下午必须强制从 +5 起算。 */
function m5Slot(mins){
  if (mins <= 575) return '0935';
  if (mins <= 690) return pad4(570 + Math.ceil((mins - 570)/5)*5);
  return pad4(780 + Math.max(1, Math.ceil((mins - 780)/5))*5);
}
function volBaseAll(){
  try{ const o = JSON.parse(localStorage.getItem(VM_LS) || '{}'); return (o && typeof o === 'object') ? o : {}; }
  catch(_){ return {}; }
}
function volBaseGet(code){
  const e = volBaseAll()[code], d = todayStr().replace(/-/g,'');
  return (e && e.forDate === d && e.slots) ? e : null;
}
function volBaseSet(code, entry){
  const all = volBaseAll(), d = todayStr().replace(/-/g,'');
  Object.keys(all).forEach(k => { if (!all[k] || all[k].forDate !== d) delete all[k]; });  // 只留当天，防配额
  all[code] = entry;
  try{ localStorage.setItem(VM_LS, JSON.stringify(all)); }catch(_){}
}

/* 拉 m5 → 建 5 日同时段基准 → 判读今日量价关系。失败只降级，不抛出。 */
export async function loadVolMin(s, force){
  const now = Date.now();
  if (!force && s._vm && now - s._vm.at < VM_TTL) return s._vm;
  const tcode = s.tcode || (s.secid ? tencentCode(s.secid) : tcodeFromCode(s.code));
  if (!tcode){ s._vm = { at:now, ok:false, err:'缺少股票代码' }; return s._vm; }

  let ks;
  try{ ks = await fetchKlineMin(tcode, 'm5', 482); }
  catch(e){ s._vm = { at:now, ok:false, err:'m5 取数失败：' + e.message }; return s._vm; }
  if (!ks || ks.length < 60){
    s._vm = { at:now, ok:false, err:'m5 样本不足（' + (ks ? ks.length : 0) + ' 根，5 日基准建不起来）' };
    return s._vm;
  }

  const today = todayStr().replace(/-/g,'');
  const byDay = {};
  ks.forEach(k=>{
    const dt = String(k.date), d = dt.slice(0,8), t = dt.slice(8,12);
    if (!/^\d{8}$/.test(d) || !/^\d{4}$/.test(t)) return;
    (byDay[d] = byDay[d] || []).push({ t, vol:+k.vol||0, close:+k.close, high:+k.high, low:+k.low });
  });

  let base = volBaseGet(s.code);
  if (!base){
    const hist = Object.keys(byDay).filter(d => d !== today).sort().slice(-5);
    if (!hist.length){ s._vm = { at:now, ok:false, err:'只有今日分时，缺前 5 日基准' }; return s._vm; }
    const sum = {};
    hist.forEach(d => byDay[d].forEach(b => { sum[b.t] = (sum[b.t] || 0) + b.vol; }));
    const slots = {};
    Object.keys(sum).forEach(t => { slots[t] = sum[t] / hist.length; });
    base = { forDate: today, slots, days: hist.length, builtAt: now };
    volBaseSet(s.code, base);
  }

  /* ---- 今日各根：不能用 m5 ----
     实测：腾讯 kline/mkline 的 m5 在盘中不含当日（09:42 时最后一根仍是昨天 15:00），
     所以基准用 m5、当日用「当日分时」自己聚合成 5 分钟桶。
     额外好处是能知道当前这根走到第几分钟 —— 没走完的桶必须按已走分钟数折算回满桶，
     否则最后一根会被系统性低估，把"放量"读成"缩量"。 */
  let bars = (byDay[today] || []).map(b => ({ t:b.t, vol:b.vol, high:b.high, low:b.low, close:b.close, elapsed:5 }));
  try{
    const mn = await fetchMinute(tcode);
    /* 关键守卫：开盘前 / 非交易日，分时接口会把「上一个交易日」的完整分时原样吐回来。
       不判日期就会拿昨天的量去比一个已经包含昨天的基准 —— r 恒等于 1，显示"量能常态"，
       完全是假象。所以日期不匹配时一律当作"今日还没有分时"。 */
    const mnDate = String((mn && mn.date) || '').replace(/\D/g,'').slice(0,8);
    const pts = (mnDate === today) ? ((mn && mn.pts) || []) : [];
    if (pts.length){
      const acc = {};
      pts.forEach(p=>{
        if (!(p.price > 0)) return;
        const mm = (+p.t.slice(0,2))*60 + (+p.t.slice(2,4));
        const sl = m5Slot(mm);
        const b = acc[sl] || (acc[sl] = { t:sl, vol:0, high:0, low:1e9, close:p.price, lastMin:mm });
        b.vol += (+p.vol) || 0;
        b.close = p.price;
        if (p.price > b.high) b.high = p.price;
        if (p.price < b.low)  b.low  = p.price;
        if (mm > b.lastMin) b.lastMin = mm;
      });
      bars = Object.keys(acc).sort().map(k=>{
        const b = acc[k], lmin = (+k.slice(0,2))*60 + (+k.slice(2,4));
        const el = Math.max(1, Math.min(5, b.lastMin - (lmin - 5)));
        return { t:k, vol:b.vol, high:b.high, low:(b.low === 1e9 ? b.close : b.low), close:b.close, elapsed:el };
      });
    }
  }catch(_){ /* 分时挂了就退回 m5 的当日（通常是空数组 → 走"样本不足"分支） */ }

  // ---- 今日各根 ÷ 同一时段基准（未走完的桶按进度折算回满桶）----
  const rs = bars.map(b => {
    const bv = base.slots[b.t];
    if (!(bv > 0)) return null;
    const el = b.elapsed || 5;
    return (b.vol * (5 / el)) / bv;
  });
  const R  = rs.filter(v => v != null && isFinite(v) && v > 0);
  const avg = arr => arr.reduce((a,b)=>a+b,0) / arr.length;

  const px   = +s.price || (bars.length ? bars[bars.length-1].close : 0);
  const pcl  = +s.prevClose || px;
  const avgL = +s.avg || px;                                   // 分时均价线
  const HI   = bars.length ? Math.max.apply(null, bars.map(b=>b.high)) : 0;
  const LO   = bars.length ? Math.min.apply(null, bars.map(b=>b.low))  : 0;

  const curR  = R.length ? R[R.length-1] : null;
  const r3    = R.length ? (R.length >= 3 ? avg(R.slice(-3)) : avg(R)) : null;
  const peakR = R.length ? Math.max.apply(null, R) : null;
  const offHi = (HI > 0 && px > 0) ? (px/HI - 1)*100 : null;   // ≤0，距当日高点的百分比
  const distA = (avgL > 0 && px > 0) ? Math.abs(px/avgL - 1)*100 : null;

  let state, label, cls, sc, text;
  if (bars.length < VM_MIN_BARS || r3 == null){
    state='na'; label='样本不足'; cls='t-nt'; sc='s-nt';
    text = `今日 5 分钟K 只有 ${bars.length} 根（至少 ${VM_MIN_BARS} 根才做判定）。开盘头 15 分钟量能最乱，这一段本来也不该下手。`;
  } else if (curR >= 2 && LO > 0 && px <= LO*1.002 && px < pcl){
    state='breakdown'; label='放量破位'; cls='t-no'; sc='s-no';
    text = `现价 ${f2(px)} 贴着当日低点 ${f2(LO)}，最新一根量能是同时段常态的 <b>${curR.toFixed(2)} 倍</b>（近三根均值 ${r3.toFixed(2)}×）。放量下跌是真抛压在出逃、不是情绪，这时<b>不接</b>——要等量能萎缩、分时线不再创新低。`;
  } else if (offHi != null && offHi >= -0.3 && r3 < 0.85 && peakR != null && peakR >= 1.5){
    state='diverge'; label='量价顶背离'; cls='t-wn'; sc='s-wn';
    text = `价格在当日高点 ${f2(HI)} 附近（距高点 ${offHi.toFixed(2)}%），但近三根量能只有同时段常态的 <b>${r3.toFixed(2)} 倍</b>，而当日最高曾放到 ${peakR.toFixed(2)} 倍 —— 拉上去没人跟。日内高点大概率已出，<b>倒T 先卖</b>：在 ${f2(px)} 附近减第一份，回落到均价 ${f2(avgL)} 再看接不接得回。`;
  } else if (offHi != null && offHi <= -0.8 && distA != null && distA <= 0.4 && r3 < 0.7){
    state='pullback'; label='缩量回踩'; cls='t-ok'; sc='s-ok';
    text = `自当日高点 ${f2(HI)} 回落 ${Math.abs(offHi).toFixed(2)}%，现价 ${f2(px)} 距分时均价 ${f2(avgL)} 仅 ${distA.toFixed(2)}%，近三根量能萎缩到常态的 <b>${r3.toFixed(2)} 倍</b> —— 抛压正在衰减，这是回踩有效性最高的组合。<b>正T 第一份可挂</b>，止损放 ${f2(avgL*0.994)}（均价线失守 0.6%）。`;
  } else if (offHi != null && offHi >= -0.15 && r3 >= 1.5){
    state='surge'; label='量价配合'; cls='t-ok'; sc='s-ok';
    text = `现价在当日高点附近，量能放大到同时段常态的 <b>${r3.toFixed(2)} 倍</b> —— 有真金白银在推。但放量拉升后往往要消化，<b>不在这一根追</b>，等回踩均价线不破再上。`;
  } else if (r3 < 0.6){
    state='dry'; label='整体缩量'; cls='t-nt'; sc='s-nt';
    text = `近三根量能只有同时段常态的 <b>${r3.toFixed(2)} 倍</b>，属无风状态。双边都走不远，价差还不够手续费，<b>宁可不动</b>。`;
  } else {
    state='normal'; label='量能常态'; cls='t-nt'; sc='s-nt';
    text = `近三根量能是同时段常态的 <b>${r3.toFixed(2)} 倍</b>，属正常换手。方向仍按均价线判：站上偏多、跌破偏空。`;
  }

  s._vm = { at:now, ok:true, state, label, cls, sc, text,
            curR, r3, peakR, offHi, distA, dayHi:HI, dayLo:LO,
            nBars:bars.length, baseDays:base.days, slots:base.slots };
  return s._vm;
}

export let MKT = null;                       // 市场环境对象
const MKT_TTL = 30000;                // 指数行情 30 秒
let _idxK = {}, _idxKAt = 0;          // 4 个指数的日K缓存（盘中末根在变，缓存 10 分钟足够）

export async function loadMarket(force){
  const now = Date.now();
  if (!force && MKT && now - MKT.at < MKT_TTL) return MKT;
  const q = await fetchQuotes(MKT_IDX.map(x=>x[0]));
  if (force || !_idxK['sh000001'] || now - _idxKAt > 600000){
    const arr = await Promise.all(MKT_IDX.map(([tc])=> fetchKlineBig(tc,'day',140).catch(()=>null)));
    MKT_IDX.forEach(([tc],i)=>{ if (arr[i] && arr[i].length) _idxK[tc] = arr[i]; });
    _idxKAt = now;
  }
  const idx = MKT_IDX.map(([tc,label])=>{
    const o = q[tc] || {};
    const chg = o.prevClose ? (o.price - o.prevClose)/o.prevClose*100 : 0;
    return { tc, label, price:+o.price||0, chg, amp:+o.amp||0, amt:+o.amt||0, time:o.time||'' };
  });
  const amtTotal = ((+((q['sh000001']||{}).amt)||0) + (+((q['sz399001']||{}).amt)||0)) / 10000;  // 万元 → 亿元
  MKT = { at: now, idx, amtTotal, ks:_idxK['sh000001'] || [] };
  MKT.gate = marketGate(MKT);
  return MKT;
}

/* ---- 第四条闸门：市场环境 ----
   前三闸门（格位/趋势/量能）全部只看个股内部，缺一条外生的。
   同一个个股信号，在指数放量破位那天和缩量整理那天，胜率根本不是一个量级。 */
export function marketGate(m){
  const ks = m.ks || [];
  if (ks.length < 30)
    return { level:'NA', cls:'g-wn', title:'市场环境数据不足', detail:'指数日K未取到，本闸门暂不参与决策，请按三闸门执行。' };
  const closes = ks.map(k=>k.close), vols = ks.map(k=>k.vol||0);
  const ma20 = maArr(closes,20), ma60 = maArr(closes,60);
  const v20 = ma20.length ? ma20[ma20.length-1] : null;
  const v60 = ma60.length ? ma60[ma60.length-1] : null;
  const px  = (m.idx[0]||{}).price || 0;
  const hi20 = Math.max.apply(null, ks.slice(-20).map(k=>k.high));
  const lo20 = Math.min.apply(null, ks.slice(-20).map(k=>k.low));
  const pos20 = hi20 > lo20 ? (px-lo20)/(hi20-lo20)*100 : null;
  const vma20 = maArr(vols,20), vv20 = vma20.length ? vma20[vma20.length-1] : null;
  const prog = sessionProgress();
  const volRatio = (vv20 && prog > 0.05) ? (vols[vols.length-1]/vv20)/prog : null;
  const below20 = v20!=null && px < v20, below60 = v60!=null && px < v60;
  const heavy = volRatio!=null && volRatio >= 1.10, dry = volRatio!=null && volRatio <= 0.80;
  const vrTxt = volRatio!=null ? `成交达20日均量的<b>${volRatio.toFixed(2)}倍</b>（该时点按U型分布应完成全天 ${(prog*100).toFixed(0)}% 的成交量，此为折算后）` : '量能数据不足';
  const posTxt = pos20!=null ? `，处于近20日区间 <b>${pos20.toFixed(0)}%</b> 位置（${f2(lo20)} ~ ${f2(hi20)}）` : '';
  const base = `上证指数 <b>${f2(px)}</b>（${pct((m.idx[0]||{}).chg||0)}），MA20 ${v20!=null?f2(v20):'—'}、MA60 ${v60!=null?f2(v60):'—'}${posTxt}，${vrTxt}。`;

  if (below20 && below60){
    return { level:'BAD', cls:'g-bd', pos20, volRatio,
      title:'⛔ 市场环境偏空 —— 只允许倒T，禁止新开正T',
      detail: base + (heavy
        ? ' 指数同时跌破 MA20 与 MA60 且<b>放量</b>，属系统性走弱而非情绪回踩。这种日子里个股技术信号会被整体打折，正T低吸极容易接在半山腰。今天只做一件事：倒T（反弹到压力位先减T仓、回落再接回），或直接空仓等指数收回 MA20。'
        : ' 指数同时跌破 MA20 与 MA60，属系统性走弱。今天只做倒T（反弹到压力位先减T仓、回落再接回），或直接空仓等指数收回 MA20。') };
  }
  if (below20){
    return { level:'WARN', cls:'g-wn', pos20, volRatio,
      title:'⚠️ 指数跌回 MA20 下方 —— 做T仓位减半、止损从紧',
      detail: base + ' 指数丢了短期均线，但仍在 MA60 上方，属可修复的回调。个股方案仍可执行，但建议：T仓只用计划的 <b>一半</b>、正T止损从 −1.5% 收紧到 <b>−1.0%</b>、优先做倒T。' };
  }
  if (dry && !heavy){
    return { level:'WARN', cls:'g-wn', pos20, volRatio,
      title:'⚠️ 指数缩量整理 —— 环境许可，但个股需要更明确的信号',
      detail: base + ' 指数在 MA20 上方且量能萎缩，属"无风"状态。此时个股若无量价共振，做T容易两头挨打——建议只在个股同时满足"缩量回踩均线"或"放量突破压力"时才动手。' };
  }
  return { level:'OK', cls:'g-ok', pos20, volRatio,
    title:'✅ 市场环境中性偏多 —— 三闸门方案可正常执行',
    detail: base + (heavy ? ' 放量上行说明有增量资金进场，个股正T的成功率相对更高。' : ' 环境不构成额外约束，按个股自身信号执行即可。') };
}
/* 大盘环境对个股方案的影响：返回 null 表示无额外约束，否则返回需要追加的提示与扣分 */
export function marketEffect(g){
  if (!g) return null;
  if (g.level === 'BAD')  return { cls:'g-bd', pen:12, txt:'市场环境偏空：指数破 MA20/MA60，正T低吸风险显著上升' };
  if (g.level === 'WARN') return { cls:'g-wn', pen:5,  txt:'市场环境转弱：指数在 MA20 下方，做T仓位宜减半、止损从紧' };
  if (g.level === 'OK')   return { cls:'g-ok', pen:0,  txt:'市场环境中性偏多，不构成额外约束' };
  return null;
}

/* ---- 历史估值序列（东财 datacenter-web，CORS *）----
   这是本系统唯一能拿到的"真历史估值"来源：直接返回每日 PE_TTM / PE_LAR / PB_MRQ / PS_TTM，
   不是用「现价 ÷ 当前EPS」反推的伪分位（那样算出来的分位在数学上恒等于股价分位，没有信息量）。
   体积控制：只取需要的列并限制行数，1250 行 ≈ 173KB（取全列是 431KB）。
   缓存按自然日——估值一日只更新一次，同一天内不重复请求。 */
/* 东财 datacenter-web 的取数封装：偶发 "Failed to fetch"。
   实测同一会话内出现过"第一只票失败、第二只票成功"，属网络抖动而非接口不可用，
   所以内部重试一次（间隔 900ms）——不要因为一次抖动就把整块估值/板块标成失败。 */
async function fetchDCW(url, ms){
  let last;
  for (let k=0;k<2;k++){
    try{
      const r = await fetchT(url, ms || 15000);
      if (!r.ok) throw new Error('http ' + r.status);
      return await r.json();
    }catch(e){
      last = e;
      if (k === 0) await new Promise(res=> setTimeout(res, 900));
    }
  }
  throw last;
}
async function fetchValSeries(code, n){
  const cols = 'TRADE_DATE,PE_TTM,PE_LAR,PB_MRQ,PS_TTM,CLOSE_PRICE';
  const url = T_DCW + '?reportName=RPT_VALUEANALYSIS_DET'
    + '&columns=' + encodeURIComponent(cols)
    + '&filter='  + encodeURIComponent('(SECURITY_CODE="' + code + '")')
    + '&pageSize=' + (n||1250) + '&pageNumber=1&sortColumns=TRADE_DATE&sortTypes=-1';
  const j = await fetchDCW(url, 15000);
  const rows = ((j.result || {}).data) || [];
  return rows.map(x=>({
    d: String(x.TRADE_DATE || '').slice(0,10),
    pe: x.PE_TTM==null?null:+x.PE_TTM, pel: x.PE_LAR==null?null:+x.PE_LAR,
    pb: x.PB_MRQ==null?null:+x.PB_MRQ, ps: x.PS_TTM==null?null:+x.PS_TTM,
    close: x.CLOSE_PRICE==null?null:+x.CLOSE_PRICE
  })).reverse();                                   // 接口按日期倒序，翻成升序好做分位
}
/* 分位：历史上有多少比例的交易日 ≤ 当前值（0~100）。同比口径，含当前月。 */
function pctile(arr, x){
  const a = arr.filter(v=>v!=null && isFinite(v));
  if (!a.length || x==null || !isFinite(x)) return null;
  let c = 0; for (let i=0;i<a.length;i++) if (a[i] <= x) c++;
  return c/a.length*100;
}
function medOf(arr){ const a = arr.filter(v=>v!=null&&isFinite(v)).sort((x,y)=>x-y);
  if (!a.length) return null; const m = a.length>>1; return a.length%2 ? a[m] : (a[m-1]+a[m])/2; }
function minOf(arr){ const a = arr.filter(v=>v!=null&&isFinite(v)); return a.length ? Math.min.apply(null,a) : null; }
function maxOf(arr){ const a = arr.filter(v=>v!=null&&isFinite(v)); return a.length ? Math.max.apply(null,a) : null; }
/* 三个窗口的分位统计。窗口用交易日数近似：1年≈250、3年≈750、5年≈1250。 */
const VAL_WIN = [['1y','1年',250], ['3y','3年',750], ['5y','5年',1250]];
function valStat(all, cur){
  const o = {};
  VAL_WIN.forEach(([k,label,n])=>{
    const seg = all.slice(-n);
    o[k] = { label, pct:pctile(seg,cur), med:medOf(seg), min:minOf(seg), max:maxOf(seg),
             n:seg.filter(v=>v!=null&&isFinite(v)).length };
  });
  return o;
}
export async function loadVal(s, force){
  const today = todayStr();
  if (!force && s._val && s._val.day === today) return s._val;
  const code = codeOf(s.tcode);
  const rows = await fetchValSeries(code, 1250);
  if (!rows.length) throw new Error('该标的没有估值序列（可能上市不满一年）');
  /* ⚠️ 当前值必须取**同一序列的末行**，不能拿腾讯行情里的 PE 来配东财的历史序列。
     两家口径不同（腾讯字段39与东财 PE_TTM 未必同值），混用会出现
     "显示 PE=32 但分位按 35 算"的对不上现象。全链路统一用东财口径，并在卡片上标注数据日期。 */
  const peArr = rows.map(r=>r.pe), pbArr = rows.map(r=>r.pb), psArr = rows.map(r=>r.ps);
  const lastRow = rows[rows.length-1] || {};
  const curPe = peArr.length ? peArr[peArr.length-1] : null;
  const curPb = pbArr.length ? pbArr[pbArr.length-1] : null;
  const curPs = psArr.length ? psArr[psArr.length-1] : null;
  s._val = { day:today, at:Date.now(), rows, bars:rows.length,
    start: rows[0] ? rows[0].d : null, end: lastRow.d || null, px: lastRow.close,
    cur: { pe:curPe, pb:curPb, ps:curPs, px:lastRow.close },
    pe: valStat(peArr, curPe),
    pb: valStat(pbArr, curPb),
    ps: valStat(psArr, curPs) };
  return s._val;
}

/* ---- 个股板块归属（东财 datacenter-web：行业层级 + 概念 + 板块）----
   BOARD_TYPE 只有「行业」「板块」两种取值，概念题材的 BOARD_TYPE 为 null，
   要靠 IS_PRECISE=1（该股被精确归入）来区分。BOARD_RANK 越小越核心（1 为最核心）。 */
function secucodeOf(tcode){
  const c = codeOf(tcode);
  if (/^(6|9)/.test(c)) return c + '.SH';
  if (/^(4|8)/.test(c)) return c + '.BJ';
  return c + '.SZ';
}
async function fetchBoards(secucode){
  const cols = 'SECUCODE,SECURITY_NAME_ABBR,BOARD_CODE,BOARD_NAME,BOARD_TYPE,BOARD_RANK,IS_PRECISE';
  const url = T_DCW + '?reportName=RPT_F10_CORETHEME_BOARDTYPE'
    + '&columns=' + encodeURIComponent(cols)
    + '&filter='  + encodeURIComponent('(SECUCODE="' + secucode + '")')
    + '&pageSize=40&pageNumber=1&sortColumns=BOARD_RANK&sortTypes=1';
  const j = await fetchDCW(url, 12000);
  const rows = ((j.result || {}).data) || [];
  return rows.map(x=>({ name:x.BOARD_NAME, type:x.BOARD_TYPE, rank:+x.BOARD_RANK||99, precise:String(x.IS_PRECISE)==='1' }))
             .filter(x=>x.name);
}
export async function loadBoards(s, force){
  const today = todayStr();
  if (!force && s._bd && s._bd.day === today) return s._bd;
  const list = await fetchBoards(secucodeOf(s.tcode));
  s._bd = { day:today, at:Date.now(), list };
  return s._bd;
}

/* ---- 参照指数相对强弱（RS）----
   零额外请求：个股日K 用 s._ks（loadStock 已维护），指数日K 用 _idxK 缓存。
   参照指数的选择策略：科创板→科创50，创业板→创业板指，深市→深证成指，沪市→上证指数。 */
function refIndexFor(tcode){
  const c = codeOf(tcode);
  if (/^688/.test(c)) return 'sh000688';
  if (/^3/.test(c))   return 'sz399006';
  if (/^(0|2)/.test(c)) return 'sz399001';
  return 'sh000001';
}
export function rsCalc(s){
  const tc = refIndexFor(s.tcode), iks = _idxK[tc] || [];
  const sk = s._ks || [];
  if (sk.length < 25 || iks.length < 25) return null;
  const map = {}; iks.forEach(k=> map[k.date] = k.close);
  const pts = [];
  sk.forEach(k=>{ const ic = map[k.date]; if (ic && ic>0) pts.push({ date:k.date, rs:k.close/ic, sc:k.close, ic }); });
  if (pts.length < 22) return null;
  const vals = pts.map(p=>p.rs);
  const ma5 = maArr(vals,5);
  const cur = vals[vals.length-1];
  const r20 = vals.length>20 ? (cur/vals[vals.length-21]-1)*100 : null;
  const r60 = vals.length>60 ? (cur/vals[vals.length-61]-1)*100 : null;
  return { tc, ref:(MKT_IDX.find(x=>x[0]===tc)||[,'指数'])[1], pts, ma5, cur,
           pct:pctile(vals, cur), r20, r60, n:pts.length };
}

/* 相对强弱迷你图：RS 曲线 + MA5，基准线取区间中位数 */
export function drawRS(cv, rs){
  if (!cv || !rs) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 480, H = 64;
  cv.width = W*dpr; cv.height = H*dpr;
  const g = cv.getContext('2d'); g.setTransform(dpr,0,0,dpr,0,0);
  g.clearRect(0,0,W,H);
  const PL=6, PR=6, PT=4, PB=12, iw=W-PL-PR, ih=H-PT-PB;
  const vals = rs.pts.map(p=>p.rs).concat(rs.ma5.filter(v=>v!=null));
  let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
  if (!(hi>lo)) { hi=lo+1; lo=lo-1; }
  const pad = (hi-lo)*0.12; hi+=pad; lo-=pad;
  const X = i => PL + (rs.pts.length<2?iw/2:i/(rs.pts.length-1)*iw);
  const Y = v => PT + (hi-v)/(hi-lo)*ih;
  // 中位基准线
  const med = medOf(rs.pts.map(p=>p.rs));
  if (med!=null){ g.strokeStyle='#e5e7eb'; g.setLineDash([3,3]); g.lineWidth=1;
    g.beginPath(); g.moveTo(PL, Y(med)); g.lineTo(PL+iw, Y(med)); g.stroke(); g.setLineDash([]); }
  // RS 线
  g.strokeStyle='#7c3aed'; g.lineWidth=1.6; g.beginPath();
  rs.pts.forEach((p,i)=>{ const x=X(i), y=Y(p.rs); i?g.lineTo(x,y):g.moveTo(x,y); }); g.stroke();
  // MA5
  g.strokeStyle='#c2185b'; g.lineWidth=1.1; g.beginPath();
  let started=false;
  rs.ma5.forEach((v,i)=>{ if (v==null||i>=rs.pts.length) return; const x=X(i), y=Y(v);
    if (!started){ g.moveTo(x,y); started=true; } else g.lineTo(x,y); });
  g.stroke();
  // 末端高亮
  const lx = X(rs.pts.length-1), ly = Y(rs.cur);
  g.fillStyle = rs.r20!=null && rs.r20<0 ? '#0a7f42' : '#d32f2f';
  g.beginPath(); g.arc(lx, ly, 3, 0, Math.PI*2); g.fill();
  // 标签
  g.font='10px ui-monospace,Consolas,monospace'; g.textBaseline='alphabetic';
  g.fillStyle='#66707c'; g.fillText(f3(lo), PL, H-2); g.textAlign='right';
  g.fillText(f3(hi), PL+iw, H-2); g.textAlign='left';
}

const meanN = (a,n)=> a.length < n ? null : a.slice(-n).reduce((x,y)=>x+y,0)/n;

/* ===================== 技术指标（纯函数，可单测） ===================== */
/* EMA 平滑移动平均，MACD 的基础 */
export function emaArr(vals, n){
  if (!vals.length) return [];
  const k = 2/(n+1), out = [vals[0]];
  for (let i=1;i<vals.length;i++) out.push(vals[i]*k + out[i-1]*(1-k));
  return out;
}
/* MACD(12,26,9)：DIF=EMA12-EMA26，DEA=DIF 的 EMA9，柱=2×(DIF-DEA) */
export function macdArr(closes, fast, slow, sig){
  fast = fast||12; slow = slow||26; sig = sig||9;
  if (closes.length < slow + sig) return null;
  const e1 = emaArr(closes, fast), e2 = emaArr(closes, slow);
  const dif = closes.map((_,i)=> e1[i] - e2[i]);
  const dea = emaArr(dif, sig);
  return { dif, dea, bar: dif.map((v,i)=> (v - dea[i]) * 2) };
}
/* 均线序列（用于画线，返回与 closes 等长的数组，不足处为 null） */
export function maArr(closes, n){
  const out = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i=0;i<closes.length;i++){
    sum += closes[i];
    if (i >= n) sum -= closes[i-n];
    if (i >= n-1) out[i] = sum/n;
  }
  return out;
}
/* 布林线 BOLL(20,2)：中轨=MA20，上下轨=中轨±2 倍标准差（总体标准差，与行情软件一致） */
export function bollArr(closes, n, k){
  n = n || 20; k = k || 2;
  const mid = maArr(closes, n);
  const up = new Array(closes.length).fill(null), dn = new Array(closes.length).fill(null);
  for (let i = n-1; i < closes.length; i++){
    let s = 0;
    for (let j = i-n+1; j <= i; j++) s += Math.pow(closes[j]-mid[i], 2);
    const sd = Math.sqrt(s/n);
    up[i] = mid[i] + k*sd; dn[i] = mid[i] - k*sd;
  }
  // 带宽 BW%：(上轨−下轨)/中轨 —— 判断"挤压/扩张"的常用标尺
  const bw = mid.map((m,i)=> (m && up[i]!=null) ? (up[i]-dn[i])/m*100 : null);
  return { mid, up, dn, bw };
}
/* RSI（Wilder 平滑）：RSI = 100 − 100/(1+平均涨幅/平均跌幅) */
export function rsiArr(closes, n){
  n = n || 14;
  const out = new Array(closes.length).fill(null);
  if (closes.length <= n) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++){ const d = closes[i]-closes[i-1]; if (d >= 0) g += d; else l -= d; }
  let ag = g/n, al = l/n;
  out[n] = al === 0 ? 100 : 100 - 100/(1 + ag/al);
  for (let i = n+1; i < closes.length; i++){
    const d = closes[i]-closes[i-1];
    ag = (ag*(n-1) + (d > 0 ? d : 0))/n;
    al = (al*(n-1) + (d < 0 ? -d : 0))/n;
    out[i] = al === 0 ? 100 : 100 - 100/(1 + ag/al);
  }
  return out;
}
/* 真实波幅 ATR —— 衡量"这个票一天能走多大"，是做T空间的客观度量 */
function atrArr(ks, n){
  n = n || 14;
  if (ks.length < n+1) return null;
  const tr = [];
  for (let i=1;i<ks.length;i++){
    const h=ks[i].high, l=ks[i].low, pc=ks[i-1].close;
    tr.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
  }
  // Wilder 平滑
  let a = tr.slice(0,n).reduce((x,y)=>x+y,0)/n;
  const out = [a];
  for (let i=n;i<tr.length;i++){ a = (a*(n-1) + tr[i])/n; out.push(a); }
  return out;
}
/* 取"历史"部分：只有末根确实是今天时才排除它（否则周末打开会把最近一个交易日漏掉） */
function histOf(ks){
  if (!ks || !ks.length) return [];
  return (ks[ks.length-1].date === todayStr()) ? ks.slice(0, -1) : ks;
}
/* 箱体识别：取最近 n 根（不含今日）的高低点作箱顶箱底
   返回箱顶/箱底/箱高%/现价在箱内的位置(0=箱底,100=箱顶)/是否向上突破/是否向下破位 */
function boxOf(ks, n, price){
  n = n || 20;
  const hist = histOf(ks);                         // 不含今日，避免把今天的波动算进箱体
  if (hist.length < n) return null;
  const seg = hist.slice(-n);
  const top = Math.max(...seg.map(k=>k.high));
  const bot = Math.min(...seg.map(k=>k.low));
  if (!(top > bot)) return null;
  const pos  = (price - bot) / (top - bot) * 100;  // 位置%
  const up   = price > top * 1.005;                // 上破（留 0.5% 容错，避免假突破误判）
  const down = price < bot * 0.995;                // 下破
  // 箱体是否收敛：最近 5 根的振幅 vs 前 15 根
  const rec = seg.slice(-5), ear = seg.slice(0, -5);
  const amp = arr => { const t=Math.max(...arr.map(k=>k.high)), b=Math.min(...arr.map(k=>k.low)); return (t-b)/b; };
  const shrink = ear.length >= 5 && amp(rec) < amp(ear) * 0.8;
  return { n, top, bot, pos, up, down, shrink, height:(top-bot)/bot*100 };
}
const last = (a)=>{ for (let i=a.length-1;i>=0;i--) if (a[i]!==null && a[i]!==undefined && !Number.isNaN(a[i])) return a[i]; return null; };

/* 支撑位 / 压力位：把"可能有人接盘 / 有人抛压"的价位全部列出来，按权重排序取最近三档。
   候选来源：20/60日箱体上下沿、布林上中下轨、MA5/10/20/60、20/60日极值、持仓成本。
   合并规则：相邻 0.6% 以内的价位视为同一档（避免 MA10 与 20日高点挤在一起刷屏）。 */
function levelsOf(ks, ta, price, cost){
  const hist = histOf(ks || []);
  if (hist.length < 20 || !(price > 0)) return { res:[], sup:[], all:[] };
  const closes = hist.map(k=>k.close);
  const boll = bollArr(closes, 20, 2);
  const bi = closes.length - 1;
  const seg20 = hist.slice(-20), seg60 = hist.slice(-Math.min(60, hist.length));
  const raw = [];
  const push = (p, label, w)=>{ if (p > 0 && isFinite(p)) raw.push({ p:+p, label, w, bw:w }); };

  if (ta && ta.box20){ push(ta.box20.top,'20日箱顶',3); push(ta.box20.bot,'20日箱底',3); }
  if (ta && ta.box60){ push(ta.box60.top,'60日箱顶',4); push(ta.box60.bot,'60日箱底',4); }
  if (boll.up[bi] != null){
    push(boll.up[bi],'布林上轨',2);
    push(boll.mid[bi],'布林中轨',3);
    push(boll.dn[bi],'布林下轨',2);
  }
  if (ta){
    push(ta.v5,'MA5',2); push(ta.v10,'MA10',2); push(ta.v20,'MA20',3); push(ta.v60,'MA60',4);
  }
  push(Math.max(...seg20.map(k=>k.high)), '20日高点', 3);
  push(Math.min(...seg20.map(k=>k.low )), '20日低点', 3);
  if (seg60.length >= 40){
    push(Math.max(...seg60.map(k=>k.high)), '60日高点', 5);
    push(Math.min(...seg60.map(k=>k.low )), '60日低点', 5);
  }
  if (+cost > 0) push(+cost, '持仓成本', 3);

  raw.sort((a,b)=> a.p - b.p);
  const merged = [];
  raw.forEach(r=>{
    const m = merged[merged.length-1];
    if (m && Math.abs(r.p - m.p)/price < 0.006){
      m.w += r.w;
      if (r.bw > m.bw){ m.bw = r.bw; m.label = r.label; }
      m.p = (m.p + r.p)/2;
    } else merged.push({ p:r.p, w:r.w, bw:r.bw, label:r.label });
  });
  const deco = l => ({ p:l.p, label:l.label, w:l.w, strength: l.w >= 6 ? '强' : l.w >= 4 ? '中' : '弱',
                       dist:(l.p - price)/price*100 });
  const res = merged.filter(l=> l.p >  price*1.001).sort((a,b)=> a.p - b.p).slice(0,3).map(deco);
  const sup = merged.filter(l=> l.p <  price*0.999).sort((a,b)=> b.p - a.p).slice(0,3).map(deco);
  return { res, sup, all: merged.map(deco) };
}

/* 拉取并写入某只股票（行情与均线互不牵连：均线失败不影响行情落地） */
export async function loadStock(s){
  if (!s.tcode) s.tcode = s.secid ? tencentCode(s.secid) : tcodeFromCode(s.code);
  if (!s.tcode) throw new Error('缺少股票代码，请删掉重新添加');
  const tc = s.tcode;

  let q = null, lastErr = null;
  for (let attempt = 0; attempt < 3 && !q; attempt++){
    if (attempt) await new Promise(r => setTimeout(r, 700 * attempt));
    try{
      const r = await fetchQuotes([tc]);
      if (r[tc] && r[tc].prevClose) q = r[tc];
      else lastErr = new Error('未取到行情（可能停牌或代码有误）');
    }catch(e){ lastErr = e; }
  }
  if (!q) throw lastErr || new Error('行情接口不可达');

  const px = q.price > 0 ? q.price : q.prevClose;        // 停牌 / 未开盘兜底
  const hi = q.high > 0 ? q.high : px, lo = q.low > 0 ? q.low : px;

  /* 手改保护：用户手填过价格（断网、或试算"如果涨到 24 我怎么操作"），
     60 秒后的自动刷新原本会静默盖掉它。这里跳过被标记为手动的字段，
     并在输入框上打黄色标记 + 提供「⟲ 恢复行情值」按钮，让状态始终可见。 */
  const man = s.manual || {};
  const upd = {
    name: q.name || s.name, code: q.code || s.code,
    prevClose:q.prevClose, open:q.open || q.prevClose, high:hi, low:lo,
    price:px, avg:q.avg || px, vr:q.vr || 1,
    to:q.to || 0, pe:q.pe || 0, pb:q.pb || 0, mcap:q.mcap || 0, floatSh:q.floatSh || 0,
    vol:q.vol || 0, amt:q.amt || 0, outer:q.outer || 0, inner:q.inner || 0,
    _t: nowStr()
  };
  AUTO_FIELDS.forEach(k=>{ if (man[k]) delete upd[k]; });   // 代码/名称始终同步
  Object.assign(s, upd);

  // 日K 单独取，失败只标记不报错（均线 / K线图 / 指标 全部共用这一份数据）
  let maOk = false;
  try{
    const kl = await fetchKline(tc);
    if (kl.length >= 5){
      const closes = kl.map(k => k.close);
      /* 只有"今天确实有交易"时才把今日并入 K 线序列。
         判据用行情返回的时间戳（f[30]，形如 20260917161242）而不是"今天是几号"——
         否则周六打开页面会凭空插出一根日期为周六、价格等于周五收盘的假 K 线，
         既污染均线也污染箱子图。 */
      const hasToday = String(q.time || '').slice(0,8) === todayStr().replace(/-/g,'');
      if (kl[kl.length-1].date === todayStr()){
        closes[closes.length-1] = px;                     // 末根已是今天 → 用实时价覆盖收盘
        kl[kl.length-1].close = px; kl[kl.length-1].high = Math.max(kl[kl.length-1].high, hi);
        kl[kl.length-1].low  = Math.min(kl[kl.length-1].low, lo);
      } else if (hasToday){
        kl.push({ date:todayStr(), open:s.open, close:px, high:hi, low:lo, vol:0, _live:true });
        closes.push(px);                                  // K线源尚未更新，用实时价补一根
      }
      // 非交易日：K线末根本就是最近交易日，原样使用，不补不改
      s._ks = kl;                                         // 完整 K 线，供绘图与指标计算
      s._k = s._k || {};
      s._k['day'] = chartEntry('bar', { ks: s._ks });
      const m5 = meanN(closes,5), m10 = meanN(closes,10), m20 = meanN(closes,20), m60 = meanN(closes,60);
      /* 写回前必须四舍五入到 2 位：均线是若干个浮点收盘价的平均，
         原样落盘会得到 22.997999999999998 这种 17 位尾巴，再通过
         value="${s[k]}" 直接进可编辑输入框 —— 而用户是要从这里复制数字去挂单的。
         一个被券商拒单、或成交在自己都没算清位置的挂单价，足以让整套系统失去价值。 */
      const fx = v => (v == null || !isFinite(v)) ? v : +(+v).toFixed(2);
      if (m5  !== null && !man.ma5)  s.ma5  = fx(m5);
      if (m10 !== null && !man.ma10) s.ma10 = fx(m10);
      if (m20 !== null && !man.ma20) s.ma20 = fx(m20);
      if (!man.ma20) s.ma60 = fx(m60);
      maOk = (m5 !== null && m10 !== null && m20 !== null);
    }
  }catch(_){}
  s._maOk = maOk;
  /* 分时量能（第二层）：m5 同时段基准。单独取数、失败只降级，
     不能因为"量能基准挂了"就把整只票的行情和均线一起判为取数失败。 */
  try{ await loadVolMin(s, false); }catch(_){}
  return s;
}

/* ===================== 技术面体检（从 K 线算出全部指标 + 可操作结论） =====================
   设计原则：每个指标都必须落到"所以呢"——不只是报数值，而是给出多空倾向和具体价位。 */
export function computeTA(s){
  const ks = s._ks;
  if (!ks || ks.length < 30) return null;
  const closes = ks.map(k=>k.close);
  const price  = +s.price || closes[closes.length-1];
  const n = closes.length;

  // ---- 均线 ----
  const mA = { ma5:maArr(closes,5), ma10:maArr(closes,10), ma20:maArr(closes,20), ma60:maArr(closes,60) };
  const v5 = mA.ma5[n-1], v10 = mA.ma10[n-1], v20 = mA.ma20[n-1], v60 = mA.ma60[n-1];
  const v20p = mA.ma20[n-2];
  const ma20Rising = (v20!=null && v20p!=null) ? v20 > v20p : null;      // MA20 方向
  let arrange = '未知';
  if (v5!=null && v10!=null && v20!=null){
    if (v5>v10 && v10>v20 && (v60==null || v20>v60)) arrange = '多头排列';
    else if (v5<v10 && v10<v20 && (v60==null || v20<v60)) arrange = '空头排列';
    else arrange = '均线纠缠';
  }

  // ---- MACD ----
  const macd = macdArr(closes);
  let macdSig = null;
  if (macd){
    const i = n-1;
    const dif = macd.dif[i], dea = macd.dea[i], bar = macd.bar[i];
    const difP = macd.dif[i-1], deaP = macd.dea[i-1], barP = macd.bar[i-1];
    const golden = difP <= deaP && dif > dea;     // 金叉
    const dead   = difP >= deaP && dif < dea;     // 死叉
    // 柱状体连续放大/缩小
    let grow = 0;
    for (let k=i; k>0 && Math.sign(macd.bar[k])===Math.sign(macd.bar[i]) && Math.abs(macd.bar[k])>Math.abs(macd.bar[k-1]); k--) grow++;
    macdSig = { dif, dea, bar, golden, dead, above0: dif>0, grow,
                // 顶背驰：价创新高但 DIF 未创新高（近 20 根内）
                diverge: (()=>{
                  const w = 20, s0 = Math.max(0, n-w);
                  let hiI = s0; for (let k=s0;k<n;k++) if (closes[k] > closes[hiI]) hiI = k;
                  let difMax = -Infinity, difMaxI = s0;
                  for (let k=s0;k<n;k++) if (macd.dif[k] > difMax){ difMax = macd.dif[k]; difMaxI = k; }
                  return (hiI > difMaxI + 2) && (closes[hiI] > closes[s0]*1.02);
                })() };
  }

  // ---- 箱体 ----
  const box20 = boxOf(ks, 20, price);
  const box60 = boxOf(ks, 60, price);

  // ---- 波动率 ATR ----
  const atr = atrArr(ks, 14);
  const atrV = atr ? last(atr) : null;
  const atrPct = atrV ? atrV/price*100 : null;

  // ---- 量能：今日量 vs 5日均量 ----
  const vols = ks.map(k=>k.vol||0);
  const todayVol = vols[n-1], avg5 = meanN(vols.slice(0,-1), 5);
  const volRatio = (avg5 && todayVol) ? todayVol/avg5 : null;
  /* 时段量能达成率 = 今日累计量 ÷（5日均量 × 当前时点应完成占比）—— 这才是「及不及预期」。
     量比做的是「每分钟均量」归一，达成率做的是「日内真实分布」归一，两者不是一回事，
     差一个系数（线性进度 ÷ U型进度），而且这个系数随时点变化。
     具体到 10:00：若今日累计量已达 5 日均量的 25%，
       旧口径（线性 12.5%）给出 2.00 倍 → 看起来像爆量；
       新口径（U 型 20.0%）给出 1.25 倍 → 实际只是「略超预期」。
     所以量能这一项不能只看量比，也不能只看达成率，两个并排看才不会有错觉。 */
  const volShare = sessionProgress();
  const volProgress = (volRatio != null && volShare > 0.03) ? volRatio / volShare : null;
  const volState = volProgress == null ? null
    : volProgress >= 1.5 ? 'heavy'
    : volProgress >= 1.2 ? 'above'
    : volProgress >= 0.8 ? 'normal'
    : volProgress >= 0.6 ? 'below' : 'light';

  // ---- 布林线 BOLL(20,2) ----
  const boll = bollArr(closes, 20, 2);
  const bl = { up:boll.up[n-1], mid:boll.mid[n-1], dn:boll.dn[n-1], bw:boll.bw[n-1] };
  const bwPrev = boll.bw[n-6];
  // %B：现价在布林通道中的位置（0=下轨 1=上轨），比单看上下轨更直观
  const pctB = (bl.up != null && bl.up > bl.dn) ? (price - bl.dn)/(bl.up - bl.dn) : null;
  // 开口/收口：近 5 日带宽相对 5 日前的变化
  const bwDelta = (bl.bw != null && bwPrev) ? (bl.bw - bwPrev)/bwPrev*100 : null;

  // ---- RSI(6/12/24) ----
  const rsi6 = rsiArr(closes,6), rsi12 = rsiArr(closes,12), rsi24 = rsiArr(closes,24);
  const r = { r6:last(rsi6), r12:last(rsi12), r24:last(rsi24) };

  // ---- 换手率：优先用行情给的官方值，缺失时用「成交量/流通股本」自己算 ----
  const floatSh = +s.floatSh || 0;
  const toCalc = floatSh > 0 ? todayVol*100/floatSh*100 : null;

  // ---- 支撑位 / 压力位 ----
  const lv = levelsOf(ks, { box20, box60, v5, v10, v20, v60 }, price, s.cost);

  // ---- 破位判定（三档，权重不同）----
  const breaks = [];
  if (box20 && box20.down)  breaks.push({ lv:'严重', t:`跌破20日箱底 ${f2(box20.bot)}`, d:'箱体结构破坏，做T立即停止，等重新站回箱内再谈' });
  if (v20!=null && price < v20 && ma20Rising===false) breaks.push({ lv:'严重', t:`失守 MA20(${f2(v20)}) 且 MA20 转头向下`, d:'中期趋势转弱，禁止低吸，只允许反弹减仓' });
  if (v60!=null && price < v60) breaks.push({ lv:'中等', t:`跌破 MA60(${f2(v60)})`, d:'生命线失守，仓位应主动降低' });
  if (s.cost > 0 && price < +s.cost) breaks.push({ lv:'中等', t:`跌破持仓成本 ${f2(+s.cost)}`, d:'做T只为摊薄成本，此时"接回"等于逆势加仓，要格外克制' });
  const ma20Slope = (v20!=null && v20p!=null) ? (v20-v20p)/v20p*100 : null;
  // 假破位：盘中最低跌破箱底但收盘收回箱内
  const lastK = ks[n-1];
  if (box20 && lastK.low < box20.bot && price > box20.bot) breaks.push({ lv:'提示', t:'盘中破位、收盘收回', d:'典型的"假破位诱空"，若次日不再跌破，反而是短线机会' });
  // 布林 / RSI 补充提示
  if (bl.dn != null && price < bl.dn) breaks.push({ lv:'中等', t:'跌破布林下轨 ' + f2(bl.dn), d:'短线已进入超卖区，但“超卖”不等于“见底”——要等出现缩量止跌K线再谈低吸' });
  if (bl.up != null && price > bl.up) breaks.push({ lv:'提示', t:'上冲布林上轨 ' + f2(bl.up), d:'短线进入超买区，正T不宜在此追买，反而是倒T减仓的位置' });
  if (r.r6 != null && r.r6 < 20) breaks.push({ lv:'提示', t:'RSI6 = ' + r.r6.toFixed(1) + ' 进入超卖', d:'超卖后反弹概率上升；但趋势向下时“超卖可以更超卖”，只宜小仓快进快出' });
  if (r.r6 != null && r.r6 > 85) breaks.push({ lv:'提示', t:'RSI6 = ' + r.r6.toFixed(1) + ' 进入超买', d:'短线情绪过热，优先兑现浮盈，不追高' });

  // ---- 技术面评分（0~100，只做多空参考，不替代三闸门）----
  let sc = 50;
  if (arrange==='多头排列') sc += 15; else if (arrange==='空头排列') sc -= 18;
  if (macdSig){ if (macdSig.golden) sc += 12; if (macdSig.dead) sc -= 12;
                sc += macdSig.above0 ? 6 : -6; }
  if (box20){ if (box20.up) sc += 10; else if (box20.down) sc -= 15;
              else sc += Math.round((box20.pos - 50) * 0.12); }
  if (ma20Rising===true) sc += 7; else if (ma20Rising===false) sc -= 7;
  if (volRatio!=null) sc += (volRatio > 1.5 && price > (+s.prevClose)) ? 6 : (volRatio<0.8 ? 2 : 0);
  if (pctB != null) sc += (pctB > 1.02 ? 5 : (pctB < 0.05 ? 4 : Math.round((pctB - 0.5)*6)));
  if (r.r6 != null) sc += (r.r6 >= 85 ? -6 : (r.r6 > 55 ? 5 : (r.r6 < 25 ? -2 : 0)));
  sc = Math.max(0, Math.min(100, sc));

  return { v5,v10,v20,v60, mA, ma20Rising, ma20Slope, arrange, macd:macdSig,
           /* 绘图用的完整序列（macdSig.dif 是"当前值"，这里是"整条线"，两者不能混用） */
           macdSeries: macd ? { dif:macd.dif, dea:macd.dea, bar:macd.bar } : null,
           bollSeries: boll, bl, pctB, bwDelta,
           rsiSeries:{ r6:rsi6, r12:rsi12, r24:rsi24 }, r,
           turnover:(+s.to || toCalc), toCalc, floatSh,
           levels: lv,
           box20, box60, atrV, atrPct, volRatio, volProgress, volState, volShare, breaks, score:sc };
}

/* 落盘：只存"人填的"和"选择的"，绘图用的 K 线 / 指标 / 分时 / 逐笔缓存一律不存
   —— 它们体积大（单只四个周期就可能上万字符），存进去会撑爆 localStorage 配额。 */
function savePool(){
  try{
    const slim = pool.map(s=>{
      const o = {};
      Object.keys(s).forEach(k=>{ if (k.charAt(0) !== '_') o[k] = s[k]; });
      return o;
    });
    localStorage.setItem('t-system-pool', JSON.stringify(slim));
  }catch(_){}
}

/* 刷新全部 */
async function refreshAll(silent){
  const st = document.getElementById('dbStatus');
  if (!pool.length){ st.className='db-status'; st.textContent='自选池是空的 —— 在上面输入代码或名称添加。'; return; }
  if (!silent){ st.className='db-status'; st.textContent='正在获取行情…'; }
  const errs = [];
  // 市场环境（第四条闸门）：2 个请求（指数行情 + 指数日K组）。失败不阻塞个股，闸门会显示"数据不足"
  const mktTask = (async ()=>{ try{ await loadMarket(false); renderMarket(); }catch(e){ console.warn('[市场环境] ' + e.message); } })();
  // 每只票一组请求，票与票之间并发：原来是 i 只票 × 3~4 个请求依次排队，
  // 票一多总耗时线性叠加；并发后总耗时≈最慢的那只。每只票内部仍保持 行情→图表→研究 的顺序。
  const stockTasks = pool.map(async s=>{
    try{
      await loadStock(s);
      await loadChart(s, true);                       // 只取"当前所选周期"的图表数据，不预取全部周期
      await loadResearch(s, false);                   // 估值序列(按日缓存) + 板块归属(按日缓存)
      if (s.ddOn){ try{ await loadDD(s); }catch(_){} }  // 大单资金：已开启才刷，且自带 90 秒节流
      return null;
    }catch(e){ return (s.name||s.code) + '（' + e.message + '）'; }
  });
  const results = await Promise.all([mktTask, ...stockTasks]);
  results.slice(1).forEach(x=>{ if (x) errs.push(x); });
  render(pool); savePool();
  // 时效戳：只要有一只票取到了就推进。全军覆没则不动 —— 顶部会转黄，明示"你看到的是旧数据"。
  if (errs.length < pool.length) stampData();
  if (errs.length){ st.className='db-status err'; st.textContent='部分未更新 → ' + errs.join('；'); }
  else { st.className='db-status'; st.innerHTML = '行情已更新 <b>' + nowStr() + '</b>　·　来源：腾讯实时行情 + 腾讯前复权K线（日/周/月/分钟）+ 腾讯逐笔明细'; }
  checkPriceAlerts();    // 到价提醒：标题栏永远生效，桌面通知需授权
  checkMarketAlerts();   // 大盘异动：5 分钟窗口 + 按振幅标准化
  autoSnapshot();      // 收盘后自动落一条快照，省得忘记点
}

/* 收盘自动快照：交易日 15:05 之后、当天还没记录时自动补一条。
   只在有持仓时记录；记录的是当时行情，收盘后取到的即为收盘价。 */
function autoSnapshot(){
  const d = new Date(), mins = d.getHours()*60 + d.getMinutes(), wd = d.getDay();
  if (wd < 1 || wd > 5 || mins < 15*60+5) return;
  const today = todayStr();
  if ((SNAP||[]).some(x => x.date === today)) return;
  if (!pool.some(s => Math.round(+s.shares||0) > 0)) return;
  const r = takeSnapshot();
  if (r){ renderAccount();
  renderTailBuySection(); console.log('[自动快照] 已记录 ' + r.date + '：总资产 ' + r.total); }
}

/* 网络自检：三条链路分别探测，把"哪个环节断了"一次说清 */
export async function selfTest(){
  const st = document.getElementById('dbStatus');
  st.className='db-status'; st.textContent = '正在自检三条链路…';
  const rows = [];
  const probe = async (label, fn)=>{
    const t0 = Date.now();
    try{ const n = await fn(); rows.push([label, n > 0, Date.now()-t0, n > 0 ? '' : '返回空数据']); }
    catch(e){ rows.push([label, false, Date.now()-t0, e.message]); }
  };
  await probe('行情　qt.gtimg.cn',       async ()=> (await fetchQuotes(['sh605128'])).sh605128 ? 1 : 0);
  await probe('检索　proxy.finance.qq.com', async ()=> (await searchTencent('上海沿浦')).length);
  await probe('日K　ifzq.gtimg.cn',       async ()=> (await fetchKline('sh605128')).length);
  await probe('周K　ifzq.gtimg.cn',       async ()=> (await fetchKlineBig('sh605128','week',20)).length);
  await probe('月K　ifzq.gtimg.cn',       async ()=> (await fetchKlineBig('sh605128','month',20)).length);
  await probe('分钟K 15分',               async ()=> (await fetchKlineMin('sh605128','m15',20)).length);
  await probe('分钟K 5分（量能基准）',     async ()=> (await fetchKlineMin('sh605128','m5',482)).length);
  await probe('分时　web.ifzq.gtimg.cn',  async ()=> (await fetchMinute('sh605128')).pts.length);
  await probe('逐笔　stock.gtimg.cn',     async ()=> (await fetchDetail('sh605128', 8)).recs.length);
  await probe('指数　qt.gtimg.cn',        async ()=> (await fetchQuotes(['sh000001'])).sh000001 ? 1 : 0);
  await probe('指数日K ifzq',             async ()=> (await fetchKlineBig('sh000001','day',30)).length);
  await probe('估值　datacenter-web',     async ()=> (await fetchValSeries('605128', 60)).length);
  await probe('板块　datacenter-web',     async ()=> (await fetchBoards('605128.SH')).length);
  const ok = rows.every(r => r[1]);
  st.className = ok ? 'db-status' : 'db-status err';
  st.innerHTML = rows.map(r =>
    (r[1] ? '✅' : '❌') + ' ' + r[0] + '　' + (r[1] ? '正常' : '失败') + '　' + r[2] + 'ms' + (r[3] ? '　' + r[3] : '')
  ).join('<br>') + (ok ? '<br>十三条链路全通：行情 / 检索 / 日周月K / 分钟K / 分时 / 分时量能基准 / 逐笔大单 / 指数 / 指数日K / 历史估值 / 板块归属 全部可用。'
                       : '<br>结论：检索挂了不影响使用 —— 直接输 <b>6 位代码</b>（如 605128）添加即可，这条路在本地换算，不走检索接口。<br>'
                         + '指数/估值/板块三条是新链路，若失败则第四条闸门、估值分位、板块归属会显示"数据不足"，不影响三闸门与做T价位计算。');
}

/* 添加自选：能本地解析的代码，绝不依赖检索接口 */
export async function addByQuery(q){
  const st  = document.getElementById('dbStatus');
  const box = document.getElementById('dbCands');
  box.innerHTML = '';

  /* 快路径：纯 6 位代码 / sh605128 形式 —— 本地算 tcode，零网络检索 */
  const direct = tcodeFromInput(q);
  if (direct){
    const code = codeOf(direct);
    if (pool.some(s => s.code === code)){
      st.className='db-status err'; st.textContent = code + ' 已经在自选池里了。'; return;
    }
    st.className='db-status'; st.textContent = '按代码直接添加 ' + direct + ' …';
    await adoptCandidate({ name:'', code, tcode:direct });
    return;
  }

  /* 常规路径：名称 / 拼音首字母 / 部分代码 → 走检索 */
  st.className='db-status'; st.textContent = '正在检索「' + q + '」…';
  let list;
  try{ list = await searchTencent(q); }
  catch(e){
    st.className='db-status err';
    st.innerHTML = '检索接口连不上（' + e.message + '）。<br>不必等它 —— 直接输 <b>6 位代码</b>（如 605128）即可添加，<b>这条路径不走检索，一定可用</b>。';
    return;
  }
  if (!list.length){ st.className='db-status err'; st.textContent = '没找到匹配的 A 股「' + q + '」，可换名称、拼音首字母（如 shyp），或直接输 6 位代码。'; return; }
  if (list.length > 1){
    box.innerHTML = list.map((x,i)=>`<button data-cand="${i}">${x.name} ${x.code}${x.market?'·'+x.market:''}</button>`).join('');
    box.querySelectorAll('button[data-cand]').forEach(b=>{
      b.onclick = ()=> adoptCandidate(list[+b.dataset.cand]);
    });
    st.textContent = '找到 ' + list.length + ' 个结果，点一个加入自选：';
    return;
  }
  await adoptCandidate(list[0]);
}

export async function adoptCandidate(c){
  const st = document.getElementById('dbStatus');
  if (pool.some(s => s.code === c.code)){
    st.className='db-status err'; st.textContent = (c.name||c.code) + ' 已经在自选池里了。'; return;
  }
  document.getElementById('dbCands').innerHTML = '';
  pool.push({ name:c.name || c.code, code:c.code, tcode:c.tcode,
              prevClose:0, open:0, high:0, low:0, price:0, avg:0, vr:1,
              ma5:null, ma10:null, ma20:null, shares:0, cost:0, cap:0 });
  const s = pool[pool.length-1];
  try{
    await loadStock(s);
    st.className='db-status';
    st.innerHTML = '已加入 <b>'+s.name+' '+s.code+'</b>，行情已同步' + (s._maOk ? '（含均线）' : '（均线未同步，可点 ⟳ 重试）') + '。';
  }
  catch(e){ st.className='db-status err'; st.textContent = '已加入 ' + s.code + '，但取数失败：' + e.message; }
  render(pool); savePool();
}

/* 交易时段自动刷新 */
let _timer = null;
export function setupTimer(){
  if (_timer){ clearInterval(_timer); _timer = null; }
  const autoEl = document.getElementById('dbAuto');
  if (!autoEl || !autoEl.checked) return;
  _timer = setInterval(()=>{
    const d = new Date(), mins = d.getHours()*60 + d.getMinutes(), wd = d.getDay();
    if (wd < 1 || wd > 5 || mins < 9*60+15 || mins > 15*60+5) return;
    const ae = document.activeElement;                        // 正在输入时不打断
    // 守卫补上 #dbInput：正在检索框里打字时同样不能被整页重绘打断
    if (ae && ae.closest && (ae.closest('#pool') || ae.closest('#logTable') || ae.closest('#dbInput') || ae.closest('#quickTModal'))) return;
    refreshAll(true);
  }, 60000);
}

/* ===================== 核心计算 ===================== */
export function calc(s){
  const pc   = +s.prevClose;
  const amp  = pc ? (+s.high - +s.low) / pc * 100 : 0;   // 日内振幅%
  const grid = amp / GRID;                                // 折合格数
  const chg  = pc ? (+s.price - pc) / pc * 100 : 0;       // 现价涨跌幅%
  const vsAvg= (+s.avg) ? (+s.price - +s.avg) / +s.avg * 100 : null;
  const vr   = +s.vr || 0;

  // 日线趋势
  const ma5=+s.ma5||0, ma10=+s.ma10||0, ma20=+s.ma20||0;
  const hasMA = ma5>0 && ma10>0 && ma20>0;
  const bear  = hasMA && ma5<ma10 && ma10<ma20 && +s.price<ma5;   // 空头排列且价在均线下
  const bull  = hasMA && ma5>ma10 && ma10>ma20 && +s.price>ma5;   // 多头排列
  const trend = !hasMA ? '未知' : (bull ? '多头' : (bear ? '空头' : '震荡'));

  // 七格价格阶梯（以昨收为基准的预案挂单价）
  const L = k => pc * (1 + k*GRID/100);

  // ---- 闸门1：格位 ----
  let gate1, g1cls;
  if (grid < 3)       { gate1 = `振幅 ${amp.toFixed(2)}%（${grid.toFixed(1)}格）不足3格 → 波段空间不够，扣手续费后无利润`; g1cls='wait'; }
  else if (grid < 6)  { gate1 = `振幅 ${amp.toFixed(2)}%（${grid.toFixed(1)}格）落在黄金做T区间 3–6格`; g1cls='ok'; }
  else                { gate1 = `振幅 ${amp.toFixed(2)}%（${grid.toFixed(1)}格）超过6格 → 情绪透支，只减不新开`; g1cls='warn'; }

  // ---- 闸门2：趋势 ----
  let gate2 = `日线${trend}（MA5 ${f2(ma5)} / MA10 ${f2(ma10)} / MA20 ${f2(ma20)}）`;

  // ---- 闸门3：量能 ----
  const heavy = vr >= 1.5, light = vr < 1.0;
  let gate3 = `量比 ${f2(vr)} → ` + (heavy ? '放量' : (light ? '缩量' : '中性'));

  // ---- 确定价位：以"现价所处格位"为锚，上下各取两格（每日自动跟随，无需手调） ----
  const gNow = chg / GRID;
  const kUp1 = Math.floor(gNow) + 1, kUp2 = kUp1 + 1;   // 现价上方两格 = 压力位
  const kDn1 = Math.ceil(gNow)  - 1, kDn2 = kDn1 - 1;   // 现价下方两格 = 支撑位
  const inA  = L(kDn1), inB = L(kDn2);                  // 正T买入区
  const outA = L(kUp1), outB = L(kUp2);                 // 倒T卖出区
  const bkA  = inA, bkB = inB;                          // 倒T接回位
  const tp1  = inA * 1.03;                              // 正T第一止盈 +3%
  const tp2  = Math.max(tp1, Math.min(inA * 1.06, pc * (1 + GRID/100)));// 正T第二止盈，不越过 +1.33% 格
  const slA  = inA * (1 - STOP), slB = inB * (1 - STOP);// 正T止损 -1.5%
  const fly  = outA * (1 + FLY);                        // 卖飞线
  const gain1 = (tp1 - inA)/inA*100, gain2 = (tp2 - inA)/inA*100;

  // ---- 综合结论 ----
  const below = vsAvg !== null && vsAvg < 0;
  let mode, vcls, title, detail;
  if (grid < 3){
    mode='WAIT'; vcls='v-wait';
    title = '⛔ 今日不做T —— 观望';
    detail = `日内振幅只有 ${amp.toFixed(2)}%，不够 4%（3格）的门槛。这个波动里做T赚的差价还不够手续费，强行操作只会踏错节奏。`;
  } else if (bear){
    mode='REV'; vcls='v-warn';
    title = '⚠️ 日线空头，只允许「倒T」（反弹减仓），禁止低吸接飞刀';
    detail = `价格 ${f2(+s.price)} 位于 MA5(${f2(ma5)}) / MA10(${f2(ma10)}) / MA20(${f2(ma20)}) 之下且均线空头发散，正踩在铁律第一条「趋势优先，逆势不伸手」上。今天唯一可做：反弹到 <b>${f2(outA)} ~ ${f2(outB)}</b> 无量滞涨时先减T仓，回落到 <b>${f2(bkA)} / ${f2(bkB)}</b> 缩量企稳再接回；<b>不主动在下跌途中低吸</b>。`;
  } else if (below && heavy){
    mode='WAIT'; vcls='v-warn';
    title = '⛔ 放量下行，暂不接 —— 等缩量企稳';
    detail = `现价在分时均线 ${f2(+s.avg)} 下方 ${Math.abs(vsAvg).toFixed(2)}%，同时量比 ${f2(vr)} 属于放量。按口诀「放量急跌是陷阱」，这波下跌是真抛压在出逃，不是情绪。等量能萎缩、分时白线走平，再在 <b>${f2(inA)}</b> 挂第一份。`;
  } else if (below && !heavy){
    mode='BUY'; vcls='v-buy';
    title = '✅ 正T信号 —— 缩量回踩，分三份低吸';
    detail = `现价在分时均线 ${f2(+s.avg)} 下方且量比 ${f2(vr)} 未放大，符合「缩量急跌是机会」。第一份挂 <b>${f2(inA)}</b>、第二份挂 <b>${f2(inB)}</b>、第三份留给尾盘企稳；到位后目标 <b>${f2(tp1)}</b>（${gain1.toFixed(1)}%）T出，跌破 ${f2(slA)} 无条件砍。`;
  } else if (!below && light){
    mode='REV'; vcls='v-go';
    title = '✅ 倒T信号 —— 无量拉升，先卖后买';
    detail = `现价站在分时均线 ${f2(+s.avg)} 上方，量比仅 ${f2(vr)}，「无量拉升全是耍流氓」。在 <b>${f2(outA)}</b> 减第一份、<b>${f2(outB)}</b> 减第二份，回落 <b>${f2(bkA)}</b> 分批接回；若放量突破 ${f2(fly)} 即认卖飞，不追。`;
  } else if (chg >= 6*GRID){
    mode='CUT'; vcls='v-go';
    title = '🔻 已进入6格以上亢奋区 —— 只减不接';
    detail = `涨幅已达 ${chg.toFixed(2)}%，多头力量透支，随时可能冲高回落。这个位置只做减仓，<b>不新开正T</b>，避免接在日内最高点。`;
  } else {
    mode='WAIT'; vcls='v-wait';
    title = '⛔ 信号模糊 —— 观望';
    detail = `波动够（${grid.toFixed(1)}格），但量价关系不清晰（量比 ${f2(vr)}，价在均价${below?'下':'上'}方）。按铁律「宁缺毋滥，无信号不交易」，空着。若一定要动，只在 <b>${f2(inA)}</b> 轻仓试第一份。`;
  }

  // ---- 闸门4：市场环境（外生约束，可一票否决正T） ----
  /* 前三闸门全部只看个股内部，这条是唯一的外生闸门。
     为什么给它否决权：个股技术面再漂亮，指数放量破位日照样系统性挨打，
     这是做T最高频的亏损来源，所以在"正T低吸"这个动作上给硬约束。 */
  const me = (MKT && MKT.gate) ? MKT.gate : null;
  let gate4 = '数据未加载（点上方「刷新全部」或等待自动取数）';
  let g4cls = 'wait', mktLevel = me ? me.level : 'NA';
  if (me){
    if (me.level === 'OK')        { gate4 = '市场环境中性偏多，不构成额外约束'; g4cls='ok'; }
    else if (me.level === 'WARN') { gate4 = '指数在 MA20 下方 → 做T仓位减半、止损收紧到 −1.0%'; g4cls='warn'; }
    else if (me.level === 'BAD')  { gate4 = '指数破 MA20/MA60 → 禁止新开正T（一票否决）'; g4cls='bad'; }
    else                          { gate4 = '指数日K数据不足，本闸门不参与决策'; g4cls='wait'; }
  }
  if (me && me.level === 'BAD' && mode === 'BUY'){
    mode = 'WAIT'; vcls = 'v-warn';
    title = '⛔ 正T信号被「市场环境」一票否决 —— 指数破位日不低吸';
    detail = `个股层面本已满足正T条件（现价在分时均线下方且量比未放大），但指数已同时跌破 MA20 与 MA60，属系统性走弱而非情绪回踩。这种日子里"个股技术面看对了、却被大盘一刀砍下来"是高频事故，所以此信号不予执行。今天只保留倒T：反弹到 <b>${f2(outA)} ~ ${f2(outB)}</b> 无量滞涨时减T仓，回落到 <b>${f2(bkA)}</b> 缩量再接回；<b>空仓等指数收回 MA20 更稳</b>。`;
  }

  // ---- 仓位（七底三仓 · A股整百股/手实盘约束） ----
  const sh = Math.round(+s.shares||0);
  const base = Math.round(sh*0.7);
  const t = sh - base;
  const t1 = Math.round(t/3);
  // 实盘可挂单整手（A股买入必须为100股整数倍）
  const tLots = Math.floor(t / 100) * 100;
  // 每份挂单手数：若T仓大于等于300股分3份，否则若>=100股分1份或2份
  const t1Lots = tLots >= 300 ? Math.floor(tLots / 300) * 100 : (tLots >= 100 ? 100 : 0);
  const cap = Math.round(+s.cap||0);

  // 倒T卖飞熔断保护：现价放量超过倒T卖出区 +2.0% 且逼近卖飞线
  const sellFlyTriggered = (+s.price > 0 && outA > 0 && +s.price >= outA * 1.02);

  return { pc, amp, grid, chg, vr, vsAvg, trend, bull, bear, heavy, light,
           gate1, g1cls, gate2, gate3, gate4, g4cls, mktLevel, mode, vcls, title, detail,
           inA, inB, tp1, tp2, slA, slB, outA, outB, bkA, bkB, fly,
           gain1, gain2, sh, base, t, t1, tLots, t1Lots, cap, sellFlyTriggered };
}


/* 研究数据装载：估值（按日缓存）+ 板块归属（按日缓存） */
const RSCH_FAIL_CD = 600000;
export async function loadResearch(s, force){
  const now = Date.now();
  const jobs = [];
  if (force || (!s._val && !(s._valErr && now - (s._valErrAt||0) < RSCH_FAIL_CD)))
    jobs.push(loadVal(s, force).then(()=>{ s._valErr = null; })
              .catch(e=>{ s._valErr = e.message || String(e); s._valErrAt = now; }));
  if (force || (!s._bd && !(s._bdErr && now - (s._bdErrAt||0) < RSCH_FAIL_CD)))
    jobs.push(loadBoards(s, force).then(()=>{ s._bdErr = null; })
              .catch(e=>{ s._bdErr = e.message || String(e); s._bdErrAt = now; }));
  await Promise.all(jobs);
}


/* ===================== 价格到位提醒 ===================== */
const NEAR_PCT = 0.004;
const _hitSeen = {};
export function checkPriceAlerts(){
  if (!Array.isArray(pool) || !pool.length) return;
  const hits = [];
  pool.forEach(s=>{
    const p = +s.price;
    if (!p) return;
    let c; try{ c = calc(s); }catch(_){ return; }
    [['买点', c.inA], ['第二买点', c.inB], ['卖点', c.outA], ['卖飞线', c.fly]].forEach(pair=>{
      const label = pair[0], lv = +pair[1];
      if (!lv) return;
      const dev = Math.abs(p - lv) / lv;
      if (dev <= NEAR_PCT) hits.push({ key: s.code + '|' + label, name: s.name, label, lv, p, dev });
    });
  });
  hits.sort((a,b)=>a.dev - b.dev);
  document.title = hits.length
    ? '⚡' + hits[0].name + ' ' + hits[0].p.toFixed(2) + ' 触及' + hits[0].label
    : '做T执行台 · 七格箱体 + 七底三仓';
  hits.filter(h=>!_hitSeen[h.key]).forEach(h=>{
    _hitSeen[h.key] = 1;
    toastWarn(h.name + ' ' + h.p.toFixed(2) + ' 已到「' + h.label + ' ' + h.lv.toFixed(2) + '」（差 ' + (h.dev*100).toFixed(2) + '%）');
  });
  Object.keys(_hitSeen).forEach(k=>{ if (!hits.some(h=>h.key === k)) delete _hitSeen[k]; });
}

export function checkMarketAlerts(){
  if (!MKT || !Array.isArray(MKT.idx) || !MKT.idx.length) return;
}

/* 持仓与成本核算 */
export function tRealOf(code){
  let sum = 0, n = 0;
  return { sum, n };
}

export function posCalc(s){
  const px   = +s.price || 0;
  const cost = +s.cost  || 0;
  const sh   = Math.round(+s.shares || 0);
  const pc   = +s.prevClose || 0;
  const cap  = Math.round(+s.cap || 0);

  const curMkt  = px * sh;
  const mkt     = curMkt;
  const costAmt = cost * sh;
  const floatPL = sh ? (px - cost) * sh : 0;
  const floatPct= (sh && cost) ? (px - cost)/cost*100 : null;
  const dayPL   = (sh && pc) ? (px - pc) * sh : null;
  const dayPct  = pc ? (px - pc)/pc*100 : null;

  const t = tRealOf(s.code);
  const tPerShare = (sh && t.n) ? t.sum/sh : null;
  const tBudget = cap > 0 ? Math.round(cap*0.3) : (sh ? Math.round(sh*0.3*px) : 0);

  return { px, cost, sh, cap, curMkt, mkt, costAmt, floatPL, floatPct, dayPL, dayPct,
           tReal:t.sum, tCount:t.n, tPerShare,
           costNoT: tPerShare!==null ? cost + tPerShare : null,
           tBudget, hasPos: sh > 0,
           aboveCost: (sh && cost) ? px > cost : null };
}
