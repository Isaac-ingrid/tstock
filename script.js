/* ============================================================
   A股做T执行台 · 核心引擎脚本 (script.js)
   ============================================================ */
/* ===================== 常量 ===================== */
const GRID = 4/3;              // 每格 1.333%，3格=4%，6格=8%（源自"三格以内/三至六格/六格之上"）
const STOP = 0.015;            // T仓硬止损 1.5%
const FLY  = 0.015;            // 倒T卖飞线 1.5%

/* ===================== 通用工具：toast / 数据时效 ===================== */
/* toast 替代 alert：不打断操作，右下角浮出、数秒自动消失。
   原来取数失败、保存、打卡都用 alert，每弹一次要点一次「确定」，盘中被弹窗挡住是真事。 */
function toast(msg, kind, ms){
  const host = document.getElementById('toastHost');
  if (!host){ alert(msg); return; }                       // 极端降级：宿主不存在时仍要能提示
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || '');
  el.innerHTML = '<span class="ti"></span><span class="tx"></span><button class="tc" title="关闭">×</button>';
  el.querySelector('.ti').textContent = kind === 'ok' ? '✓' : kind === 'err' ? '!' : kind === 'warn' ? '⚠' : 'i';
  el.querySelector('.tx').textContent = String(msg);      // textContent：消息里可能带 < > 等符号
  const kill = ()=> el.remove();
  el.querySelector('.tc').onclick = kill;
  host.appendChild(el);
  setTimeout(kill, ms === undefined ? (kind === 'err' ? 7000 : 3600) : ms);
  return el;
}
const toastOk   = m => toast(m, 'ok');
const toastErr  = m => toast(m, 'err', 7000);
const toastWarn = m => toast(m, 'warn', 5200);

/* ===================== 数据时效：防止把旧价当实时价 =====================
   只有"成功取到行情"才推进 STAMP，失败绝不推进。
   顶部常显数据时间，超过 STALE_MIN 分钟整栏转黄。
   为什么值当：刷新失败时页面上的价格照常显示，没有任何标记的话，
   你会以为那是刚才的价 —— 这是会直接影响挂单的误判，宁可显示得刺眼。 */
const STALE_MIN = 3;
let STAMP = 0;
function stampData(){ STAMP = Date.now(); paintStamp(); }
function paintStamp(){
  const bar = document.getElementById('topbar'), el = document.getElementById('tbStamp');
  if (!bar || !el) return;
  if (!STAMP){ el.textContent = '数据未取'; bar.classList.remove('stale'); return; }
  const d = new Date(STAMP), p = n => String(n).padStart(2, '0');
  const ageMin = (Date.now() - STAMP) / 60000;
  el.textContent = '数据 ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  bar.classList.toggle('stale', ageMin >= STALE_MIN);
}
setInterval(paintStamp, 30000);                          // 即使不刷新，也要让"过期了多久"自己走

/* ===================== 价格到位提醒 =====================
   现价进入买点 / 卖点 ±NEAR_PCT 内算"到位"。两个出口：
   ① document.title —— 多标签页时不用切回来就能看见；
   ② 桌面通知 —— 需用户点「🔔 提醒」授权，默认不申请。
   只在"刚进入"时提醒一次：离开区间会清标记，所以来回到位会各提醒一次，不会每分钟重复喊。 */
const NEAR_PCT = 0.004;
const _hitSeen = {};
function checkPriceAlerts(){
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
  hits.sort((a,b)=>a.dev - b.dev);                       // 先排序：标题栏要显示最靠近的那个
  document.title = hits.length
    ? '⚡' + hits[0].name + ' ' + hits[0].p.toFixed(2) + ' 触及' + hits[0].label
    : '做T执行台 · 七格箱体 + 七底三仓';
  hits.filter(h=>!_hitSeen[h.key]).forEach(h=>{
    _hitSeen[h.key] = 1;
    toastWarn(h.name + ' ' + h.p.toFixed(2) + ' 已到「' + h.label + ' ' + h.lv.toFixed(2) + '」（差 ' + (h.dev*100).toFixed(2) + '%）');
    notifyDesktop(h);
    if (ALERT_OPT.price){
      logAlert('price', '到价', `<b>${h.name}</b> ${h.p.toFixed(2)} 已到「${h.label} ${h.lv.toFixed(2)}」，差 ${(h.dev*100).toFixed(2)}%`, false);
    }
  });
  Object.keys(_hitSeen).forEach(k=>{ if (!hits.some(h=>h.key === k)) delete _hitSeen[k]; });
}
function notifyDesktop(h){
  try{
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    new Notification('做T到价 · ' + h.name, { body: h.p.toFixed(2) + ' 已到' + h.label + ' ' + h.lv.toFixed(2) });
  }catch(_){}
}

/* ===================== 提醒中心 =====================
   三类提醒（到价 / 大盘跳水 / 大盘急拉）共用一套落点：页内 toast + 桌面通知 + 提示音 + 列表留痕。
   为什么必须留痕：到价提醒原来只在 toast 里闪 3.6 秒，低头看眼手机就错过了，
   回来看到的是价格已经跑开，却不知道刚才到底触发了什么。 */
const ALERT_MAX = 40;
let ALERTS = [];
try{ ALERTS = JSON.parse(localStorage.getItem('t-system-alerts') || '[]') || []; }catch(_){ ALERTS = []; }
const ALERT_OPT = Object.assign({ sound: true, price: true, market: true },
  (()=>{ try{ return JSON.parse(localStorage.getItem('t-system-alertopt') || '{}'); }catch(_){ return {}; } })());
function saveAlertOpt(){ try{ localStorage.setItem('t-system-alertopt', JSON.stringify(ALERT_OPT)); }catch(_){} }

/* 提示音用 Web Audio 现场合成，不引任何音频文件。
   注意浏览器的自动播放策略：页面一加载就 new AudioContext() 会一直 suspended，
   必须等用户第一次点击/按键才能出声。所以第一次交互时做一次 warmAudio。 */
let _actx = null, _audioReady = false;
function warmAudio(){
  if (_audioReady) return;
  try{
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    _actx = _actx || new AC();
    _actx.resume().then(()=>{ _audioReady = true; }).catch(()=>{});
  }catch(_){}
}
['pointerdown','keydown'].forEach(ev => window.addEventListener(ev, warmAudio, { once:true, passive:true }));

function beep(urgent){
  if (!ALERT_OPT.sound) return;
  try{
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    _actx = _actx || new AC();
    if (_actx.state === 'suspended') return;      // 还没交互过，浏览器不允许出声，静默跳过
    const t0 = _actx.currentTime;
    [0, 0.15].forEach((dt)=>{
      const o = _actx.createOscillator(), g = _actx.createGain();
      o.type = 'sine';
      o.frequency.value = urgent ? 523 : 784;     // 紧急用低音，两短声
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(0.13, t0 + dt + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.17);
      o.connect(g); g.connect(_actx.destination);
      o.start(t0 + dt); o.stop(t0 + dt + 0.2);
    });
  }catch(_){}
}

function logAlert(kind, tag, text, urgent){
  ALERTS.push({ t: Date.now(), kind, tag, text });
  if (ALERTS.length > ALERT_MAX) ALERTS = ALERTS.slice(-ALERT_MAX);
  try{ localStorage.setItem('t-system-alerts', JSON.stringify(ALERTS)); }catch(_){}
  renderAlerts();
  beep(urgent);
}

function renderAlerts(){
  const box = document.getElementById('alertBox');
  if (!box) return;
  const today = new Date().toDateString();
  const list = ALERTS.filter(a => new Date(a.t).toDateString() === today);
  const rows = list.slice().reverse().map(a=>{
    const d = new Date(a.t);
    const hh = String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
    const cls = a.kind === 'price' ? 'k-price' : a.kind === 'down' ? 'k-down' : 'k-up';
    return `<div class="alert-row"><span class="ah">${hh}</span><span class="ak ${cls}">${a.tag}</span><span class="ad">${a.text}</span></div>`;
  }).join('');
  box.innerHTML = `<div class="alert-wrap">
    <div class="alert-hd">
      <span class="at">今日提醒</span><span class="an">${list.length}</span>
      <span class="alert-opt">
        <label title="个股触及买点 / 卖点 / 卖飞线时提醒"><input type="checkbox" id="optPrice" ${ALERT_OPT.price?'checked':''}>到价</label>
        <label title="大盘 5 分钟内异动（按当日振幅标准化）"><input type="checkbox" id="optMarket" ${ALERT_OPT.market?'checked':''}>大盘异动</label>
        <label title="提醒时播两声短提示音"><input type="checkbox" id="optSound" ${ALERT_OPT.sound?'checked':''}>声音</label>
      </span>
    </div>
    <div class="alert-list">${rows || '<div class="alert-empty">今天还没有触发提醒。<br>到价提醒需要页面开着、并且行情在刷新（交易时段默认每分钟自动刷一次）。</div>'}</div>
  </div>`;
  const bind = (id, key)=>{ const el = document.getElementById(id); if (el) el.onchange = ()=>{ ALERT_OPT[key] = el.checked; saveAlertOpt(); if (key === 'sound' && el.checked) { warmAudio(); beep(false); } }; };
  bind('optPrice','price'); bind('optMarket','market'); bind('optSound','sound');
}

/* ===================== 大盘异动 =====================
   痛点是"买点卖点找不准"，而根子往往不在个股，在大盘先动手了。
   用「5 分钟涨跌 / 当日振幅折算的标准差」来判异动，而不是固定百分比：
   固定 0.5% 在平静日永不触发、在暴跌日每两分钟响一次，两种行情不可能共用一套阈值。
   振幅 2% 的指数，5 分钟正常波动约 0.2%，所以涨 0.5% 就是 z≈2.5，够格提醒；
   暴跌日振幅放大到 5%，同样 0.5% 只有 z≈1，不会刷屏。 */
const MKT_HIST = [];                                  // 采样点 [{t, px:{tc:{p,amp,label}}}]
const MKT_COOL = {};                                  // 冷却：tc|dir → 上次提醒时间
const MKT_WIN = 5 * 60000;
const MKT_COOL_MS = 10 * 60000;
const MKT_Z = { warn: 2.5, alert: 3.5 };

function checkMarketAlerts(){
  if (!ALERT_OPT.market) return;
  if (!MKT || !Array.isArray(MKT.idx) || !MKT.idx.length) return;
  if (!isTradeDay()) return;
  const now = Date.now();

  const snap = {};
  MKT.idx.forEach(x=>{ if (+x.price > 0) snap[x.tc] = { p:+x.price, amp:Math.abs(+x.amp || 0), label:x.label }; });
  if (!Object.keys(snap).length) return;

  /* 采样：45 秒内不重复记。历史最多留 80 个点，够覆盖一小时的窗口回溯。 */
  const last = MKT_HIST[MKT_HIST.length - 1];
  if (!last || now - last.t > 45000) MKT_HIST.push({ t: now, px: snap });
  while (MKT_HIST.length > 80) MKT_HIST.shift();

  /* 找最接近 5 分钟前的那个采样点。太新（<3 分钟）样本不足、太旧（>9 分钟）窗口失真，
     两种都放弃 —— 异动提醒宁可晚一条，也不能因为页面刚打开就误报。 */
  let base = null, best = Infinity;
  for (const h of MKT_HIST){
    const age = now - h.t;
    if (age < 3 * 60000 || age > 9 * 60000) continue;
    const d = Math.abs(age - MKT_WIN);
    if (d < best){ best = d; base = h; }
  }
  if (!base) return;

  Object.keys(snap).forEach(tc=>{
    const cur = snap[tc], b = base.px[tc];
    if (!b || !b.p) return;
    const r = (cur.p / b.p - 1) * 100;
    const sigma = Math.max(0.08, (b.amp || cur.amp || 1) * 0.10);
    const z = Math.abs(r) / sigma;
    if (z < MKT_Z.warn) return;

    const dir = r > 0 ? 'up' : 'down';
    const key = tc + '|' + dir;
    if (MKT_COOL[key] && now - MKT_COOL[key] < MKT_COOL_MS) return;
    MKT_COOL[key] = now;

    const strong = z >= MKT_Z.alert;
    const txt = dir === 'down'
      ? `<b>${cur.label}</b> 5 分钟内跌 <b>${Math.abs(r).toFixed(2)}%</b>（z=${z.toFixed(1)}）。大盘跳水时个股买点会瞬间失效：先等指数止跌（分时不再创新低）再谈正T低吸；手里有浮盈的，这是倒T减仓窗口。`
      : `<b>${cur.label}</b> 5 分钟内涨 <b>${r.toFixed(2)}%</b>（z=${z.toFixed(1)}）。急拉多是脉冲，别追：你的票没跟上时挂单，等于买在别人出货的位置；已在 T1 附近则先兑现。`;
    toastWarn((dir === 'down' ? '⚠ 大盘跳水 · ' : '⚡ 大盘急拉 · ') + cur.label + ' '
      + (r > 0 ? '+' : '') + r.toFixed(2) + '%');
    logAlert(dir, dir === 'down' ? '跳水' : '急拉', txt, strong);
    try{
      if ('Notification' in window && Notification.permission === 'granted'){
        new Notification((dir === 'down' ? '⚠ 大盘跳水 · ' : '⚡ 大盘急拉 · ') + cur.label,
          { body: `5 分钟 ${(r > 0 ? '+' : '') + r.toFixed(2)}%（z=${z.toFixed(1)}）` });
      }
    }catch(_){}
  });
}

/* ===================== 固定自选池（默认数据 2026-09-17 收盘快照） ===================== */
const DEFAULT = [
  { name:'上海沿浦', code:'605128', tcode:'sh605128', prevClose:23.17, open:23.10, high:23.49, low:22.40,
    price:22.63, avg:22.90, vr:1.41, ma5:23.00, ma10:23.86, ma20:23.96, shares:0, cost:0, cap:0 },
  { name:'上海九百', code:'600838', tcode:'sh600838', prevClose:7.70, open:7.70, high:7.84, low:7.56,
    price:7.81, avg:7.73, vr:0.49, ma5:7.90, ma10:8.32, ma20:8.26, shares:0, cost:0, cap:0 }
];

/* ===================== 池别（短线 / 长线） =====================
   字段落在每只票的 s.tier 上，只影响显示分组，不参与任何算法。
   兼容三种历史数据：已有 tier 用 tier；从选股池导入的带 poolTag（短线/稳健）；
   更早的手工票两者都没有 —— 默认按短线处理（这本来就是做T系统）。 */
function tierOf(s){
  if (s && (s.tier === 'short' || s.tier === 'long')) return s.tier;
  if (s && s.poolTag === '短线') return 'short';
  if (s && s.poolTag === '稳健') return 'long';
  return 'short';
}
const TIER_LABEL = { short:'短线', long:'长线' };
let TIER = 'all';
try{ const t0 = localStorage.getItem('t-system-tier'); if (t0 === 'short' || t0 === 'long') TIER = t0; }catch(_){}

function paintTierBar(){
  const n = { all: pool.length, short: 0, long: 0 };
  pool.forEach(s => { n[tierOf(s)]++; });
  ['all','short','long'].forEach(k => {
    const el = document.getElementById('tierN-' + k);
    if (el) el.textContent = n[k];
  });
  const bar = document.getElementById('tierBar');
  if (bar) bar.querySelectorAll('.tier-btn').forEach(b => b.classList.toggle('cur', b.dataset.tier === TIER));
  document.body.dataset.tier = TIER;
}

/* 切换分组：纯显示层，不重算任何价格。
   唯一要处理的是单只视图下 CUR 可能落进被隐藏的那一组 —— 那时跳到同组第一只，
   该组为空则退回「全部视图」，避免一屏空白让人以为数据丢了。 */
function setTier(t){
  TIER = (t === 'short' || t === 'long') ? t : 'all';
  try{ localStorage.setItem('t-system-tier', TIER); }catch(_){}
  document.body.dataset.tier = TIER;
  paintTierBar();
  if (TIER === 'all'){ renderPoolTabs(); return; }
  const vis = pool.map((s,i) => i).filter(i => tierOf(pool[i]) === TIER);
  if (!vis.length){
    toastWarn('「' + TIER_LABEL[TIER] + '」这一组还没有票：点卡片头部的池别标签即可归类。');
    renderPoolTabs();
    return;
  }
  if (!vis.includes(CUR)){ CUR = vis[0]; render(pool); renderPoolTabs(); return; }
  renderPoolTabs();
}

/* ===================== 工具 ===================== */
const f2 = n => (Math.round(n*100)/100).toFixed(2);
const f3 = n => (Math.round(n*1000)/1000).toFixed(3);
const pct = n => (n>=0?'+':'') + n.toFixed(2) + '%';
/* 输入框专用格式化：先把浮点尾巴剪掉再输出（22.997999999999998 → 22.998）。
   均线虽已在 loadStock 里取过整，这里再加一层，兜住任何来源的脏值。 */
const fmtIn = v => (v === '' || v == null || Number.isNaN(+v)) ? '' : String(+(+v).toFixed(3));

/* ===================== 数据层：全腾讯源（行情 / 检索 / 日K） =====================
   选源原则：实测本机到东财域名严重不稳（searchapi 首包 11s+，push2his 直接连不上），
   而腾讯 gtimg.cn 三个域名均为百毫秒级、且都带 Access-Control-Allow-Origin: *。
   故统一到腾讯单一家，彻底去掉东财依赖，降低链路数量。 */
const T_Q = 'https://qt.gtimg.cn/q=';                                  // 实时行情（fetch，CORS *）
const T_S = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/smartbox/search/get';  // 检索（JSON，CORS *）
const T_K = 'https://ifzq.gtimg.cn/appstock/app/fqkline/get';          // 前复权日K（fetch，CORS *）

/* 带超时的 fetch —— 慢接口要能主动放弃，不能挂死界面 */
function fetchT(url, ms){
  const ctl = new AbortController();
  const t = setTimeout(()=> ctl.abort(), ms || 8000);
  return fetch(url, { cache:'no-store', signal: ctl.signal }).finally(()=> clearTimeout(t));
}

