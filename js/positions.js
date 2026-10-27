/* positions.js — 「持倉方向總覽」＋「倉位異動分析」＋「大戶實際績效」
   ─────────────────────────────────────────────────────────────
   三個資料來源：
     1. OC.hl.states —— js/onchain.js 正在輪詢的追蹤錢包 clearinghouseState（即時、每次載入重新取得）
     2. data/positions-daily.json 與 data/positions-YYYY-MM-DD.json
        —— scripts/snapshot_positions.py 每天 00:10 UTC 由 GitHub Actions 寫入（可長期累積）
     3. data/whale-perf.json —— 52 個大戶錢包的真實權益曲線與 30/60/180/360 天報酬（每日更新）

   這一頁已經沒有跟單模擬：不再計算、也不顯示任何「若跟單」的損益。
   js/signals.js 的模擬邏輯保留給其他頁面使用，這裡只讀它的帳本（大戶真實已實現盈虧）。

   所有即時異動都是「這台裝置前後兩次快照的差分」：只在你開著這一頁時觀察得到，
   重新整理就重新累積；要長期累積請看每日快照（data/positions-*.json）。
*/
(function (w) {
  'use strict';
  const S = w.SENTINEL, U = S.util, OC = S.onchain;
  const P = S.positions = {
    minDelta: 25000,     // 即時異動門檻：這一筆交易的名目 ≥ 此值才記錄
    minRel: 0.02,        // 持倉數量變化比例 ≥ 此值才算加倉／減倉（避免報價跳動雜訊）
    minOpen: 25000,      // 新開倉／平倉的名目門檻
    maxEvents: 120,
    sort: 'size',        // size 規模 | net 淨部位 | crowd 擁擠度 | cons 共識度
    openMin: 250000,     // 即時持倉清單的顯示門檻（名目）
    events: [], prev: new Map(), polls: 0, primed: 0,
    daily: null, snaps: null, perf: null, rank: null, sig: '', lastPaint: 0, note: ''
  };

  /* ── 小工具 ───────────────────────────────────────────── */
  const $ = id => document.getElementById(id);
  /* 金額與百分比一律自己組正負號。
     注意：U.signed(v, fmt) 會把 fmt 收到的「帶號值」交給 fmt，若 fmt 內再取絕對值，
     負數的負號就會被吃掉（畫面會出現「負的卻沒有減號」）。 */
  const m2 = v => { const n = U.num(v); return isFinite(n) ? ((n > 0 ? '+' : n < 0 ? '−' : '') + '$' + U.money(Math.abs(n))) : '—'; };
  const sp = (v, d) => { const n = U.num(v); return isFinite(n) ? ((n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(d === undefined ? 1 : d) + '%') : '—'; };
  const usd = v => '$' + U.money(v);
  const pc = (v, d) => isFinite(v) ? (v * 100).toFixed(d === undefined ? 1 : d) + '%' : '—';
  const cls = v => !isFinite(v) || v === 0 ? '' : (v > 0 ? 'up' : 'down');
  const time = ts => new Date(ts).toLocaleTimeString('zh-TW', { hour12: false });
  const dayTxt = d => String(d || '').replace(/-/g, '/').slice(5);
  const nm = addr => { const m = OC.hl.wallets.find(x => x.addr === addr); return (m && m.name) || OC.short(addr); };
  const addrOf = addr => { const m = OC.hl.wallets.find(x => x.addr === addr); return (m && m.name) ? OC.short(addr) : ''; };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sgn = (side, notional) => (side === 'long' ? 1 : -1) * Math.abs(notional || 0);   // 帶正負號的名目
  const sideTxt = side => side === 'long' ? '多' : '空';
  /* 這一頁最下面那條狀態列由 signalsboot.js 輪播，這裡不搶它；
     這一頁自己的即時狀態寫在「倉位異動分析」標題列（#psStatus）。 */
  const status = msg => { const e = $('psStatus'); if (e) e.textContent = msg; };
  const empty = n => '<div class="empty">' + n + '</div>';

  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  /* ══════════ 1. 持倉方向總覽 ══════════
     Σ多／Σ空名目、多空比、每個幣的共識度（幾個錢包同向）與擁擠度（前 3 大占比）。 */
  P.coinStats = function () {
    const by = new Map();
    let longUsd = 0, shortUsd = 0, nw = 0, positions = 0, states = 0, upnl = 0, value = 0;
    const ratios = [];
    OC.hl.states.forEach((s, addr) => {
      states++;
      if (!s || !s.pos || !s.pos.length) return;
      nw++;
      value += s.value || 0; upnl += s.upnl || 0;
      let wl = 0, ws = 0;
      s.pos.forEach(p => {
        positions++;
        const u = Math.abs(p.notional || 0);
        if (p.side === 'long') { longUsd += u; wl += u; } else { shortUsd += u; ws += u; }
        let c = by.get(p.coin);
        if (!c) { c = { coin: p.coin, long: 0, short: 0, lw: 0, sw: 0, levSum: 0, levN: 0, sizes: [] }; by.set(p.coin, c); }
        if (p.side === 'long') { c.long += u; c.lw++; } else { c.short += u; c.sw++; }
        if (isFinite(p.lev)) { c.levSum += p.lev; c.levN++; }
        c.sizes.push({ addr: addr, usd: u, side: p.side });
      });
      if (wl + ws > 0) ratios.push(wl / (wl + ws));
    });

    const coins = [];
    by.forEach(c => {
      const total = c.long + c.short, holders = c.lw + c.sw;
      const top3 = c.sizes.slice().sort((a, b) => b.usd - a.usd).slice(0, 3);
      const cons = holders ? Math.max(c.lw, c.sw) / holders : NaN;
      const lead = c.lw === c.sw ? 'flat' : (c.lw > c.sw ? 'long' : 'short');
      /* 共識標籤：≥75% 同向＝共識，60~75%＝偏一邊，其餘＝分歧 */
      let tag = '分歧', tcls = 'neu';
      if (isFinite(cons) && holders >= 2) {
        if (lead === 'flat') { tag = '分歧'; tcls = 'neu'; }
        else if (cons >= 0.75) { tag = sideTxt(lead) + '共識'; tcls = lead === 'long' ? 'up' : 'down'; }
        else if (cons >= 0.6) { tag = '偏' + sideTxt(lead); tcls = lead === 'long' ? 'up' : 'down'; }
      }
      coins.push({
        coin: c.coin, long: c.long, short: c.short, total: total, net: c.long - c.short,
        lw: c.lw, sw: c.sw, holders: holders, consensus: cons, crowding: total > 0 ? top3.reduce((a, x) => a + x.usd, 0) / total : NaN,
        avgLev: c.levN ? c.levSum / c.levN : NaN, tag: tag, tcls: tcls, lead: lead, top3: top3
      });
    });
    coins.sort((a, b) => b.total - a.total);
    const medRatio = U.median(ratios);
    return {
      coins: coins, longUsd: longUsd, shortUsd: shortUsd, net: longUsd - shortUsd, total: longUsd + shortUsd,
      ratio: (longUsd + shortUsd) ? longUsd / (longUsd + shortUsd) : NaN,
      medRatio: medRatio, wallets: nw, positions: positions, states: states, upnl: upnl, value: value,
      listTotal: OC.hl.wallets.length
    };
  };

  /* 共識度最高／最擁擠的幣（要求有一定規模與持有者，否則單一錢包就 100% 沒有意義） */
  const notable = (coins, key, dir) => {
    const list = coins.filter(c => c.total >= 5e6 && c.holders >= 4 && isFinite(c[key]));
    if (!list.length) return null;
    list.sort((a, b) => dir * (b[key] - a[key]));
    return list[0];
  };

  P.dirKpi = function (st0) {
    const box = $('psDirKpi'); if (!box) return;
    const st = st0 || P.coinStats();
    const cons = notable(st.coins, 'consensus', 1);
    const crowd = notable(st.coins, 'crowding', 1);
    const bigNet = st.coins.filter(c => c.total >= 5e6).slice().sort((a, b) => b.net - a.net);
    const top = bigNet[0], bottom = bigNet[bigNet.length - 1];
    const tiles = [
      { label: 'Σ多單名目', b: usd(st.longUsd), sub: st.coins.filter(c => c.lw > 0).length + ' 個幣有多方持倉', cls: 'up',
        title: '所有追蹤錢包的多單名目合計（美元）。名目＝持倉數量 × 標記價，不是保證金。' },
      { label: 'Σ空單名目', b: usd(st.shortUsd), sub: st.coins.filter(c => c.sw > 0).length + ' 個幣有空方持倉', cls: 'down',
        title: '所有追蹤錢包的空單名目合計（美元）。' },
      { label: '多空比（名目加權）', b: isFinite(st.ratio) ? pc(st.ratio, 1) + ' / ' + pc(1 - st.ratio, 1) : '—',
        sub: '錢包等權中位數 ' + (isFinite(st.medRatio) ? pc(st.medRatio, 0) : '—'),
        title: '多單名目 ÷（多＋空）名目。名目加權會被少數超大型帳戶主導，所以副標同時給「每個錢包各自多空比的中位數」（等權，52 檔不受規模影響）。' },
      { label: '淨部位', b: m2(st.net), sub: 'Σ多 − Σ空', cls: cls(st.net),
        title: '多單名目減空單名目。負值＝整體偏空（空方名目較大）。' },
      { label: '共識度最高', b: cons ? cons.coin : '—',
        sub: cons ? ('多 ' + cons.lw + ' / 空 ' + cons.sw + ' · 同向 ' + pc(cons.consensus, 0)) : '規模不足',
        cls: cons ? (cons.lead === 'long' ? 'up' : 'down') : '',
        title: '在總名目 ≥ $5M 且 ≥ 4 個錢包持有的幣裡，同向錢包占比最高的那個。共識度＝同向錢包數 ÷ 持有該幣的錢包數。' },
      { label: '最擁擠', b: crowd ? crowd.coin : '—', sub: crowd ? ('前 3 大占 ' + pc(crowd.crowding, 0)) : '規模不足',
        cls: '', title: '該幣前 3 大持倉名目占該幣總持倉的比例。越高代表少數幾檔決定這個幣的多空。' },
      { label: '淨多最強 / 淨空最強', b: top ? top.coin + ' / ' + (bottom ? bottom.coin : '—') : '—',
        sub: top ? (m2(top.net) + ' / ' + m2(bottom.net)) : '—',
        title: '總名目 ≥ $5M 的幣裡，淨名目最大（偏多）與最小（偏空）的兩個幣。' },
      { label: '掃描進度', b: st.states + ' / ' + (st.listTotal || '—'),
        sub: '有持倉的錢包 ' + st.wallets + ' 檔 · 倉位 ' + st.positions + ' 個',
        title: '已取得 clearinghouseState 的錢包數。這一頁與鏈上頁共用輪詢：每 6 秒 4 個錢包，52 檔約 80 秒跑完一輪，剛開啟時數字會逐步補齊。' }
    ];
    box.innerHTML = tiles.map(t => '<div class="kpi' + (t.cls ? ' ' + t.cls : '') + '" title="' + esc(t.title) + '">'
      + '<label>' + esc(t.label) + '</label><b class="' + (t.cls || '') + '">' + esc(t.b) + '</b>'
      + '<span class="mini">' + esc(t.sub) + '</span></div>').join('');
    const meta = $('psDirMeta');
    if (meta) meta.textContent = '即時輪詢 ' + (st.listTotal || 0) + ' 個大戶錢包 · 共 ' + st.positions + ' 個倉位 · 名目合計 ' + usd(st.total);
    return st;
  };

  P.coinTable = function (st0) {
    const body = $('psCoinBody'); if (!body) return null;
    const st = st0 || P.coinStats();
    const list = st.coins.filter(c => c.total > 0);
    /* dir = 1 表示由大到小（key[1] * (y - x)：y 比 x 大就排前面） */
    const key = { size: ['total', 1], net: ['net', 1], crowd: ['crowding', 1], cons: ['consensus', 1] }[P.sort] || ['total', 1];
    list.sort((a, b) => {
      const x = a[key[0]], y = b[key[0]];
      if (!isFinite(x) && !isFinite(y)) return 0;
      if (!isFinite(x)) return 1;          // 算不出來的排最後
      if (!isFinite(y)) return -1;
      return key[1] * (y - x);
    });
    const meta = $('psCoinMeta');
    if (meta) meta.textContent = list.length + ' 個幣 · ' + (P.sort === 'size' ? '依總名目' : P.sort === 'net' ? '依淨名目' : P.sort === 'crowd' ? '依擁擠度' : '依共識度');
    if (!list.length) {
      body.innerHTML = '<tr><td colspan="7" class="empty">還沒取得任何持倉（輪詢中，約 80 秒跑完一輪）</td></tr>';
      return st;
    }
    body.innerHTML = list.slice(0, 60).map(c => {
      const top3 = c.top3.map(t => nm(t.addr) + ' ' + usd(t.usd)).join('｜');
      const thin = c.holders <= 3;      // 只有少數幾檔時，擁擠度必然接近 100%，標成灰字
      return '<tr title="' + esc('多 ' + c.lw + ' 檔 / 空 ' + c.sw + ' 檔 · 多單 ' + usd(c.long) + '、空單 ' + usd(c.short)
        + '；前 3 大：' + (top3 || '—') + '（占 ' + pc(c.crowding, 0) + '）') + '">'
        + '<td><b>' + esc(c.coin) + '</b></td>'
        + '<td title="' + esc('同向錢包 ' + Math.max(c.lw, c.sw) + ' ÷ 持有 ' + c.holders + ' = ' + pc(c.consensus, 0)) + '">'
        + '<span class="sgtag ' + c.tcls + '">' + esc(c.tag) + '</span>'
        + '<span class="mini"> 多 ' + c.lw + ' · 空 ' + c.sw + '</span></td>'
        + '<td class="ta-r ' + cls(c.net) + '" title="Σ多 − Σ空 名目">' + m2(c.net) + '</td>'
        + '<td class="ta-r" title="多單＋空單名目">' + usd(c.total) + '</td>'
        + '<td class="ta-r" title="持有多方的錢包 ' + c.lw + ' 檔、持有空方的 ' + c.sw + ' 檔">' + c.holders + ' <span class="mini">(' + c.lw + '/' + c.sw + ')</span></td>'
        + '<td class="ta-r' + (thin ? ' mini' : '') + '" title="' + esc('該幣前 3 大持倉 ' + pc(c.crowding, 0)
          + '，其餘 ' + (c.holders - Math.min(3, c.holders)) + ' 檔分剩下的 ' + pc(1 - c.crowding, 0)
          + (thin ? '。只有 ' + c.holders + ' 檔持倉，前 3 大等於全部，這個數字沒有區別力' : '')) + '">'
        + '<span class="ps-crowd"><i style="width:' + Math.max(2, Math.min(100, (c.crowding || 0) * 100)).toFixed(0) + '%"></i></span> ' + pc(c.crowding, 0) + '</td>'
        + '<td class="ta-r mini">' + (isFinite(c.avgLev) ? c.avgLev.toFixed(1) + '×' : '—') + '</td>'
        + '</tr>';
    }).join('');
    return st;
  };

  /* 加權淨部位排行：前 10 淨多、後 10 淨空（div 寬度自畫橫條） */
  P.rankBars = function (st0) {
    const up = $('psRankUp'), dn = $('psRankDown'); if (!up || !dn) return;
    const list = (st0 || P.coinStats()).coins.filter(c => c.total >= 1e6);
    if (!list.length) { up.innerHTML = empty('輪詢中…'); dn.innerHTML = empty('輪詢中…'); return; }
    const sorted = list.slice().sort((a, b) => b.net - a.net);
    const hi = sorted.slice(0, 10), lo = sorted.slice(-10).reverse();
    /* 兩個清單各自用自己的最大值當基準：名目加權下 BTC/ETH 的淨空名目可能是其他幣的上百倍，
       共用一個基準會讓「淨多前 10」的橫條全部變成看不見的小點（實際踩過）。 */
    const draw = (el, arr) => {
      const max = Math.max.apply(null, [1].concat(arr.map(c => Math.abs(c.net))));
      el.innerHTML = arr.map((c, i) => {
        const w = Math.max(2, Math.abs(c.net) / max * 100);
        return '<div class="ps-bar" title="' + esc(c.coin + '：淨 ' + m2(c.net) + '（多 ' + usd(c.long) + '、空 ' + usd(c.short) + '）· 多 ' + c.lw + ' 檔 / 空 ' + c.sw + ' 檔') + '">'
          + '<span class="rk">' + (i + 1) + '</span><span class="cc">' + esc(c.coin) + '</span>'
          + '<span class="bb"><i class="' + (c.net >= 0 ? 'up' : 'down') + '" style="width:' + w.toFixed(1) + '%"></i></span>'
          + '<span class="vv ' + cls(c.net) + '">' + m2(c.net) + '</span></div>';
      }).join('');
    };
    draw(up, hi);
    draw(dn, lo);
  };

  /* ══════════ 2. 倉位異動分析 ══════════
     2a. 即時事件：這台裝置前後兩次 clearinghouseState 快照的差分 */
  const KIND = { OPEN: '新開倉', ADD: '加倉', CUT: '減倉', CLOSE: '平倉', FLIP: '翻倉' };

  P.push = function (e) {
    P.events.unshift(e);
    if (P.events.length > P.maxEvents) P.events.pop();
    S.emit('ps-event', e);
  };

  P.diff = function (addr, s) {
    const cur = new Map();
    (s.pos || []).forEach(p => cur.set(p.coin, { coin: p.coin, szi: p.szi, side: p.side, usd: Math.abs(p.notional || 0), entry: p.entry, lev: p.lev }));
    const prev = P.prev.get(addr);
    P.prev.set(addr, cur);
    P.polls++;
    const name = nm(addr);
    if (!prev) { P.primed += cur.size; return; }      // 第一次看到：載入時既有持倉，不算異動
    const now = Date.now();

    cur.forEach((p, coin) => {
      const q = prev.get(coin);
      if (!q) {
        if (p.usd >= P.minOpen) P.push({
          ts: now, addr, name, coin, kind: 'OPEN', side: p.side, usd: p.usd, traded: p.usd, szi0: 0, szi1: p.szi,
          text: '新開' + sideTxt(p.side) + '單 ' + usd(p.usd) + ' · 進場 ' + U.px(p.entry) + (isFinite(p.lev) ? ' · ' + p.lev + '×' : '')
        });
        return;
      }
      const flipped = (q.szi > 0) !== (p.szi > 0);
      const dszi = p.szi - q.szi;
      const rel = Math.abs(dszi) / Math.max(1e-12, Math.abs(q.szi));
      const unit = Math.abs(p.szi) > 0 ? p.usd / Math.abs(p.szi) : 0;   // 這個幣的每單位名目
      const traded = Math.abs(dszi) * unit;                             // 這一段變動對應的交易名目
      if (flipped) {
        P.push({
          ts: now, addr, name, coin, kind: 'FLIP', side: p.side, from: q.side, usd: p.usd, traded: traded, szi0: q.szi, szi1: p.szi,
          text: '由' + sideTxt(q.side) + '翻' + sideTxt(p.side) + '：' + U.qty(Math.abs(q.szi)) + ' → ' + U.qty(Math.abs(p.szi)) + ' ' + coin + ' · 名目 ' + usd(p.usd)
        });
      } else if (rel >= P.minRel && traded >= P.minDelta) {
        const add = Math.abs(p.szi) > Math.abs(q.szi);
        P.push({
          ts: now, addr, name, coin, kind: add ? 'ADD' : 'CUT', side: p.side, usd: p.usd, traded: traded, szi0: q.szi, szi1: p.szi,
          text: (add ? '加倉 ' : '減倉 ') + usd(traded) + ' · ' + U.qty(Math.abs(q.szi)) + ' → ' + U.qty(Math.abs(p.szi)) + ' ' + coin
            + ' · 目前名目 ' + usd(p.usd) + '（' + (add ? '+' : '−') + pc(traded / Math.max(1, q.usd), 0) + '）'
        });
      }
    });
    prev.forEach((q, coin) => {
      if (cur.has(coin) || q.usd < P.minOpen) return;
      P.push({
        ts: now, addr, name, coin, kind: 'CLOSE', side: q.side, usd: 0, closed: q.usd, traded: q.usd, szi0: q.szi, szi1: 0,
        text: '平倉：原本' + sideTxt(q.side) + '單 ' + usd(q.usd) + ' 已出場'
      });
    });
  };

  P.diffFeed = function () {
    const box = $('psDiff'); if (!box) return;
    const meta = $('psDiffMeta');
    if (meta) meta.textContent = P.events.length + ' 筆 · 已比對 ' + P.polls + ' 次快照' + (P.primed ? ' · 載入時既有倉位 ' + P.primed + ' 個' : '');
    if (!P.events.length) {
      box.innerHTML = empty('等第一批倉位變化…（載入時的既有持倉不算異動，需要再一輪輪詢才有差分）');
      return;
    }
    const key = P.events.slice(0, 6).map(e => e.ts + e.kind + e.coin).join(',') + '|' + P.events.length;
    if (box.__k === key) return;
    box.__k = key;
    box.innerHTML = P.events.slice(0, 70).map(e => '<div class="pse k-' + e.kind + '" data-addr="' + esc(e.addr) + '" title="' + esc(e.text) + '">'
      + '<span class="t">' + time(e.ts) + '</span>'
      + '<span class="k">' + KIND[e.kind] + '</span>'
      + '<span class="w">' + esc(e.name) + (addrOf(e.addr) ? '<span class="mini">' + esc(addrOf(e.addr)) + '</span>' : '') + '</span>'
      + '<span class="c"><b>' + esc(e.coin) + '</b> <span class="sidechip ' + e.side + '">' + sideTxt(e.side) + '</span></span>'
      + '<span class="d">' + esc(e.text) + '</span></div>').join('');
  };

  /* 2b. 異動排行：最新兩份每日快照的差分（錢包 × 幣種） */
  P.computeRank = function (latest, prev) {
    const out = { add: [], cut: [], bad: [], days: [latest && latest.date, prev && prev.date] };
    if (!latest || !latest.wallets) return out;
    const pv = (prev && prev.wallets) || {};
    const rows = [];
    Object.keys(latest.wallets).forEach(addr => {
      const L = latest.wallets[addr], R = pv[addr];
      const cur = new Map(), old = new Map();
      (L.pos || []).forEach(p => cur.set(p.coin, p));
      ((R && R.pos) || []).forEach(p => old.set(p.coin, p));
      const coins = new Set([].concat(Array.from(cur.keys()), Array.from(old.keys())));
      coins.forEach(coin => {
        const a = cur.get(coin), b = old.get(coin);
        const to = a ? sgn(a.side, a.usd) : 0, from = b ? sgn(b.side, b.usd) : 0;
        const d = to - from;
        if (Math.abs(d) < 1e3) return;              // 低於 $1K 不列（多半是報價跳動）
        let kind = '加倉';
        if (!b) kind = '新開倉';
        else if (!a) kind = '平倉';
        else if (a.side !== b.side) kind = '翻倉';
        else if (Math.abs(a.szi) < Math.abs(b.szi)) kind = '減倉';
        rows.push({
          addr: addr, name: L.name || (b && b.name) || nm(addr), coin: coin, d: d, from: from, to: to,
          toSide: a ? a.side : null, fromSide: b ? b.side : null, kind: kind,
          szi0: b ? b.szi : 0, szi1: a ? a.szi : 0
        });
      });
    });
    rows.sort((x, y) => y.d - x.d);
    out.add = rows.filter(r => r.d > 0).slice(0, 12);
    out.cut = rows.filter(r => r.d < 0).slice(-12).reverse();
    out.all = rows;
    return out;
  };

  P.rankBars2 = function () {
    const add = $('psAddList'), cut = $('psCutList');
    if (!add || !cut) return;
    const r = P.rank, meta = $('psChangeMeta');
    if (!r || !r.add) { add.innerHTML = empty('等快照載入…'); cut.innerHTML = empty('等快照載入…'); return; }
    if (meta) meta.textContent = (r.days[1] ? ('比對 ' + dayTxt(r.days[1]) + ' → ' + dayTxt(r.days[0]) + '（每日快照）') : '只有一份快照，明天才有差分');
    if (!r.days[1]) {
      const msg = '只有一份每日快照（' + dayTxt(r.days[0]) + '），要等明天 00:10 UTC 的第二份才能算 24 小時異動。';
      add.innerHTML = empty(msg); cut.innerHTML = empty(msg);
      return;
    }
    /* 兩個排行也是各自用清單最大值當基準（增倉與減倉的金額級距常常差一個數量級） */
    const draw = (el, arr, emptyMsg) => {
      if (!arr.length) { el.innerHTML = empty(emptyMsg); return; }
      const max = Math.max.apply(null, [1].concat(arr.map(x => Math.abs(x.d))));
      el.innerHTML = arr.slice(0, 8).map((x, i) => '<div class="ps-bar" title="' + esc(x.name + '：' + x.kind + ' ' + x.coin + '，淨名目 ' + m2(x.d)
        + '（' + (x.fromSide ? sideTxt(x.fromSide) + ' ' + usd(Math.abs(x.from)) : '無倉位') + ' → ' + (x.toSide ? sideTxt(x.toSide) + ' ' + usd(Math.abs(x.to)) : '已平倉') + '）') + '">'
        + '<span class="rk">' + (i + 1) + '</span>'
        + '<span class="cc">' + esc(x.coin) + '</span>'
        + '<span class="ww">' + esc(x.name) + '</span>'
        + '<span class="bb"><i class="' + (x.d >= 0 ? 'up' : 'down') + '" style="width:' + Math.max(2, Math.abs(x.d) / max * 100).toFixed(1) + '%"></i></span>'
        + '<span class="vv ' + cls(x.d) + '">' + m2(x.d) + '</span></div>').join('');
    };
    draw(add, r.add, '這 24 小時沒有淨增倉');
    draw(cut, r.cut, '這 24 小時沒有淨減倉');
  };

  /* 2c. 累積異動史：已累積幾天 + 每個錢包的每日淨部位趨勢 */
  P.histPanel = function () {
    const box = $('psHist'), meta = $('psHistMeta');
    if (!box) return;
    const d = P.daily;
    if (!d || !d.days || !d.days.length) {
      if (meta) meta.textContent = '今天開始累積';
      box.innerHTML = empty('今天開始累積：這個站還沒有伺服器端的部位快照。'
        + '<br>scripts/snapshot_positions.py 每天 00:10 UTC 由 GitHub Actions 執行一次，寫入 data/positions-YYYY-MM-DD.json 與 data/positions-daily.json。');
      return;
    }
    const days = d.days, n = days.length;
    const wallets = d.wallets || {};
    const rows = Object.keys(wallets).map(addr => {
      const w = wallets[addr], netArr = (w.net_usd || []).filter(v => v != null);
      const cur = netArr.length ? netArr[netArr.length - 1] : NaN;
      const prev = netArr.length > 1 ? netArr[netArr.length - 2] : NaN;
      const chg = (isFinite(cur) && isFinite(prev)) ? cur - prev : NaN;
      const peak = netArr.length ? Math.max.apply(null, netArr.map(Math.abs)) : 0;
      return { addr: addr, name: w.name || nm(addr), cur: cur, chg: chg, arr: netArr, peak: peak, n: netArr.length };
    }).filter(x => isFinite(x.cur));
    const movers = rows.slice().sort((a, b) => Math.abs((b.chg || 0)) - Math.abs((a.chg || 0)));
    const shown = (n > 1 ? movers.filter(x => isFinite(x.chg)) : movers).slice(0, 14);
    if (meta) meta.textContent = '已累積 ' + n + ' 天（' + dayTxt(days[0]) + ' → ' + dayTxt(days[n - 1]) + '）· ' + rows.length + ' 個錢包有部位';
    if (!shown.length) { box.innerHTML = empty('快照裡還沒有任何錢包部位。'); return; }
    const p1 = (n > 1 ? '' : ' p1');
    const head = '<div class="ps-hrow hd' + p1 + '"><span>錢包</span><span class="ta-r">目前淨名目</span>'
      + (n > 1 ? '<span class="ta-r">最近一日變動</span>' : '') + '<span class="mid">' + n + ' 天走勢</span></div>';
    box.innerHTML = head + shown.map(x => {
      const bars = x.arr.slice(-14).map((v, i, a) => {
        const mx = Math.max.apply(null, a.map(Math.abs)) || 1;
        const h = Math.max(8, Math.abs(v) / mx * 100);
        return '<i class="' + (v >= 0 ? 'up' : 'down') + '" style="height:' + h.toFixed(0) + '%" title="'
          + esc(dayTxt(days[Math.max(0, n - a.length + i)]) + ' ' + m2(v)) + '"></i>';
      }).join('');
      return '<div class="ps-hrow' + p1 + '" title="' + esc(x.name + '：每日總淨名目（Σ多 − Σ空）· 目前 ' + m2(x.cur)) + '">'
        + '<span class="nm">' + esc(x.name) + '<span class="mini">' + n + ' 天有 ' + x.n + ' 筆資料</span></span>'
        + '<span class="ta-r ' + cls(x.cur) + '">' + m2(x.cur) + '</span>'
        + (n > 1 ? '<span class="ta-r ' + cls(x.chg) + '">' + (isFinite(x.chg) ? m2(x.chg) : '—') + '</span>' : '')
        + '<span class="mid"><span class="ps-spark">' + bars + '</span></span></div>';
    }).join('');
  };

  P.loadDaily = async function () {
    const add = $('psAddList'), cut = $('psCutList');
    let d = null;
    try { d = await getJSON('data/positions-daily.json'); }
    catch (e) {
      if (add) add.innerHTML = empty('以 file:// 直接開啟時瀏覽器禁止讀取 data/…；請用 http:// 開啟（或看線上版），否則只會看到即時輪詢的部分。');
      if (cut) cut.innerHTML = empty('伺服器端快照讀取失敗：' + e.message);
      P.daily = null; P.histPanel(); return;
    }
    P.daily = d;
    const days = (d && d.days) || [];
    if (days.length) {
      try {
        const latest = await getJSON('data/positions-' + days[days.length - 1] + '.json');
        let prev = null;
        if (days.length > 1) prev = await getJSON('data/positions-' + days[days.length - 2] + '.json');
        P.snaps = { latest: latest, prev: prev };
        P.rank = P.computeRank(latest, prev);
      } catch (e) {
        if (add) add.innerHTML = empty('每日部位檔案讀取失敗：' + e.message);
        if (cut) cut.innerHTML = empty('每日部位檔案讀取失敗：' + e.message);
      }
    }
    P.rankBars2(); P.histPanel();
  };

  /* ══════════ 3. 大戶實際績效（data/whale-perf.json）══════════ */
  P.perfPanel = function () {
    const box = $('psPerfGrid'), meta = $('psPerfMeta'), note = $('psPerfNote');
    if (!box) return;
    const d = P.perf;
    if (!d || !d.wallets) {
      box.innerHTML = empty('讀不到 data/whale-perf.json（以 file:// 直接開啟會被瀏覽器擋下，請用 http:// 開啟）');
      return;
    }
    const wins = d.windows || [30, 60, 180, 360];
    const addrs = Object.keys(d.wallets);
    if (meta) {
      meta.textContent = addrs.length + ' 個大戶錢包 · 資料時間 ' + String(d.generated_at || '').slice(0, 16).replace('T', ' ')
        + ' UTC · ' + (d.source || '');
    }
    box.innerHTML = wins.map(win => {
      const rows = [];
      addrs.forEach(a => {
        const m = (d.wallets[a].m || {})[String(win)];
        if (m && isFinite(m.ret)) rows.push(m);
      });
      if (!rows.length) {
        return '<div class="ps-wcard"><label>' + win + ' 天</label><b>—</b>'
          + '<span class="mini">這批錢包在這個視窗沒有足夠的取樣點（帳戶開立時間太短）。</span></div>';
      }
      const rets = rows.map(m => m.ret);
      const med = U.median(rets), mean = U.mean(rets);
      const up = rets.filter(v => v > 0).length;
      const dds = rows.map(m => m.dd).filter(isFinite);
      const ddMed = U.median(dds);
      const daysMed = U.median(rows.map(m => m.days).filter(isFinite));
      return '<div class="ps-wcard" title="' + esc('取樣 ' + rows.length + ' 個錢包 · 中位數取樣天數 ' + (isFinite(daysMed) ? daysMed.toFixed(0) : '—')
        + ' 天 · 報酬以累積盈虧差分計算（排除入金），回撤以權益曲線計算') + '">'
        + '<label>' + win + ' 天</label>'
        + '<b class="' + cls(med) + '">' + sp(med * 100, 1) + '</b>'
        + '<span class="mini">中位數報酬（' + rows.length + ' 檔 · 取樣中位數 ' + (isFinite(daysMed) ? daysMed.toFixed(0) : '—') + ' 天）</span>'
        + '<div class="ps-kv"><span>平均報酬</span><b class="' + cls(mean) + '">' + sp(mean * 100, 1) + '</b></div>'
        + '<div class="ps-kv"><span>正報酬比例</span><b>' + pc(up / rets.length, 0) + '</b></div>'
        + '<div class="ps-kv"><span>最大回撤（中位數）</span><b>' + (isFinite(ddMed) ? pc(ddMed, 1) : '—') + '</b></div>'
        + '</div>';
    }).join('');
    if (note) {
      note.innerHTML = '指標定義與完整資料在 <a href="report.html">回測報表</a>：報酬以累積盈虧差分計算（排除入金造成的權益跳動），'
        + '回撤以權益曲線計算。這裡只做摘要，明細（每個錢包的曲線與指標）看報表頁。';
    }
  };

  P.loadPerf = async function () {
    try { P.perf = await getJSON('data/whale-perf.json'); }
    catch (e) { P.perf = null; P.note = e.message; }
    P.perfPanel();
  };

  /* ══════════ 4. 即時持倉清單、錢包排行、大戶真實盈虧帳本 ══════════
     這三塊以前是 signalui.js 在畫的，但它的欄位含「模擬跟單」（這一頁已經移除），
     所以在這裡用同一批真實資料自己渲染；signalui.js 本體不動。 */
  const dm = ts => { const d = new Date(ts); return d.toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' }) + ' ' + d.toLocaleTimeString('zh-TW', { hour12: false }); };
  const dur = ms => {
    if (!isFinite(ms) || ms <= 0) return '—';
    const m = ms / 60000;
    if (m < 60) return Math.max(1, Math.round(m)) + ' 分';
    const h = m / 60;
    return h < 24 ? h.toFixed(1) + ' 小時' : (h / 24).toFixed(1) + ' 天';
  };
  const mid = c => (S.signals && S.signals.mid) ? S.signals.mid(c) : NaN;
  const keepScroll = (el, fn) => { const p = el && (el.closest('.ps-tw') || el.parentNode); const t = p ? p.scrollTop : 0; fn(); if (p) p.scrollTop = t; };

  /* 4a. 大戶即時持倉清單（純真實資料） */
  P.openTable = function (st0) {
    const body = $('psOpenBody'); if (!body) return;
    const st = st0 || P.coinStats();
    const coinTotal = new Map(st.coins.map(c => [c.coin, c.total]));
    const list = [];
    OC.hl.states.forEach((s, addr) => {
      (s.pos || []).forEach(p => {
        const u = Math.abs(p.notional || 0);
        if (u < P.openMin) return;
        list.push({
          addr: addr, name: nm(addr), coin: p.coin, side: p.side, entry: p.entry, mark: mid(p.coin),
          usd: u, upnl: p.upnl, roe: p.roe, lev: p.lev, value: s.value, ct: coinTotal.get(p.coin) || 0
        });
      });
    });
    list.sort((a, b) => b.usd - a.usd);
    const meta = $('psOpenMeta');
    if (meta) meta.textContent = list.length + ' 個持倉 ≥ ' + usd(P.openMin) + ' · 全部倉位 ' + st.positions + ' 個 · 依名目排序';
    keepScroll(body, () => {
      if (!list.length) {
        body.innerHTML = '<tr><td colspan="10" class="empty">還沒取得持倉（每 6 秒輪詢 4 個錢包，約 80 秒跑完一輪）</td></tr>';
        return;
      }
      body.innerHTML = list.slice(0, 80).map(p => {
        const share = p.ct > 0 ? p.usd / p.ct : NaN;
        const wshare = (isFinite(p.value) && p.value > 0) ? p.usd / p.value : NaN;
        const tag = addrOf(p.addr);
        return '<tr data-addr="' + esc(p.addr) + '" title="' + esc(p.name + ' · ' + p.coin + ' ' + sideTxt(p.side) + ' · 名目 ' + usd(p.usd)
          + '（占該幣總持倉 ' + pc(share, 1) + '、占該錢包淨值 ' + pc(wshare, 1) + '）· 進場 ' + U.px(p.entry) + '、標記 ' + U.px(p.mark)) + '">'
          + '<td class="w"><span class="nm">' + esc(p.name) + '</span>' + (tag ? '<span class="mini">' + esc(tag) + '</span>' : '') + '</td>'
          + '<td><b>' + esc(p.coin) + '</b></td>'
          + '<td><span class="sidechip ' + p.side + '">' + sideTxt(p.side) + '</span>' + (isFinite(p.lev) ? ' <span class="mini">' + p.lev + '×</span>' : '') + '</td>'
          + '<td class="ta-r">' + U.px(p.entry) + '</td>'
          + '<td class="ta-r">' + U.px(p.mark) + '</td>'
          + '<td class="ta-r">' + usd(p.usd) + '</td>'
          + '<td class="ta-r ' + cls(p.upnl) + '">' + m2(p.upnl) + '</td>'
          + '<td class="ta-r ' + cls(p.roe) + '">' + sp(p.roe * 100, 1) + '</td>'
          + '<td class="ta-r mini">' + pc(share, 1) + '</td>'
          + '<td class="ta-r mini">' + pc(wshare, 1) + '</td>'
          + '</tr>';
      }).join('');
    });
  };

  /* 4b. 錢包績效排行（大戶自己的實際已實現盈虧） */
  P.walletBoard = function () {
    const box = $('psWalletPerf'); if (!box) return;
    const SG = S.signals;
    if (!SG || !SG.stats) { box.innerHTML = empty('讀不到盈虧引擎'); return; }
    const st = SG.stats({ minNotional: 0 });
    const list = st.wallets.slice(0, 12);
    const meta = $('psWalletMeta');
    if (meta) meta.textContent = st.wallets.length + ' 個錢包有平倉記錄 · 依實際已實現盈虧排序';
    if (!list.length) { box.innerHTML = empty('累積記錄中…（首次開啟會先抓最近 10 分鐘的成交，之後持續累積）'); return; }
    const max = Math.max.apply(null, list.map(x => Math.abs(x.real))) || 1;
    keepScroll(box, () => {
      box.innerHTML = list.map((x, i) => {
        const w = Math.round(Math.abs(x.real) / max * 100), neg = x.real < 0;
        const name = x.name || nm(x.addr);
        return '<div class="wl-perf" title="' + esc(name + '：實際已實現 ' + m2(x.real) + ' · ' + x.n + ' 筆 · 勝率 '
          + (isFinite(x.winRate) ? pc(x.winRate, 0) : '—') + (addrOf(x.addr) ? '（' + addrOf(x.addr) + '）' : '')
          + ' · 只計這一頁觀察到並向 Hyperliquid 取得 closedPnl 的回合') + '">'
          + '<span class="rk">' + (i + 1) + '</span>'
          + '<div class="info">'
          + '<div class="r1"><span class="nm">' + esc(name) + '</span>'
          + '<span class="mini">' + x.n + ' 筆 · 勝率 ' + (isFinite(x.winRate) ? pc(x.winRate, 0) : '—') + (x.track ? ' · 即時追蹤 ' + x.track : '') + '</span></div>'
          + '<div class="bar"><i class="' + (neg ? 'neg' : 'pos') + '" style="width:' + w + '%"></i></div>'
          + '<div class="r2"><span class="' + cls(x.real) + '">實際已實現 ' + m2(x.real) + '</span></div>'
          + '</div></div>';
      }).join('');
    });
  };

  /* 4c. 大戶真實已實現盈虧帳本（Hyperliquid closedPnl） */
  P.ledger = function () {
    const body = $('psLedgerBody'); if (!body) return;
    const SG = S.signals;
    if (!SG || !SG.stats) { body.innerHTML = '<tr><td colspan="11" class="empty">讀不到盈虧引擎</td></tr>'; return; }
    const all = SG.stats({ minNotional: 0 }).rows;
    const rows = all.slice().sort((a, b) => b.closedAt - a.closedAt).slice(0, 200);
    const meta = $('psLedgerMeta');
    if (meta) meta.textContent = all.length + ' 筆平倉回合 · 顯示最新 ' + rows.length + ' 筆（同一錢包、同幣種、同方向且時間相近的成交會聚成一個回合）';
    keepScroll(body, () => {
      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="11" class="empty">還沒有平倉記錄。載入時會先抓最近的成交重建回合，之後持續累積。</td></tr>';
        return;
      }
      body.innerHTML = rows.map(r => {
        const ratio = (isFinite(r.realUsd) && r.notional > 0) ? r.realUsd / r.notional : NaN;
        const warn = (r.realSrc === 'capped' || r.partial)
          ? ' <span class="mini" title="該錢包在那段時間的成交超過 Hyperliquid 單次 2000 筆上限，或進場資料不完整，這個數字可能低估">⚠</span>' : '';
        const name = r.name || nm(r.addr);
        return '<tr data-addr="' + esc(r.addr) + '" title="' + esc(name + ' · ' + r.coin + ' ' + sideTxt(r.side) + ' · 名目 ' + usd(r.notional)
          + ' · 進場 ' + (isFinite(r.entryPx) ? U.px(r.entryPx) : '—') + '、出場 ' + (isFinite(r.exitPx) ? U.px(r.exitPx) : '—')
          + ' · 盈虧來自 Hyperliquid 成交的 closedPnl') + '">'
          + '<td class="mini">' + dm(r.closedAt) + '</td>'
          + '<td class="w"><span class="nm">' + esc(name) + '</span>' + (addrOf(r.addr) ? '<span class="mini">' + esc(addrOf(r.addr)) + '</span>' : '') + '</td>'
          + '<td><b>' + esc(r.coin) + '</b></td>'
          + '<td><span class="sidechip ' + r.side + '">' + sideTxt(r.side) + '</span></td>'
          + '<td class="ta-r">' + (isFinite(r.entryPx) ? U.px(r.entryPx) : '—') + '</td>'
          + '<td class="ta-r">' + (isFinite(r.exitPx) ? U.px(r.exitPx) : '—') + '</td>'
          + '<td class="ta-r">' + usd(r.notional) + '</td>'
          + '<td class="ta-r ' + cls(r.realUsd) + '"><b>' + m2(r.realUsd) + '</b>' + warn + '</td>'
          + '<td class="ta-r ' + cls(ratio) + '">' + sp(ratio * 100, 2) + '</td>'
          + '<td class="ta-r mini">' + dur(r.holdMs) + '</td>'
          + '<td class="mini">' + (r.src === 'track' ? '即時追蹤' : '成交聚合') + (r.fills > 1 ? ' ×' + r.fills : '') + '</td>'
          + '</tr>';
      }).join('');
    });
  };

  /* 4d. 匯出（只有真實數字，沒有跟單欄位）與清除本機記錄 */
  P.exportCSV = function () {
    const SG = S.signals;
    if (!SG || !SG.stats) return;
    const rows = SG.stats({ minNotional: 0 }).rows.slice().sort((a, b) => b.closedAt - a.closedAt).slice(0, 300);
    const head = ['平倉時間(UTC)', '錢包', '名稱', '幣種', '方向', '進場價', '出場價', '名目(USD)', '大戶實際已實現盈虧(USD)', '實際報酬率', '持有分鐘', '來源'];
    const lines = [head.join(',')];
    rows.forEach(r => lines.push([
      new Date(r.closedAt).toISOString(), r.addr, String(r.name || '').replace(/,/g, ' '), r.coin, sideTxt(r.side),
      isFinite(r.entryPx) ? r.entryPx : '', isFinite(r.exitPx) ? r.exitPx : '', Math.round(r.notional || 0),
      isFinite(r.realUsd) ? Math.round(r.realUsd) : '',
      (isFinite(r.realUsd) && r.notional > 0) ? (r.realUsd / r.notional * 100).toFixed(2) + '%' : '',
      Math.round((r.holdMs || 0) / 60000), r.src === 'track' ? '即時追蹤' : '成交聚合'
    ].join(',')));
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sentinel-whale-realized-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    status('已匯出 ' + rows.length + ' 筆大戶真實已實現平倉記錄（CSV）');
  };

  P.clearLedger = function () {
    const SG = S.signals;
    if (!SG || !SG.clear) return;
    if (!confirm('確定要清除這台裝置上的大戶盈虧帳本嗎？（只影響這台電腦的瀏覽器記錄；伺服器端的每日快照不受影響）')) return;
    SG.clear();
    P.all();
    status('已清除這台裝置上的本機記錄');
  };

  /* ══════════ 排序切換與主渲染 ══════════ */
  P.wire = function () {
    const seg = $('psSortSeg');
    if (seg) seg.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      Array.prototype.forEach.call(seg.children, x => x.classList.toggle('on', x === b));
      P.sort = b.dataset.sort; P.coinTable();
    });
    const oseg = $('psOpenSeg');
    if (oseg) oseg.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      Array.prototype.forEach.call(oseg.children, x => x.classList.toggle('on', x === b));
      P.openMin = +b.dataset.min || 250000; P.openTable();
    });
    const ex = $('psExport');
    if (ex) ex.addEventListener('click', P.exportCSV);
    const cl = $('psClear');
    if (cl) cl.addEventListener('click', P.clearLedger);
    S.on('hl-state', addr => {
      const s = OC.hl.states.get(addr);
      if (s) P.diff(addr, s);
    });
    S.on('hl-wallets', () => P.all());
  };

  P.all = function () {
    const st = P.coinStats();
    P.dirKpi(st); P.coinTable(st); P.rankBars(st);
    P.openTable(st); P.diffFeed(); P.walletBoard(); P.ledger();
    status('追蹤 ' + (st.listTotal || 0) + ' 個大戶 · 已取得 ' + st.states + ' 檔持倉 · Σ多 ' + usd(st.longUsd)
      + ' · Σ空 ' + usd(st.shortUsd) + ' · 淨 ' + m2(st.net) + ' · 即時異動 ' + P.events.length + ' 筆');
  };

  const paint = () => {
    const st = P.coinStats();
    const rounds = (S.signals && S.signals.rounds) ? S.signals.rounds.length : 0;
    const sig = st.states + '|' + st.positions + '|' + Math.round(st.total / 1e6) + '|' + P.events.length + '|' + rounds;
    if (sig === P.sig) return;
    P.sig = sig;
    P.all();
  };

  P.init = function () {
    P.wire();
    P.all();
    P.loadDaily();
    P.loadPerf();
    // 即時事件與表格：2 秒重畫一次（背景分頁降頻，但不停更）
    let t = 0;
    setInterval(() => { t++; if (document.hidden && t % 5 !== 0) return; paint(); }, 2000);
    // 錢包明細（與 signalui 共用同一個彈窗容器）
    document.addEventListener('click', e => {
      const row = e.target.closest('#psDiff .pse');
      if (!row || !row.dataset.addr || !S.signalUI || !S.signalUI.walletModal) return;
      S.signalUI.walletModal(row.dataset.addr);
    });
    // 自動化檢查用
    w.__SENTINEL_POS_STATUS = () => {
      const st = P.coinStats();
      const coinRows = document.querySelectorAll('#psCoinBody tr').length;
      return {
        page: 'signals', module: 'positions',
        states: st.states, walletsWithPos: st.wallets, positions: st.positions,
        coins: st.coins.length, longUsd: Math.round(st.longUsd), shortUsd: Math.round(st.shortUsd),
        netUsd: Math.round(st.net), ratio: isFinite(st.ratio) ? +st.ratio.toFixed(4) : null,
        coinRows: coinRows, rankUp: document.querySelectorAll('#psRankUp .ps-bar').length,
        rankDown: document.querySelectorAll('#psRankDown .ps-bar').length,
        diffEvents: P.events.length, diffRows: document.querySelectorAll('#psDiff .pse').length,
        openRows: document.querySelectorAll('#psOpenBody tr[data-addr]').length,
        ledgerRows: document.querySelectorAll('#psLedgerBody tr[data-addr]').length,
        walletRows: document.querySelectorAll('#psWalletPerf .wl-perf').length,
        histRows: document.querySelectorAll('#psHist .ps-hrow').length,
        dailyDays: P.daily && P.daily.days ? P.daily.days.length : 0,
        changeAdd: P.rank && P.rank.add ? P.rank.add.length : 0,
        changeCut: P.rank && P.rank.cut ? P.rank.cut.length : 0,
        perfWindows: P.perf && P.perf.windows ? P.perf.windows.length : 0,
        errors: S.errors.slice(-10)
      };
    };
  };

  S.ready(P.init);
})(window);
