/* app.js — 主控：啟動流程、資料編排、事件綁定、定時任務（含鏈上情報排程） */
'use strict';
(function (w) {
  const S = w.SENTINEL, U = S.util, A = S.analytics, OC = S.onchain, FX = S.fx;
  S.state = { symbol: 'BTCUSDT', futuresSet: null, fundMap: null, mcapMap: null, universe: [], bySym: new Map(), ready: false, startTs: Date.now() };

  const pend = { trades: [] };
  let oneMin = [], drawDirty = true, lastDraw = 0, lastPx = NaN;

  /* ══════ 開機動畫（逐步打勾 + 資料雨 + 掃描環）══════ */
  const B = S.boot = {
    steps: [], el: null, bar: null, done: false,
    start() {
      this.el = document.getElementById('bootlog'); this.bar = document.getElementById('bootbar');
      FX.bootRain();
      this.add('終端核心初始化 · 建立繪圖與分析管線', 0);
      this.add('載入量化模組：CVD · 訂單簿 · 掛單牆 · 持倉結構', 200);
      this.add('連線 Binance 公開行情 API（現貨 + 合約統計）', 430);
      this.add('訂閱全市場即時資料流與清算事件廣播', 640);
      this.add('掛載鏈上情報：Hyperliquid 大戶錢包 + 多鏈 DEX 大額換幣', 880);
      setTimeout(() => this.prog(40), 900);
    },
    add(txt, delay) {
      setTimeout(() => {
        this.steps.push(txt);
        if (!this.el) return;
        this.el.innerHTML = this.steps.map((s, i) => {
          const last = i === this.steps.length - 1;
          return '<span class="boot-step ' + (last ? 'on' : 'done') + '"><span class="tick">' + (last ? '▶' : '✓') + '</span>' + s + '</span>';
        }).join('');
      }, delay);
    },
    prog(v) { if (this.bar) this.bar.style.width = v + '%'; },
    finish(msg) {
      if (this.done) return; this.done = true;
      this.prog(100);
      if (msg) U.text('#boothint', msg);
      U.$$('.boot-step').forEach(s => { s.classList.remove('on'); s.classList.add('done'); const t = s.querySelector('.tick'); if (t) t.textContent = '✓'; });
      setTimeout(() => {
        const b = document.getElementById('boot'); if (b) b.classList.add('done');
        FX.glitch();
        A.anomaly.push({ type: 'SYS', sev: 'low', symbol: '系統', title: '監控上線', text: '已載入 ' + S.state.universe.length + ' 個交易對、' + OC.hl.wallets.length + ' 個鏈上大戶錢包，資料流建立完成' });
      }, 420);
    },
    fail(msg) {
      const b = document.getElementById('boot'); if (b) b.classList.add('fail');
      U.html('#bootlog', '<span style="color:var(--rd)">✗ ' + msg + '</span>');
      U.text('#boothint', '請確認網路可連線 api.binance.com，5 秒後自動重試…');
      setTimeout(() => location.reload(), 6000);
    }
  };

  /* ══════ 選幣 ══════ */
  S.select = async function (sym, quiet) {
    if (!sym) return;
    const c = S.state.bySym.get(sym);
    if (!c) return;
    const switching = S.state.symbol !== sym;
    S.state.symbol = sym;
    S.state.cur = c;
    A.reset();
    S.chart.markers = [];
    S.ui.whale.count = 0;
    lastPx = NaN;
    const tape = document.getElementById('whaleTape'); if (tape) tape.innerHTML = '<div class="empty">等待大額成交…</div>';
    S.ui.scan.render();
    U.text('#chartBadge', 'LIVE · ' + sym);
    if (switching && !quiet) {
      FX.glitch();
      FX.streamLine(document.querySelector('.chart-panel'));
    }

    const hasFut = !!(S.state.futuresSet && S.state.futuresSet.has(sym));
    S.stream.startSelected(sym, hasFut ? sym : null);

    const jobs = [
      S.api.klines(sym, S.chart.tf, 300).then(k => { if (k && S.state.symbol === sym) S.chart.setData(k, true); }),
      S.api.klines(sym, '1m', 90).then(k => { if (k && S.state.symbol === sym) oneMin = k; }),
      S.api.depth(sym, 1000).then(d => { if (d && S.state.symbol === sym) { A.Book.setRest(d); S.bookUI.render(A.Book); } })
    ];
    if (hasFut) jobs.push(loadPos(sym));
    else { A.Pos.set(null); S.ui.pos.render(); }
    await Promise.all(jobs);
    S.state.ready = true;
    refreshStats();
  };

  async function loadPos(sym) {
    const [p, oi] = await Promise.all([S.api.positioning(sym), S.api.oiHist(sym, '5m', 48)]);
    if (S.state.symbol !== sym || !p) return;
    const fund = S.state.fundMap && S.state.fundMap[sym] ? S.state.fundMap[sym].funding : NaN;
    A.Pos.set(Object.assign({}, p, { oiHist: oi, funding: fund }));
    S.ui.pos.render(priceStats());
  }

  /* ══════ 價格統計（ATR、VWAP、POC、1H 變動）══════ */
  function priceStats() {
    const k = S.chart.k || [], out = { atr: NaN, vwap: NaN, poc: NaN, pocBand: 0.005, h1: NaN };
    if (k.length > 15) {
      let tr = 0, n = 0;
      for (let i = k.length - 14; i < k.length; i++) {
        const a = k[i - 1], b = k[i];
        tr += Math.max(b.h - b.l, Math.abs(b.h - a.c), Math.abs(b.l - a.c)); n++;
      }
      out.atr = (tr / n) / (k[k.length - 1].c || 1) * 100;
    }
    if (oneMin.length > 61) {
      const last = oneMin[oneMin.length - 1].c, prev = oneMin[oneMin.length - 61].c;
      out.h1 = (last / prev - 1) * 100;
    } else if (k.length > 12) {
      out.h1 = (k[k.length - 1].c / k[k.length - 13].c - 1) * 100;
    }
    const vw = A.Trades.vwap(1800e3); out.vwap = isFinite(vw) ? vw : (k.length ? k[k.length - 1].c : NaN);
    const src = k.length > 40 ? k.slice(-40) : k;
    if (src.length > 5) {
      const lo = Math.min.apply(null, src.map(x => x.l)), hi = Math.max.apply(null, src.map(x => x.h));
      const NB = 48, bins = new Float64Array(NB);
      src.forEach(x => {
        const mid = (x.h + x.l + x.c) / 3;
        const i = U.clamp(Math.floor((mid - lo) / (hi - lo || 1) * NB), 0, NB - 1);
        bins[i] += x.q || 0;
      });
      let bi = 0; for (let i = 1; i < NB; i++) if (bins[i] > bins[bi]) bi = i;
      out.poc = lo + (hi - lo) * (bi + .5) / NB;
      let sw = 0, swx = 0, swx2 = 0;
      for (let i = 0; i < NB; i++) { const pp = lo + (hi - lo) * (i + .5) / NB; sw += bins[i]; swx += bins[i] * pp; swx2 += bins[i] * pp * pp; }
      const m = sw ? swx / sw : 0, v = sw ? (swx2 / sw - m * m) : 0;
      out.pocBand = m ? Math.min(.05, Math.sqrt(Math.max(0, v)) / m) : 0.005;
      out.poc = sw ? m : out.poc;
    }
    return out;
  }

  function refreshStats() {
    const c = S.state.cur; if (!c) return;
    const ps = priceStats();
    S.ui.stats(c, ps, null);
    return ps;
  }

  /* ══════ 事件綁定 ══════ */
  function wire() {
    S.on('trade', t => { if (t.symbol === S.state.symbol) { A.Trades.add(t); S.chart.setPrice(t.price); drawDirty = true; } });
    S.on('trade-new', t => { if (t.symbol !== S.state.symbol) return; pend.trades.push(t); });
    S.on('depth', d => { if (S.state.symbol) A.Book.setWs(d); });
    S.on('book-update', b => {
      S.heat.draw();
      const sp = document.getElementById('heatSpan');
      if (sp) sp.textContent = '深度 ' + (b.levels || 0) + ' 檔 · 涵蓋中價 ±' + ((b.depthRange || 0) * 100).toFixed(3) + '%';
      const s = document.getElementById('hSkew');
      if (s) {
        const sk = b.skew || 0;
        s.textContent = (sk >= 0 ? '中價上方 ' : '中價下方 ') + Math.abs(sk).toFixed(3) + '%';
        s.style.color = sk >= 0 ? 'var(--rd)' : 'var(--gn)';
        s.title = '全部可見掛單的金額加權重心相對中價的位置：在中價上方代表上方賣壓較集中，下方代表買盤支撐較厚';
      }
    });
    S.on('liquidation', e => {
      A.Liq.add(e); S.ui.liq.add(e);
      const pn = document.querySelector('.liq-panel');
      if (pn && e.notional >= 50000) {
        pn.classList.remove('hit-long', 'hit-short'); void pn.offsetWidth;
        pn.classList.add(e.side === 'long' ? 'hit-long' : 'hit-short');
        setTimeout(() => pn.classList.remove('hit-long', 'hit-short'), 950);
      }
    });
    S.on('alert', a => {
      S.ui.alerts.push(a);
      if (a.sev === 'high') FX.toast({ title: a.title, text: a.text, sev: 'high', tag: (a.type || 'ALERT').replace('CHAIN_', '鏈上·') });
      else if (a.sev === 'mid' && (a.type || '').indexOf('CHAIN') === 0) FX.toast({ title: a.title, text: a.text, sev: 'mid', tag: '鏈上情報' });
    });
    S.on('alert-clear', () => S.ui.alerts.clear());
    S.on('ws-state', st => S.ui.hud.pills(st));

    /* 鏈上事件 */
    S.on('hl-wallets', () => { S.chainUI.render(); S.ui.hud.pills(S.stream.state); });
    S.on('hl-event', e => {
      S.chainUI.hlEvent(e);
      if (e.sev === 'high' || e.kind === 'FLIP') FX.toast({ title: e.name + ' ' + e.title, text: e.text, sev: e.sev === 'high' ? 'high' : 'mid', tag: '鏈上大戶' });
    });
    S.on('hl-state', () => { hlDirty = true; });
    S.on('dex-trade', t => {
      S.chainUI.dexTrade(t);
      if (t.usd >= 1000000) FX.toast({
        title: '鏈上大額' + (t.side === 'buy' ? '買入' : '賣出') + ' ' + (t.tokenSym || '') + ' $' + U.money(t.usd),
        text: '錢包 ' + OC.short(t.wallet) + ' · ' + OC.chainLabel(t.chain) + ' · ' + (t.poolName || t.dex || ''), sev: 'mid', tag: '鏈上換幣'
      });
    });
    S.on('dex-scan', () => S.chainUI.dexMeta());

    const map = {};
    S.on('miniTicker', arr => {
      for (const m of arr) {
        if (!m.s || !S.state.bySym.has(m.s)) continue;
        map[m.s] = { c: +m.c, o: +m.o, h: +m.h, l: +m.l, q: +m.q };
      }
      S.state.tickMap = map;
    });

    document.getElementById('scanSearch').addEventListener('input', U.debounce(e => { S.ui.scan.q = e.target.value.trim(); S.ui.scan.render(true); }, 180));
    document.getElementById('onlyFutures').addEventListener('change', e => { S.ui.scan.onlyFut = e.target.checked; S.ui.scan.render(true); });
    document.getElementById('scanSort').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      S.ui.scan.sort = b.dataset.sort;
      Array.prototype.forEach.call(b.parentNode.children, x => x.classList.toggle('on', x === b));
      S.ui.scan.render(true);
    });
    document.getElementById('tfSeg').addEventListener('click', async e => {
      const b = e.target.closest('button'); if (!b) return;
      Array.prototype.forEach.call(b.parentNode.children, x => x.classList.toggle('on', x === b));
      S.chart.tf = b.dataset.tf;
      const k = await S.api.klines(S.state.symbol, S.chart.tf, 300);
      if (k) S.chart.setData(k, true);
      refreshStats();
    });
    document.getElementById('ovSeg').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      const key = b.dataset.ov;
      S.chart.ov[key] = !S.chart.ov[key];
      b.classList.toggle('on', S.chart.ov[key]);
      S.chart.draw();
    });
    document.getElementById('whaleFilter').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      Array.prototype.forEach.call(b.parentNode.children, x => x.classList.toggle('on', x === b));
      S.ui.whale.min = b.dataset.min === 'auto' ? 'auto' : +b.dataset.min;
      S.ui.whale.thrNow = S.ui.whale.threshold();
      S.ui.whale.renderNetflow();
    });
    document.getElementById('clearAlerts').addEventListener('click', () => A.anomaly.clear());
    /* 鏈上區塊「展開 / 收合」：預設高度約 32vh，展開後吃掉整個工作區高度，
       大戶持倉表一次可以看到十幾列（其餘區塊也一併變高）。 */
    (function () {
      const btn = document.getElementById('chainExpand');
      const wrap = document.querySelector('.chain-wrap');
      if (!btn || !wrap) return;
      btn.addEventListener('click', () => {
        const on = wrap.classList.toggle('full');
        btn.textContent = on ? '收合' : '展開';
        btn.classList.toggle('on', on);
        /* 高度用 inline + important 指定：外面的 flex/媒體查詢都不會蓋掉它 */
        if (on) wrap.style.setProperty('height', 'min(62vh, calc(100vh - 118px))', 'important');
        else wrap.style.removeProperty('height');
        try { localStorage.setItem('cs.chainFull', on ? '1' : '0'); } catch (e) { }
        requestAnimationFrame(() => {
          w.dispatchEvent(new Event('resize'));
          S.chainUI.dexMeta();
        });
      });
      let saved = false;
      try { saved = localStorage.getItem('cs.chainFull') === '1'; } catch (e) { }
      if (saved && innerHeight >= 760) btn.click();   // 矮螢幕不自動展開，免得三欄被壓扁
    })();

    /* 鏈上：鏈別 / 門檻切換 */
    document.getElementById('chainSeg').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      Array.prototype.forEach.call(b.parentNode.children, x => x.classList.toggle('on', x === b));
      OC.dex.chain = b.dataset.chain;
      OC.dex.reset();
      const tape = document.getElementById('chainTape');
      if (tape) tape.innerHTML = '<div class="empty">切換鏈別，重新掃描中…</div>';
      const wl = document.getElementById('walletList'); if (wl) { wl.__key = ''; wl.innerHTML = '<div class="empty">累積鏈上錢包資料中…</div>'; }
      const cb = document.getElementById('coBuyList'); if (cb) { cb.__key = ''; cb.innerHTML = ''; }
      S.chainUI.dexMeta();
      FX.glitch();
      setTimeout(() => dexScan(), 120);
    });
    document.getElementById('chainMin').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      Array.prototype.forEach.call(b.parentNode.children, x => x.classList.toggle('on', x === b));
      OC.dex.min = +b.dataset.min;
      S.chainUI.dexMeta();
      setTimeout(() => dexScan(), 120);
    });

    /* 鍵盤操作 */
    document.addEventListener('keydown', e => {
      if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); document.getElementById('scanSearch').focus(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const list = S.ui.scan.sorted(); if (!list.length) return;
        const i = list.findIndex(x => x.symbol === S.state.symbol);
        const n = i < 0 ? 0 : U.clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, list.length - 1);
        if (n !== i) {
          e.preventDefault(); S.select(list[n].symbol);
          const el = document.querySelector('#scanBody tr[data-sym="' + list[n].symbol + '"]'); if (el) el.scrollIntoView({ block: 'nearest' });
        }
      }
    });
  }

  /* ══════ 資金動能分數（全市場輕量版）══════ */
  function scoreProxy(c, fund) {
    const turnover = (S.state.mcapMap && S.state.mcapMap[c.symbol] && S.state.mcapMap[c.symbol].mcap)
      ? c.quoteVolume / S.state.mcapMap[c.symbol].mcap : 0.15;
    const tv = U.clamp((turnover - 0.12) / 0.4, -1, 1);
    const range = (c.high > c.low) ? (c.price - c.low) / (c.high - c.low) : .5;
    const rg = (range - .5) * 2;
    const mom = U.clamp(c.changePct / 8, -1, 1);
    const fd = isFinite(fund) ? U.clamp(-fund / 0.0008, -1, 1) : 0;
    const v = 0.34 * mom + 0.22 * rg + 0.22 * fd + 0.22 * tv;
    return Math.round(U.clamp(50 + v * 45, 2, 98));
  }
  function applyScores() {
    const fm = S.state.fundMap || {};
    S.state.universe.forEach(c => {
      const f = fm[c.symbol] ? fm[c.symbol].funding : NaN;
      c.smart = scoreProxy(c, f);
    });
    const cur = S.state.bySym.get(S.state.symbol);
    if (cur && S.state.lastSmart) cur.smart = S.state.lastSmart;
  }

  /* ══════ 鏈上：大戶輪詢與 DEX 掃描 ══════ */
  let hlDirty = false, dexBusy = false;
  async function loadWhales() {
    const d = await S.api.hlWhales();
    if (d) { OC.hl.setWallets(d); S.chainUI.render(); }
  }
  /* 首輪快速預掃：不照輪詢順序，先把名單前段（最大的錢包）一次補齊，
     讓「大戶持倉」在十幾秒內就有內容，而不是等 80 秒整輪掃完。 */
  async function primeWallets(n) {
    const list = OC.hl.wallets.slice(0, n || 24);
    const chunk = 6;
    for (let i = 0; i < list.length; i += chunk) {
      await Promise.all(list.slice(i, i + chunk).map(wl =>
        S.api.hlState(wl.addr).then(st => { if (st) OC.hl.ingest(wl.addr, st); })));
      S.chainUI.agg();
      await new Promise(r => setTimeout(r, 250));
    }
    OC.hl.pollIdx = list.length % Math.max(1, OC.hl.wallets.length);   // 接續輪詢，不重掃同一批
    S.chainUI.render();
  }
  function hlPoll(batchSize) {
    OC.hl.nextBatch(batchSize || 4).forEach(wl => S.api.hlState(wl.addr).then(st => { if (st) OC.hl.ingest(wl.addr, st); }));
  }
  async function dexScan() {
    if (dexBusy) return;
    dexBusy = true;
    try { await OC.dex.scan(); } catch (e) { S.errors.push('dexScan: ' + e.message); }
    dexBusy = false;
    S.chainUI.dexMeta();
  }

  /* ══════ 定時任務 ══════ */
  function timers() {
    // 每 400ms：消化成交流（圖表標記 + 巨鯨面板 + 價格脈動 + 浮動金額）
    setInterval(() => {
      if (!pend.trades.length) return;
      const batch = pend.trades; pend.trades = [];
      for (const t of batch) {
        if (t.notional >= 50000) {
          S.chart.markers.push({ t: t.ts, price: t.price, notional: t.notional, side: t.side });
          if (S.chart.markers.length > 300) S.chart.markers.splice(0, 100);
        }
        S.ui.whale.add(t);
      }
      drawDirty = true;
      const pEl = document.getElementById('symPrice');
      const px = S.chart.price;
      if (pEl && isFinite(px) && px !== lastPx) {
        if (isFinite(lastPx)) {
          pEl.classList.remove('pulse-up', 'pulse-down'); void pEl.offsetWidth;
          pEl.classList.add(px > lastPx ? 'pulse-up' : 'pulse-down');
          const big = batch.filter(t => t.notional >= 250000).sort((a, b) => b.notional - a.notional)[0];
          if (big) FX.floatTag(pEl, (big.side === 'buy' ? '+' : '−') + '$' + U.money(big.notional), big.side === 'buy' ? 'var(--gn)' : 'var(--rd)');
        }
        lastPx = px;
      }
    }, 400);

    // 每 1 秒：分析 + 面板
    setInterval(() => {
      const ps = priceStats();
      const medN = A.Trades.medianNotional(600e3);
      if (isFinite(medN) && medN > 0) A.Trades.WHALE = U.clamp(Math.max(25000, medN * 8), 25000, 5e6);
      A.anomaly.scanPrice(S.state.cur ? S.state.cur.price : NaN, oneMin);
      A.anomaly.scanBook(A.Book);
      const res = A.smart({ trades: A.Trades, book: A.Book, pos: A.Pos, liq: A.Liq, price: S.state.cur ? S.state.cur.price : NaN, klines: S.chart.k, priceStats: ps });
      S.state.lastSmart = res.score;
      const cur = S.state.bySym.get(S.state.symbol); if (cur) cur.smart = res.score;
      if (document.hidden) return;
      S.ui.whale.renderNetflow();
      S.ui.liq.render();
      S.ui.smart(res);
      S.ui.hud.pills(S.stream.state);
      S.ui.hud.clock();
      refreshStats();
      const b = document.querySelector('#scanBody tr[data-sym="' + S.state.symbol + '"] .smbadge');
      if (b) b.title = '已完整分析：聰明錢壓力分數 ' + res.score + '（' + res.verdict + '）';
    }, 1000);

    // 圖表／熱圖動畫重繪（畫面可見時才畫；偵測到繪製過慢就自動降頻）
    let atick = 0, slow = 0, animTimer = null;
    const fast = () => {
      if (document.hidden) return;
      const cv = document.getElementById('chart'); if (!cv) return;
      const r = cv.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) return;
      atick++;
      const t0 = performance.now();
      S.chart.draw();
      if (atick % 2 === 0) S.heat.draw();
      const dt = performance.now() - t0;
      if (dt > 16) {
        // 連續偏慢（舊電腦／行動裝置）→ 降頻，先保住操作流暢度
        if (++slow > 6) { clearInterval(animTimer); animTimer = setInterval(() => { if (!document.hidden) S.chart.draw(); }, 170); }
      } else slow = Math.max(0, slow - 1);
    };
    animTimer = setInterval(fast, 62);

    // 每 2.2 秒：訂單簿快照
    setInterval(async () => {
      if (!S.state.ready) return;
      const d = await S.api.depth(S.state.symbol, 1000);
      if (d && A.Book) { A.Book.setRest(d); S.bookUI.render(A.Book); }
    }, 2200);

    // 全市場輕量行情套用
    setInterval(() => {
      if (document.hidden || !S.state.tickMap) return;
      S.ui.scan.patch(S.state.tickMap);
      const up = S.state.universe.filter(x => x.changePct > 0).length;
      S.ui.hud.breadth(up, S.state.universe.length - up, S.state.universe.length);
    }, 1500);

    // 每 20 秒：K 線刷新
    setInterval(async () => {
      if (!S.state.ready) return;
      const sym = S.state.symbol;
      const [k, k1] = await Promise.all([S.api.klines(sym, S.chart.tf, 300), S.api.klines(sym, '1m', 90)]);
      if (sym !== S.state.symbol) return;
      if (k) S.chart.setData(k);
      if (k1) oneMin = k1;
      refreshStats();
    }, 20000);

    // 每 15 秒：全市場 24H 統計（背景分頁降頻）
    let uniTick = 0;
    setInterval(async () => {
      uniTick++;
      if (document.hidden && uniTick % 4 !== 0) return;
      const l = await S.api.universe();
      if (!l) return;
      S.state.universe = l;
      S.state.bySym = new Map(l.map(x => [x.symbol, x]));
      const curNew = S.state.bySym.get(S.state.symbol);
      if (curNew) { S.state.cur = curNew; if (S.state.lastSmart) curNew.smart = S.state.lastSmart; }
      applyScores();
      S.ui.scan.setList(l);
      const up = l.filter(x => x.changePct > 0).length;
      S.ui.hud.breadth(up, l.length - up, l.length);
    }, 15000);

    // 每 5 秒：鏈上大戶錢包（每輪 6 個，約 45 秒輪完全部名單；載入時另有 24 檔快速預掃）
    setInterval(() => { if (!document.hidden) hlPoll(6); else hlPoll(2); }, 5000);

    // 每 14 秒：鏈上 DEX 大額換幣掃描（每輪 1 個高流量池；GeckoTerminal 免費層約 5 次/分即被擋）
    setInterval(() => dexScan(), 14000);
    setInterval(() => { if (!document.hidden) S.chainUI.dexMeta(); }, 3000);

    // 每 1.2 秒：鏈上面板渲染
    setInterval(() => {
      if (document.hidden) return;
      S.chainUI.agg();
      if (hlDirty) { hlDirty = false; S.chainUI.hlTable(); S.chainUI.coinBars(); }
      S.chainUI.wallets();
      S.chainUI.coBuy();
      const cnt = document.getElementById('chainCount');
      if (cnt) cnt.textContent = String(OC.dex.trades.length + OC.hl.events.length);
    }, 1200);

    // 每 5 分鐘：重新載入大戶名單
    setInterval(() => { S.api.hlWhales().then(d => { if (d) { OC.hl.setWallets(d); S.chainUI.render(); } }); }, 300000);

    // 每 10 分鐘：確認合約流對應當前幣種
    setInterval(() => {
      if (document.hidden || !S.state.futuresSet) return;
      if (S.state.futuresSet.has(S.state.symbol)) S.stream.attachFutures(S.state.symbol);
    }, 600000);

    // 每 45 秒：持倉結構
    setInterval(() => { if (!document.hidden && S.state.futuresSet && S.state.futuresSet.has(S.state.symbol)) loadPos(S.state.symbol); }, 45000);

    // 每 30 秒：資金費率（全市場）+ 分數重算
    setInterval(async () => {
      const fm = await S.api.futures();
      if (fm) { S.state.fundMap = fm; S.state.futuresSet = new Set(Object.keys(fm)); applyScores(); S.ui.scan.render(); }
    }, 30000);

    // 每 5 分鐘：全球市值 / 排行 / 情緒
    setInterval(async () => {
      const [g, m, f] = await Promise.all([S.api.global(), S.api.mcapMap(), S.api.fng()]);
      if (m) { S.state.mcapMap = m; applyScores(); }
      S.ui.hud.global(g, f);
    }, 300000);

    // 狀態列輪播
    let ti = 0;
    setInterval(() => {
      ti++;
      const st = S.stream.stats();
      const top = A.Trades.large(250000, 900e3)[0];
      const a = OC.hl.agg;
      const msgs = [
        '即時流 ' + st.selRate + ' 筆/秒 · 全市場行情 ' + st.globRate + ' 則/秒 · 資料源 ' + (S.api.source || 'Binance'),
        '訂單簿熱圖 ' + A.Book.frames.length + ' 格（每格 2.2 秒）· 掛單牆 ' + A.Book.walls.length + ' 道 · 疑似假掛單 ' + A.Book.spoofs.length + ' 次',
        top ? '近 15 分鐘最大單筆：' + top.symbol + ' ' + (top.side === 'buy' ? '主動買入' : '主動賣出') + ' $' + U.money(top.notional) + ' @ ' + U.px(top.price) : '近 15 分鐘未出現大額單筆',
        a && a.wallets ? '鏈上大戶追蹤 ' + a.wallets + ' 個錢包 / ' + a.positions + ' 個倉位：多 $' + U.money(a.longUsd) + '、空 $' + U.money(a.shortUsd) + '（Hyperliquid）' : '鏈上大戶錢包資料載入中…',
        '鏈上換幣：' + OC.chainLabel(OC.dex.chain) + ' 追蹤 ' + OC.dex.pools.length + ' 個熱門池 · 已收 ' + OC.dex.trades.length + ' 筆大額 · ' + OC.dex.wallets.size + ' 個錢包',
        '清算監控中 · 近 15 分鐘清算 $' + U.money(A.Liq.sum(900e3).total) + ' · 壓力分數 ' + (S.state.lastSmart || '—') + ' · 方向鍵切換幣種、/ 搜尋'
      ];
      S.ui.hud.ticker(msgs[ti % msgs.length]);
    }, 5000);
  }

  /* ══════ 啟動 ══════ */
  async function main() {
    S.boot.start();
    FX.initBackground();
    S.chart.init(document.getElementById('chart'));
    S.heat.init(document.getElementById('heat'));
    S.gauge.init(document.getElementById('gauge'));
    S.oiChart.init(document.getElementById('oiChart'));
    S.bookUI.init();
    FX.initRadar(document.getElementById('radar'));
    S.ui.hud.clock(); setInterval(() => S.ui.hud.clock(), 1000);
    wire();

    const uni = await S.api.universe();
    if (!uni || !uni.length) { S.boot.fail('無法取得市場資料'); return; }
    S.state.universe = uni;
    S.state.bySym = new Map(uni.map(x => [x.symbol, x]));
    S.ui.scan.setList(uni);
    S.ui.hud.breadth(uni.filter(x => x.changePct > 0).length, uni.filter(x => x.changePct < 0).length, uni.length);
    S.boot.prog(62);

    const start = uni.find(x => x.symbol === 'BTCUSDT') ? 'BTCUSDT' : uni[0].symbol;
    S.stream.startGlobal();
    S.api.bybitLinear().then(lin => {
      if (!lin) return;
      const majors = S.state.universe.filter(x => lin.has(x.symbol)).slice(0, 100).map(x => x.symbol);
      if (majors.length) S.stream.startLiquidations(majors);
    });
    await S.select(start, true);
    S.boot.prog(80);

    Promise.all([S.api.futures(), S.api.global(), S.api.mcapMap(), S.api.fng()]).then(([fm, g, m, f]) => {
      if (fm) { S.state.fundMap = fm; S.state.futuresSet = new Set(Object.keys(fm)); }
      if (m) S.state.mcapMap = m;
      applyScores();
      S.ui.scan.render();
      S.ui.hud.global(g, f);
      if (fm && S.state.futuresSet.has(S.state.symbol)) {
        S.stream.attachFutures(S.state.symbol);
        loadPos(S.state.symbol);
      }
      S.boot.prog(95);
      S.boot.finish('系統就緒 · ' + S.state.universe.length + ' 個交易對 · 即時流已連線');
    }).catch(() => S.boot.finish('系統就緒（部分輔助資料暫時無法取得）'));

    // 鏈上情報（獨立於行情）
    loadWhales().then(() => {
      primeWallets(24); S.chainUI.render();
      setTimeout(() => {
        const m = document.getElementById('hlMeta');
        if (OC.hl.wallets.length && !OC.hl.states.size) {
          S.api.health.chain = 'off';
          if (m) m.innerHTML = '<span style="color:var(--am)">無法取得持倉資料 — 可能是網路阻擋 api.hyperliquid.xyz（此站需要瀏覽器直連該端點）</span>';
        }
      }, 25000);
    });
    setTimeout(() => dexScan(), 1500);

    setTimeout(() => S.boot.finish(), 7000);
    timers();

    setTimeout(() => {
      const st = S.stream.stats();
      if (st.sel !== 'open' || st.selAge > 4000) {
        A.anomaly.push({ type: 'WS', sev: 'low', symbol: '系統', title: '即時流狀態', text: '成交明細資料流尚未收到資料，已自動切換備援資料源' });
      }
    }, 9000);
  }

  S.ready(main);

  /* 全域診斷（供自動化檢查使用） */
  w.__SENTINEL_STATUS = () => ({
    symbol: S.state.symbol,
    universe: S.state.universe.length,
    scanRows: document.querySelectorAll('#scanBody tr').length,
    bookAsks: document.querySelectorAll('#bookAsks tr').length,
    whaleRows: document.querySelectorAll('#whaleTape .trow').length,
    liqRows: document.querySelectorAll('#liqTape .lrow').length,
    alerts: A.anomaly.list.length,
    klines: S.chart.k.length,
    heatFrames: A.Book.frames.length,
    smart: S.state.lastSmart,
    ws: S.stream.stats(),
    apiHealth: S.api.health,
    errors: S.errors.slice(-12),
    chain: {
      hlWallets: OC.hl.wallets.length,
      hlStates: OC.hl.states.size,
      hlPolled: OC.hl.polled,
      hlEvents: OC.hl.events.length,
      hlAgg: OC.hl.agg ? { wallets: OC.hl.agg.wallets, positions: OC.hl.agg.positions, longUsd: Math.round(OC.hl.agg.longUsd), shortUsd: Math.round(OC.hl.agg.shortUsd), ratio: +(OC.hl.agg.ratio || 0).toFixed(3) } : null,
      dexChain: OC.dex.chain, dexMin: OC.dex.min, dexPools: OC.dex.pools.length, dexTrades: OC.dex.trades.length,
      dexWallets: OC.dex.wallets.size, coBuy: OC.dex.coBuy.length, radarPings: OC.radar.pings.length,
      hlRows: document.querySelectorAll('#hlBody tr').length,
      walletRows: document.querySelectorAll('#walletList .wl').length,
      chainRows: document.querySelectorAll('#chainTape .ctrow').length,
      hlEventRows: document.querySelectorAll('#hlEvents .hle').length,
      toasts: document.querySelectorAll('.toast').length
    },
    flow: (() => {
      const b = A.Trades.buf, f = b.filter(x => x.market === 'futures').length;
      return {
        trades: b.length, futures: f, spot: b.length - f,
        maxNotional: b.length ? Math.round(Math.max.apply(null, b.map(x => x.notional))) : 0,
        over50k: b.filter(x => x.notional >= 50000).length,
        liqRaw: A.Liq.buf.length, liqBuf: A.Liq.buf.slice(-3).map(x => x.symbol + ' ' + x.side + ' $' + Math.round(x.notional))
      };
    })(),
    booted: document.getElementById('boot').classList.contains('done')
  });
})(window);