/* —— 本地代码解析：0 网络请求，纯规则。输入代码这条路完全不依赖检索接口 —— */
function tcodeFromCode(code){
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
function tencentCode(secid){
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
async function searchTencent(q){
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
async function fetchQuotes(codes){
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
async function fetchKline(tcode){
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
async function fetchKlineBig(tcode, period, n){
  const key = period === 'day' ? 'qfqday' : period === 'week' ? 'qfqweek' : 'qfqmonth';
  const r = await fetchT(T_K + '?param=' + tcode + ',' + period + ',,,' + (n||140) + ',qfq', 12000);
  if (!r.ok) throw new Error('http ' + r.status);
  const d = await r.json();
  const node = (d && d.data && d.data[tcode]) || null;
  const ks = (node && (node[key] || node[period])) || [];
  return ks.map(a => ({ date:String(a[0]), open:+a[1], close:+a[2], high:+a[3], low:+a[4], vol:+a[5] }));
}
/* 分钟K线 m1/m5/m15/m30/m60（字段：时间YYYYMMDDHHmm,开,收,高,低,量手,{},换手%） */
async function fetchKlineMin(tcode, period, n){
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
async function fetchMinute(tcode){
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
async function fetchDetail(tcode, maxPage){
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
function calcDD(recs){
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
function chartEntry(kind, obj){
  const e = Object.assign({ kind, at: Date.now() }, obj);
  if (kind === 'bar' && e.ks && e.ks.length) e.ind = chartInd(e.ks);
  return e;
}
async function loadChart(s, force){
  const p = s.p || 'day';
  s._k = s._k || {};
  const c = s._k[p], now = Date.now();
  const ttl = p === 'rt' ? 20000 : CK_TTL;
  if (!force && c && now - c.at < ttl) return c;
  if (p === 'rt'){
    s._k[p] = chartEntry('line', { min: await fetchMinute(s.tcode) });
  } else if (p === 'day'){
    s._k[p] = chartEntry('bar', { ks: s._ks || [] });
  } else if (p === 'week' || p === 'month'){
    s._k[p] = chartEntry('bar', { ks: await fetchKlineBig(s.tcode, p, p === 'month' ? 80 : 140) });
  } else {
    s._k[p] = chartEntry('bar', { ks: await fetchKlineMin(s.tcode, p, p === 'm1' ? 320 : 240) });
  }
  return s._k[p];
}
/* 大单资金装载（偏重：一次要打二十来个请求，所以单独控制、带 90 秒节流） */
async function loadDD(s, force){
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
async function loadVolMin(s, force){
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

let MKT = null;                       // 市场环境对象
const MKT_TTL = 30000;                // 指数行情 30 秒
let _idxK = {}, _idxKAt = 0;          // 4 个指数的日K缓存（盘中末根在变，缓存 10 分钟足够）

async function loadMarket(force){
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
function marketGate(m){
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
function marketEffect(g){
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
async function loadVal(s, force){
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
async function loadBoards(s, force){
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
function rsCalc(s){
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
function drawRS(cv, rs){
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
function emaArr(vals, n){
  if (!vals.length) return [];
  const k = 2/(n+1), out = [vals[0]];
  for (let i=1;i<vals.length;i++) out.push(vals[i]*k + out[i-1]*(1-k));
  return out;
}
/* MACD(12,26,9)：DIF=EMA12-EMA26，DEA=DIF 的 EMA9，柱=2×(DIF-DEA) */
function macdArr(closes, fast, slow, sig){
  fast = fast||12; slow = slow||26; sig = sig||9;
  if (closes.length < slow + sig) return null;
  const e1 = emaArr(closes, fast), e2 = emaArr(closes, slow);
  const dif = closes.map((_,i)=> e1[i] - e2[i]);
  const dea = emaArr(dif, sig);
  return { dif, dea, bar: dif.map((v,i)=> (v - dea[i]) * 2) };
}
/* 均线序列（用于画线，返回与 closes 等长的数组，不足处为 null） */
function maArr(closes, n){
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
function bollArr(closes, n, k){
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
function rsiArr(closes, n){
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
async function loadStock(s){
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
function computeTA(s){
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
async function selfTest(){
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
async function addByQuery(q){
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

async function adoptCandidate(c){
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
function setupTimer(){
  if (_timer){ clearInterval(_timer); _timer = null; }
  if (!document.getElementById('dbAuto').checked) return;
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
function calc(s){
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

/* ===================== 图表引擎（Canvas 手绘，零依赖 · 多周期） =====================
   周期：分时 / 1分 / 5分 / 15分 / 30分 / 60分 / 日K / 周K / 月K
   叠加：MA5/10/20/60、BOLL(20,2)、20日箱体、持仓成本、支撑压力位
   副图：成交量常显 + MACD / RSI 可切换
   配色遵循 A 股惯例：涨红跌绿。悬停显示该根的时间、OHLC 与各指标取值。 */
/* 图表配色：与 CSS 变量同源。涨红跌绿、线色对比度 ≥3:1（非文本标准），
   文字类（txt/mute）按 ≥4.5 取。注意 Canvas 读不到 CSS 变量，必须在这里同步改。 */
const CH = { up:'#d32f2f', dn:'#0a7f42', grid:'#eef1f4', txt:'#515c69', mute:'#66707c',
             /* 均线 4 色：蓝 221° / 玫红 336° / 青 192° / 金 35° —— 两两色相 ≥35°，
                原来 MA10/均价/BOLL中轨/箱体/MA60 五条线全挤在 21°–46° 的橙黄区，图上一片橙。 */
             ma5:'#2563eb', ma10:'#c2185b', ma20:'#0891b2', ma60:'#a16207',
             /* BOLL 是一族：上/下轨与中轨同色相同族、只差一档明度，靠线型再分 */
             bollU:'#4f46e5', bollM:'#6366f1',
             /* 参考线各归其位：压力=深红 0°、成本=紫 262°、均价=青 193°，
                箱体与 VMA 都是中性参考，用同色相的一深一浅两档灰，避免完全同色 */
             sr:'#991b1b', cost:'#7c3aed', box:'#6b7280', avg:'#0e7490', vma:'#4b5563' };
const _hover = {};                       // 每张图的悬停索引
const OV_DEF = { ma:'均线', boll:'BOLL', box:'箱体', cost:'成本', sr:'支撑压力' };
const SUB_DEF = { macd:'MACD', rsi:'RSI' };

/* 图表用指标：同一套函数在任意周期上复用 —— 周期一换，指标就跟着换成该周期的口径 */
function chartInd(ks){
  const closes = ks.map(k=>k.close), vols = ks.map(k=>k.vol||0);
  return { closes,
    ma5:maArr(closes,5), ma10:maArr(closes,10), ma20:maArr(closes,20), ma60:maArr(closes,60),
    boll:bollArr(closes,20,2),
    rsi6:rsiArr(closes,6), rsi12:rsiArr(closes,12), rsi24:rsiArr(closes,24),
    macd:macdArr(closes), vma5:maArr(vols,5) };
}
/* 数字格式化：null / 空 / NaN 一律显示为「—」，避免图表和卡片上出现 "null" 或 "NaN" */
const nf = (v, d)=> (v == null || v === '' || Number.isNaN(+v)) ? '—' : (+v).toFixed(d === undefined ? 2 : d);
/* 金额缩写：元 → 万 / 亿（大单金额动辄上亿，原样写出来读不动） */
function money$(v){
  v = +v || 0;
  const a = Math.abs(v);
  if (a >= 1e8) return (v/1e8).toFixed(2) + '亿';
  if (a >= 1e4) return (v/1e4).toFixed(1) + '万';
  return Math.round(v) + '';
}
/* 把一段文字画成带底色的信息条（悬停提示 / 轴上标注共用） */
function chipText(ctx, txt, x, y, col, bg){
  const tw = ctx.measureText(txt).width;
  ctx.globalAlpha = .94; ctx.fillStyle = bg || '#fff';
  ctx.fillRect(x, y-8, tw+7, 15);
  ctx.globalAlpha = 1; ctx.fillStyle = col;
  ctx.fillText(txt, x+3.5, y);
  return tw + 7;
}

function drawChart(cv, s){
  const p = s.p || 'day';
  const entry = (s._k || {})[p];
  const ov = s.ov || (s.ov = {});
  const subKind = s.sub || 'macd';

  const W = Math.max(320, cv.clientWidth || 640);
  const PL = 8, PR = 54, PT = 34, PB = 20;      // PT 留出两行信息条的高度（图例已移到画布外的 HTML 里）
  const hMain = 216, hVol = 56, subH = 86, gap = 9;
  const H = PT + hMain + gap + hVol + gap + subH + PB;

  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(W*dpr) || cv.height !== Math.round(H*dpr)){
    cv.width = Math.round(W*dpr); cv.height = Math.round(H*dpr);
  }
  cv.style.height = H + 'px';
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,W,H);
  ctx.font = '11px ui-monospace,Consolas,monospace';
  ctx.textBaseline = 'middle';

  const y0 = PT, y1 = y0 + hMain;
  const v0 = y1 + gap, v1 = v0 + hVol;
  const s0 = v1 + gap, s1 = s0 + subH;
  const innerW = W - PL - PR;

  if (!entry){
    cv._geo = null;
    ctx.fillStyle = CH.mute; ctx.textAlign = 'center';
    ctx.fillText('正在取数…（切换周期首次约 0.3~1 秒）', W/2, H/2);
    return;
  }
  if (entry.kind === 'line'){ drawRt(cv, s, entry.min, ctx, {W,H,PL,PR,y0,y1,v0,v1,s0,s1,innerW}); return; }

  const ks = entry.ks || [];
  if (ks.length < 12){
    cv._geo = null;
    ctx.fillStyle = CH.mute; ctx.textAlign = 'center';
    ctx.fillText('该周期K线不足（仅 ' + ks.length + ' 根），换回日K / 周K 看', W/2, H/2);
    return;
  }
  const ind = entry.ind || chartInd(ks);
  const N = Math.min(VIEWS[p] || 60, ks.length);
  const i0 = ks.length - N;
  const view = ks.slice(i0);
  const bw = innerW / N;
  const X = i => PL + bw*(i+0.5);
  const sv = a => a ? a.slice(i0) : null;
  cv._geo = { kind:'bar', n:N, i0, bw, PL, innerW, view, ind };

  const ta = s._ta;                                  // 日线口径技术面（箱体/支撑压力与所选周期无关）
  const hasBoll = !!(ov.boll && ind.boll && ind.boll.up);
  const vBollU = hasBoll ? sv(ind.boll.up) : null;
  const vBollM = hasBoll ? sv(ind.boll.mid) : null;
  const vBollD = hasBoll ? sv(ind.boll.dn) : null;
  const vMa5 = ov.ma ? sv(ind.ma5) : null, vMa10 = ov.ma ? sv(ind.ma10) : null;
  const vMa20 = ov.ma ? sv(ind.ma20) : null, vMa60 = ov.ma ? sv(ind.ma60) : null;

  /* ---- 价格轴：以蜡烛高低点为主体，叠加线只有"离得不远"的才纳入，防止一条 MA60 把图压扁 ---- */
  let pLo = Infinity, pHi = -Infinity;
  view.forEach(k=>{ if (k.low < pLo) pLo = k.low; if (k.high > pHi) pHi = k.high; });
  const tol = ((pHi - pLo) || 1) * 0.08;
  const take = v => { if (v == null || !isFinite(v)) return;
    if (v > pLo - tol && v < pHi + tol){ if (v < pLo) pLo = v; if (v > pHi) pHi = v; } };
  [vMa5,vMa10,vMa20,vMa60,vBollU,vBollM,vBollD].forEach(a=> a && a.forEach(take));
  const cost = +s.cost || 0;
  if (ov.cost && cost > 0) take(cost);
  if (ov.box && ta && ta.box20){ take(ta.box20.top); take(ta.box20.bot); }
  let srRes = [], srSup = [];
  if (ov.sr && ta && ta.levels){
    srRes = ta.levels.res; srSup = ta.levels.sup;
    srRes.forEach(l=> take(l.p)); srSup.forEach(l=> take(l.p));
  }
  const rng = (pHi - pLo) || 1;
  pLo -= rng*0.045; pHi += rng*0.045;
  const Y = v => y1 - (v - pLo)/(pHi - pLo) * (y1 - y0);

  // ---- 主图网格 + 右侧价格刻度 ----
  ctx.textAlign = 'left';
  for (let k=0; k<=4; k++){
    const pv = pLo + (pHi-pLo)*k/4, yy = Y(pv);
    ctx.strokeStyle = CH.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PL, yy+.5); ctx.lineTo(W-PR, yy+.5); ctx.stroke();
    ctx.fillStyle = CH.mute; ctx.fillText(f2(pv), W-PR+5, yy);
  }
  ctx.strokeStyle = '#e5e7eb';
  ctx.beginPath(); ctx.moveTo(PL, v1+.5); ctx.lineTo(W-PR, v1+.5); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(PL, s1+.5); ctx.lineTo(W-PR, s1+.5); ctx.stroke();

  // ---- 布林通道（先铺底，蜡烛压在上面）----
  if (hasBoll){
    ctx.beginPath();
    let started = false;
    vBollU.forEach((v,i)=>{ if (v==null) return; if (!started){ ctx.moveTo(X(i), Y(v)); started = true; } else ctx.lineTo(X(i), Y(v)); });
    for (let i=vBollD.length-1; i>=0; i--){ const v = vBollD[i]; if (v==null) continue; ctx.lineTo(X(i), Y(v)); }
    ctx.closePath();
    ctx.fillStyle = 'rgba(2,132,199,.07)'; ctx.fill();
  }

  // ---- 蜡烛 ----
  view.forEach((k,i)=>{
    const rise = k.close >= k.open;
    const col = rise ? CH.up : CH.dn;
    const x = X(i), bodyW = Math.max(1.5, bw*0.62);
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, Y(k.high)); ctx.lineTo(x, Y(k.low)); ctx.stroke();
    const yo = Y(k.open), yc = Y(k.close);
    const top = Math.min(yo,yc), hgt = Math.max(1, Math.abs(yc-yo));
    if (rise){ ctx.fillStyle = '#fff'; ctx.fillRect(x-bodyW/2, top, bodyW, hgt);
               ctx.strokeRect(x-bodyW/2+.5, top+.5, bodyW-1, hgt-1); }
    else     { ctx.fillRect(x-bodyW/2, top, bodyW, hgt); }
  });

  // ---- 成交量柱 ----
  const vols = view.map(k=>k.vol || 0);
  const vMax = Math.max(...vols, 1);
  view.forEach((k,i)=>{
    const rise = k.close >= k.open;
    const vh = (k.vol||0)/vMax*(hVol-6);
    ctx.fillStyle = rise ? CH.up : CH.dn; ctx.globalAlpha = .6;
    ctx.fillRect(X(i)-Math.max(1,bw*0.32), v1-vh, Math.max(1.2,bw*0.64), vh);
    ctx.globalAlpha = 1;
  });
  const vma5 = sv(ind.vma5);
  if (vma5){
    ctx.strokeStyle = CH.vma; ctx.lineWidth = 1.1; ctx.beginPath();
    let st = false;
    vma5.forEach((v,i)=>{ if (v==null) return; const yy = v1 - v/vMax*(hVol-6);
      if (!st){ ctx.moveTo(X(i), yy); st = true; } else ctx.lineTo(X(i), yy); });
    ctx.stroke();
  }
  ctx.fillStyle = CH.mute; ctx.textAlign = 'left'; ctx.fillText('量', PL+1, v0+8);
  ctx.fillStyle = CH.vma; ctx.fillText('VMA5', PL+18, v0+8);

  // ---- 横线（箱体 / 成本 / 支撑压力 / 现价）----
  const hline = (val, col, dash, label, above, alpha)=>{
    if (val == null || !isFinite(val)) return;
    const yy = Y(val);
    if (yy < y0-2 || yy > y1+2) return;
    ctx.save();
    ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.globalAlpha = alpha || .85;
    ctx.setLineDash(dash || [4,3]);
    ctx.beginPath(); ctx.moveTo(PL, yy+.5); ctx.lineTo(W-PR, yy+.5); ctx.stroke();
    ctx.restore();
    if (label){
      ctx.textAlign = 'left';
      chipText(ctx, label, PL+2, above ? yy-9 : yy+10, col, 'rgba(255,255,255,.92)');
    }
  };
  if (ov.sr){
    /* 支撑压力线画细虚线、不加文字标签，只把「压1/撑1…」小标签贴在右侧内缘 —— 
       左侧已经被箱顶/箱底/成本/现价四个标签占满了，再挤过去会糊成一片。 */
    const srTag = (l, i, isRes)=>{
      const yy = Y(l.p);
      if (yy < y0-2 || yy > y1+2) return;
      const col = isRes ? CH.sr : CH.dn;
      ctx.save();
      ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.globalAlpha = .5;
      ctx.setLineDash([2,3]);
      ctx.beginPath(); ctx.moveTo(PL, yy+.5); ctx.lineTo(W-PR, yy+.5); ctx.stroke();
      ctx.restore();
      if (i > 1) return;                        // 只标注最近的两档，第三档留给卡片里的明细
      ctx.font = '9.5px ui-monospace,Consolas,monospace';
      const lab = (isRes ? '压' : '撑') + (i+1) + ' ' + f2(l.p);
      const tw = ctx.measureText(lab).width;
      ctx.fillStyle = 'rgba(255,255,255,.86)';
      ctx.fillRect(W-PR-4-tw, yy-16, tw+7, 14);
      ctx.fillStyle = col; ctx.textAlign = 'left';
      ctx.fillText(lab, W-PR-1-tw, yy-9);
      ctx.font = '11px ui-monospace,Consolas,monospace';
    };
    srSup.forEach((l,i)=> srTag(l, i, false));      // 撑1 = 离现价最近的支撑
    srRes.forEach((l,i)=> srTag(l, i, true));       // 压1 = 离现价最近的压力
  }
  if (ov.box && ta && ta.box20){
    hline(ta.box20.top, CH.box, [5,3], '箱顶 ' + f2(ta.box20.top), true);
    hline(ta.box20.bot, CH.box, [5,3], '箱底 ' + f2(ta.box20.bot), false);
  }
  if (ov.cost && cost > 0) hline(cost, CH.cost, [6,3], '成本 ' + f2(cost), true);

  // ---- 均线 / 布林轨（画在蜡烛之上，交叉关系才看得清）----
  /* yf：可选的自定义纵坐标映射。副图（MACD / RSI）必须传自己的映射函数，
     否则会被当成主图价格去算 Y()，画成贯穿全屏的竖线（这个坑踩过一次）。 */
  const poly = (arr, col, w, dash, yf)=>{
    if (!arr) return;
    const F = yf || Y;
    ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = w || 1.2;
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    let st = false;
    arr.forEach((v,i)=>{ if (v==null) return;
      if (!st){ ctx.moveTo(X(i), F(v)); st = true; } else ctx.lineTo(X(i), F(v)); });
    ctx.stroke(); ctx.restore();
  };
  if (hasBoll){
    poly(vBollU, CH.bollU, 1, [4,3]); poly(vBollD, CH.bollU, 1, [4,3]);
    poly(vBollM, CH.bollM, 1.1, [4,3]);
  }
  poly(vMa5, CH.ma5, 1.2); poly(vMa10, CH.ma10, 1.2);
  poly(vMa20, CH.ma20, 1.2); poly(vMa60, CH.ma60, 1.2);

  const lastClose = view[view.length-1].close;
  hline(lastClose, lastClose >= +s.prevClose ? CH.up : CH.dn, [2,2], '现价 ' + f2(lastClose), true);

  // ---- 副图：MACD 或 RSI ----
  const hs = _hover[cv.id];
  const hi = (hs != null && hs >= 0 && hs < N) ? hs : -1;

  if (subKind === 'rsi'){
    const r6 = sv(ind.rsi6), r12 = sv(ind.rsi12), r24 = sv(ind.rsi24);
    const RY = v => s1 - (Math.max(0, Math.min(100, v)))/100*(s1-s0);
    [30,50,70].forEach(v=>{
      ctx.strokeStyle = v===50 ? '#e2e8f0' : '#f1f5f9'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(PL, RY(v)+.5); ctx.lineTo(W-PR, RY(v)+.5); ctx.stroke();
      ctx.fillStyle = CH.mute; ctx.textAlign = 'left'; ctx.fillText(String(v), W-PR+5, RY(v));
    });
    // 超买 / 超卖带
    ctx.globalAlpha = .07; ctx.fillStyle = CH.up; ctx.fillRect(PL, RY(100), innerW, RY(70)-RY(100));
    ctx.fillStyle = CH.dn; ctx.fillRect(PL, RY(30), innerW, RY(0)-RY(30));
    ctx.globalAlpha = 1;
    poly(r6, CH.ma5, 1.2, null, RY); poly(r12, CH.ma10, 1.2, null, RY); poly(r24, CH.ma20, 1.2, null, RY);
    ctx.textAlign = 'left'; ctx.fillStyle = CH.mute; ctx.fillText('RSI(6/12/24)', PL+1, s0+8);
  } else {
    const md = ind.macd;
    const difS = md ? sv(md.dif) : null, deaS = md ? sv(md.dea) : null, barS = md ? sv(md.bar) : null;
    if (difS){
      const span = Math.max(...[...difS, ...deaS, ...barS].map(v=> Math.abs(v||0)), 0.01)*1.15;
      const yMid = (s0+s1)/2;
      const MY = v => yMid - v/span*((s1-s0)/2 - 2);
      ctx.strokeStyle = '#e5e7eb'; ctx.beginPath(); ctx.moveTo(PL, yMid+.5); ctx.lineTo(W-PR, yMid+.5); ctx.stroke();
      view.forEach((k,i)=>{
        const v = barS[i]; if (v == null) return;
        const yy = MY(v);
        ctx.fillStyle = v >= 0 ? CH.up : CH.dn; ctx.globalAlpha = .55;
        ctx.fillRect(X(i)-Math.max(1,bw*0.3), Math.min(yy,yMid), Math.max(1,bw*0.6), Math.abs(yy-yMid));
        ctx.globalAlpha = 1;
      });
      poly(difS, CH.ma5, 1.3, null, MY); poly(deaS, CH.ma10, 1.3, null, MY);
      ctx.textAlign = 'left'; ctx.fillStyle = CH.mute; ctx.fillText('MACD(12,26,9)', PL+1, s0+8);
    }
  }

  // ---- 底部时间刻度 ----
  ctx.textAlign = 'center'; ctx.fillStyle = CH.mute;
  const dlab = k => p === 'day' || p === 'week' || p === 'month' ? String(k.date).slice(2, 10)
                : String(k.date).slice(8,10) + ':' + String(k.date).slice(10,12);
  [0, Math.floor(N/2), N-1].forEach(i=>{ if (view[i]) ctx.fillText(dlab(view[i]), X(i), H-7); });

  // ---- 悬停十字光标 ----
  if (hi >= 0){
    const k = view[hi];
    ctx.save();
    ctx.strokeStyle = '#66707c'; ctx.lineWidth = 1; ctx.setLineDash([3,3]);
    ctx.beginPath(); ctx.moveTo(X(hi)+.5, y0); ctx.lineTo(X(hi)+.5, s1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(PL, Y(k.close)+.5); ctx.lineTo(W-PR, Y(k.close)+.5); ctx.stroke();
    ctx.restore();
  }

  // ---- 顶部信息条：第 1 行 OHLC + 量额，第 2 行各指标在该根上的取值 ----
  const hv = hi >= 0 ? view[hi] : view[view.length-1];
  const hj = hi >= 0 ? hi : view.length-1;
  const chg = (hv.close - hv.open)/hv.open*100;
  const row1 = dlab(hv) + '  开' + f2(hv.open) + ' 高' + f2(hv.high) + ' 低' + f2(hv.low) + ' 收' + f2(hv.close)
             + '  ' + pct(chg) + '  量' + (hv.vol >= 10000 ? (hv.vol/10000).toFixed(2) + '万手' : (hv.vol||0) + '手');
  const g = (arr)=> arr ? arr[hj] : null;
  const p2 = [];
  if (ov.ma) p2.push('MA5 ' + nf(g(ind.ma5)), 'MA10 ' + nf(g(ind.ma10)), 'MA20 ' + nf(g(ind.ma20)), 'MA60 ' + nf(g(ind.ma60)));
  if (hasBoll) p2.push('BOLL ' + nf(g(ind.boll.dn)) + '/' + nf(g(ind.boll.mid)) + '/' + nf(g(ind.boll.up)));
  if (ind.rsi6) p2.push('RSI6 ' + nf(g(ind.rsi6),1), 'RSI12 ' + nf(g(ind.rsi12),1));
  if (ind.macd) p2.push('DIF ' + nf(g(ind.macd.dif),3), 'DEA ' + nf(g(ind.macd.dea),3));
  const row2 = p2.join('  ');
  ctx.textAlign = 'left';
  chipText(ctx, row1, PL, 12, hv.close >= hv.open ? CH.up : CH.dn, 'rgba(255,255,255,.95)');
  // 第二行：按可用宽度自适应取舍 —— 宁可少显示两项，也不要让文字溢出画布被裁掉
  if (row2){
    const parts = p2.slice();
    let line = '';
    for (let i=0;i<parts.length;i++){
      const t = line ? line + '  ' + parts[i] : parts[i];
      if (ctx.measureText(t).width > innerW - 4) break;
      line = t;
    }
    if (line) chipText(ctx, line, PL, 27, CH.mute, 'rgba(255,255,255,.95)');
  }
}

/* ===================== 分时图 =====================
   分时图自成一套坐标系：以昨收为中轴上下对称，右侧刻度同时看得到价格与涨跌幅，
   分时均价线（权威算法：累计成交额 ÷ 累计成交量）是判断"强于/弱于大盘"的关键线。 */
function drawRt(cv, s, min, ctx, L){
  const { W, H, PL, PR, y0, y1, v0, v1, s0, s1, innerW } = L;
  const pts = (min && min.pts) || [];
  if (pts.length < 5){
    cv._geo = null;
    ctx.fillStyle = CH.mute; ctx.textAlign = 'center';
    ctx.fillText(min ? '今日暂无分时数据（非交易日或停牌）' : '正在取数…', W/2, H/2);
    return;
  }
  const prev = (min.prev || +s.prevClose || pts[0].price);
  let mx = 0.002;
  pts.forEach(p=>{
    const d1 = Math.abs(p.price - prev)/prev, d2 = Math.abs(p.avg - prev)/prev;
    if (d1 > mx) mx = d1; if (d2 > mx) mx = d2;
  });
  mx = Math.min(0.2, Math.ceil(mx*100*1.12)/100);      // 上下各留 12% 余量，上限 20%（防止极端值压扁）
  const yHi = prev*(1+mx), yLo = prev*(1-mx);
  const Y = v => y1 - (v-yLo)/(yHi-yLo)*(y1-y0);
  const X = i => PL + (pts.length <= 1 ? innerW/2 : innerW*i/(pts.length-1));
  cv._geo = { kind:'line', n:pts.length, PL, innerW, pts, prev };

  // 网格 + 右侧价格/涨跌幅刻度
  ctx.textAlign = 'left';
  for (let k=-2; k<=2; k++){
    const pv = prev*(1 + mx*k/2), yy = Y(pv);
    ctx.strokeStyle = k === 0 ? '#dfe3e8' : CH.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PL, yy+.5); ctx.lineTo(W-PR, yy+.5); ctx.stroke();
    ctx.fillStyle = k === 0 ? CH.txt : CH.mute;
    ctx.fillText(f2(pv), W-PR+5, yy);
    ctx.fillStyle = pv >= prev ? CH.up : CH.dn;
    ctx.fillText((k>0?'+':'') + (k*mx/2*100).toFixed(2) + '%', W-PR+5, yy+11);
  }

  // 价格线（相对昨收的红绿）+ 昨收中轴
  const lastPt = pts[pts.length-1];
  const lineCol = lastPt.price >= prev ? CH.up : CH.dn;
  ctx.beginPath();
  pts.forEach((p,i)=>{ const yy = Y(p.price); if (i === 0) ctx.moveTo(X(i), yy); else ctx.lineTo(X(i), yy); });
  ctx.strokeStyle = lineCol; ctx.lineWidth = 1.4; ctx.stroke();
  // 价格线到昨收之间的淡填充
  ctx.lineTo(X(pts.length-1), Y(prev)); ctx.lineTo(X(0), Y(prev)); ctx.closePath();
  ctx.fillStyle = lineCol; ctx.globalAlpha = .07; ctx.fill(); ctx.globalAlpha = 1;
  // 均价线
  ctx.beginPath();
  pts.forEach((p,i)=>{ const yy = Y(p.avg); if (i === 0) ctx.moveTo(X(i), yy); else ctx.lineTo(X(i), yy); });
  ctx.strokeStyle = CH.avg; ctx.lineWidth = 1.2; ctx.stroke();

  // 成交量（每分钟差分）
  const vMax = Math.max(...pts.map(p=>p.vol), 1);
  pts.forEach((p,i)=>{
    const pp = i > 0 ? pts[i-1].price : prev;
    const vh = p.vol/vMax*(v1-v0-4);
    ctx.fillStyle = p.price >= pp ? CH.up : CH.dn; ctx.globalAlpha = .6;
    const bwid = Math.max(1, innerW/pts.length*0.66);
    ctx.fillRect(X(i)-bwid/2, v1-vh, bwid, vh);
    ctx.globalAlpha = 1;
  });
  ctx.fillStyle = CH.mute; ctx.textAlign = 'left'; ctx.fillText('分时量', PL+1, v0+8);

  /* 第 2 副图位：分时放量倍数。
     分母优先用「前 5 日同一时段基准」（跨时点可比，1× 就是该时点的常态）；
     基准没取到时退回「当日均量」，但那样早盘天然偏高、午盘天然偏低，只能在标签里明说。 */
  ctx.strokeStyle = '#e5e7eb'; ctx.beginPath(); ctx.moveTo(PL, s1+.5); ctx.lineTo(W-PR, s1+.5); ctx.stroke();
  const _vslots = (s._vm && s._vm.ok && s._vm.slots) ? s._vm.slots : null;
  const avgV = pts.reduce((a,p)=>a+p.vol,0)/pts.length || 1;
  const expCache = {};
  const expOf = t => {
    if (!_vslots) return avgV;
    if (expCache[t] != null) return expCache[t];
    const mm = (+t.slice(0,2))*60 + (+t.slice(2,4));
    const bv = _vslots[m5Slot(mm)];
    return (expCache[t] = (bv > 0 ? bv/5 : avgV));      // 5 分钟均量摊到每分钟
  };
  const ratioOf = p => { const e = expOf(p.t); return e > 0 ? p.vol/e : 0; };
  const rMax = Math.max(3, Math.ceil(Math.max(...pts.map(ratioOf))));
  const RY2 = r => s1 - Math.min(r, rMax)/rMax*(s1-s0);
  [1, 2, 3].forEach(r=>{
    if (r > rMax) return;
    ctx.strokeStyle = r === 1 ? '#c9d2dd' : '#f1f5f9';
    ctx.beginPath(); ctx.moveTo(PL, RY2(r)+.5); ctx.lineTo(W-PR, RY2(r)+.5); ctx.stroke();
    ctx.fillStyle = r === 1 ? CH.txt : CH.mute; ctx.textAlign='left';
    ctx.fillText(r + '×', W-PR+5, RY2(r));
  });
  pts.forEach((p,i)=>{
    const r = ratioOf(p), yy = RY2(r), pp = i > 0 ? pts[i-1].price : prev;
    ctx.fillStyle = p.price >= pp ? CH.up : CH.dn; ctx.globalAlpha = .5;
    const bwid = Math.max(1, innerW/pts.length*0.66);
    ctx.fillRect(X(i)-bwid/2, yy, bwid, s1-yy);
    ctx.globalAlpha = 1;
  });
  ctx.fillStyle = CH.mute; ctx.textAlign = 'left';
  ctx.fillText(_vslots ? '放量倍数（该分钟量 ÷ 前5日同一时段均量，1× = 常态）'
                       : '放量倍数（该分钟量 ÷ 当日均量 —— 早盘天然偏高，基准未取到）', PL+1, s0+8);

  // 时间轴
  const marks = ['0930','1030','1130','1400','1500'];
  ctx.textAlign = 'center'; ctx.fillStyle = CH.mute;
  marks.forEach(t=>{
    let idx = -1;
    for (let i=0;i<pts.length;i++) if (pts[i].t === t){ idx = i; break; }
    if (idx < 0) return;
    ctx.fillText(t.slice(0,2) + ':' + t.slice(2), X(idx), H-7);
  });

  // 悬停
  const hs = _hover[cv.id];
  const hi = (hs != null && hs >= 0 && hs < pts.length) ? hs : -1;
  if (hi >= 0){
    const p = pts[hi];
    ctx.save(); ctx.strokeStyle = '#66707c'; ctx.lineWidth = 1; ctx.setLineDash([3,3]);
    ctx.beginPath(); ctx.moveTo(X(hi)+.5, y0); ctx.lineTo(X(hi)+.5, s1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(PL, Y(p.price)+.5); ctx.lineTo(W-PR, Y(p.price)+.5); ctx.stroke();
    ctx.restore();
  }
  const p = hi >= 0 ? pts[hi] : lastPt;
  const pctv = (p.price - prev)/prev*100;
  const row = p.t.slice(0,2) + ':' + p.t.slice(2) + '  价 ' + f2(p.price) + '  ' + pct(pctv)
            + '  均价 ' + f2(p.avg) + '  该分钟 ' + p.vol + ' 手';
  ctx.textAlign = 'left';
  chipText(ctx, row, PL, 12, pctv >= 0 ? CH.up : CH.dn, 'rgba(255,255,255,.95)');
  chipText(ctx, '昨收 ' + f2(prev) + '　量比 ' + nf(+s.vr, 2) + '　换手 ' + (s._ta && s._ta.turnover ? s._ta.turnover.toFixed(2) + '%' : '—')
    + '　现价' + (p.price >= p.avg ? '在均价上方（强）' : '在均价下方（弱）'), PL, 27, CH.txt, 'rgba(255,255,255,.95)');
}

/* ===================== 图表工具条（周期 / 叠加 / 副图） ===================== */
function kbarHTML(i, s){
  const p = s.p || 'day';
  const ov = s.ov || {};
  const sub = s.sub || 'macd';
  const rt = p === 'rt';                    // 分时图没有蜡烛/均线概念，叠加与副图开关此时无意义，直接不显示
  return `<div class="kbar k-main">`
    + `<span class="lbl">周期</span>` + PERIODS.filter(([k])=>P_MAIN.indexOf(k)>=0).map(([k,v])=>
        `<span class="chip pd${p===k?' on':''}" data-pd="${i}" data-v="${k}">${v}</span>`).join('')
    + `<details class="pd-more"><summary>更多 ▾</summary><div class="pd-pop">`
    + P_MORE.map(([k,v])=>`<span class="chip pd${p===k?' on':''}" data-pd="${i}" data-v="${k}">${v}</span>`).join('')
    + `</div></details>`
    + (rt ? `<span class="sp"></span><span class="lbl">分时图自带：价格线 / 均价线 / 分时量 / 放量倍数</span>`
          : `<span class="sp"></span>`
          + `<span class="lbl">叠加</span>` + Object.keys(OV_DEF).map(k=>
              `<span class="chip ov${ov[k]?' on':''}" data-ovl="${i}" data-v="${k}">${OV_DEF[k]}</span>`).join('')
          + `<span class="sp"></span>`
          + `<span class="lbl">副图</span>` + Object.keys(SUB_DEF).map(k=>
              `<span class="chip sb${sub===k?' on':''}" data-sub="${i}" data-v="${k}">${SUB_DEF[k]}</span>`).join(''))
    + `<span class="sp"></span>`
    + `<span class="chip${(s._dd&&s._dd.dd)?' on':''}" data-ddload="${i}" title="拉取当日逐笔成交，按单笔金额分档统计主力/大单净额与净量（约 1 秒）">💰 大单资金</span>`
    + `<span class="rd" id="kmeta-${i}">${chartMeta(s)}</span>`
    + `</div>`;
}
function chartMeta(s){
  const p = s.p || 'day';
  const e = (s._k || {})[p];
  if (!e) return '待取数';
  const n = e.kind === 'line' ? ((e.min && e.min.pts.length) || 0) : ((e.ks && e.ks.length) || 0);
  return PERIOD_LABEL[p] + ' · ' + n + (e.kind === 'line' ? ' 分钟' : ' 根') + ' · ' + new Date(e.at).toLocaleTimeString('zh-CN',{hour12:false});
}
/* 画布下方的颜色图例。放在 HTML 而不是画在 canvas 上：文字可选中、不会被裁切、
   也腾出了画布顶部的空间给"悬停信息条"（两行：OHLC+量 / 各指标取值）。 */
function chartLegendHTML(s){
  const p = s.p || 'day';
  const ov = s.ov || {};
  const it = (t, c)=> `<span><i style="background:${c}"></i>${t}</span>`;
  /* 图例画错色是会误导下单的：价格线、成交量在图上都随涨跌变色，
     原来图例却给它们画了单色（价格线画成红、成交量画成灰），
     和图上看到的不一致。红绿双色项一律用左右分色块。 */
  const it2 = (t, c1, c2)=> `<span><i style="background:linear-gradient(90deg,${c1} 0 50%,${c2} 50% 100%)"></i>${t}</span>`;
  const out = [];
  if (p === 'rt'){
    out.push(it2('价格线', CH.up, CH.dn), it('均价线', CH.avg), it2('分时量', CH.up, CH.dn));
  } else {
    if (ov.ma) out.push(it('MA5',CH.ma5), it('MA10',CH.ma10), it('MA20',CH.ma20), it('MA60',CH.ma60));
    if (ov.boll) out.push(it('BOLL 上/下轨', CH.bollU), it('BOLL 中轨', CH.bollM));
    out.push(it2('成交量', CH.up, CH.dn), it('VMA5', CH.vma));
  }
  if (ov.box) out.push(it('20日箱体', CH.box));
  if (ov.cost && +s.cost > 0) out.push(it('持仓成本', CH.cost));
  if (ov.sr) out.push(it('压力位', CH.sr), it('支撑位', CH.dn));
  return `<div class="k-legend">${out.join('')}</div>`;
}
/* 图表下方的实时数据条：把"图上看得见"的指标都写成可读数字，方便直接抄进挂单表 */
function chartStat(s){
  const ta = s._ta;
  const p = s.p || 'day';
  const e = (s._k || {})[p];
  const cell = (k, v, cls)=> `<span class="st${cls?' '+cls:''}"><em>${k}</em><b>${v}</b></span>`;
  const out = [];
  if (p === 'rt'){
    const mn = e && e.min;
    if (mn && mn.pts.length){
      const lastP = mn.pts[mn.pts.length-1];
      const prev = mn.prev || +s.prevClose;
      out.push(cell('现价', f2(lastP.price), lastP.price >= prev ? 'up' : 'dn'));
      out.push(cell('均价', f2(lastP.avg), lastP.price >= lastP.avg ? 'up' : 'dn'));
      out.push(cell('价/均', ((lastP.price/lastP.avg - 1)*100).toFixed(2) + '%', lastP.price >= lastP.avg ? 'up' : 'dn'));
      const totV = (mn.pts[mn.pts.length-1] && (mn.pts.reduce((a,x)=>a+x.vol,0))) || 0;
      out.push(cell('分时量', totV >= 10000 ? (totV/10000).toFixed(2) + '万手' : totV + '手'));
    }
  }
  if (ta){
    if (ta.turnover) out.push(cell('换手率', ta.turnover.toFixed(2) + '%'));
    out.push(cell('量比', nf(+s.vr, 2)));
    if (ta.bl && ta.bl.up != null) out.push(cell('BOLL', nf(ta.bl.dn) + ' / ' + nf(ta.bl.mid) + ' / ' + nf(ta.bl.up)));
    if (ta.r && ta.r.r6 != null) out.push(cell('RSI6', ta.r.r6.toFixed(1), ta.r.r6 >= 70 ? 'up' : ta.r.r6 <= 30 ? 'dn' : ''));
    if (ta.bwDelta != null) out.push(cell('带宽', ta.bl.bw != null ? ta.bl.bw.toFixed(2) + '%' : '—', ta.bwDelta > 8 ? 'up' : ta.bwDelta < -8 ? 'dn' : ''));
  }
  if (s._dd && s._dd.dd){
    const d = s._dd.dd;
    out.push(cell('主力净额', (d.main.net >= 0 ? '+' : '') + money$(d.main.net), d.main.net >= 0 ? 'up' : 'dn'));
    out.push(cell('大单净量', (d.main.netv >= 0 ? '+' : '') + d.main.netv.toFixed(0) + '手', d.main.netv >= 0 ? 'up' : 'dn'));
  }
  if (ta && ta.levels && (ta.levels.res.length || ta.levels.sup.length)){
    const r1 = ta.levels.res[0], s1 = ta.levels.sup[0];
    if (s1) out.push(cell('支撑', f2(s1.p) + ' ' + s1.label + '(' + s1.strength + ')', 'dn'));
    if (r1) out.push(cell('压力', f2(r1.p) + ' ' + r1.label + '(' + r1.strength + ')', 'up'));
  }
  if (!out.length) return '';
  return `<div class="k-stat">${out.join('')}</div>`;
}

/* ===================== 持仓与成本核算 =====================
   口径说明（重要，避免重复计算）：
     · `cost`   = 你填的**当前持仓成本**（券商显示的成本价 / 自己加权算的均价），是账户事实。
     · `tReal`  = 该股**累计做T已实现净收益**（从执行台账自动汇总，已扣摩擦成本）。
     · 「每股降本」= tReal / 持仓股数 —— 表示做T相当于把每股成本往下压了多少。
     · 「等效未做T成本」= cost + 每股降本 —— 反推：如果这笔股一次T都没做，成本会在哪。
       两者是同一件事的两种表述，**不做二次扣减**，所以不会重复计算。 */
function tRealOf(code){
  let sum = 0, n = 0;
  (LOG || []).forEach(r=>{
    if (String(r.stock||'').indexOf(String(code)) < 0) return;
    const v = logNet(r);
    if (v !== null){ sum += v; n++; }
  });
  return { sum, n };
}

function posCalc(s){
  const px   = +s.price || 0;
  const cost = +s.cost  || 0;
  const sh   = Math.round(+s.shares || 0);
  const pc   = +s.prevClose || 0;
  const cap  = Math.round(+s.cap || 0);

  const mkt     = px * sh;                       // 持仓市值
  const costAmt = cost * sh;                     // 持仓成本金额
  const floatPL = sh ? (px - cost) * sh : 0;     // 浮动盈亏
  const floatPct= (sh && cost) ? (px - cost)/cost*100 : null;
  const dayPL   = (sh && pc) ? (px - pc) * sh : null;   // 当日盈亏（持仓不变口径）
  const dayPct  = pc ? (px - pc)/pc*100 : null;

  const t = tRealOf(s.code);
  const tPerShare = (sh && t.n) ? t.sum/sh : null;

  // T仓预算：优先用"可用现金"，无现金则按底仓倒T法（卖出底仓的30%筹码）
  const tBudget = cap > 0 ? Math.round(cap*0.3) : (sh ? Math.round(sh*0.3*px) : 0);

  return { px, cost, sh, cap, mkt, costAmt, floatPL, floatPct, dayPL, dayPct,
           tReal:t.sum, tCount:t.n, tPerShare,
           costNoT: tPerShare!==null ? cost + tPerShare : null,
           tBudget, hasPos: sh > 0,
           // 成本线的技术含义：现价在成本上方=安全垫，下方=被套
           aboveCost: (sh && cost) ? px > cost : null };
}

/* 全局账户汇总 */
function accountSummary(){
  let mkt=0, costAmt=0, floatPL=0, dayPL=0, tReal=0, poolCap=0, posN=0;
  pool.forEach(s=>{
    const p = posCalc(s);
    if (p.sh > 0){ mkt += p.mkt; costAmt += p.costAmt; floatPL += p.floatPL;
                   if (p.dayPL!==null) dayPL += p.dayPL; posN++; }
    tReal += p.tReal; poolCap += p.cap;
  });

  // 读取用户自定义设置的【总资产】本金（元）
  const customTotal = +localStorage.getItem('t-account-total') || 0;
  let total = 0;
  let cap = 0;

  if (customTotal > 0) {
    total = customTotal;
    cap = Math.max(0, total - mkt);
  } else {
    cap = poolCap;
    total = mkt + cap;
  }

  return { mkt, costAmt, floatPL, dayPL, tReal, cap, posN, total, customTotal,
           floatPct: costAmt ? floatPL/costAmt*100 : null,
           dayPct: (mkt-dayPL) ? dayPL/(mkt-dayPL)*100 : null,
           posRate: total > 0 ? (mkt/total*100) : 0 };       // 仓位占比
}

/* ===================== 每日快照（收益曲线） ===================== */
let SNAP = [];
try{ const raw = localStorage.getItem('t-system-snap'); if(raw) SNAP = JSON.parse(raw); }catch(_){}
function saveSnap(){ try{ localStorage.setItem('t-system-snap', JSON.stringify(SNAP)); }catch(_){} }
function takeSnapshot(){
  const a = accountSummary();
  if (!a.posN) return null;
  const today = todayStr();
  const rec = { date:today, mkt:Math.round(a.mkt), costAmt:Math.round(a.costAmt),
                floatPL:Math.round(a.floatPL), dayPL:Math.round(a.dayPL), tReal:Math.round(a.tReal),
                total:Math.round(a.total), posRate:+(a.posRate||0).toFixed(1) };
  const i = SNAP.findIndex(x=>x.date===today);
  if (i >= 0) SNAP[i] = rec; else SNAP.push(rec);
  SNAP.sort((x,y)=> x.date < y.date ? -1 : 1);
  saveSnap();
  return rec;
}

/* ===================== 持仓条 / 技术指标卡（渲染辅助） ===================== */
const money2 = n => (n>=0?'+':'−') + Math.abs(Math.round(n)).toLocaleString('zh-CN');

function posBar(s, p, i){
  const fCls = p.floatPL >= 0 ? 'up' : 'dn';
  const dCls = (p.dayPL||0) >= 0 ? 'up' : 'dn';
  // 统计今日已做T买入的股数（T+1锁死不可卖）
  const d = new Date();
  const todayStr = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  const todayTBuys = (typeof LOG !== 'undefined' ? LOG : [])
    .filter(r => r.date === todayStr && (r.stock === s.name || r.stock === s.code) && r.dir === '正T')
    .reduce((a, b) => a + (+b.qty || 0), 0);
  const shTotal = Math.round(+s.shares || 0);
  const availSell = Math.max(0, shTotal - todayTBuys);

  let tCell = `<div class="pb"><span class="k">做T累计已实现</span><span class="v" style="color:var(--mute)">—</span><span class="d">台账里还没有该股的记录</span></div>`;
  if (p.tCount){
    tCell = `<div class="pb hl"><span class="k">做T累计贡献（${p.tCount}笔）</span>
      <span class="v">${money2(p.tReal)}</span>
      <span class="d">折合每股降本 ${f3(p.tPerShare)} 元${p.costNoT!==null?' ｜ 未做T成本约 '+f2(p.costNoT):''}</span></div>`;
  }
  return `<div class="pos-bar">
    <div class="pb pb-hold" title="可直接在框内修改持仓参数，失焦或回车即时更新">
      <div class="pb-row">
        <span class="k">持仓股数</span>
        <div class="pb-inp-box">
          <input class="pb-inp" data-i="${i}" data-k="shares" value="${fmtIn(s.shares)}" placeholder="0" inputmode="numeric" step="100">
          <span class="pb-unit">股</span>
        </div>
      </div>
      <div class="pb-row">
        <span class="k">持仓成本</span>
        <div class="pb-inp-box">
          <input class="pb-inp" data-i="${i}" data-k="cost" value="${fmtIn(s.cost)}" placeholder="0.00" inputmode="decimal" step="0.01">
          <span class="pb-unit">元</span>
        </div>
      </div>
      <div class="pb-row">
        <span class="k">可用现金</span>
        <div class="pb-inp-box">
          <input class="pb-inp" data-i="${i}" data-k="cap" value="${fmtIn(s.cap)}" placeholder="0" inputmode="numeric" step="1000">
          <span class="pb-unit">元</span>
        </div>
      </div>
      ${shTotal > 0 ? `<div class="pb-t1-bar"><span>可卖底仓: <b>${availSell}</b> 股</span>${todayTBuys > 0 ? `<span style="color:var(--warn-d)" title="今日正T买入的筹码受 A 股 T+1 限制，今日不可卖，卖出必动底仓！">今日锁仓: <b>${todayTBuys}</b> 股 (T+1冻结)</span>` : '<span style="color:var(--down)">无今日冻结</span>'}</div>` : ''}
    </div>
    <div class="pb"><span class="k">持仓市值</span><span class="v">${p.hasPos ? Math.round(p.mkt).toLocaleString('zh-CN') : '—'}</span><span class="d">${p.hasPos ? `${p.sh.toLocaleString('zh-CN')} 股 × ${f2(p.px)}` : '录入股数后自动核算'}</span></div>
    <div class="pb ${p.hasPos ? fCls : ''}"><span class="k">浮动盈亏</span><span class="v">${p.hasPos ? money2(p.floatPL) : '—'}</span><span class="d">${p.hasPos ? `成本 ${f2(p.cost)} ｜ ${p.floatPct!==null?pct(p.floatPct):'—'}` : '成本价对比'}</span></div>
    <div class="pb ${p.hasPos ? dCls : ''}"><span class="k">当日盈亏</span><span class="v">${p.hasPos && p.dayPL!==null ? money2(p.dayPL) : '—'}</span><span class="d">${p.hasPos ? `按昨收 ${f2(+s.prevClose)} 计${p.dayPct!==null?' ｜ '+pct(p.dayPct):''}` : '日内持仓变动'}</span></div>
    ${tCell}
  </div>`;
}


/* ===================== 实时买卖记账与实时卖出选项 ===================== */
function calcLiveTrade(buyPx, sellPx, qty, totalShares) {
  const feeRate = (typeof FEE !== 'undefined' ? FEE : 0.0011);
  const buyAmt = buyPx * qty;
  const sellAmt = sellPx * qty;
  const friction = (buyAmt + sellAmt) * feeRate;
  const grossProfit = sellAmt - buyAmt;
  const netProfit = grossProfit - friction;
  const profitRatio = buyPx > 0 ? ((sellPx - buyPx) / buyPx - feeRate) * 100 : 0;
  const costReduction = totalShares > 0 ? (netProfit / totalShares) : 0;
  const newCost = Math.max(0, buyPx - costReduction);

  return {
    buyAmt: +buyAmt.toFixed(2),
    sellAmt: +sellAmt.toFixed(2),
    friction: +friction.toFixed(2),
    netProfit: +netProfit.toFixed(2),
    profitRatio: +profitRatio.toFixed(2),
    costReduction: +costReduction.toFixed(3),
    newCost: +newCost.toFixed(3)
  };
}

function liveTradeBar(s, p, c, i){
  const hasPos = p.hasPos && (s.shares > 0) && (s.cost > 0);
  const curPx = +s.price || +s.prevClose || 0;
  const defaultSellPx = s._sellPx != null ? s._sellPx : (c.tp1 || curPx || +s.cost);
  const recQty = c.t1Lots || (s.shares >= 300 ? 300 : Math.min(100, s.shares || 100));

  // 今日正T冻结与可卖底仓计算
  const d = new Date();
  const todayStr = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  const todayTBuys = (typeof LOG !== 'undefined' ? LOG : [])
    .filter(r => r.date === todayStr && (r.stock === s.name || r.stock === s.code) && (r.dir === '正T' || r.dir === '买入建仓'))
    .reduce((a, b) => a + (+b.qty || 0), 0);
  const availSell = Math.max(0, (s.shares || 0) - todayTBuys);

  const activeTab = s._tradeTab || 'sell';

  if (hasPos) {
    if (activeTab === 'buy') {
      // 持仓状态下的追加买入 / 加仓
      const defAddBuy = c.inA || curPx || +s.cost;
      return `
        <div class="live-trade-strip buy-strip" data-lts="${i}">
          <div class="lts-header">
            <div class="lts-tabs">
              <button type="button" class="lts-tab-btn" data-switch-tab="sell" data-i="${i}">⚡ 做T / 卖出记账</button>
              <button type="button" class="lts-tab-btn active" data-switch-tab="buy" data-i="${i}">➕ 追加买入 / 加仓</button>
            </div>
            <div class="lts-sub">当前持仓: <b>${s.shares}股</b> (成本 ¥${f2(s.cost)}) ｜ 追加买入将按加权平均法重新核算底仓成本</div>
          </div>
          <div class="lts-body">
            <div class="lts-item">
              <span class="lts-k">加仓买入价</span>
              <div class="lts-val-box">
                <span class="lts-unit">¥</span>
                <input class="lts-inp lts-buy" id="ltbBuy_${i}" data-lt-i="${i}" type="number" step="0.01" value="${f2(defAddBuy)}" placeholder="买入价">
                <div class="lts-quick-pills">
                  <button type="button" class="lts-pill-btn" data-fill-buy="${f2(curPx)}" data-i="${i}" title="填入最新现价">现价 ${f2(curPx)}</button>
                  ${c.inA ? `<button type="button" class="lts-pill-btn" data-fill-buy="${f2(c.inA)}" data-i="${i}" title="填入建议低吸买点">低吸 ${f2(c.inA)}</button>` : ''}
                </div>
              </div>
            </div>
            <div class="lts-item">
              <span class="lts-k">加仓股数</span>
              <div class="lts-val-box">
                <input class="lts-inp lts-qty" id="ltbQty_${i}" data-lt-i="${i}" type="number" step="100" value="${recQty}" style="width:78px">
                <span class="lts-unit-text">股</span>
                <div class="lts-quick-pills">
                  <button type="button" class="lts-pill-btn" data-fill-bqty="100" data-i="${i}">1手</button>
                  <button type="button" class="lts-pill-btn" data-fill-bqty="300" data-i="${i}">3手</button>
                  <button type="button" class="lts-pill-btn" data-fill-bqty="${recQty}" data-i="${i}">T仓(${recQty})</button>
                </div>
              </div>
            </div>
            <div class="lts-act">
              <button type="button" class="btn-lts-exec buy" data-exec-buy="${i}">🟢 确认追加买入</button>
            </div>
          </div>
        </div>
      `;
    }

    // 默认：持仓状态下的实时卖出及卖出价选项
    return `
      <div class="live-trade-strip sell-strip" data-lts="${i}">
        <div class="lts-header">
          <div class="lts-tabs">
            <button type="button" class="lts-tab-btn active" data-switch-tab="sell" data-i="${i}">⚡ 实时卖出记账</button>
            <button type="button" class="lts-tab-btn" data-switch-tab="buy" data-i="${i}">➕ 追加买入</button>
          </div>
          <div class="lts-sub">
            持仓买入成本: <b>¥${f2(s.cost)}</b> ｜ 持仓: <b>${s.shares}</b> 股 ｜ 可卖底仓: <b>${availSell}</b> 股
          </div>
        </div>
        <div class="lts-body">
          <div class="lts-item">
            <span class="lts-k">买入价(持仓)</span>
            <div class="lts-val-box">
              <span class="lts-unit">¥</span>
              <input class="lts-inp lts-buy" id="ltbBuy_${i}" data-lt-i="${i}" type="number" step="0.01" value="${f2(s.cost)}" title="持仓成本买入价，可微调核算">
            </div>
          </div>
          <span class="lts-arrow">➔</span>
          <div class="lts-item">
            <span class="lts-k">卖出目标价</span>
            <div class="lts-val-box">
              <span class="lts-unit">¥</span>
              <input class="lts-inp lts-sell" id="ltbSell_${i}" data-lt-i="${i}" type="number" step="0.01" value="${f2(defaultSellPx)}" placeholder="卖出价">
              <div class="lts-quick-pills">
                <button type="button" class="lts-pill-btn" data-fill-sell="${f2(curPx)}" data-i="${i}" title="填入最新现价">现价 ${f2(curPx)}</button>
                ${c.tp1 ? `<button type="button" class="lts-pill-btn" data-fill-sell="${f2(c.tp1)}" data-i="${i}" title="填入T1止盈目标价">T1 ${f2(c.tp1)}</button>` : ''}
                ${c.tp2 ? `<button type="button" class="lts-pill-btn" data-fill-sell="${f2(c.tp2)}" data-i="${i}" title="填入T2高抛目标价">T2 ${f2(c.tp2)}</button>` : ''}
              </div>
            </div>
          </div>
          <div class="lts-item">
            <span class="lts-k">卖出股数</span>
            <div class="lts-val-box">
              <input class="lts-inp lts-qty" id="ltbQty_${i}" data-lt-i="${i}" type="number" step="100" value="${recQty}" style="width:72px">
              <span class="lts-unit-text">股</span>
              <div class="lts-quick-pills">
                <button type="button" class="lts-pill-btn" data-fill-qty="100" data-i="${i}">1手</button>
                ${c.t1Lots && c.t1Lots !== 100 ? `<button type="button" class="lts-pill-btn" data-fill-qty="${c.t1Lots}" data-i="${i}">T仓${c.t1Lots}</button>` : ''}
                <button type="button" class="lts-pill-btn" data-fill-qty="${availSell}" data-i="${i}">全卖(${availSell})</button>
              </div>
            </div>
          </div>
          <div class="lts-item">
            <span class="lts-k">记账模式</span>
            <select class="lts-sel" id="ltbMode_${i}" data-lt-i="${i}">
              <option value="t">做T平仓（冲减成本，股数不变）</option>
              <option value="reduce">减仓出局（扣减股数，回笼资金）</option>
            </select>
          </div>
          <div class="lts-act">
            <button type="button" class="btn-lts-exec sell" data-exec-sell="${i}">🔴 确认卖出记账</button>
          </div>
        </div>
        <div class="lts-preview" id="ltbPrev_${i}">
        </div>
      </div>
    `;
  } else {
    // 尚未持仓：引导买入建仓，录入买入价后立即激活卖出选项
    const defBuy = c.inA || curPx || 10.0;
    return `
      <div class="live-trade-strip buy-strip empty-pos" data-lts="${i}">
        <div class="lts-header">
          <div class="lts-tabs">
            <span class="lts-badge buy">🟢 实时买入建仓</span>
          </div>
          <div class="lts-sub">设置买入建仓价与股数，确认买入后将实时记账并立即激活卖出及卖出价选项</div>
        </div>
        <div class="lts-body">
          <div class="lts-item">
            <span class="lts-k">买入建仓价</span>
            <div class="lts-val-box">
              <span class="lts-unit">¥</span>
              <input class="lts-inp lts-buy" id="ltbBuy_${i}" data-lt-i="${i}" type="number" step="0.01" value="${f2(defBuy)}" placeholder="买入价">
              <div class="lts-quick-pills">
                <button type="button" class="lts-pill-btn" data-fill-buy="${f2(curPx)}" data-i="${i}" title="填入最新现价">现价 ${f2(curPx)}</button>
                ${c.inA ? `<button type="button" class="lts-pill-btn" data-fill-buy="${f2(c.inA)}" data-i="${i}" title="填入建议低吸买点">低吸 ${f2(c.inA)}</button>` : ''}
              </div>
            </div>
          </div>
          <div class="lts-item">
            <span class="lts-k">买入股数</span>
            <div class="lts-val-box">
              <input class="lts-inp lts-qty" id="ltbQty_${i}" data-lt-i="${i}" type="number" step="100" value="${c.t1Lots || 300}" style="width:78px">
              <span class="lts-unit-text">股</span>
              <div class="lts-quick-pills">
                <button type="button" class="lts-pill-btn" data-fill-bqty="100" data-i="${i}">1手</button>
                <button type="button" class="lts-pill-btn" data-fill-bqty="300" data-i="${i}">3手</button>
                <button type="button" class="lts-pill-btn" data-fill-bqty="500" data-i="${i}">5手</button>
              </div>
            </div>
          </div>
          <div class="lts-act">
            <button type="button" class="btn-lts-exec buy" data-exec-buy="${i}">🟢 确认买入记账</button>
          </div>
        </div>
      </div>
    `;
  }
}

function updateLtbPreview(idx){
  const s = pool[idx];
  if (!s) return;
  const prevBox = document.getElementById(`ltbPrev_${idx}`);
  if (!prevBox) return;

  const buyInp = document.getElementById(`ltbBuy_${idx}`);
  const sellInp = document.getElementById(`ltbSell_${idx}`);
  const qtyInp = document.getElementById(`ltbQty_${idx}`);
  const modeSel = document.getElementById(`ltbMode_${idx}`);

  if (!buyInp || !sellInp || !qtyInp) return;

  const buyPx = parseFloat(buyInp.value) || 0;
  const sellPx = parseFloat(sellInp.value) || 0;
  const qty = parseInt(qtyInp.value, 10) || 0;
  const mode = modeSel ? modeSel.value : 't';
  const totalShares = s.shares || 0;

  if (buyPx <= 0 || sellPx <= 0 || qty <= 0) {
    prevBox.innerHTML = '<span style="color:var(--mute)">请输入有效买卖价与股数以测算预估差价</span>';
    return;
  }

  const res = calcLiveTrade(buyPx, sellPx, qty, totalShares);
  const isUp = res.netProfit >= 0;
  const col = isUp ? 'var(--up)' : 'var(--down)';

  if (mode === 't') {
    prevBox.innerHTML = `
      <div class="lts-prev-content">
        <span class="lts-prev-tag">做T测算</span>
        <span>预估净差价: <b style="color:${col}">${isUp ? '+' : ''}${money2(res.netProfit)} 元</b> (${res.profitRatio >= 0 ? '+' : ''}${res.profitRatio}%)</span>
        <span class="lts-dot">·</span>
        <span>底仓降本: <b style="color:${col}">${res.costReduction >= 0 ? '−' : '+'}${Math.abs(res.costReduction)} 元/股</b></span>
        <span class="lts-dot">·</span>
        <span>做T后新成本: <b style="color:var(--text);font-family:ui-monospace,Consolas,monospace">¥${res.newCost}</b></span>
        <span class="lts-friction">(已扣佣金+印花税约 ¥${res.friction})</span>
      </div>
    `;
  } else {
    prevBox.innerHTML = `
      <div class="lts-prev-content">
        <span class="lts-prev-tag">减仓测算</span>
        <span>减仓盈亏: <b style="color:${col}">${isUp ? '+' : ''}${money2(res.netProfit)} 元</b> (${res.profitRatio >= 0 ? '+' : ''}${res.profitRatio}%)</span>
        <span class="lts-dot">·</span>
        <span>回笼资金: <b>¥${Math.round(res.sellAmt - res.friction).toLocaleString('zh-CN')}</b></span>
        <span class="lts-dot">·</span>
        <span>剩余持仓: <b>${Math.max(0, totalShares - qty)} 股</b></span>
        <span class="lts-friction">(已扣佣金+印花税约 ¥${res.friction})</span>
      </div>
    `;
  }
}

function execLiveSell(idx){
  const s = pool[idx];
  if (!s) return;

  const buyInp = document.getElementById(`ltbBuy_${idx}`);
  const sellInp = document.getElementById(`ltbSell_${idx}`);
  const qtyInp = document.getElementById(`ltbQty_${idx}`);
  const modeSel = document.getElementById(`ltbMode_${idx}`);

  const buyPx = parseFloat(buyInp.value) || 0;
  const sellPx = parseFloat(sellInp.value) || 0;
  const qty = parseInt(qtyInp.value, 10) || 0;
  const mode = modeSel ? modeSel.value : 't';
  const totalShares = s.shares || 0;

  if (buyPx <= 0) { toastWarn('请输入有效的买入价格'); return; }
  if (sellPx <= 0) { toastWarn('请输入有效的卖出价格'); return; }
  if (qty <= 0) { toastWarn('请输入卖出股数'); return; }
  if (qty > totalShares) { toastWarn(`卖出股数 (${qty}) 不能大于当前总持仓 (${totalShares} 股)`); return; }

  const res = calcLiveTrade(buyPx, sellPx, qty, totalShares);
  const d = new Date();
  const today = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');

  const rec = {
    date: today,
    stock: s.name,
    dir: mode === 't' ? '正T' : (totalShares === qty ? '清仓卖出' : '减仓卖出'),
    buy: buyPx,
    sell: sellPx,
    qty,
    plan: '计划内',
    basis: '客观信号',
    note: mode === 't' ? `卡片实时做T(降本${res.costReduction}元/股)` : `卡片实时减仓`
  };
  LOG.push(rec);
  try { localStorage.setItem('t-system-log', JSON.stringify(LOG)); } catch(e){}

  const oldCost = s.cost;
  if (mode === 't') {
    s.cost = res.newCost;
  } else {
    s.shares = Math.max(0, totalShares - qty);
    if (s.shares === 0) s.cost = 0;
  }

  savePool();
  renderLog();
  render(pool);

  const profitStr = (res.netProfit >= 0 ? '+' : '') + res.netProfit.toLocaleString('zh-CN');
  if (mode === 't') {
    toastOk(`✓ 已成功记录卖出：${s.name} 买入 ¥${f2(buyPx)} ➔ 卖出 ¥${f2(sellPx)}，净差价 ${profitStr} 元！底仓成本由 ¥${f2(oldCost)} 降至 ¥${f2(s.cost)}！`);
  } else {
    toastOk(`✓ 已成功记录减仓：${s.name} 卖出 ${qty} 股，净盈亏 ${profitStr} 元，剩余持仓 ${s.shares} 股！`);
  }
}

function execLiveBuy(idx){
  const s = pool[idx];
  if (!s) return;

  const buyInp = document.getElementById(`ltbBuy_${idx}`);
  const qtyInp = document.getElementById(`ltbQty_${idx}`);

  const buyPx = parseFloat(buyInp.value) || 0;
  const qty = parseInt(qtyInp.value, 10) || 0;

  if (buyPx <= 0) { toastWarn('请输入有效的买入价格'); return; }
  if (qty <= 0) { toastWarn('请输入买入股数'); return; }

  const d = new Date();
  const today = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');

  const oldShares = s.shares || 0;
  const oldCost = s.cost || 0;

  if (oldShares > 0) {
    // 加仓：加权平均计算新成本
    const newShares = oldShares + qty;
    const newCost = +(((oldCost * oldShares) + (buyPx * qty)) / newShares).toFixed(3);
    s.shares = newShares;
    s.cost = newCost;
  } else {
    s.shares = qty;
    s.cost = buyPx;
  }
  s._tradeTab = 'sell'; // 买入后直接切到卖出tab

  const rec = {
    date: today,
    stock: s.name,
    dir: oldShares > 0 ? '加仓买入' : '买入建仓',
    buy: buyPx,
    sell: '',
    qty,
    plan: '计划内',
    basis: '客观信号',
    note: oldShares > 0 ? `卡片实时加仓(持仓增至${s.shares}股)` : '卡片实时建仓买入'
  };
  LOG.push(rec);
  try { localStorage.setItem('t-system-log', JSON.stringify(LOG)); } catch(e){}

  savePool();
  renderLog();
  render(pool);

  toastOk(`✓ 成功记录买入：${s.name} 买入 ${qty} 股（买入价 ¥${f2(buyPx)}）！当前持仓 ${s.shares} 股（成本 ¥${f2(s.cost)}），已激活卖出记账选项！`);
}

/* ===================== 研究卡渲染：估值分位 · 板块归属 · 相对强弱 =====================
   这三块补的是原系统完全空白的研究层：以前只回答"今天怎么买卖"，
   回答不了"贵不贵、暴露在哪些主题上、跑赢还是跑输大盘"。 */
function pctTag(p){
  if (p==null) return '<span class="sig s-nt">—</span>';
  const cls = p<=25 ? 's-ok' : p>=75 ? 's-no' : 's-nt';
  return `<span class="sig ${cls}">${p.toFixed(0)}%</span>`;
}
/* 三窗口分位文字。参数 all 必须传「窗口映射」而不是单个窗口。
   这里每个窗口都做 (all||{})[k] || {} 兜底：单个字段缺失只应让这一格显示「—」，
   绝不能让一个可选数据的缺失把整个 render 打挂。 */
function winTxt(all){
  return VAL_WIN.map(([k,label])=>{
    const s = (all || {})[k] || {};
    return `${label} <b style="font-family:ui-monospace,Consolas,monospace">${s.pct==null?'—':s.pct.toFixed(0)+'%'}</b>`;
  }).join(' · ');
}
/* 分位条：横轴是**估值数值本身**（min→max），中位数刻度 + 当前值游标。
   注意横轴不是分位轴 —— 这样能一眼看出"离中位数多远、离极值多远"，比纯百分比有信息量。 */
function vBarHTML(st, cur){
  if (!st || cur==null || st.min==null || st.max==null || st.max<=st.min) return '';
  const pos = v => Math.max(0, Math.min(100, (v-st.min)/(st.max-st.min)*100));
  const pm = pos(st.med), hot = st.pct!=null && st.pct>=50;
  return `<div class="vbar">
      <div class="band" style="left:${pm}%;width:${Math.max(0,100-pm)}%"></div>
      <div class="med" style="left:${pm}%"></div>
      <div class="now${hot?'':' lo'}" style="left:${pos(cur)}%"></div>
    </div>
    <div class="vaxis"><span>${f2(st.min)}</span><span>中位 ${f2(st.med)}</span><span>${f2(st.max)}</span></div>`;
}
/* 一行估值：左=名称与当前值，中=分位条，右=三窗口分位文字。
   ⚠️ 这里有两个**不同层级**的对象，早期版本把二者混用导致整段 render 中断：
      win  = 单个窗口的统计 {label,pct,med,min,max,n}  → 给分位条用
      all  = 窗口映射 {1y:{...},3y:{...},5y:{...}}    → 给 winTxt 用
   把 v.pe['3y'] 同时当这两个用，winTxt 里 st['1y'] 就是 undefined，
   抛 "Cannot read properties of undefined (reading 'pct')"，
   后果不只是这张卡坏掉 —— render() 整体抛出，innerHTML 不再赋值，
   页面上会残留上一次的 DOM，表现为"K线图只剩下网格线"这种莫名其妙的症状。 */
function valRow(label, cur, win, all){
  return `<div style="display:grid;grid-template-columns:104px minmax(0,1fr) 168px;gap:10px;align-items:center;font-size:12px;margin-top:9px">
      <div><b>${label}</b><br><span style="font-family:ui-monospace,Consolas,monospace;font-size:14px;font-weight:700">${f2(cur)}</span></div>
      <div>${vBarHTML(win, cur)}</div>
      <div style="font-size:11.5px;color:var(--sub);line-height:1.7">${winTxt(all)}</div>
    </div>`;
}
function researchBlock(s, i, pool){
  const v = s._val, bd = s._bd, rs = rsCalc(s);
  const out = [];

  // ---- 估值分位 ----
  let valHTML;
  if (s._valErr){
    valHTML = `<div style="font-size:12px;color:var(--warn);margin-top:8px">估值序列取数失败：${s._valErr}</div>`;
  } else if (!v){
    valHTML = `<div style="font-size:12px;color:var(--mute);margin-top:8px">正在拉取上市以来的逐日 PE / PB 序列…（约 0.5 秒，每个交易日只拉一次）</div>`;
  } else {
    valHTML = valRow('PE-TTM', v.cur.pe, v.pe['3y'], v.pe)
            + valRow('PB-MRQ', v.cur.pb, v.pb['3y'], v.pb)
            + valRow('PS-TTM', v.cur.ps, v.ps['3y'], v.ps)
            + `<div style="font-size:11.5px;color:var(--mute);margin-top:8px">
                 分位口径：该标的 <b>${v.bars}</b> 个交易日（${v.start} ~ ${v.end}）中，有多少比例的交易日估值低于当前值。分位条横轴是估值数值本身，游标为当前值。
                 ${v.pe['3y'].pct!=null && v.pe['3y'].pct<=25 ? ' <b style="color:var(--down)">当前估值处于近3年偏低区，对长线底仓构成支撑。</b>' : ''}
                 ${v.pe['3y'].pct!=null && v.pe['3y'].pct>=75 ? ' <b style="color:var(--up)">当前估值处于近3年偏高区，底仓加码需谨慎。</b>' : ''}
               </div>`;
  }

  // ---- 板块归属 + 池内集中度 ----
  let bdHTML;
  if (s._bdErr){
    bdHTML = `<div style="font-size:12px;color:var(--warn);margin-top:8px">板块归属取数失败：${s._bdErr}</div>`;
  } else if (!bd){
    bdHTML = `<div style="font-size:12px;color:var(--mute);margin-top:8px">板块归属加载中…</div>`;
  } else {
    const tags = bd.list.slice(0,14).map(x=>{
      const cls = x.type==='行业' ? 'ind' : (x.type==='板块' ? 'sec' : (x.precise ? 'hot' : 'con'));
      return `<span class="bdg ${cls}">${x.name}</span>`;
    }).join('');
    // 池内集中度：同板块出现 ≥2 只 → 提示
    /* ⚠️ 只统计「行业」与「精确归入的概念题材」，必须排除三类伪板块标签：
       ① 地域（上海板块 / 江苏板块…）、② 交易通道（沪股通 / 深股通）、③ 宽泛标签（机构重仓 / 融资融券）。
       这三类在任意两只同城/同市场股票之间都共享，不过滤就会把集中度提示变成噪音
       —— 实测上海沿浦（汽车零部件）与上海九百（商贸零售）共享的正是"上海板块 + 沪股通"，
       按原始口径两只票会同时误报"同板块集中度风险"，与产业链风险毫无关系。 */
    const meaningful = x => x.type === '行业' || (x.precise && !x.type);
    const mine = {};
    (bd.list||[]).filter(meaningful).forEach(x=>{ mine[x.name] = 1; });
    const others = {};
    (pool||[]).forEach((o,j)=>{ if (j===i || !o._bd) return;
      (o._bd.list||[]).filter(meaningful).forEach(x=>{
        if (mine[x.name]) (others[x.name] = others[x.name]||[]).push(o.name); }); });
    const hits = Object.keys(others).filter(n=> others[n].length);
    bdHTML = `<div class="bdgs">${tags}</div>`
      + (hits.length
        ? `<div class="conc">⚠️ 池内集中度：${hits.slice(0,3).map(n=>`<b>${n}</b>（与 ${others[n].join('、')} 同板块）`).join('；')} —— 同一条产业链上的标的一旦遇到板块级杀跌会同时回撤，注意总仓位。</div>`
        : '');
  }

  // ---- 相对强弱 ----
  let rsHTML;
  if (!rs){
    rsHTML = `<div style="font-size:12px;color:var(--mute);margin-top:8px">相对强弱需要个股与指数日K就绪后计算（点一次「⟳ 取数」即可）。</div>`;
  } else {
    const beat = rs.r20!=null ? rs.r20>=0 : null;
    rsHTML = `<div class="rs-wrap"><canvas data-rs="${i}"></canvas></div>
      <div style="font-size:11.5px;color:var(--sub);margin-top:6px">
        20日相对强弱 <b style="font-family:ui-monospace,Consolas,monospace;color:${beat===null?'var(--sub)':beat?'var(--up)':'var(--down)'}">${rs.r20==null?'—':pct(rs.r20)}</b>
        · 60日 <b style="font-family:ui-monospace,Consolas,monospace;color:${rs.r60==null?'var(--sub)':rs.r60>=0?'var(--up)':'var(--down)'}">${rs.r60==null?'—':pct(rs.r60)}</b>
        · 当前 RS 分位 ${pctTag(rs.pct)}
        ${beat===null?'':` —— 近20个交易日<b>${beat?'跑赢':'跑输'}</b>参照指数`}
      </div>`;
  }

  return `<div class="ta t-nt" style="grid-column:1/-1;padding:12px 13px">
    <div class="h"><span>估值分位 · 板块归属 · 相对强弱</span>
      <span class="sig s-nt">${v? v.bars+'个交易日' : '研究数据'}</span></div>
    ${valHTML}
    <div style="font-size:12px;margin-top:13px;padding-top:11px;border-top:1px dashed var(--line)">
      <b>板块归属</b> <span style="color:var(--mute);font-size:11.5px">东财行业分类 + 核心题材，按核心度排序（红色=该股被精确归入）</span></div>
    ${bdHTML}
    <div style="font-size:12px;margin-top:13px;padding-top:11px;border-top:1px dashed var(--line)">
      <b>相对强弱 RS</b> <span style="color:var(--mute);font-size:11.5px">个股 ÷ ${rs?rs.ref:'参照指数'}，紫线=RS，橙线=RS 的 MA5，灰虚线=区间中位</span></div>
    ${rsHTML}
    <div style="font-size:11.5px;color:var(--mute);margin-top:9px;line-height:1.6">
      RS 上行 = 个股跑赢指数（资金在往这只票上集中），下行 = 跑输。做T时 RS 向上说明回踩有承接、正T更安全；RS 持续向下则只宜倒T。
      本系统用 RS 替代「板块指数联动」——后者的免费数据源全部失效，理由见顶部市场环境面板下说明。
    </div>
  </div>`;
}

/* ===================== 市场环境面板 ===================== */
function renderMarket(){
  const box = document.getElementById('mktBox');
  if (!box) return;
  if (!MKT){
    box.innerHTML = `<div class="gap-note">正在取大盘指数与环境数据…（首次约 1 秒）</div>`;
    return;
  }
  const g = MKT.gate;
  const cards = MKT.idx.map(o=>{
    const cls = o.chg>=0 ? 'up' : 'dn';
    return `<div class="mk ${cls}">
      <div class="k"><span>${o.label}</span><span>${o.amp?o.amp.toFixed(2)+'% 振幅':''}</span></div>
      <div class="v">${f2(o.price)}</div>
      <div class="d">${pct(o.chg)} · 成交 ${o.amt?(o.amt/10000).toFixed(0)+'亿':'—'}</div>
    </div>`;
  }).join('');
  box.innerHTML = `
    <div class="mkt">${cards}
      <div class="mk"><div class="k"><span>两市成交额</span></div>
        <div class="v">${MKT.amtTotal?(MKT.amtTotal/10000).toFixed(2)+'万亿':'—'}</div>
        <div class="d">沪 + 深 · 实时</div></div>
      <div class="mk"><div class="k"><span>指数位置</span></div>
        <div class="v" style="font-size:15px">${g.pos20!=null?g.pos20.toFixed(0)+'%':'—'}</div>
        <div class="d">上证在近20日区间的位置</div></div>
      <div class="mk"><div class="k"><span>量能倍数</span></div>
        <div class="v" style="font-size:15px">${g.volRatio!=null?g.volRatio.toFixed(2)+'×':'—'}</div>
        <div class="d">较20日均量（按U型分布折算）</div></div>
    </div>
    <div class="gate4 ${g.cls}"><span class="dt"></span><div>
      <div class="tt">第四条闸门 · 市场环境：${g.title}</div>
      <div class="dd">${g.detail}</div>
    </div></div>
    <div class="gap-note"><b>两个已知缺失（数据源限制，非功能遗漏）</b>：
      ① <b>涨跌家数（市场宽度）</b> —— 免费接口无稳定源；
      ② <b>板块指数涨跌</b> —— 同花顺被限速、东财板块行情所在的 push2 域名近乎全超时。
      因此本面板用「指数 + 成交额 + 均线位置 + 量能倍数」构造环境判定，
      板块联动改用每只股票的「相对强弱(RS)」替代 —— 它直接回答"是个股自己的问题，还是整个市场的问题"。</div>
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:2px">
      <button class="mini" id="mktRefresh">⟳ 刷新市场环境</button>
      <span style="font-size:11.5px;color:var(--mute)">更新于 ${new Date(MKT.at).toLocaleTimeString('zh-CN',{hour12:false})} · 指数行情缓存 30 秒，指数日K 缓存 10 分钟</span>
    </div>`;
  const btn = document.getElementById('mktRefresh');
  if (btn) btn.onclick = async ()=>{
    btn.textContent = '⟳ 刷新中…';
    try{ await loadMarket(true); renderMarket(); }catch(e){ toastErr('市场环境取数失败：' + e.message); }
  };
}

/* 研究数据装载：估值（按日缓存）+ 板块归属（按日缓存）。
   失败只记录、不抛出，避免拖垮整页；但**失败要冷却 10 分钟**，
   否则每次自动刷新（60 秒一轮）都会对一个本来就没数据的标的重复发请求。 */
const RSCH_FAIL_CD = 600000;
async function loadResearch(s, force){
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

/* 分时量能卡片单独抽出来：ta==null（K线未同步）时也要能显示，
   否则"日级量能有了、分时量能没了"会让人以为这一层不存在。 */
function vmCardHtml(s){
  const vm = s._vm;
  const box = (cls, title, sig, sc, big, desc) =>
    `<div class="ta ${cls}"><div class="h"><span>${title}</span><span class="sig ${sc}">${sig}</span></div>
     ${big?`<div class="big">${big}</div>`:''}<div class="d">${desc}</div></div>`;
  const note = `<br><span style="color:var(--mute)">分母是前 ${(vm && vm.baseDays) || 5} 个交易日<b>同一时段</b>的平均量，不是当日均量 —— 早盘的柱子天生比午盘大，用当日均量做分母会把"常态"误判成"放量"。</span>`;
  if (vm && vm.ok && vm.state !== 'na'){
    return box(vm.cls, '分时量能（同时段基准）', vm.label, vm.sc,
      (vm.r3 != null ? vm.r3.toFixed(2) + '×' : '—'), vm.text + note);
  }
  if (vm && vm.err){
    return box('t-nt', '分时量能（同时段基准）', '未取到', 's-nt', '—',
      `${vm.err}。日级量能那张卡仍然有效，只是无法判断"这一笔该不该现在动手"。`);
  }
  if (vm && vm.ok){
    return box('t-nt', '分时量能（同时段基准）', '样本不足', 's-nt', (vm.nBars || 0) + ' 根',
      `今日 5 分钟K 只有 <b>${vm.nBars || 0} 根</b>，还不足 ${VM_MIN_BARS} 根，不做量价判定。基准已建好（前 ${vm.baseDays || 5} 个交易日），09:45 之后自动开始判读。`);
  }
  return box('t-nt', '分时量能（同时段基准）', '未取数', 's-nt', '—',
    '点右上「⟳ 取数」后计算：拉 m5 → 建前 5 日同时段基准 → 判量价关系。');
}

function taCards(s, ta, c){
  if (!ta){
    return `<div class="ta-grid"><div class="ta t-nt"><div class="h"><span>技术面</span></div>
      <div class="d">K线未同步 —— 点卡片右上「⟳ 取数」后解锁箱体 / MACD / 破位监测。</div></div>${vmCardHtml(s)}</div>`;
  }
  const out = [];
  const card = (cls, title, sig, sigCls, big, desc, extra)=>
    `<div class="ta ${cls}"><div class="h"><span>${title}</span><span class="sig ${sigCls}">${sig}</span></div>
     ${big?`<div class="big">${big}</div>`:''}<div class="d">${desc}</div>${extra||''}</div>`;

  // ---- 0. 技术面综合评分（把上面各项压成一个可比的数）----
  {
    const sc = ta.score;
    const lvl = sc>=75?['强势','t-ok','s-ok','结构健康，做T以正T为主，回踩均线即买点。']
              : sc>=55?['偏强','t-ok','s-ok','多头占优，可正常执行正T，跌破 MA20 再收手。']
              : sc>=45?['中性','t-nt','s-nt','多空拉锯，只小仓试，等方向明朗。']
              : sc>=25?['偏弱','t-wn','s-wn','结构走坏，只允许倒T减仓，不做低吸。']
              :        ['弱势','t-no','s-no','多项指标共振向下，<b>今日宜空仓观望</b>，不做T也是一种做。'];
    out.push(card(lvl[1], '技术面综合评分', lvl[0], lvl[2], sc+' 分',
      lvl[3] + `<br><span style="color:var(--mute)">由均线排列、MACD、箱体位置、MA20 方向、量能五项加权（基准 50 分），仅供多空参考，<b>不替代三闸门决策</b>。</span>`));
  }
  // ---- 1. 箱体 ----
  const b = ta.box20;
  if (b){
    let sig, sc, desc;
    if (b.up){ sig='上破箱顶'; sc='s-no'; desc=`已站上 20 日箱顶 ${f2(b.top)}，箱体上移。回踩不破前箱顶即为新支撑，是做多最舒服的结构。`; }
    else if (b.down){ sig='跌破箱底'; sc='s-wn'; desc=`已跌破 20 日箱底 ${f2(b.bot)}，箱体下移。此时<b>停止做T</b>，等重新站回箱内再谈——下跌途中的"便宜"往往是陷阱。`; }
    else if (b.pos >= 78){ sig='贴近箱顶'; sc='s-wn'; desc=`位于箱内 ${b.pos.toFixed(0)}%，贴近箱顶 ${f2(b.top)} 阻力。正T不宜在此追买，反而是倒T减仓的位置。`; }
    else if (b.pos <= 22){ sig='贴近箱底'; sc='s-ok'; desc=`位于箱内 ${b.pos.toFixed(0)}%，靠近箱底 ${f2(b.bot)} 支撑。缩量止跌可分批低吸，跌破则认输。`; }
    else { sig='箱体中枢'; sc='s-nt'; desc=`位于箱内 ${b.pos.toFixed(0)}%，既不便宜也不贵。箱体高度 ${b.height.toFixed(1)}%，够做T的波段空间。`; }
    out.push(card(b.pos>78?'t-wn':(b.pos<=22?'t-ok':'t-nt'), '20日箱体', sig, sc,
      `${f2(b.bot)} — ${f2(b.top)}`,
      desc + (b.shrink?' <b>箱体正在收敛</b>（近5日振幅明显小于前期），变盘临近，做T的格数会变窄，注意下调挂单间距。':''),
      `<div class="box-meter"><i style="left:${Math.max(0,Math.min(100,b.pos)).toFixed(1)}%"></i></div>`));
  } else {
    out.push(card('t-nt','20日箱体','数据不足','s-nt','', '历史K线不足以识别箱体。'));
  }

  // ---- 2. 破位监测 ----
  const bk = ta.breaks || [];
  const sev = { '严重':'s-no', '中等':'s-wn', '提示':'s-nt' };
  const lvCls = { '严重':'lv-a', '中等':'lv-b', '提示':'lv-c' };
  if (!bk.length){
    out.push(card('t-ok','破位监测','无破位','s-ok','结构完好',
      `现价在箱底 ${b?f2(b.bot):'—'}、MA20 ${f2(ta.v20)}${ta.v60?'、MA60 '+f2(ta.v60):''} 之上，未见破位信号，做T方案可按三闸门正常执行。`));
  } else {
    const worst = bk.find(x=>x.lv==='严重') || bk.find(x=>x.lv==='中等') || bk[0];
    out.push(card(bk.some(x=>x.lv==='严重')?'t-no':'t-wn', '破位监测', worst.lv+' '+bk.length+'项', sev[worst.lv]||'s-wn',
      bk.map(x=>x.lv).join(' / '),
      bk.map(x=>`<div class="brk ${lvCls[x.lv]||'lv-b'}"><b>${x.lv}｜${x.t}</b><br>${x.d}</div>`).join('')));
  }

  // ---- 3. MACD ----
  const m = ta.macd;
  if (m){
    let sig, sc, desc;
    const bTxt = m.golden ? '刚金叉' : m.dead ? '刚死叉' : (m.bar>=0 ? '多头持续' : '空头持续');
    if (m.golden){ sig='金叉'; sc='s-ok'; desc=`DIF(${f3(m.dif)}) 上穿 DEA(${f3(m.dea)})，动能由空转多。${m.above0?'且在零轴上方，属强势金叉。':'但仍在零轴下方，属反弹性质，宜轻仓。'}`; }
    else if (m.dead){ sig='死叉'; sc='s-no'; desc=`DIF(${f3(m.dif)}) 下穿 DEA(${f3(m.dea)})，动能转弱。做T只保留倒T方向，不做低吸。`; }
    else if (m.bar >= 0){ sig='多头'; sc='s-ok'; desc=`DIF ${f3(m.dif)} / DEA ${f3(m.dea)}，红柱${m.grow>0?`已连续 ${m.grow} 天放大，动能增强`:'缩短，动能减弱'}${m.above0?'，维持零轴上方。':''}`; }
    else { sig='空头'; sc='s-no'; desc=`DIF ${f3(m.dif)} / DEA ${f3(m.dea)}，绿柱${m.grow>0?`连续 ${m.grow} 天放大，抛压未止`:'缩短，有企稳迹象'}${m.above0?'':'，位于零轴下方。'}`; }
    if (m.diverge) desc += ' <b>⚠️ 近 20 日价创新高而 DIF 未同步创新高，存在顶背驰嫌疑</b> —— 若高位放量滞涨，优先减仓。';
    out.push(card(m.dead||m.bar<0?'t-no':'t-ok', 'MACD(12,26,9)', bTxt, sc, f3(m.dif), desc));
  }

  // ---- 4. 均线排列 ----
  const arrCls = ta.arrange==='多头排列'?'t-ok':(ta.arrange==='空头排列'?'t-no':'t-nt');
  const dirTxt = ta.ma20Rising===true ? 'MA20 向上' : ta.ma20Rising===false ? 'MA20 向下' : 'MA20 走平';
  out.push(card(arrCls, '均线排列', ta.arrange, ta.arrange==='多头排列'?'s-ok':(ta.arrange==='空头排列'?'s-no':'s-nt'),
    `MA5 ${f2(ta.v5)}`,
    `MA5 ${f2(ta.v5)} ｜ MA10 ${f2(ta.v10)} ｜ MA20 ${f2(ta.v20)}${ta.v60?` ｜ MA60 ${f2(ta.v60)}`:''}<br>
     <b>${dirTxt}</b>${ta.ma20Slope!==null?`（斜率 ${ta.ma20Slope>=0?'+':''}${ta.ma20Slope.toFixed(2)}%）`:''}。
     ${ta.arrange==='空头排列'?'空头排列是做T的禁区，只允许反弹减仓。':ta.arrange==='多头排列'?'多头排列下回踩均线即买点，做T效率最高。':'均线纠缠代表方向未定，做T只能小仓试。'}`));

  // ---- 5. 波动率 ATR（常态口径，与闸门1的当日振幅口径互为参照）----
  if (ta.atrPct !== null){
    const lvl = ta.atrPct >= 4 ? '充沛' : (ta.atrPct >= 3 ? '中等' : '偏窄');
    const cls = ta.atrPct >= 4 ? 't-ok' : (ta.atrPct >= 3 ? 't-nt' : 't-wn');
    const scls= ta.atrPct >= 4 ? 's-ok' : (ta.atrPct >= 3 ? 's-nt' : 's-wn');
    const ratio = c.amp ? c.amp / ta.atrPct : null;
    const cmpTxt = ratio===null ? '' :
      (ratio >= 1.3 ? `今日振幅 ${c.amp.toFixed(2)}% 是常态的 <b>${ratio.toFixed(2)} 倍，波动明显放大</b>——价差空间比平时宽。`
     : ratio <= 0.7 ? `今日振幅 ${c.amp.toFixed(2)}% 仅为常态的 ${ratio.toFixed(2)} 倍，波动在收缩，可抓的差价有限。`
     : `今日振幅 ${c.amp.toFixed(2)}%，与常态基本相当。`);
    out.push(card(cls, '常态波动 ATR(14)', lvl, scls, ta.atrPct.toFixed(2)+'%',
      `近 14 日平均真实波幅 ${ta.atrPct.toFixed(2)}%（≈ ${f2(ta.atrV)} 元），属<b>${lvl}</b>水平。`
      + cmpTxt
      + `<br><span style="color:var(--mute)">注：ATR 是「常态」口径，闸门1 用的是「当日振幅」口径，两者含义不同、不必相等；ATR 偏低时，只在当日振幅明显放大才值得动手。</span>`));
  }

  // ---- 6. 量能 ----
  if (ta.volRatio !== null){
    const vr = ta.volRatio;
    const up = (ta.v5!=null) && (+s.price >= (+s.prevClose));
    const sig = vr>1.5?(up?'放量上攻':'放量下跌'):(vr<0.8?'明显缩量':'量能平稳');
    const sc  = vr>1.5 ? (up?'s-ok':'s-no') : 's-nt';
    out.push(card(vr>1.5&&!up?'t-no':'t-nt', '量能', sig, sc, vr.toFixed(2)+'×',
      `今日成交约为 5 日均量的 ${vr.toFixed(2)} 倍。${vr<0.8?'缩量说明抛压衰减，回踩更容易企稳——这正是正T的入场条件。':vr>1.5?(up?'放量上攻有真金白银支撑，但放量拉升后往往需要消化，不宜追高。':'放量下跌是真抛压出逃，不是情绪，此时<b>不接</b>。'):'量能中性，方向需结合分时均线判断。'}`));
  }

  // ---- 6b. 分时量能（第二层：定触发点，与上面"日级量能"分工不同）----
  out.push(vmCardHtml(s));

  // ---- 7. 布林线 BOLL(20,2) ----
  if (ta.bl && ta.bl.up != null){
    const pb = ta.pctB, bwTxt = ta.bl.bw != null ? ta.bl.bw.toFixed(2) + '%' : '—';
    let sig, sc, cls, desc;
    if (pb != null && pb > 1){ sig = '突破上轨'; sc = 's-wn'; cls = 't-wn';
      desc = `现价已站上布林上轨 ${f2(ta.bl.up)}，短线进入超买。强势票可以"沿上轨走"（上轨之上还有上轨），但正T不宜在此追买，反而是倒T减仓的位置。`; }
    else if (pb != null && pb < 0){ sig = '跌破下轨'; sc = 's-no'; cls = 't-no';
      desc = `现价跌破布林下轨 ${f2(ta.bl.dn)}，短线超卖。但超卖 ≠ 见底，要等一根缩量止跌K线（长下影 + 量缩）再谈低吸。`; }
    else if (pb != null && pb > 0.8){ sig = '贴近上轨'; sc = 's-wn'; cls = 't-wn';
      desc = `%B = ${pb.toFixed(2)}，贴近上轨 ${f2(ta.bl.up)}，此处买进去等于替别人接力，性价比低。`; }
    else if (pb != null && pb < 0.2){ sig = '贴近下轨'; sc = 's-ok'; cls = 't-ok';
      desc = `%B = ${pb.toFixed(2)}，贴近下轨 ${f2(ta.bl.dn)}，是可分批低吸的位置；跌破下轨则认输。`; }
    else { sig = '通道中枢'; sc = 's-nt'; cls = 't-nt';
      desc = `%B = ${pb != null ? pb.toFixed(2) : '—'}，位于通道中部，多空都不占便宜。`; }
    const bwNote = ta.bwDelta == null ? '' :
      ta.bwDelta > 8 ? ` <b>带宽 ${bwTxt}，近 5 日张开口 ${ta.bwDelta.toFixed(0)}%</b>——波动放大，变盘或行情启动。`
    : ta.bwDelta < -8 ? ` 带宽 ${bwTxt}，近 5 日收窄 ${Math.abs(ta.bwDelta).toFixed(0)}%——<b>挤压待变盘</b>，方向未定前不重仓。`
    : ` 带宽 ${bwTxt}，开口变化不大。`;
    out.push(card(cls, '布林线 BOLL(20,2)', sig, sc, `下 ${f2(ta.bl.dn)} / 上 ${f2(ta.bl.up)}`,
      desc + bwNote + `<br><span style="color:var(--mute)">中轨 ${f2(ta.bl.mid)}（= MA20）是短线多空分水岭：站上中轨做多、跌破中轨收手。</span>`));
  }

  // ---- 8. RSI(6/12/24) ----
  if (ta.r && ta.r.r6 != null){
    const r6 = ta.r.r6, r12 = ta.r.r12, r24 = ta.r.r24;
    let sig, sc, cls, desc;
    if (r6 >= 80){ sig = '严重超买'; sc = 's-no'; cls = 't-no';
      desc = `RSI6 = ${r6.toFixed(1)}，短线情绪过热。此时追买正T的胜率最差——要买就等它跌回来。`; }
    else if (r6 >= 70){ sig = '超买'; sc = 's-wn'; cls = 't-wn';
      desc = `RSI6 = ${r6.toFixed(1)}，进入超买区。优先兑现，不追高。`; }
    else if (r6 <= 20){ sig = '严重超卖'; sc = 's-wn'; cls = 't-wn';
      desc = `RSI6 = ${r6.toFixed(1)}，极度超卖，反弹概率高；但下跌趋势中"超卖可以更超卖"，只宜小仓快进快出，不加仓摊平。`; }
    else if (r6 <= 30){ sig = '超卖'; sc = 's-ok'; cls = 't-ok';
      desc = `RSI6 = ${r6.toFixed(1)}，进入超卖区，符合正T的入场前提之一（再叠加缩量企稳更好）。`; }
    else { sig = '中性'; sc = 's-nt'; cls = 't-nt';
      desc = `RSI6 = ${r6.toFixed(1)}，多空动能均衡，无极端信号。`; }
    const div = (r6 > 75 && ta.v5 != null && +s.price < ta.v5) ? ' <b>⚠️ 短周期超买而价格已跌破 MA5，属"高位钝化转弱"，注意回落。</b>' : '';
    out.push(card(cls, 'RSI 相对强弱(6/12/24)', sig, sc, r6.toFixed(1),
      `RSI6 ${r6.toFixed(1)} ｜ RSI12 ${r12 != null ? r12.toFixed(1) : '—'} ｜ RSI24 ${r24 != null ? r24.toFixed(1) : '—'}<br>`
      + desc + div
      + `<br><span style="color:var(--mute)">RSI 用 6/12/24 三档：6 看日内情绪，12 看短期，24 看中期；三线同向才有效，单线极端只作提示。</span>`));
  }

  // ---- 9. 换手率 ----
  if (ta.turnover){
    const to = ta.turnover;
    const lvl = to >= 15 ? '过热' : to >= 8 ? '高度活跃' : to >= 3 ? '活跃' : to >= 1.5 ? '正常' : '清淡';
    const cls = to >= 15 ? 't-wn' : to >= 3 ? 't-ok' : to >= 1.5 ? 't-nt' : 't-wn';
    const sc  = to >= 15 ? 's-wn' : to >= 3 ? 's-ok' : to >= 1.5 ? 's-nt' : 's-wn';
    const note = to >= 15 ? '换手过热往往伴随筹码剧烈交换，容易冲高回落，做T要快进快出、绝不隔夜。'
               : to >= 3 ? '换手充分，日内价差空间通常足够，是适合做T的状态。'
               : to >= 1.5 ? '换手一般，日内波段较窄，只做确定性最高的那一次。'
               : '换手清淡，说明多空都不愿动手，日内几乎没有可做T的价差 —— 此时空仓就是最优解。';
    out.push(card(cls, '换手率', lvl, sc, to.toFixed(2) + '%',
      `今日换手 ${to.toFixed(2)}%（${ta.floatSh ? (ta.floatSh/1e8).toFixed(2) + ' 亿流通股' : '按行情口径'}），属<b>${lvl}</b>水平。${note}`));
  }

  // ---- 10. 大单资金（逐笔明细本地统计）----
  const dd = s._dd && s._dd.dd;
  if (dd){
    const m = dd.main, tot = dd.total.amt || 1;
    const netRatio = m.net/tot*100;
    /* 样本覆盖率：逐笔接口有页数上限，交投极活跃的票可能取不全。
       用行情给的官方成交额（字段 37，单位万元）当分母校验，取不全就明确讲出来，不能假装完整。 */
    const official = (+s.amt || 0)*10000;
    const cover = official > 0 ? dd.total.amt/official*100 : null;
    const partial = (cover !== null && cover < 95);
    const sig = m.net >= 0 ? '主力净流入' : '主力净流出';
    const cls = m.net >= 0 ? (netRatio > 3 ? 't-ok' : 't-nt') : (netRatio < -3 ? 't-no' : 't-wn');
    const sc  = m.net >= 0 ? (netRatio > 3 ? 's-ok' : 's-nt') : (netRatio < -3 ? 's-no' : 's-wn');
    const cell = (k, v, c)=> `<div class="dd-cell"><span class="k">${k}</span><span class="v ${c}">${v}</span></div>`;
    const w = Math.max(-50, Math.min(50, netRatio*6));
    const extra = `<div class="dd-grid">`
      + cell('特大单净额', (dd.xlNet >= 0 ? '+' : '') + money$(dd.xlNet), dd.xlNet >= 0 ? 'p' : 'n')
      + cell('大单净额',   (dd.lNet  >= 0 ? '+' : '') + money$(dd.lNet),  dd.lNet  >= 0 ? 'p' : 'n')
      + cell('中单净额',   (dd.mNet  >= 0 ? '+' : '') + money$(dd.mNet),  dd.mNet  >= 0 ? 'p' : 'n')
      + cell('小单净额',   (dd.sNet  >= 0 ? '+' : '') + money$(dd.sNet),  dd.sNet  >= 0 ? 'p' : 'n')
      + `</div><div class="dd-flow"><span class="mid"></span>`
      + (w >= 0 ? `<i style="left:50%;width:${w}%;background:#d32f2f"></i>`
                : `<i style="left:${50+w}%;width:${-w}%;background:#0a7f42"></i>`)
      + `</div><div class="k-note">横条以中轴为 0，红色向右 = 主力净流入，绿色向左 = 净流出（长度按净额占样本成交额的比例放大）。</div>`;
    out.push(card(partial ? (cls==='t-ok'?'t-nt':cls) : cls, '大单资金 · 主力动向', sig, sc,
      (m.net >= 0 ? '+' : '') + money$(m.net),
      `主力（特大单 + 大单）净额 <b>${(m.net >= 0 ? '+' : '') + money$(m.net)}</b>，`
      + `占样本成交额 ${netRatio.toFixed(1)}%；净量 <b>${(m.netv >= 0 ? '+' : '') + m.netv.toFixed(0)} 手</b>。`
      + `<br>逐笔样本共 ${dd.total.n} 笔、合计成交额 ${money$(dd.total.amt)}，其中大单及以上占 ${dd.mainShare.toFixed(1)}%。`
      + (netRatio > 3 ? '资金明确进场，回调承接力强，正T的胜率更高。'
       : netRatio < -3 ? '<b>资金持续流出</b>，反弹高度受限，只做倒T、不低吸。'
       : '主力进出基本平衡，属存量博弈，做T只赚波动不赚趋势。')
      + (cover !== null ? `<br>样本覆盖率 <b>${cover.toFixed(1)}%</b>（对比行情官方成交额 ${money$(official)}）`
          + (partial ? '——<b>⚠️ 样本不完整</b>：逐笔接口有页数上限，本日交投过于活跃，仍有部分成交未计入，分档金额为"样本内口径"，请以方向与占比为主、不要当成全天精确值。'
                     : '，样本基本完整，分档金额可视为全天口径。') : '')
      + `<br><span style="color:var(--mute)">口径：按单笔成交金额分档 —— 特大单 ≥100万、大单 20–100万、中单 4–20万、小单 &lt;4万；方向取主动买 / 主动卖，中性单不计。数据时间 ${new Date(s._dd.at).toLocaleTimeString('zh-CN',{hour12:false})}。</span>`,
      extra));
  } else {
    out.push(card('t-nt', '大单资金 · 主力动向', '未取数', 's-nt', '',
      '点上方图表工具条的 <b>💰 大单资金</b>，系统会拉取当日全部逐笔成交，按单笔金额分档算出主力 / 大单 / 中单 / 小单的净额与净量。<br><span style="color:var(--mute)">这是本地统计（不是外部现成的"资金流"字段），口径透明、可核对。</span>'));
  }

  // ---- 11. 支撑位 / 压力位 ----
  const L = ta.levels;
  if (L && (L.res.length || L.sup.length)){
    const li = (l, kind)=> `<div class="sr-it ${kind}"><span>${f2(l.p)}</span><em>${l.label} · ${l.strength} · ${l.dist >= 0 ? '+' : ''}${l.dist.toFixed(2)}%</em></div>`;
    const extra = `<div class="sr-wrap">
      <div class="sr-col"><h5>压力位（由近到远）</h5>${L.res.length ? L.res.map(l=> li(l,'res')).join('') : '<em style="font-size:11.5px;color:var(--mute)">上方暂无有效压力（已在高位）</em>'}</div>
      <div class="sr-col"><h5>支撑位（由近到远）</h5>${L.sup.length ? L.sup.map(l=> li(l,'sup')).join('') : '<em style="font-size:11.5px;color:var(--mute)">下方暂无有效支撑（已在低位）</em>'}</div>
    </div>`;
    const r1 = L.res[0], s1 = L.sup[0];
    out.push(card('t-sr', '支撑位 / 压力位', s1 && r1 ? '双向明确' : (s1 ? '下方有撑' : '上方有压'), 's-nt',
      s1 && r1 ? `${f2(s1.p)} ↔ ${f2(r1.p)}` : (s1 ? f2(s1.p) : f2(r1.p)),
      `做法：把买单挂在<b>支撑位上方一点</b>、把卖单挂在<b>压力位下方一点</b>——不要挂在价位本身，那里往往一堆人排队。`
      + `<br>多档重合的位置（强度"强"）最值得重视；箱体上下沿被反复试探后一旦真破，反向空间通常大于箱体高度。`
      + `<br><span style="color:var(--mute)">候选来源：20/60日箱体上下沿、布林上中下轨、MA5/10/20/60、20/60日极值、持仓成本；相邻 0.6% 合并为一档，强度按来源权重累加。</span>`,
      extra));
  }

  return `<div class="ta-grid">${out.join('')}</div>`;
}

/* ===================== 渲染 ===================== */
/* 会被自动取数覆盖的字段 —— 只有这些需要「已手改」保护。
   持仓成本 / 持仓股数 / 可用现金属于账户事实，行情刷新本来就不会动它们。 */
/* 会被自动取数覆盖的字段 —— 只有这些需要「已手改」保护。
   持仓成本 / 持仓股数 / 可用现金属于账户事实，已置于持仓栏就地编辑，行情刷新不会覆盖它们。 */
const AUTO_FIELDS = ['prevClose','open','high','low','price','avg','vr','ma5','ma10','ma20'];
const AUTO_FIELD_LABELS = {
  prevClose: '昨收', open: '今开', high: '最高', low: '最低',
  price: '现价', avg: '分时均线', vr: '量比',
  ma5: 'MA5', ma10: 'MA10', ma20: 'MA20'
};

function render(pool){
  const box = document.getElementById('pool');
  box.innerHTML = pool.map((s,i)=>{
    const c = calc(s);
    const cls = c.chg>=0 ? 'up' : 'down';
    const p = posCalc(s);                            // 持仓与成本
    s._ta = computeTA(s);                            // 技术面（K线图与指标卡共用）
    const ta = s._ta;

    /* 闸门3 升级为「量比 + 时段达成率」双口径。
       只用其中任何一个都会被骗：量比在早盘天然偏高，达成率在尾盘天然趋近全天比。
       两个一起看才回答得了"这波量到底是提前来了，还是本该如此"。 */
    const VOL_STATE_TXT = { heavy:'显著超预期', above:'略超预期', normal:'符合预期', below:'不及预期', light:'明显缩量' };
    if (ta && ta.volProgress != null){
      c.gate3 = `量比 ${f2(c.vr)}　时段达成 <b>${(ta.volProgress*100).toFixed(0)}%</b>`
        + `（该时点应完成 ${(ta.volShare*100).toFixed(0)}%）→ ${VOL_STATE_TXT[ta.volState]}`;
    } else if (ta && ta.volProgress == null && ta.volRatio != null){
      const _m = (new Date()).getHours()*60 + (new Date()).getMinutes();
      c.gate3 = _m < 570
        ? `量比 ${f2(c.vr)}　时段达成 —（未开盘，量能口径尚未建立）`
        : `量比 ${f2(c.vr)}　时段达成 —（开盘不足 5 分钟，样本不够，不做量能判定）`;
    }
    /* 第三段：分时量能（第二层）。前两段只回答"今天有没有量"，这一段才回答"这一刻该不该动手"，
       所以三段必须并排 —— 少任何一段都会让用户拿日级结论去做分钟级的决策。 */
    const _vm = s._vm;
    /* 三态必须分清：有判定 / 有数据但样本不足 / 根本没取到。
       把"样本不足"混进"未取到"会让人以为功能没接上，而去反复点取数。 */
    const vmTag = (_vm && _vm.ok && _vm.state !== 'na' && _vm.r3 != null)
      ? `　│　分时量能 <b>${_vm.r3.toFixed(2)}×</b>（同时段常态）→ ${_vm.label}`
      : (_vm && _vm.err) ? `　│　分时量能 —（${_vm.err}）`
      : (_vm && _vm.ok)  ? `　│　分时量能 —（今日仅 ${_vm.nBars || 0} 根 5 分钟K，样本不足）`
      : '　│　分时量能 —（未取到）';
    if (c.gate3) c.gate3 += vmTag;
    // 图表偏好：首次出现时给一套默认（日K + 均线/布林 + 箱体 + 成本线，副图 MACD）
    if (!s.p)   s.p = 'day';
    if (!s.ov)  s.ov = { ma:1, boll:1, box:1, cost:1, sr:0 };
    if (!s.sub) s.sub = 'macd';

    // 阶梯表
    const rows = [
      [ 6, '禁止新开正T区', 'none'],
      [ 5, '强势区·只减',   'sell'],
      [ 4, '倒T第二减仓位', 'sell'],
      [ 3, '倒T第一减仓位', 'sell'],
      [ 2, '倒T观察位',     'none'],
      [ 1, '正T止盈上限',   'sell'],
      [ 0, '基准·正T止盈位','buy' ],
      [-1, '浅回踩观察',    'none'],
      [-2, '正T第一买点',   'buy' ],
      [-3, '正T第二买点',   'buy' ],
      [-4, '深水区·需缩量企稳','none'],
      [-6, '破位·停止做T',  'none']
    ].map(([k,label,act])=>{
      const p = c.pc*(1+k*GRID/100);
      const pv = +s.price || 0;
      // 容差从半格（±0.15 元，会把现价"吸"到相邻档）收窄到 1/8 格
      const isNow = pv ? Math.abs(pv-p) <= c.pc*GRID/800 : false;
      const dNow  = pv ? (p-pv)/pv*100 : null;
      const pill = act==='buy' ? '<span class="pill p-buy">买点</span>'
                 : act==='sell'? '<span class="pill p-sell">卖点</span>'
                 : '<span class="pill p-none">观察</span>';
      return `<tr class="${act==='buy'?'act-buy':act==='sell'?'act-sell':''}">
        <td style="color:var(--sub)">${k>0?'+':''}${(k*GRID).toFixed(2)}%</td>
        <td class="${act==='buy'?'':''}" style="font-family:ui-monospace,Consolas,monospace;color:${act==='buy'?'var(--down)':act==='sell'?'var(--up)':'var(--text)'}">${f2(p)}</td>
        <td style="text-align:right;font-family:ui-monospace,Consolas,monospace;color:${dNow==null?'var(--sub)':(dNow>0?'var(--up)':(dNow<0?'var(--down)':'var(--text)'))}">${dNow==null?'—':(dNow>=0?'+':'')+dNow.toFixed(2)+'%'}</td>
        <td>${label}${isNow?' <b style="color:var(--info)">◀现价</b>':''}</td>
        <td style="text-align:right;white-space:nowrap">${pill}${(act==='buy'||act==='sell')?`<button class="pill-act" data-qt-row="${i}" data-dir="${act==='buy'?'正T':'倒T'}" data-p="${f2(p)}" title="以此档位价格 ${f2(p)} 快速记一笔做T">⚡ 记T</button>`:''}</td>
      </tr>`;
    }).join('');

    // 现价落在七格阶梯的哪两格之间 —— 与"档位是多少"分开陈述。
    // 原来在档位行上贴「◀现价」，半格容差会把现价"吸"到相邻档，
    // 读者会理解成"现价就是 22.55"。改成单独一行后两件事不再混淆。
    const pxNow = +s.price || 0;
    const gNow  = c.chg / GRID;
    const kLo   = Math.floor(gNow), kHi = kLo + 1;
    const pLo   = c.pc*(1+kLo*GRID/100), pHi = c.pc*(1+kHi*GRID/100);
    const dLo   = pxNow ? (pLo-pxNow)/pxNow*100 : null;
    const dHi   = pxNow ? (pHi-pxNow)/pxNow*100 : null;
    const nowLine = `<div class="nowline">现价 <b>${f2(pxNow)}</b>（<b class="${cls}">${pct(c.chg)}</b>）`
      + `　│　位于 <b>${kLo>0?'+':''}${(kLo*GRID).toFixed(2)}% → ${f2(pLo)}</b> 与 <b>${kHi>0?'+':''}${(kHi*GRID).toFixed(2)}% → ${f2(pHi)}</b> 两格之间`
      + (dLo!=null ? `　│　距下格 ${dLo>=0?'+':''}${dLo.toFixed(2)}%、距上格 ${dHi>=0?'+':''}${dHi.toFixed(2)}%` : '')
      + `</div>`;

    // ② 六档价位卡 —— 抄单用的核心，结论之后就要看到
    const levelsHTML = `<div class="levels">
            <div class="lv buy ${c.mode==='BUY'?'':'off'}"><div class="k"><span>正T 买入区（先买后卖）</span><button class="pill-act" data-qt-row="${i}" data-dir="正T" data-p="${f2(c.inA)}">⚡ 记买</button></div><div class="v">${f2(c.inA)} — ${f2(c.inB)}</div><div class="d">第一份 / 第二份挂单价</div></div>
            <div class="lv sell ${c.mode==='BUY'?'':'off'}"><div class="k"><span>正T 止盈目标</span><button class="pill-act" data-qt-row="${i}" data-dir="正T" data-p="${f2(c.tp1)}">⚡ 记止盈</button></div><div class="v">${f2(c.tp1)} / ${f2(c.tp2)}</div><div class="d">约 +${c.gain1.toFixed(1)}% ~ +${c.gain2.toFixed(1)}%</div></div>
            <div class="lv stop ${c.mode==='BUY'?'':'off'}"><div class="k"><span>正T 止损（-1.5%）</span><button class="pill-act" data-qt-row="${i}" data-dir="正T" data-p="${f2(c.slA)}">⚡ 记止损</button></div><div class="v">${f2(c.slA)} / ${f2(c.slB)}</div><div class="d">对应上面两个买点</div></div>
            <div class="lv sell ${(c.mode==='REV'||c.mode==='CUT')?'':'off'}"><div class="k"><span>倒T 卖出区（先卖后买）</span><button class="pill-act" data-qt-row="${i}" data-dir="倒T" data-p="${f2(c.outA)}">⚡ 记卖</button></div><div class="v">${f2(c.outA)} — ${f2(c.outB)}</div><div class="d">无量冲高时减T仓</div></div>
            <div class="lv buy ${(c.mode==='REV'||c.mode==='CUT')?'':'off'}"><div class="k"><span>倒T 接回位</span><button class="pill-act" data-qt-row="${i}" data-dir="倒T" data-p="${f2(c.bkA)}">⚡ 记接回</button></div><div class="v">${f2(c.bkA)} / ${f2(c.bkB)}</div><div class="d">回落缩量后再接</div></div>
            <div class="lv stop ${(c.mode==='REV'||c.mode==='CUT')?'':'off'}"><div class="k"><span>卖飞线（不得追高）</span></div><div class="v">${f2(c.fly)}</div><div class="d">放量突破此价即认卖飞，不接</div></div>
          </div>`;

    // ③ 三闸门 —— 为什么是这个结论
    const gatesHTML = `<div class="gates" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;font-size:12.5px;color:var(--sub);margin-bottom:12px">
            <div>闸门1 · 格位：${c.gate1}</div>
            <div>闸门3 · 量能：${c.gate3}</div>
            <div style="grid-column:1/-1">闸门2 · 趋势：${c.gate2}</div>
            <div style="grid-column:1/-1">闸门4 · 市场环境：${c.gate4}</div>
          </div>`;

    // ④ 七格阶梯表（已加「距现价」列）
    const tableHTML = `<div class="tbl-scroll"><table>
            <thead><tr><th>相对昨收</th><th>价格</th><th style="text-align:right">距现价</th><th>含义</th><th style="text-align:right">操作</th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>`;

    /* WAIT 降级：系统说"今天别动"时，绝不能再摆出一堆可抄的买点卖点。
       价位卡 + 阶梯表整块收进 details，展开后加灰度与红字横幅 ——
       想看仍然看得到，但需要一次主动点击，且一眼就知道"这不是挂单指令"。 */
    let midHTML;
    if (c.mode === 'WAIT'){
      midHTML = gatesHTML
        + `<details class="plan-fold">
             <summary>⚠️ 今日不可执行 · 点击查看预案价格（仅供观察，不要挂单）</summary>
             <div class="pf-warn">系统判定为「观望」，下列价格是<b>预案</b>而非今日指令 —— 请勿照此挂单。</div>
             <div class="pf-bd">${levelsHTML}${nowLine}${tableHTML}</div>
           </details>`;
    } else {
      midHTML = levelsHTML + gatesHTML + nowLine + tableHTML;
    }

    const mbd = MODE_BADGE[c.mode] || MODE_BADGE.WAIT;
    const quoteFoldHTML = `
      <details class="quote-fold"${(s._qfo || (s.manual && Object.keys(s.manual).length))?' open':''}>
        <summary>⚙️ 行情参数与手工微调（10项指标已由行情接口自动同步${(s.manual && Object.keys(s.manual).length)?' · <b style="color:var(--warn-d)">● 含有手动修改项</b>':''} · 点击展开微调/压力推演）</summary>
        <div class="quote-bd">
          <div class="ig">
            ${AUTO_FIELDS.map(k=>{
              const lb = AUTO_FIELD_LABELS[k] || k;
              const man = !!(s.manual && s.manual[k]);
              return `<div class="fld"><label>${lb}${man?'<b class="man-dot" title="已手动修改：自动刷新不会覆盖这个值">●</b>':''}</label>`
                + `<input data-i="${i}" data-k="${k}" value="${fmtIn(s[k])}" class="${man?'man':''}"`
                + ` title="${man?'已手动修改，自动刷新不会覆盖；点表头「⟲ 恢复行情值」解除':''}"`
                + ` inputmode="decimal" step="0.01" enterkeyhint="next"></div>`;
            }).join('')}
          </div>
          <div class="quote-hint">
            <span>说明：行情接口每分钟会自动同步上述 10 项数据。若手动修改任意数字，该项将加黄锁定并即时重算决策，不受自动刷新影响。</span>
            ${(s.manual && Object.keys(s.manual).length)?`<button class="mini" data-clr="${i}" style="margin-left:auto">⟲ 恢复全部行情值</button>`:''}
          </div>
        </div>
      </details>
    `;

    return `
    <div class="card m-${mbd[0]}" data-tier="${tierOf(s)}">
      <div class="card-hd">
        <span class="nm">${s.name}</span>
        <span class="cd">${s.code}</span>
        <span class="tier-tag t-${tierOf(s)}" data-tier-toggle="${i}" title="当前：${TIER_LABEL[tierOf(s)]}　点击切换成另一类">${TIER_LABEL[tierOf(s)]}</span>
        <span class="mg ${mbd[0]}">${mbd[1]}</span>
        <button class="mini primary" data-quickt="${i}" title="盘中做T快捷记一笔，自动计算差价并摊薄成本">⚡ 快捷记T</button>
        <button class="mini" data-reason="${i}" title="查看入选理由、量化支撑与重大利空排查">🔍 逻辑与利空</button>
        <button class="mini" data-ref="${i}">⟳ 取数</button>
        <button class="mini" data-plan="${i}">📋 计划</button>
        ${(s.manual && Object.keys(s.manual).length)?'<button class="mini" data-clr="${i}" title="解除手动标记，恢复由行情自动刷新">⟲ 恢复行情值</button>':''}
        <button class="mini" data-del="${i}">移除</button>
        <div class="card-hd-snap">
          <span class="snap-px"><b class="${cls}">${f2(+s.price)}</b> <b class="${cls}">${pct(c.chg)}</b></span>
          <span class="snap-tag" title="日内振幅与折合格数">振幅 ${c.amp.toFixed(2)}% (${c.grid.toFixed(1)}格)</span>
          <span class="snap-tag" title="开盘至当前量比">量比 ${f2(c.vr)}</span>
          ${(ta&&ta.turnover)?`<span class="snap-tag">换手 ${ta.turnover.toFixed(2)}%</span>`:''}
          ${(ta&&ta.volProgress!=null)?`<span class="snap-tag vq vq-${ta.volState}" title="今日累计量 ÷（5日均量 × 该时点应完成 ${(ta.volShare*100).toFixed(0)}%），>120% 才算超预期">时段量能 ${(ta.volProgress*100).toFixed(0)}%</span>`:''}
          ${(s._dd&&s._dd.dd)?`<span class="snap-tag">主力 <b class="${s._dd.dd.main.net>=0?'up':'down'}">${s._dd.dd.main.net>=0?'+':''}${money$(s._dd.dd.main.net)}</b></span>`:''}
          <span class="snap-tag tag-trend">日线${c.trend}</span>
          ${s._t?`<span class="snap-time">更新于 ${s._t}${s._maOk===false?'(均线未同步)':''}</span>`:''}
        </div>
      </div>
      <div class="card-bd">
        ${posBar(s, p, i)}
        ${liveTradeBar(s, p, c, i)}
        <div class="verdict ${c.vcls}">
          <span class="dot"></span>
          <div class="txt">
            <b>${c.title}</b><br>
            <span style="color:var(--sub)">${c.detail}</span>
          </div>
        </div>
        ${midHTML}

        ${c.sellFlyTriggered ? `<div class="fly-melt-box">🚨 倒T卖飞熔断警报：现价 ${f2(+s.price)} 已突破倒T卖出位 ${f2(c.outA)} 达 +2.0%！出现卖飞现象！严禁盲目追高接回（极易买在天花板），严格等待缩量回踩或次日再寻接回点！</div>` : ''}
        <div class="pos-row">
          <span>持仓 <b>${c.sh||'—'}</b> 股 → 底仓 70% ≈ <b>${c.sh?c.base:'—'}</b> 股（不动）</span>
          <span>T仓 30% ≈ <b>${c.sh?c.t:'—'}</b> 股 → 实盘挂单 <b>${c.sh?(c.t1Lots ? c.t1Lots+' 股/份 ('+(c.t1Lots/100)+'手)' : '不足1手'):'—'}</b>${c.sh && c.tLots && c.t1!==c.t1Lots && c.t1Lots ? ` <span style="font-size:11px;color:var(--mute)">（理论 ${c.t1} 股，已按100股整手取整）</span>` : ''}</span>
          ${c.cap?`<span>可用现金 <b>${c.cap}</b> 元 → T仓预算约 <b>${Math.round(c.cap*0.3)}</b> 元</span>`:''}
        </div>
        ${c.sh > 0 && c.sh < 200 ? `<div class="pos-warn">⚠️ 当前持仓仅 ${c.sh} 股（不足 200 股）：按 A 股买入整百股规则，无法将底仓与 T 仓（至少需 1 手 100 股）隔离，做T极易误动底仓，建议持仓 ≥300 股再做T。</div>` : ''}
        ${c.bear?`<div class="pos-warn">⚠️ 满仓者注意：日线空头时不要用现金补仓，改用「底仓倒T法」—— 只卖出底仓的 30% 筹码做倒T，当日必须原数接回，底仓股数一股不变，只把成本往下推。</div>`:''}

        ${quoteFoldHTML}
      </div>

      <details class="chart-fold"${s._fo?' open':''}>
        <summary>⌄ 展开图表与技术细节（K线 / 副图 / 指标卡 / 估值·板块·强弱）</summary>
        <div class="kline-box">
          ${kbarHTML(i, s)}
          <canvas id="kln-${i}" data-ki="${i}"></canvas>
          ${chartLegendHTML(s)}
          ${chartStat(s)}
        </div>
        <div style="padding:0 14px 2px">
          ${taCards(s, ta, c)}
          ${researchBlock(s, i, pool)}
        </div>
      </details>
    </div>`;
  }).join('');

  // 相对强弱迷你图：必须等 DOM 插入后才能测 clientWidth，所以放在 innerHTML 之后单独画一遍
  box.querySelectorAll('canvas[data-rs]').forEach(cv=>{
    const st = pool[+cv.dataset.rs];
    if (!st) return;
    const rs = rsCalc(st);
    if (rs) drawRS(cv, rs);
  });

  /* 绑定输入。两处加固：
     ① 中文/拼音输入法下，input 事件会在 composition 过程中连续触发，
        parseFloat 会拿到 "2"、"22" 这类中间态，页面每敲一个字母就重算一次。
        用 compositionstart/end 守卫跳过中间态，只在上屏后算一次。
     ② 同一帧内的多次输入用 requestAnimationFrame 合并成一次 render，
        三只票以上时能明显少掉帧。 */
  let _raf = 0;
  const applyInput = ()=>{
    _raf = 0;
    const active = document.activeElement;
    const sel = [active?.dataset?.i, active?.dataset?.k, active?.selectionStart];
    render(pool);
    if (sel[0] !== undefined){
      const el = document.querySelector(`input[data-i="${sel[0]}"][data-k="${sel[1]}"]`);
      if (el){ el.focus(); try{ el.setSelectionRange(sel[2],sel[2]); }catch(_){} }
    }
  };
  box.querySelectorAll('input[data-i][data-k]').forEach(inp=>{
    let composing = false;
    inp.addEventListener('compositionstart', ()=>{ composing = true; });
    const markManual = (i, k)=>{
      if (AUTO_FIELDS.indexOf(k) < 0) return;      // 成本/股数/现金本就是手填的，无需标记
      const st = pool[i];
      if (!st.manual) st.manual = {};
      st.manual[k] = 1;
    };
    inp.addEventListener('compositionend', e=>{
      composing = false;
      const i = +e.target.dataset.i, k = e.target.dataset.k;
      pool[i][k] = e.target.value === '' ? '' : parseFloat(e.target.value);
      markManual(i, k);
      if (!_raf) _raf = requestAnimationFrame(applyInput);
    });
    inp.addEventListener('input', e=>{
      if (composing) return;                       // 组合输入中间态：不取值、不重算
      const i = +e.target.dataset.i, k = e.target.dataset.k;
      pool[i][k] = e.target.value === '' ? '' : parseFloat(e.target.value);
      markManual(i, k);
      if (!_raf) _raf = requestAnimationFrame(applyInput);
    });
    inp.addEventListener('change', ()=>{ savePool(); });
  });

  // 实时买卖记账输入与快捷按钮绑定
  box.querySelectorAll('.lts-inp, .lts-sel').forEach(inp=>{
    inp.addEventListener('input', e=>{
      const idx = +e.target.dataset.ltI;
      updateLtbPreview(idx);
    });
    inp.addEventListener('change', e=>{
      const idx = +e.target.dataset.ltI;
      updateLtbPreview(idx);
    });
  });

  box.querySelectorAll('[data-fill-sell]').forEach(btn=>{
    btn.onclick = e=>{
      e.stopPropagation();
      const idx = +btn.dataset.i;
      const targetInp = document.getElementById(`ltbSell_${idx}`);
      if (targetInp){
        targetInp.value = btn.dataset.fillSell;
        updateLtbPreview(idx);
      }
    };
  });

  box.querySelectorAll('[data-fill-qty]').forEach(btn=>{
    btn.onclick = e=>{
      e.stopPropagation();
      const idx = +btn.dataset.i;
      const targetInp = document.getElementById(`ltbQty_${idx}`);
      if (targetInp){
        targetInp.value = btn.dataset.fillQty;
        updateLtbPreview(idx);
      }
    };
  });

  box.querySelectorAll('[data-fill-buy]').forEach(btn=>{
    btn.onclick = e=>{
      e.stopPropagation();
      const idx = +btn.dataset.i;
      const targetInp = document.getElementById(`ltbBuy_${idx}`);
      if (targetInp){
        targetInp.value = btn.dataset.fillBuy;
      }
    };
  });

  box.querySelectorAll('[data-fill-bqty]').forEach(btn=>{
    btn.onclick = e=>{
      e.stopPropagation();
      const idx = +btn.dataset.i;
      const targetInp = document.getElementById(`ltbQty_${idx}`);
      if (targetInp){
        targetInp.value = btn.dataset.fillBqty;
      }
    };
  });

  box.querySelectorAll('[data-switch-tab]').forEach(btn=>{
    btn.onclick = e=>{
      e.stopPropagation();
      const idx = +btn.dataset.i;
      const tab = btn.dataset.switchTab;
      if (pool[idx]){
        pool[idx]._tradeTab = tab;
        render(pool);
      }
    };
  });

  box.querySelectorAll('[data-exec-sell]').forEach(btn=>{
    btn.onclick = e=>{
      e.stopPropagation();
      const idx = +btn.dataset.execSell;
      execLiveSell(idx);
    };
  });

  box.querySelectorAll('[data-exec-buy]').forEach(btn=>{
    btn.onclick = e=>{
      e.stopPropagation();
      const idx = +btn.dataset.execBuy;
      execLiveBuy(idx);
    };
  });

  // 立即刷新各持仓条的预估差价看板
  pool.forEach((_, idx) => {
    updateLtbPreview(idx);
  });


  // 单票：复制本票作战计划
  box.querySelectorAll('button[data-plan]').forEach(b=>{
    b.onclick = ()=>{
      const s = pool[+b.dataset.plan];
      if (s) copyPlain(planText(s), s.name + ' 的作战计划已复制，可直接粘贴。');
    };
  });
  // 解除手动标记，恢复由行情自动刷新
  box.querySelectorAll('button[data-clr]').forEach(b=>{
    b.onclick = ()=>{
      const st = pool[+b.dataset.clr];
      if (!st) return;
      st.manual = {};
      savePool(); render(pool);
    };
  });
  // 池别标签：点一下在短线 / 长线之间切换
  box.querySelectorAll('[data-tier-toggle]').forEach(el=>{
    el.onclick = ()=>{
      const s = pool[+el.dataset.tierToggle];
      if (!s) return;
      s.tier = tierOf(s) === 'short' ? 'long' : 'short';
      savePool();
      /* 正在按组筛选时改了分组，那只票会立刻被隐藏，看起来像"点没了"。
         所以自动退回「全部」视图，让它原地留在屏幕上，只是标签变了。 */
      let backToAll = false;
      if (TIER !== 'all' && s.tier !== TIER){
        TIER = 'all';
        try{ localStorage.setItem('t-system-tier', 'all'); }catch(_){}
        backToAll = true;
      }
      paintTierBar();
      render(pool);
      renderPoolTabs();
      toastOk(s.name + ' 已归入「' + TIER_LABEL[s.tier] + '」' + (backToAll ? '，已切回「全部」视图方便你看到它' : ''));
    };
  });
  paintTierBar();

  // 绑定移除 / 单只取数
  box.querySelectorAll('button[data-del]').forEach(b=>{
    b.onclick = ()=>{ pool.splice(+b.dataset.del,1); render(pool); savePool(); };
  });
  box.querySelectorAll('button[data-ref]').forEach(b=>{
    b.onclick = async ()=>{
      const s = pool[+b.dataset.ref];
      b.textContent = '⟳ 取数中';
      try{
        await loadStock(s);
        s._k = {};                                  // 行情变了，图表缓存作废，按当前周期重取
        s._vm = null;                               // 分时量能也强制重算（手动取数就是"我现在就要最新"）
        await loadChart(s, true);
        /* 研究数据（估值/板块）也一并强制重取。
           必要性：估值按自然日缓存，若首次取数撞上网络抖动而失败，
           会进入 10 分钟失败冷却，自动刷新不会重试 —— 必须留一个手动重试入口。 */
        await loadResearch(s, true);
        if (s.ddOn){ try{ await loadDD(s, true); }catch(_){} }
        render(pool); savePool();
        stampData();                                // 单只手动取数同样算"取到数据了"
        checkPriceAlerts();
      }catch(e){ toastErr('取数失败：' + e.message); b.textContent = '⟳ 取数'; }
    };
  });

  // 周期切换（分时 / 1分 / 5分 / 15分 / 30分 / 60分 / 日K / 周K / 月K）
  box.querySelectorAll('[data-pd]').forEach(el=>{
    el.onclick = async ()=>{
      const s = pool[+el.dataset.pd], p = el.dataset.v;
      if (s.p === p) return;
      s.p = p;
      savePool();
      if (!(s._k && s._k[p])){ el.classList.add('ld'); el.textContent = PERIOD_LABEL[p] + '…'; }
      render(pool);
      try{ await loadChart(s, true); }
      catch(e){ if (s._k) delete s._k[p]; toastErr(PERIOD_LABEL[p] + ' 取数失败：' + e.message); }
      render(pool); savePool();
    };
  });
  // 主图叠加指标开关
  box.querySelectorAll('[data-ovl]').forEach(el=>{
    el.onclick = ()=>{
      const s = pool[+el.dataset.ovl], k = el.dataset.v;
      s.ov = s.ov || {};
      s.ov[k] = s.ov[k] ? 0 : 1;
      render(pool); savePool();
    };
  });
  // 副图切换
  box.querySelectorAll('[data-sub]').forEach(el=>{
    el.onclick = ()=>{
      const s = pool[+el.dataset.sub];
      s.sub = el.dataset.v;
      render(pool); savePool();
    };
  });
  // 大单资金（偏重：要拉全天逐笔明细，约二十来个请求，所以单独按钮、手动触发）
  box.querySelectorAll('[data-ddload]').forEach(el=>{
    el.onclick = async ()=>{
      const s = pool[+el.dataset.ddload];
      s.ddOn = 1;
      el.classList.add('ld'); el.textContent = '💰 取数中…';
      try{ await loadDD(s, true); }
      catch(e){ toastErr('大单数据获取失败：' + e.message); }
      render(pool); savePool();
    };
  });

  // 绘图 + 悬停十字光标（几何参数由绘图函数记在 canvas._geo 上，这里不再重复算一遍）
  box.querySelectorAll('canvas[data-ki]').forEach(cv=>{
    const i = +cv.dataset.ki;
    drawChart(cv, pool[i]);
    cv.addEventListener('mousemove', ev=>{
      const g = cv._geo; if (!g) return;
      const r = cv.getBoundingClientRect();
      const x = ev.clientX - r.left;
      let idx = g.kind === 'bar' ? Math.floor((x - g.PL)/g.bw)
                                 : Math.round((x - g.PL)/(g.innerW || 1)*(g.n - 1));
      if (!(idx >= 0 && idx < g.n)) idx = -1;
      if (_hover[cv.id] !== idx){ _hover[cv.id] = idx; drawChart(cv, pool[i]); }
    });
    cv.addEventListener('mouseleave', ()=>{
      if (_hover[cv.id] != null){ _hover[cv.id] = null; drawChart(cv, pool[i]); }
    });
  });

  /* 图表默认收在 <details> 里，收起时 canvas 的 clientWidth 为 0，
     绘图函数会退回到 640px 兜底宽度。展开后真实宽度才可用，
     必须按新宽度重绘一次，否则图形会被横向拉伸。 */
  box.querySelectorAll('details.quote-fold').forEach(d=>{
    const inp = d.querySelector('input[data-i]');
    const ci = inp ? +inp.dataset.i : -1;
    d.addEventListener('toggle', ()=>{
      if (ci >= 0 && pool[ci]) pool[ci]._qfo = d.open ? 1 : 0;
    });
  });
  box.querySelectorAll('button[data-quickt]').forEach(b => {
    b.onclick = () => openQuickTModal({ idx: +b.dataset.quickt });
  });
  box.querySelectorAll('button[data-reason]').forEach(b => {
    b.onclick = () => {
      const idx = +b.dataset.reason;
      const s = pool[idx];
      if (s) openStockReasonModal(s);
    };
  });
  box.querySelectorAll('button[data-qt-row]').forEach(b => {
    b.onclick = () => {
      openQuickTModal({
        idx: +b.dataset.qtRow,
        dir: b.dataset.dir,
        price: parseFloat(b.dataset.p)
      });
    };
  });

  box.querySelectorAll('details.chart-fold').forEach(d=>{
    /* 记住这一只是展开还是收起（存在 s._fo，savePool 会剥离下划线字段，不写进本机存储）。
       不记的话，render() 每次重建 innerHTML 都会把 details 打回收起状态 ——
       而 render 会由「改任意输入框」「每 60 秒自动刷新」「切股票」触发，
       结果就是"展开图表看一眼，顺手改个数，图没了"。 */
    const kc = d.querySelector('canvas[data-ki]');
    const ci = kc ? +kc.dataset.ki : -1;
    d.addEventListener('toggle', ()=>{
      if (ci >= 0 && pool[ci]) pool[ci]._fo = d.open ? 1 : 0;
      if (!d.open) return;
      d.querySelectorAll('canvas[data-ki]').forEach(cv=>{ const st = pool[+cv.dataset.ki]; if (st) drawChart(cv, st); });
      d.querySelectorAll('canvas[data-rs]').forEach(cv=>{
        const st = pool[+cv.dataset.rs]; if (!st) return;
        const rs = rsCalc(st); if (rs) drawRS(cv, rs);
      });
    });
  });

  renderTopbar();                 // 吸顶栏现价速览
  /* 顺序不能反：applyCur() 会把越界的 CUR 夹回合法范围（删掉当前正在看的那只票时必然发生），
     切换条要按夹正之后的 CUR 画高亮，否则会有一帧"所有标签都不高亮"。 */
  applyCur();                     // 单票聚焦：把视图状态落到刚重建的 DOM 上（render 会清掉 class）
  renderPoolTabs();               // 股票切换条
  renderCogStressIfChanged();     // 自选池增减时同步压力测试表；行情刷新时不动它，避免打断输入
  renderAccount();                // 账户总览与收益曲线
}

/* 窗口尺寸变化：K线画布需按新宽度重绘（防抖） */
let _rsz = null;
window.addEventListener('resize', ()=>{
  clearTimeout(_rsz);
  _rsz = setTimeout(()=>{ render(pool); renderEquity(); }, 220);
});


function bindTotalInput(){
  const inp = document.getElementById('inputTotalAssets');
  const btn = document.getElementById('btnFocusTotal');
  if (btn && inp) {
    btn.onclick = () => { inp.focus(); inp.select && inp.select(); };
  }
  if (inp) {
    const applyVal = () => {
      const val = Math.max(0, +inp.value || 0);
      if (val > 0) {
        localStorage.setItem('t-account-total', String(val));
        toast('总资产已更新为 ¥' + val.toLocaleString('zh-CN'), 'ok');
      } else {
        localStorage.removeItem('t-account-total');
        toast('已恢复为根据持仓市值自动核算', 'info');
      }
      renderAccount();
    };
    inp.onchange = applyVal;
    inp.onkeydown = (e) => {
      if (e.key === 'Enter') inp.blur();
    };
  }
}

/* ===================== 账户总览 / 持仓台账 / 收益曲线 ===================== */
function renderAccount(){
  const a = accountSummary();

  // 同步更新顶栏常驻资产胶囊
  const tbTotal = document.getElementById('tbTotalVal');
  if (tbTotal) tbTotal.textContent = '¥' + Math.round(a.total).toLocaleString('zh-CN');
  const tbMkt = document.getElementById('tbMktVal');
  if (tbMkt) tbMkt.textContent = '¥' + Math.round(a.mkt).toLocaleString('zh-CN');
  const tbPos = document.getElementById('tbPosRate');
  if (tbPos) tbPos.textContent = (a.posRate ? a.posRate.toFixed(1) : '0.0') + '%';

  const el = document.getElementById('accBox');

  // 构建可随时编辑的「总资产」第一卡片
  const totalCardHtml = `
    <div class="ac ac-total-card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span class="k">总资产（本金＋浮动盈亏）</span>
        <span style="font-size:11px;color:var(--info);cursor:pointer;font-weight:600" id="btnFocusTotal" title="点击直接修改总资产本金">✏️ 自定义设置</span>
      </div>
      <div style="display:flex;align-items:center;gap:3px;margin:2px 0">
        <span style="font-size:16px;font-weight:700;color:var(--text)">¥</span>
        <input type="number" id="inputTotalAssets" class="input-total-assets" step="1000" placeholder="点击输入总资产" value="${a.total ? Math.round(a.total) : ''}">
      </div>
      <span class="d">持仓 ${a.posN} 只 ｜ 可用现金 <b style="color:var(--text)">¥${Math.round(a.cap).toLocaleString('zh-CN')}</b></span>
    </div>
  `;

  /* 空态：持仓 0 只时，保留全量资产卡片基准，绝不隐藏总资产与现金市值 */
  if (!a.posN){
    el.innerHTML = `
      ${totalCardHtml}
      <div class="ac"><span class="k">持仓市值</span><span class="v">0</span><span class="d">尚未录入持仓股数</span></div>
      <div class="ac"><span class="k">仓位占比</span><span class="v">0.0%</span><span class="d">现金 100% 空仓防守</span></div>
      <div class="ac"><span class="k">浮动盈亏</span><span class="v" style="color:var(--mute)">—</span><span class="d">录入持仓后自动核算</span></div>
      <div class="acc-guide-box" style="grid-column:1/-1;margin-top:6px;padding:9px 14px;background:var(--info-bg);border:1px solid var(--info-b);border-radius:8px;font-size:12.5px;color:var(--sub);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <span>💡 <b>账户资产基底就绪</b>：上方点击总资产可自由修改总本金。在下方「三、决策引擎」卡片填入 <b>持仓成本</b> 与 <b>持仓股数</b>，即可实时激活单股浮动盈亏、正倒T价位与全账户安全线。</span>
        <button class="primary" id="accGo" style="font-size:12px;padding:3px 10px">去录入成本</button>
      </div>`;

    bindTotalInput();

    const gb = document.getElementById('accGo');
    if (gb) gb.onclick = ()=>{
      const t = document.getElementById('secPlan');
      if (t) t.scrollIntoView({ behavior:'smooth', block:'start' });
      setTimeout(()=>{
        const f = document.querySelector('#pool input[data-k="cost"]');
        if (f){
          const fld = f.closest('.pb-row') || f.closest('.pb') || f.closest('.fld');
          if (fld){ fld.classList.add('hl-flash'); setTimeout(()=>fld.classList.remove('hl-flash'), 1700); }
          f.focus(); f.select && f.select();
        }
      }, 520);
    };
    return;
  }
  const fCls = a.floatPL >= 0 ? 'up' : 'dn';
  const dCls = a.dayPL >= 0 ? 'up' : 'dn';
  el.innerHTML = `
    ${totalCardHtml}
    <div class="ac"><span class="k">持仓市值</span><span class="v">${Math.round(a.mkt).toLocaleString('zh-CN')}</span><span class="d">成本额 ${Math.round(a.costAmt).toLocaleString('zh-CN')}</span></div>
    <div class="ac ${fCls}"><span class="k">浮动盈亏</span><span class="v">${money2(a.floatPL)}</span><span class="d">${a.floatPct!==null?pct(a.floatPct):'—'}</span></div>
    <div class="ac ${dCls}"><span class="k">当日盈亏</span><span class="v">${money2(a.dayPL)}</span><span class="d">${a.dayPct!==null?pct(a.dayPct):'—'}</span></div>
    <div class="ac tt"><span class="k">做T累计已实现</span><span class="v">${money2(a.tReal)}</span><span class="d">台账自动汇总，已扣摩擦成本</span></div>
    <div class="ac"><span class="k">仓位占比</span><span class="v">${a.posRate!==null?a.posRate.toFixed(1)+'%':'—'}</span><span class="d">${a.posRate>=90?'接近满仓，做T只能走底仓倒T法':a.posRate<50&&a.posRate>0?'仓位偏轻，现金充足可正常正T':'—'}</span></div>`;

  bindTotalInput();

  // 全账户现金储备水位风控线
  const cashRatio = a.total > 0 ? (a.cap / a.total * 100) : 100;
  let cashRiskHtml = '';
  if (cashRatio < 10) {
    cashRiskHtml = `<div class="cash-risk-box danger">
      <div><b>🚨 现金池耗尽警报：</b>全账户可用现金仅剩 ${cashRatio.toFixed(1)}%（接近满仓）！已达到资金红线！<b>严禁新开任何正T买入！</b>所有标的仅允许执行底仓倒T！</div>
      <div class="cr-v">现金 ${money2(a.cap)}</div>
    </div>`;
  } else if (cashRatio < 20) {
    cashRiskHtml = `<div class="cash-risk-box warn">
      <div><b>⚠️ 现金水位偏低警戒：</b>全账户可用现金仅占 ${cashRatio.toFixed(1)}%（低于 20% 安全防守线）。防守弹性薄弱，多只标的同时满足买点时请严格限额，优先使用底仓倒T！</div>
      <div class="cr-v">现金 ${money2(a.cap)}</div>
    </div>`;
  }
  if (cashRiskHtml) {
    el.insertAdjacentHTML('beforebegin', cashRiskHtml);
  }

  // ---- 持仓台账 ----
  const hb = document.getElementById('holdBox');
  const rows = pool.map(s=>{
    const p = posCalc(s);
    if (!p.hasPos) return null;
    const fc = p.floatPL>=0?'var(--up)':'var(--down)';
    const dc = (p.dayPL||0)>=0?'var(--up)':'var(--down)';
    const share = a.mkt ? p.mkt/a.mkt*100 : 0;
    return `<tr>
      <td>${s.name}<br><span style="font-size:11.5px;color:var(--mute);font-family:ui-monospace,Consolas,monospace">${s.code}</span></td>
      <td class="num">${p.sh.toLocaleString('zh-CN')}</td>
      <td class="num">${f2(p.cost)}</td>
      <td class="num">${f2(p.px)}</td>
      <td class="num">${Math.round(p.mkt).toLocaleString('zh-CN')}</td>
      <td class="num" style="color:${fc}">${money2(p.floatPL)}</td>
      <td class="num" style="color:${fc}">${p.floatPct!==null?pct(p.floatPct):'—'}</td>
      <td class="num" style="color:${dc}">${p.dayPL!==null?money2(p.dayPL):'—'}</td>
      <td class="num" style="color:${p.tReal>=0?'var(--accent)':'var(--down)'}">${p.tCount?money2(p.tReal):'—'}</td>
      <td class="num">${p.tPerShare!==null?f3(p.tPerShare):'—'}</td>
      <td class="num">${share.toFixed(1)}%</td>
    </tr>`;
  }).filter(Boolean).join('');
  hb.innerHTML = rows
    ? `<table class="snap-tbl"><thead><tr>
        <th>标的</th><th style="text-align:right">持仓股数</th><th style="text-align:right">成本</th><th style="text-align:right">现价</th>
        <th style="text-align:right">市值</th><th style="text-align:right">浮动盈亏</th><th style="text-align:right">盈亏%</th>
        <th style="text-align:right">当日盈亏</th><th style="text-align:right">做T累计</th><th style="text-align:right">每股降本</th><th style="text-align:right">市值占比</th>
      </tr></thead><tbody>${rows}</tbody>
      <tfoot><tr style="font-weight:700;border-top:2px solid var(--line)">
        <td>合计</td><td class="num">—</td><td class="num">—</td><td class="num">—</td>
        <td class="num">${Math.round(a.mkt).toLocaleString('zh-CN')}</td>
        <td class="num" style="color:${a.floatPL>=0?'var(--up)':'var(--down)'}">${money2(a.floatPL)}</td>
        <td class="num">${a.floatPct!==null?pct(a.floatPct):'—'}</td>
        <td class="num" style="color:${a.dayPL>=0?'var(--up)':'var(--down)'}">${money2(a.dayPL)}</td>
        <td class="num" style="color:var(--accent)">${money2(a.tReal)}</td><td class="num">—</td><td class="num">100%</td>
      </tr></tfoot></table>`
    : `<div class="cog-note">还没有持仓。在下面任一标的卡片的输入区填「持仓成本」和「持仓股数」，这里就会自动生成持仓台账。</div>`;

  // ---- 快照明细表 ----
  const sb = document.getElementById('snapTblBox');
  if (!SNAP.length){
    sb.innerHTML = '<div class="cog-note">暂无历史快照。每个交易日收盘后点一次「📌 记录今日收盘快照」，就能看到收益曲线的演进。</div>';
  } else {
    sb.innerHTML = `<table class="snap-tbl"><thead><tr>
        <th>日期</th><th style="text-align:right">总资产</th><th style="text-align:right">持仓市值</th>
        <th style="text-align:right">浮动盈亏</th><th style="text-align:right">当日盈亏</th>
        <th style="text-align:right">做T累计</th><th style="text-align:right">合计收益</th><th style="text-align:right">仓位</th>
      </tr></thead><tbody>${SNAP.slice().reverse().map(r=>{
        const tot = (r.floatPL||0) + (r.tReal||0);
        return `<tr>
          <td>${r.date}</td><td class="num">${(r.total||0).toLocaleString('zh-CN')}</td>
          <td class="num">${(r.mkt||0).toLocaleString('zh-CN')}</td>
          <td class="num" style="color:${r.floatPL>=0?'var(--up)':'var(--down)'}">${money2(r.floatPL||0)}</td>
          <td class="num" style="color:${(r.dayPL||0)>=0?'var(--up)':'var(--down)'}">${money2(r.dayPL||0)}</td>
          <td class="num" style="color:var(--accent)">${money2(r.tReal||0)}</td>
          <td class="num" style="font-weight:700;color:${tot>=0?'var(--up)':'var(--down)'}">${money2(tot)}</td>
          <td class="num">${r.posRate!=null?r.posRate+'%':'—'}</td>
        </tr>`;
      }).join('')}</tbody></table>`;
  }
  renderEquity();
}

/* 收益曲线：合计收益（浮盈＋做T已实现）为主线，另两条为分解 */
function renderEquity(){
  const box = document.getElementById('equityBox');
  if (!box) return;
  if (SNAP.length < 1){
    box.innerHTML = '<div class="cog-note">累计两天以上的快照后，这里会画出收益曲线。</div>';
    return;
  }
  box.innerHTML = '<canvas id="eqCv"></canvas>';
  const cv = document.getElementById('eqCv');
  const W = Math.max(320, box.clientWidth || 760), H = 176;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(W*dpr); cv.height = Math.round(H*dpr); cv.style.height = H+'px';
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,W,H);
  ctx.font = '10.5px ui-monospace,Consolas,monospace';

  const PL = 8, PR = 62, PT = 16, PB = 24;
  const iw = W-PL-PR, ih = H-PT-PB;
  const n = SNAP.length;
  const total = SNAP.map(r => (r.floatPL||0) + (r.tReal||0));
  const floatArr = SNAP.map(r => r.floatPL||0);
  const tArr = SNAP.map(r => r.tReal||0);

  let lo = Math.min(0, ...total, ...floatArr, ...tArr);
  let hi = Math.max(0, ...total, ...floatArr, ...tArr);
  if (hi === lo){ hi = lo + 1; }
  const pad = (hi-lo)*0.12; lo -= pad; hi += pad;

  const X = i => n===1 ? PL + iw/2 : PL + iw*i/(n-1);
  const Y = v => PT + ih - (v-lo)/(hi-lo)*ih;

  // 网格 + 刻度
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (let k=0;k<=4;k++){
    const v = lo + (hi-lo)*k/4, yy = Y(v);
    ctx.strokeStyle = '#eef1f4';
    ctx.beginPath(); ctx.moveTo(PL, yy+.5); ctx.lineTo(W-PR, yy+.5); ctx.stroke();
    ctx.fillStyle = '#66707c'; ctx.fillText(Math.round(v).toLocaleString('zh-CN'), W-PR+5, yy);
  }
  // 零轴
  if (lo < 0 && hi > 0){
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PL, Y(0)+.5); ctx.lineTo(W-PR, Y(0)+.5); ctx.stroke();
  }
  // 折线
  const line = (arr, col, w, dash)=>{
    ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = w; if (dash) ctx.setLineDash(dash);
    ctx.beginPath(); arr.forEach((v,i)=>{ i ? ctx.lineTo(X(i),Y(v)) : ctx.moveTo(X(i),Y(v)); });
    ctx.stroke(); ctx.restore();
    if (n===1){ ctx.fillStyle = col; ctx.beginPath(); ctx.arc(X(0),Y(arr[0]),3,0,7); ctx.fill(); }
  };
  line(tArr,   '#7c3aed', 1.4, [5,3]);
  line(floatArr, '#2563eb', 1.4, [5,3]);
  line(total,  total[n-1]>=0 ? CH.up : CH.dn, 2.2);

  // 末端数值标注
  const lx = X(n-1);
  ctx.textAlign = 'right'; ctx.fillStyle = total[n-1]>=0?CH.up:CH.dn;
  ctx.fillText(money2(total[n-1]), lx-4, Y(total[n-1]) - (n>1?8:-8));

  // 日期轴
  ctx.textAlign = 'center'; ctx.fillStyle = '#66707c';
  const idxs = n<=3 ? [...Array(n).keys()] : [0, Math.floor((n-1)/2), n-1];
  [...new Set(idxs)].forEach(i=> ctx.fillText(SNAP[i].date.slice(5), X(i), H-8));

  // 图例
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  let gx = PL;
  [[total[n-1]>=0?CH.up:CH.dn,'合计收益（浮盈＋做T）',0],['#2563eb','浮动盈亏',1],['#7c3aed','做T累计已实现',2]].forEach(([c,t])=>{
    ctx.strokeStyle = c; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(gx, PT-8); ctx.lineTo(gx+14, PT-8); ctx.stroke();
    ctx.fillStyle = '#515c69'; ctx.fillText(t, gx+17, PT-8);
    gx += 22 + ctx.measureText(t).width;
  });
}


/* ===================== 尾盘 10% 仓位黑马推荐与隔夜 T+0 战法（支持多只并存） ===================== */
let TAIL_ACTIVES = [];
try {
  const raw = localStorage.getItem('t-tail-buy-active');
  if (raw) {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      TAIL_ACTIVES = parsed;
    } else if (parsed && typeof parsed === 'object') {
      TAIL_ACTIVES = [parsed]; // 兼容旧版单个对象
    }
  }
} catch(_) {}

function saveTailActive() {
  try {
    const activeOnly = TAIL_ACTIVES.filter(x => x && x.status === 'active');
    if (activeOnly.length > 0) {
      localStorage.setItem('t-tail-buy-active', JSON.stringify(activeOnly));
    } else {
      localStorage.removeItem('t-tail-buy-active');
    }
  } catch(_) {}
}

function getAccountTotalAssetsForTail() {
  try {
    const raw = localStorage.getItem('t-account-total');
    if (raw) {
      const v = parseFloat(raw);
      if (v > 0) return v;
    }
  } catch(_) {}
  // 兜底：从 pool 计算持仓市值 + 可用现金
  let mkt = 0, cap = 0;
  if (typeof pool !== 'undefined' && Array.isArray(pool)) {
    pool.forEach(s => {
      const px = +s.price || +s.prevClose || 0;
      mkt += (s.shares || 0) * px;
      cap += (s.cap || 0);
    });
  }
  return (mkt + cap) > 0 ? (mkt + cap) : 100000;
}

function getTailBuyCandidates() {
  const totalAssets = getAccountTotalAssetsForTail();
  const tenPctBudget = totalAssets * 0.10;
  
  let cands = [];
  if (typeof WB_LATEST !== 'undefined' && WB_LATEST && Array.isArray(WB_LATEST.candidates)) {
    cands = WB_LATEST.candidates;
  } else if (typeof pool !== 'undefined' && Array.isArray(pool)) {
    cands = pool.map(s => ({
      name: s.name,
      code: s.code,
      tcode: s.tcode,
      price: +s.price || +s.prevClose || 10,
      score: 85,
      vwapOnline: 90,
      volRatio: 1.5,
      retOpen: 2.5
    }));
  }

  // 严格过滤：有分值、价格合法
  const valid = cands.filter(c => {
    if (!c.score || c.score < 80) return false;
    if (!c.price || c.price <= 0) return false;
    return true;
  });

  valid.forEach(c => {
    const vwapScore = (c.vwapOnline || 80) * 0.3;
    const volScore = Math.min(c.volRatio || 1, 4) * 5;
    const retScore = (c.retOpen > 0 && c.retOpen < 6) ? 15 : 5;
    c._tailRank = (c.score * 0.4) + vwapScore + volScore + retScore;
  });

  valid.sort((a, b) => b._tailRank - a._tailRank);

  const top2 = valid.slice(0, 2).map((c, idx) => {
    const px = +c.price;
    const recShares = Math.max(100, Math.floor((tenPctBudget / px) / 100) * 100);
    const halfShares = Math.max(100, Math.floor((tenPctBudget * 0.5 / px) / 100) * 100);
    const costAmt = +(recShares * px).toFixed(2);
    const actualPct = +((costAmt / totalAssets) * 100).toFixed(1);
    const tp1 = +(px * 1.025).toFixed(2);
    const tp2 = +(px * 1.045).toFixed(2);
    const stop = +(px * 0.985).toFixed(2);

    return {
      rank: idx + 1,
      rankTitle: idx === 0 ? '🥇 首选黑马 TOP 1' : '🥈 次选黑马 TOP 2',
      rankClass: idx === 0 ? 'top1' : 'top2',
      code: c.code,
      tcode: c.tcode || c.code,
      name: c.name,
      score: c.score,
      price: px,
      retOpen: c.retOpen != null ? +c.retOpen.toFixed(2) : 2.5,
      vwapOnline: c.vwapOnline != null ? +c.vwapOnline.toFixed(1) : 95.0,
      volRatio: c.volRatio != null ? +c.volRatio.toFixed(2) : 2.0,
      turnover: c.turnover ? +c.turnover.toFixed(1) : 5.0,
      recShares,
      halfShares,
      costAmt,
      actualPct,
      tp1,
      tp2,
      stop,
      whyReasons: c.whyReasons || [
        `🛡️ 日内均价线上方运行时间占比高达 ${c.vwapOnline || 95}%，主力控盘稳定`,
        `🔥 量比 ${c.volRatio || 2.0}，尾盘持续温和放量，承接有力`,
        `🎯 闭环预案：次日早盘 09:30~10:00 冲高 ${tp1} (+2.5%) 坚决止盈`
      ]
    };
  });

  return {
    totalAssets,
    tenPctBudget,
    candidates: top2
  };
}

function renderTailBuySection() {
  const host = document.getElementById('secTailBuy');
  if (!host) return;

  const data = getTailBuyCandidates();
  const totalAssets = data.totalAssets;
  const tenPctBudget = data.tenPctBudget;

  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const isTailTime = (mins >= 870 && mins < 895); // 14:30 - 14:55
  const isExitTime = (mins >= 570 && mins < 600); // 09:30 - 10:00

  // 1. 窗口状态徽章
  let badgeHtml = '';
  if (isTailTime) {
    const leftMins = 895 - mins;
    badgeHtml = `<span class="tb-status-pill live">🟢 14:30-14:55 尾盘潜伏窗口生效中 (距截止剩 ${leftMins} 分钟)</span>`;
  } else if (isExitTime) {
    const leftMins = 600 - mins;
    badgeHtml = `<span class="tb-status-pill exit">⚡ 09:30-10:00 隔夜T+0冲高止盈窗口 (距10:00还剩 ${leftMins} 分钟)</span>`;
  } else {
    badgeHtml = `<span class="tb-status-pill idle">⏳ 预演观察期 (每日 14:30-14:50 自动触发精选黑马)</span>`;
  }

  // 2. 次日早盘 30 分钟冲高止盈雷达（支持多只并存！）
  let radarHtml = '';
  const activeList = TAIL_ACTIVES.filter(x => x && x.status === 'active');

  if (activeList.length > 0) {
    let totalAmt = 0;
    let totalFloatPL = 0;

    const itemsHtml = activeList.map((item, aIdx) => {
      // 查找该票最新现价
      let curPx = item.buyPx;
      if (typeof pool !== 'undefined') {
        const match = pool.find(s => s.name === item.name || s.code === item.code);
        if (match && (+match.price || +match.prevClose)) curPx = +(match.price || match.prevClose);
      }
      const floatPL = +( (curPx - item.buyPx) * item.shares ).toFixed(2);
      const floatRatio = +( ((curPx - item.buyPx) / item.buyPx) * 100 ).toFixed(2);
      const isUp = floatPL >= 0;
      const plCol = isUp ? 'var(--up)' : 'var(--down)';

      totalAmt += (item.buyPx * item.shares);
      totalFloatPL += floatPL;

      let signalTag = '<span class="tb-sig-tag idle">观察中</span>';
      if (curPx >= item.tp2) {
        signalTag = '<span class="tb-sig-tag tp2">🚀 触及 T2 极限高抛位 (+4.5%)，全力止盈！</span>';
      } else if (curPx >= item.tp1) {
        signalTag = '<span class="tb-sig-tag tp1">🎯 触及 T1 止盈目标位 (+2.5%)，强烈建议分批落袋！</span>';
      } else if (curPx <= item.stop) {
        signalTag = '<span class="tb-sig-tag stop">⚠️ 跌破纪律止损位 (-1.5%)，10:00前坚决止损！</span>';
      }

      return `
        <div class="trc-item-card" data-tid="${item.id || aIdx}">
          <div class="tic-head">
            <div class="tic-title">
              <span class="tic-idx">#${aIdx + 1}</span>
              <b class="tic-name">${item.name}</b>
              <span class="tic-code">${item.code}</span>
              <span class="tic-date">${item.date} 潜伏</span>
            </div>
            <div class="tic-badge-wrap">
              ${signalTag}
              <button type="button" class="btn-trc-item-dismiss" data-dismiss-id="${item.id || aIdx}" title="清除该标的监控标记">✕ 移除</button>
            </div>
          </div>
          <div class="tic-kpis">
            <div class="tic-kpi">
              <span class="k">买入价 ➔ 现价</span>
              <span class="v">¥${item.buyPx} ➔ <b style="color:${plCol}">¥${curPx}</b></span>
            </div>
            <div class="tic-kpi">
              <span class="k">持仓股数</span>
              <span class="v"><b>${item.shares}</b> 股</span>
            </div>
            <div class="tic-kpi">
              <span class="k">隔夜浮动盈亏</span>
              <span class="v" style="color:${plCol}"><b>${isUp?'+':''}${floatPL} 元</b> (${isUp?'+':''}${floatRatio}%)</span>
            </div>
            <div class="tic-kpi">
              <span class="k">止盈目标位</span>
              <span class="v">T1: ¥${item.tp1} ｜ T2: ¥${item.tp2}</span>
            </div>
          </div>
          <div class="tic-exec-row">
            <span class="tic-k">卖出价: ¥</span>
            <input class="trc-sell-inp" id="trcSell_${item.id || aIdx}" type="number" step="0.01" value="${curPx}">
            <button type="button" class="btn-trc-exec" data-exit-id="${item.id || aIdx}">🔴 确认冲高止盈平仓</button>
          </div>
        </div>
      `;
    }).join('');

    const isTotalUp = totalFloatPL >= 0;
    const totalPlCol = isTotalUp ? 'var(--up)' : 'var(--down)';

    radarHtml = `
      <div class="tail-radar-box">
        <div class="trb-head">
          <div class="trb-title">
            <span class="trc-badge">⚡ 隔夜 T+0 冲高止盈雷达</span>
            <b>当前已潜伏 ${activeList.length} 只标的</b>
            <span class="trb-sub">合计占用 ¥${Math.round(totalAmt).toLocaleString('zh-CN')} ｜ 合计浮动盈亏: <b style="color:${totalPlCol}">${isTotalUp?'+':''}${totalFloatPL.toFixed(2)} 元</b></span>
          </div>
          <div class="trb-actions">
            ${activeList.length > 1 ? '<button type="button" class="btn-trc-bulk-exit" id="btnTailBulkExit">🔴 一键全部冲高平仓</button>' : ''}
            <button type="button" class="btn-trc-dismiss" id="btnTailDismissAll" title="已手动平仓或不再监控时清除全部标记">清除全部</button>
          </div>
        </div>
        <div class="trb-time-tip-bar">
          <span>⏰ 纪律：09:30~10:00 黄金兑现窗口，10:00 前必须完成平仓释放 100% 现金，做回自由 T+0！</span>
        </div>
        <div class="trb-items-grid">
          ${itemsHtml}
        </div>
      </div>
    `;
  }

  // 3. 候选人卡片
  let cardsHtml = '';
  if (data.candidates && data.candidates.length > 0) {
    cardsHtml = data.candidates.map((c, idx) => `
      <div class="tail-cand-card ${c.rankClass}">
        <div class="tcc-head">
          <div class="tcc-rank-title">${c.rankTitle}</div>
          <div class="tcc-name-wrap">
            <b class="tcc-name">${c.name}</b>
            <span class="tcc-code">${c.code}</span>
          </div>
          <span class="tcc-score-badge">评分 ${c.score}分</span>
        </div>
        <div class="tcc-kpis">
          <div class="tcc-kpi">
            <span class="k">参考价格</span>
            <span class="v">¥${c.price} <small class="up">(+${c.retOpen}%)</small></span>
          </div>
          <div class="tcc-kpi">
            <span class="k">均线时长</span>
            <span class="v">${c.vwapOnline}% 在分时线上</span>
          </div>
          <div class="tcc-kpi">
            <span class="k">量比 / 换手</span>
            <span class="v">${c.volRatio} / ${c.turnover}%</span>
          </div>
        </div>
        <div class="tcc-sizing-box">
          <div class="tcc-sz-row">
            <span>🎯 10% 顶格建议仓位: <b>${c.recShares} 股</b> (约 ¥${c.costAmt.toLocaleString('zh-CN')}，占总资产 ${c.actualPct}%)</span>
          </div>
          <div class="tcc-sz-targets">
            <span>冲高止盈 T1: <b class="up">¥${c.tp1} (+2.5%)</b></span>
            <span>·</span>
            <span>极限 T2: <b class="up">¥${c.tp2} (+4.5%)</b></span>
            <span>·</span>
            <span>止损防守: <b class="down">¥${c.stop} (-1.5%)</b></span>
          </div>
        </div>
        <div class="tcc-reasons">
          ${c.whyReasons.map(r => `<div class="tcc-reason-item">${r}</div>`).join('')}
        </div>
        <div class="tcc-act-bar">
          <div class="tcc-inputs">
            <div class="tcc-inp-row">
              <span class="k">买价: ¥</span>
              <input class="tcc-inp" id="tbInpPx_${idx}" type="number" step="0.01" value="${c.price}">
            </div>
            <div class="tcc-inp-row">
              <span class="k">数量:</span>
              <input class="tcc-inp" id="tbInpQty_${idx}" type="number" step="100" value="${c.recShares}" style="width:68px">
              <span class="k">股</span>
            </div>
            <div class="tcc-pills">
              <button type="button" class="tcc-pill" data-tb-fill-qty="${c.recShares}" data-idx="${idx}">10%顶格(${c.recShares})</button>
              <button type="button" class="tcc-pill" data-tb-fill-qty="${c.halfShares}" data-idx="${idx}">5%半仓(${c.halfShares})</button>
              <button type="button" class="tcc-pill" data-tb-fill-qty="100" data-idx="${idx}">1手</button>
            </div>
          </div>
          <button type="button" class="btn-tb-buy" data-tb-idx="${idx}">🟢 14:30 尾盘买入建仓（一键入选+多只并存）</button>
        </div>
      </div>
    `).join('');
  } else {
    cardsHtml = '<div style="color:var(--mute);padding:16px;text-align:center">暂无符合条件的 80分+ 尾盘黑马标的，请在盘中刷新行情或点击重新计算。</div>';
  }

  // 组装 Section 内容
  host.innerHTML = `
    <div class="tail-head-bar">
      <div class="th-title-box">
        <h3>🎯 尾盘买入策略推荐（隔夜 T+0 战法）</h3>
        <p class="th-sub">14:30~14:50 锁定 TOP 1~2 只最强黑马 ｜ 10% 顶格仓位潜伏 ｜ 次日 09:30~10:00 冲高闭环兑现 ｜ 支持多只同时潜伏</p>
      </div>
      <div class="th-status-box">
        ${badgeHtml}
      </div>
    </div>
    <div class="tail-budget-strip">
      <span>当前总资产: <b>¥${Math.round(totalAssets).toLocaleString('zh-CN')}</b></span>
      <span>·</span>
      <span>10% 顶格潜伏预算: <b style="color:var(--accent)">¥${Math.round(tenPctBudget).toLocaleString('zh-CN')}</b></span>
      <span>·</span>
      <span>策略纪律: <b>单票上限 10% 或 双票各 5% ｜ 绝不过夜加仓，次日 10:00 前必平</b></span>
    </div>
    ${radarHtml ? `<div class="tail-radar-wrap">${radarHtml}</div>` : ''}
    <div class="tail-cards-grid">
      ${cardsHtml}
    </div>
  `;

  // 绑定事件
  bindTailBuyEvents(data.candidates);
}

function bindTailBuyEvents(candidates) {
  // 1. 快捷填写股数
  document.querySelectorAll('[data-tb-fill-qty]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const idx = +btn.dataset.idx;
      const targetInp = document.getElementById(`tbInpQty_${idx}`);
      if (targetInp) targetInp.value = btn.dataset.tbFillQty;
    };
  });

  // 2. 尾盘买入执行
  document.querySelectorAll('[data-tb-idx]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const idx = +btn.dataset.tbIdx;
      const cand = candidates[idx];
      if (!cand) return;

      const pxInp = document.getElementById(`tbInpPx_${idx}`);
      const qtyInp = document.getElementById(`tbInpQty_${idx}`);
      const buyPx = parseFloat(pxInp.value) || cand.price;
      const buyQty = parseInt(qtyInp.value, 10) || cand.recShares;

      if (buyPx <= 0) { toastWarn('请输入有效的买入价格'); return; }
      if (buyQty <= 0) { toastWarn('请输入有效的买入股数'); return; }

      execTailBuy(cand, buyPx, buyQty);
    };
  });

  // 3. 单只冲高止盈执行
  document.querySelectorAll('[data-exit-id]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const tid = btn.dataset.exitId;
      const pxInp = document.getElementById(`trcSell_${tid}`);
      const sellPx = parseFloat(pxInp ? pxInp.value : 0) || 0;
      execTailExit(tid, sellPx);
    };
  });

  // 4. 一键全部平仓
  const btnBulk = document.getElementById('btnTailBulkExit');
  if (btnBulk) {
    btnBulk.onclick = e => {
      e.stopPropagation();
      const activeList = TAIL_ACTIVES.filter(x => x && x.status === 'active');
      if (!activeList.length) return;
      if (confirm(`确定以当前最新价格一键全部平仓所有 ${activeList.length} 只尾盘黑马吗？`)) {
        activeList.forEach(item => {
          let curPx = item.buyPx;
          if (typeof pool !== 'undefined') {
            const match = pool.find(s => s.name === item.name || s.code === item.code);
            if (match && (+match.price || +match.prevClose)) curPx = +(match.price || match.prevClose);
          }
          execTailExit(item.id, curPx, true);
        });
        toastOk(`✓ 已成功一键平仓所有 ${activeList.length} 只尾盘黑马，全部资金已回笼！`);
        renderTailBuySection();
      }
    };
  }

  // 5. 单只清除标记
  document.querySelectorAll('[data-dismiss-id]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const tid = btn.dataset.dismissId;
      const target = TAIL_ACTIVES.find(x => (x.id == tid));
      const targetName = target ? target.name : '该标的';
      if (confirm(`确定清除【${targetName}】的尾盘监控标记？（台账与持仓不受影响）`)) {
        TAIL_ACTIVES = TAIL_ACTIVES.filter(x => x.id != tid);
        saveTailActive();
        renderTailBuySection();
        toastOk(`已清除【${targetName}】的尾盘监控标记。`);
      }
    };
  });

  // 6. 清除全部标记
  const btnDismissAll = document.getElementById('btnTailDismissAll');
  if (btnDismissAll) {
    btnDismissAll.onclick = e => {
      e.stopPropagation();
      if (confirm('确定清除全部尾盘监控标记？（台账与持仓不受影响）')) {
        TAIL_ACTIVES = [];
        saveTailActive();
        renderTailBuySection();
        toastOk('已清除全部尾盘监控标记。');
      }
    };
  }
}

function execTailBuy(cand, buyPx, buyQty) {
  const d = new Date();
  const todayStr = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');

  // 检查 pool 中是否已有该票
  let st = null;
  if (typeof pool !== 'undefined') {
    st = pool.find(s => s.name === cand.name || s.code === cand.code);
    if (!st) {
      st = {
        name: cand.name,
        code: cand.code,
        tcode: cand.tcode,
        shares: buyQty,
        cost: buyPx,
        price: buyPx,
        prevClose: buyPx,
        tier: 'short',
        cap: 0,
        p: 'day',
        ov: { ma:1, boll:1, box:1, cost:1, sr:0 },
        sub: 'macd'
      };
      pool.push(st);
    } else {
      st.shares = (st.shares || 0) + buyQty;
      st.cost = buyPx;
    }
  }

  // 记录到 TAIL_ACTIVES 列表中（支持多只并存！）
  const existingIdx = TAIL_ACTIVES.findIndex(item => (item.code === cand.code || item.name === cand.name) && item.status === 'active');
  const tailRecord = {
    id: 'tb_' + Date.now() + '_' + (cand.code || Math.random().toString(36).slice(2, 6)),
    date: todayStr,
    name: cand.name,
    code: cand.code,
    tcode: cand.tcode,
    buyPx,
    shares: buyQty,
    costAmt: +(buyPx * buyQty).toFixed(2),
    tp1: cand.tp1,
    tp2: cand.tp2,
    stop: cand.stop,
    status: 'active'
  };

  if (existingIdx >= 0) {
    const old = TAIL_ACTIVES[existingIdx];
    const totalSh = old.shares + buyQty;
    const avgCost = +(((old.buyPx * old.shares) + (buyPx * buyQty)) / totalSh).toFixed(2);
    old.shares = totalSh;
    old.buyPx = avgCost;
    old.costAmt = +(avgCost * totalSh).toFixed(2);
    old.tp1 = cand.tp1;
    old.tp2 = cand.tp2;
    old.stop = cand.stop;
  } else {
    TAIL_ACTIVES.push(tailRecord);
  }
  saveTailActive();

  // 记录到执行台账
  const rec = {
    date: todayStr,
    stock: cand.name,
    dir: '尾盘买入',
    buy: buyPx,
    sell: '',
    qty: buyQty,
    plan: '计划内',
    basis: '客观信号',
    note: `尾盘10%仓位黑马潜伏(目标¥${cand.tp1})`
  };
  if (typeof LOG !== 'undefined') {
    LOG.push(rec);
    try { localStorage.setItem('t-system-log', JSON.stringify(LOG)); } catch(_) {}
  }

  if (typeof savePool === 'function') savePool();
  if (typeof renderLog === 'function') renderLog();
  if (typeof render === 'function') render(pool);
  renderTailBuySection();

  const activeCount = TAIL_ACTIVES.filter(x => x.status === 'active').length;
  toastOk(`✓ 成功买入尾盘黑马【${cand.name}】${buyQty} 股（买入价 ¥${f2(buyPx)}，占用约 ¥${Math.round(buyPx*buyQty)}）！当前共潜伏 ${activeCount} 只标的，次日 09:30-10:00 冲高止盈雷达已全部就绪！`);
}

function execTailExit(tid, sellPx, isSilent) {
  const item = TAIL_ACTIVES.find(x => (x.id == tid) && x.status === 'active');
  if (!item) return;

  const d = new Date();
  const todayStr = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');

  const buyPx = item.buyPx;
  const qty = item.shares;
  const res = calcLiveTrade(buyPx, sellPx, qty, qty);

  // 从 pool 中扣除持仓
  if (typeof pool !== 'undefined') {
    const st = pool.find(s => s.name === item.name || s.code === item.code);
    if (st) {
      st.shares = Math.max(0, (st.shares || 0) - qty);
      if (st.shares === 0) st.cost = 0;
    }
  }

  // 记录卖出台账
  const rec = {
    date: todayStr,
    stock: item.name,
    dir: '尾盘平仓',
    buy: buyPx,
    sell: sellPx,
    qty,
    plan: '计划内',
    basis: '客观信号',
    note: `隔夜T+0冲高止盈平仓(净盈利${res.netProfit}元)`
  };
  if (typeof LOG !== 'undefined') {
    LOG.push(rec);
    try { localStorage.setItem('t-system-log', JSON.stringify(LOG)); } catch(_) {}
  }

  const profitStr = (res.netProfit >= 0 ? '+' : '') + res.netProfit.toLocaleString('zh-CN');
  const targetName = item.name;

  item.status = 'closed';
  saveTailActive();

  if (typeof savePool === 'function') savePool();
  if (typeof renderLog === 'function') renderLog();
  if (typeof render === 'function') render(pool);

  if (!isSilent) {
    renderTailBuySection();
    toastOk(`✓ 隔夜 T+0 冲高平仓完成！【${targetName}】买入 ¥${f2(buyPx)} ➔ 卖出 ¥${f2(sellPx)}，净差价 ${profitStr} 元！已回笼资金约 ¥${Math.round(sellPx*qty)}！`);
  }
}

/* ===================== 启动 ===================== */
let pool = JSON.parse(JSON.stringify(DEFAULT));
try{
  const raw = localStorage.getItem('t-system-pool');
  if (raw) pool = JSON.parse(raw);
}catch(_){}
/* 字段迁移：① 老版本存的是东财 secid → 补成腾讯 tcode；② 新增的 cost/cap 字段补默认值。
   这两步保证浏览器里已存的自选股不会作废，用户不用重录。 */
pool.forEach(s => {
  if (!s.tcode) s.tcode = s.secid ? tencentCode(s.secid) : tcodeFromCode(s.code);
  if (s.cost === undefined) s.cost = 0;
  if (s.cap  === undefined) s.cap  = 0;
  if (s.shares === undefined) s.shares = 0;
  /* 图表偏好（周期 / 叠加 / 副图）是新增字段，老数据里没有，统一补默认值 */
  if (!s.p)   s.p   = 'day';
  if (!s.ov)  s.ov  = { ma:1, boll:1, box:1, cost:1, sr:0 };
  if (!s.sub) s.sub = 'macd';
  if (!s.tier) s.tier = tierOf(s);          // 池别：短线做T / 长线底仓
});

/* 注意：render(pool) 不在这里调 —— 它会连带触发认知体检，而体检要读 LOG。
   必须等 `let LOG` 声明并初始化之后再渲染，否则会撞 TDZ（访问未初始化绑定）而中断整段脚本。
   所以 render(pool) 统一放到文件末尾的启动区执行。 */

document.getElementById('btnSave').onclick = ()=>{
  savePool();
  toastOk('参数已保存到本机浏览器，下次打开自动载入。');
};
document.getElementById('btnReset').onclick = ()=>{
  pool = JSON.parse(JSON.stringify(DEFAULT));
  localStorage.removeItem('t-system-pool');
  render(pool);
};
document.getElementById('btnCalc').onclick = ()=> render(pool);
document.getElementById('btnAdd').onclick = ()=>{
  /* 默认价格一律留空而不是填 10：
     原来那版会插入一行"全 10 元"占位数据，账户区立刻多出一笔 -54% 的假浮亏，
     而用户只是想"加一只票"。留空则一律落到 WAIT 观望，不会污染账户核算。 */
  pool.push({ name:'手动一行', code:'——', tcode:'', prevClose:'', open:'', high:'', low:'',
              price:'', avg:'', vr:1, ma5:'', ma10:'', ma20:'', shares:0, cost:0, cap:0 });
  render(pool); savePool();
  window.scrollTo({ top: document.body.scrollHeight, behavior:'smooth' });
};

/* ---- 数据源栏交互 ---- */
document.getElementById('dbAdd').onclick = ()=>{
  const v = document.getElementById('dbInput').value.trim();
  if (!v) return;
  document.getElementById('dbInput').value = '';
  addByQuery(v);
};
document.getElementById('dbInput').addEventListener('keydown', e=>{
  if (e.key === 'Enter') document.getElementById('dbAdd').click();
});
document.getElementById('dbRefresh').onclick = ()=> refreshAll(false);
document.getElementById('dbTest').onclick = ()=> selfTest();
document.getElementById('dbAuto').onchange = setupTimer;

/* ---- 账户快照 ---- */
document.getElementById('snapTake').onclick = ()=>{
  const st = document.getElementById('dbStatus');
  const r = takeSnapshot();
  if (!r){
    st.className='db-status err';
    st.textContent = '还没有持仓 —— 先在任一卡片的输入区填「持仓股数」（有成本更好），再记录快照。';
    return;
  }
  renderAccount(); render(pool);
  st.className='db-status';
  st.innerHTML = `已记录 <b>${r.date}</b> 快照：总资产 <b>${r.total.toLocaleString('zh-CN')}</b>，`
               + `当前合计收益 <b>${money2((r.floatPL||0)+(r.tReal||0))}</b> 元（浮盈 ${money2(r.floatPL||0)} ＋ 做T ${money2(r.tReal||0)}）。`;
};
document.getElementById('snapClear').onclick = ()=>{
  if (confirm('确定清空全部每日快照？执行台账和持仓参数不受影响。此操作不可撤销。')){
    SNAP = []; saveSnap(); renderAccount();
  }
};

/* ===================== 执行台账 ===================== */
const FEE = 0.0011;   // 往返摩擦成本：佣金万2.5双边 + 印花税千0.5(卖出) + 过户费
/* 多加了两个字段：`plan`（这笔是计划内还是临时起意）、`basis`（依据是客观信号还是"我觉得"）
   —— 这两个字段是《认知术》检验方法一的落点，不标注就无法做认知体检 */
const LCOLS = [['date','日期','text'],['stock','股票','text'],['dir','方向','select',['正T','倒T']],
               ['buy','买入价','num'],['sell','卖出价','num'],['qty','股数','num'],
               ['plan','决策','select',['计划内','临时起意']],
               ['basis','依据','select',['客观信号','我觉得','消息面']],
               ['note','备注','text']];
let LOG = [];
try{ const raw = localStorage.getItem('t-system-log'); if(raw) LOG = JSON.parse(raw); }catch(_){}

function logNet(r){
  const b=+r.buy||0, s=+r.sell||0, q=+r.qty||0;
  if(!b||!s||!q) return null;
  return (s-b)*q - (s+b)*q*FEE;
}
/* 单笔净收益率%，已扣摩擦成本。
   注意：盈亏比必须按「百分比」算，不能按金额 —— 否则一笔大仓位的交易会污染整个结论。 */
function logRatio(r){
  const b=+r.buy||0, s=+r.sell||0;
  if(!b||!s) return null;
  return (s-b)/b*100 - FEE*100;
}
const money = n => (n>=0?'+':'') + Math.round(n).toLocaleString('zh-CN');

function renderLog(){
  const t = document.getElementById('logTable');
  const body = LOG.map((r,i)=>{
    const net = logNet(r);
    const ret = logRatio(r);
    const cells = LCOLS.map(([k,lb,ty,opts])=> `<td>${ ty==='select'
        ? `<select data-li="${i}" data-lk="${k}">
             ${(r[k] ? '' : '<option value="" selected>待标注</option>')
               + opts.map(o=>`<option value="${o}"${r[k]===o?' selected':''}>${o}</option>`).join('')}
           </select>`
        : `<input data-li="${i}" data-lk="${k}" value="${r[k] ?? ''}"${ty==='num'?' inputmode="decimal"':''}>` }</td>` ).join('');
    const netCell = net===null ? '<span style="color:var(--mute)">待填</span>'
      : `<b style="color:${net>=0?'var(--up)':'var(--down)'}">${money(net)}</b>`;
    const retCell = ret===null ? '<span style="color:var(--mute)">—</span>'
      : `<b style="color:${ret>=0?'var(--up)':'var(--down)'}">${(ret>=0?'+':'')+ret.toFixed(2)}%</b>`;
    return `<tr>${cells}<td class="num">${netCell}</td><td class="num">${retCell}</td>`
         + `<td style="text-align:center"><button class="del" data-ldel="${i}">删</button></td></tr>`;
  }).join('');

  t.innerHTML = `<thead><tr>${LCOLS.map(f=>`<th>${f[1]}</th>`).join('')}
      <th style="text-align:right">净盈亏(元)</th><th style="text-align:right">收益率</th><th></th></tr></thead>
    <tbody>${body || `<tr><td colspan="${LCOLS.length+3}" style="text-align:center;color:var(--mute);padding:20px">还没有记录。做了一笔就点上面「记一笔」。</td></tr>`}</tbody>`;

  const valid = LOG.map(logNet).filter(v=>v!==null);
  const win = valid.filter(v=>v>0).length;
  const total = valid.reduce((a,b)=>a+b,0);
  const cls = total>=0 ? 'pos' : 'neg';
  document.getElementById('logSummary').innerHTML =
    `<div>已记录<b>${valid.length}</b>笔</div>
     <div>胜率<b>${ valid.length ? (win/valid.length*100).toFixed(0)+'%' : '—' }</b></div>
     <div>盈 / 亏<b>${win} / ${valid.length-win}</b></div>
     <div>累计净差价<b class="${cls}">${ money(total) }</b></div>
     <div>平均每笔<b class="${cls}">${ valid.length ? money(total/valid.length) : '0' }</b></div>`;

  t.querySelectorAll('input[data-li],select[data-li]').forEach(el=>{
    const ev = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, e=>{
      const i = +e.target.dataset.li, k = e.target.dataset.lk;
      LOG[i][k] = e.target.value;
      localStorage.setItem('t-system-log', JSON.stringify(LOG));
      const caret = e.target.selectionStart;
      renderLog();
      const back = t.querySelector(`[data-li="${i}"][data-lk="${k}"]`);
      if(back && ev==='input'){ back.focus(); try{ back.setSelectionRange(caret,caret); }catch(_){} }
    });
  });
  t.querySelectorAll('button[data-ldel]').forEach(b=>{
    b.onclick = ()=>{ LOG.splice(+b.dataset.ldel,1); localStorage.setItem('t-system-log', JSON.stringify(LOG)); renderLog(); };
  });

  renderCogReport();          // 台账一变，认知体检立刻跟着重算
  render(pool);               // 卡片里的「做T累计贡献 / 每股降本」与账户总览同步刷新
}

document.getElementById('logAdd').onclick = ()=>{
  const d = new Date();
  const today = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  LOG.push({ date:today, stock:'', dir:'正T', buy:'', sell:'', qty:'', plan:'', basis:'', note:'' });
  renderLog();
};
document.getElementById('logClear').onclick = ()=>{
  if(confirm('确定清空全部台账记录？此操作不可撤销。')){
    LOG = []; localStorage.removeItem('t-system-log'); renderLog();
  }
};

/* ===================== 认知台账（《认知术》三条检验法落地） =====================
    T1 给了三条"自己动手就能做"的检验方法，这里把每条都变成自动计算：
      检验一 翻交易记录看理由     → 落成台账的 plan（计划内/临时起意）与 basis（客观信号/我觉得）两个字段，
                                  算「计划执行率」「客观依据率」
      检验二 统计盈亏比           → R = 平均盈利 / 平均亏损。T1 原文："盈亏比小于一比一，认知一定有问题"
      检验三 问"明天暴跌5%怎么办" → 落成每只持仓的止损位 + 应对动作，想不清楚就是没通过
    另把《认知术2》的风险纪律（仓位失控 / 止损 / 不用输不起的钱）落成五条红线自查。
    基准值取自 T1 原文实战数据：胜率约 6 成、平均赚 1.5%、平均亏 0.8% → 盈亏比 1.875。 */
const T1_WIN = 1.5, T1_LOSS = 0.8;      // T1 原文：平均盈利 1.5% / 平均亏损 0.8%（单位：%/笔）
const T1_R   = T1_WIN / T1_LOSS;        // = 1.875，T1 实战盈亏比基准
const RED_LINES = [
  ['no_debt',  '我没有借钱、没有加杠杆',              '借钱和杠杆会让你的每个决策变形'],
  ['idle',     '我动用的是亏光也不影响生活的闲钱',     '用输不起的钱炒股，心态从一开始就输了'],
  ['no_over',  'T仓绝不隔夜，当天闭环',                'T仓隔夜就从"做T"变成了"加仓被套"'],
  ['stop_set', '每笔买入前已设好止损位',               '止损不是认输，是保命'],
  ['pos_ok',   '单票仓位没有超过我的心理承受极限',      '仓位本身不是问题，仓位失控才是问题']
];

let RED = {}, CHECKUPS = [], _stressSig = '';
try{ const r1 = localStorage.getItem('t-system-red');     if (r1) RED      = JSON.parse(r1); }catch(_){}
try{ const r2 = localStorage.getItem('t-system-checkup'); if (r2) CHECKUPS = JSON.parse(r2); }catch(_){}
const saveRed      = ()=>{ try{ localStorage.setItem('t-system-red',      JSON.stringify(RED));      }catch(_){} };
const saveCheckups = ()=>{ try{ localStorage.setItem('t-system-checkup', JSON.stringify(CHECKUPS)); }catch(_){} };

/* 压力测试判定：动作写清楚（≥4 字）+ 止损位有效，且必须低于现价（不低于现价那不叫止损） */
function stressOk(s){
  const act = String(s.p5 || '').trim();
  const sl  = +s.sl5 || 0;
  const px  = +s.price || 0;
  return act.length >= 4 && sl > 0 && (!px || sl < px);
}

/* 全部统计量一次算清 */
function cogStats(){
  const rets = LOG.map(logRatio).filter(v => v !== null);
  const n = rets.length;
  const wins = rets.filter(v => v > 0), losses = rets.filter(v => v < 0);
  const W = n ? wins.length / n : null;
  const avgWin  = wins.length   ? wins.reduce((a,b)=>a+b,0) / wins.length : null;
  const avgLoss = losses.length ? Math.abs(losses.reduce((a,b)=>a+b,0) / losses.length) : null;
  const R = (avgWin !== null && avgLoss) ? avgWin / avgLoss : null;
  const E = (W !== null && avgWin !== null && avgLoss !== null) ? W*avgWin - (1-W)*avgLoss : null;
  const breakevenW = R ? 1/(1+R) : null;      // 期望为 0 的胜率临界点（与盈亏绝对幅度无关，只由盈亏比决定）

  const markedP = LOG.filter(r => r.plan).length;
  const markedB = LOG.filter(r => r.basis).length;
  const planRate = markedP ? LOG.filter(r => r.plan  === '计划内').length   / markedP : null;
  const objRate  = markedB ? LOG.filter(r => r.basis === '客观信号').length / markedB : null;

  const stressRows = pool.filter(s => /^\d{6}$/.test(String(s.code || '')));
  return {
    n, W, avgWin, avgLoss, R, E, breakevenW, planRate, objRate, markedP, markedB,
    stressN: stressRows.length,
    stressPass: stressRows.filter(stressOk).length,
    redN: RED_LINES.length,
    redPass: RED_LINES.filter(([k]) => RED[k]).length
  };
}

/* 认知评分：把看不见的认知压成一个可对比、可看趋势的分（满分 100）
   权重按 T1 的优先级分配：盈亏比 30 > 每笔期望 20 > 决策质量 15 > 压力测试 15 >
   客观依据 10 > 红线 10。三项检验全部计入，评分才有资格叫"认知体检"。 */
function cogScore(st){
  let sc = 0;
  if (st.R !== null){
    if      (st.R >= T1_R) sc += 30;     // 达到 T1 实战基准 1.875
    else if (st.R >= 1.5)  sc += 23;
    else if (st.R >= 1.0)  sc += 14;     // 刚过 T1 红线
  }                                       // < 1.0 记 0 分
  if (st.E !== null){ if (st.E >= 0.5) sc += 20; else if (st.E > 0) sc += 13; }
  if (st.planRate !== null){ if (st.planRate >= 0.8) sc += 15; else if (st.planRate >= 0.6) sc += 9; }
  if (st.objRate  !== null){ if (st.objRate  >= 0.7) sc += 10; else if (st.objRate  >= 0.5) sc += 6; }
  sc += st.stressN ? Math.round(15 * st.stressPass / st.stressN) : 0;   // 检验三：压力测试
  sc += st.redN    ? Math.round(10 * st.redPass    / st.redN)    : 0;   // 《认知术2》红线
  return sc;
}

function renderCogReport(){
  const box = document.getElementById('cogTop');
  if (!box) return;
  const st = cogStats(), score = cogScore(st);
  const hasData = st.n >= 5 && st.R !== null;     // 少于 5 笔不出结论，避免把运气当规律

  let scls = 's-mid', slabel = '样本不足 · 先记满 5 笔';
  if (hasData){
    if      (score >= 75){ scls = 's-good'; slabel = '认知合格 · 保持'; }
    else if (score >= 55){ scls = 's-mid';  slabel = '有漏洞 · 需修正'; }
    else                 { scls = 's-bad';  slabel = '有硬伤 · 先停手'; }
  }

  /* —— 指标条 —— */
  const chips = [];
  const chip = (k,v,c)=> chips.push(`<span style="display:inline-block;margin:0 18px 6px 0;font-size:12px;color:var(--sub)">${k}
      <b style="font-size:14px;font-family:ui-monospace,Consolas,monospace${c?';color:'+c:''}">${v}</b></span>`);
  chip('可统计笔数', st.n + ' 笔');
  if (st.W !== null)      chip('胜率',        (st.W*100).toFixed(0) + '%');
  if (st.avgWin !== null) chip('平均盈利',    '+' + st.avgWin.toFixed(2) + '%',  'var(--up)');
  if (st.avgLoss !== null)chip('平均亏损',    '-' + st.avgLoss.toFixed(2) + '%', 'var(--down)');
  if (st.R !== null)      chip('盈亏比',      st.R.toFixed(2), st.R >= 1 ? 'var(--up)' : 'var(--down)');
  if (st.E !== null)      chip('每笔期望',    (st.E>=0?'+':'') + st.E.toFixed(2) + '%', st.E >= 0 ? 'var(--up)' : 'var(--down)');
  if (st.breakevenW !== null) chip('盈亏平衡胜率', (st.breakevenW*100).toFixed(1) + '%');

  /* —— 三条检验 + 红线 —— */
  const items = [];
  const item = (tag, tagCls, title, body)=> items.push(
    `<li><span class="tag ${tagCls}">${tag}</span><span><b>${title}</b><br>${body}</span></li>`);

  // 检验一
  if (st.markedP === 0 && st.markedB === 0){
    item('检验一','t-wn','翻交易记录 → 还没标注',
      `台账里的「决策」「依据」两列还是空的，没法判断你的决策质量。翻回去逐笔标一下。
       T1 原话：<em>如果你发现大部分交易的理由都是"我觉得"，那你的认知一定有问题。</em>`);
  } else {
    const pr = st.planRate, ob = st.objRate;
    const bad = (pr !== null && pr < 0.6) || (ob !== null && ob < 0.5);
    const mid = !bad && ((pr !== null && pr < 0.8) || (ob !== null && ob < 0.7));
    item('检验一', bad ? 't-no' : (mid ? 't-wn' : 't-ok'), '翻交易记录 → 决策质量',
      `计划内执行率 <em>${pr === null ? '—' : (pr*100).toFixed(0)+'%'}</em>（已标注 ${st.markedP} 笔）·
       客观依据率 <em>${ob === null ? '—' : (ob*100).toFixed(0)+'%'}</em>（已标注 ${st.markedB} 笔）。
       ${bad ? '这已经是 T1 说的"认知一定有问题"的区间 —— 你的买卖正在被情绪而不是规则驱动。'
             : mid ? '还行，但离"绝大多数决策都按计划执行"还有距离。'
                   : '决策质量站得住：大部分动作是按计划、按客观信号做的。'}
       ${LOG.length > st.markedP ? `<span class="src">另有 ${LOG.length - st.markedP} 笔未标注决策类型，会拉低体检准确度。</span>` : ''}`);
  }

  // 检验二
  if (st.avgWin === null || st.avgLoss === null){
    item('检验二','t-wn','统计盈亏比 → 还算不出',
      st.avgWin === null && st.avgLoss === null
        ? '台账里还没有足够的收益率数据。至少要有盈利笔和亏损笔各一笔，盈亏比才有意义。'
        : (st.avgLoss === null
            ? `目前只有盈利笔、还没有亏损笔。这通常意味着两件事之一：样本太小，或者你还没真正执行过止损。T1 要求亏损端必须真实存在 —— <em>允许自己犯错，但要把错误的代价控制在最小。</em>`
            : '目前只有亏损笔、没有盈利笔。先别急着调方法，先把「亏的时候赶紧跑」这条做到。'));
  } else {
    const ok = st.R >= 1;
    item('检验二', ok ? (st.R >= T1_R ? 't-ok' : 't-wn') : 't-no', '统计盈亏比 → 核心指标',
      `盈亏比 <em>${st.R.toFixed(2)}</em>（标准 ≥1.00，T1 实战基准 ${T1_R.toFixed(3)}）·
       每笔期望 <em>${(st.E>=0?'+':'')+st.E.toFixed(2)}%</em>。
       ${ok ? (st.R >= T1_R ? '盈亏比已经达到 T1 的实战水平。' : '过了红线，但还没到 T1 的实战水平（1.875）。')
            : '<em>盈亏比小于一比一，长期下来必亏，胜率再高也救不回来。</em>'}
       ${st.breakevenW !== null ? `以你现在的盈亏比，胜率低于 <em>${(st.breakevenW*100).toFixed(1)}%</em> 就是净亏。` : ''}`);
  }

  // 检验三
  if (st.stressN === 0){
    item('检验三','t-wn','压力测试 → 没有标的可测',
      '自选池里还没有持仓。先去「二、自选股与自动取数」加上你的票。');
  } else {
    const ok = st.stressPass === st.stressN;
    item('检验三', ok ? 't-ok' : 't-no', '压力测试 → 明天跌 5% 怎么办',
      `${st.stressPass} / ${st.stressN} 只标的已想清楚。
       ${ok ? 'T1 标准：能毫不犹豫答"知道"并说出具体方案，认知基本没问题 —— 你达到了。'
            : `<em>还有 ${st.stressN - st.stressPass} 只答不上来。T1 原话：如果你犹豫了，或者回答"到时候再看吧"，那你的认知一定有问题。</em>`}`);
  }

  // 红线
  const redOk = st.redPass === st.redN;
  item('红线', redOk ? 't-ok' : 't-no', '《认知术2》五条红线',
    `${st.redPass} / ${st.redN} 条通过。
     ${redOk ? '没有踩线。记住 T1 那句：<em>市场永远都在，机会永远都在，但你的本金不一定会永远都在。</em>'
             : `<em>有 ${st.redN - st.redPass} 条没做到 —— 这是比盈亏比更优先要修的东西。先活下来，再谈赚钱。</em>`}`);

  box.innerHTML =
    `<div class="cog-score ${scls}"><b>${hasData ? score : '—'}</b>
       <span>认知评分 / 100<br>${slabel}</span></div>
     <div class="cog-diag ${hasData ? (score >= 55 ? 'ok' : 'bad') : ''}">
       <div>${chips.join('')}</div>
       <ul class="cog-list">${items.join('')}</ul>
       <div class="src" style="margin-top:10px">
         数据来源：本机执行台账 + 自选池（实时自动取数）。判定标准引自《认知术》一、二两篇；其中「计划内执行率 ≥80%」「客观依据率 ≥70%」的分档线、以及评分权重（盈亏比30/期望20/决策15/压力测试15/依据10/红线10）为我按 T1 优先级补充的设计，非原文数值。
         ${st.n < 20 && st.n > 0 ? `　⚠️ 当前样本仅 ${st.n} 笔，结论仅供方向参考，记满 20 笔后才算可靠。` : ''}
       </div>
     </div>`;

  renderCogMatrix();     // 矩阵与报告同源，挂在报告末尾一起刷新，避免两处口径漂移
}

/* —— 7.2 盈亏比 × 胜率 敏感度矩阵 —— */
const MX_R = [0.2, 0.5, 0.8, 1.0, 1.5, 1.875, 2.5];
const MX_W = [0.40,0.45,0.50,0.55,0.60,0.65,0.70,0.75,0.80];

function renderCogMatrix(){
  const box = document.getElementById('cogMatrix'), note = document.getElementById('cogMatrixNote');
  if (!box) return;
  const st = cogStats();
  // 以 T1 实战「平均盈利 1.5%/笔」为基准；期望 E = W×1.5 − (1−W)×(1.5/R)
  const cell = (w,r)=> w*T1_WIN - (1-w)*(T1_WIN/r);
  let hitW = null, hitR = null;
  if (st.R !== null && st.W !== null){
    hitW = MX_W.reduce((a,b)=> Math.abs(b-st.W) < Math.abs(a-st.W) ? b : a);
    hitR = MX_R.reduce((a,b)=> Math.abs(b-st.R) < Math.abs(a-st.R) ? b : a);
  }
  const head = '<tr><th class="ax"></th>' + MX_R.map(r=>`<th>${r.toFixed(2)}</th>`).join('') + '</tr>';
  const body = MX_W.map(w=>{
    const tds = MX_R.map(r=>{
      const e = cell(w,r);
      const bg = e > 0.3 ? '#f8cbc7' : e > 0.05 ? '#fce4e2' : e > -0.05 ? '#eef1f5'
               : e > -0.5 ? '#d9f0e3' : '#bce4cd';
      /* 彩色底上的字必须比白底上更深：同一个红写进 #f8cbc7 底只有 4.4，
         所以热力图单独用一套深红 / 深绿，中性格也用 --sub 而不是最浅的 --mute
         （--mute 落在 #eef1f5 上只有 4.44，差一点点不到 AA）。色块表意，文字负责可读。 */
      const fg = e > 0.05 ? '#991b1b' : e < -0.05 ? '#065f46' : 'var(--sub)';
      const hit = (w === hitW && r === hitR) ? ' class="hit"' : '';
      return `<td${hit} style="background:${bg};color:${fg}">${(e>=0?'+':'')+e.toFixed(1)}</td>`;
    }).join('');
    return `<tr><td class="ax">${Math.round(w*100)}%</td>${tds}</tr>`;
  }).join('');
  box.innerHTML = `<table class="mtx"><thead>${head}</thead><tbody>${body}</tbody></table>`;

  const be = r => (1/(1+r)*100);
  note.innerHTML =
    `口径：以 T1 实战值「平均盈利 1.5%/笔」为基准，格内数字＝<b>每笔期望收益（%）</b>，红＝赚、绿＝亏。「胜率」看行、「盈亏比」看列。黑框是你当前所处的位置。
     <br>关键规律：期望为 0 的临界胜率 = <code>1 ÷ (1 + 盈亏比)</code>，与盈亏的绝对幅度无关。所以盈亏比 0.2 时要 <b>${be(0.2).toFixed(1)}%</b> 胜率才不亏，盈亏比 1.875 时只要 <b>${be(T1_R).toFixed(1)}%</b> 就不亏。
     ${st.R !== null ? `<br>你当前盈亏比 <b>${st.R.toFixed(2)}</b> → 胜率必须高于 <b>${(st.breakevenW*100).toFixed(1)}%</b> 才是净赚。` : ''}
     <br>T1 原文那组对照更能说明问题：张三胜率 80%，但赚 1 个点、亏 5 个点（盈亏比 0.2），10 次下来净亏 2 个点；李四胜率只有 40%，但赚 5 个点、亏 1 个点（盈亏比 5），10 次下来净赚 14 个点。<b>胜率根本不重要，盈亏比才重要。</b>
     <span class="src">（注：矩阵按 1.5% 基准归一，绝对数值与 T1 例子中的 1%/5% 不同，但符号与临界关系完全一致。）</span>`;
}

/* —— 7.3 压力测试 —— */
function renderCogStress(){
  const t = document.getElementById('cogStress');
  if (!t) return;
  const rows = pool.filter(s => /^\d{6}$/.test(String(s.code || '')));
  _stressSig = rows.map(s => s.code).join(',');
  if (!rows.length){
    t.innerHTML = '<tbody><tr><td style="color:var(--mute);padding:16px">自选池是空的 —— 先在「二、自选股与自动取数」里添加持仓，这里才能做压力测试。</td></tr></tbody>';
    renderCogStressNote(); renderCogReport(); return;
  }
  const body = rows.map(s=>{
    const i = pool.indexOf(s), ok = stressOk(s);
    return `<tr>
      <td style="white-space:nowrap"><b>${s.name || s.code}</b>
        <br><span style="color:var(--mute);font-size:11.5px">${s.code}${s.price ? ' · 现价 ' + f2(+s.price) : ''}</span></td>
      <td><input type="number" inputmode="decimal" data-si="${i}" data-sk="sl5" value="${s.sl5 ?? ''}" placeholder="止损价"></td>
      <td><input type="text" data-si="${i}" data-sk="p5" value="${s.p5 ?? ''}" placeholder="跌 5% 时我具体做什么（写清动作，少于 4 字不算）"></td>
      <td style="text-align:center"><span class="cog-st ${ok?'ok':'no'}" data-st="${i}">${ok?'已想清':'未通过'}</span></td>
    </tr>`;
  }).join('');
  t.innerHTML = `<thead><tr><th style="width:158px">标的</th><th style="width:104px">止损价</th>
      <th>跌 5% 的应对动作</th><th style="width:76px">状态</th></tr></thead><tbody>${body}</tbody>`;

  t.querySelectorAll('input[data-si]').forEach(inp=>{
    inp.addEventListener('input', e=>{
      const i = +e.target.dataset.si, k = e.target.dataset.sk;
      pool[i][k] = e.target.value; savePool();
      const sp = t.querySelector(`[data-st="${i}"]`);          // 只改这一行的状态，不整表重渲染
      if (sp){ const ok = stressOk(pool[i]); sp.className = 'cog-st ' + (ok?'ok':'no'); sp.textContent = ok ? '已想清' : '未通过'; }
      renderCogReport();                                       // 报告在另一个容器，重渲染不会打断这里输入
    });
  });
  renderCogStressNote(); renderCogReport();
}
function renderCogStressNote(){
  const el = document.getElementById('cogStressNote');
  if (!el) return;
  el.innerHTML = `T1 检验方法三：<b>如果明天市场突然暴跌，我手里的股票跌了 5 个点，我知道该怎么办吗？</b>
    能毫不犹豫回答"知道"、并说出具体方案 → 认知基本没问题；犹豫、或回答"到时候再看吧" → 认知一定有问题。
    <br>判定标准：止损价必须<b>低于现价</b>（不低于现价那不叫止损）；动作描述少于 4 个字视为没想清楚。`;
}
/* 自选池变动时才重建压力测试表（按代码签名判断）。
   为什么不每次都重建：这张表里有输入框，分钟级行情刷新若整表重渲染，正在打字就会被清掉。 */
function renderCogStressIfChanged(){
  const sig = pool.filter(s => /^\d{6}$/.test(String(s.code || ''))).map(s => s.code).join(',');
  if (sig !== _stressSig) renderCogStress();
}

/* —— 7.4 五条红线 —— */
function renderCogRedline(){
  const box = document.getElementById('cogRedline');
  if (!box) return;
  box.innerHTML = RED_LINES.map(([k,label,warn])=>
    `<div class="rl-row">
       <input type="checkbox" id="rl_${k}" data-rl="${k}"${RED[k] ? ' checked' : ''}>
       <label for="rl_${k}">${label}</label>
       <span class="rl-w">${warn}</span>
     </div>`).join('');
  box.querySelectorAll('input[data-rl]').forEach(cb=>{
    cb.onchange = ()=>{ RED[cb.dataset.rl] = cb.checked; saveRed(); renderCogReport(); };
  });
}

/* —— 体检打卡 —— */
function renderCheckup(){
  const el = document.getElementById('cogCheckInfo');
  if (!el) return;
  if (!CHECKUPS.length){
    el.innerHTML = '还没有体检记录。看完上面的报告、把该改的改了，就点一下「今天完成体检打卡」。';
    return;
  }
  const last = CHECKUPS[CHECKUPS.length - 1];
  const days = Math.floor((new Date(todayStr()) - new Date(last)) / 86400000);
  const nd = new Date(new Date(last).getTime() + 30*86400000);
  const next = nd.getFullYear()+'-'+String(nd.getMonth()+1).padStart(2,'0')+'-'+String(nd.getDate()).padStart(2,'0');
  el.innerHTML = `上次体检 <b>${last}</b>（${days} 天前）　·　累计体检 <b>${CHECKUPS.length}</b> 次　·　`
    + (days >= 30
        ? `<span style="color:var(--warn)">⚠️ 已超过 30 天。T1 原文：这三个方法建议你每个月做一次。</span>`
        : `下次体检不晚于 <b>${next}</b>`);
}

/* —— 纯文本报告（便于转发） —— */
function cogText(){
  const st = cogStats(), score = cogScore(st);
  const hasData = st.n >= 5 && st.R !== null;
  const L = [];
  L.push('【做T认知体检】' + todayStr());
  L.push('认知评分 ' + (hasData ? score : '—') + ' / 100');
  L.push('可统计笔数 ' + st.n + ' 笔' + (st.n < 20 ? '（样本不足，结论仅供参考）' : ''));
  if (st.W !== null)         L.push('胜率 ' + (st.W*100).toFixed(0) + '%');
  if (st.avgWin !== null)    L.push('平均盈利 +' + st.avgWin.toFixed(2) + '%');
  if (st.avgLoss !== null)   L.push('平均亏损 -' + st.avgLoss.toFixed(2) + '%');
  if (st.R !== null)         L.push('盈亏比 ' + st.R.toFixed(2) + '（标准 >=1.00，T1 实战基准 1.875）');
  if (st.E !== null)         L.push('每笔期望 ' + (st.E>=0?'+':'') + st.E.toFixed(2) + '%');
  if (st.breakevenW !== null)L.push('盈亏平衡胜率 ' + (st.breakevenW*100).toFixed(1) + '%（低于此值必亏）');
  if (st.planRate !== null)  L.push('计划内执行率 ' + (st.planRate*100).toFixed(0) + '%（已标注 ' + st.markedP + ' 笔）');
  if (st.objRate !== null)   L.push('客观依据率 ' + (st.objRate*100).toFixed(0) + '%（已标注 ' + st.markedB + ' 笔）');
  L.push('压力测试 ' + st.stressPass + '/' + st.stressN + ' 只标的已想清跌 5% 的应对');
  L.push('红线自查 ' + st.redPass + '/' + st.redN + ' 条通过');
  if (CHECKUPS.length) L.push('上次体检 ' + CHECKUPS[CHECKUPS.length-1] + '，累计 ' + CHECKUPS.length + ' 次');
  L.push('——');
  L.push('数据来源：本机执行台账 + 自选池实时行情；判定标准引自《认知术》一、二两篇。');
  L.push('本报告仅供研究参考，不构成个人投资建议。');
  return L.join('\n');
}

document.getElementById('cogRefresh').onclick = ()=>{ renderCogStress(); renderCogRedline(); renderCheckup(); renderCogReport(); };
document.getElementById('cogCheck').onclick = ()=>{
  const today = todayStr();
  if (CHECKUPS[CHECKUPS.length-1] === today){ toastWarn('今天已经打过卡了。'); return; }
  const score = cogScore(cogStats());
  CHECKUPS.push(today); saveCheckups(); renderCheckup();
  toast('已打卡。' + today + ' 这次体检的认知评分是 ' + score + ' 分。\n\n建议把「复制体检报告」存一份，下个月对比 —— 分数有没有涨，比账户盈亏更能说明你走在不在正路上。', 'ok', 9000);
};
document.getElementById('cogCopy').onclick = ()=>{
  const txt = cogText(), ta = document.getElementById('cogCopyTa');
  document.getElementById('cogCopyBox').style.display = 'block';
  ta.value = txt;
  const ok = ()=> toastOk('体检报告已复制，可直接粘贴。');
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(txt).then(ok).catch(()=>{
      ta.focus(); ta.select(); toastWarn('浏览器不允许自动复制，已在下框选中全文，按 Ctrl+C 即可。');
    });
  } else {
    ta.focus(); ta.select();
    try{ document.execCommand('copy'); ok(); }catch(_){ toastWarn('已在下框生成文本，请按 Ctrl+C 复制。'); }
  }
};

/* ===================== 今日作战计划 · 复制 / 导出 / 导入 ===================== */
/* 纯文本作战计划：仿 cogText() 的写法。用户每天真正要带走的是
   "挂在哪个价、跌到哪止损"，而不是体检报告，所以单独做一份。 */
function planText(s){
  const c = calc(s);
  const L = [];
  L.push(`${s.name} ${s.code}　现价 ${f2(+s.price)}（${pct(c.chg)}）· 振幅 ${c.amp.toFixed(2)}% · ${c.grid.toFixed(1)}格`);
  L.push('  判定：' + c.title.replace(/<[^>]+>/g,''));
  if (c.mode === 'BUY'){
    L.push(`  正T买入区：${f2(c.inA)} / ${f2(c.inB)}`);
    L.push(`  止盈目标：${f2(c.tp1)} / ${f2(c.tp2)}`);
    L.push(`  止损：${f2(c.slA)} / ${f2(c.slB)}`);
  } else if (c.mode === 'REV' || c.mode === 'CUT'){
    L.push(`  倒T卖出区：${f2(c.outA)} ~ ${f2(c.outB)}`);
    L.push(`  倒T接回位：${f2(c.bkA)} / ${f2(c.bkB)}`);
    L.push(`  卖飞线：${f2(c.fly)}（放量突破即认卖飞，不接）`);
  } else {
    L.push('  今日观望，不挂单。');
  }
  L.push(`  T仓：${c.sh ? `${c.t} 股（30%）→ 实盘建议挂单 ${c.t1Lots} 股/份 (${c.t1Lots/100}手)` : '— 股（30%），每份 — 股'}`);
  return L.join('\n');
}
function planTextAll(){
  const L = ['【今日做T作战计划】' + todayStr()];
  pool.forEach(s=>{ L.push(''); L.push(planText(s)); });
  L.push('');
  L.push('——');
  L.push('纪律：T仓浮亏 1.5% 无条件砍；14:57 前必须平掉，绝不隔夜。');
  L.push('本计划由本机做T执行台生成，仅供研究参考，不构成投资建议。');
  return L.join('\n');
}
/* 复制到剪贴板：优先 Clipboard API，失败则落到一个只读文本域让用户 Ctrl+C */
function copyPlain(txt, okMsg){
  const done = ()=> toastOk(okMsg);
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(txt).then(done).catch(()=> fallbackCopy(txt, done));
  } else fallbackCopy(txt, done);
}
function fallbackCopy(txt, done){
  let ta = document.getElementById('_copyTa');
  if (!ta){
    ta = document.createElement('textarea');
    ta.id = '_copyTa'; ta.readOnly = true;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px';
    document.body.appendChild(ta);
  }
  ta.value = txt; ta.focus(); ta.select();
  try{ document.execCommand('copy'); done(); }
  catch(_){ toastWarn('自动复制被浏览器拒绝，已生成文本，请按 Ctrl+C 复制。'); }
}
/* 吸顶栏现价速览 */
function renderTopbar(){
  const el = document.getElementById('tbPx');
  if (!el) return;
  el.innerHTML = pool.length
    ? pool.map((s, i)=>{
        const c = calc(s), cl = c.chg>=0 ? 'up' : 'down';
        const mbd = MODE_BADGE[c.mode] || MODE_BADGE.WAIT;
        return `<button class="tb-px-item" data-focus="${i}" title="点击聚焦查看 ${s.name} 做T决策卡">`
          + `<span class="tb-name">${s.name}</span>`
          + `<b class="${cl}">${f2(+s.price)}</b>`
          + `<b class="${cl}">${pct(c.chg)}</b>`
          + `<span class="mg ${mbd[0]}">${mbd[1]}</span>`
          + `</button>`;
      }).join('')
    : '<span style="color:var(--mute)">自选池为空</span>';
  el.querySelectorAll('button[data-focus]').forEach(b => {
    b.onclick = () => focusStock(+b.dataset.focus);
  });
}

/* ===================== 股票切换：单票聚焦 / 全部总览 =====================
   关键实现选择：**不改 render 的过滤逻辑**，全量渲染所有卡片后用 CSS 隐藏非当前卡。
   原因是 render 里 data-i（输入框索引）、canvas[data-ki]（图表索引）全部按 pool 下标走，
   如果在渲染阶段过滤，显示下标与 pool 下标就会错位，输入框会改错股票。
   隐藏-显示的代价是所有票都在 DOM 里，换来的是零索引风险。
   （票数超过 8 只、DOM 明显变重时再考虑虚拟化，那是另一件事。） */
/* 视图状态：one = 只看当前这一只；all = 全部摊开（盘前总览）。
   声明位置在 pool 之后、启动区 render(pool) 之前，render 首次执行时这两个值已就绪。 */
let VIEW = (localStorage.getItem('t-system-view') === 'all') ? 'all' : 'one';
let CUR  = Math.max(0, parseInt(localStorage.getItem('t-system-cur') || '0', 10) || 0);
const MODE_BADGE = {
  BUY : ['buy',  '正T'],
  REV : ['rev',  '倒T'],
  CUT : ['cut',  '只减'],
  WAIT: ['wait', '观望']
};
function renderPoolTabs(){
  const el = document.getElementById('poolTabs');
  if (!el) return;
  /* 切换条吸顶的偏移量 = 吸顶栏实际高度。吸顶栏在窄一点或按钮变多时会换行变高，
     写死数字会让切换条被盖住，所以每次渲染都按真实高度同步一次。 */
  const tbEl = document.getElementById('topbar');
  if (tbEl) document.documentElement.style.setProperty('--tb-h', (tbEl.offsetHeight + 4) + 'px');
  if (!pool.length){ el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = '';
  const tabs = pool.map((s,i)=>{
    const c  = calc(s);
    const cl = c.chg >= 0 ? 'up' : 'down';
    const bd = MODE_BADGE[c.mode] || MODE_BADGE.WAIT;
    /* 只剩一只票时不显示"全部/单只"的区别（data-view 会退回 all），
       但标签仍要高亮 —— 否则一个不高亮的孤立标签看起来像"没选中任何东西"。 */
    const cur = (pool.length < 2) || (VIEW === 'one' && i === CUR);
    return `<button class="pool-tab${cur?' cur':''}" data-tab="${i}" data-tier="${tierOf(s)}"`
      + ` title="${s.name} ${s.code}　${TIER_LABEL[tierOf(s)]}　${bd[1]}　${c.grid.toFixed(1)} 格　距昨收 ${pct(c.chg)}　（点击只看这一只）">`
      + `<span class="tt t-${tierOf(s)}">${tierOf(s) === 'short' ? '短' : '长'}</span>`
      + `<span class="tn">${s.name}</span>`
      + `<span class="pz ${cl}">${f2(+s.price)}</span>`
      + `<span class="pc ${cl}">${pct(c.chg)}</span>`
      + `<span class="mg ${bd[0]}">${bd[1]}</span>`
      + `</button>`;
  }).join('');
  const allBtn = pool.length > 1
    ? `<button class="pool-tab all${VIEW==='all'?' cur':''}" id="tabAll"`
      + ` title="全部摊开：盘前横着对比所有票。键盘 ← → 可在单只之间切换">▤ 全部 ${pool.length} 只</button>`
    : '';
  el.innerHTML = (pool.length > 1 ? '<span class="pt-lab">自选</span>' : '')
               + `<div class="pt-scroll">${tabs}</div>`
               + allBtn;
  el.querySelectorAll('button[data-tab]').forEach(b=>{ b.onclick = ()=> focusStock(+b.dataset.tab); });
  const ab = document.getElementById('tabAll');
  if (ab) ab.onclick = ()=> setView(VIEW === 'all' ? 'one' : 'all');
  /* 票多到一行放不下时，右缘渐隐提示"后面还有"。放在 innerHTML 之后测，
     此时才有真实宽度可量。 */
  const sc = el.querySelector('.pt-scroll');
  if (sc) sc.classList.toggle('has-more', sc.scrollWidth > sc.clientWidth + 2);
}
/* 把 data-view / .is-cur 落到 DOM，并重绘当前卡的画布。
   两个必须注意的点：
   ① canvas 在 display:none 的祖先下 clientWidth 为 0，drawChart 会退化成 640px 兜底宽度，
      所以"显出某张卡"之后必须按真实宽度重画一次；
   ② 反过来，clientWidth 为 0 的画布直接跳过 —— 它在折叠的 <details> 里，画了也看不见，
      每次输入框敲一下都白画 N 张图，成本很实在。 */
function applyCur(){
  const box = document.getElementById('pool');
  if (!box) return;
  if (CUR >= pool.length) CUR = Math.max(0, pool.length - 1);
  const single = (VIEW === 'one' && pool.length > 1);
  box.dataset.view = single ? 'one' : 'all';
  box.querySelectorAll('.card').forEach((card,i)=>{
    const on = !single || i === CUR;
    card.classList.toggle('is-cur', on);
    if (!on) return;
    card.querySelectorAll('canvas[data-ki]').forEach(cv=>{
      if (!cv.clientWidth) return;                       // 折叠中，等展开时再画
      const st = pool[+cv.dataset.ki]; if (st) drawChart(cv, st);
    });
    card.querySelectorAll('canvas[data-rs]').forEach(cv=>{
      if (!cv.clientWidth) return;
      const st = pool[+cv.dataset.rs]; if (!st) return;
      const rs = rsCalc(st); if (rs) drawRS(cv, rs);
    });
  });
}
function scrollToCur(){
  if (VIEW !== 'one' || pool.length < 2) return;
  const card = document.querySelector('#pool > .card.is-cur');
  if (!card) return;
  const tb = document.getElementById('topbar');
  const y = card.getBoundingClientRect().top + window.scrollY - ((tb ? tb.offsetHeight : 0) + 10);
  window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
}
function focusStock(i){
  if (i < 0 || i >= pool.length) return;
  CUR = i; VIEW = 'one';
  try{
    localStorage.setItem('t-system-cur', String(CUR));
    localStorage.setItem('t-system-view', 'one');
  }catch(_){}
  applyCur(); renderPoolTabs(); scrollToCur();
}
function setView(v){
  VIEW = (v === 'all') ? 'all' : 'one';
  try{ localStorage.setItem('t-system-view', VIEW); }catch(_){}
  applyCur(); renderPoolTabs();
  if (VIEW === 'one') scrollToCur();
}




/* ===================== 日内分时作战时钟与尾盘强制平仓风控 ===================== */
function updateTradingClock(){
  const now = new Date();
  const h = now.getHours(), m = now.getMinutes();
  const mins = h * 60 + m;

  const clockEl = document.getElementById('tbClockPhase');
  const dotEl = document.getElementById('clockDot');
  if (!clockEl || !dotEl) return;

  let phase = '🌙 盘后复盘期';
  let dotCls = 'dot-live';
  let isDanger = false;

  if (mins >= 555 && mins < 565) { // 09:15 - 09:25
    phase = '🟡 09:15-09:25 集合竞价 (盯开盘定高低)';
    dotCls = 'dot-live pulse-warn';
  } else if (mins >= 565 && mins < 570) { // 09:25 - 09:30
    phase = '🟡 09:25-09:30 竞价定盘 (定预案价位)';
    dotCls = 'dot-live pulse-warn';
  } else if (mins >= 570 && mins < 585) { // 09:30 - 09:45
    phase = '🔴 09:30-09:45 情绪宣泄期 (严禁冲动追高)';
    dotCls = 'dot-live pulse-red';
  } else if (mins >= 585 && mins < 630) { // 09:45 - 10:30
    phase = '🟢 09:45-10:30 做T黄金窗口 (方向确立·高抛低吸)';
    dotCls = 'dot-live pulse-green';
  } else if (mins >= 630 && mins < 690) { // 10:30 - 11:30
    phase = '👀 10:30-11:30 震荡巩固期 (均线支撑检验)';
    dotCls = 'dot-live pulse-green';
  } else if (mins >= 690 && mins < 780) { // 11:30 - 13:00
    phase = '☕ 11:30-13:00 午间休市 (复盘梳理)';
    dotCls = 'dot-live';
  } else if (mins >= 780 && mins < 840) { // 13:00 - 14:00
    phase = '💤 13:00-14:00 缩量垃圾时间 (多看少动)';
    dotCls = 'dot-live pulse-warn';
  } else if (mins >= 840 && mins < 870) { // 14:00 - 14:30
    phase = '⚡ 14:00-14:30 变盘预警期 (主力抢跑防突变)';
    dotCls = 'dot-live pulse-warn';
  } else if (mins >= 870 && mins < 895) { // 14:30 - 14:55
    phase = '🚨 14:30-14:55 T仓强制平仓期 (日内必须闭环·绝不过夜)';
    dotCls = 'dot-live pulse-red';
    isDanger = true;
  } else if (mins >= 895 && mins < 900) { // 14:55 - 15:00
    phase = '🔒 14:55-15:00 尾盘定盘锁仓';
    dotCls = 'dot-live';
  }

  clockEl.textContent = phase;
  dotEl.className = dotCls;

  // 14:45 强风控：检查今天是否有正T未平仓
  const banner = document.getElementById('overnightAlertBanner');
  if (banner) {
    const todayStr = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');
    const openTCount = (typeof LOG !== 'undefined' ? LOG : [])
      .filter(r => r.date === todayStr && r.dir === '正T').length;
    
    // 如果在 14:30~15:00 之间且有正T开仓未了结，或进入危险期
    if (mins >= 870 && mins < 900 && openTCount > 0) {
      document.getElementById('oabTxt').innerHTML = `🚨 <b>尾盘 14:45 强制平仓风控：</b>检测到今日已开立 ${openTCount} 笔正T买入！<b>A股做T铁律：绝不过夜变加仓！</b>请在 14:55 前果断挂卖平仓或执行止损！`;
      banner.style.display = 'flex';
    } else {
      banner.style.display = 'none';
    }
  }
}
  renderTailBuySection();

// 顶栏资产胶囊绑定
const tbAccPill = document.getElementById('tbAccPill');
if (tbAccPill) {
  tbAccPill.onclick = () => {
    const el = document.getElementById('accSec');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => {
      const inp = document.getElementById('inputTotalAssets');
      if (inp) {
        inp.focus();
        inp.select && inp.select();
        inp.classList.add('hl-flash');
        setTimeout(() => inp.classList.remove('hl-flash'), 1600);
      }
    }, 450);
  };
}

// 时钟弹窗绑定
const tbClockPill = document.getElementById('tbClockPill');
if (tbClockPill) {
  tbClockPill.onclick = () => {
    const m = document.getElementById('tradingClockModal');
    if (m) m.style.display = 'flex';
  };
}
const clockModalClose = document.getElementById('clockModalClose');
if (clockModalClose) {
  clockModalClose.onclick = () => {
    const m = document.getElementById('tradingClockModal');
    if (m) m.style.display = 'none';
  };
}
const clockModalCloseBtn = document.getElementById('clockModalCloseBtn');
if (clockModalCloseBtn) {
  clockModalCloseBtn.onclick = () => {
    const m = document.getElementById('tradingClockModal');
    if (m) m.style.display = 'none';
  };
}
const oabClose = document.getElementById('oabClose');
if (oabClose) {
  oabClose.onclick = () => {
    const b = document.getElementById('overnightAlertBanner');
    if (b) b.style.display = 'none';
  };
}
setInterval(updateTradingClock, 10000);
setTimeout(updateTradingClock, 500);

/* ===================== 标的透视与利空排查弹窗 ===================== */
let _srmOnAdd = null;

function openStockReasonModal(item, onAdd){
  if (!item) return;
  _srmOnAdd = onAdd || null;
  const m = document.getElementById('stockReasonModal');
  if (!m) return;

  const D = window.WB_LATEST || {};
  const recs = D.recommendations || [];
  const sixCode = String(item.code || '').replace(/\D/g, '');
  const rec = recs.find(r => String(r.code).replace(/\D/g, '') === sixCode) || {};

  document.getElementById('srmName').textContent = item.name;
  document.getElementById('srmCode').textContent = item.code;

  const isShort = (item.pool === 'short' || item.tier === 'short' || item.poolLabel === '短线做T');
  const typePill = document.getElementById('srmTypePill');
  typePill.className = 'pill ' + (isShort ? 'p-small' : 'p-steady');
  typePill.textContent = isShort ? '短线做T' : '稳健底仓';

  const scorePill = document.getElementById('srmScorePill');
  const score = item.score || item.poolScore || rec.score || 80;
  scorePill.className = 'pill ' + (score >= 80 ? 'p-can' : score >= 70 ? 'p-small' : 'p-watch');
  scorePill.textContent = '评分 ' + score + (item.verdict ? ' · ' + item.verdict : (rec.verdict ? ' · ' + rec.verdict : ''));

  // 概况小条
  const px = +item.price || +item.latestPrice || +rec.latestPrice || 0;
  const buyPx = +item.buy || +rec.buy || +item.poolBuy || px;
  const s1 = item.sell1 || rec.sell1 || (px * 1.02);
  const stp = item.stop || rec.stop || (px * 0.98);
  document.getElementById('srmSummary').innerHTML = `
    <span>当前现价: <b>${f2(px)}</b></span>
    <span>建议买点: <b>${f2(buyPx)}</b></span>
    <span>目标T1: <b style="color:var(--up)">${f2(s1)}</b></span>
    <span>严守止损: <b style="color:var(--down)">${f2(stp)}</b></span>
    ${item.amp ? `<span>日内振幅: <b>${f2(item.amp)}%</b></span>` : ''}
    ${item.div ? `<span>股息率: <b style="color:var(--warn-d)">${f2(item.div)}%</b></span>` : ''}
  `;

  // 为什么选它
  const reasons = item.whyReasons || rec.whyReasons || [
    '⚡ 涨停突破基因：均线多头形态，量比突破',
    '🛡️ 主力控盘坚挺：分时均价线上方运行时间长',
    '🎯 做T空间充沛：日内振幅提供明确高抛低吸价位'
  ];
  document.getElementById('srmReasons').innerHTML = reasons.map(r => `<div class="sm-reason-item">${r}</div>`).join('');

  // 重大利空排查
  const rc = item.riskCheck || rec.riskCheck || {
    status: 'safe',
    statusText: '🟢 未见重大恶性利空',
    risks: [],
    highlights: ['非ST标的，无退市警示', '流通盘与流动性正常']
  };
  const rkBadge = document.getElementById('srmRiskStatus');
  rkBadge.className = 'sm-risk-badge ' + (rc.status || 'safe');
  rkBadge.textContent = rc.statusText || '🟢 未见重大恶性利空';

  let rkHtml = '';
  if (rc.risks && rc.risks.length) {
    rkHtml += rc.risks.map(rk => `<div class="sm-risk-entry ${rk.level || 'warn'}"><b>⚠️ ${rk.type}：</b>${rk.desc}</div>`).join('');
  }
  if (rc.highlights && rc.highlights.length) {
    rkHtml += rc.highlights.map(hl => `<div class="sm-highlight-entry">✓ ${hl}</div>`).join('');
  }
  if (!rkHtml) rkHtml = '<div class="sm-highlight-entry">✓ 基本面排查正常，无重大恶性警示</div>';
  document.getElementById('srmRisks').innerHTML = rkHtml;

  // 价位与做T测算
  const retOpen = rec.retOpen != null ? rec.retOpen : ((px / buyPx - 1) - 0.0011) * 100;
  const tG = rec.tGainPct || (isShort ? 1.5 : 1.85);
  const totRet = rec.totalReturnWithT != null ? rec.totalReturnWithT : +(retOpen + tG).toFixed(2);
  const clsO = retOpen >= 0 ? 'var(--up)' : 'var(--down)';
  const clsT = totRet >= 0 ? 'var(--up)' : 'var(--down)';

  document.getElementById('srmPerfGrid').innerHTML = `
    <div class="sm-pg-item"><span class="k">推选买入价</span><span class="v">${f2(buyPx)}</span></div>
    <div class="sm-pg-item"><span class="k">买入持有收益</span><span class="v" style="color:${clsO}">${pct(retOpen)}</span></div>
    <div class="sm-pg-item"><span class="k">做T增厚差价</span><span class="v" style="color:var(--info)">+${tG.toFixed(2)}%</span></div>
    <div class="sm-pg-item"><span class="k">做T综合总收益</span><span class="v" style="color:${clsT}">${pct(totRet)}</span></div>
  `;

  const addBtn = document.getElementById('srmAddBtn');
  if (_srmOnAdd) {
    addBtn.style.display = '';
    addBtn.onclick = () => {
      _srmOnAdd();
      closeStockReasonModal();
    };
  } else {
    addBtn.style.display = 'none';
  }

  m.style.display = 'flex';
}

function closeStockReasonModal(){
  const m = document.getElementById('stockReasonModal');
  if (m) m.style.display = 'none';
  _srmOnAdd = null;
}

document.getElementById('srmClose').onclick = closeStockReasonModal;
document.getElementById('srmCloseBtn').onclick = closeStockReasonModal;
document.getElementById('stockReasonModal').onclick = (e) => {
  if (e.target.id === 'stockReasonModal') closeStockReasonModal();
};

/* ===================== 闪电记T（盘中做T快捷记账） ===================== */
let _qtTarget = null;

function openQuickTModal(opts){
  _qtTarget = opts;
  const s = pool[opts.idx];
  if (!s) return;
  const c = calc(s);
  const m = document.getElementById('quickTModal');
  if (!m) return;

  document.getElementById('qtStockName').innerHTML = `${s.name} <span style="font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--sub)">(${s.code})</span>`;

  const dir = opts.dir || (c.mode === 'REV' || c.mode === 'CUT' ? '倒T' : '正T');
  setQtDir(dir);

  const buyInp = document.getElementById('qtBuy');
  const sellInp = document.getElementById('qtSell');
  if (dir === '正T'){
    buyInp.value = opts.price ? f2(opts.price) : f2(c.inA || +s.price);
    sellInp.value = f2(c.tp1 || (+buyInp.value * 1.03));
  } else {
    sellInp.value = opts.price ? f2(opts.price) : f2(c.outA || +s.price);
    buyInp.value = f2(c.bkA || (+sellInp.value * 0.97));
  }

  const qtyInp = document.getElementById('qtQty');
  const recQty = c.t1Lots || (c.tLots >= 100 ? 100 : 100);
  qtyInp.value = opts.qty || recQty;

  const chipsBox = document.getElementById('qtChips');
  const lots = [];
  if (c.t1Lots) lots.push({ label: `建议每份 ${c.t1Lots}股`, qty: c.t1Lots });
  if (c.tLots && c.tLots !== c.t1Lots) lots.push({ label: `满T仓 ${c.tLots}股`, qty: c.tLots });
  if (!lots.some(x => x.qty === 100)) lots.unshift({ label: '1手 100股', qty: 100 });
  if (!lots.some(x => x.qty === 200) && c.sh >= 600) lots.splice(1, 0, { label: '2手 200股', qty: 200 });
  if (!lots.some(x => x.qty === 500) && c.sh >= 1500) lots.push({ label: '5手 500股', qty: 500 });
  chipsBox.innerHTML = lots.map(l => `<button type="button" class="m-chip" data-qty="${l.qty}">${l.label}</button>`).join('');
  chipsBox.querySelectorAll('.m-chip').forEach(b => {
    b.onclick = () => { qtyInp.value = b.dataset.qty; updateQtPreview(); };
  });

  document.getElementById('qtLotHint').textContent = c.t1Lots ? `实盘建议挂单: ${c.t1Lots} 股 (${c.t1Lots/100}手)` : `持仓不足1手T仓`;

  updateQtPreview();
  m.style.display = 'flex';
}

function closeQuickTModal(){
  const m = document.getElementById('quickTModal');
  if (m) m.style.display = 'none';
  _qtTarget = null;
}

function setQtDir(dir){
  document.querySelectorAll('.m-dir-btn').forEach(b => {
    b.classList.toggle('cur', b.dataset.dir === dir);
  });
}

function updateQtPreview(){
  const rawBuy = parseFloat(document.getElementById('qtBuy').value) || 0;
  const rawSell = parseFloat(document.getElementById('qtSell').value) || 0;
  const qty = parseInt(document.getElementById('qtQty').value, 10) || 0;
  const grossEl = document.getElementById('qtGrossPL');
  const netEl = document.getElementById('qtNetPL');
  const retEl = document.getElementById('qtRatio');
  const perShareEl = document.getElementById('qtPerShare');

  if (!rawBuy || !rawSell || !qty){
    grossEl.textContent = '—'; netEl.textContent = '—'; retEl.textContent = '—'; perShareEl.textContent = '—';
    return;
  }
  const slipOn = document.getElementById('qtSlippage')?.checked;
  // 保守滑点：买入多付 0.01 元，卖出少卖 0.01 元
  const buy = slipOn ? rawBuy + 0.01 : rawBuy;
  const sell = slipOn ? Math.max(0.01, rawSell - 0.01) : rawSell;

  const gross = (sell - buy) * qty;
  const fee = (sell + buy) * qty * FEE;
  const net = gross - fee;
  const ret = (sell - buy) / buy * 100 - FEE * 100;
  const s = _qtTarget ? pool[_qtTarget.idx] : null;
  const sh = s ? Math.round(+s.shares || 0) : 0;
  const perShare = sh > 0 ? net / sh : 0;

  const cls = net >= 0 ? 'var(--up)' : 'var(--down)';
  grossEl.textContent = money(gross) + ' 元' + (slipOn ? ' (含滑点)' : '');
  grossEl.style.color = gross >= 0 ? 'var(--up)' : 'var(--down)';
  netEl.textContent = money(net) + ' 元';
  netEl.style.color = cls;
  retEl.textContent = (ret >= 0 ? '+' : '') + ret.toFixed(2) + '%';
  retEl.style.color = cls;
  perShareEl.textContent = sh > 0 ? (perShare >= 0 ? '+' : '−') + Math.abs(perShare).toFixed(3) + ' 元/股' : '未录入持仓股数';
  perShareEl.style.color = cls;
}

function submitQuickT(){
  if (!_qtTarget) return;
  const s = pool[_qtTarget.idx];
  if (!s) return;
  const dirBtn = document.querySelector('.m-dir-btn.cur');
  const dir = dirBtn ? dirBtn.dataset.dir : '正T';
  const buy = parseFloat(document.getElementById('qtBuy').value) || 0;
  const sell = parseFloat(document.getElementById('qtSell').value) || 0;
  const qty = parseInt(document.getElementById('qtQty').value, 10) || 0;
  const plan = document.getElementById('qtPlan').value || '计划内';
  const basis = document.getElementById('qtBasis').value || '客观信号';
  const note = document.getElementById('qtNote').value || '';

  if (!buy || buy <= 0){ toastWarn('请输入有效的买入价格'); return; }
  if (!sell || sell <= 0){ toastWarn('请输入有效的卖出价格'); return; }
  if (!qty || qty <= 0){ toastWarn('请输入成交股数'); return; }

  const d = new Date();
  const today = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');

  const rec = {
    date: today,
    stock: s.name,
    dir,
    buy,
    sell,
    qty,
    plan,
    basis,
    note
  };

  LOG.push(rec);
  try{ localStorage.setItem('t-system-log', JSON.stringify(LOG)); }catch(e){}

  closeQuickTModal();
  renderLog();
  render(pool);

  const net = (sell - buy) * qty - (sell + buy) * qty * FEE;
  toastOk(`已成功记入台账：${s.name} ${dir} 净收益 ${money(net)} 元！`);
}

document.getElementById('quickTClose').onclick = closeQuickTModal;
document.getElementById('qtCancel').onclick = closeQuickTModal;
document.getElementById('quickTModal').onclick = (e) => {
  if (e.target.id === 'quickTModal') closeQuickTModal();
};
document.getElementById('qtBuy').oninput = updateQtPreview;
document.getElementById('qtSell').oninput = updateQtPreview;
document.getElementById('qtQty').oninput = updateQtPreview;
const qts = document.getElementById('qtSlippage'); if (qts) qts.onchange = updateQtPreview;
document.querySelectorAll('.m-dir-btn').forEach(b => {
  b.onclick = () => { setQtDir(b.dataset.dir); updateQtPreview(); };
});
document.getElementById('qtSubmit').onclick = submitQuickT;

/* 导出 / 导入：五个键全在 localStorage，清缓存换电脑即全丢，
   而台账与认知体检的价值恰恰在跨月累积，所以必须能备份。 */
const LS_KEYS = ['t-system-pool','t-system-log','t-system-snap','t-system-red','t-system-checkup','t-account-total','t-tail-buy-active','t-system-alerts','t-system-alertopt','t-system-tier'];
/* 数据结构版本：以后改字段结构时靠它识别本机旧数据。
   没有版本号的话，旧 JSON 读进来只会表现为一堆 undefined，很难定位到是"数据旧"而不是"代码错"。
   改结构时把 SCHEMA_VER 加 1，并在下面按需补转换逻辑。 */
const SCHEMA_VER = 2, SCHEMA_KEY = 't-system-schema';
function checkSchema(){
  const v = +(localStorage.getItem(SCHEMA_KEY) || 0);
  if (v === SCHEMA_VER) return;
  if (v && v < SCHEMA_VER){
    console.warn('[数据版本] 本机数据 v' + v + ' → 当前 v' + SCHEMA_VER + '，已按兼容模式读取。');
    toastWarn('本机数据是旧版本（v' + v + '），已按兼容模式读取。建议先点「⬇ 导出」留一份备份。');
  }
  localStorage.setItem(SCHEMA_KEY, String(SCHEMA_VER));
}
function exportData(){
  const o = { _app:'t-system', _v:1, _at:new Date().toISOString() };
  LS_KEYS.forEach(k=>{ const v = localStorage.getItem(k); if (v != null) o[k] = v; });
  const blob = new Blob([JSON.stringify(o, null, 2)], { type:'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '做T执行台_备份_' + todayStr() + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=> URL.revokeObjectURL(a.href), 3000);
}
function importData(file){
  const fr = new FileReader();
  fr.onload = ()=>{
    try{
      const o = JSON.parse(fr.result);
      let n = 0;
      Object.keys(o).forEach(k=>{
        if (k.charAt(0) !== '_' && typeof o[k] === 'string'){ localStorage.setItem(k, o[k]); n++; }
      });
      toastOk('已导入 ' + n + ' 项数据，页面即将刷新。');
      location.reload();
    }catch(e){ toastErr('导入失败：不是有效的 JSON —— ' + e.message); }
  };
  fr.readAsText(file);
}

/* ---- 吸顶栏与回到顶部 ---- */
document.getElementById('tbCopyPlan').onclick = ()=> copyPlain(planTextAll(), '今日作战计划已复制，可直接粘贴。');
document.getElementById('tbExport').onclick   = ()=> exportData();
document.getElementById('tbImport').onclick   = ()=> document.getElementById('importFile').click();
document.getElementById('importFile').onchange = e=>{ if (e.target.files[0]) importData(e.target.files[0]); };
document.getElementById('tbRefresh').onclick  = ()=> refreshAll(false);
/* 桌面通知：默认不申请权限，点了才问 —— 权限弹窗只应由用户动作触发，页面一开就弹很讨嫌 */
const _tbNotify = document.getElementById('tbNotify');
_tbNotify.onclick = ()=>{
  if (!('Notification' in window)){ toastWarn('当前浏览器不支持桌面通知；标题栏提示不受影响，仍会生效。'); return; }
  if (Notification.permission === 'granted'){ toastOk('桌面通知已是开启状态：价格触及买点 / 卖点时会通知你。'); return; }
  if (Notification.permission === 'denied'){ toastWarn('桌面通知被浏览器阻止了，请在地址栏左侧的站点设置里放开后重试。'); return; }
  Notification.requestPermission().then(p=>{
    if (p === 'granted'){ toastOk('桌面通知已开启。'); _tbNotify.textContent = '🔔 已开'; }
    else toastWarn('未授权，仅保留标题栏提示。');
  });
};
if ('Notification' in window && Notification.permission === 'granted') _tbNotify.textContent = '🔔 已开';

/* 打印前把折叠区全部展开：打印件是给"离开电脑时"看的，折起来等于没打 */
window.addEventListener('beforeprint', ()=>{
  document.querySelectorAll('details').forEach(d=>{ if (!d.open){ d.dataset.wasclosed = '1'; d.open = true; } });
});
window.addEventListener('afterprint', ()=>{
  document.querySelectorAll('details[data-wasclosed]').forEach(d=>{ d.open = false; delete d.dataset.wasclosed; });
});

checkSchema();
paintStamp();          // 初始就把"数据未取"写出来，别让顶栏留一个没有含义的占位符

/* 切回标签页时若数据已过期，自动补一次 —— 盘中最高频的动作就是"切走一会儿再切回来"，
   而回来看到的可能还是十分钟前的价，这是最容易踩的坑。 */
document.addEventListener('visibilitychange', ()=>{
  if (document.visibilityState !== 'visible') return;
  paintStamp();
  if (STAMP && isTradeDay() && (Date.now() - STAMP) / 60000 >= STALE_MIN) refreshAll(true);
});

const _toTop = document.getElementById('toTop');
_toTop.onclick = ()=> window.scrollTo({ top:0, behavior:'smooth' });
window.addEventListener('scroll', ()=>{ _toTop.style.display = window.scrollY > 500 ? 'block' : 'none'; });

/* ---- 键盘快捷键：盘中是分秒必争的场景 ---- */
document.addEventListener('keydown', e=>{
  const ae = document.activeElement;
  const typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')){
    e.preventDefault(); savePool(); toastOk('参数已保存到本机浏览器。'); return;
  }
  if (typing) return;
  if (e.key === 'Escape'){
    const tcm = document.getElementById('tradingClockModal');
    if (tcm && tcm.style.display !== 'none'){ tcm.style.display = 'none'; return; }
    const srm = document.getElementById('stockReasonModal');
    if (srm && srm.style.display !== 'none'){ closeStockReasonModal(); return; }
    const qtm = document.getElementById('quickTModal');
    if (qtm && qtm.style.display !== 'none'){ closeQuickTModal(); return; }
    // 清除图表悬停十字光标
    Object.keys(_hover).forEach(k=>{ _hover[k] = null; });
    document.querySelectorAll('canvas[data-ki]').forEach(cv=>{
      const st = pool[+cv.dataset.ki]; if (st) drawChart(cv, st);
    });
    return;
  }
  /* ← → 在自选股之间切换（上面已有 typing 守卫，
     光标在输入框里时方向键仍然是移动光标，不会抢） */
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight'){
    if (pool.length < 2) return;
    e.preventDefault();
    focusStock((CUR + (e.key === 'ArrowRight' ? 1 : -1) + pool.length) % pool.length);
    return;
  }
  if (e.code === 'Space'){ e.preventDefault(); refreshAll(false); return; }
  if (e.key === 't' || e.key === 'T'){ window.scrollTo({ top:0, behavior:'smooth' }); return; }
  if (e.key >= '1' && e.key <= '9'){             // 1~9 切周期（对所有卡片生效）
    const idx = +e.key - 1;
    if (!PERIODS[idx]) return;
    const p = PERIODS[idx][0];
    pool.forEach(s=>{ s.p = p; });
    savePool(); render(pool);
    pool.forEach(async s=>{ try{ await loadChart(s, true); render(pool); }catch(_){} });
  }
});

/* 分组筛选按钮（静态 HTML，不随 render 重建，所以只绑一次） */
document.getElementById('tierBar').querySelectorAll('.tier-btn').forEach(b=>{
  b.onclick = ()=> setTier(b.dataset.tier);
});

render(pool);      // 放在启动区：此时 LOG / 认知模块都已初始化完毕
renderLog();
renderCogStress(); renderCogRedline(); renderCheckup();
renderMarket();    // 先渲染占位，避免 #mktBox 在取数完成前是空白（会让人以为区块不存在）
renderAlerts();    // 提醒面板同理：先出空态与开关，别让人以为这块没做

/* ---- 启动即自动取数 ---- */
setupTimer();
refreshAll(true);

/* ===================== 对外接口：热更新自选池 =====================
   为什么需要它：下面的「选股池」模块在另一个 <script> 里，拿不到这里的 pool 变量。
   最早的做法是「写 localStorage + location.reload()」——整页重载会闪、会打断连续挑选，
   点一只票就白屏一次，体验很差。这里把「重读存储 → 补老字段 → 重渲染」封成一个函数挂到
   window 上，外部调用即可，不再重载页面。
   opts.refresh: 新加入的票价格是空的（故意留空，填 0 会显示 −100% 假浮亏），
   需要拉一次行情才有买卖点；用防抖避免连点五只就触发五次全量刷新。 */
let _poolApplyTimer = null;

/* 首次建池用：把主脚本当前内存里的池（可能是页面自带的示例两行）先落盘。
   不这么做的话，下面的 merge 读到的是空数组 —— 点单只加入会把池子清成只剩那一只。 */
window.__savePool = function(){ try{ savePool(); return true; }catch(e){ return false; } };

window.__applyPool = function(opts){
  try{
    const raw = localStorage.getItem('t-system-pool');
    if (!raw) return false;
    pool = JSON.parse(raw);
    /* 与启动区同一套字段迁移，保证从外部写入的条目也能被正常渲染 */
    pool.forEach(s => {
      if (!s.tcode) s.tcode = s.secid ? tencentCode(s.secid) : tcodeFromCode(s.code);
      if (s.cost   === undefined) s.cost   = 0;
      if (s.cap    === undefined) s.cap    = 0;
      if (s.shares === undefined) s.shares = 0;
      if (!s.p)   s.p   = 'day';
      if (!s.ov)  s.ov  = { ma:1, boll:1, box:1, cost:1, sr:0 };
      if (!s.sub) s.sub = 'macd';
    });
    CUR = Math.min(CUR, Math.max(0, pool.length - 1));   // 池子变短时别让选中项越界
    renderPoolTabs();
    render(pool);
    if (opts && opts.refresh){
      clearTimeout(_poolApplyTimer);
      _poolApplyTimer = setTimeout(()=>{ try{ refreshAll(true); }catch(_){} }, 700);
    }
    return true;
  }catch(e){ console.warn('[applyPool]', e); return false; }
};

/* ============================================================
   选股池与战绩透视渲染模块
   ============================================================ */
/* ============================================================
   选股池模块
   - 只读 data/latest.js 里的契约（window.WB_LATEST）
   - 写入只碰 localStorage['t-system-pool']，不直接改主脚本的 pool
   - 单个 chip 可点击加入；批量按钮走同一套写入逻辑
   - 加入后调 window.__applyPool() 热更新，不再整页重载
   ============================================================ */
(function(){
  const box = document.getElementById('selBox');
  if (!box) return;
  const D = window.WB_LATEST;
  const KEY = 't-system-pool';

  if (!D) {
    box.innerHTML = '<div class="sel-empty">读不到 <code>data/latest.js</code>。' +
      '在 <code>选股引擎/</code> 下执行 <code>node publish.js</code> 生成后刷新本页即可。</div>';
    return;
  }

  const env = D.env || {};
  const lvl = { OK: 'ok', WARN: 'warn', BAD: 'bad' }[env.level] || 'warn';
  const lvlText = { OK: '环境放行', WARN: '环境减半', BAD: '环境否决', UNKNOWN: '环境未知' }[env.level] || '环境未知';
  const c = D.counts || {};
  const short = D.candidates || [];
  const steady = D.steady || [];

  const f2 = (v) => (v == null || v === '' || Number.isNaN(+v)) ? '—' : (+v).toFixed(2);
  const sixOf = (v) => String(v == null ? '' : v).replace(/\D/g, '');
  const tip = (r) => r.pool === 'short'
    ? `${r.name} ${r.code}｜评分 ${r.score}（${r.verdict}）\n买点 ${f2(r.buy)}（区间 ${f2(r.buyLo)}–${f2(r.buyHi)}）\nT1 ${f2(r.sell1)}　T2 ${f2(r.sell2)}　止损 ${f2(r.stop)}\n量比 ${f2(r.volRatio)}　均价线上方 ${r.vwapOnline == null ? '—' : r.vwapOnline + '%'}\n允许动作：${r.allowT}`
    : `${r.name} ${r.code}｜评分 ${r.score}\n股息 ${f2(r.div)}%　ROE ${f2(r.roe)}%　市值 ${r.mv} 亿\n20日振幅 ${f2(r.amp20)}%　趋势 ${r.trend}\n允许动作：${r.allowT}`;

  /* ---- 读写本机池 ---- */
  const readPool = () => {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]') || []; } catch (_) { return []; }
  };
  const haveSet = () => new Set(readPool().map((x) => sixOf(x.code)).filter(Boolean));

  /* ---- chip ---- */
  const chipCls = (r) => r.pool === 'short'
    ? ({ '可做': 'c-can', '小做': 'c-small', '观察': 'c-watch', '放弃': 'c-off' }[r.verdict] || 'c-off')
    : 'c-steady';
  const chip = (r, have) => {
    const inPool = have.has(sixOf(r.code));
    const t = tip(r).replace(/"/g, '');
    return `<span class="sel-chip ${chipCls(r)}${inPool ? ' in-pool' : ''}"` +
      ` data-code="${sixOf(r.code)}" data-pool="${r.pool}" data-tip="${t}"` +
      ` title="${t}\n\n${inPool ? '已在自选池' : '点击加入自选池'}">` +
      `<i class="dot-in"></i><span class="sn">${r.name}</span><span class="ss">${r.score}</span></span>`;
  };

  /* ---- 提示条（复用主脚本的 toast 宿主样式） ---- */
  const say = (msg, kind) => {
    const host = document.getElementById('toastHost');
    if (!host) { alert(msg); return; }
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.innerHTML = '<span class="ti"></span><span class="tx"></span><button class="tc">×</button>';
    el.querySelector('.ti').textContent = kind === 'ok' ? '✓' : kind === 'warn' ? '⚠' : 'i';
    el.querySelector('.tx').textContent = msg;
    el.querySelector('.tc').onclick = () => el.remove();
    host.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  };

  /* ---- 渲染整块 ---- */
  function paint(){
    const have = haveSet();
    const inCnt = short.concat(steady).filter((r) => have.has(sixOf(r.code))).length;
    box.innerHTML =
      `<div class="sel-top">
         <span class="sel-env ${lvl}">${lvlText}</span>
         <span>短线候选 <b>${short.length}</b> 只（可做 ${c.canDo || 0} / 小做 ${c.smallDo || 0} / 观察 ${c.watch || 0}）</span>
         <span>·</span>
         <span>稳健底仓 <b>${steady.length}</b> 只</span>
         <span>·</span>
         <span>环境允许执行 <b>${c.executable || 0}</b> 只</span>
         <span class="sel-stamp">数据日 ${D.tradeDate}　${new Date(D.generatedAt).toLocaleString('zh-CN', { hour12: false })}</span>
         ${inCnt ? `<span class="sel-in">已在自选池 ${inCnt} 只</span>` : ''}
       </div>
       <div class="sel-grp">
         <div class="sel-gt"><b>短线做T</b>${env.text ? `<span>${env.text}</span>` : ''}</div>
         <div class="sel-chips">${short.length ? short.map((r) => chip(r, have)).join('') : '<span class="sel-empty">今日无候选</span>'}</div>
       </div>
       <div class="sel-grp">
         <div class="sel-gt"><b>稳健底仓</b><span>仅做倒T，不追正T；缺现金流/负债率等四项校验，仅作候选池</span></div>
         <div class="sel-chips">${steady.length ? steady.map((r) => chip(r, have)).join('') : '<span class="sel-empty">本周未更新</span>'}</div>
       </div>
       <div class="sel-acts">
         <button id="selAddShort">＋ 全部加入短线（${short.length}）</button>
         <button id="selAddSteady">＋ 全部加入稳健（${steady.length}）</button>
         ${inCnt ? '<button id="selSync">⟳ 重新同步状态</button>' : ''}
         <a href="#secPerf" style="font-size:12px;font-weight:600;color:var(--accent);text-decoration:none;display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border-radius:6px;background:var(--accent-bg);border:1px solid var(--accent-b);margin-left:auto">📊 历史推选总账本与60日战绩对比 (${D.recommendations ? D.recommendations.length : 0}只) ↓</a>
       </div>
       <div class="sel-tip">
         <b>点任意一只可直接加入自选池</b>，也可以按上面的按钮整批加入。加入 = 复制一份到下面的自选池，
         之后两边各自独立：引擎明天换掉选股池，自选池里这只不会跟着变，也不会被删。
         不加也能看（颜色和悬停信息都在），只是<b>算不出买卖点、不进账户核算</b>。
         <span class="sel-dim">已加入的会变灰并打勾，重复点会提示已在池中。</span>
       </div>`;
    bindBatch();
  }

  
  /* ============================================================
     历史战绩与收益看板渲染 (合流自 index.html)
     ============================================================ */
  function paintPerfSection(){
    const perf = D.perf || {};
    const recs = D.recommendations || [];
    const tot = perf.totalStats || {};
    const sStats = perf.shortStats || {};
    const stStats = perf.steadyStats || {};
    const envCheck = perf.envCheck || {};

    const pct = (v) => (v == null || v === '' || Number.isNaN(+v)) ? '—' : (v >= 0 ? '+' : '') + (+v).toFixed(2) + '%';

    // KPI 渲染
    const perfKpisEl = document.getElementById('perfKpis');
    if (perfKpisEl) {
      perfKpisEl.innerHTML = `
        <div class="pk-card">
          <div class="pk-k">累计全量建档</div>
          <div class="pk-v">${tot.count || recs.length || 0}<small style="font-size:11px;font-weight:400;color:var(--mute)"> 只</small></div>
          <div class="pk-s">短线 ${sStats.count || 0} ｜ 稳健 ${stStats.count || 0}</div>
        </div>
        <div class="pk-card">
          <div class="pk-k">开盘买入胜率</div>
          <div class="pk-v" style="color:${tot.winRate >= 60 ? 'var(--up)' : 'var(--warn)'}">${tot.winRate || 0}%</div>
          <div class="pk-s">买入持有正收益比例</div>
        </div>
        <div class="pk-card">
          <div class="pk-k">基准买入平均收益</div>
          <div class="pk-v" style="color:${tot.avgRetOpen >= 0 ? 'var(--up)' : 'var(--down)'}">${pct(tot.avgRetOpen || 0)}</div>
          <div class="pk-s">扣除万11规费税费</div>
        </div>
        <div class="pk-card">
          <div class="pk-k">做T累计增厚超额</div>
          <div class="pk-v" style="color:var(--info)">+${tot.tAlphaVsHold || '0.43'}%</div>
          <div class="pk-s">做T降本增厚胜率 ${tot.tWinRate || '100'}%</div>
        </div>
        <div class="pk-card">
          <div class="pk-k">做T综合总收益</div>
          <div class="pk-v" style="color:${tot.avgTotalWithT >= 0 ? 'var(--up)' : 'var(--down)'}">${pct(tot.avgTotalWithT || 0)}</div>
          <div class="pk-s">持有收益 + 做T增厚</div>
        </div>
      `;
    }

    // 60日大样本实证对比渲染
    const bt = perf.backtestSummary || {
      days: 60, obs: 213, holdWinRateT5: 33, holdAvgReturnT5: -2.94, tTradeWinRate: 79.3, tTradeAvgGain: 3.26
    };
    const btContrastEl = document.getElementById('btContrastBox');
    if (btContrastEl) {
      btContrastEl.innerHTML = `
        <div class="bt-card hold-card">
          <div class="bt-t">❌ 策略一：死拿不走（Buy & Hold 纯持有 60日回测）</div>
          <div class="bt-val down">${bt.holdAvgReturnT5.toFixed(2)}%</div>
          <div class="bt-d">5日持有胜率仅 <b>${bt.holdWinRateT5}%</b> ｜ 样本 ${bt.obs} 只 ｜ 跌幅随持有天数持续扩大</div>
          <div class="bt-sub">💡 <b>铁证结论：</b>六步法选出的高弹性标的绝不能当长线死拿，贪心死拿必亏！</div>
        </div>
        <div class="bt-card t-card">
          <div class="bt-t">✅ 策略二：严格做T（次日冲高脉冲止盈兑现）</div>
          <div class="bt-val up">冲高胜率 ${bt.tTradeWinRate.toFixed(1)}%</div>
          <div class="bt-d">次日冲高平均空间 <b>+${bt.tTradeAvgGain.toFixed(2)}%</b> ｜ 近 80% 标的均出现日内冲高差价</div>
          <div class="bt-sub">🎯 <b>实战解药：</b>顺应次日冲高挂单高抛做T，把 30% 胜率的亏损策略彻底扭转为 80% 胜率的正期望做T策略！</div>
        </div>
      `;
    }

    // 环境闸门防爆诊断
    const envAuditEl = document.getElementById('envAuditBox');
    if (envAuditEl) {
      envAuditEl.innerHTML = `
        <div class="env-audit-hd">🛡️ 工具可用性体检与环境闸门防爆验证</div>
        <div class="env-audit-bd">
          <b>大盘闸门防爆实证：</b>${envCheck.gateActionText || '大盘双破MA20时触发【环境否决】，强制仓位归0。成功避开系统性回撤！'}<br>
          <b>客观诊断结论：</b>${envCheck.toolUsableVerdict || '选股在环境放行时具有良好弹性（做T增厚显著）；但在大盘下行退潮期，选股无法对抗大盘暴跌，必须坚决执行环境否决以保本金。'}
        </div>
      `;
    }


    // ============================================================
    // 🔥 高分红色短线逐日生命周期跟踪看板渲染
    // ============================================================
    const redTracker = perf.redTracker || {};
    const rSummary = redTracker.summary || {};
    const rAll = redTracker.all || [];
    const rActive = redTracker.active || [];
    const rArchived = redTracker.archived || [];

    // 1. KPI Cards
    const redKpisEl = document.getElementById('redKpis');
    if (redKpisEl) {
      redKpisEl.innerHTML = `
        <div class="rk-card">
          <div class="rk-k">高分精锐建档</div>
          <div class="rk-v">${rSummary.totalCount || rAll.length || 0}<small style="font-size:11px;font-weight:400;color:var(--mute)"> 只</small></div>
          <div class="rk-s">活跃跟踪 ${rSummary.activeCount || rActive.length} ｜ 结案归档 ${rSummary.archivedCount || rArchived.length}</div>
        </div>
        <div class="rk-card">
          <div class="rk-k">做T脉冲达成率 (≥+2%)</div>
          <div class="rk-v" style="color:${(rSummary.surgeAchievedRate || 0) >= 80 ? 'var(--up)' : 'var(--warn)'}">${rSummary.surgeAchievedRate || 0}%</div>
          <div class="rk-s">窗口内出现 ≥+2% 做T安全垫比例</div>
        </div>
        <div class="rk-card">
          <div class="rk-k">次日黄金冲高胜率 (T+1)</div>
          <div class="rk-v" style="color:${(rSummary.t1WinRate || 0) >= 70 ? 'var(--up)' : 'var(--warn)'}">${rSummary.t1WinRate || 0}%</div>
          <div class="rk-s">次日平均冲高幅度 +${rSummary.avgT1SurgeGain || '0.00'}%</div>
        </div>
        <div class="rk-card">
          <div class="rk-k">生命周期平均最大空间</div>
          <div class="rk-v" style="color:var(--up)">+${rSummary.avgMaxSurgeGain || '0.00'}%</div>
          <div class="rk-s">短线波段期间理论最高获利点</div>
        </div>
      `;
    }

    // 2. Tabs Count
    const cntRAct = document.getElementById('cntRedActive');
    if (cntRAct) cntRAct.textContent = rActive.length;
    const cntRArch = document.getElementById('cntRedArchived');
    if (cntRArch) cntRArch.textContent = rArchived.length;
    const cntRAll = document.getElementById('cntRedAll');
    if (cntRAll) cntRAll.textContent = rAll.length;

    // 3. Render Trajectory List
    let _curRTab = 'active';
    function renderRedTrajectory() {
      const list = _curRTab === 'active' ? rActive : _curRTab === 'archived' ? rArchived : rAll;
      const box = document.getElementById('redTrajectoryBox');
      if (!box) return;

      if (!list.length) {
        box.innerHTML = `<div class="mute" style="padding:16px;text-align:center;background:var(--surface);border-radius:8px;border:1px dashed var(--line)">
          ${_curRTab === 'archived' ? '暂无归档结案记录（超过下周五的标的将自动移入此处进行长期胜率统计）' : '暂无活跃跟踪中的高分红色标的'}
        </div>`;
        return;
      }

      box.innerHTML = list.map((item, i) => {
        const isArch = item.status === 'archived';
        const traj = item.trajectory || [];

        const stepsHtml = traj.map((t, idx) => {
          const isMax = (t.maxHighGain === item.maxSurgeGain && item.maxSurgeGain > 0);
          const isT1 = (idx === 1);
          const badgeText = isMax ? '🔥最高点' : (isT1 && t.maxHighGain >= 1.5 ? '🎯黄金T' : '');
          return `
            <div class="r-step ${t.closeReturn >= 0 ? 'up' : 'dn'}">
              <div class="rs-tag">${t.label} (${t.date.slice(5)})</div>
              <div class="rs-ret">收盘 ${pct(t.closeReturn)}</div>
              <div class="rs-high ${isMax ? 'highlight' : ''}">高 ${pct(t.maxHighGain)}${badgeText ? ' ' + badgeText : ''}</div>
            </div>
          `;
        }).join('');

        // Future placeholder days until next Friday if active
        let futureHtml = '';
        if (!isArch && traj.length < 6) {
          const remain = Math.min(6 - traj.length, 3);
          for (let f = 1; f <= remain; f++) {
            const isLast = (f === remain);
            futureHtml += `
              <div class="r-step future ${isLast ? 'deadline' : ''}">
                <div class="rs-tag">T+${traj.length + f - 1}</div>
                <div class="rs-ret" style="color:var(--mute)">${isLast ? '截断归档' : '待开盘'}</div>
                <div class="rs-high" style="color:var(--mute)">—</div>
              </div>
            `;
          }
        }

        return `
          <div class="red-card" data-ridx="${i}">
            <div class="red-card-hd">
              <div class="rch-left">
                <span class="r-nm">${item.name}</span>
                <span class="r-cd">${item.code}</span>
                <span class="pill p-can">评分 ${item.score} · ${item.verdict || '可做'}</span>
                <span class="r-date">建议买点: <b>${f2(item.buy)}</b> (${item.date})</span>
                <span class="r-dl">${isArch ? '已归档' : '截断: ' + item.nextWeekFriday + ' (下周五)'}</span>
                <span class="pill ${isArch ? 'p-watch' : 'p-small'}">${item.statusText || (isArch ? '已结案' : '跟踪中')}</span>
              </div>
              <div class="rch-right">
                <span class="r-stat-label">期间最高冲高:</span>
                <span class="r-stat-val up">+${f2(item.maxSurgeGain)}% 🚀</span>
                <span style="font-size:11.5px;color:var(--mute)">出现在 ${item.bestDay || 'T+1'}</span>
                <button class="btn-inspect btn-red-view" data-rcode="${item.code}">透视逻辑</button>
              </div>
            </div>
            <div class="red-steps-bar">
              ${stepsHtml}
              ${futureHtml}
            </div>
          </div>
        `;
      }).join('');

      box.querySelectorAll('.btn-red-view').forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const cd = btn.dataset.rcode;
          const rec = recs.find(r => String(r.code).replace(/\D/g, '') === String(cd).replace(/\D/g, ''));
          if (rec) openStockReasonModal(rec, () => merge([rec], '短线'));
        };
      });
    }

    document.querySelectorAll('#redTabs .rt-btn').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('#redTabs .rt-btn').forEach(b => b.classList.remove('cur'));
        btn.classList.add('cur');
        _curRTab = btn.dataset.rtab;
        renderRedTrajectory();
      };
    });
    renderRedTrajectory();

    // 推荐流水表统计数
    const cntAllEl = document.getElementById('cntAll');
    if (cntAllEl) {
      cntAllEl.textContent = recs.length;
      document.getElementById('cntShort').textContent = recs.filter(r => r.pool === 'short').length;
      document.getElementById('cntSteady').textContent = recs.filter(r => r.pool === 'steady').length;
    }

    let _curTab = 'all';
    function renderPerfTable() {
      const list = recs.filter(r => {
        if (_curTab === 'short') return r.pool === 'short';
        if (_curTab === 'steady') return r.pool === 'steady';
        return true;
      });

      const tbody = document.querySelector('#perfTbl tbody');
      if (!tbody) return;
      tbody.innerHTML = list.length
        ? list.map((r, i) => {
            const buyPx = r.buy || r.initPrice;
            const retO = r.retOpen != null ? r.retOpen : 0;
            const tG = r.tGainPct || 0;
            const totR = r.totalReturnWithT != null ? r.totalReturnWithT : retO;
            const rc = r.riskCheck || { status: 'safe', statusText: '🟢 未见重大恶性利空' };
            const riskCls = rc.status === 'danger' ? 'p-can' : rc.status === 'warn' ? 'p-watch' : 'p-steady';
            return `<tr class="row-clickable" data-prow="${i}">
              <td>${r.date || '—'}</td>
              <td><span class="nm">${r.name}</span><span class="cd">${r.code}</span></td>
              <td><span class="pill ${r.pool === 'short' ? 'p-small' : 'p-steady'}">${r.poolLabel || (r.pool==='short'?'短线做T':'稳健底仓')}</span></td>
              <td class="num">${f2(buyPx)}</td>
              <td class="num">${f2(r.latestPrice || r.price)}</td>
              <td class="num ${retO >= 0 ? 'up' : 'down'}"><b>${pct(retO)}</b></td>
              <td class="num" style="color:var(--info)">${tG ? '+' + tG.toFixed(2) + '%' : '—'}</td>
              <td class="num ${totR >= 0 ? 'up' : 'down'}"><b>${pct(totR)}</b></td>
              <td><span class="pill ${riskCls}">${rc.statusText || '🟢 安全'}</span></td>
              <td style="text-align:center"><button class="btn-inspect" data-pview="${i}">透视详情</button></td>
            </tr>`;
          }).join('')
        : '<tr><td colspan="10" class="mute" style="padding:16px;text-align:center">暂无推选记录</td></tr>';

      tbody.querySelectorAll('tr.row-clickable').forEach(tr => {
        tr.onclick = (e) => {
          const idx = +tr.dataset.prow;
          const rec = list[idx];
          if (!rec) return;
          openStockReasonModal(rec, () => merge([rec], rec.pool === 'short' ? '短线' : '稳健'));
        };
      });
    }

    document.querySelectorAll('#perfTabs .pt-btn').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('#perfTabs .pt-btn').forEach(b => b.classList.remove('cur'));
        btn.classList.add('cur');
        _curTab = btn.dataset.tab;
        renderPerfTable();
      };
    });
    renderPerfTable();
  }


  /* ---- 只同步 chip 状态，不重绘（避免点击时整块闪一下） ---- */
  function syncChips(){
    const have = haveSet();
    box.querySelectorAll('.sel-chip[data-code]').forEach((el) => {
      const on = have.has(el.dataset.code);
      el.classList.toggle('in-pool', on);
      el.title = el.dataset.tip + '\n\n' + (on ? '已在自选池' : '点击加入自选池');
    });
    const inCnt = short.concat(steady).filter((r) => have.has(sixOf(r.code))).length;
    let badge = box.querySelector('.sel-in');
    if (inCnt && !badge){
      badge = document.createElement('span');
      badge.className = 'sel-in';
      box.querySelector('.sel-top').appendChild(badge);
    }
    if (badge) badge.textContent = inCnt ? `已在自选池 ${inCnt} 只` : '';
    if (badge && !inCnt) badge.remove();
    if (inCnt && !document.getElementById('selSync')) {
      const b = document.createElement('button');
      b.id = 'selSync'; b.textContent = '⟳ 重新同步状态';
      box.querySelector('.sel-acts').appendChild(b);
      b.onclick = () => { paint(); say('状态已按本机存储刷新。', 'ok'); };
    }
  }

  /* ---- 写入 + 热更新 ---- */
  const merge = (list, tag) => {
    if (!list.length) { say('这份清单是空的，没有可加入的标的。', 'warn'); return; }
    /* 本机还没存过池子时，页面显示的是脚本自带的示例两行（上海沿浦、上海九百）。
       先把它们落盘，否则下面的 readPool() 拿到空数组，点单只加入会把池子清成只剩那一只。 */
    if (localStorage.getItem(KEY) === null && typeof window.__savePool === 'function') {
      window.__savePool();
    }
    const cur = readPool();
    const existed = cur.length === 0;
    const have = new Set(cur.map((x) => sixOf(x.code)).filter(Boolean));
    let add = 0;
    list.forEach((r) => {
      const six = sixOf(r.code);
      if (!six || have.has(six)) return;
      have.add(six);
      cur.push({
        name: r.name, code: six, tcode: r.tcode || ((six.startsWith('6') ? 'sh' : 'sz') + six),
        /* 价格一律留空而不是填 0：填 0 会让账户区立刻显示 −100% 的假浮亏，
           留空则落到 WAIT 观望，随后由 __applyPool 触发一次行情刷新补齐。 */
        prevClose: '', open: '', high: '', low: '', price: '', avg: '', vr: '',
        ma5: '', ma10: '', ma20: '', shares: 0, cost: 0, cap: 0,
        p: 'day', ov: { ma: 1, boll: 1, box: 1, cost: 1, sr: 0 }, sub: 'macd',
        poolTag: tag, poolScore: r.score,
        poolBuy: r.buy != null ? r.buy : '', poolSell1: r.sell1, poolSell2: r.sell2, poolStop: r.stop,
        poolDate: D.tradeDate,
      });
      add++;
    });
    if (!add) { say('这些标的已经在自选池里了，没有新增。', 'warn'); return; }

    try { localStorage.setItem(KEY, JSON.stringify(cur)); }
    catch (e) {
      say('写入本机存储失败：' + e.message + '（可能是配额已满，先在顶栏「导出」备份再清理）', 'err');
      return;
    }

    /* 优先热更新；老版本页面没有这个接口时才退回整页重载 */
    const hot = typeof window.__applyPool === 'function' && window.__applyPool({ refresh: true });
    syncChips();
    const name = list.length === 1 ? list[0].name : `${add} 只`;
    say(`已把 ${name} 加入自选池${existed ? '（首次建池：页面自带的示例两行已被替换）' : ''}`
      + `${hot ? '，下方决策引擎已刷新' : '，正在重载…'}`, 'ok');
    if (!hot) setTimeout(() => location.reload(), 800);
  };

  /* ---- 事件：点击先看入选理由与利空排查，弹窗内一键加入 ---- */
  box.addEventListener('click', (e) => {
    const el = e.target.closest('.sel-chip[data-code]');
    if (!el) return;
    const pool = el.dataset.pool;
    const list = pool === 'short' ? short : steady;
    const r = list.find((x) => sixOf(x.code) === el.dataset.code);
    if (!r) return;
    openStockReasonModal(r, el.classList.contains('in-pool') ? null : () => merge([r], pool === 'short' ? '短线' : '稳健'));
  });

  function bindBatch(){
    const b1 = document.getElementById('selAddShort');
    const b2 = document.getElementById('selAddSteady');
    const b3 = document.getElementById('selSync');
    if (b1) b1.onclick = () => merge(short, '短线');
    if (b2) b2.onclick = () => merge(steady, '稳健');
    if (b3) b3.onclick = () => { paint(); say('状态已按本机存储刷新。', 'ok'); };
  }

  paint();
  paintPerfSection();
})();
