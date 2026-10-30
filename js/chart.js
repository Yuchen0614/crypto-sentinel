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
  /* 繪圖工具的順序與名稱（工具列用）*/
  const TOOLS = [
    { k: 'select', n: '選取／移動', hk: 'V' },
    { k: 'trend', n: '趨勢線', hk: 'T' },
    { k: 'hline', n: '水平線', hk: 'H' },
    { k: 'rect', n: '矩形／區間', hk: 'B' },
    { k: 'fib', n: '斐波那契回撤', hk: 'F' },
    { k: 'measure', n: '測量（拖曳）', hk: 'M' }
  ];
  const FIB_LV = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  /* 內嵌 SVG 圖示（不外連任何 CDN 或字型）*/
  const SVG = {
    select: '<svg viewBox="0 0 16 16"><path d="M3.5 2.2 L12.4 7.4 L8.3 8.5 L6.6 12.6 Z" fill="currentColor"/></svg>',
    trend: '<svg viewBox="0 0 16 16"><path d="M3.4 12.4 L12.6 3.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="3.4" cy="12.4" r="1.7" fill="currentColor"/><circle cx="12.6" cy="3.6" r="1.7" fill="currentColor"/></svg>',
    hline: '<svg viewBox="0 0 16 16"><path d="M2 8 H14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="8" r="1.9" fill="currentColor"/></svg>',
    rect: '<svg viewBox="0 0 16 16"><rect x="2.7" y="4.2" width="10.6" height="7.6" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2.7 8 h10.6" stroke="currentColor" stroke-width="1" opacity=".5"/></svg>',
    fib: '<svg viewBox="0 0 16 16"><path d="M2 3.2 h12 M2 6.4 h12 M2 9.2 h12 M2 12 h12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M2 3.2 h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    measure: '<svg viewBox="0 0 16 16"><path d="M8 2.6 V13.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 2.6 L5.8 5 M8 2.6 L10.2 5 M8 13.4 L5.8 11 M8 13.4 L10.2 11" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    del: '<svg viewBox="0 0 16 16"><path d="M3.4 4.8 h9.2 M6.4 4.8 V3.2 h3.2 v1.6 M5 4.8 l.6 8.2 h4.8 l.6-8.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    clear: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4.1 11.9 L11.9 4.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    full: '<svg viewBox="0 0 16 16"><path d="M3 6.2 V3 h3.2 M9.8 3 H13 v3.2 M13 9.8 V13 H9.8 M6.2 13 H3 V9.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    fullx: '<svg viewBox="0 0 16 16"><path d="M6.2 3 V6.2 H3 M9.8 3 V6.2 H13 M13 9.8 H9.8 V13 M3 9.8 H6.2 V13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'
  };

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
    ui: {},                       /* 互動疊層（圖例／回到最新／工具列／樣式列）*/
    _lgKey: '',
    /* 繪圖：錨點一律存「時間＋價格」＝ {t: 該根 K 線的開盤時間(ms), p: 價位}，
       所以縮放、平移、換週期、重開頁面後圖形都貼在同一根 K 線與同一價位。 */
    drawings: [], tool: 'select', draft: null, sel: null,
    dcolor: '#4d8dff', dwidth: 1, _id: 0,
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
      if (!this._viewInit) { this._viewInit = true; this._viewKey = key; this.loadView(); this.loadDrawings(); }
      else if (key !== this._viewKey) { this._viewKey = key; this.fit(); this.loadDrawings(); }   /* 換幣種／週期：視圖回預設 fit，但該幣種該週期的圖形仍在 */
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

    /* 十字準線＋兩軸標籤＋左上圖例（游標指哪根就顯示哪根的 O/H/L/C）*/
    drawCross(c, L, R, X, Y) {
      const hv = this.hover;
      const inX = !!hv && hv.x >= L.x0 && hv.x <= L.x1;
      const inY = !!hv && hv.y >= L.y0 && hv.y <= L.vy1;
      let i = -1, k = null;
      if (inX) { i = U.clamp(Math.round(this.idxOfPx(hv.x, L)), 0, this.k.length - 1); k = this.k[i]; }
      if (!k) { i = this.k.length - 1; k = this.k[i]; }   /* 游標不在圖上 → 圖例顯示最新一根 */
      this.setLegend(k, i, inX);
      if (!inX) return;

      const hx = Math.round(hv.x) + .5;
      c.save();
      c.setLineDash([3, 3]); c.lineWidth = 1; c.strokeStyle = 'rgba(122,163,255,.55)';
      c.beginPath(); c.moveTo(hx, L.y0); c.lineTo(hx, L.vy1); c.stroke();
      if (inY) { const hy = Math.round(hv.y) + .5; c.beginPath(); c.moveTo(L.x0, hy); c.lineTo(L.x1, hy); c.stroke(); }
      c.restore();

      /* 右軸：游標價位標籤 */
      if (inY) {
        const lbl = U.pxSym(this.priceOfPy(hv.y, L, R));
        c.font = '10px "JetBrains Mono",monospace';
        const tw = Math.max(54, c.measureText(lbl).width + 12);
        c.fillStyle = 'rgba(28,40,64,.97)';
        c.fillRect(L.x1 + 2, hv.y - 8, tw, 16);
        c.strokeStyle = 'rgba(122,163,255,.55)'; c.lineWidth = 1;
        c.strokeRect(L.x1 + 2.5, hv.y - 7.5, tw - 1, 15);
        c.fillStyle = '#cfe0ff'; c.textAlign = 'left';
        c.fillText(lbl, L.x1 + 8, hv.y + 3.5);
      }
      /* 下軸：時間標籤 */
      if (k) {
        const lbl = this.hoverTime(k.t);
        c.font = '10px "JetBrains Mono",monospace';
        const tw = c.measureText(lbl).width + 14;
        const bx = U.clamp(hx, L.x0 + tw / 2, L.x1 - tw / 2);
        c.fillStyle = 'rgba(28,40,64,.97)';
        c.fillRect(bx - tw / 2, L.H - 17, tw, 16);
        c.strokeStyle = 'rgba(122,163,255,.55)'; c.lineWidth = 1;
        c.strokeRect(bx - tw / 2 + .5, L.H - 16.5, tw - 1, 15);
        c.fillStyle = '#cfe0ff'; c.textAlign = 'center';
        c.fillText(lbl, bx, L.H - 5.5);
      }
    },
    hoverTime(t) {
      const d = new Date(t), p = n => String(n).padStart(2, '0');
      const md = p(d.getMonth() + 1) + '/' + p(d.getDate());
      if (this.tf === '1d' || this.tf === '3d' || this.tf === '1w' || this.tf === '1M') return d.getFullYear() + '/' + md;
      return md + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    },
    /* 左上圖例：游標所指那根（沒游標時顯示最新一根）*/
    setLegend(k, i, hovering) {
      const el = this.ui.legend; if (!el) return;
      const key = (k ? k.t + '|' + k.c + '|' + k.h + '|' + k.l : 'none') + '|' + hovering;
      if (key === this._lgKey) return;
      this._lgKey = key;
      if (!k) { el.innerHTML = '<b>' + this.sym() + '</b> ' + this.tf + ' · 尚無資料'; return; }
      const up = k.c >= k.o, c1 = up ? 'lg-up' : 'lg-dn';
      const pct = k.o ? (k.c / k.o - 1) * 100 : 0;
      el.innerHTML =
        '<b>' + this.sym() + '</b><i>' + this.tf + '</i>' +
        '<span class="lg-t">' + (hovering ? this.hoverTime(k.t) : '最新 ' + this.hoverTime(k.t)) + '</span>' +
        '<span>開<b class="' + c1 + '">' + U.pxSym(k.o) + '</b></span>' +
        '<span>高<b class="' + c1 + '">' + U.pxSym(k.h) + '</b></span>' +
        '<span>低<b class="' + c1 + '">' + U.pxSym(k.l) + '</b></span>' +
        '<span>收<b class="' + c1 + '">' + U.pxSym(k.c) + '</b></span>' +
        '<span class="' + c1 + '">' + (up ? '+' : '') + pct.toFixed(2) + '%</span>' +
        '<span>量 ' + U.usd(k.q || 0) + '</span>';
    },
    /* 「回到最新」小按鈕：一平移就出現 */
    syncLive() {
      const b = this.ui.live; if (!b) return;
      b.hidden = this.follow;
    },
    /* 建立互動用的 DOM 疊層（圖例、回到最新；工具列見 buildTools）*/
    buildUI(canvas) {
      const wrap = canvas.parentElement;
      if (!wrap || this.ui.built) return;
      this.ui.built = true;
      const lg = U.el('div', 'ct-legend');
      lg.id = 'chartOhlc';
      const live = U.el('button', 'ct-live');
      live.id = 'chartGoLive';
      live.type = 'button';
      live.innerHTML = '回到最新 ▸';
      live.title = '回到最右側最新一根 K 線（快速鍵 End）';
      live.hidden = true;
      live.addEventListener('click', e => { e.preventDefault(); this.goLive(); });
      wrap.appendChild(lg);
      wrap.appendChild(live);
      this.ui.legend = lg; this.ui.live = live;
      this.setLegend(this.k[this.k.length - 1] || null, this.k.length - 1, false);
      this.syncLive();
    },

    /* ══════════ 繪圖引擎（錨點＝時間＋價格）══════════ */
    DCOLORS: [{ v: '#4d8dff', n: '藍' }, { v: '#0ecb81', n: '漲綠' }, { v: '#f6465d', n: '跌紅' }],
    pxOfAnchor(a, L) { return this.pxOfIdx(this.timeToIdx(a.t), L); },
    pyOfAnchor(a, L, R) { return this.pyOfPrice(a.p, L, R); },
    anchorAt(x, y, L, R) { return { t: this.idxToTime(this.idxOfPx(x, L)), p: this.priceOfPy(y, L, R) }; },
    geom(d, L, R) {
      const x1 = this.pxOfAnchor(d.p1, L), y1 = this.pyOfAnchor(d.p1, L, R);
      const x2 = d.p2 ? this.pxOfAnchor(d.p2, L) : x1, y2 = d.p2 ? this.pyOfAnchor(d.p2, L, R) : y1;
      return { x1, y1, x2, y2 };
    },
    segDist(x, y, ax, ay, bx, by) {
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 ? U.clamp(((x - ax) * dx + (y - ay) * dy) / l2, 0, 1) : 0;
      return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
    },
    /* 命中測試（由上往下找）*/
    hitTest(x, y, L, R) {
      const seg = (ax, ay, bx, by) => this.segDist(x, y, ax, ay, bx, by);
      for (let i = this.drawings.length - 1; i >= 0; i--) {
        const d = this.drawings[i], g = this.geom(d, L, R);
        let hit = false;
        if (d.type === 'hline') hit = Math.abs(y - g.y1) <= 6 && x >= L.x0 - 4 && x <= L.x1 + 4;
        else if (d.type === 'rect') {
          const xa = Math.min(g.x1, g.x2), xb = Math.max(g.x1, g.x2), ya = Math.min(g.y1, g.y2), yb = Math.max(g.y1, g.y2);
          hit = x >= xa - 3 && x <= xb + 3 && y >= ya - 3 && y <= yb + 3;
        } else if (d.type === 'fib') {
          const xa = Math.min(g.x1, g.x2), xb = Math.max(g.x1, g.x2);
          const ya = Math.min(g.y1, g.y2), yb = Math.max(g.y1, g.y2);
          hit = seg(g.x1, g.y1, g.x2, g.y2) <= 6 || (x >= xa - 3 && x <= xb + 3 && y >= ya - 5 && y <= yb + 5);
        } else hit = seg(g.x1, g.y1, g.x2, g.y2) <= 6;
        if (hit) return d;
      }
      return null;
    },
    endPointAt(d, x, y, L, R) {
      const g = this.geom(d, L, R);
      if (d.type === 'hline') return Math.hypot(x - g.x1, y - g.y1) <= 9 ? 'p1' : null;
      const d1 = Math.hypot(x - g.x1, y - g.y1), d2 = Math.hypot(x - g.x2, y - g.y2);
      if (d1 <= 9 && d1 <= d2) return 'p1';
      if (d2 <= 9) return 'p2';
      return null;
    },
    newShape(type, p1) { return { id: ++this._id, type: type, p1: p1, p2: null, color: this.dcolor, lw: this.dwidth }; },
    commit(d) {
      if (!d) return;
      if (!d.id) { d.id = ++this._id; d.color = d.color || this.dcolor; d.lw = d.lw || this.dwidth; }
      if (d.type !== 'hline' && d.p2 && d.p1 && Math.abs(d.p2.t - d.p1.t) < this.tfMs() * 0.5 && Math.abs(d.p2.p - d.p1.p) < 1e-9) { this.draft = null; this.draw(); return; }
      const i = this.drawings.findIndex(x => x.id === d.id);
      if (i >= 0) this.drawings[i] = d; else this.drawings.push(d);
      this.draft = null; this.sel = d.id;
      this.tool = 'select';                       /* 畫完回到選取工具（TradingView 亦然）*/
      this.saveDrawings(); this.syncTools(); this.draw();
    },
    deleteSel() {
      const i = this.drawings.findIndex(d => d.id === this.sel);
      if (i < 0) return;
      this.drawings.splice(i, 1); this.sel = null;
      this.saveDrawings(); this.syncTools(); this.draw();
    },
    clearAll(btn) {
      if (!this.drawings.length && !this.draft) return;
      if (btn && !btn.classList.contains('arm')) {          /* 二次確認，避免手滑清空 */
        btn.classList.add('arm'); btn.title = '再按一次就清除全部圖形';
        clearTimeout(this._clrT);
        this._clrT = setTimeout(() => { btn.classList.remove('arm'); btn.title = '全部清除'; }, 3000);
        return;
      }
      if (btn) { btn.classList.remove('arm'); btn.title = '全部清除'; }
      this.drawings = []; this.draft = null; this.sel = null;
      this.saveDrawings(); this.syncTools(); this.draw();
    },
    applyStyleToSel() {
      const d = this.drawings.find(x => x.id === this.sel);
      if (d) { d.color = this.dcolor; d.lw = this.dwidth; this.saveDrawings(); this.draw(); }
      this.syncTools();
    },
    setTool(k) {
      if (k !== this.tool) this.draft = null;
      this.tool = k || 'select';
      if (this.tool !== 'select') this.sel = null;
      this.canvas.style.cursor = this.tool === 'select' ? 'crosshair' : 'copy';
      this.syncTools(); this.draw();
    },
    hintText() {
      const t = this.tool, d = this.draft;
      if (t === 'select') return '';
      if (t === 'hline') return '點一下圖面放置水平線（Esc 取消）';
      if (t === 'measure') return '按住左鍵拖曳 → 顯示 Δ價格／Δ%／根數／時間（Esc 取消）';
      const nm = { trend: '趨勢線', rect: '矩形', fib: '斐波那契' }[t] || '圖形';
      return d ? nm + '：再點第二點完成（Esc 取消）' : nm + '：點第一點';
    },
    syncTools() {
      const u = this.ui;
      if (u.rail) Array.prototype.forEach.call(u.rail.querySelectorAll('.ct-btn[data-tool]'), b => b.classList.toggle('on', b.dataset.tool === this.tool));
      if (u.del) { u.del.disabled = !this.drawings.some(d => d.id === this.sel); }
      if (u.wb) { u.wb.querySelector('.ct-w').textContent = String(this.dwidth); u.wb.title = '線寬 ' + this.dwidth + 'px（點一下切換 1／2px）'; }
      if (u.actions) Array.prototype.forEach.call(u.actions.querySelectorAll('.ct-sw'), s => s.classList.toggle('on', s.dataset.color === this.dcolor));
      if (u.hint) { const h = this.hintText(); u.hint.hidden = !h; u.hint.textContent = h; }
    },
    buildTools(canvas) {
      const wrap = canvas.parentElement;
      if (!wrap || this.ui.rail) return;
      wrap.classList.add('ct-tools-on');
      /* 左側豎排工具列（38px）：6 個繪圖工具 ＋ 刪除選取 ＋ 全部清除 */
      const rail = U.el('div', 'ct-rail');
      const rin = U.el('div', 'ct-rail-in');
      TOOLS.forEach(t => {
        const b = U.el('button', 'ct-btn' + (t.k === 'select' ? ' on' : ''));
        b.type = 'button'; b.dataset.tool = t.k; b.title = t.n + '（' + t.hk + '）';
        b.innerHTML = SVG[t.k];
        b.addEventListener('click', () => this.setTool(t.k));
        rin.appendChild(b);
      });
      rin.appendChild(U.el('div', 'ct-sep'));
      const del = U.el('button', 'ct-btn ct-danger');
      del.type = 'button'; del.id = 'ctDel'; del.title = '刪除選取的圖形（Delete）'; del.innerHTML = SVG.del;
      del.addEventListener('click', () => this.deleteSel());
      const clr = U.el('button', 'ct-btn ct-danger');
      clr.type = 'button'; clr.id = 'ctClear'; clr.title = '全部清除'; clr.innerHTML = SVG.clear;
      clr.addEventListener('click', () => this.clearAll(clr));
      rin.appendChild(del); rin.appendChild(clr);
      rail.appendChild(rin);
      wrap.insertBefore(rail, wrap.firstChild);   /* 插在畫布前面 → 工具列在左側 */

      /* 畫布右上：顏色 ×3、線寬、全螢幕 */
      const act = U.el('div', 'ct-actions');
      this.DCOLORS.forEach((col, i) => {
        const s = U.el('button', 'ct-sw' + (i === 0 ? ' on' : ''));
        s.type = 'button'; s.dataset.color = col.v; s.title = '繪圖顏色：' + col.n;
        s.style.background = col.v; s.style.color = col.v;
        s.addEventListener('click', () => { this.dcolor = col.v; this.applyStyleToSel(); });
        act.appendChild(s);
      });
      act.appendChild(U.el('div', 'ct-div'));
      const wb = U.el('button', 'ct-btn');
      wb.type = 'button'; wb.id = 'ctWidth'; wb.innerHTML = '<span class="ct-w">1</span>';
      wb.addEventListener('click', () => { this.dwidth = this.dwidth === 1 ? 2 : 1; this.applyStyleToSel(); });
      act.appendChild(wb);
      act.appendChild(U.el('div', 'ct-div'));
      const fb = U.el('button', 'ct-btn');
      fb.type = 'button'; fb.id = 'ctFull'; fb.title = '放大到整個視窗（Esc 退出）'; fb.innerHTML = SVG.full;
      fb.addEventListener('click', () => this.toggleFull());
      act.appendChild(fb);
      wrap.appendChild(act);

      const hint = U.el('div', 'ct-hint');
      hint.id = 'ctHint'; hint.hidden = true;
      wrap.appendChild(hint);

      this.ui.rail = rail; this.ui.actions = act; this.ui.hint = hint;
      this.ui.del = del; this.ui.clr = clr; this.ui.wb = wb; this.ui.fb = fb;
      this.syncTools();
    },
    /* 測量結果文字：Δ價格、Δ%、K 線根數、經過時間 */
    measureText(d) {
      const dp = d.p2.p - d.p1.p;
      const pct = d.p1.p ? dp / d.p1.p * 100 : 0;
      const bars = Math.max(0, Math.round(Math.abs(this.timeToIdx(d.p2.t) - this.timeToIdx(d.p1.t))));
      const mins = Math.abs(d.p2.t - d.p1.t) / 60000;
      let el;
      if (mins < 60) el = Math.round(mins) + ' 分';
      else if (mins < 1440) el = Math.floor(mins / 60) + ' 小時 ' + Math.round(mins % 60) + ' 分';
      else el = Math.floor(mins / 1440) + ' 天 ' + Math.round((mins % 1440) / 60) + ' 小時';
      return (dp >= 0 ? '+' : '') + U.pxSym(Math.abs(dp)) + '（' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%）· ' + bars + ' 根 · ' + el;
    },
    /* 繪製所有圖形（含繪製中的暫存）*/
    drawShapes(c, L, R) {
      const list = this.drawings.concat(this.draft ? [this.draft] : []);
      if (!list.length) return;
      list.forEach(d => {
        const g = this.geom(d, L, R), isDraft = d === this.draft;
        const sel = !isDraft && d.id === this.sel;
        const col = d.color || this.dcolor, lw = d.lw || 1;
        c.save();
        c.lineJoin = 'round'; c.lineCap = 'round';
        c.font = '10px "JetBrains Mono",monospace';
        /* 選取時先鋪一層光暈 */
        if (sel) {
          c.strokeStyle = 'rgba(122,163,255,.22)'; c.lineWidth = lw + 5;
          c.beginPath();
          if (d.type === 'hline') { c.moveTo(L.x0, g.y1); c.lineTo(L.x1, g.y1); }
          else if (d.type === 'rect') c.rect(Math.min(g.x1, g.x2), Math.min(g.y1, g.y2), Math.abs(g.x2 - g.x1), Math.abs(g.y2 - g.y1));
          else { c.moveTo(g.x1, g.y1); c.lineTo(g.x2, g.y2); }
          c.stroke();
        }
        c.strokeStyle = col; c.fillStyle = col; c.lineWidth = lw;

        if (d.type === 'hline') {
          c.beginPath(); c.moveTo(L.x0, g.y1); c.lineTo(L.x1, g.y1); c.stroke();
          const lbl = U.pxSym(d.p1.p);
          const tw = c.measureText(lbl).width + 10;
          c.fillStyle = col; c.fillRect(L.x1 + 2, g.y1 - 8, tw, 16);
          c.fillStyle = '#0b0e13'; c.textAlign = 'left'; c.fillText(lbl, L.x1 + 7, g.y1 + 3.5);
        } else if (d.type === 'rect') {
          const xa = Math.min(g.x1, g.x2), ya = Math.min(g.y1, g.y2);
          const w = Math.abs(g.x2 - g.x1), h = Math.abs(g.y2 - g.y1);
          c.globalAlpha = .13; c.fillRect(xa, ya, w, h); c.globalAlpha = 1;
          c.strokeRect(xa + .5, ya + .5, w, h);
          if (d.p2 && w > 52 && Math.abs(d.p1.p - d.p2.p) > 0) {
            const pct = (d.p2.p / d.p1.p - 1) * 100;
            c.fillStyle = col; c.textAlign = 'left';
            c.fillText((pct >= 0 ? '+' : '') + pct.toFixed(2) + '%', xa + 5, ya + 12);
          }
        } else if (d.type === 'fib') {
          const y1 = g.y1, y2 = g.y2, xa = Math.min(g.x1, g.x2), xb = Math.max(g.x1, g.x2);
          c.globalAlpha = .05; c.fillStyle = col;
          c.fillRect(xa, Math.min(y1, y2), xb - xa, Math.abs(y2 - y1)); c.globalAlpha = 1;
          let lastLab = -1e9;
          FIB_LV.forEach(r => {
            const p = d.p1.p + (d.p2.p - d.p1.p) * r, y = this.pyOfPrice(p, L, R);
            c.setLineDash(r === 0 || r === 1 ? [] : [4, 3]);
            c.strokeStyle = col; c.lineWidth = r === 0 || r === 1 ? lw : Math.max(1, lw - .2);
            c.beginPath(); c.moveTo(xa, y); c.lineTo(xb, y); c.stroke();
            c.setLineDash([]);
            /* 價位太擠時只標記不重疊的那幾條，避免字疊在一起 */
            if (Math.abs(y - lastLab) < 13) return;
            lastLab = y;
            const lbl = (r === 0 ? '0' : r === 1 ? '1' : r.toFixed(3).slice(1)) + '  ' + U.pxSym(p);
            c.font = '9.5px "JetBrains Mono",monospace';
            const tw = c.measureText(lbl).width + 6;
            const inside = xb + 4 + tw <= L.x1;
            c.fillStyle = 'rgba(10,13,18,.78)';
            c.fillRect(inside ? xb + 3 : xb - 4 - tw, y - 9, tw, 12);
            c.fillStyle = col; c.textAlign = inside ? 'left' : 'right';
            c.fillText(lbl, inside ? xb + 6 : xb - 7, y - .5);
          });
        } else {
          c.beginPath(); c.moveTo(g.x1, g.y1); c.lineTo(g.x2, g.y2); c.stroke();
          if (d.type === 'measure') {
            /* 兩端短豎線 + 中央量測標籤 */
            c.lineWidth = Math.max(1, lw - .2);
            c.beginPath(); c.moveTo(g.x1, g.y1 - 5); c.lineTo(g.x1, g.y1 + 5);
            c.moveTo(g.x2, g.y2 - 5); c.lineTo(g.x2, g.y2 + 5); c.stroke();
            if (d.p2) {
              const lbl = this.measureText(d);
              c.font = '10px "JetBrains Mono",monospace';
              const tw = c.measureText(lbl).width + 12;
              const mx = (g.x1 + g.x2) / 2, my = (g.y1 + g.y2) / 2;
              const bx = U.clamp(mx - tw / 2, L.x0, L.x1 - tw);
              c.fillStyle = col; c.globalAlpha = .92;
              c.fillRect(bx, my - 20, tw, 16); c.globalAlpha = 1;
              c.fillStyle = '#0b0e13'; c.textAlign = 'left';
              c.fillText(lbl, bx + 6, my - 8.5);
            }
          }
        }
        /* 選取／端點標記：白心圓點，讓「可以拖」看得出來 */
        if (!isDraft && (sel || d.type === 'measure')) {
          const pts = d.type === 'hline' ? [[g.x1, g.y1]] : (d.p2 ? [[g.x1, g.y1], [g.x2, g.y2]] : [[g.x1, g.y1]]);
          pts.forEach(pt => {
            c.beginPath(); c.arc(pt[0], pt[1], sel ? 4 : 3, 0, 6.2832);
            c.fillStyle = '#0b0e13'; c.fill();
            c.strokeStyle = col; c.lineWidth = 2; c.stroke();
            c.beginPath(); c.arc(pt[0], pt[1], 1.4, 0, 6.2832);
            c.fillStyle = '#f2f5fa'; c.fill();
          });
        }
        c.restore();
      });
    },
    /* ══════════ 保存與還原（localStorage）══════════
       視圖：cs.ui.chart.<symbol>.<tf>　繪圖：cs.drawing.<symbol>.<tf> */
    readLS(key) {
      try { const v = w.localStorage.getItem(key); return v ? JSON.parse(v) : null; }
      catch (e) { S.errors.push('LS 讀取 ' + key + ': ' + e.message); return null; }
    },
    writeLS(key, val) {
      try { w.localStorage.setItem(key, JSON.stringify(val)); }
      catch (e) { /* 隱私模式或容量不足：靜默忽略，不影響看圖 */ }
    },
    saveView() {
      if (!this.k.length) return;
      this.writeLS('cs.ui.chart.' + this.viewKey(), { start: +this.vw.start.toFixed(4), count: +this.vw.count.toFixed(4), follow: this.follow, ts: Date.now() });
    },
    loadView() {
      const v = this.readLS('cs.ui.chart.' + this.viewKey());
      if (!v || !(v.count > 0)) { this.fit(); return; }
      this.vw.count = this._clampCount(v.count);
      this.vw.start = v.start;
      this.follow = !!v.follow;
      this.clampView();
      if (this.follow) this.vw.start = Math.max(0, this.k.length - this.vw.count);
    },
    saveDrawings() {
      if (!this.k.length) return;
      const list = this.drawings.map(d => ({
        id: d.id, type: d.type,
        p1: { t: d.p1.t, p: d.p1.p },
        p2: d.p2 ? { t: d.p2.t, p: d.p2.p } : null,
        color: d.color, lw: d.lw
      }));
      this.writeLS('cs.drawing.' + this.viewKey(), { v: 1, list: list, ts: Date.now() });
    },
    loadDrawings() {
      this.drawings = []; this.draft = null; this.sel = null;
      const d = this.readLS('cs.drawing.' + this.viewKey());
      const fin = n => typeof n === 'number' && isFinite(n);
      if (d && d.list && d.list.length) {
        this.drawings = d.list.filter(x => x && x.type && x.p1 && fin(x.p1.t) && fin(x.p1.p))
          .map(x => ({
            id: x.id || ++this._id, type: x.type,
            p1: { t: +x.p1.t, p: +x.p1.p },
            p2: (x.p2 && fin(x.p2.t) && fin(x.p2.p)) ? { t: +x.p2.t, p: +x.p2.p } : null,
            color: x.color || this.dcolor, lw: x.lw || 1
          }));
        this._id = this.drawings.reduce((m, x) => Math.max(m, x.id), this._id);
      }
      this.syncTools();
    },
    emitView() { this.syncLive(); this.queueSaveView(); },
    queueSaveView() {
      if (!this._sv) this._sv = U.debounce(() => this.saveView(), 400);   /* 拖曳中不要每個像素都寫 */
      this._sv();
    },
    /* ══════════ 全螢幕 ══════════ */
    toggleFull(on) {
      const panel = this.canvas && this.canvas.closest('.chart-panel');
      if (!panel) return;
      const want = on === undefined ? !panel.classList.contains('ct-full') : !!on;
      panel.classList.toggle('ct-full', want);
      document.body.classList.toggle('ct-full-on', want);
      this.fullscreen = want;
      if (want) this.kbOn = true;
      if (this.ui.fb) {
        this.ui.fb.innerHTML = want ? SVG.fullx : SVG.full;
        this.ui.fb.classList.toggle('on', want);
        this.ui.fb.title = want ? '結束全螢幕（Esc）' : '放大到整個視窗（Esc 退出）';
      }
      this._yr = null;
      this.draw();
      setTimeout(() => { this.resizeDraws++; this._yr = null; this.draw(); }, 80);
    },

    /* ══════════ 滑鼠互動（平移／選取／繪製）══════════ */
    onDown(e, p) {
      const L = this.layout(); if (!L || !this.k.length) return;
      const R = this.rangeOf(L);
      if (this.tool === 'select') {
        const hit = this.hitTest(p.x, p.y, L, R);
        if (hit) {
          this.sel = hit.id;
          this.drag = { x: e.clientX, y: e.clientY, moved: 0, shape: hit, end: this.endPointAt(hit, p.x, p.y, L, R), last: this.anchorAt(p.x, p.y, L, R) };
          this.canvas.style.cursor = 'move';
          this.syncTools(); this.draw();
          return;
        }
        if (this.sel) { this.sel = null; this.syncTools(); }
        this.drag = { x: e.clientX, y: e.clientY, moved: 0 };   /* 空白處拖曳＝平移 */
        this.canvas.style.cursor = 'grabbing';
        return;
      }
      const a = this.anchorAt(p.x, p.y, L, R);
      if (this.tool === 'hline') { this.commit(this.newShape('hline', a)); return; }
      if (!this.draft) {
        this.draft = this.newShape(this.tool, a);
        this.draft.p2 = a;
        this.drag = { draw: true, x: e.clientX, y: e.clientY };
      } else {
        this.draft.p2 = a;
        this.commit(this.draft);
      }
      this.syncTools();
    },
    onMove(e, p) {
      const L = this.layout(); if (!L) return;
      const R = this.rangeOf(L);
      if (this.drag && this.drag.shape) {                 /* 拖端點或整段拖移 */
        const d = this.drag.shape, a = this.anchorAt(p.x, p.y, L, R);
        if (this.drag.end) d[this.drag.end] = a;
        else {
          const dt = a.t - this.drag.last.t, dp = a.p - this.drag.last.p;
          if (d.p1) d.p1 = { t: d.p1.t + dt, p: d.p1.p + dp };
          if (d.p2) d.p2 = { t: d.p2.t + dt, p: d.p2.p + dp };
          this.drag.last = a;
        }
        this.saveDrawings(); this.draw();
        return;
      }
      if (this.drag && this.drag.draw) {                  /* 按住拖曳繪製（測量）*/
        if (this.draft) this.draft.p2 = this.anchorAt(p.x, p.y, L, R);
        this.draw(); return;
      }
      if (this.drag) {                                    /* 拖曳平移視圖 */
        const dx = e.clientX - this.drag.x;
        if (dx) { this.drag.x = e.clientX; this.drag.moved += Math.abs(dx); this.panBy(dx); }
        return;
      }
      if (this.draft) this.draft.p2 = this.anchorAt(p.x, p.y, L, R);     /* 預覽跟隨游標 */
      else if (this.tool === 'select' && p.x >= L.x0 && p.x <= L.x1) {
        this.canvas.style.cursor = this.hitTest(p.x, p.y, L, R) ? 'move' : 'crosshair';
      }
    },
    onUp() {
      if (this.drag && this.drag.draw && this.draft && this.draft.type === 'measure') this.commit(this.draft);
      this.canvas.style.cursor = this.tool === 'select' ? 'crosshair' : 'copy';
      this.drag = null;
    },

    /* ═══ 互動 ═══ */
    init(canvas) {
      this.canvas = canvas;
      this.buildUI(canvas);
      this.buildTools(canvas);
      canvas.style.cursor = 'crosshair';
      canvas.style.touchAction = 'none';        /* 觸控拖曳不平移頁面 */
      const rel = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

      canvas.addEventListener('mousemove', e => {
        const p = rel(e);
        this.hover = { x: p.x, y: p.y, r: canvas.getBoundingClientRect() };
        this.kbOn = true;
        this.onMove(e, p);
        this.draw();
      });
      canvas.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        this.kbOn = true;
        const p = rel(e);
        this.hover = { x: p.x, y: p.y, r: canvas.getBoundingClientRect() };
        this.onDown(e, p);
        this.draw();
        e.preventDefault();                     /* 不選取文字、不觸發頁面捲動 */
      });
      w.addEventListener('mouseup', () => {
        if (!this.drag) return;
        this.onUp();
        this.draw();
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
          case 'v': case 'V': this.setTool('select'); break;
          case 't': case 'T': this.setTool('trend'); break;
          case 'h': case 'H': this.setTool('hline'); break;
          case 'b': case 'B': this.setTool('rect'); break;
          case 'f': case 'F': this.setTool('fib'); break;
          case 'm': case 'M': this.setTool('measure'); break;
          case 'Delete': this.deleteSel(); break;
          case 'Escape':
            if (this.fullscreen) this.toggleFull(false);
            else if (this.draft) { this.draft = null; this.syncTools(); this.draw(); }
            else this.setTool('select');
            break;
          default: used = false;
        }
        if (used) { e.preventDefault(); e.stopPropagation(); }
      });

      /* 關頁前把視圖補寫進去（去抖動的最後一次變更可能還沒落地）*/
      w.addEventListener('beforeunload', () => { this.saveView(); this.saveDrawings(); });

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
