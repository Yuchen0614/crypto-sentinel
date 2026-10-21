/* app.js — 主控：啟動流程、資料編排、事件綁定、定時任務 */
'use strict';
(function (w) {
  const S = w.SENTINEL, U = S.util, A = S.analytics;
  S.state = { symbol: 'BTCUSDT', futuresSet: null, fundMap: null, mcapMap: null, universe: [], bySym: new Map(), ready: false, startTs: Date.now() };

  const pend = { trades: [] };
  let oneMin = [], drawDirty = true, lastDraw = 0;

  /* ══════ 開機動畫 ══════ */
  const B = S.boot = {
    lines: [], el: null, bar: null, timer: null, done: false,
    start() {
      this.el = document.getElementById('bootlog'); this.bar = document.getElementById('bootbar');
      this.tick('CRYPTO SENTINEL 終端啟動中…', 0);
      this.tick('載入量化分析模組 · 訂單簿追蹤 · 巨鯨偵測', 140);
      this.tick('連線 Binance 公開行情 API（現貨 + 合約）', 300);
      this.tick('訂閱全市場即時資料流 · 清算事件廣播', 470);
      setTimeout(() => this.prog(45), 900);
    },
    tick(txt, delay) { setTimeout(() => { this.lines.push(txt); if (this.el) this.el.innerHTML = this.lines.map((l, i) => `<span class="${i === this.lines.length - 1 ? 'hi' : 'ok'}">${i === this.lines.length - 1 ? '▶ ' : '✓ '}${l}</span>`).join('\n'); }, delay); },
    prog(v) { if (this.bar) this.bar.style.width = v + '%'; },
    finish(msg) {
      if (this.done) return; this.done = true;
      this.prog(100);
      if (msg) { U.text('#boothint', msg); }
      setTimeout(() => {
        const b = document.getElementById('boot'); if (b) b.classList.add('done');
        A.anomaly.push({ type: 'SYS', sev: 'low', symbol: '系統', title: '監控上線', text: `已載入 ${S.state.universe.length} 個交易對，即時資料流建立完成` });
      }, 420);
    },
    fail(msg) {
      const b = document.getElementById('boot'); if (b) b.classList.add('fail');
      U.html('#bootlog', `<span style="color:var(--rd)">✗ ${msg}</span>`);
      U.text('#boothint', '請確認網路可連線 api.binance.com，5 秒後自動重試…');
      setTimeout(() => location.reload(), 6000);
    }
  };

  /* ══════ 背景星空／資料流光 ══════ */
  function starfield() {
    const cv = document.getElementById('starfield'); if (!cv) return;
    const c = cv.getContext('2d');
    let W, H, dots = [], scan = 0;
    function size() {
      const dpr = Math.min(2, w.devicePixelRatio || 1);
      W = cv.width = innerWidth * dpr; H = cv.height = innerHeight * dpr;
      cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px';
      const n = Math.min(150, Math.round(innerWidth * innerHeight / 16000));
      dots = [];
      for (let i = 0; i < n; i++) dots.push({ x: Math.random() * W, y: Math.random() * H, z: Math.random() * .8 + .2, s: Math.random() * 1.6 + .4 });
    }
    size(); addEventListener('resize', U.debounce(size, 250));
    let last = 0;
    function loop(t) {
      requestAnimationFrame(loop);
      if (t - last < 33) return;             // ~30fps 省電
      last = t;
      c.clearRect(0, 0, W, H);
      for (const d of dots) {
        d.y -= d.z * .35;
        if (d.y < 0) { d.y = H; d.x = Math.random() * W; }
        const a = .12 + d.z * .5;
        c.fillStyle = d.z > .7 ? `rgba(56,246,255,${a})` : `rgba(143,178,201,${a * .7})`;
        c.fillRect(d.x, d.y, d.s, d.s);
      }
      // 資料掃描光
      scan += 1.6;
      if (scan > H + 300) scan = -300;
      const g = c.createLinearGradient(0, scan - 120, 0, scan);
      g.addColorStop(0, 'rgba(56,246,255,0)'); g.addColorStop(1, 'rgba(56,246,255,.055)');
      c.fillStyle = g; c.fillRect(0, scan - 120, W, 120);
    }
    requestAnimationFrame(loop);
  }

  /* ══════ 選幣 ══════ */
  S.select = async function (sym) {
    if (!sym) return;
    const c = S.state.bySym.get(sym);
    if (!c) return;
    S.state.symbol = sym;
    S.state.cur = c;
    A.reset();
    S.chart.markers = [];
    S.ui.whale.count = 0;
    const tape = document.getElementById('whaleTape'); if (tape) tape.innerHTML = '<div class="empty">等待大額成交…</div>';
    S.ui.scan.render();
    U.text('#chartBadge', 'LIVE · ' + sym);

    const hasFut = !!(S.state.futuresSet && S.state.futuresSet.has(sym));
    S.stream.startSelected(sym, hasFut ? sym : null);

    const jobs = [
      S.api.klines(sym, S.chart.tf, 300).then(k => { if (k && S.state.symbol === sym) S.chart.setData(k); }),
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
    // Volume Profile（近 24 小時 1 小時 K 線近似）
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
      // 以 POC 為中心的加權標準差
      let sw = 0, swx = 0, swx2 = 0;
      for (let i = 0; i < NB; i++) { const p = lo + (hi - lo) * (i + .5) / NB; sw += bins[i]; swx += bins[i] * p; swx2 += bins[i] * p * p; }
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
    S.on('depth', d => { if (S.state.symbol) { A.Book.setWs(d); } });
    S.on('book-update', b => {
      S.heat.draw();
      const sp = document.getElementById('heatSpan');
      if (sp) sp.textContent = `深度 ${b.levels || 0} 檔 · 涵蓋中價 ±${((b.depthRange || 0) * 100).toFixed(3)}%`;
      const s = document.getElementById('hSkew');
      if (s) {
        const sk = b.skew || 0;
        s.textContent = (sk >= 0 ? '中價上方 ' : '中價下方 ') + Math.abs(sk).toFixed(3) + '%';
        s.style.color = sk >= 0 ? 'var(--rd)' : 'var(--gn)';
        s.title = '全部可見掛單的金額加權重心相對中價的位置：在中價上方代表上方賣壓較集中，下方代表買盤支撐較厚';
      }
    });
    S.on('liquidation', e => { A.Liq.add(e); S.ui.liq.add(e); });
    S.on('alert', a => S.ui.alerts.push(a));
    S.on('alert-clear', () => S.ui.alerts.clear());
    S.on('ws-state', st => S.ui.hud.pills(st));

    const map = {};
    S.on('miniTicker', arr => {
      let n = 0;
      for (const m of arr) {
        if (!m.s || !S.state.bySym.has(m.s)) continue;
        map[m.s] = { c: +m.c, o: +m.o, h: +m.h, l: +m.l, q: +m.q };
        n++;
      }
      S.state.tickMap = map;
    });

    document.getElementById('scanSearch').addEventListener('input', U.debounce(e => { S.ui.scan.q = e.target.value.trim(); S.ui.scan.render(); }, 180));
    document.getElementById('onlyFutures').addEventListener('change', e => { S.ui.scan.onlyFut = e.target.checked; S.ui.scan.render(); });
    document.getElementById('scanSort').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      S.ui.scan.sort = b.dataset.sort;
      Array.prototype.forEach.call(b.parentNode.children, x => x.classList.toggle('on', x === b));
      S.ui.scan.render();
    });
    document.getElementById('tfSeg').addEventListener('click', async e => {
      const b = e.target.closest('button'); if (!b) return;
      Array.prototype.forEach.call(b.parentNode.children, x => x.classList.toggle('on', x === b));
      S.chart.tf = b.dataset.tf;
      const k = await S.api.klines(S.state.symbol, S.chart.tf, 300);
      if (k) S.chart.setData(k);
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
      S.ui.whale.min = +b.dataset.min;
      S.ui.whale.renderNetflow();
    });
    document.getElementById('clearAlerts').addEventListener('click', () => A.anomaly.clear());

    // 鍵盤操作
    document.addEventListener('keydown', e => {
      if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); document.getElementById('scanSearch').focus(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const list = S.ui.scan.sorted(); if (!list.length) return;
        const i = list.findIndex(x => x.symbol === S.state.symbol);
        const n = i < 0 ? 0 : U.clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, list.length - 1);
        if (n !== i) { e.preventDefault(); S.select(list[n].symbol); const el = document.querySelector(`#scanBody tr[data-sym="${list[n].symbol}"]`); if (el) el.scrollIntoView({ block: 'nearest' }); }
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

  /* ══════ 定時任務 ══════ */
  function timers() {
    // 每 400ms：消化成交流（圖表標記 + 巨鯨面板）
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
    }, 400);

    // 每 1 秒：淨流向、清算統計、壓力分數、警報掃描、狀態
    setInterval(() => {
      // 分析（背景分頁也持續運算，只是不更新畫面）
      const ps = priceStats();
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
      // 壓力分數寫入浮動提示
      const b = document.querySelector(`#scanBody tr[data-sym="${S.state.symbol}"] .smbadge`);
      if (b) { b.title = '已完整分析：聰明錢壓力分數 ' + res.score + '（' + res.verdict + '）'; }
    }, 1000);

    // 圖表重繪（節流）
    setInterval(() => {
      const now = performance.now();
      if (drawDirty && now - lastDraw > 260) { lastDraw = now; drawDirty = false; S.chart.draw(); }
    }, 250);

    // 每 2.2 秒：訂單簿快照（熱圖與掛單牆的資料來源；背景分頁也持續抓取）
    setInterval(async () => {
      if (!S.state.ready) return;
      const d = await S.api.depth(S.state.symbol, 1000);
      if (d && A.Book) { A.Book.setRest(d); S.bookUI.render(A.Book); }
    }, 2200);

    // 每 8 秒：全市場輕量行情套用
    setInterval(() => {
      if (document.hidden || !S.state.tickMap) return;
      const n = S.ui.scan.patch(S.state.tickMap);
      const up = S.state.universe.filter(x => x.changePct > 0).length;
      S.ui.hud.breadth(up, S.state.universe.length - up, S.state.universe.length);
    }, 1500);

    // 每 20 秒：K 線刷新（主圖 + 1 分鐘量能掃描用；背景分頁也持續抓取）
    setInterval(async () => {
      if (!S.state.ready) return;
      const sym = S.state.symbol;
      const [k, k1] = await Promise.all([S.api.klines(sym, S.chart.tf, 300), S.api.klines(sym, '1m', 90)]);
      if (sym !== S.state.symbol) return;
      if (k) S.chart.setData(k);
      if (k1) oneMin = k1;
      refreshStats();
    }, 20000);

    // 每 15 秒：全市場 24H 統計（背景分頁時延長為每 60 秒，減少無謂請求）
    let uniTick = 0;
    setInterval(async () => {
      uniTick++;
      if (document.hidden && uniTick % 4 !== 0) return;
      const l = await S.api.universe();
      if (!l) return;
      S.state.universe = l;
      S.state.bySym = new Map(l.map(x => [x.symbol, x]));
      applyScores();
      S.ui.scan.setList(l);
      const up = l.filter(x => x.changePct > 0).length;
      S.ui.hud.breadth(up, l.length - up, l.length);
    }, 15000);

    // 每 10 分鐘：確認合約流與清算清單仍對應當前幣種/市場
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
      const msgs = [
        `即時流 ${st.selRate} 筆/秒 · 全市場行情 ${st.globRate} 則/秒 · 資料源 ${S.api.source || 'Binance'}`,
        `訂單簿熱圖已累積 ${A.Book.frames.length} 格（每格 2.2 秒）· 偵測到掛單牆 ${A.Book.walls.length} 道`,
        top ? `近 15 分鐘最大單筆：${top.symbol} ${top.side === 'buy' ? '主動買入' : '主動賣出'} $${U.money(top.notional)} @ ${U.px(top.price)}` : '近 15 分鐘未出現 ≥25 萬美元大額單筆',
        `清算監控中 · 近 15 分鐘清算總額 $${U.money(A.Liq.sum(900e3).total)} · 累計事件 ${S.ui.liq.count} 筆`,
        `壓力分數 ${S.state.lastSmart || '—'} · K 線 ${S.chart.k.length} 根 · 建議使用方向鍵切換幣種、按 / 搜尋`
      ];
      S.ui.hud.ticker(msgs[ti % msgs.length]);
    }, 5000);
  }

  /* ══════ 啟動 ══════ */
  async function main() {
    S.boot.start();
    starfield();
    S.chart.init(document.getElementById('chart'));
    S.heat.init(document.getElementById('heat'));
    S.gauge.init(document.getElementById('gauge'));
    S.oiChart.init(document.getElementById('oiChart'));
    S.bookUI.init();
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
    // 主要幣種清算流（Bybit 線性合約，取成交量前 24 個且有合約的幣種）
    S.api.bybitLinear().then(lin => {
      if (!lin) return;
      const majors = S.state.universe.filter(x => lin.has(x.symbol)).slice(0, 100).map(x => x.symbol);
      if (majors.length) S.stream.startLiquidations(majors);
    });
    await S.select(start);
    S.boot.prog(80);

    // 背景輔助資料（不阻塞畫面）
    Promise.all([S.api.futures(), S.api.global(), S.api.mcapMap(), S.api.fng()]).then(([fm, g, m, f]) => {
      if (fm) { S.state.fundMap = fm; S.state.futuresSet = new Set(Object.keys(fm)); }
      if (m) S.state.mcapMap = m;
      applyScores();
      S.ui.scan.render();
      S.ui.hud.global(g, f);
      if (fm && S.state.futuresSet.has(S.state.symbol)) {
        S.stream.attachFutures(S.state.symbol);   // 合約清單到齊後補掛合約成交流
        loadPos(S.state.symbol);
      }
      S.boot.prog(95);
      S.boot.finish(`系統就緒 · ${S.state.universe.length} 個交易對 · 即時流已連線`);
    }).catch(() => S.boot.finish('系統就緒（部分輔助資料暫時無法取得）'));

    // 保險：無論如何 7 秒後關閉開機畫面
    setTimeout(() => S.boot.finish(), 7000);

    timers();
    // 每秒檢查資料流是否真的在動
    setTimeout(() => {
      const st = S.stream.stats();
      if (st.sel !== 'open' || st.selAge > 4000) {
        A.anomaly.push({ type: 'WS', sev: 'low', symbol: '系統', title: '即時流狀態', text: '成交明細資料流尚未收到資料，已自動切換備援資料源', });
      }
    }, 9000);
  }

  S.ready(main);
  // 全域診斷（供自動化檢查使用）
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
    flow: (() => {
      const b = A.Trades.buf, f = b.filter(x => x.market === 'futures').length;
      return {
        trades: b.length, futures: f, spot: b.length - f,
        maxNotional: Math.round(Math.max(0, ...b.map(x => x.notional))),
        over50k: b.filter(x => x.notional >= 50000).length,
        liqRaw: A.Liq.buf.length, liqBuf: A.Liq.buf.slice(-3).map(x => x.symbol + ' ' + x.side + ' $' + Math.round(x.notional))
      };
    })(),
    booted: document.getElementById('boot').classList.contains('done')
  });
})(window);
