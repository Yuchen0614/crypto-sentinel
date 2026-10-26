/* analytics.js — 量化分析核心
   Trades     : 成交流、巨鯨偵測、淨流向、CVD、VWAP
   Book       : 訂單簿不平衡、掛單牆生命週期、深度熱圖、價差/微觀價格
   Pos        : 未平倉量、資金費率、大戶多空比、主動買賣比
   Liquids    : 清算統計與串聯偵測
   Smart      : 聰明錢壓力分數（6 項即時指標加權）
   Anomaly    : 異常事件偵測（含冷卻去重）
*/
'use strict';
(function (w) {
  const S = w.SENTINEL, U = S.util, A = S.analytics = {};

  /* ══════════ 1. 成交流 ══════════ */
  const T = A.Trades = {
    buf: [],             // 近 20 分鐘的成交
    MAX: 9000,
    WHALE: 50000,
    seen: new Set(),
    cnt: { recv: 0, added: 0, dup: 0 },
    add(t) {
      if (!t || !isFinite(t.price) || !isFinite(t.qty)) return;
      this.cnt.recv++;
      const key = t.ts + '|' + t.price + '|' + t.qty + '|' + t.market;
      if (this.seen.has(key)) { this.cnt.dup++; return; }   // 同一幀重複推送去重
      this.seen.add(key);
      this.cnt.added++;
      if (this.seen.size > 20000) this.seen = new Set();
      this.buf.push(t);
      if (this.buf.length > this.MAX) this.buf.splice(0, this.buf.length - this.MAX);
      const cut = Date.now() - 20 * 60e3;
      if (this.buf.length && this.buf[0].ts < cut) {
        let i = 0; while (i < this.buf.length && this.buf[i].ts < cut) i++;
        if (i > 500) this.buf.splice(0, i);
      }
      S.emit('trade-new', t);
      this._scan(t);
    },
    reset() { this.buf = []; this.seen = new Set(); },
    window(ms) { const c = Date.now() - ms; const o = []; for (let i = this.buf.length - 1; i >= 0; i--) { if (this.buf[i].ts >= c) o.push(this.buf[i]); else break; } return o.reverse(); },
    netflow(ms) {
      let b = 0, s = 0, bn = 0, sn = 0, bc = 0, sc = 0;
      const arr = this.window(ms === undefined ? 300e3 : ms);
      for (const t of arr) { if (t.side === 'buy') { b += t.notional; bc++; } else { s += t.notional; sc++; } }
      for (const t of arr) if (t.notional >= this.WHALE) { if (t.side === 'buy') bn += t.notional; else sn += t.notional; }
      return { buy: b, sell: s, delta: b - s, total: b + s, buyCount: bc, sellCount: sc, whaleBuy: bn, whaleSell: sn, whaleDelta: bn - sn, ratio: (b + s) ? b / (b + s) : 0.5, n: arr.length };
    },
    vwap(ms) { const a = this.window(ms === undefined ? 3600e3 : ms); let pv = 0, v = 0; for (const t of a) { pv += t.price * t.qty; v += t.qty; } return v ? pv / v : NaN; },
    // 近期成交金額中位數（用來決定「大額」的相對門檻，讓不同價位的幣種都合理）
    medianNotional(ms) {
      const a = this.window(ms === undefined ? 300e3 : ms);
      if (a.length < 8) return NaN;
      const s = [];
      const step = Math.max(1, Math.floor(a.length / 1200));
      for (let i = 0; i < a.length; i += step) s.push(a[i].notional);
      return U.median(s);
    },
    large(minN, ms) {
      const a = this.window(ms === undefined ? 900e3 : ms);
      const o = a.filter(t => t.notional >= minN);
      o.sort((x, y) => y.ts - x.ts);
      return o;
    },
    // 每秒 CVD（累積主動買賣金額差）
    cvdSeries(secs, bucketMs) {
      secs = secs || 300; bucketMs = bucketMs || 1000;
      const now = Date.now(), n = Math.ceil(secs * 1000 / bucketMs);
      const out = new Array(n).fill(0);
      for (const t of this.buf) {
        const age = now - t.ts; if (age < 0 || age > secs * 1000) continue;
        const idx = n - 1 - Math.floor(age / bucketMs);
        if (idx >= 0 && idx < n) out[idx] += (t.side === 'buy' ? t.notional : -t.notional);
      }
      let acc = 0;
      return out.map(v => (acc += v, acc));
    },
    // 巨鯨爆發偵測：同一方向大單密集
    _scan(t) {
      if (t.notional < 250000) return;
      const w = this.window(20000).filter(x => x.notional >= 250000);
      const same = w.filter(x => x.side === t.side);
      if (same.length >= 3 && same.reduce((s, x) => s + x.notional, 0) >= 1.2e6) {
        S.analytics.anomaly.push({
          type: 'WHALE_BURST', sev: 'high', symbol: S.state.symbol,
          title: (t.side === 'buy' ? '巨鯨連續掃貨' : '巨鯨連續砸盤'),
          text: `20 秒內 ${same.length} 筆 ≥25 萬美元${t.side === 'buy' ? '主動買入' : '主動賣出'}，合計 $${U.money(same.reduce((s, x) => s + x.notional, 0))}`
        });
      }
    }
  };

  /* ══════════ 2. 訂單簿 ══════════ */
  const Bk = A.Book = {
    bids: [], asks: [],           // 目前最完整快照（REST 為底，WS 更新頂端）
    wsBids: [], wsAsks: [],
    mid: NaN, ts: 0, spread: NaN,
    imbHist: [],                  // {ts, imb, mid}
    frames: [],                   // 熱圖格（以「距中價相對距離」為共用座標）
    MAXF: 150, BINS: 96,
    span: 0,                      // 深度範圍（相對中價，僅隨快照變大，座標系保持穩定）
    depthRange: 0, levels: 0,
    wallMap: new Map(),           // 掛單牆生命週期
    walls: [],
    spoofs: [],
    setRest(d) {
      if (!d || !d.bids.length || !d.asks.length) return;
      this.bids = d.bids; this.asks = d.asks; this.ts = d.ts;
      this.levels = Math.min(d.bids.length, d.asks.length);
      const mid = (d.bids[0][0] + d.asks[0][0]) / 2;
      const half = Math.max(mid - d.bids[d.bids.length - 1][0], d.asks[d.asks.length - 1][0] - mid) / mid;
      this.depthRange = half;
      this.span = Math.max(this.span || 0, half * 1.02);
      this._recalc();
      this._frame();
    },
    setWs(d) {
      if (!d) return;
      this.wsBids = d.bids; this.wsAsks = d.asks;
      // 以 WS 頂端覆蓋 REST 前 20 檔
      if (this.bids.length > 20) {
        this.mergedBids = d.bids.concat(this.bids.slice(20));
        this.mergedAsks = d.asks.concat(this.asks.slice(20));
      } else { this.mergedBids = d.bids; this.mergedAsks = d.asks; }
      this.mid = (d.bids[0][0] + d.asks[0][0]) / 2;
      this.spread = d.asks[0][0] - d.bids[0][0];
      this.wsTs = d.ts;
    },
    _recalc() {
      if (!this.bids.length || !this.asks.length) return;
      this.mid = (this.bids[0][0] + this.asks[0][0]) / 2;
      this.spread = this.asks[0][0] - this.bids[0][0];
      const bt = this.mergedBids || this.bids, at = this.mergedAsks || this.asks;
      const seg = (a, from, to) => { let s = 0; for (let i = from; i < Math.min(to, a.length); i++) s += a[i][0] * a[i][1]; return s; };
      const b20 = seg(bt, 0, 20), a20 = seg(at, 0, 20);
      // 各區段買賣掛單金額（近端/中段/遠端）— 以「檔位」而非固定百分比切分，
      // 這樣 BTC（tick 0.01，1000 檔僅涵蓋 ±0.01%）與小幣都能一致解讀
      const segs = [
        { label: '近端 1–20 檔', bid: b20, ask: a20 },
        { label: '中段 21–200 檔', bid: seg(bt, 20, 200), ask: seg(at, 20, 200) },
        { label: '遠端 201–1000 檔', bid: seg(bt, 200, 1000), ask: seg(at, 200, 1000) }
      ].map(x => ({ label: x.label, bid: x.bid, ask: x.ask, imb: (x.bid + x.ask) ? (x.bid - x.ask) / (x.bid + x.ask) : 0 }));
      const bNear = b20 + segs[1].bid, aNear = a20 + segs[1].ask;
      const imb = (bNear + aNear) ? (bNear - aNear) / (bNear + aNear) : 0;
      this.metrics = { b20, a20, bNear, aNear, imb, segs, bTop: bt[0], aTop: at[0] };
      this.imbHist.push({ ts: Date.now(), imb, mid: this.mid });
      if (this.imbHist.length > 900) this.imbHist.splice(0, this.imbHist.length - 900);
      this._walls();
    },
    // 掛單牆：金額顯著高於同側中位數
    _walls() {
      const now = Date.now(), out = [], bt = this.mergedBids || this.bids, at = this.mergedAsks || this.asks;
      const scan = (arr, side) => {
        const n = Math.min(1000, arr.length); if (n < 40) return;
        const FROM = 10, vals = [], list = [];
        let sideTotal = 0;
        for (let i = 0; i < n; i++) sideTotal += arr[i][0] * arr[i][1];
        for (let i = FROM; i < n; i++) { const v = arr[i][0] * arr[i][1]; vals.push(v); list.push({ px: arr[i][0], qty: arr[i][1], notional: v, i }); }
        const med = U.median(vals) || 1;
        const spine = list.filter(x => x.notional > Math.max(med * 5, 150000));
        spine.sort((x, y) => y.notional - x.notional);
        spine.slice(0, 4).forEach(x => {
          const key = side + '@' + x.px;
          let e = this.wallMap.get(key);
          if (!e) { e = { side, px: x.px, first: now, last: now, peak: x.notional, notional: x.notional, dist: side === 'bid' ? (this.mid - x.px) / this.mid : (x.px - this.mid) / this.mid }; this.wallMap.set(key, e); }
          else { e.last = now; e.peak = Math.max(e.peak, x.notional); e.notional = x.notional; }
          e.multiple = +(x.notional / med).toFixed(1);
          e.share = sideTotal ? +(x.notional / sideTotal * 100).toFixed(2) : 0;   // 佔該側可見掛單總額比例
          e.levels = n;
          e.mid = this.mid;
          out.push(e);
        });
      };
      scan(bt, 'bid'); scan(at, 'ask');
      // 生命週期：消失的牆（快閃 = 疑似假掛單）
      for (const [key, e] of this.wallMap) {
        if (now - e.last > 9000) {
          const life = (e.last - e.first) / 1000;
          if (life < 45 && e.peak >= 120000) {
            this.spoofs.unshift({ px: e.px, side: e.side, life: +life.toFixed(1), peak: e.peak, ts: now, dist: e.dist });
            if (this.spoofs.length > 12) this.spoofs.pop();
            S.analytics.anomaly.push({
              type: 'SPOOF', sev: 'mid', symbol: S.state.symbol,
              title: '疑似假掛單（快閃牆）',
              text: `${e.side === 'bid' ? '買方' : '賣方'} ${U.px(e.px)} 掛單 $${U.money(e.peak)} 僅存在 ${life.toFixed(1)} 秒即撤單`
            });
          }
          this.wallMap.delete(key);
        }
      }
      out.sort((a, b) => b.notional - a.notional);
      this.walls = out.slice(0, 8);
    },
    // 熱圖：以中價為中心，±1.2% 範圍切成 96 個價位格
    _frame() {
      if (!this.bids.length || !this.asks.length) return;
      const N = this.BINS, span = this.span || 0.01;
      const lo = this.mid * (1 - span), hi = this.mid * (1 + span);
      const bin = new Float32Array(N);
      const add = (px, qty) => {
        if (px < lo || px > hi) return;
        const i = Math.min(N - 1, Math.floor((px - lo) / (hi - lo) * N));
        bin[i] += px * qty;
      };
      (this.mergedBids || this.bids).forEach(x => add(x[0], x[1]));
      (this.mergedAsks || this.asks).forEach(x => add(x[0], x[1]));
      let mx = 0; for (const v of bin) if (v > mx) mx = v;
      this.frames.push({ ts: Date.now(), mid: this.mid, lo, hi, bin, mx });
      if (this.frames.length > this.MAXF) this.frames.splice(0, this.frames.length - this.MAXF);
      // 掛單重心：全部掛單金額的加權中心相對中價的位置（正 = 重心在中價上方 = 上方賣壓較重）
      let cp = 0, cv = 0;
      for (let i = 0; i < N; i++) { const px = lo + (hi - lo) * (i + .5) / N; cp += px * bin[i]; cv += bin[i]; }
      this.skew = cv ? ((cp / cv) - this.mid) / this.mid * 100 : 0;
      this.maxNotional = mx;
      S.emit('book-update', this);
    },
    reset() { this.bids = []; this.asks = []; this.mergedBids = null; this.mergedAsks = null; this.wallMap = new Map(); this.frames = []; this.imbHist = []; this.spoofs = []; this.walls = []; this.span = 0; this.depthRange = 0; }
  };

  /* ══════════ 3. 持倉結構 ══════════ */
  const P = A.Pos = {
    data: null, signals: [], out: null,
    set(d, closeSeries, klineTf) {
      if (!d) return;
      this.data = d; this.closeSeries = closeSeries || this.closeSeries;
      this.compute();
    },
    compute() {
      const d = this.data; if (!d) return;
      const out = this.out = {};
      const last = a => a && a.length ? a[a.length - 1] : null;
      const at = (a, k) => a && a.length > k ? a[a.length - 1 - k] : (a && a.length ? a[0] : null);

      const tp = last(d.topPosition), ta = last(d.topAccount), ga = last(d.globalAccount), tk = last(d.taker);
      out.topLongFrac = tp ? tp.long : NaN;                       // 大戶多方持倉占比
      out.topRatioNow = tp ? tp.v : NaN;                          // 大戶持倉多空比
      out.topRatioPrev = (at(d.topPosition, 12) || {}).v;
      out.topAccountRatio = ta ? ta.v : NaN;
      out.globalRatio = ga ? ga.v : NaN;
      out.globalPrev = (at(d.globalAccount, 12) || {}).v;
      out.takerRatio = tk ? (tk.buy / (tk.buy + tk.sell || 1)) : NaN;
      out.takerPrev = (() => { const x = at(d.taker, 12); return x && (x.buy + x.sell) ? x.buy / (x.buy + x.sell) : NaN; })();
      out.oiNow = d.oiNow;
      if (d.oiHist && d.oiHist.length > 2) {
        const a = d.oiHist;
        out.oiSeries = a.map(x => x.val || x.oi);
        out.oiTimes = a.map(x => x.t);
        const n = a.length;
        out.oi1h = n >= 13 ? (a[n - 1].val / a[n - 13].val - 1) * 100 : NaN;
        out.oi5m = n >= 2 ? (a[n - 1].val / a[n - 2].val - 1) * 100 : NaN;
        out.oi15m = n >= 4 ? (a[n - 1].val / a[n - 4].val - 1) * 100 : NaN;
        out.oi4h = n >= 48 ? (a[n - 1].val / a[n - 48].val - 1) * 100 : NaN;
      }
      out.funding = d.funding;
    },
    // 價格 × 持倉 × 資金費率的聯合訊號
    signalsFor(priceStats) {
      const o = this.out || {}, sig = [], L = (cls, fn, txt) => sig.push({ cls, fn, txt });
      const pc = priceStats || {};
      if (isFinite(o.topRatioNow)) {
        const d12 = isFinite(o.topRatioPrev) ? (o.topRatioNow - o.topRatioPrev) : 0;
        if (o.topRatioNow > 1.6) L('bear', '大戶多空比偏高', `大戶持倉多空比 <b>${o.topRatioNow.toFixed(2)}</b>，槓桿多方擁擠${d12 > 0.15 ? '且持續加碼' : ''}，回檔風險升高`);
        else if (o.topRatioNow < 0.7) L('bull', '大戶多空比偏低', `大戶持倉多空比 <b>${o.topRatioNow.toFixed(2)}</b>，空方擁擠，容易出現軋空`);
        if (Math.abs(d12) > 0.12) L(d12 > 0 ? 'bull' : 'bear', '大戶部位快速調整', `近 1 小時大戶多空比變化 <b>${d12 > 0 ? '+' : ''}${d12.toFixed(2)}</b>，${d12 > 0 ? '偏多方向增持' : '偏空方向增持'}`);
        if (isFinite(o.globalRatio) && isFinite(o.topRatioNow)) {
          const gap = o.topRatioNow - o.globalRatio;
          if (Math.abs(gap) > 0.5) L(gap > 0 ? 'bull' : 'bear', '大戶與散戶方向分歧', `大戶比 <b>${o.topRatioNow.toFixed(2)}</b> vs 散戶比 <b>${o.globalRatio.toFixed(2)}</b>，${gap > 0 ? '大戶偏多、散戶偏空（歷史上偏多訊號）' : '大戶偏空、散戶偏多（需警戒）'}`);
        }
      }
      if (isFinite(o.funding)) {
        const ann = o.funding * 3 * 365 * 100;
        if (o.funding > 0.0005) L('warn', '資金費率偏高', `資金費率 <b>${(o.funding * 100).toFixed(4)}%</b>（年化約 ${ann.toFixed(0)}%），多方付費給空方，追多成本高`);
        else if (o.funding < -0.0005) L('warn', '資金費率為負', `資金費率 <b>${(o.funding * 100).toFixed(4)}%</b>（年化約 ${ann.toFixed(0)}%），空方付費，空頭擁擠`);
        else L('', '資金費率中性', `資金費率 <b>${(o.funding * 100).toFixed(4)}%</b>，市場情緒平衡`);
      }
      if (isFinite(o.oi1h) && isFinite(pc.h1)) {
        if (o.oi1h > 3 && Math.abs(pc.h1) < 0.8) L('warn', '持倉異常堆積', `未平倉量 1 小時增加 <b>${o.oi1h.toFixed(1)}%</b> 但價格僅 ${U.pct(pc.h1)}，槓桿在區間內堆疊，容易出現單邊急殺/急拉`);
        if (o.oi1h > 3 && pc.h1 > 1.5) L('bull', '價漲量增（多頭續勢）', `價格 +${pc.h1.toFixed(2)}% 且 OI +${o.oi1h.toFixed(1)}%，新資金進場推升`);
        if (o.oi1h > 3 && pc.h1 < -1.5) L('bear', '價跌量增（空方主導）', `價格 ${pc.h1.toFixed(2)}% 且 OI +${o.oi1h.toFixed(1)}%，空方新建倉下壓`);
        if (o.oi1h < -3 && pc.h1 < -1) L('bull', '價跌減倉（去槓桿）', `價格下跌但 OI 減少 ${o.oi1h.toFixed(1)}%，屬被動平倉而非新增賣壓`);
      }
      if (isFinite(o.takerRatio) && isFinite(pc.h1)) {
        const above = o.takerRatio > 0.52, priceUp = pc.h1 > 0;
        if (above && !priceUp) L('bull', '主動買盤背離', `主動買賣比 <b>${(o.takerRatio * 100).toFixed(1)}%</b> 偏買，但價格 1 小時 ${U.pct(pc.h1)}，疑似有資金承接`);
        if (!above && priceUp) L('bear', '主動賣盤背離', `價格上漲但主動買賣比僅 <b>${(o.takerRatio * 100).toFixed(1)}%</b>，漲勢缺乏主動買盤支撐`);
      }
      this.signals = sig;
      return sig;
    }
  };
  let K;

  /* ══════════ 4. 清算流 ══════════ */
  const Lq = A.Liq = {
    buf: [],
    add(e) {
      if (!e || !isFinite(e.notional)) return;
      this.buf.push(e);
      if (this.buf.length > 600) this.buf.splice(0, this.buf.length - 600);
      const cut = Date.now() - 30 * 60e3;
      if (this.buf.length && this.buf[0].ts < cut) { let i = 0; while (i < this.buf.length && this.buf[i].ts < cut) i++; if (i > 200) this.buf.splice(0, i); }
      S.emit('liq-new', e);
      this._scan();
    },
    sum(ms) {
      const c = Date.now() - ms; let l = 0, s = 0, ln = 0, sn = 0;
      for (let i = this.buf.length - 1; i >= 0; i--) { const x = this.buf[i]; if (x.ts < c) break; if (x.side === 'long') { l += x.notional; ln++; } else { s += x.notional; sn++; } }
      return { long: l, short: s, total: l + s, ln, sn, ratio: (l + s) ? l / (l + s) : 0.5, net: s - l };
    },
    _scan() {
      const m = this.sum(60000);
      if (m.total >= 1.5e6 && Date.now() - (this._lastAlert || 0) > 45000) {
        this._lastAlert = Date.now();
        S.analytics.anomaly.push({
          type: 'LIQ_CASCADE', sev: 'high', symbol: '全市場',
          title: (m.long > m.short ? '多單清算潮' : '空單清算潮'),
          text: `近 1 分鐘清算總額 $${U.money(m.total)}（多 $${U.money(m.long)} / 空 $${U.money(m.short)}），${m.long > m.short ? '多頭被強制平倉' : '空頭被軋平'}`
        });
      }
    }
  };

  /* ══════════ 5. 聰明錢壓力分數 ══════════ */
  A.smart = function (ctx) {
    const t = ctx.trades, b = ctx.book, p = ctx.pos, lq = ctx.liq, price = ctx.price, klines = ctx.klines || [];
    const comps = [];
    const add = (key, label, v, detail) => comps.push({ key, label, v: U.clamp(v, -1, 1), detail });

    // 1) 巨鯨淨流向（近 5 分鐘，以 15 分鐘平均大單量級歸一化）
    const nf5 = t.netflow(300e3), nf15 = t.netflow(900e3);
    const scale = Math.max(200000, (Math.abs(nf15.whaleBuy) + Math.abs(nf15.whaleSell)) / 2);
    /* 壓力計每條的明細只給約 100px 寬（單行截斷），所以文字要短；
       完整說明放在元素的 title，hover 就看得見。 */
    add('whale', '巨鯨淨流向 5M', nf5.whaleDelta / (scale * 2),
      `買 $${U.money(nf5.whaleBuy)} · 賣 $${U.money(nf5.whaleSell)}`);

    // 2) CVD 斜率（近期動能）
    const cvd = t.cvdSeries(300, 5000);
    let cs = 0;
    if (cvd.length > 3) {
      const d = cvd[cvd.length - 1] - cvd[0];
      const noise = Math.abs(cvd[Math.floor(cvd.length / 2)] - cvd[0]) * 2 + 200000;
      cs = d / (Math.abs(d) + noise);
    }
    add('cvd', 'CVD 累積斜率', cs * 1.6, `5M 淨主動 ${U.signed(cvd.length ? cvd[cvd.length - 1] : 0, v => '$' + U.money(v))}`);

    // 3) 訂單簿買賣壓力
    const imb = (b.metrics && b.metrics.imb) || 0;
    add('book', '訂單簿買賣壓力', imb * 1.5,
      `前20 買 ${U.money(b.metrics ? b.metrics.b20 : 0)} · 賣 ${U.money(b.metrics ? b.metrics.a20 : 0)}`);

    // 4) 大戶持倉方向
    let tp = 0, tpTxt = '無合約資料';
    if (p.out && isFinite(p.out.topRatioNow)) {
      const dev = Math.log(p.out.topRatioNow) / Math.log(2);      // ratio>1 → 正
      const chg = isFinite(p.out.topRatioPrev) ? (p.out.topRatioNow - p.out.topRatioPrev) * 1.4 : 0;
      tp = U.clamp(dev * 0.5 + chg, -1, 1);
      tpTxt = `多空比 ${p.out.topRatioNow.toFixed(2)}${isFinite(p.out.topRatioPrev) ? `（1H ${(p.out.topRatioNow - p.out.topRatioPrev >= 0 ? '+' : '')}${(p.out.topRatioNow - p.out.topRatioPrev).toFixed(2)}）` : ''}`;
    }
    add('top', '大戶部位方向', tp, tpTxt);

    // 5) 槓桿結構（資金費率 + OI 與價格一致性）
    let lev = 0, levTxt = '無合約資料';
    if (p.out && isFinite(p.out.funding)) {
      const f = U.clamp(-p.out.funding / 0.0006, -1, 1);          // 正費率 → 偏空壓力（追多成本）
      const oiC = isFinite(p.out.oi1h) ? p.out.oi1h : 0;
      const pxC = isFinite(ctx.priceStats && ctx.priceStats.h1) ? ctx.priceStats.h1 : 0;
      const agree = (oiC > 0 && pxC > 0) ? 0.35 : (oiC > 0 && pxC < 0 ? -0.35 : 0);
      lev = U.clamp(f * 0.45 + agree, -1, 1);
      levTxt = `費率 ${(p.out.funding * 100).toFixed(4)}% · OI ${isFinite(p.out.oi1h) ? U.pct(p.out.oi1h) : '—'}`;
    }
    add('lev', '槓桿結構', lev, levTxt);

    // 6) 價格動能（相對 VWAP 與短均線斜率）
    let mom = 0, momTxt = '—';
    const vw = t.vwap(1800e3);
    if (klines.length > 24 && isFinite(price)) {
      const closes = klines.slice(-24).map(k => k.c);
      const sl = U.slope(closes, 24) / (price || 1) * 24 * 30;    // 歸一化
      const vwapDev = isFinite(vw) ? (price - vw) / vw * 25 : 0;
      mom = U.clamp(sl * 0.6 + vwapDev * 0.6, -1, 1);
      momTxt = `30M VWAP ${U.px(vw)}`;
    }
    add('mom', '價格動能', mom, momTxt);

    // 7) 清算偏向（空頭被軋 = 助力上漲）
    const lq15 = lq.sum(900e3);
    const lqv = lq15.total > 50000 ? U.clamp(lq15.net / (lq15.total * 1.5), -1, 1) : 0;
    add('liq', '清算方向壓力', lqv, lq15.total > 0 ? `15M $${U.money(lq15.total)} · 多 $${U.money(lq15.long)} / 空 $${U.money(lq15.short)}` : '近 15 分無顯著清算');

    const W = { whale: .2, cvd: .18, book: .14, top: .18, lev: .12, mom: .1, liq: .08 };
    let sum = 0, wsum = 0;
    comps.forEach(c => { const w = W[c.key] || 0; sum += c.v * w; wsum += w; });
    const norm = wsum ? sum / wsum : 0;
    const score = Math.round(50 + norm * 50);
    let verdict = '中性觀望', cls = 'neu';
    if (score >= 74) { verdict = '強力吸籌／偏多'; cls = 'bull'; }
    else if (score >= 60) { verdict = '偏多'; cls = 'bull'; }
    else if (score >= 55) { verdict = '微幅偏多'; cls = 'bull'; }
    else if (score > 45) { verdict = '中性觀望'; cls = 'neu'; }
    else if (score > 40) { verdict = '微幅偏空'; cls = 'bear'; }
    else if (score > 26) { verdict = '偏空'; cls = 'bear'; }
    else { verdict = '強力派發／偏空'; cls = 'bear'; }

    // 綜合結論文字
    const best = comps.slice().sort((a, b) => Math.abs(b.v) - Math.abs(a.v)).slice(0, 2).filter(c => Math.abs(c.v) > 0.15);
    const note = best.length
      ? `主要驅動：${best.map(c => `${c.label}（${c.detail}）`).join('、')}。分數為 7 項即時指標加權結果，反映當下資金與掛單結構，非買賣建議。`
      : '各項指標皆接近中性，市場缺乏明確方向，建議等待量能與持倉結構進一步變化。';
    return { score, verdict, cls, comps, note, norm };
  };

  /* ══════════ 6. 異常事件偵測 ══════════ */
  const An = A.anomaly = {
    list: [], cd: new Map(),
    push(a) {
      if (!a) return;
      const key = a.type + '|' + (a.symbol || '') + '|' + (a.title || '');
      const last = this.cd.get(key) || 0;
      const cooldown = a.sev === 'high' ? 60000 : a.sev === 'mid' ? 120000 : 300000;
      if (Date.now() - last < cooldown) return;
      this.cd.set(key, Date.now());
      a.ts = a.ts || Date.now();
      a.id = key + '|' + a.ts;
      this.list.unshift(a);
      if (this.list.length > 120) this.list.pop();
      S.emit('alert', a);
    },
    clear() { this.list = []; this.cd.clear(); S.emit('alert-clear'); },
    // 價格與量能的即時掃描（由 app 每秒呼叫）
    scanPrice(price, buf) {
      if (!buf || buf.length < 20) return;
      const now = Date.now(), win = buf.filter(x => x.t >= now - 60000);
      if (win.length > 4) {
        const first = win[0].c, last = win[win.length - 1].c;
        const chg = (last / first - 1) * 100;
        if (Math.abs(chg) >= 2) {
          this.push({
            type: 'PRICE_SPIKE', sev: Math.abs(chg) >= 4 ? 'high' : 'mid', symbol: S.state.symbol,
            title: chg > 0 ? '急漲' : '急跌',
            text: `1 分鐘內價格變動 ${U.pct(chg)}（${U.px(first)} → ${U.px(last)}）`
          });
        }
      }
      // 量能爆量：最近 3 根 1 分鐘量 vs 前 30 根中位數
      if (buf.length > 34) {
        const vols = buf.slice(-31, -1).map(k => k.q);
        const med = U.median(vols) || 1;
        const last3 = buf.slice(-3).reduce((s, k) => s + k.q, 0) / 3;
        if (last3 > med * 5 && last3 > 300000) {
          this.push({
            type: 'VOL_SPIKE', sev: 'mid', symbol: S.state.symbol,
            title: '成交量異常放大',
            text: `近 3 分鐘均量為前 30 分鐘中位數的 ${(last3 / med).toFixed(1)} 倍（${U.usd(last3)} / 分）`
          });
        }
      }
    },
    scanBook(b) {
      if (!b.metrics) return;
      const imb = b.metrics.imb;
      if (Math.abs(imb) > 0.42) {
        const side = imb > 0 ? '買方' : '賣方';
        this.push({
          type: 'BOOK_SKEW', sev: 'low', symbol: S.state.symbol,
          title: `${side}掛單明顯佔優`,
          text: `前 20 檔不平衡度 ${(imb * 100).toFixed(1)}%（買 ${U.usd(b.metrics.b20)} / 賣 ${U.usd(b.metrics.a20)}）`
        });
      }
      b.spoofs.slice(0, 1).forEach(s => { /* 已在 Book 內推播 */ });
    }
  };

  A.reset = () => { T.reset(); Bk.reset(); Lq.buf = []; P.data = null; P.out = null; P.signals = []; };
})(window);
