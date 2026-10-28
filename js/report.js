/* ══════════════════════════════════════════════════════════════
   report.js — 「回測報表」頁：大戶實際績效 + 策略回測績效
   ──────────────────────────────────────────────────────────────
   純靜態：直接讀 data/*.json，所有統計在瀏覽器現算。
   沒有 build step、不連外部服務、不引入圖表庫（長條圖用 div 寬度畫）。

   資料檔
     data/whale-perf.json  大戶真實權益曲線 + 30/60/180/360 天指標
     data/backtest.json    策略回測結果（檔案還沒產生時顯示「回測資料產生中」）
     data/whales.json      追蹤名單（補淨值與名單備註）

   統計規則（畫面上隨處標示，方法論面板有完整說明）
     · 有效樣本＝該視窗 ret 不是 null、且沒有 unreliable 標記
     · 極端值＝|報酬| ≥ 1000%（EXT）：研判為權益曲線異常跳動，
       排除於「平均報酬」與「分布圖」，其餘統計與排行表照實呈現
     · 平均報酬用修剪平均（排除極端值後，雙邊各去 5%），
       未修剪的原始平均放在 tooltip，避免單一極端值蓋掉整組資訊
   ══════════════════════════════════════════════════════════════ */
'use strict';
(function (w) {
  const S = w.SENTINEL = w.SENTINEL || {};
  const U = S.util;
  const FX = S.fx || {};
  const R = S.report = {};
  const doc = w.document;

  /* ══ 常數 ══════════════════════════════════════════════════ */
  const WINS = ['30', '60', '180', '360'];
  const EXT = 10;          // |報酬| ≥ 1000% → 極端值
  const TRIM = 0.05;       // 修剪平均：雙邊各去 5% 樣本
  const RELABEL = { 30: '30 天', 60: '60 天', 180: '180 天', 360: '360 天' };
  const WHY = {
    'flow_jump': '權益在相鄰取樣點之間跳動超過 3 倍（推測為入金／出金）',
    'start<1000': '視窗起點權益不足 $1,000（分母太小，報酬率不可信）',
    'start<1%max': '視窗起點權益不到期內最高權益的 1%（分母太小）',
    'end<1000': '視窗終點權益不足 $1,000',
    'median<1000': '視窗內權益中位數不足 $1,000',
    'points<2': '視窗內取樣點不足 2 點，算不出區間報酬'
  };

  /* ══ 格式化小工具 ══════════════════════════════════════════ */
  const fin = v => isFinite(U.num(v));
  const pctR = (v, d) => fin(v) ? U.pct(U.num(v) * 100, d === undefined ? 1 : d) : '—';       // 報酬率（帶正負號）
  const pctU = (v, d) => fin(v) ? U.fmt(U.num(v) * 100, d === undefined ? 1 : d) + '%' : '—';  // 比例（不帶號，例如勝率）
  const num2 = (v, d) => fin(v) ? U.fmt(U.num(v), d === undefined ? 2 : d) : '—';
  const clsOf = v => (fin(v) && U.num(v) !== 0) ? (U.num(v) > 0 ? 'up' : 'down') : '';
  const esc = s => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const shortAddr = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '—';
  const ts2str = ts => { const n = U.num(ts); if (!fin(n) || n <= 0) return '—'; const d = new Date(n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const day2str = ts => { const n = U.num(ts); if (!fin(n) || n <= 0) return '—'; const d = new Date(n); return (d.getMonth() + 1) + '/' + d.getDate(); };
  const NA = '<span class="rp-na" title="這個視窗的資料不可信，統計時已排除">—</span>';

  /* ══ 分布圖分桶 ══════════════════════════════════════════ */
  const RET_BUCKETS = [
    { lo: -Infinity, hi: -0.5, label: '≤ −50%', cls: 'down' },
    { lo: -0.5, hi: -0.2, label: '−50 ~ −20%', cls: 'down' },
    { lo: -0.2, hi: 0, label: '−20% ~ 0%', cls: 'down' },
    { lo: 0, hi: 0.2, label: '0% ~ +20%', cls: 'up' },
    { lo: 0.2, hi: 0.5, label: '+20 ~ +50%', cls: 'up' },
    { lo: 0.5, hi: 1, label: '+50 ~ +100%', cls: 'up' },
    { lo: 1, hi: 3, label: '+100 ~ +300%', cls: 'up' },
    { lo: 3, hi: Infinity, label: '≥ +300%', cls: 'up' }
  ];
  const DD_BUCKETS = [
    { lo: 0, hi: 0.1, label: '≤ 10%', cls: 'up' },
    { lo: 0.1, hi: 0.2, label: '10 ~ 20%', cls: 'up' },
    { lo: 0.2, hi: 0.35, label: '20 ~ 35%', cls: 'warn' },
    { lo: 0.35, hi: 0.5, label: '35 ~ 50%', cls: 'warn' },
    { lo: 0.5, hi: 0.7, label: '50 ~ 70%', cls: 'down' },
    { lo: 0.7, hi: Infinity, label: '≥ 70%', cls: 'down' }
  ];

  /* ══════════════════════════════════════════════════════════
     核心：純計算（不碰 DOM，可單獨用 Node 驗算）
     ══════════════════════════════════════════════════════════ */
  R.core = {
    WINS: WINS, EXT: EXT, TRIM: TRIM,
    WHY: WHY,

    /* 資料檔 → 錢包列（正規化，缺欄位不爆炸） */
    wallets(perf) {
      const src = (perf && perf.wallets) || {};
      const out = [];
      Object.keys(src).forEach(addr => {
        const v = src[addr] || {};
        const nm = v.name && String(v.name).trim() ? String(v.name).trim() : '';
        out.push({
          addr: addr,
          label: nm || shortAddr(addr),
          eq: Array.isArray(v.eq) ? v.eq : [],
          n: U.num(v.n) || (Array.isArray(v.eq) ? v.eq.length : 0),
          av: U.num(v.av),
          ts0: U.num(v.ts0) || U.num(v.t0) || 0,
          step_h: U.num(v.step_h) || 24,
          td: Array.isArray(v.td) ? v.td : null,
          m: v.m || {}
        });
      });
      out.sort((a, b) => String(a.label).localeCompare(String(b.label), 'zh-Hant'));
      return out;
    },

    /* 這個視窗的資料能不能拿來統計 */
    ok(m) { return !!m && !m.unreliable && m.ret !== null && m.ret !== undefined && fin(m.ret); },
    isExt(m) { return R.core.ok(m) && Math.abs(U.num(m.ret)) >= EXT; },

    /* 單一視窗的綜合統計 */
    winStats(list, win) {
      const good = [], ext = [], bad = [], pts = [];
      list.forEach(wl => {
        const m = wl.m[win] || {};
        if (R.core.ok(m)) {
          (R.core.isExt(m) ? ext : good).push({ w: wl, m: m });
          if (fin(m.days)) pts.push(U.num(m.days));
        } else {
          bad.push({ w: wl, m: m, why: m.why || (m.unreliable ? 'unreliable' : 'no_data') });
        }
      });
      const rets = good.map(x => U.num(x.m.ret)).sort((a, b) => a - b);
      const allRets = good.concat(ext).map(x => U.num(x.m.ret)).sort((a, b) => a - b);
      const k = Math.max(1, Math.floor(rets.length * TRIM));
      const trim = (rets.length - 2 * k >= 3) ? rets.slice(k, rets.length - k) : rets.slice();
      const pick = key => good.map(x => U.num(x.m[key])).filter(isFinite);
      const posN = rets.filter(r => r > 0).length;
      return {
        win: win, n: good.length, nExt: ext.length, nBad: bad.length, nTotal: list.length,
        median: U.median(rets), medianAll: U.median(allRets),
        meanRaw: U.mean(allRets), meanTrim: U.mean(trim), trimN: trim.length,
        posN: posN, pos: rets.length ? posN / rets.length : NaN,
        medDD: U.median(pick('dd')), medSharpe: U.median(pick('sharpe')),
        medWin: U.median(pick('win')), medVol: U.median(pick('vol')),
        ptsMed: U.median(pts), ptsMin: pts.length ? Math.min.apply(null, pts) : NaN,
        ptsMax: pts.length ? Math.max.apply(null, pts) : NaN,
        eqSum: U.sum(pick('equity')),
        retMin: rets.length ? rets[0] : NaN, retMax: rets.length ? rets[rets.length - 1] : NaN,
        rows: good, extRows: ext, badRows: bad
      };
    },

    /* 分布分桶：value(item) 取數、回傳每桶筆數 */
    bucketize(items, value, buckets) {
      const out = buckets.map(b => ({ label: b.label, cls: b.cls, n: 0 }));
      let used = 0;
      items.forEach(it => {
        const v = U.num(value(it)); if (!isFinite(v)) return;
        used++;
        for (let i = 0; i < buckets.length; i++) {
          const b = buckets[i];
          if (v >= b.lo && (i === buckets.length - 1 ? v <= b.hi : v < b.hi)) { out[i].n++; break; }
        }
      });
      const mx = Math.max(1, Math.max.apply(null, out.map(b => b.n)));
      out.forEach(b => { b.w = b.n / mx * 100; b.share = used ? b.n / used : 0; });
      return { buckets: out, used: used, max: mx };
    },

    /* 回測檔的數值單位：小數（0.35）還是百分比（35）→ 用回撤與勝率判斷
       （這兩個在兩種寫法下都不會超過 1 / 100，不會被波動率這種 >1 的欄位誤導） */
    detectScale(bt) {
      const s = [];
      ((bt && bt.strategies) || []).forEach(st => {
        const bw = (st && st.byWindow) || {};
        Object.keys(bw).forEach(k => {
          const b = bw[k] || {};
          ['dd', 'win'].forEach(f => { const v = U.num(b[f]); if (isFinite(v)) s.push(Math.abs(v)); });
        });
      });
      const med = U.median(s);
      const scale = (isFinite(med) && med > 1) ? 0.01 : 1;
      return { scale: scale, probe: med, samples: s.length };
    },

    /* 回測檔 → 策略列（欄位名稱固定，但缺欄位一律當 NaN，不補造） */
    strategies(bt) {
      const sc = R.core.detectScale(bt);
      const wins = (bt && Array.isArray(bt.windows) && bt.windows.length ? bt.windows : WINS).map(String);
      const list = ((bt && bt.strategies) || []).map(st => {
        const bw = (st && st.byWindow) || {};
        const by = {};
        wins.forEach(win => {
          const b = bw[win] || bw[String(win)] || {};
          // selected 可能是「錢包清單」也可能是「筆數」，兩種都吃
          const selList = Array.isArray(b.selected) ? b.selected.map(String) : null;
          by[win] = {
            ret: U.num(b.ret) * sc.scale, ann: U.num(b.ann) * sc.scale,
            dd: U.num(b.dd) * sc.scale, sharpe: U.num(b.sharpe),
            win: U.num(b.win) * sc.scale, vol: U.num(b.vol) * sc.scale,
            turnover: U.num(b.turnover) * sc.scale, final_mult: U.num(b.final_mult),
            days: U.num(b.days), selN: selList ? selList.length : U.num(b.selected), selList: selList
          };
        });
        return { key: String(st.key || st.name || ''), name: String(st.name || st.key || '未命名策略'), desc: String(st.desc || ''), by: by };
      });
      const best = {};
      Object.keys((bt && bt.best) || {}).forEach(k => { best[String(k)] = bt.best[k]; });
      return { scale: sc.scale, probe: sc.probe, wins: wins, list: list, best: best, universe: (bt && bt.universe) || null };
    }
  };

  /* ══════════════════════════════════════════════════════════
     畫面狀態
     ══════════════════════════════════════════════════════════ */
  const state = {
    perf: null, list: [], agg: [], bt: null, btRaw: null, whales: null, wmap: {},
    sort: '360', dir: -1, q: '', onlyRel: false, detWin: '360',
    distWin: '360', distMetric: 'ret',
    stratWin: '360', stratKey: 'ret', stratDir: -1
  };

  /* ══════════════════════════════════════════════════════════
     渲染：綜合績效
     ══════════════════════════════════════════════════════════ */
  function kpi(label, value, cls, sub, title) {
    return '<div class="kpi"' + (title ? ' title="' + esc(title) + '"' : '') + '>' +
      '<label>' + esc(label) + '</label>' +
      '<b class="' + (cls || '') + '">' + value + '</b>' +
      (sub ? '<span class="mini">' + sub + '</span>' : '') + '</div>';
  }

  function renderAgg() {
    const box = doc.getElementById('rpAggBody'); if (!box) return;
    const meta = doc.getElementById('rpAggMeta');
    const nAll = state.list.length;
    if (meta) meta.innerHTML = '樣本 <b>' + nAll + '</b> 個追蹤錢包 · 資料時間 ' + esc(ts2str(Date.parse((state.perf && state.perf.generated_at) || '') / 1));

    box.innerHTML = state.agg.map(s => {
      const head = '<div class="rp-wlabel">' +
        '<b>' + RELABEL[s.win] + '視窗</b>' +
        '<span class="mini">取樣點中位數 <b>' + num2(s.ptsMed, 0) + '</b> 點（' + num2(s.ptsMin, 0) + '~' + num2(s.ptsMax, 0) + '）</span>' +
        '<span class="mini">樣本期末權益合計 <b>' + (fin(s.eqSum) ? U.usd(s.eqSum) : '—') + '</b></span>' +
        '<span class="mini rp-wchip">有效 ' + s.n + ' · 不可信 ' + s.nBad + ' · 極端 ' + s.nExt + '</span>' +
        '</div>';
      const kpis = '<div class="kpi-grid rp-wkpi">' +
        kpi('中位數報酬', '<span data-anim="' + (fin(s.median) ? s.median : '') + '">' + pctR(s.median) + '</span>', clsOf(s.median),
          (s.n ? s.n + ' 檔的中位數' : '沒有可用樣本'),
          '中位數＝把所有可用錢包的區間報酬排序後取中間值，不受單一極端值影響。此視窗有效樣本 ' + s.n + ' 檔（共 ' + s.total + '）' + (fin(s.medianAll) && s.nExt ? '；若把 ' + s.nExt + ' 筆極端值一起算，中位數為 ' + pctR(s.medianAll) + '。' : '。')) +
        kpi('平均報酬（修剪）', '<span data-anim="' + (fin(s.meanTrim) ? s.meanTrim : '') + '">' + pctR(s.meanTrim) + '</span>', clsOf(s.meanTrim),
          s.nExt ? '已排除 ' + s.nExt + ' 筆極端值' : '無極端值需排除',
          '排除 |報酬| ≥ 1000% 的極端樣本後，雙邊各去掉 5% 再取平均（共 ' + s.trimN + ' 檔）。未修剪、含極端值的原始平均是 ' + pctR(s.meanRaw) + '，單一異常曲線就能蓋掉整組資訊，所以不放上檯面。') +
        kpi('正報酬錢包比例', pctU(s.pos), (fin(s.pos) && s.pos >= 0.5 ? 'up' : 'down'),
          s.posN + ' / ' + s.n + ' 檔為正',
          '有效樣本中有多少比例是賺的（不含已排除的不可信視窗）。') +
        kpi('中位數最大回撤', pctU(s.medDD), (fin(s.medDD) && s.medDD > 0.5 ? 'down' : ''), '以權益曲線計算') +
        kpi('中位數夏普', num2(s.medSharpe, 2), (fin(s.medSharpe) && s.medSharpe > 1 ? 'up' : ''), '年化，由相鄰取樣點換算') +
        kpi('樣本數', s.n + ' / ' + s.nTotal, s.n >= 20 ? '' : 'warn',
          s.nBad + ' 檔不可信 · ' + s.nExt + ' 檔極端',
          '這個視窗內能算出區間報酬的錢包數。被排除的原因包含：入金／出金造成權益跳動、期初權益過小、極端值。') +
        '</div>';
      return '<div class="rp-wrow">' + head + kpis + '</div>';
    }).join('');

    // 數字進場動畫（只做一次視覺提示，之後重新渲染仍會播）
    U.$$('#rpAggBody [data-anim]').forEach(el => {
      const v = U.num(el.getAttribute('data-anim'));
      if (isFinite(v)) U.animateNum(el, v, x => pctR(x), 520);
    });
  }

  /* ══ 渲染：報酬率分布 ══════════════════════════════════════ */
  function renderDist() {
    const box = doc.getElementById('rpDistBody'); if (!box) return;
    const s = state.agg.filter(x => x.win === state.distWin)[0];
    const meta = doc.getElementById('rpDistMeta');
    if (!s) { box.innerHTML = '<div class="empty">沒有資料</div>'; return; }
    const isRet = state.distMetric === 'ret';
    const items = s.rows.concat(isRet ? [] : s.extRows);   // 回撤分布：極端報酬的錢包，回撤數字本身仍可用
    const spec = R.core.bucketize(items, it => isRet ? U.num(it.m.ret) : U.num(it.m.dd), isRet ? RET_BUCKETS : DD_BUCKETS);
    if (meta) meta.innerHTML = RELABEL[state.distWin] + '視窗 · ' + (isRet ? '區間報酬率' : '最大回撤') + ' · ' + items.length + ' 檔' +
      (isRet && s.nExt ? '（另有 ' + s.nExt + ' 筆極端值未畫入）' : '');

    const rows = spec.buckets.map(b => '<div class="rp-bar-row">' +
      '<span class="rp-bl">' + esc(b.label) + '</span>' +
      '<span class="rp-btrack"><i class="rp-bfill ' + b.cls + '" style="width:' + (b.n ? Math.max(1.5, b.w) : 0).toFixed(1) + '%"></i></span>' +
      '<b class="rp-bn ' + b.cls + '">' + b.n + '</b>' +
      '<span class="mini">' + (spec.used ? (b.share * 100).toFixed(1) + '%' : '—') + '</span>' +
      '</div>').join('');

    const foot = isRet
      ? '<div class="rp-dfoot">中位數 <b class="' + clsOf(s.median) + '">' + pctR(s.median) + '</b> · ' +
        '平均（修剪）<b class="' + clsOf(s.meanTrim) + '">' + pctR(s.meanTrim) + '</b> · ' +
        '正報酬 <b>' + s.posN + ' / ' + s.n + '</b>（' + pctU(s.pos) + '） · ' +
        '區間 <b class="down">' + pctR(s.retMin) + '</b> ~ <b class="up">' + pctR(s.retMax) + '</b>' +
        '<span class="mini">排除極端值後的最差／最好</span></div>'
      : '<div class="rp-dfoot">中位數回撤 <b>' + pctU(s.medDD) + '</b> · 回撤 ≥ 50% 的錢包 <b>' +
        spec.buckets.slice(4).reduce((a, b) => a + b.n, 0) + '</b> / ' + spec.used +
        '<span class="mini">以視窗內權益曲線的峰對谷計算</span></div>';

    box.innerHTML = '<div class="rp-bars">' + rows + '</div>' + foot;
  }

  /* ══ 渲染：策略績效 ════════════════════════════════════════ */
  /* 等權買進持有（不換手）參考值：主 agent 用另一種口徑獨立算出
     （data/whale-perf.json；條件：該視窗可靠、期初權益 ≥ $1000、視窗內 ≥ 2 個取樣點）
     與上面策略表的「每期等權再平衡」不同口徑，兩者不能混著看。 */
  const BUYHOLD = { '30': 0.4220, '60': 0.2918, '180': 0.3969, '360': 0.8708 };
  const BUYHOLD_N = { '30': 49, '60': 47, '180': 31, '360': 22 };

  function renderStrategy() {
    const mbox = doc.getElementById('rpStrBody');
    const fbox = doc.getElementById('rpStrFull');
    const meta = doc.getElementById('rpStrMeta');
    if (!mbox || !fbox) return;

    if (!state.bt) {
      const msg = state.btRaw === 'error' ? '讀取 data/backtest.json 失敗' : 'data/backtest.json 還沒產生（HTTP 404）';
      if (meta) meta.innerHTML = '回測資料產生中 · ' + esc(msg);
      const ph = '<div class="rp-empty"><b>回測資料產生中</b>' +
        '<p>這一區要讀 <code>data/backtest.json</code>，目前檔案還不存在（' + esc(msg) + '）。' +
        '策略回測由另一支腳本產生，寫好之後重新整理這一頁就會自動出現，不需要改任何設定。</p>' +
        '<p class="mini">資料檔不存在時，這裡只顯示狀態、不會補造任何數字；同一頁的大戶績效與排行表仍可正常使用。</p></div>';
      mbox.innerHTML = ph;
      fbox.innerHTML = '';
      const seg = doc.getElementById('rpStrSeg');
      if (seg) seg.hidden = true;
      const fh0 = doc.getElementById('rpStrFullHead');
      if (fh0) fh0.hidden = true;
      return;
    }
    const st = R.core.strategies(state.bt);
    const seg = doc.getElementById('rpStrSeg');
    if (seg) seg.hidden = false;
    const fh = doc.getElementById('rpStrFullHead');
    if (fh) fh.hidden = false;
    if (meta) meta.innerHTML = '資料時間 ' + esc(ts2str(Date.parse(state.bt.generated_at || '') / 1)) +
      ' · 策略 <b>' + st.list.length + '</b> 組' +
      (st.universe && fin(st.universe.wallets) ? ' · 回測母體 ' + num2(st.universe.wallets, 0) + ' 個錢包' + (fin(st.universe.reliable) ? '（可靠 ' + num2(st.universe.reliable, 0) + '）' : '') : '');

    /* 對照表：列＝策略、欄＝視窗 */
    const wins = st.wins.slice();
    const head = '<thead><tr><th class="rp-thl">策略</th>' + wins.map(win => {
      const b = st.best[win];
      return '<th class="ta-r">' + (RELABEL[win] || win + ' 天') + (b ? '<span class="rp-best">★ ' + esc(b.name || b.key || '') + '</span>' : '') + '</th>';
    }).join('') + '<th class="rp-thl">方法重點</th></tr></thead>';
    const body = st.list.map(s => {
      const cells = wins.map(win => {
        const b = s.by[win] || {};
        const isBest = st.best[win] && String(st.best[win].key || st.best[win].name) === s.key;
        return '<td class="ta-r num ' + clsOf(b.ret) + (isBest ? ' rp-bcell' : '') + '"' +
          (isBest ? ' title="這個視窗報酬最好的策略"' : '') + '>' + pctR(b.ret) + '</td>';
      }).join('');
      return '<tr><td class="rp-strname"><b>' + esc(s.name) + '</b></td>' + cells +
        '<td class="rp-desc">' + esc(s.desc) + '</td></tr>';
    }).join('');
    const bhCells = wins.map(win => '<td class="ta-r num ' + clsOf(BUYHOLD[win]) + '" title="期初等權買進後不再調整（' + (BUYHOLD_N[win] || '?') + ' 個錢包有完整視窗資料）">' + pctR(BUYHOLD[win]) + '</td>').join('');
    const bhRow = '<tr class="rp-bh"><td class="rp-strname"><b>等權買進持有（不換手）</b></td>' + bhCells +
      '<td class="rp-desc" title="期初等權買進、期間不調整">對照用：同一批大戶、期初等權買進後不再換手</td></tr>';
    mbox.innerHTML = '<div class="rp-tw rp-tw-matrix"><table class="rp">' + head + '<tbody>' + body + bhRow + '</tbody></table></div>' +
      '<div class="mini rp-basis">兩種口徑：上表策略是<b>每期等權再平衡</b>（每 5~14 天一個取樣期，把資金平均分配到當時選中的錢包、逐期複利）；最後一列是<b>等權買進持有、期間不換手</b>。' +
      '同樣的大戶、同樣期間，360 天兩者差約 90 個百分點——差距來自再平衡（會賣強買弱）與可用錢包數不同（買進持有需有完整視窗資料，360 天只有 22 檔）。看策略績效請看同一列之間的高低，不要把兩列直接相減。</div>' +
      (st.scale !== 1 ? '<div class="mini rp-scale">回測檔的數值以百分比（35＝35%）記錄，畫面已統一換算成同一種寫法。</div>' : '');

    /* 該視窗的完整指標（可排序） */
    const win = state.stratWin;
    const keys = [
      { k: 'name', t: '策略', c: '' },
      { k: 'ret', t: '報酬', c: 'ta-r', h: '這個視窗的區間報酬（把資金等權分配到各期選中的錢包、逐期複利）' },
      { k: 'ann', t: '年化', c: 'ta-r', h: '區間報酬的幾何外推。回測檔把顯示上限截斷在 +2000%，短視窗的年化數字會很誇張，看區間報酬比較實在' },
      { k: 'dd', t: '最大回撤', c: 'ta-r', h: '組合權益曲線的峰對谷跌幅（以取樣點為準，可能低估區間內的極端回撤）' },
      { k: 'sharpe', t: '夏普', c: 'ta-r', h: '以實際經過天數換算日等效對數報酬後年化' },
      { k: 'win', t: '勝率', c: 'ta-r', h: '各取樣區間為正的比例' },
      { k: 'vol', t: '年化波動', c: 'ta-r', h: '日等效報酬的標準差年化' },
      { k: 'turnover', t: '換手', c: 'ta-r', h: '各次重選中「新增成員」的累計個數；買入持有策略為 0' },
      { k: 'final_mult', t: '期末倍數', c: 'ta-r', h: '期末權益 ÷ 期初權益' },
      { k: 'selN', t: '選中錢包', c: 'ta-r', h: '這個視窗最後一期持有的錢包數（滑鼠移上去看名單）' },
      { k: 'days', t: '區間天數', c: 'ta-r', h: '這個視窗的日曆天數（不是取樣點數）' }
    ];
    const th = '<thead><tr>' + keys.map(x => '<th class="' + x.c + '" data-sk="' + x.k + '" title="' +
      esc((x.h || '') + '　　點一下依這一欄排序') + '">' + x.t +
      (state.stratKey === x.k ? '<i class="rp-sarrow">' + (state.stratDir < 0 ? '▼' : '▲') + '</i>' : '') + '</th>').join('') + '</tr></thead>';
    const rows2 = st.list.map(s => ({ s: s, b: s.by[win] || {} }));
    const key = state.stratKey;
    rows2.sort((a, b) => {
      if (key === 'name') return state.stratDir * String(a.s.name).localeCompare(String(b.s.name), 'zh-Hant');
      const x = U.num(a.b[key]), y = U.num(b.b[key]);
      const xv = isFinite(x), yv = isFinite(y);
      if (!xv && !yv) return 0; if (!xv) return 1; if (!yv) return -1;
      return state.stratDir * (x - y);
    });
    const cell = (r, k) => {
      const b = r.b;
      if (k === 'name') return '<td><b>' + esc(r.s.name) + '</b></td>';
      if (k === 'selN') {
        const names = b.selList;
        const tip = names && names.length
          ? '這個視窗最後一期持有的 ' + names.length + ' 個錢包：' + names.join('、')
          : '這個視窗沒有回測檔提供的名單欄位';
        return '<td class="ta-r num" title="' + esc(tip) + '">' + (fin(b.selN) ? num2(b.selN, 0) : '—') + '</td>';
      }
      if (k === 'turnover') return '<td class="ta-r num">' + (fin(b.turnover) ? num2(b.turnover, 0) : '—') + '</td>';
      if (k === 'days') return '<td class="ta-r num">' + (fin(b.days) ? num2(b.days, 0) : '—') + '</td>';
      if (k === 'final_mult') return '<td class="ta-r num">' + num2(b.final_mult, 3) + '</td>';
      if (k === 'sharpe') return '<td class="ta-r num">' + num2(b.sharpe, 2) + '</td>';
      if (k === 'dd' || k === 'win' || k === 'vol') return '<td class="ta-r num">' + pctU(b[k]) + '</td>';
      return '<td class="ta-r num ' + clsOf(b[k]) + '">' + pctR(b[k]) + '</td>';
    };
    const tbody = rows2.map(r => '<tr>' + keys.map(x => cell(r, x.k)).join('') + '</tr>').join('');
    /* 這張表 11 欄，窄螢幕一定比版面寬：一定要包在 .rp-tw（自己的捲動容器）裡，
       否則溢出的欄位會被 panel 的 overflow:hidden 直接裁掉（字被吃掉）。 */
    fbox.innerHTML = '<div class="rp-tw rp-tw-full"><table class="rp rp-full">' + th + '<tbody>' + tbody + '</tbody></table></div>' +
      '<div class="rp-scale">年化是區間報酬的幾何外推（回測檔把顯示上限截斷在 +2000%），30／60 天視窗的年化只能當相對比較；' +
      '回撤以取樣點為準，區間內的極端回撤可能被低估。' +
      (state.bt.note ? ' 其餘方法論見下方「方法論與已知限制」的回測檔原文。' : '') + '</div>';
    const fm = doc.getElementById('rpStrFullMeta');
    if (fm) fm.innerHTML = esc(RELABEL[win]) + '視窗 · ' + st.list.length + ' 組策略 · 點欄位標題可依該欄排序（再點一次反向）';

    U.$$('#rpStrFull [data-sk]').forEach(th2 => {
      th2.addEventListener('click', () => {
        const k = th2.getAttribute('data-sk');
        if (state.stratKey === k) state.stratDir = -state.stratDir;
        else { state.stratKey = k; state.stratDir = (k === 'name') ? 1 : -1; }
        renderStrategy();
      });
    });
  }

  /* ══ 渲染：錢包績效排行 ════════════════════════════════════ */
  function valOf(wl, key) {
    const m = wl.m[state.detWin] || {};
    if (key === 'name') return wl.label;
    if (key === 'av') return wl.av;
    if (key === 'dd' || key === 'sharpe' || key === 'win' || key === 'pts') {
      if (key === 'pts') return U.num(m.days);
      return U.num(m[key]);
    }
    const mm = wl.m[key] || {};
    return U.num(mm.ret);
  }

  function viewRows() {
    const q = state.q.trim().toLowerCase();
    let rows = state.list.filter(wl => {
      if (q && wl.label.toLowerCase().indexOf(q) < 0 && wl.addr.toLowerCase().indexOf(q) < 0) return false;
      if (state.onlyRel) {
        const m = wl.m[state.detWin] || {};
        if (!R.core.ok(m) || R.core.isExt(m)) return false;
      }
      return true;
    });
    const key = state.sort, dir = state.dir;
    rows.sort((a, b) => {
      if (key === 'name') return dir * String(valOf(a, key)).localeCompare(String(valOf(b, key)), 'zh-Hant');
      const x = U.num(valOf(a, key)), y = U.num(valOf(b, key));
      const xv = isFinite(x), yv = isFinite(y);
      if (!xv && !yv) return String(a.label).localeCompare(String(b.label), 'zh-Hant');
      if (!xv) return 1; if (!yv) return -1;
      if (x === y) return String(a.label).localeCompare(String(b.label), 'zh-Hant');
      return dir * (x - y);
    });
    return rows;
  }

  function retCell(wl, win) {
    const m = wl.m[win] || {};
    if (!R.core.ok(m)) {
      const why = WHY[m.why] || (m.unreliable ? '視窗內資金變動過大，不列入統計' : '這個視窗沒有可用資料');
      return '<td class="ta-r num rp-na" title="' + esc(why) + '">' + NA + '</td>';
    }
    const v = U.num(m.ret), ex = R.core.isExt(m);
    return '<td class="ta-r num ' + (ex ? 'warn' : clsOf(v)) + '"' + (ex ? ' title="極端值：|報酬| ≥ 1000%，研判為權益曲線異常跳動；已排除於平均與分布圖，排行表照實顯示"' : '') + '>' +
      pctR(v) + (ex ? '<i class="rp-ext">⚠</i>' : '') + '</td>';
  }

  function renderWallets() {
    const box = doc.getElementById('rpWalBody'); if (!box) return;
    const rows = viewRows();
    const cnt = doc.getElementById('rpWalCount'); if (cnt) cnt.textContent = rows.length;
    const thw = doc.getElementById('rpThWin'); if (thw) thw.textContent = RELABEL[state.detWin];
    const rl = doc.getElementById('rpRelLabel'); if (rl) rl.textContent = '只看可靠資料（' + RELABEL[state.detWin] + '）';
    const hl = doc.getElementById('rpWalHead');
    if (hl) {
      const SK = { name: '名稱', av: '淨值', dd: '最大回撤（' + RELABEL[state.detWin] + '）', sharpe: '夏普（' + RELABEL[state.detWin] + '）', win: '勝率（' + RELABEL[state.detWin] + '）', pts: '取樣點數' };
      hl.innerHTML = '排序：<b>' + esc(SK[state.sort] || (RELABEL[state.sort] + '報酬')) + '</b>' + (state.dir < 0 ? ' 由高到低' : ' 由低到高') +
        ' · 篩選後 <b>' + viewRows().length + '</b> 檔';
    }

    if (!rows.length) {
      box.innerHTML = '<div class="empty">沒有符合條件的錢包——把搜尋字串清掉，或取消「只看可靠資料」。</div>';
      return;
    }
    const body = rows.map((wl, i) => {
      const m = wl.m[state.detWin] || {};
      const ok = R.core.ok(m), ex = R.core.isExt(m);
      const dd = ok ? pctU(m.dd) : '—', sh = ok ? num2(m.sharpe, 2) : '—', wn = ok ? pctU(m.win) : '—';
      const st = !ok ? '<span class="rp-tag warn" title="' + esc(WHY[m.why] || '資料不可信') + '">不可信</span>'
        : (ex ? '<span class="rp-tag bad">極端值</span>' : '<span class="rp-tag ok">可靠</span>');
      const last = wl.eq.length ? wl.eq[wl.eq.length - 1] : NaN;
      const sparkCls = clsOf(fin(m.ret) ? m.ret : (last - wl.eq[0]));
      return '<tr data-addr="' + esc(wl.addr) + '" tabindex="0" title="點一下看這個錢包的權益曲線與四個視窗的完整指標">' +
        '<td class="rp-rk">' + (i + 1) + '</td>' +
        '<td class="rp-wl"><b title="' + esc(wl.addr) + '">' + esc(wl.label) + '</b>' +
        '<span class="mini" title="' + esc(wl.addr) + '">' + esc(shortAddr(wl.addr)) + ' · ' + st + '</span></td>' +
        '<td class="ta-r num">' + (fin(wl.av) ? U.usd(wl.av) : '—') + '</td>' +
        WINS.map(win => retCell(wl, win)).join('') +
        '<td class="ta-r num">' + dd + '</td>' +
        '<td class="ta-r num">' + sh + '</td>' +
        '<td class="ta-r num">' + wn + '</td>' +
        '<td class="rp-c"><canvas class="rp-spark ' + sparkCls + '" data-addr="' + esc(wl.addr) + '" width="72" height="18" aria-hidden="true"></canvas></td>' +
        '</tr>';
    }).join('');
    box.innerHTML = '<div class="rp-tw"><table class="rp rp-rank">' +
      '<thead><tr>' +
      '<th class="rp-rk">#</th>' +
      '<th data-sk="name" title="點一下依名稱排序">錢包</th>' +
      '<th class="ta-r" data-sk="av" title="Hyperliquid 公開排行榜的帳戶淨值">淨值</th>' +
      WINS.map(win => '<th class="ta-r" data-sk="' + win + '" title="這個視窗的區間報酬（權益差分，排除入金影響）">' + RELABEL[win] + '報酬</th>').join('') +
      '<th class="ta-r" data-sk="dd" title="權益曲線最大回撤（跟隨下方指標視窗）">最大回撤<span class="rp-thw2">' + esc(RELABEL[state.detWin]) + '</span></th>' +
      '<th class="ta-r" data-sk="sharpe" title="年化夏普（跟隨下方指標視窗）">夏普</th>' +
      '<th class="ta-r" data-sk="win" title="相鄰取樣點為正的比例（跟隨下方指標視窗）">勝率</th>' +
      '<th class="rp-c" title="每個取樣點的帳戶權益（資料源原始曲線）">權益曲線</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></div>';

    // 迷你權益曲線（真實資料，非示意）
    U.$$('#rpWalBody .rp-spark').forEach(cv => {
      const wl = state.list.filter(x => x.addr === cv.getAttribute('data-addr'))[0];
      if (wl && wl.eq.length > 1) U.spark(cv, wl.eq, cv.classList.contains('up') ? '#0ecb81' : '#f6465d', true);
    });
    U.$$('#rpWalBody thead th[data-sk]').forEach(th2 => {
      th2.addEventListener('click', () => {
        const k = th2.getAttribute('data-sk');
        if (state.sort === k) state.dir = -state.dir;
        else { state.sort = k; state.dir = (k === 'name') ? 1 : -1; }
        renderWallets();
      });
    });
    U.$$('#rpWalBody tbody tr').forEach(tr => {
      tr.addEventListener('click', () => openWallet(tr.getAttribute('data-addr')));
      tr.addEventListener('keydown', e => { if (e.key === 'Enter') openWallet(tr.getAttribute('data-addr')); });
    });
  }

  /* ══ 錢包明細（彈窗：權益曲線 + 四個視窗 + 名單備註）════════ */
  function drawEquity(cv, wl) {
    const f = S.fit ? S.fit(cv) : null; if (!f) return;
    const c = f.c, W = f.w, H = f.h;
    const eq = wl.eq.map(U.num).filter(isFinite);
    c.clearRect(0, 0, W, H);
    if (eq.length < 2) { c.fillStyle = '#68717e'; c.font = '11px sans-serif'; c.fillText('沒有權益曲線', 8, H / 2); return; }
    let mn = Math.min.apply(null, eq), mx = Math.max.apply(null, eq);
    if (mn === mx) { mn -= 1; mx += 1; }
    const padL = 46, padR = 8, padT = 8, padB = 14;
    const X = i => padL + i / (eq.length - 1) * (W - padL - padR);
    const Y = v => H - padB - (v - mn) / (mx - mn) * (H - padT - padB);
    // 水平格線
    c.strokeStyle = 'rgba(255,255,255,.055)'; c.lineWidth = 1;
    [0, 0.5, 1].forEach(t => {
      const y = Math.round(padT + t * (H - padT - padB)) + .5;
      c.beginPath(); c.moveTo(padL, y); c.lineTo(W - padR, y); c.stroke();
      c.fillStyle = '#68717e'; c.font = '10px JetBrains Mono, monospace';
      c.fillText(U.money(mx - t * (mx - mn)), 4, y + 3);
    });
    // 面積 + 線
    const g = c.createLinearGradient(0, padT, 0, H);
    g.addColorStop(0, 'rgba(91,140,255,.22)'); g.addColorStop(1, 'rgba(91,140,255,0)');
    c.beginPath(); c.moveTo(X(0), Y(eq[0]));
    eq.forEach((v, i) => c.lineTo(X(i), Y(v)));
    c.lineTo(X(eq.length - 1), H - padB); c.lineTo(X(0), H - padB); c.closePath(); c.fillStyle = g; c.fill();
    c.beginPath(); c.moveTo(X(0), Y(eq[0]));
    eq.forEach((v, i) => c.lineTo(X(i), Y(v)));
    c.strokeStyle = '#5b8cff'; c.lineWidth = 1.6; c.lineJoin = 'round'; c.stroke();
    // 起訖日期
    const t0 = wl.ts0, stepMs = (wl.step_h || 24) * 3600e3;
    const tEnd = wl.td && wl.td.length ? t0 + U.num(wl.td[wl.td.length - 1]) * 86400e3 : t0 + (eq.length - 1) * stepMs;
    c.fillStyle = '#68717e';
    c.fillText(day2str(t0) + '（' + ts2str(t0) + '）', padL, H - 3);
    const tail = day2str(tEnd);
    c.fillText(tail, W - padR - c.measureText(tail).width, H - 3);
  }

  function openWallet(addr) {
    const wl = state.list.filter(x => x.addr === addr)[0];
    const ov = doc.getElementById('rpOv'), card = doc.getElementById('rpOvCard');
    if (!wl || !ov || !card) return;
    const wj = state.wmap[addr.toLowerCase()] || {};
    const kv = [
      ['淨值（排行榜）', fin(wl.av) ? U.usd(wl.av) : '—'],
      ['名稱／地址', wl.label],
      ['權益點距（中位數）', num2(wl.step_h, 0) + ' 小時'],
      ['取樣點總數', num2(wl.n, 0) + ' 點'],
      ['取樣區間', ts2str(wl.ts0) + ' 起']
    ];
    const rows = WINS.map(win => {
      const m = wl.m[win] || {};
      const ok = R.core.ok(m), ex = R.core.isExt(m);
      const tag = !ok ? '<span class="rp-tag warn">不可信</span>' : (ex ? '<span class="rp-tag bad">極端值</span>' : '<span class="rp-tag ok">可用</span>');
      return '<tr><td>' + RELABEL[win] + '</td>' +
        '<td class="ta-r num ' + (ok && !ex ? clsOf(m.ret) : 'warn') + '">' + (ok ? pctR(m.ret) : '—') + (ex ? ' <i class="rp-ext">⚠</i>' : '') + '</td>' +
        '<td class="ta-r num">' + (ok ? pctU(m.dd) : '—') + '</td>' +
        '<td class="ta-r num">' + (ok ? num2(m.sharpe, 2) : '—') + '</td>' +
        '<td class="ta-r num">' + (ok ? pctU(m.win) : '—') + '</td>' +
        '<td class="ta-r num">' + (ok ? num2(m.days, 0) + ' 點' : '—') + '</td>' +
        '<td class="ta-r num">' + (ok && fin(m.equity) ? U.usd(m.equity) : '—') + '</td>' +
        '<td>' + tag + (ok ? '' : '<span class="mini"> ' + esc(WHY[m.why] || '此視窗資料不可信') + '</span>') + '</td></tr>';
    }).join('');

    card.innerHTML =
      '<div class="rp-ov-head"><div><h3>' + esc(wl.label) + '</h3>' +
      '<div class="addr">' + esc(wl.addr) + '</div></div>' +
      '<button class="ghost" id="rpOvClose">關閉</button></div>' +
      '<div class="ov-grid">' + kv.map(x => '<div><label>' + esc(x[0]) + '</label><b>' + esc(x[1]) + '</b></div>').join('') + '</div>' +
      '<h4>權益曲線（資料源原始取樣）</h4>' +
      '<div class="rp-ovcv"><canvas id="rpOvChart"></canvas></div>' +
      '<div class="mini">' + wl.eq.length + ' 個取樣點、點距中位數約 ' + num2(wl.step_h, 0) + ' 小時（資料源是粗採樣，不是每天一點）。' +
      ' y 軸單位為美元，採用的是 Hyperliquid portfolio 的帳戶權益。</div>' +
      '<h4>四個視窗的完整指標</h4>' +
      '<div class="rp-tw"><table class="rp rp-ovt"><thead><tr><th>視窗</th><th class="ta-r">報酬</th><th class="ta-r">最大回撤</th><th class="ta-r">夏普</th><th class="ta-r">勝率</th><th class="ta-r">取樣點</th><th class="ta-r">期末權益</th><th>資料狀態</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<h4>名單背景</h4>' +
      '<p class="mini">' + (wj.why ? '名單入選理由：<b>' + esc(wj.why) + '</b>。' : '這份名單沒有備註。') +
      (fin(wj.roi30) ? ' Hyperliquid 排行榜自己的 30 天 ROI 為 <b>' + U.num(wj.roi30).toFixed(2) + '%</b>（排行榜以帳戶層級計算、含入金影響），' +
        '本頁算的是<b>權益差分</b>、排除入金，兩者不同很正常，不能互相驗證。' : '') +
      ' 名單由 GitHub Actions 每日更新。</p>' +
      '<div class="ov-actions"><button class="ghost" id="rpOvCsv">匯出這個錢包的 CSV</button></div>';

    ov.hidden = false;
    const cv = doc.getElementById('rpOvChart');
    if (cv) { drawEquity(cv, wl); w.onresize && null; }
    const closeBtn = doc.getElementById('rpOvClose');
    if (closeBtn) closeBtn.addEventListener('click', () => { ov.hidden = true; });
    const csvBtn = doc.getElementById('rpOvCsv');
    if (csvBtn) csvBtn.addEventListener('click', () => exportWallet(wl));
  }

  /* ══ CSV ═══════════════════════════════════════════════════ */
  function download(name, text) {
    const blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = doc.createElement('a');
    a.href = url; a.download = name;
    doc.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 400);
  }
  const cellPct = v => fin(v) ? (U.num(v) * 100).toFixed(2) : '';
  function exportWallet(wl) {
    const head = ['視窗', '報酬率(%)', '最大回撤(%)', '夏普', '勝率(%)', '年化波動(%)', '取樣點', '期末權益(USD)', '資料狀態'];
    const lines = [head.join(',')];
    WINS.forEach(win => {
      const m = wl.m[win] || {};
      const ok = R.core.ok(m);
      lines.push([RELABEL[win], ok ? cellPct(m.ret) : '', ok ? cellPct(m.dd) : '', ok ? m.sharpe : '',
        ok ? cellPct(m.win) : '', ok ? cellPct(m.vol) : '', ok ? m.days : '', ok ? m.equity : '',
        !ok ? '不可信：' + (WHY[m.why] || m.why || '') : (R.core.isExt(m) ? '極端值' : '可用')].join(','));
    });
    download('whale-' + wl.addr.slice(2, 10) + '.csv', lines.join('\r\n'));
  }
  function exportAll() {
    const rows = viewRows();
    const head = ['地址', '名稱', '淨值(USD)', '30天報酬(%)', '60天報酬(%)', '180天報酬(%)', '360天報酬(%)',
      '最大回撤(%)', '夏普', '勝率(%)', '取樣點', '資料狀態'];
    const lines = [head.join(',')];
    rows.forEach(wl => {
      const m = wl.m[state.detWin] || {};
      const ok = R.core.ok(m);
      lines.push([wl.addr, '"' + wl.label.replace(/"/g, '""') + '"', fin(wl.av) ? wl.av : '']
        .concat(WINS.map(win => { const mm = wl.m[win] || {}; return R.core.ok(mm) ? cellPct(mm.ret) : ''; }))
        .concat([ok ? cellPct(m.dd) : '', ok ? m.sharpe : '', ok ? cellPct(m.win) : '', ok ? m.days : '',
          !ok ? '不可信' : (R.core.isExt(m) ? '極端值' : '可用')]).join(','));
    });
    download('whale-perf-' + new Date().toISOString().slice(0, 10) + '.csv', lines.join('\r\n'));
    if (FX.toast) FX.toast({ title: '已匯出 ' + rows.length + ' 筆', text: '內容就是畫面上目前的排序與篩選結果', sev: 'low', tag: '回測報表' });
  }

  /* ══ 渲染：方法論 ══════════════════════════════════════════ */
  function renderMethod() {
    const box = doc.getElementById('rpMethodBody'); if (!box) return;
    const p = state.perf || {};
    const bt = state.bt;
    const agg = state.agg;
    const sec = (t, b) => '<div class="rp-ms"><h4>' + t + '</h4>' + b + '</div>';
    box.innerHTML =
      sec('資料來源與產出時間',
        '<ul class="rp-ul">' +
        '<li><b>大戶實際績效</b>：<code>data/whale-perf.json</code> · 產出時間 ' + esc(ts2str(Date.parse(p.generated_at || '') / 1)) +
        ' · 來源「' + esc(p.source || '—') + '」· 追蹤 ' + state.list.length + ' 個錢包。</li>' +
        '<li><b>策略回測</b>：' + (bt
          ? '<code>data/backtest.json</code> · 產出時間 ' + esc(ts2str(Date.parse(bt.generated_at || '') / 1)) +
            ' · 策略 ' + ((bt.strategies || []).length) + ' 組' +
            (bt.universe ? ' · 回測母體 ' + Object.keys(bt.universe).map(k => esc(k) + '=' + esc(bt.universe[k])).join('、') : '') + '。'
          : '<code>data/backtest.json</code> · <b>尚未產生</b>（回測資料產生中），這一頁不會補造數字。') + '</li>' +
        '<li><b>追蹤名單</b>：<code>data/whales.json</code>（淨值、名單備註）。三份資料都由 GitHub Actions 或本機腳本產生，前端只讀不算。</li>' +
        '</ul>' +
        (p.note ? '<p class="rp-quote"><b>whale-perf 產生器自己的說明（原文）：</b><br>' + esc(p.note) + '</p>' : '') +
        (bt && bt.note ? '<div class="rp-quote"><b>回測檔的方法論說明（原文；原檔以「｜」分段，這裡照樣分段、不改字）：</b>' +
          bt.note.split('｜').map(x => '<p>' + esc(x.trim()) + '</p>').join('') + '</div>' : '')) +
      sec('欄位定義',
        '<ul class="rp-ul">' +
        '<li><b>報酬（ret）</b>：視窗期末權益 ÷ 期初權益 − 1。用權益差分，已排除入金影響。</li>' +
        '<li><b>最大回撤（dd）</b>：視窗內權益曲線從高點到低點的最大跌幅（含出入金造成的淨值跳動，因為那是帳戶真實淨值）。</li>' +
        '<li><b>夏普（sharpe）</b>：把相鄰取樣點的報酬換算成「日等效報酬」後再年化，不是把相鄰兩點硬當一天。資料源是粗採樣，這個數字對取樣密度很敏感。</li>' +
        '<li><b>勝率（win）</b>：相鄰取樣點中權益上升的比例。</li>' +
        '<li><b>取樣點（days 欄位）</b>：<b>不是日曆天數</b>，是落在這個視窗內的取樣點數。資料源是 5～14 天一點的粗採樣，所以 30 天視窗常常只有 5～10 點。</li>' +
        '<li><b>unreliable</b>：視窗起點權益 &lt; $1,000 或不到期內最高權益的 1%、或相鄰取樣點權益跳動超過 3 倍（入金／出金）→ 報酬率不可信，一律當「—」並排除於統計。</li>' +
        '</ul>') +
      sec('本頁的統計規則',
        '<ul class="rp-ul">' +
        '<li><b>中位數</b>是每個視窗的主指標：把可用錢包排序取中間值，不受少數異常曲線影響。</li>' +
        '<li><b>平均報酬用修剪平均</b>：先排除 |報酬| ≥ 1000% 的極端值，再雙邊各去 5% 取平均；未修剪的原始平均只放在 tooltip。' +
        '各視窗目前的有效樣本／不可信／極端值筆數：' +
        agg.map(s => RELABEL[s.win] + ' ' + s.n + '／' + s.nBad + '／' + s.nExt).join('、') + '。</li>' +
        '<li><b>極端值</b>在排行表與明細照實顯示並標 ⚠，只是不進平均與分布圖；把資料藏起來比數字醜更糟。</li>' +
        '</ul>') +
      sec('已知限制（看數字前請先讀）',
        '<ul class="rp-ul">' +
        '<li><b>取樣粗</b>：資料源是 5～14 天一點，短視窗（30／60 天）只有 5～15 點，夏普、勝率這類以取樣點為基礎的指標會很浮動，不要當成精算結果。</li>' +
        '<li><b>未扣成本</b>：報酬沒有扣手續費、資金費率、滑價，也沒有處理稅。實際可實現報酬會低於這裡的數字。</li>' +
        '<li><b>入金與出金的殘留誤差</b>：工具已用「跳動倍數」過濾可疑視窗，但連續多次小額入金不會被標記，仍可能讓報酬率失真。</li>' +
        '<li><b>存活者偏誤</b>：名單是「目前還在排行榜上、淨值 ≥ $100M 級別」的錢包，已經賠光或離場的不在名單裡，整體績效必然偏樂觀。</li>' +
        '<li><b>權益≠交易績效</b>：帳戶權益包含未實現損益、資金費率收入與其他鏈上操作，不完全等於「這個人的交易本領」。</li>' +
        '<li><b>策略回測與大戶績效不是同一件事</b>：策略是規則化、可重複的；大戶績效是實際帳戶結果，含倉位大小與時機判斷。兩邊的報酬率不能當成「誰比較強」的排序依據，只能當作兩種做法的參考。</li>' +
        '<li><b>回測本身的限制</b>：' + (bt && bt.note ? '見上方回測檔的原文說明。' : '回測檔產生後，這裡會顯示它自己的方法論原文；在檔案出現之前，任何策略數字都不會出現在本頁。') + '</li>' +
        '</ul>') +
      sec('這一頁不會做的事',
        '<p class="rp-p">不下任何單、不接錢包、不預測價格。資料全部來自公開 API 的既有快照，頁面只做統計與視覺化，不構成投資建議。</p>');
  }

  /* ══ 空狀態：資料讀不到 ════════════════════════════════════ */
  function renderFatal(reason) {
    const msg = '<div class="rp-empty"><b>讀不到 data/whale-perf.json</b>' +
      '<p>這個頁面要讀同一站上的 JSON 檔。用 <code>file://</code> 直接開啟時，瀏覽器會擋下跨來源讀檔，所以整頁只會看到這段訊息。</p>' +
      '<p>請用 http(s) 開啟：本機可以先在專案資料夾執行 <code>python -m http.server 8788</code>，再開 ' +
      '<code>http://127.0.0.1:8788/report.html</code>；線上版 ' +
      '<a href="https://yuchen0614.github.io/crypto-sentinel/report.html">yuchen0614.github.io/crypto-sentinel/report.html</a> 直接可用。</p>' +
      '<p class="mini">原始錯誤：' + esc(String(reason || 'fetch failed')) + '</p></div>';
    ['rpAggBody', 'rpDistBody', 'rpStrBody', 'rpWalBody', 'rpMethodBody'].forEach(id => {
      const el = doc.getElementById(id); if (el) el.innerHTML = msg;
    });
    const meta = doc.getElementById('rpMeta'); if (meta) meta.textContent = '資料讀取失敗';
    const seg = doc.getElementById('rpStrSeg'); if (seg) seg.hidden = true;
    const fh = doc.getElementById('rpStrFullHead'); if (fh) fh.hidden = true;
    const fbox = doc.getElementById('rpStrFull'); if (fbox) fbox.innerHTML = '';
    const tk = doc.getElementById('statusTicker');
    if (tk) tk.innerHTML = '<span>資料讀取失敗：這個頁面需要以 http(s) 開啟（file:// 會被瀏覽器擋下讀檔）</span>';
  }

  /* ══ 全部渲染 ══════════════════════════════════════════════ */
  function renderAll() {
    state.agg = WINS.map(win => {
      const s = R.core.winStats(state.list, win);
      s.total = state.list.length;
      return s;
    });
    renderAgg();
    renderDist();
    renderStrategy();
    renderWallets();
    renderMethod();
    const meta = doc.getElementById('rpMeta');
    if (meta) meta.innerHTML = '追蹤 <b>' + state.list.length + '</b> 個大戶錢包 · 權益曲線 ' + (state.perf.source || '') +
      ' · 資料 ' + esc(ts2str(Date.parse((state.perf && state.perf.generated_at) || '') / 1)) +
      (state.bt ? ' · 回測 ' + esc(ts2str(Date.parse(state.bt.generated_at || '') / 1)) : ' · 回測資料產生中');
  }

  /* ══ 控制項 ════════════════════════════════════════════════ */
  function segWire(id, attr, fn) {
    const box = doc.getElementById(id); if (!box) return;
    box.addEventListener('click', e => {
      const b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !box.contains(b)) return;
      U.$$('#' + id + ' button').forEach(x => x.classList.toggle('on', x === b));
      fn(b.getAttribute(attr));
    });
  }

  function wire() {
    segWire('rpDistSeg', 'data-win', v => { state.distWin = v; renderDist(); });
    segWire('rpDistMetric', 'data-m', v => { state.distMetric = v; renderDist(); });
    segWire('rpStrSeg', 'data-win', v => { state.stratWin = v; renderStrategy(); });
    segWire('rpDetSeg', 'data-win', v => { state.detWin = v; renderWallets(); });
    const q = doc.getElementById('rpQ');
    if (q) q.addEventListener('input', U.debounce ? U.debounce(() => { state.q = q.value; renderWallets(); }, 180) : () => { state.q = q.value; renderWallets(); });
    const rel = doc.getElementById('rpRel');
    if (rel) rel.addEventListener('change', () => { state.onlyRel = !!rel.checked; renderWallets(); });
    const csv = doc.getElementById('rpCsv');
    if (csv) csv.addEventListener('click', exportAll);
    const ov = doc.getElementById('rpOv');
    if (ov) ov.addEventListener('click', e => { if (e.target === ov) ov.hidden = true; });
    doc.addEventListener('keydown', e => {
      if (e.key === 'Escape' && ov) ov.hidden = true;
      if (e.key === '/' && q && doc.activeElement !== q) { e.preventDefault(); q.focus(); }
    });
    let rt = 0;
    w.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => {
        const card = doc.getElementById('rpOvCard'), cv = doc.getElementById('rpOvChart');
        if (card && cv && !doc.getElementById('rpOv').hidden) {
          const wl = state.list.filter(x => x.addr === (card.querySelector('.addr') || {}).textContent)[0];
          if (wl) drawEquity(cv, wl);
        }
      }, 180);
    });
  }

  /* ══ 載入 ══════════════════════════════════════════════════ */
  function grab(path) {
    return w.fetch(path).then(r => r.ok ? r.json() : Promise.reject(new Error(path + ' → HTTP ' + r.status)));
  }

  function load() {
    const ticker = doc.getElementById('statusTicker');
    if (ticker) ticker.innerHTML = '<span>正在讀取大戶權益曲線與回測結果…</span>';
    Promise.allSettled([grab('data/whale-perf.json'), grab('data/backtest.json'), grab('data/whales.json')]).then(res => {
      const perf = res[0].status === 'fulfilled' ? res[0].value : null;
      const bt = res[1].status === 'fulfilled' ? res[1].value : null;
      state.btRaw = res[1].status === 'fulfilled' ? 'ok' : 'error';
      const wl = res[2].status === 'fulfilled' ? res[2].value : null;
      R.api.perf = perf; R.api.backtest = bt;
      if (!perf) { R.api.fatal = String(res[0].reason && res[0].reason.message || res[0].reason); renderFatal(res[0].reason && res[0].reason.message); return; }
      state.perf = perf;
      state.bt = bt;
      state.whales = wl;
      state.wmap = {};
      ((wl && wl.wallets) || []).forEach(x => { if (x && x.addr) state.wmap[String(x.addr).toLowerCase()] = x; });
      state.list = R.core.wallets(perf);
      try { renderAll(); } catch (err) {
        (S.errors = S.errors || []).push('render: ' + err.message);
        renderFatal('渲染時發生錯誤：' + err.message);
        return;
      }
      // 狀態列
      if (ticker) {
        const s360 = state.agg[3] || {}, s30 = state.agg[0] || {};
        ticker.innerHTML = '<span>大戶實際績效：30 天中位數 ' + pctR(s30.median) + '（有效 ' + (s30.n || 0) + ' 檔） · 360 天中位數 ' + pctR(s360.median) +
          '（有效 ' + (s360.n || 0) + ' 檔） · ' + (bt ? '策略回測 ' + ((bt.strategies || []).length) + ' 組已載入' : '策略回測資料產生中') + '</span>';
      }
    });
  }

  /* ══ 對外（自動化檢查用）═══════════════════════════════════ */
  R.api = {
    state: state, core: R.core, renderAll: renderAll, renderStrategy: renderStrategy,
    /* 讓自動化測試可以餵一份假回測檔驗證策略區塊，而不必真的寫 data/backtest.json */
    injectBacktest(obj) { state.bt = obj; state.btRaw = 'ok'; renderStrategy(); renderMethod(); return true; },
    status() {
      return {
        page: 'report',
        wallets: state.list.length,
        agg: state.agg.map(s => ({ win: s.win, n: s.n, nBad: s.nBad, nExt: s.nExt, median: s.median, meanTrim: s.meanTrim, pos: s.pos, medDD: s.medDD, medSharpe: s.medSharpe, ptsMed: s.ptsMed })),
        backtest: !!state.bt, strategies: state.bt ? ((state.bt.strategies || []).length) : 0,
        rows: doc.querySelectorAll('#rpWalBody tbody tr').length,
        aggKpis: doc.querySelectorAll('#rpAggBody .kpi').length,
        distBars: doc.querySelectorAll('#rpDistBody .rp-bar-row').length,
        sparks: doc.querySelectorAll('#rpWalBody .rp-spark').length,
        errors: (S.errors || []).slice(-8)
      };
    }
  };
  w.__REPORT_STATUS = R.api.status;

  /* ══ 開機（沿用站上其他頁的 SENTINEL.ready 模式）═══════════ */
  S.ready(function () {
    if (!doc.getElementById('rpRoot')) return;
    const ck = doc.getElementById('rpClock'), dt = doc.getElementById('rpDate');
    const tick = () => {
      const d = new Date();
      if (ck) ck.textContent = d.toLocaleTimeString('zh-TW', { hour12: false });
      if (dt) dt.textContent = '台北 · ' + d.toLocaleDateString('zh-TW');
    };
    tick(); setInterval(tick, 1000);
    wire();
    load();
  });

  /* ══════════════════════════════════════════════════════════════
     新增：策略報單（歷史進出場）
     ──────────────────────────────────────────────────────────────
     資料檔 data/trades.json（scripts/trades.py 產生）
       strategies[].trades[]        逐筆單，win 是字串 "30"/"60"/"180"/"360"
       strategies[].byWindow[win]   該策略該視窗的統計
                                    （n＝已出場、nOpen＝仍在倉，兩者分開）

     三個實測到的資料事實，畫面照實揭露、不美化：
       1. 每一筆單在每個符合的視窗裡各有一份複本（win 不同），所以各視窗
          的數字不能相加，同一筆單可能同時出現在 30／60／180／360。
       2. K 線歷史只抓得到約 286 天，所以「360 天」視窗實際最多 286 天；
          按鈕與備註都標實際涵蓋天數（用 byWindow.firstEntryTs／lastEntryTs）。
       3. 檔案有兩層上限：每策略每視窗 150 筆、全域 2,000 筆。byWindow 的
          統計在裁切前算好，所以統計 n 可能大於表上列出的筆數。資料檔的
          nTrimmed 欄位把仍在倉的單也算進去（會出現負值），不能直接用，
          差額一律由這裡自己算，並寫在備註列。
     ══════════════════════════════════════════════════════════════ */

  const TK_LABEL = {
    tp4: 'TP4 出場', tp3: 'TP3 出場', tp2: 'TP2 出場', tp1: 'TP1 出場',
    be: '保本出場', sl: '止損', ind: '指標出場', timeout: '逾時', open: '仍在倉'
  };
  const TK_WHY = {
    tp4: '價格觸及 TP4（4R），直接以 TP4 出場。',
    tp3: 'TP4 觸及後停損移到 TP3，被移動後的停損收掉（+3R）。',
    tp2: 'TP3 觸及後停損移到 TP2，被移動後的停損收掉（+2R）。',
    tp1: 'TP2 觸及後停損移到 TP1，被移動後的停損收掉（+1R）。',
    be: 'TP1 觸及後停損移到開倉價（保本），之後價格回到開倉價被收掉，結果是 0R。',
    sl: '從頭到尾沒碰到任何目標，被初始止損收掉（−1R）。',
    ind: 'MACD 系列在指標轉向時出場（例如柱狀體由正轉負），以那一根 4h 的收盤價出場。',
    timeout: '持有滿 30 天都沒出場，以最後一根 4h 的收盤價出場。',
    open: '資料最後一根 4h K 線收完時還在倉，出場價用的是那根的收盤價，結果 R 是未實現的浮動損益。'
  };
  const TK_MIX = ['tp4', 'tp3', 'tp2', 'tp1', 'be', 'ind', 'timeout', 'sl'];
  const TK_WINS_FB = ['30', '60', '180', '360'];
  /* 資料檔目前沒有 params／source 欄位（trades.py 內部有、沒有輸出），
     這裡照那份定義補上，讓 MACD 變體的參數、時間框、出處看得到；
     若日後資料檔自己帶了 st.params／st.source，會優先採用資料檔的。 */
  const TK_SRC = {
    brk20: { p: '20 日突破 · 1d 訊號 · 4h 出場 · 出處：本站自訂規則' },
    ma2060: { p: 'MA20 上／下穿 MA60 · 1d 訊號 · 4h 出場 · 出處：本站自訂規則' },
    rsi_pb: { p: 'RSI(14) 35／65 + MA20／MA60 趨勢過濾 · 1d 訊號 · 4h 出場 · 出處：本站自訂規則' },
    consen: { p: '10 日突破 + 共識度 ≥ 0.7 · 1d 訊號 · 4h 出場 · 出處：本站自訂規則' },
    macd_hist: {
      p: 'MACD(12,26,9) · 4h · 過濾＝收盤 > MA200(4h) · 只做多 · 指標出場＝柱狀體轉負',
      s: 'Keel Research', u: 'https://usekeel.io/strategies/macd-crossover-crypto'
    },
    macd_zero: {
      p: 'MACD(12,17,9) · 4h · 量 > MA20(量)×1.5 · RSI(14) 同向 50 之上／之下',
      s: 'SpreadAtlas', u: 'https://spreadatlas.com/indicators/macd/'
    },
    macd_ema200: {
      p: 'MACD(12,26,9) · 4h · 過濾＝EMA200(4h) 同向',
      s: 'cryptoprofitcalc（規則 D ＋教科書交叉）',
      u: 'https://cryptoprofitcalc.com/macd-strategy-for-crypto-best-settings-signals-and-backtesting-guide/'
    },
    macd_div: {
      p: '擺動點左右各 3 根 4h · MACD 線背離 · 突破前一個擺動高／低點確認 · 訊號 30 根內有效',
      s: 'cryptoprofitcalc（規則 C）',
      u: 'https://cryptoprofitcalc.com/macd-strategy-for-crypto-best-settings-signals-and-backtesting-guide/'
    }
  };

  const TKS = { d: null, err: null, list: [], wins: TK_WINS_FB.slice(), key: '', win: '360', rows: [], cov: null };
  let TKD = null;   // 目前這一組（策略＋視窗）算好的資料：byWindow、備註、KPI、出場分布

  /* ── 小工具 ─────────────────────────────────────────────── */
  const tk2 = n => (n < 10 ? '0' : '') + n;
  const tkLocal = ts => {
    const d = new Date(U.num(ts));
    return d.getFullYear() + '-' + tk2(d.getMonth() + 1) + '-' + tk2(d.getDate()) + ' ' + tk2(d.getHours()) + ':' + tk2(d.getMinutes());
  };
  const tkUTC = ts => {
    const d = new Date(U.num(ts));
    return d.getUTCFullYear() + '-' + tk2(d.getUTCMonth() + 1) + '-' + tk2(d.getUTCDate()) + ' ' + tk2(d.getUTCHours()) + ':' + tk2(d.getUTCMinutes()) + ' UTC';
  };
  /* 出場時間在資料檔裡是「那一根 4h 的最後一毫秒」（…999），顯示時 +1ms
     還原成 K 線收完的整點，才不會出現 11:59 這種看不懂的時間 */
  const tkDT = (ts, plus) => fin(ts) ? tkLocal(U.num(ts) + (plus || 0)) : '—';
  const tkDTtitle = (ts, plus) => '台北 ' + tkDT(ts, plus) + '（' + tkUTC(U.num(ts) + (plus || 0)) + '）';
  const tkR = (v, d) => fin(v) ? (U.num(v) > 0 ? '+' : U.num(v) < 0 ? '−' : '') + Math.abs(U.num(v)).toFixed(d === undefined ? 2 : d) : '—';
  const tkUsd = (v, d) => fin(v) ? (U.num(v) > 0 ? '+' : U.num(v) < 0 ? '−' : '') + '$' + U.fmt(Math.abs(U.num(v)), d === undefined ? 2 : d) : '—';
  const tkPctU = (v, d) => fin(v) ? U.fmt(U.num(v) * 100, d === undefined ? 1 : d) + '%' : '—';
  const tkFull = v => fin(v) ? String(U.num(v)) : '—';
  const tkPriceTitle = (name, v, rel) => name + ' ' + tkFull(v) + (rel ? '（' + rel + '）' : '');
  const tkReason = r => TK_LABEL[r] || ((TKS.d && TKS.d.rules && TKS.d.rules.params && TKS.d.rules.params.exitReasonLabels || {})[r]) || String(r);
  const tkTagCls = r => r === 'sl' ? 'sl' : r === 'ind' ? 'ind' : r === 'be' ? 'be' : r === 'open' ? 'open' : r === 'timeout' ? 'timeout' : 'tp';
  const tkRowCls = r => r === 'sl' ? 'rp-tk-sl' : r === 'ind' ? 'rp-tk-ind' : r === 'be' ? 'rp-tk-be' : r === 'open' ? 'rp-tk-open' : '';
  const tkDay = ts => ts2str(ts);
  const tkDays = (a, b) => Math.round((U.num(b) - U.num(a)) / 86400000);
  const tkCfg = k => {
    const p = (TKS.d && TKS.d.rules && TKS.d.rules.params) || {};
    return fin(p[k]) ? U.num(p[k]) : null;
  };
  const tkStrategy = () => TKS.list.filter(x => x.key === TKS.key)[0] || null;
  const tkBW = (st, win) => (st && st.byWindow && (st.byWindow[String(win)] || st.byWindow[win])) || null;

  /* ── 資料 → 畫面用的一次算好 ─────────────────────────────── */
  function tkBuild() {
    const st = tkStrategy();
    const b = tkBW(st, TKS.win);
    TKD = { st: st, b: b, rows: [], cov: null, covAll: [], mix: [], indN: 0, missingClosed: 0, openShown: 0, notes: [], twins: [] };
    if (!st || !b) return TKD;

    TKS.rows = (st.trades || [])
      .filter(t => String(t.win) === String(TKS.win))
      .sort((a, c) => U.num(c.entryTs) - U.num(a.entryTs));   // 新 → 舊（報單慣例）

    TKD.rows = TKS.rows;
    TKD.cov = tkCover(b);
    TKD.covAll = TKS.wins.map(w => ({ w: w, cov: tkCover(tkBW(st, w)), n: (tkBW(st, w) || {}).n, totalR: (tkBW(st, w) || {}).totalR }));
    TKD.openShown = TKS.rows.filter(t => t.exitReason === 'open').length;
    TKD.missingClosed = Math.max(0, (U.num(b.n) || 0) - (TKS.rows.length - TKD.openShown));
    TKD.mix = tkMixArr(b);
    TKD.indN = TKD.mix.filter(x => x.k === 'ind').reduce((a, x) => a + x.c, 0);
    /* 別的視窗單數與總 R 一模一樣（180／360 常見）：原因見 tkNotes */
    TKD.twins = TKS.wins.map(w => ({ w: String(w), b: tkBW(st, w) }))
      .filter(x => x.w !== String(TKS.win) && x.b && (U.num(b.n) || 0) > 0 &&
        U.num(x.b.n) === U.num(b.n) && Math.abs(U.num(x.b.totalR) - U.num(b.totalR)) < 1e-9);
    TKD.notes = tkNotes(st, b);
    return TKD;
  }
  function tkCover(b) {
    if (!b) return null;
    const a = U.num(b.firstEntryTs), z = U.num(b.lastEntryTs);
    if (!fin(a) || !fin(z) || z <= 0) return null;
    return { from: a, to: z, days: tkDays(a, z) };
  }
  /* K 線原始抓取長度與涵蓋區間（不寫死天數：資料檔怎麼寫就怎麼顯示） */
  function tkHistNote() {
    const u = (TKS.d && TKS.d.universe) || {};
    const fd = u.fetchedDays || {};
    const h = u.history || {};
    const k = Object.keys(h)[0];
    const d1 = k ? ((h[k] || {}).d1 || null) : null;
    let s = '';
    if (fin(fd.signal) || fin(fd.exit)) {
      s = 'K 線原始抓取：訊號（1d）' + (fin(fd.signal) ? U.fmt(fd.signal, 0) + ' 天' : '—') +
        '、出場（4h）' + (fin(fd.exit) ? U.fmt(fd.exit, 0) + ' 天' : '—');
    }
    if (d1 && d1.from) {
      s += (s ? '（' + esc(k) + ' 的 1d 涵蓋 ' + esc(d1.from) + ' ~ ' + esc(d1.to) + '）' : esc(k) + ' 的 1d 涵蓋 ' + esc(d1.from) + ' ~ ' + esc(d1.to));
    }
    if (s) s += '；';
    return s + '指標要暖身（MA60 要 60 根、ATR14 要 14 根）';
  }
  function tkMixArr(b) {
    const n = U.num(b.n) || 0;
    const mix = (b && b.exitMix) || {};
    let sum = 0;
    TK_MIX.forEach(k => { if (k !== 'ind') sum += U.num(mix[k]) || 0; });
    const indN = Math.max(0, n - sum);   // 資料檔的 exitMix 沒有列指標出場，用差額還原
    return TK_MIX.map(k => {
      const c = k === 'ind' ? indN : (U.num(mix[k]) || 0);
      return { k: k, c: c, share: n ? c / n : 0, label: tkReason(k) };
    }).filter(x => x.c > 0);
  }

  /* ── 備註列：把資料檔的限制講清楚 ────────────────────────── */
  function tkNotes(st, b) {
    const out = [];
    const cap = tkCfg('maxPerWindow') || 150;
    const n = U.num(b.n) || 0, nOpen = U.num(b.nOpen) || 0;

    /* 1) 實際涵蓋天數（K 線只有 ~286 天，360 天視窗不可能真的滿） */
    const covs = TKD.covAll || [];
    const line = covs.map(x => x.w + ' 天 → ' + (x.cov ? x.cov.days + ' 天' : '—')).join('　·　');
    out.push('各視窗實際涵蓋天數（' + st.name + '）：' + line +
      (TKD.cov ? '；本視窗最早 ' + tkDay(TKD.cov.from) + '、最新 ' + tkDay(TKD.cov.to) : '') +
      '。這是統計口徑裡「最早的那筆到最新的那筆」的跨度，不是視窗標籤上的天數——' + tkHistNote() + '。');
    if (TKS.rows.length) {
      const first = TKS.rows[TKS.rows.length - 1].entryTs, last = TKS.rows[0].entryTs;
      out.push('下面這張表列出的單：' + tkDay(first) + ' ~ ' + tkDay(last) + '（共 ' + TKS.rows.length + ' 筆）' +
        (TKD.missingClosed > 0 ? '，比統計口徑少的那 ' + TKD.missingClosed + ' 筆就是上面說的、比較舊的單' : '') + '。');
    }

    /* 2) 兩層檔案上限 */
    if (n >= cap) {
      out.push('<span class="warn">已達每策略每視窗 ' + cap + ' 筆上限</span>：這個視窗內的單比 ' + cap +
        ' 筆多，較舊的部分沒有列入統計與清單（這是輸出檔的大小上限，不是沒有交易）。');
    }
    if (TKD.missingClosed > 0) {
      out.push('<span class="warn">統計 ' + n + ' 筆，下面清單只有 ' + (TKS.rows.length - TKD.openShown) + ' 筆已出場</span>：差的 ' +
        TKD.missingClosed + ' 筆是最舊的單，被全域 ' + (tkCfg('maxTotal') || 2000) + ' 筆上限裁掉，統計仍含它們。');
    }
    /* 3) 某幾個視窗數字一模一樣的原因 */
    if (TKD.twins.length) {
      const t = TKD.twins[0];
      const why = (n >= cap)
        ? '兩邊都只留最近 ' + cap + ' 筆，所以數字相同'
        : ((U.num(b.lastEntryTs) - U.num(b.firstEntryTs)) / 86400000 < U.num(TKS.win)
          ? '最早的單在 ' + tkDay(b.firstEntryTs) + '（' + tkDays(b.firstEntryTs, b.lastEntryTs) + ' 天前），兩個視窗本來就抓到同一批單'
          : '兩個視窗抓到的是同一批單');
      out.push('與 ' + t.w + ' 天視窗的單數（' + n + '）與總 R（' + tkR(b.totalR) + '）完全相同：' + why + '。');
    }
    /* 4) 仍在倉 */
    if (nOpen > 0) {
      out.push('仍在倉 ' + nOpen + ' 筆：出場價用的是資料最後一根 4h 收盤價，結果 R 是未實現的浮動損益，不列入勝率、平均 R 與出場原因分布。');
    }
    /* 5) 觸及率與出場原因是兩件事 */
    out.push('「TPn 觸及」＝出場前價格真的到過第 n 個目標（用 4h 高低點判定），和「最後在哪裡出場」是兩件事：到過 TP2 的單最後可能是被移到 TP1 的停損收掉。');
    return out;
  }

  /* ── 分段鈕（策略由 JSON 動態產生，不寫死）─────────────── */
  function tkShortName(nm) {
    return String(nm || '').replace(/（[^）]*）/g, '').trim() || String(nm || '');
  }
  function tkSegHtml() {
    return TKS.list.map(s => {
      const on = s.key === TKS.key;
      return '<button type="button" data-key="' + esc(s.key) + '"' + (on ? ' class="on"' : '') +
        ' title="' + esc(tkShortName(s.name) + '：' + (s.desc || '')) + '">' + esc(tkShortName(s.name)) + '</button>';
    }).join('');
  }
  function tkWinHtml() {
    const st = tkStrategy();
    return TKS.wins.map(w => {
      const cov = tkCover(tkBW(st, w));
      const tip = '只看開倉時間落在最近 ' + w + ' 天內的單' + (cov ? '；統計口徑涵蓋 ' + cov.days + ' 天（' + tkDay(cov.from) + ' ~ ' + tkDay(cov.to) + '）' : '；這個視窗沒有單');
      return '<button type="button" data-win="' + esc(w) + '"' + (String(w) === String(TKS.win) ? ' class="on"' : '') +
        ' title="' + esc(tip) + '">' + esc(w) + ' 天</button>';
    }).join('');
  }

  /* ── 摘要條 ─────────────────────────────────────────────── */
  function tkKpiHtml(st, b) {
    const n = U.num(b.n) || 0, nOpen = U.num(b.nOpen) || 0;
    const fee = tkCfg('feePerSide'), notional = tkCfg('notionalUsd');
    const pos = (fin(b.winRate) && n) ? U.num(b.winRate) * n : NaN;
    const out = [];
    out.push(kpi('已出場單數', U.fmt(n, 0), n ? '' : 'warn',
      nOpen ? '另有 ' + U.fmt(nOpen, 0) + ' 筆仍在倉' : '視窗內沒有未平倉',
      '這一批單裡已經出場的筆數（統計都是算這一批）。仍在倉的單只列在表上，不列入勝率與平均 R。'));
    out.push(kpi('勝率', tkPctU(b.winRate), fin(b.winRate) && U.num(b.winRate) >= 0.5 ? 'up' : (n ? 'down' : ''),
      n ? (fin(pos) ? U.fmt(pos, 0) + ' / ' + n + ' 筆為正' : '—') : '沒有樣本',
      '已出場單中，扣完來回手續費後損益為正的比例（用金額判定，不是用 R）。'));
    out.push(kpi('平均 R', tkR(b.avgR, 3), clsOf(b.avgR), '每筆平均賺賠',
      '結果 R 的平均值。1R 就是開倉價到初始止損的距離：+1 代表平均每筆賺 1R、−1 代表平均賠 1R。中位數 R 是 ' + tkR(b.medR, 3) + '。'));
    out.push(kpi('總 R', tkR(b.totalR, 2), clsOf(b.totalR), n + ' 筆加總',
      '這一批單的結果 R 加總（不含仍在倉的單）。'));
    out.push(kpi('期望值 R', tkR(b.expR, 3), clsOf(b.expR), '每筆期望值',
      '期望值＝總 R ÷ 單數，和平均 R 本來就是同一個數（資料檔兩個欄位都有，這裡照原樣呈現）。'));
    out.push(kpi('中位 R', tkR(b.medR, 3), clsOf(b.medR), '一半的單比它好',
      '結果 R 的中位數，比平均 R 不容易被少數大單拉走。'));
    out.push(kpi('TP1 觸及', tkPctU(b.tp1Hit), '', '出場前到過 1R',
      '出場前價格真的到過 TP1 的比例（用 4h K 線高低點判定）。到過 TP1 但沒到 TP2 的單，會被移到開倉價的停損收掉，記成「保本出場」。'));
    out.push(kpi('TP2 觸及', tkPctU(b.tp2Hit), '', '出場前到過 2R',
      '出場前價格真的到過 TP2 的比例。到過 TP2 的單停損會移到 TP1，最後可能記成「TP1 出場」。'));
    out.push(kpi('TP3 觸及', tkPctU(b.tp3Hit), '', '出場前到過 3R',
      '出場前價格真的到過 TP3 的比例。'));
    out.push(kpi('止損比例', tkPctU(b.slHit), fin(b.slHit) && U.num(b.slHit) > 0.5 ? 'down' : '', '被初始止損收掉',
      '最後是被初始止損收掉的比例（−1R）。被移動後的停損收掉不算在這裡，那些記在保本／TP1／TP2。'));
    out.push(kpi('逾時比例', tkPctU(b.timeout), '', '持有滿 30 天出場',
      '持有滿 30 天、以最後一根 4h 收盤價出場的比例。'));
    if (fin(b.be) && U.num(b.be) > 0) {
      out.push(kpi('保本出場', tkPctU(b.be), '', '停損移到開倉價後被收掉',
        'TP1 觸及後停損移到開倉價，之後價格回到開倉價被收掉：結果 0R，只剩手續費的成本。'));
    }
    if (TKD.indN > 0) {
      out.push(kpi('指標出場', n ? tkPctU(TKD.indN / n) : '—', '', TKD.indN + ' 筆',
        'MACD 系列在指標轉向時出場（例如柱狀體由正轉負），以那一根 4h 的收盤價出場，結果 R 不固定。'));
    }
    out.push(kpi('實際損益', tkUsd(b.pnlUsd, 0), clsOf(b.pnlUsd),
      n + ' 筆 · 名目 ' + (notional ? '$' + U.fmt(notional, 0) : '$10,000') + ' × 每筆',
      '已出場單的累計損益（美元）。每筆名目 ' + (notional ? '$' + U.fmt(notional, 0) : '$10,000') +
      '，手續費吃單 ' + (fee ? (U.num(fee) * 100).toFixed(3) + '%／邊' : '0.045%／邊') +
      '（來回 ' + (fee ? (U.num(fee) * 200).toFixed(3) + '%' : '0.09%') + '）已扣在這裡面，共 ' +
      (fin(b.feeUsd) ? U.fmt(U.num(b.feeUsd), 2) : '—') + ' 美元；沒有算資金費率與滑價。' +
      '每筆平均 ' + tkUsd(b.pnlPerTrade, 0) + '。'));
    return '<div class="kpi-grid rp-wkpi" id="rpTkKpi">' + out.join('') + '</div>';
  }

  function tkMixHtml(b) {
    const n = U.num(b.n) || 0;
    if (!TKD.mix.length) return '<div class="rp-tk-mix"><span class="rp-tk-mixlab">出場原因分布</span><span class="mini">這個視窗沒有已出場的單</span></div>';
    const bars = TKD.mix.map(x => '<i class="mx-' + x.k + '" style="width:' + (x.share * 100).toFixed(3) + '%" title="' +
      esc(x.label + ' ' + x.c + ' 筆（' + (x.share * 100).toFixed(1) + '%）· ' + (TK_WHY[x.k] || '')) + '"></i>').join('');
    const leg = TKD.mix.map(x => '<span title="' + esc(x.label + '：' + (TK_WHY[x.k] || '')) + '"><i class="dot mx-' + x.k + '"></i>' +
      esc(x.label) + ' <b>' + x.c + '</b>（' + (x.share * 100).toFixed(1) + '%）</span>').join('');
    return '<div class="rp-tk-mix"><span class="rp-tk-mixlab">出場原因分布<br>（' + n + ' 筆已出場）</span>' +
      '<span class="rp-tk-mixbar">' + bars + '</span>' +
      '<span class="rp-tk-mixleg">' + leg + '</span></div>';
  }

  /* ── 主表 ──────────────────────────────────────────────── */
  function tkPriceCell(name, v, rel, cls) {
    return '<td class="rp-tkpx' + (cls || '') + '" title="' + esc(tkPriceTitle(name, v, rel)) + '">' + esc(U.px(v)) + '</td>';
  }
  function tkTableHtml(st, b) {
    const rows = TKS.rows;
    const long = t => t.side === 'long';
    const head = '<thead><tr>' +
      '<th class="rp-tkrk" title="本表列序（新到舊），不是資料檔的單號">#</th>' +
      '<th title="訊號成立那根日線的收盤時間（台北）">開倉時間<span class="rp-thw2">台北</span></th>' +
      '<th>幣種</th>' +
      '<th title="做多／做空（跟著訊號方向）">方向</th>' +
      '<th class="ta-r" title="1d 訊號成立那根的收盤價">開倉價</th>' +
      '<th class="ta-r" title="開倉價 ∓ 1.5×ATR(14)；這一欄是還沒移動過的初始止損，實際停損會跟著 TP 往上（下）移">初始止損</th>' +
      ['1', '2', '3', '4'].map(k => '<th class="ta-r" title="1R＝開倉價到初始止損的距離；TP' + k + ' ＝ ' + k + 'R">TP' + k + '<span class="rp-thw2">' + k + 'R</span></th>').join('') +
      '<th title="出場那根 4h K 線收完的時間（台北）；出場時間在資料檔裡是那一根的最後一毫秒，這裡顯示的是 K 線收完的整點">出場時間<span class="rp-thw2">台北</span></th>' +
      '<th class="ta-r" title="出場價永遠是開倉價／某個 TP／被移動後的停損／逾時那根的收盤價">出場價</th>' +
      '<th title="出場原因；滑鼠移上去看原因說明">出場原因</th>' +
      '<th class="ta-r" title="實際出場距離 ÷ 1R：TP2 出場＝+2.00、止損＝−1.00、保本＝0.00">結果 R</th>' +
      '<th class="ta-r" title="名目 $10,000 的實際損益，已扣來回手續費 0.09%">損益 $<span class="rp-thw2">名目 10K</span></th>' +
      '<th class="ta-r" title="進場到出場經過的時間">持有</th>' +
      '</tr></thead>';

    const body = rows.map((t, i) => {
      const lng = long(t), R = U.num(t.rAbs), open = t.exitReason === 'open';
      const dirCls = lng ? 'up' : 'down';
      const dir = lng ? '多' : '空';
      const rel = k => (lng ? '＝ 開倉價 + ' : '＝ 開倉價 − ') + k + 'R，1R = ' + tkFull(R);
      const cells = [
        '<td class="rp-tkrk" title="本表列序（新到舊）">' + (i + 1) + '</td>',
        '<td class="rp-tkdt" title="' + esc(tkDTtitle(t.entryTs, 0)) + '">' + esc(tkDT(t.entryTs, 0)) + '</td>',
        '<td><b>' + esc(t.coin) + '</b></td>',
        '<td class="' + dirCls + '" title="' + esc((lng ? '做多' : '做空') + '：' + (t.note || '')) + '">' + dir + '</td>',
        tkPriceCell('開倉價', t.entryPx, '訊號成立那根的 1d 收盤價', ''),
        tkPriceCell('初始止損', t.sl, '1R = ' + tkFull(R), ''),
        tkPriceCell('TP1', t.tp1, rel(1), ''),
        tkPriceCell('TP2', t.tp2, rel(2), ''),
        tkPriceCell('TP3', t.tp3, rel(3), ''),
        tkPriceCell('TP4', t.tp4, rel(4), ''),
        open
          ? '<td class="rp-tkdt rp-tk-dim" title="' + esc('還沒有出場，時間是資料最後一根 4h K 線收完的時點：' + tkDTtitle(t.exitTs, 1) + '；' + TK_WHY.open) + '">' +
            esc(tkDT(t.exitTs, 1)) + '<span class="rp-tk-tag open" style="margin-left:6px">仍在倉</span></td>'
          : '<td class="rp-tkdt" title="' + esc(tkDTtitle(t.exitTs, 1)) + '">' + esc(tkDT(t.exitTs, 1)) + '</td>',
        tkPriceCell(open ? '現價（資料最後一根 4h 收盤）' : '出場價', t.exitPx, '', ''),
        '<td><span class="rp-tk-tag ' + tkTagCls(t.exitReason) + '" title="' + esc(tkReason(t.exitReason) + '：' + (TK_WHY[t.exitReason] || '')) + '">' +
          esc(tkReason(t.exitReason)) + '</span></td>',
        '<td class="ta-r num ' + (open ? 'rp-tk-dim' : clsOf(t.rMult)) + '" title="' +
          esc(tkR(t.rMult, 4) + 'R' + (open ? '（未實現）' : '') + ' · 出場前最大有利 ' + tkR(t.mfeR, 3) + 'R、最大不利 ' + tkR(t.maeR, 3) + 'R') + '">' + tkR(t.rMult, 2) + '</td>',
        '<td class="ta-r num ' + (open ? 'rp-tk-dim' : clsOf(t.pnlUsd)) + '" title="' +
          esc('名目 ' + (tkCfg('notionalUsd') ? '$' + U.fmt(tkCfg('notionalUsd'), 0) : '$10,000') + ' × 結果 R × 1R ÷ 開倉價 − 手續費；' +
            (open ? '未實現，' : '') + '完整值 ' + tkFull(t.pnlUsd)) + '">' + tkUsd(t.pnlUsd, 2) + '</td>',
        '<td class="ta-r num" title="' + esc(U.fmt(t.holdHours, 1) + ' 小時 ＝ ' + U.fmt(U.num(t.holdHours) / 24, 1) + ' 天 ＝ ' + U.fmt(t.bars, 0) + ' 根 4h K 線') + '">' +
          esc(U.fmt(t.holdHours, 1)) + 'h</td>'
      ].join('');
      return '<tr data-i="' + i + '" class="' + tkRowCls(t.exitReason) + '" tabindex="0" title="點一下看這一筆的進場依據、TP／止損一覽與出場說明">' + cells + '</tr>';
    }).join('');

    const closedShown = rows.length - TKD.openShown;
    const cnt = '<div class="rp-tk-count">' +
      '顯示 <b>' + rows.length + '</b> 筆（新到舊）· 已出場 <b>' + closedShown + '</b> 筆 · 仍在倉 <b>' + TKD.openShown + '</b> 筆 · ' +
      '摘要的統計口徑 <b>' + U.fmt(b.n, 0) + '</b> 筆' +
      (TKD.missingClosed > 0 ? '（差額 ' + TKD.missingClosed + ' 筆見上方備註）' : '') +
      '<span>點任一列看明細 · 價格欄滑鼠移上去看完整值</span></div>';

    return '<div class="rp-tw rp-tw-tk rp-tw-full"><table class="rp rp-tk">' + head + '<tbody>' + body + '</tbody></table></div>' + cnt;
  }

  /* ── 策略資訊條（參數／時間框／出處）───────────────────── */
  function tkInfoHtml(st, b) {
    const src = TK_SRC[st.key] || {};
    const p = st.params ? String(st.params) : (src.p || '');
    const tf = st.tf ? String(st.tf) : (st.key.indexOf('macd') === 0 ? '4h' : '1d 訊號 · 4h 出場');
    const sName = (st.source && st.source.name) ? String(st.source.name) : (src.s || '');
    const sUrl = (st.source && st.source.url) ? String(st.source.url) : (src.u || '');
    const pool = Array.isArray(st.pool) ? st.pool : [];
    const sig = ['signals', 'skippedInPosition', 'skippedNoAtr', 'skippedNoKline']
      .filter(k => fin(st[k]) && U.num(st[k]) > 0)
      .map(k => ({ signals: '訊號', skippedInPosition: '持倉中略過', skippedNoAtr: '缺 ATR 略過', skippedNoKline: '無 K 線略過' }[k] + ' ' + U.fmt(st[k], 0) + ' 次'))
      .join(' · ');
    return '<div class="rp-tk-idesc"><b>' + esc(st.name) + '</b>（<code>' + esc(st.key) + '</code>）' + esc(st.desc || '') +
      '<span class="rp-tk-iparams">' + esc(p) + '｜時間框：' + esc(tf) +
      (sName ? '｜出處：' + esc(sName) : '') + '</span>' +
      '<span class="mini">母體 ' + pool.length + ' 幣' +
      (pool.length ? '（' + esc(pool.join('、')) + '）' : '') +
      (sig ? ' · ' + esc(sig) : '') +
      ' · 全部視窗的單共 ' + U.fmt((st.trades || []).length, 0) + ' 筆（同一筆可能同時出現在兩個視窗）' +
      (sUrl ? ' · <a href="' + esc(sUrl) + '" target="_blank" rel="noopener">看原始研究</a>' : '') +
      '</span></div>';
  }

  /* ── 明細彈窗 ───────────────────────────────────────────── */
  function tkLevelRows(t) {
    const R = U.num(t.rAbs), maxTp = U.num(t.maxTp) || 0;
    const lv = [
      { n: 'TP4', v: t.tp4, r: 4, hit: maxTp >= 4 },
      { n: 'TP3', v: t.tp3, r: 3, hit: maxTp >= 3 },
      { n: 'TP2', v: t.tp2, r: 2, hit: maxTp >= 2 },
      { n: 'TP1', v: t.tp1, r: 1, hit: maxTp >= 1 },
      { n: '初始止損', v: t.sl, r: -1, hit: U.num(t.maeR) <= -1 }
    ];
    const out = lv.map(x => {
      /* 距開倉的正負＝這個價位在開倉價的上面或下面（不是跟著做多／做空）；
         做多的止損在下面所以是負的，做空的止損在上面所以是正的 */
      const dPct = (fin(t.entryPx) && U.num(t.entryPx) > 0) ? (U.num(x.v) - U.num(t.entryPx)) / U.num(t.entryPx) * 100 : NaN;
      const isExit = fin(t.exitPx) && Math.abs(U.num(t.exitPx) - U.num(x.v)) < 1e-12 && tkRowCls(t.exitReason) !== 'rp-tk-open';
      return '<tr' + (isExit ? ' style="background:rgba(91,140,255,.06)"' : '') + '>' +
        '<td><b>' + esc(x.n) + '</b>' + (isExit ? ' <span class="rp-tk-tag be">實際出場</span>' : '') + '</td>' +
        '<td class="rp-tkpx" title="' + esc(tkFull(x.v)) + '">' + esc(U.px(x.v)) + '</td>' +
        '<td class="ta-r num">' + tkR(x.r, 2) + 'R</td>' +
        '<td class="ta-r num ' + clsOf(dPct) + '">' + tkR(dPct, 2) + '%</td>' +
        '<td class="' + (x.hit ? 'rp-tk-hit' : 'rp-tk-miss') + '">' + (x.hit ? (x.n === '初始止損' ? '觸及（＝被止損）' : '觸及') : '未觸及') + '</td>' +
        '<td class="mini">' + esc(x.n === '初始止損' ? '1R ＝ ' + U.px(R) + '（開倉價 ∓ 1.5×ATR14）'
          : '＝ 開倉價 ' + (t.side === 'long' ? '+' : '−') + ' ' + Math.abs(x.r) + 'R') + '</td>' +
        '</tr>';
    }).join('');
    return '<div class="rp-tw"><table class="rp rp-tk-lv"><thead><tr><th>價位</th><th class="ta-r">價格</th><th class="ta-r">R</th><th class="ta-r">距開倉</th><th>出場前是否觸及</th><th>怎麼來的</th></tr></thead><tbody>' + out + '</tbody></table></div>' +
      '<div class="mini">「出場前是否觸及」用 4h K 線的高低點判定；同一根 K 線同時觸及 TP 與止損時一律先算止損，所以「觸及 TP」不一定會以那個 TP 出場。這筆單出場前觸及的最高目標是 TP' + (maxTp || 0) + '。</div>';
  }

  function openTrade(i) {
    const t = TKS.rows[i];
    const ov = doc.getElementById('rpOv'), card = doc.getElementById('rpOvCard');
    if (!t || !ov || !card) return;
    const st = tkStrategy() || {};
    const lng = t.side === 'long', R = U.num(t.rAbs), dPct = fin(t.entryPx) && U.num(t.entryPx) > 0 ? R / U.num(t.entryPx) * 100 : NaN;
    const open = t.exitReason === 'open';
    const notional = tkCfg('notionalUsd') || 10000, fee = tkCfg('feePerSide') || 0.00045;
    const kv = [
      ['開倉時間（台北）', tkDT(t.entryTs, 0), tkDTtitle(t.entryTs, 0)],
      ['開倉價', U.px(t.entryPx) + '（完整 ' + tkFull(t.entryPx) + '）', '1d 訊號成立那根的收盤價'],
      ['初始止損', U.px(t.sl), '開倉價 ' + (lng ? '−' : '+') + ' 1.5×ATR(14)'],
      ['1R 距離', U.px(R) + '（' + U.fmt(dPct, 2) + '%）', '＝ |開倉價 − 初始止損|；TP1~4 ＝ 1R~4R'],
      ['ATR(14)（1d）', U.px(t.atr), '進場當下的 Wilder 平滑 ATR'],
      ['方向／幣種', (lng ? '做多' : '做空') + ' · ' + t.coin, ''],
      ['出場時間（台北）', open ? '仍在倉' : tkDT(t.exitTs, 1), open ? '資料最後一根 4h K 線收完時還沒出場' : tkDTtitle(t.exitTs, 1)],
      ['出場價', U.px(t.exitPx) + (open ? '（現價）' : ''), open ? '資料最後一根 4h 收盤價（未實現）' : '實際成交的價位'],
      ['出場原因', tkReason(t.exitReason), TK_WHY[t.exitReason] || ''],
      ['結果 R', tkR(t.rMult, 4) + 'R' + (open ? '（未實現）' : ''), 'TP2 出場就是 +2.00、止損 −1.00、保本 0.00'],
      ['損益（$10K 名目）', tkUsd(t.pnlUsd, 2) + (open ? '（未實現）' : ''), '名目 ' + U.fmt(notional, 0) + ' 美元、手續費吃單 ' + (U.num(fee) * 100).toFixed(3) + '%／邊（來回 ' + (U.num(fee) * 200).toFixed(3) + '%）已扣'],
      ['損益（%）', (U.num(t.pnlPct) > 0 ? '+' : '') + U.fmt(t.pnlPct, 4) + '%', '相對名目；已扣來回手續費'],
      ['持有時間', U.fmt(t.holdHours, 1) + ' 小時', U.fmt(U.num(t.holdHours) / 24, 1) + ' 天 ＝ ' + U.fmt(t.bars, 0) + ' 根 4h K 線'],
      ['出場前最大有利', tkR(t.mfeR, 3) + 'R', 'MFE：進場後最有利走到幾 R'],
      ['出場前最大不利', tkR(t.maeR, 3) + 'R', 'MAE：進場後最不利走到幾 R'],
      ['觸及的最高目標', 'TP' + (U.num(t.maxTp) || 0), '0 ＝ 連 TP1 都沒碰到']
    ];
    const hit = U.num(t.maxTp) || 0;
    const after = hit > 0
      ? '出場前價格到過 TP' + hit + '（最大有利 ' + tkR(t.mfeR, 3) + 'R）。'
      : '出場前價格連 TP1（1R）都沒碰到（最大有利 ' + tkR(t.mfeR, 3) + 'R）。';

    card.innerHTML =
      '<div class="rp-ov-head"><div><h3>' + esc(t.coin + ' ' + (lng ? '做多' : '做空') + ' · ' + (st.name || '')) + '</h3>' +
      '<div class="addr">' + esc(String(t.id || '')) + '　資料檔單號（是該視窗內的序號，視窗不同會不一樣）</div></div>' +
      '<button class="ghost" id="rpOvClose">關閉</button></div>' +
      '<div class="ov-grid">' + kv.map(x => '<div' + (x[2] ? ' title="' + esc(x[2]) + '"' : '') + '><label>' + esc(x[0]) + '</label><b>' + esc(x[1]) + '</b></div>').join('') + '</div>' +
      '<h4>TP／止損一覽（1R ＝ ' + esc(U.px(R)) + '）</h4>' + tkLevelRows(t) +
      '<h4>進場依據</h4>' +
      '<div class="rp-tk-note">' + esc(t.note || '（這一筆沒有進場說明的欄位）') + '</div>' +
      '<h4>出場說明</h4>' +
      '<p class="rp-tk-why">' + esc(TK_WHY[t.exitReason] || '') + '</p>' +
      '<p class="rp-tk-why">' + esc(after) + '出場價 ' + U.px(t.exitPx) + '、實際出場距離 ' +
      tkR(t.rMult, 4) + 'R（1R ＝ ' + U.px(R) + '），扣掉來回手續費後損益 ' + tkUsd(t.pnlUsd, 2) + '。' +
      (U.num(t.holdHours) >= 24 * 30 - 1 ? ' 持有時間已經貼近 30 天上限。' : '') + '</p>' +
      '<div class="ov-actions"><button class="ghost" id="rpTkCsvOne">匯出這一筆 CSV</button>' +
      '<button class="ghost" id="rpOvClose2">關閉</button></div>';

    ov.hidden = false;
    const c1 = doc.getElementById('rpOvClose'), c2 = doc.getElementById('rpOvClose2');
    if (c1) c1.addEventListener('click', () => { ov.hidden = true; });
    if (c2) c2.addEventListener('click', () => { ov.hidden = true; });
    const one = doc.getElementById('rpTkCsvOne');
    if (one) one.addEventListener('click', () => exportTrade(t, i + 1, st));
  }

  /* ── 渲染全部 ───────────────────────────────────────────── */
  function renderTk() {
    const bodyBox = doc.getElementById('rpTkBody');
    if (!bodyBox) return;
    const seg = doc.getElementById('rpTkSeg'), win = doc.getElementById('rpTkWin');
    const info = doc.getElementById('rpTkInfo'), sum = doc.getElementById('rpTkSum');
    const meta = doc.getElementById('rpTkMeta'), csv = doc.getElementById('rpTkCsv');

    /* 資料檔不在：只顯示狀態，不造任何數字 */
    if (!TKS.d) {
      const why = TKS.err ? esc(TKS.err) : 'data/trades.json 還沒產生';
      if (seg) seg.innerHTML = '';
      if (win) win.innerHTML = '';
      if (info) { info.innerHTML = ''; info.hidden = true; }
      if (sum) sum.innerHTML = '';
      if (csv) csv.disabled = true;
      if (meta) meta.innerHTML = '報單資料產生中 · 讀不到 <code>data/trades.json</code>';
      bodyBox.innerHTML = '<div class="rp-empty"><b>報單資料產生中</b>' +
        '<p>這一區要讀 <code>data/trades.json</code>，目前還沒拿到（' + why + '）。逐筆報單由 ' +
        '<code>scripts/trades.py</code> 用 Hyperliquid 的真實 K 線產生（每週由 GitHub Actions 跑一次），跑完之後重新整理這一頁就會出現，不需要改任何設定。</p>' +
        '<p class="mini">資料檔不在時，這裡只顯示狀態、不會補造任何價格或績效；上面的策略回測與下面的錢包排行不受影響。</p></div>';
      return;
    }

    if (!TKS.list.length) {
      if (meta) meta.textContent = '報單檔裡沒有任何策略';
      bodyBox.innerHTML = '<div class="rp-empty"><b>報單檔裡沒有策略</b><p><code>data/trades.json</code> 讀到了，但 <code>strategies</code> 是空的。這不是前端可以修的問題，請確認產生器的輸出。</p></div>';
      return;
    }
    if (csv) csv.disabled = false;
    tkBuild();
    const st = TKD.st, b = TKD.b;
    if (seg) seg.innerHTML = tkSegHtml();
    if (win) win.innerHTML = tkWinHtml();
    if (info) { info.hidden = false; info.innerHTML = tkInfoHtml(st, b); }

    const u = TKS.d.universe || {};
    if (meta) meta.innerHTML = '資料時間 ' + esc(ts2str(Date.parse(TKS.d.generated_at || '') / 1)) +
      ' · 真實 K 線重算 · 母體 ' + (Array.isArray(u.coins) ? u.coins.length : '—') + ' 幣 · 策略 <b>' + TKS.list.length + '</b> 組 · ' +
      '全部逐筆 <b>' + U.fmt(TKS.list.reduce((a, s) => a + (s.trades || []).length, 0), 0) + '</b> 筆（同一筆可能算在多個視窗裡）';

    if (!b) {
      if (sum) sum.innerHTML = '';
      bodyBox.innerHTML = '<div class="empty" style="padding:14px">這個組合（' + esc(st.name) + ' · ' + esc(TKS.win) + ' 天）沒有統計資料。</div>';
      return;
    }
    if (sum) sum.innerHTML = '<div class="rp-tk-sum">' + tkKpiHtml(st, b) + tkMixHtml(b) +
      '<div class="rp-tk-notes">' + TKD.notes.map(x => '<span>' + x + '</span>').join('') + '</div></div>';
    bodyBox.innerHTML = TKS.rows.length
      ? tkTableHtml(st, b)
      : '<div class="empty" style="padding:14px">這個組合目前沒有可列出的單（統計 n ＝ ' + U.fmt(b.n, 0) + '）。</div>';
  }

  /* ── CSV ───────────────────────────────────────────────── */
  const tkCell = v => {
    const s = String(v === null || v === undefined ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  function tkCsvHead() {
    return ['策略', '視窗(天)', '列序', '資料檔單號', '開倉時間(台北)', '開倉時間(UTC)', '幣種', '方向',
      '開倉價', '初始止損', 'TP1', 'TP2', 'TP3', 'TP4', '1R距離', 'ATR14(1d)', '出場時間(台北)', '出場時間(UTC)',
      '出場價', '出場原因', '仍在倉', '結果R', '損益USD', '損益pct', '持有小時', '4hK線數',
      '出場前最大有利R', '出場前最大不利R', '出場前觸及最高目標', '進場依據'];
  }
  function tkCsvLine(t, st, i) {
    const open = t.exitReason === 'open';
    return [st.name || '', TKS.win, i, t.id || '',
      tkDT(t.entryTs, 0), tkUTC(t.entryTs), t.coin, t.side === 'long' ? '多' : '空',
      t.entryPx, t.sl, t.tp1, t.tp2, t.tp3, t.tp4, t.rAbs, t.atr,
      tkDT(t.exitTs, 1), tkUTC(U.num(t.exitTs) + 1), t.exitPx,
      tkReason(t.exitReason), open ? '是' : '否',
      t.rMult, t.pnlUsd, t.pnlPct, t.holdHours, t.bars, t.mfeR, t.maeR, t.maxTp || 0, t.note || ''
    ].map(tkCell).join(',');
  }
  function exportTrades() {
    const st = tkStrategy();
    if (!st || !TKS.rows.length) return;
    const lines = [tkCsvHead().map(tkCell).join(',')];
    TKS.rows.forEach((t, i) => lines.push(tkCsvLine(t, st, i + 1)));
    download('trades-' + st.key + '-' + TKS.win + 'd-' + new Date().toISOString().slice(0, 10) + '.csv', lines.join('\r\n'));
    if (FX.toast) FX.toast({ title: '已匯出 ' + TKS.rows.length + ' 筆報單', text: st.name + ' · ' + TKS.win + ' 天視窗（價格是完整未進位值）', sev: 'low', tag: '策略報單' });
  }
  function exportTrade(t, i, st) {
    const lines = [tkCsvHead().map(tkCell).join(','), tkCsvLine(t, st, i)];
    download('trade-' + (st.key || 'x') + '-' + t.coin + '-' + String(t.entryTs) + '.csv', lines.join('\r\n'));
  }

  /* ── 控制項與載入 ───────────────────────────────────────── */
  function wireTk() {
    segWire('rpTkSeg', 'data-key', v => { TKS.key = v; renderTk(); });
    segWire('rpTkWin', 'data-win', v => { TKS.win = v; renderTk(); });
    const csv = doc.getElementById('rpTkCsv');
    if (csv) csv.addEventListener('click', exportTrades);
    const body = doc.getElementById('rpTkBody');
    if (body) {
      body.addEventListener('click', e => {
        const tr = e.target.closest ? e.target.closest('tr[data-i]') : null;
        if (tr) openTrade(U.num(tr.getAttribute('data-i')));
      });
      body.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const tr = e.target.closest ? e.target.closest('tr[data-i]') : null;
        if (tr) { e.preventDefault(); openTrade(U.num(tr.getAttribute('data-i'))); }
      });
    }
  }

  function loadTrades() {
    const meta = doc.getElementById('rpTkMeta');
    if (meta) meta.textContent = '正在讀取逐筆報單…';
    w.fetch('data/trades.json').then(r => {
      if (!r.ok) throw new Error('data/trades.json → HTTP ' + r.status);
      return r.json();
    }).then(d => {
      TKS.d = d; TKS.err = null;
      TKS.list = ((d && d.strategies) || []).slice().sort((a, b) => (U.num(a.order) || 0) - (U.num(b.order) || 0));
      const w2 = (d && d.universe && Array.isArray(d.universe.windows) && d.universe.windows.length)
        ? d.universe.windows.map(String) : TK_WINS_FB.slice();
      TKS.wins = w2;
      TKS.key = TKS.list.filter(s => s.key === TKS.key).length ? TKS.key : (TKS.list[0] || {}).key || '';
      TKS.win = TKS.wins.indexOf(String(TKS.win)) >= 0 ? String(TKS.win) : String(TKS.wins[TKS.wins.length - 1]);
      renderTk();
    }).catch(e => {
      /* 讀不到就照實說，不造數字 */
      TKS.d = null; TKS.err = String((e && e.message) || e); TKS.list = [];
      renderTk();
    });
  }

  /* ── 對外（自動化檢查用）────────────────────────────────── */
  R.api.tk = {
    state: TKS,
    status() {
      return {
        loaded: !!TKS.d,
        error: TKS.err,
        strategies: TKS.list.length,
        coins: (TKS.d && TKS.d.universe && TKS.d.universe.coins) || [],
        windows: TKS.wins,
        key: TKS.key, win: TKS.win,
        segButtons: doc.querySelectorAll('#rpTkSeg button').length,
        winButtons: doc.querySelectorAll('#rpTkWin button').length,
        kpis: doc.querySelectorAll('#rpTkKpi .kpi').length,
        tableRows: doc.querySelectorAll('#rpTkBody tbody tr').length,
        statN: TKD && TKD.b ? TKD.b.n : null,
        statOpen: TKD && TKD.b ? TKD.b.nOpen : null,
        openShown: TKD ? TKD.openShown : null,
        missingClosed: TKD ? TKD.missingClosed : null,
        mix: TKD ? TKD.mix : [],
        coverage: TKD ? TKD.cov : null,
        coverageAll: TKD ? TKD.covAll.map(x => ({ w: x.w, days: x.cov ? x.cov.days : null })) : []
      };
    },
    build: TKS,
    render: renderTk, reload: loadTrades, open: openTrade, exportCsv: exportTrades,
    csvHead: tkCsvHead,
    csvLines() { const st = tkStrategy(); return TKS.rows.map((t, i) => tkCsvLine(t, st, i + 1)); },
    bar(text) {
      const lines = [tkCsvHead().map(tkCell).join(','), text];
      download('trades-test.csv', lines.join('\r\n'));
    }
  };
  w.__TRADES_STATUS = () => R.api.tk.status();

  S.ready(function () {
    if (!doc.getElementById('rpTkPanel')) return;
    wireTk();
    loadTrades();
  });
})(window);
