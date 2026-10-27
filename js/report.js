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
    mbox.innerHTML = '<div class="rp-tw rp-tw-matrix"><table class="rp">' + head + '<tbody>' + body + '</tbody></table></div>' +
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
})(window);
