/* chart.js — 全部 Canvas 繪圖：主圖表（K線/CVD/量能/VWAP/掛單牆）、深度熱圖、壓力計、OI 走勢 */
'use strict';
(function (w) {
  const S = w.SENTINEL, U = S.util;

  /* Canvas 尺寸適配：實作在 util.js（S.fit），本頁直接沿用，避免兩份實作 */
  const fit = S.fit;

  /* ══════════════ 主圖表 ══════════════ */
  const MIN_BARS = 12;    /* 縮放下限：最少可見 12 根 */
  const DEF_BARS = 150;   /* 預設視圖（自動 fit）基準根數 */
  /* 時間軸刻度間距候選（根數），取第一個塞得下的，避免標籤互疊 */
  const NICE = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 40, 60, 90, 120, 180, 240, 360, 480, 720, 1440, 2880, 10080, 20160, 43200];

  const Ch = S.chart = {
    canvas: null, k: [], tf: '5m',
    ov: { cvd: true, vol: true, vwap: false, walls: true },
    price: NaN, walls: [], lastDelta: [], hover: null,
    markers: [], reveal: 1, _rv: null,

    /* 視圖：vw.start＝最左可見 K 線索引（浮點，可為負＝左側留白）；vw.count＝可見根數。
       縮放＝改 count、平移＝改 start，兩者都是「資料索引」而非像素，
       所以視窗尺寸改變後視圖仍然指向同一段 K 線。 */
    vw: { start: 0, count: DEF_BARS },
    follow: true,                 /* 跟隨最新價模式（右緣貼著最新一根） */
    redraws: 0, resizeDraws: 0,   /* 重繪次數計數（供自動化量測） */
    drag: null, kbOn: false,
    _yr: null, _yFrozen: 0, _yTimer: 0,
    _viewKey: '', _viewInit: false,

    /* ═══ 資料 ═══ */
    setData(k, animate) {
      this.k = k || [];
      this.series();
      this.syncView();
      this._yr = null;                       /* 資料換了 → 價格範圍重算 */
      if (animate) { this.reveal = 0; this.revealAt = performance.now(); this.startReveal(); }
      else { this.reveal = 1; if (this._rv) { cancelAnimationFrame(this._rv); this._rv = null; } }
      this.draw();
    },
    startReveal() {
      if (this._rv) cancelAnimationFrame(this._rv);
      const step = () => {
        const p = U.clamp((performance.now() - this.revealAt) / 520, 0, 1);
        this.reveal = 1 - Math.pow(1 - p, 3);
        this.draw();
        this._rv = p < 1 ? requestAnimationFrame(step) : null;
      };
      this._rv = requestAnimationFrame(step);
    },
    setPrice(p) {
      this.price = p;
      if (this.k.length) {
        const c = this.k[this.k.length - 1];
        c.c = p; c.h = Math.max(c.h, p); c.l = Math.min(c.l, p);
      }
    },
    series() {
      // 依 K 線的主動買賣差累積出 CVD
      let acc = 0; this.cvd = this.k.map(k => (acc += (k.delta || 0), acc));
      this.vols = this.k.map(k => k.q || k.c * k.v || 0);
    },
    sym() { return (S.state && S.state.symbol) || 'UNKNOWN'; },
    viewKey() { return this.sym() + '.' + this.tf; },

    /* 換交易對／週期 → 回到預設 fit；載入後第一次 → 還原上次視圖（見 saveView/loadView） */
    syncView() {
      const key = this.viewKey(), n = this.k.length;
      if (!this._viewInit) { this._viewInit = true; this._viewKey = key; this.loadView(); }
      else if (key !== this._viewKey) { this._viewKey = key; this.fit(); }
      if (this.follow) this.vw.start = Math.max(0, n - this.vw.count);
      this.clampView();
    },
    clampView() {
      const n = this.k.length;
      this.vw.count = this._clampCount(this.vw.count);
      /* 縮到「全部資料」時就整段對齊左緣，右側不留空白區 */
      this.vw.start = this.vw.count >= n - 0.5 ? 0 : this._clampStart(this.vw.start);
    },
    _clampCount(c) {
      const n = this.k.length;
      if (n <= MIN_BARS) return Math.max(1, n);
      return U.clamp(c, MIN_BARS, n);          /* 上限＝全部資料（不縮到看不到 K 線） */
    },
    _clampStart(s) {
      const n = this.k.length, c = this.vw.count;
      if (n <= MIN_BARS) return 0;
      /* 左緣最多看到只剩 MIN_BARS 根；右緣最多留一小段未來空白（不讓 K 線被擠到最左邊） */
      const maxE = n + Math.min(c * 0.1, 12);
      return U.clamp(s, MIN_BARS - c, maxE - c);
    },
    atLiveEdge() {
      const n = this.k.length, E = this.vw.start + this.vw.count;
      return E >= n - 0.5 && E <= n + 0.5;      /* 右緣正好貼著最新一根 */
    },
    /* 預設視圖：資料少於 DEF_BARS 就全部顯示，否則顯示最近 DEF_BARS 根 */
    fit() {
      const n = this.k.length;
      this.vw.count = this._clampCount(Math.min(n, DEF_BARS));
      this.vw.start = Math.max(0, n - this.vw.count);
      this.follow = true;
    },
    goLive() {
      this.follow = true;
      this.vw.start = Math.max(0, this.k.length - this.vw.count);
      this._yr = null; this.emitView(); this.draw();
    },

    /* ═══ 縮放（以游標為錨點）═══ */
    zoomAt(px, factor) {
      const L = this.layout(); if (!L || !this.k.length) return;
      const w = L.x1 - L.x0; if (w <= 0) return;
      const c0 = this.vw.count, c1 = this._clampCount(c0 * factor);
      if (Math.abs(c1 - c0) < 1e-9) return;
      const r = U.clamp((px - L.x0) / w, -1, 2);
      const anchor = this.vw.start + r * c0;          /* 游標下的 K 線索引（縮放前） */
      this.freezeY();                                  /* 凍結「縮放前」的價格軸 → 游標下的價位也不跑 */
      this.vw.count = c1;
      /* 錨定：同一根 K 線留在同一像素；縮到全部資料時整段對齊左緣 */
      this.vw.start = c1 >= this.k.length - 0.5 ? 0 : this._clampStart(anchor - r * c1);
      this.follow = this.atLiveEdge();
      this.emitView(); this.draw();
    },
    zoomKey(f) {
      const L = this.layout(); if (!L) return;
      this.zoomAt((L.x0 + L.x1) / 2, f);
    },
    /* 縮放進行中凍結價格軸（避免價格軸邊縮邊跳），停止操作 260ms 後平滑重 fit */
    freezeY() {
      const L = this.layout(); if (!L) return;
      if (!this._yFrozen) { this._yr = this._yr || this.autoRange(L); this._yFrozen = 1; }
      clearTimeout(this._yTimer);
      this._yTimer = setTimeout(() => this.releaseY(), 260);
    },
    releaseY() {
      clearTimeout(this._yTimer);
      if (!this._yFrozen) { this._yr = null; return; }
      this._yFrozen = 0;
      const L = this.layout(); if (!L || !this._yr || !this.k.length) { this._yr = null; this.draw(); return; }
      const from = { mn: this._yr.mn, mx: this._yr.mx }, to = this.autoRange(L);
      /* 若凍結的價格軸仍涵蓋可見 K 線、且留白不過多，就整個保留（縮放後游標下的價位才不會跑掉）；
         只有「縮出去露出更遠的價位」或「縮太近、上下留白過多」才平滑重 fit。 */
      const span = (from.mx - from.mn) || 1;
      const clipped = to.mn < from.mn - span * 0.01 || to.mx > from.mx + span * 0.01;
      const sparse = (to.mx - to.mn) < span * 0.55;
      if (!clipped && !sparse) { this.draw(); return; }
      const t0 = performance.now();
      const step = () => {
        const p = U.clamp((performance.now() - t0) / 200, 0, 1), e = 1 - Math.pow(1 - p, 3);
        this._yr = { mn: from.mn + (to.mn - from.mn) * e, mx: from.mx + (to.mx - from.mx) * e };
        this.draw();
        if (p < 1) requestAnimationFrame(step); else this._yr = null;
      };
      requestAnimationFrame(step);
    },

    /* ═══ 平移 ═══ */
    panBy(dx) {
      const L = this.layout(); if (!L || !this.k.length) return;
      const w = L.x1 - L.x0; if (w <= 0) return;
      if (this.vw.count >= this.k.length - 0.5) { this.vw.start = 0; this.follow = true; return; }   /* 已顯示全部 → 無處可平移 */
      this.vw.start = this._clampStart(this.vw.start - dx / w * this.vw.count);
      this._yr = null;                        /* 價格軸跟著可見範圍重新 fit（標籤會變） */
      this.follow = this.atLiveEdge();
      this.emitView(); this.draw();
    },
    panBars(d) {
      this.vw.start = this._clampStart(this.vw.start + d);
      this._yr = null; this.follow = this.atLiveEdge();
      this.emitView(); this.draw();
    },

    /* ═══ 時間 ↔ 索引（繪圖錨點用：時間＋價格，不是像素）═══ */
    timeToIdx(t) {
      const k = this.k, n = k.length, ms = this.tfMs();
      if (!n) return 0;
      if (t <= k[0].t) return (t - k[0].t) / ms;         /* 左側留白區也給得出索引 */
      const last = k[n - 1];
      if (t >= last.t) return (n - 1) + (t - last.t) / ms;
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (k[m].t <= t) lo = m; else hi = m; }
      const d = k[hi].t - k[lo].t || ms;
      return lo + (t - k[lo].t) / d;
    },
    idxToTime(f) {
      const k = this.k, n = k.length, ms = this.tfMs();
      if (!n) return Date.now();
      if (f <= 0) return k[0].t + f * ms;
      if (f >= n - 1) return k[n - 1].t + (f - (n - 1)) * ms;
      const i = Math.floor(f), r = f - i;
      return k[i].t + (k[i + 1].t - k[i].t) * r;
    },

    /* ═══ 版面與座標換算 ═══ */
    layout(W, H) {
      if (!this.canvas) return null;
      if (W === undefined) {
        const r = this.canvas.getBoundingClientRect(); W = r.width; H = r.height;
        if (r.bottom < -400 || W < 20 || H < 20) return null;
      }
      const padR = 62, padL = 8, padT = 10, axisH = 18;
      const volH = Math.round((H - padT - axisH) * (this.ov.vol || this.ov.cvd ? 0.26 : 0.001));
      const priceH = H - padT - axisH - volH - (volH > 4 ? 6 : 0);
      return { W, H, x0: padL, x1: W - padR, y0: padT, y1: padT + priceH, vy0: padT + priceH + 6, vy1: H - axisH, padR };
    },
    /* 價格軸範圍：只用「可見範圍」內的 K 線（含掛單牆／現價／VWAP）*/
    autoRange(L) {
      L = L || this.layout();
      const k = this.k, n = k.length, v = this.visRange();
      let mn = Infinity, mx = -Infinity;
      for (let i = v.i0; i <= v.i1; i++) { const b = k[i]; if (!b) continue; if (b.l < mn) mn = b.l; if (b.h > mx) mx = b.h; }
      if (!isFinite(mn) || !isFinite(mx)) { mn = 0; mx = 1; }
      if (this.ov.walls) this.walls.forEach(wl => { if (isFinite(wl.px)) { if (wl.px < mn) mn = wl.px; if (wl.px > mx) mx = wl.px; } });
      if (isFinite(this.price)) { mn = Math.min(mn, this.price); mx = Math.max(mx, this.price); }
      const pad = (mx - mn) * 0.06 || Math.abs(mx) * 0.001 || 1;
      mn -= pad; mx += pad;
      if (this.ov.vwap) { const vw = S.analytics.Trades.vwap(1800e3); if (isFinite(vw)) { mn = Math.min(mn, vw); mx = Math.max(mx, vw); } }
      return { mn, mx };
    },
    rangeOf(L) { return this._yr || this.autoRange(L || this.layout()); },
    pxOfIdx(i, L) { L = L || this.layout(); return L.x0 + (i - this.vw.start) / this.vw.count * (L.x1 - L.x0); },
    idxOfPx(px, L) { L = L || this.layout(); return this.vw.start + (px - L.x0) / (L.x1 - L.x0) * this.vw.count; },
    pyOfPrice(p, L, R) { L = L || this.layout(); R = R || this.rangeOf(L); return L.y1 - (p - R.mn) / ((R.mx - R.mn) || 1) * (L.y1 - L.y0); },
    priceOfPy(py, L, R) { L = L || this.layout(); R = R || this.rangeOf(L); return R.mn + (L.y1 - py) / (L.y1 - L.y0) * (R.mx - R.mn); },
    visRange() {
      const n = this.k.length;
      const i0 = U.clamp(Math.floor(this.vw.start), 0, Math.max(0, n - 1));
      const i1 = U.clamp(Math.ceil(this.vw.start + this.vw.count - 1), 0, Math.max(0, n - 1));
      return { i0, i1, n: Math.max(0, i1 - i0 + 1) };
    },
    /* 供自動化量測：目前視圖與座標換算 */
    metrics() {
      const L = this.layout(); if (!L) return null;
      const R = this.rangeOf(L), v = this.visRange();
      return {
        symbol: this.sym(), tf: this.tf, key: this.viewKey(),
        start: +this.vw.start.toFixed(3), count: +this.vw.count.toFixed(3),
        bars: this.k.length, visible: v.n, follow: this.follow,
        mn: R.mn, mx: R.mx, x0: L.x0, x1: L.x1, y0: L.y0, y1: L.y1,
        drawn: this.redraws, resizeDraws: this.resizeDraws, frozen: !!this._yFrozen
      };
    },

    /* ═══ 繪製 ═══ */
    draw() {
      const f = fit(this.canvas); if (!f) return;
      const { c, w: W, h: H } = f;
      c.clearRect(0, 0, W, H);
      this.redraws++;
      if (!this.k.length) {
        c.fillStyle = 'rgba(140,180,205,.5)'; c.font = '11px monospace';
        c.fillText('載入 K 線資料…', 12, 22); return;
      }
      const L = this.layout(W, H);
      const R = this._yr || this.autoRange(L);
      const x0 = L.x0, x1 = L.x1, y0 = L.y0, y1 = L.y1, vy0 = L.vy0, vy1 = L.vy1;
      const v = this.visRange();
      const rev = (this.reveal === undefined ? 1 : this.reveal);
      const X = i => x0 + (i - this.vw.start) / this.vw.count * (x1 - x0) * rev;
      const Y = p => y1 - (p - R.mn) / ((R.mx - R.mn) || 1) * (y1 - y0);
      const pxBar = (x1 - x0) / this.vw.count;
      const bw = Math.max(1.2, pxBar * 0.62);

      /* 背景網格：價格（右軸）＋時間（下軸）*/
      c.save();
      c.strokeStyle = 'rgba(77,141,255,.09)'; c.lineWidth = 1;
      c.font = '10px "JetBrains Mono", monospace'; c.fillStyle = 'rgba(152,162,179,.75)';
      for (let i = 0; i <= 5; i++) {
        const p = R.mn + (R.mx - R.mn) * i / 5, y = Math.round(Y(p)) + .5;
        c.beginPath(); c.moveTo(x0, y); c.lineTo(x0 + (x1 - x0) * rev, y); c.stroke();
        c.textAlign = 'left'; c.fillText(U.pxSym(p), x1 + 6, y + 3.5);
      }
      c.textAlign = 'center';
      const raw = Math.max(1, 62 / pxBar);
      const stepIdx = NICE.find(s => s >= raw) || Math.ceil(raw / 43200) * 43200;
      const first = Math.ceil(this.vw.start / stepIdx) * stepIdx;
      for (let i = first; i < this.vw.start + this.vw.count + stepIdx; i += stepIdx) {
        if (i < 0 || i >= this.k.length) continue;
        const x = Math.round(X(i)) + .5;
        if (x < x0 - 1 || x > x1 + 1) continue;
        c.strokeStyle = 'rgba(77,141,255,.05)';
        c.beginPath(); c.moveTo(x, y0); c.lineTo(x, vy1); c.stroke();
        c.fillStyle = 'rgba(107,116,128,.9)';
        c.fillText(U.timeAxis(this.k[i].t, this.tf), x, H - 5);
      }
      c.restore();

      /* 量能柱 */
      if (this.ov.vol && v.n) {
        let vm = 0;
        for (let i = v.i0; i <= v.i1; i++) { const q = this.k[i].q || 0; if (q > vm) vm = q; }
        vm = vm || 1;
        for (let i = v.i0; i <= v.i1; i++) {
          const k = this.k[i], x = X(i);
          if (x < x0 - bw || x > x1 + bw) continue;
          const h = (k.q / vm) * (vy1 - vy0);
          const up = k.c >= k.o;
          const g = c.createLinearGradient(0, vy1 - h, 0, vy1);
          g.addColorStop(0, up ? 'rgba(14,203,129,.55)' : 'rgba(246,70,93,.55)');
          g.addColorStop(1, up ? 'rgba(14,203,129,.06)' : 'rgba(246,70,93,.06)');
          c.fillStyle = g;
          c.fillRect(x - bw / 2, vy1 - h, bw, h);
        }
      }

      /* K 線 */
      for (let i = v.i0; i <= v.i1; i++) {
        const k = this.k[i], x = X(i);
        if (x < x0 - bw || x > x1 + bw) continue;
        const up = k.c >= k.o;
        c.strokeStyle = up ? 'rgba(14,203,129,.75)' : 'rgba(246,70,93,.75)';
        c.lineWidth = 1;
        c.beginPath(); c.moveTo(x, Y(k.h)); c.lineTo(x, Y(k.l)); c.stroke();
        const yA = Y(Math.max(k.o, k.c)), yB = Y(Math.min(k.o, k.c));
        const hgt = Math.max(1.2, yB - yA);
        c.fillStyle = up ? 'rgba(14,203,129,.30)' : 'rgba(246,70,93,.30)';
        c.fillRect(x - bw / 2, yA, bw, hgt);
        c.strokeStyle = up ? '#0ecb81' : '#f6465d'; c.lineWidth = 1;
        c.strokeRect(x - bw / 2 + .5, yA + .5, Math.max(1, bw - 1), Math.max(1, hgt - 1));
      }

      /* CVD */
      if (this.ov.cvd && this.cvd && this.cvd.length && v.n) {
        let cmn = Infinity, cmx = -Infinity;
        for (let i = v.i0; i <= v.i1; i++) { const u = this.cvd[i]; if (u < cmn) cmn = u; if (u > cmx) cmx = u; }
        if (cmn === cmx) { cmn -= 1; cmx += 1; }
        const CY = u => vy1 - (u - cmn) / (cmx - cmn) * (vy1 - vy0) * .92 - 2;
        c.beginPath();
        for (let i = v.i0; i <= v.i1; i++) { const x = X(i), y = CY(this.cvd[i]); i === v.i0 ? c.moveTo(x, y) : c.lineTo(x, y); }
        c.strokeStyle = '#4d8dff'; c.lineWidth = 1.6;
        c.shadowColor = 'rgba(77,141,255,.85)'; c.shadowBlur = 8;
        c.stroke(); c.shadowBlur = 0;
        c.fillStyle = 'rgba(77,141,255,.85)'; c.font = '9px "JetBrains Mono",monospace'; c.textAlign = 'left';
        c.fillText('CVD ' + U.signed(this.cvd[v.i1], x => U.money(x)), x0 + 2, vy0 + 10);
      }

      /* VWAP */
      if (this.ov.vwap) {
        const vw = S.analytics.Trades.vwap(1800e3);
        if (isFinite(vw) && vw > R.mn && vw < R.mx) {
          const y = Y(vw);
          c.save(); c.setLineDash([5, 4]); c.strokeStyle = '#f5a524'; c.lineWidth = 1.1;
          c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke(); c.restore();
          c.fillStyle = '#f5a524'; c.font = '9px "JetBrains Mono",monospace'; c.textAlign = 'left';
          c.fillText('VWAP 30M ' + U.px(vw), x0 + 2, y - 4);
        }
      }

      /* 掛單牆水平線 */
      if (this.ov.walls) {
        this.walls.slice(0, 3).forEach(wl => {
          if (!isFinite(wl.px) || wl.px < R.mn || wl.px > R.mx) return;
          const y = Math.round(Y(wl.px)) + .5;
          const bid = wl.side === 'bid';
          c.save();
          c.setLineDash([2, 4]); c.lineWidth = 1;
          c.strokeStyle = bid ? 'rgba(14,203,129,.40)' : 'rgba(246,70,93,.40)';
          c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke();
          c.restore();
          const label = (bid ? 'BID ' : 'ASK ') + U.pxSym(wl.px) + ' · ' + U.usd(wl.notional);
          c.font = '9px "JetBrains Mono",monospace';
          const tw = c.measureText(label).width + 6;
          c.fillStyle = bid ? 'rgba(12,24,20,.85)' : 'rgba(28,14,17,.85)';
          c.fillRect(x0 + 2, y - 11, tw, 11);
          c.fillStyle = bid ? 'rgba(14,203,129,.85)' : 'rgba(246,70,93,.85)';
          c.textAlign = 'left'; c.fillText(label, x0 + 5, y - 2.5);
        });
      }

      /* 巨鯨成交標記（脈動 + 新事件漣漪）*/
      const nowT = Date.now();
      this.markers.slice(-40).forEach(m => {
        const i = this.timeToIdx(m.t);
        if (i < this.vw.start - 1 || i > this.vw.start + this.vw.count + 1) return;
        if (m.price < R.mn || m.price > R.mx) return;
        const x = X(i), y = Y(m.price);
        const age = (nowT - m.t) / 1000;
        const base = Math.min(7, 2.5 + Math.log10(m.notional / 50000 + 1) * 2);
        c.beginPath(); c.arc(x, y, base, 0, 6.2832);
        c.fillStyle = m.side === 'buy' ? 'rgba(14,203,129,.28)' : 'rgba(246,70,93,.28)';
        c.strokeStyle = m.side === 'buy' ? '#0ecb81' : '#f6465d';
        c.lineWidth = 1.2; c.fill(); c.stroke();
        if (age < 4) {
          const rr = base + age * 4.5, al = Math.max(0, .40 * (1 - age / 4));
          c.beginPath(); c.arc(x, y, rr, 0, 6.2832);
          c.strokeStyle = m.side === 'buy' ? 'rgba(14,203,129,' + al + ')' : 'rgba(246,70,93,' + al + ')';
          c.lineWidth = 1.1; c.stroke();
        }
      });

      /* 現價線 */
      if (isFinite(this.price)) {
        const y = Y(this.price);
        c.save();
        c.setLineDash([4, 3]); c.strokeStyle = 'rgba(242,245,250,.65)'; c.lineWidth = 1;
        c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke(); c.restore();
        const lbl = U.pxSym(this.price);
        c.font = 'bold 11px "JetBrains Mono",monospace';
        const tw = c.measureText(lbl).width + 8;
        c.fillStyle = '#4d8dff'; c.fillRect(x1 + 2, y - 8, tw, 16);
        c.fillStyle = '#0b0e13'; c.textAlign = 'left'; c.fillText(lbl, x1 + 6, y + 4);
      }

      /* 使用者的繪圖（趨勢線／水平線／矩形／斐波那契／測量）＋ 選取狀態 */
      this.drawShapes(c, L, R, X, Y);

      /* 十字準線、軸標籤與圖例 */
      this.drawCross(c, L, R, X, Y);
    },

    /* 十字準線（stage 2 起加上兩軸標籤與圖例）*/
    drawCross(c, L, R, X, Y) {
      if (!this.hover) return;
      const hx = this.hover.x, hy = this.hover.y;
      if (hx < L.x0 || hx > L.x1) return;
      c.save(); c.setLineDash([3, 3]); c.strokeStyle = 'rgba(77,141,255,.55)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(hx, L.y0); c.lineTo(hx, L.vy1); c.stroke();
      if (hy > L.y0 && hy < L.y1) { c.beginPath(); c.moveTo(L.x0, hy); c.lineTo(L.x1, hy); c.stroke(); }
      c.restore();
    },

    /* 繪圖層（stage 3 實作） */
    drawShapes() {},
    /* 視圖保存（stage 4 實作） */
    emitView() {}, loadView() {},

    /* ═══ 互動 ═══ */
    init(canvas) {
      this.canvas = canvas;
      canvas.style.cursor = 'crosshair';
      canvas.style.touchAction = 'none';        /* 觸控拖曳不平移頁面 */
      const rel = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

      canvas.addEventListener('mousemove', e => {
        const p = rel(e);
        this.hover = { x: p.x, y: p.y, r: canvas.getBoundingClientRect() };
        this.kbOn = true;
        if (this.drag) {                        /* 拖曳平移 */
          const dx = e.clientX - this.drag.x;
          if (dx) { this.drag.x = e.clientX; this.drag.moved += Math.abs(dx); this.panBy(dx); }
        }
        this.draw();
      });
      canvas.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        this.kbOn = true;
        this.drag = { x: e.clientX, y: e.clientY, moved: 0 };
        canvas.style.cursor = 'grabbing';
        e.preventDefault();                     /* 不選取文字、不觸發頁面捲動 */
      });
      w.addEventListener('mouseup', () => {
        if (!this.drag) return;
        this.drag = null;
        canvas.style.cursor = 'crosshair';
      });
      canvas.addEventListener('mouseleave', () => {
        this.hover = null; this.draw();
      });
      const panel = canvas.closest('.chart-panel');
      if (panel) panel.addEventListener('mouseleave', () => { this.kbOn = false; });

      /* 滾輪縮放：以游標所在位置為錨點 */
      canvas.addEventListener('wheel', e => {
        const p = rel(e);
        e.preventDefault();
        const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        this.zoomAt(p.x, Math.pow(1.0018, U.clamp(d, -600, 600)));
      }, { passive: false });

      /* 觸控：單指拖曳平移、雙指縮放 */
      let t0 = null;
      canvas.addEventListener('touchstart', e => {
        this.kbOn = true;
        if (e.touches.length === 1) { const p = rel(e.touches[0]); t0 = { x: p.x, pin: 0 }; }
        else if (e.touches.length === 2) {
          const a = rel(e.touches[0]), b = rel(e.touches[1]);
          t0 = { pin: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2 };
        }
      }, { passive: true });
      canvas.addEventListener('touchmove', e => {
        if (!t0) return;
        e.preventDefault();
        if (e.touches.length === 1 && !t0.pin) {
          const p = rel(e.touches[0]);
          this.panBy(p.x - t0.x); t0.x = p.x;
          this.hover = { x: p.x, y: p.y };
        } else if (e.touches.length === 2) {
          const a = rel(e.touches[0]), b = rel(e.touches[1]);
          const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2;
          if (t0.pin) { this.zoomAt(cx, t0.pin / Math.max(1, d)); t0.cx = cx; }
          t0.pin = d;
        }
        this.draw();
      }, { passive: false });
      canvas.addEventListener('touchend', () => { t0 = null; this.hover = null; this.draw(); }, { passive: true });

      /* 鍵盤（游標在圖表上／全螢幕時才吃按鍵，避免搶走掃描清單的快捷鍵）*/
      w.addEventListener('keydown', e => {
        if (!this.kbOn && !this.fullscreen) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        if (!this.k.length) return;
        const L = this.layout(); if (!L) return;
        const wpx = L.x1 - L.x0;
        let used = true;
        switch (e.key) {
          case '+': case '=': this.zoomKey(1 / 1.18); break;
          case '-': case '_': this.zoomKey(1.18); break;
          case 'ArrowLeft': this.panBy(Math.max(24, wpx * 0.06)); break;
          case 'ArrowRight': this.panBy(-Math.max(24, wpx * 0.06)); break;
          case 'Home': this.vw.start = this._clampStart(0); this._yr = null; this.follow = false; this.emitView(); this.draw(); break;
          case 'End': this.goLive(); break;
          case 'r': case 'R': this.fit(); this._yr = null; this.emitView(); this.draw(); break;
          default: used = false;
        }
        if (used) { e.preventDefault(); e.stopPropagation(); }
      });

      /* 視窗尺寸變化：80ms 去抖動後重繪（避免拖曳中每個像素都重畫）*/
      const onResize = () => {
        this.pendingResize = (this.pendingResize || 0) + 1;
        this._debResize();
      };
      this._debResize = U.debounce(() => {
        this.pendingResize = 0;
        this.resizeDraws++;
        this._yr = null;
        this.draw();
      }, 80);
      this._ro = new ResizeObserver(onResize);
      this._ro.observe(canvas.parentElement);
    },
    fullscreen: false,
    /* 週期 → 毫秒（1M 用 30 天近似，僅用於把標記對到 K 線索引）*/
    tfMs() {
      return {
        '1m': 6e4, '3m': 18e4, '5m': 3e5, '15m': 9e5, '30m': 18e5,
        '1h': 36e5, '2h': 72e5, '4h': 144e5, '6h': 216e5, '12h': 432e5,
        '1d': 864e5, '3d': 2592e5, '1w': 6048e5, '1M': 2592e6
      }[this.tf] || 3e5;
    }
  };

  /* ══════════════ 深度熱圖 ══════════════ */
  const HM = S.heat = {
    canvas: null, off: null,
    init(canvas) { this.canvas = canvas; new ResizeObserver(U.resizeRedraw(() => this.draw(), 120)).observe(canvas.parentElement); },
    draw() {
      const f = fit(this.canvas); if (!f) return;
      const { c, w: W, h: H } = f;
      c.clearRect(0, 0, W, H);
      const frames = S.analytics.Book.frames;
      if (!frames || frames.length < 2) {
        c.fillStyle = 'rgba(140,180,205,.5)'; c.font = '11px monospace';
        c.fillText('累積深度資料中…（每 2 秒一格）', 12, 20); return;
      }
      const N = frames[0].bin.length, F = frames.length;
      if (!this.off) this.off = document.createElement('canvas');
      if (this.off.width !== F || this.off.height !== N) { this.off.width = F; this.off.height = N; }
      const oc = this.off.getContext('2d');
      const img = oc.createImageData(F, N);
      // 對數強度：凸顯相對密度而非絕對量
      let gmax = 0;
      frames.forEach(fr => { for (const v of fr.bin) if (v > gmax) gmax = v; });
      const lg = v => gmax > 0 ? Math.log10(1 + v / gmax * 99) / 2 : 0;
      for (let x = 0; x < F; x++) {
        const fr = frames[x];
        for (let y = 0; y < N; y++) {
          const v = fr.bin[y];
          const t = v > 0 ? U.clamp(lg(v), 0, 1) : 0;
          const rgb = U.heatColor(t);
          const i = ((N - 1 - y) * F + x) * 4;
          img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2];
          img.data[i + 3] = v > 0 ? 40 + t * 215 : 0;
        }
      }
      oc.putImageData(img, 0, 0);

      const padR = 78, padT = 4, padB = 14;
      const dw = W - padR - 4, dh = H - padT - padB;
      c.imageSmoothingEnabled = true;
      c.globalAlpha = .96;
      c.drawImage(this.off, 4, padT, dw, dh);
      c.globalAlpha = 1;

      // 刻度：以「距現價的相對距離」為座標系，換算成當前價位標示
      const cd = S.analytics.Book, span = cd.span || 0.01, cmid = isFinite(cd.mid) ? cd.mid : frames[frames.length - 1].mid;
      c.font = '9px "JetBrains Mono",monospace'; c.textAlign = 'left'; c.fillStyle = 'rgba(152,162,179,.8)';
      for (let i = 0; i <= 4; i++) {
        const off = span * (1 - 2 * i / 4), y = padT + dh * i / 4;
        c.fillText(U.pxSym(cmid * (1 + off)), 4 + dw + 6, y + 3);
      }
      // 深度範圍標示
      c.fillStyle = 'rgba(107,116,128,.95)';
      c.fillText('±' + (span * 100).toFixed(3) + '%', 4 + dw + 6, padT + dh - 4);
      const mn = -span, mx = span;
      // 現價線
      const live = S.analytics.Book.mid;
      if (isFinite(live) && live >= mn && live <= mx) {
        const y = padT + dh * (1 - (live - mn) / (mx - mn));
        c.save(); c.setLineDash([3, 3]); c.strokeStyle = 'rgba(242,245,250,.8)'; c.lineWidth = 1;
        c.beginPath(); c.moveTo(4, y); c.lineTo(4 + dw, y); c.stroke(); c.restore();
      }
      c.textAlign = 'left'; c.fillStyle = 'rgba(107,116,128,.9)';
      c.fillText('← 較早', 6, H - 3);
      c.textAlign = 'right'; c.fillText('最新 →', 4 + dw, H - 3);
      c.textAlign = 'left'; c.fillStyle = 'rgba(107,116,128,.8)';
      c.fillText('掛單密度熱圖 · 縱軸為距現價距離（自適應深度範圍）', 6, padT + 11);

      // 最新一格的前緣光暈（脈動，強調資料正在寫入）
      if (!w.matchMedia || !w.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const lx = 4 + dw, pulse = 0.30 + 0.28 * (0.5 + 0.5 * Math.sin(performance.now() / 430));
        const g2 = c.createLinearGradient(lx - 34, 0, lx, 0);
        g2.addColorStop(0, 'rgba(77,141,255,0)'); g2.addColorStop(1, 'rgba(138,180,255,' + pulse.toFixed(2) + ')');
        c.fillStyle = g2; c.fillRect(lx - 34, padT, 34, dh);
        c.strokeStyle = 'rgba(242,245,250,' + (pulse + .2).toFixed(2) + ')';
        c.lineWidth = 1; c.beginPath(); c.moveTo(lx - .5, padT); c.lineTo(lx - .5, padT + dh); c.stroke();
      }

      U.text('#hFrames', F + ' 格 · ' + Math.round(F * 2) + ' 秒');
      U.text('#hMax', U.usd(gmax));
    }
  };

  /* ══════════════ 聰明錢壓力計 ══════════════ */
  const G = S.gauge = {
    canvas: null, val: 0, target: 0, raf: 0, cls: 'neu',
    init(canvas) { this.canvas = canvas; new ResizeObserver(U.resizeRedraw(() => this.draw(), 120)).observe(canvas.parentElement); this.loop(); },
    set(v, cls) { this.target = U.clamp(v, 0, 100); this.cls = cls || 'neu'; },
    vel: 0,
    loop() {
      // 彈簧運動：指針會稍微過衝再回穩，比線性內插更有儀器感
      const d = this.target - this.val;
      this.vel = (this.vel || 0) * 0.78 + d * 0.16;
      if (Math.abs(d) > .08 || Math.abs(this.vel) > .08) { this.val += this.vel; this.draw(); }
      this.raf = requestAnimationFrame(() => this.loop());
    },
    draw() {
      const f = fit(this.canvas); if (!f) return;
      const { c, w: W, h: H } = f;
      c.clearRect(0, 0, W, H);
      const cx = W / 2, cy = H * .78, R = Math.min(W * .4, H * .72);
      const A0 = Math.PI * 0.86, A1 = Math.PI * 2.14;
      // 弧帶底
      const grad = c.createLinearGradient(cx - R, 0, cx + R, 0);
      grad.addColorStop(0, 'rgba(246,70,93,.85)');
      grad.addColorStop(.35, 'rgba(245,165,36,.7)');
      grad.addColorStop(.5, 'rgba(152,162,179,.5)');
      grad.addColorStop(.7, 'rgba(77,141,255,.8)');
      grad.addColorStop(1, 'rgba(14,203,129,.95)');
      c.beginPath(); c.arc(cx, cy, R, A0, A1); c.arc(cx, cy, R - 12, A1, A0, true); c.closePath();
      c.fillStyle = 'rgba(255,255,255,.07)'; c.fill();
      c.strokeStyle = 'rgba(77,141,255,.18)'; c.lineWidth = 1; c.stroke();

      // 刻度
      for (let i = 0; i <= 10; i++) {
        const a = A0 + (A1 - A0) * i / 10;
        const r1 = R - 13, r2 = R - (i % 5 === 0 ? 22 : 18);
        c.beginPath();
        c.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
        c.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
        c.strokeStyle = i % 5 === 0 ? 'rgba(77,141,255,.55)' : 'rgba(77,141,255,.22)';
        c.lineWidth = i % 5 === 0 ? 1.6 : 1; c.stroke();
      }
      // 已達分數弧
      const k = U.clamp(this.val / 100, 0, 1);
      const aEnd = A0 + (A1 - A0) * k;
      c.beginPath(); c.arc(cx, cy, R, A0, aEnd); c.arc(cx, cy, R - 12, aEnd, A0, true); c.closePath();
      c.fillStyle = grad; c.globalAlpha = .95; c.fill(); c.globalAlpha = 1;
      c.save();
      c.shadowColor = k > .55 ? 'rgba(14,203,129,.8)' : (k < .45 ? 'rgba(246,70,93,.8)' : 'rgba(77,141,255,.8)');
      c.shadowBlur = 18;
      c.beginPath(); c.arc(cx, cy, R - 6, A0, aEnd);
      c.strokeStyle = 'rgba(255,255,255,.55)'; c.lineWidth = 2; c.stroke();
      c.restore();

      // 弧帶流光（沿已達分數的弧線移動）
      if (!w.matchMedia || !w.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const gp = A0 + (A1 - A0) * ((performance.now() % 3600) / 3600) * U.clamp(k, 0.02, 1);
        c.beginPath(); c.arc(cx, cy, R - 6, gp - 0.16, gp + 0.16);
        c.strokeStyle = 'rgba(255,255,255,' + (0.30 + 0.25 * Math.sin(performance.now() / 300)).toFixed(2) + ')';
        c.lineWidth = 3.4; c.stroke();
      }

      // 指針
      c.save();
      c.translate(cx, cy); c.rotate(aEnd);
      c.beginPath(); c.moveTo(R - 26, 0); c.lineTo(-6, -3.2); c.lineTo(-6, 3.2); c.closePath();
      c.fillStyle = '#f2f5fa'; c.shadowColor = '#4d8dff'; c.shadowBlur = 12; c.fill();
      c.restore();
      c.beginPath(); c.arc(cx, cy, 4.5, 0, 6.2832); c.fillStyle = '#4d8dff'; c.fill();
      c.beginPath(); c.arc(cx, cy, 8.5, 0, 6.2832); c.strokeStyle = 'rgba(77,141,255,.5)'; c.lineWidth = 1; c.stroke();

      // 中軸文字位置留給 DOM（gauge-center）
    }
  };

  /* ══════════════ 未平倉量走勢 ══════════════ */
  const OI = S.oiChart = {
    canvas: null, series: [], times: [],
    init(c) { this.canvas = c; new ResizeObserver(U.resizeRedraw(() => this.draw(), 120)).observe(c.parentElement); },
    set(s, t) { this.series = s || []; this.times = t || []; this.draw(); },
    draw() {
      const f = fit(this.canvas); if (!f) return;
      const { c, w: W, h: H } = f;
      c.clearRect(0, 0, W, H);
      if (!this.series || this.series.length < 2) {
        c.fillStyle = 'rgba(140,180,205,.45)'; c.font = '10px monospace';
        c.fillText('無未平倉量歷史（該幣種可能無合約）', 6, H / 2 + 3); return;
      }
      const s = this.series, mn = Math.min.apply(null, s), mx = Math.max.apply(null, s);
      const X = i => 4 + i / (s.length - 1) * (W - 8);
      const Y = v => H - 6 - (v - mn) / (mx - mn || 1) * (H - 14);
      // 面積
      const g = c.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, 'rgba(77,141,255,.35)'); g.addColorStop(1, 'rgba(77,141,255,0)');
      c.beginPath(); c.moveTo(X(0), Y(s[0]));
      s.forEach((v, i) => c.lineTo(X(i), Y(v)));
      c.lineTo(X(s.length - 1), H); c.lineTo(X(0), H); c.closePath(); c.fillStyle = g; c.fill();
      c.beginPath(); s.forEach((v, i) => i ? c.lineTo(X(i), Y(v)) : c.moveTo(X(i), Y(v)));
      c.strokeStyle = '#4d8dff'; c.lineWidth = 1.5;
      c.shadowColor = 'rgba(77,141,255,.7)'; c.shadowBlur = 6; c.stroke(); c.shadowBlur = 0;
      // 最新點
      const lx = X(s.length - 1), ly = Y(s[s.length - 1]);
      c.beginPath(); c.arc(lx, ly, 2.6, 0, 6.2832); c.fillStyle = '#f2f5fa'; c.fill();
      c.font = '9px "JetBrains Mono",monospace'; c.fillStyle = 'rgba(152,162,179,.85)'; c.textAlign = 'left';
      c.fillText('OI ' + U.money(s[s.length - 1]), 5, 10);
      const chg = (s[s.length - 1] / s[0] - 1) * 100;
      c.fillStyle = chg >= 0 ? '#0ecb81' : '#f6465d'; c.textAlign = 'right';
      c.fillText(U.pct(chg), W - 5, 10);
    }
  };
})(window);
