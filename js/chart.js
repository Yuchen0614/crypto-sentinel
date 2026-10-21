/* chart.js — 全部 Canvas 繪圖：主圖表（K線/CVD/量能/VWAP/掛單牆）、深度熱圖、壓力計、OI 走勢 */
'use strict';
(function (w) {
  const S = w.SENTINEL, U = S.util;

  function fit(canvas) {
    const dpr = Math.min(2, w.devicePixelRatio || 1);
    const r = canvas.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) return null;
    const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { c, w: r.width, h: r.height };
  }
  S.fit = fit;

  /* ══════════════ 主圖表 ══════════════ */
  const Ch = S.chart = {
    canvas: null, k: [], tf: '5m', ov: { cvd: true, vol: true, vwap: false, walls: true },
    price: NaN, walls: [], lastDelta: [], hover: null,
    markers: [],                   // 巨鯨標記 {t, price, notional, side}
    setData(k) { this.k = k || []; this.series(); this.draw(); },
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
    init(canvas) {
      this.canvas = canvas;
      const move = e => { const r = canvas.getBoundingClientRect(); this.hover = { x: e.clientX - r.left, y: e.clientY - r.top, r }; this.draw(); };
      canvas.addEventListener('mousemove', move);
      canvas.addEventListener('mouseleave', () => { this.hover = null; this.draw(); const t = document.getElementById('chartHover'); if (t) t.innerHTML = ''; });
      new ResizeObserver(U.raf(() => this.draw())).observe(canvas.parentElement);
    },
    draw() {
      const f = fit(this.canvas); if (!f) return;
      const { c, w: W, h: H } = f;
      c.clearRect(0, 0, W, H);
      if (!this.k.length) { c.fillStyle = 'rgba(140,180,205,.5)'; c.font = '11px monospace'; c.fillText('載入 K 線資料…', 12, 22); return; }

      const padR = 62, padL = 8, padT = 10, axisH = 18;
      const volH = Math.round((H - padT - axisH) * (this.ov.vol || this.ov.cvd ? 0.26 : 0.001));
      const priceH = H - padT - axisH - volH - (volH > 4 ? 6 : 0);
      const x0 = padL, x1 = W - padR, y0 = padT, y1 = padT + priceH;
      const vy0 = y1 + 6, vy1 = H - axisH;

      const vis = this.k.slice(-160);
      let mn = Infinity, mx = -Infinity, vmn = Infinity, vmx = -Infinity;
      vis.forEach(k => { mn = Math.min(mn, k.l); mx = Math.max(mx, k.h); });
      // 掛單牆也納入範圍，方便觀察壓力位
      if (this.ov.walls) this.walls.forEach(wl => { if (isFinite(wl.px)) { mn = Math.min(mn, wl.px); mx = Math.max(mx, wl.px); } });
      if (isFinite(this.price)) { mn = Math.min(mn, this.price); mx = Math.max(mx, this.price); }
      const pad = (mx - mn) * 0.06 || mx * 0.001; mn -= pad; mx += pad;
      if (this.ov.vwap) { const vw = S.analytics.Trades.vwap(1800e3); if (isFinite(vw)) { mn = Math.min(mn, vw); mx = Math.max(mx, vw); } }
      const X = i => x0 + (i / (vis.length - 1 || 1)) * (x1 - x0);
      const Y = p => y1 - (p - mn) / (mx - mn || 1) * (y1 - y0);

      // 背景網格
      c.save();
      c.strokeStyle = 'rgba(56,246,255,.09)'; c.lineWidth = 1;
      c.font = '10px "Share Tech Mono", monospace'; c.fillStyle = 'rgba(143,178,201,.75)';
      for (let i = 0; i <= 5; i++) {
        const p = mn + (mx - mn) * i / 5, y = Math.round(Y(p)) + .5;
        c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke();
        c.textAlign = 'left'; c.fillText(U.pxSym(p), x1 + 6, y + 3.5);
      }
      c.textAlign = 'center';
      const step = Math.max(1, Math.round(vis.length / 7));
      for (let i = 0; i < vis.length; i += step) {
        const x = Math.round(X(i)) + .5;
        c.strokeStyle = 'rgba(56,246,255,.05)';
        c.beginPath(); c.moveTo(x, y0); c.lineTo(x, vy1); c.stroke();
        c.fillStyle = 'rgba(93,125,148,.9)';
        c.fillText(U.timeShort(vis[i].t), x, H - 5);
      }
      c.restore();

      // 量能柱
      if (this.ov.vol) {
        const vv = vis.map(k => k.q || 0);
        const vm = Math.max.apply(null, vv) || 1;
        vis.forEach((k, i) => {
          const bw = Math.max(1.5, (x1 - x0) / vis.length * .62);
          const h = (k.q / vm) * (vy1 - vy0);
          const up = k.c >= k.o;
          const g = c.createLinearGradient(0, vy1 - h, 0, vy1);
          g.addColorStop(0, up ? 'rgba(38,255,168,.55)' : 'rgba(255,77,109,.55)');
          g.addColorStop(1, up ? 'rgba(38,255,168,.06)' : 'rgba(255,77,109,.06)');
          c.fillStyle = g;
          c.fillRect(X(i) - bw / 2, vy1 - h, bw, h);
        });
      }

      // K 線
      const bw = Math.max(1.5, (x1 - x0) / vis.length * .62);
      vis.forEach((k, i) => {
        const up = k.c >= k.o, x = X(i);
        const col = up ? '#26ffa8' : '#ff4d6b';
        c.strokeStyle = up ? 'rgba(38,255,168,.75)' : 'rgba(255,77,109,.75)';
        c.lineWidth = 1;
        c.beginPath(); c.moveTo(x, Y(k.h)); c.lineTo(x, Y(k.l)); c.stroke();
        const yA = Y(Math.max(k.o, k.c)), yB = Y(Math.min(k.o, k.c));
        const hgt = Math.max(1.2, yB - yA);
        c.fillStyle = up ? 'rgba(38,255,168,.30)' : 'rgba(255,77,109,.30)';
        c.fillRect(x - bw / 2, yA, bw, hgt);
        c.strokeStyle = col; c.lineWidth = 1;
        c.strokeRect(x - bw / 2 + .5, yA + .5, Math.max(1, bw - 1), Math.max(1, hgt - 1));
      });

      // CVD
      if (this.ov.cvd && this.cvd && this.cvd.length) {
        const cv = this.cvd.slice(-vis.length);
        let cmn = Math.min.apply(null, cv), cmx = Math.max.apply(null, cv);
        if (cmn === cmx) { cmn -= 1; cmx += 1; }
        const CY = v => vy1 - (v - cmn) / (cmx - cmn) * (vy1 - vy0) * .92 - 2;
        c.beginPath();
        cv.forEach((v, i) => i ? c.lineTo(X(i), CY(v)) : c.moveTo(X(i), CY(v)));
        c.strokeStyle = '#38f6ff'; c.lineWidth = 1.6;
        c.shadowColor = 'rgba(56,246,255,.85)'; c.shadowBlur = 8;
        c.stroke(); c.shadowBlur = 0;
        // CVD 零軸參考
        c.fillStyle = 'rgba(56,246,255,.85)'; c.font = '9px "Share Tech Mono",monospace'; c.textAlign = 'left';
        c.fillText('CVD ' + U.signed(cv[cv.length - 1], v => U.money(v)), x0 + 2, vy0 + 10);
      }

      // VWAP
      if (this.ov.vwap) {
        const vw = S.analytics.Trades.vwap(1800e3);
        if (isFinite(vw) && vw > mn && vw < mx) {
          const y = Y(vw);
          c.save(); c.setLineDash([5, 4]); c.strokeStyle = '#ffc857'; c.lineWidth = 1.1;
          c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke(); c.restore();
          c.fillStyle = '#ffc857'; c.font = '9px "Share Tech Mono",monospace'; c.textAlign = 'left';
          c.fillText('VWAP 30M ' + U.px(vw), x0 + 2, y - 4);
        }
      }

      // 掛單牆水平線
      if (this.ov.walls) {
        this.walls.slice(0, 6).forEach(wl => {
          if (!isFinite(wl.px) || wl.px < mn || wl.px > mx) return;
          const y = Math.round(Y(wl.px)) + .5;
          const bid = wl.side === 'bid';
          c.save();
          c.setLineDash([2, 3]); c.lineWidth = 1.2;
          c.strokeStyle = bid ? 'rgba(38,255,168,.75)' : 'rgba(255,77,109,.75)';
          c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke();
          c.restore();
          const label = `${bid ? 'BID' : 'ASK'} ${U.px(wl.px)} · ${U.usd(wl.notional)}`;
          c.font = '9px "Share Tech Mono",monospace';
          const tw = c.measureText(label).width + 6;
          c.fillStyle = bid ? 'rgba(6,32,24,.92)' : 'rgba(38,6,16,.92)';
          c.fillRect(x0 + 2, y - 11, tw, 11);
          c.fillStyle = bid ? '#26ffa8' : '#ff4d6b';
          c.textAlign = 'left'; c.fillText(label, x0 + 5, y - 2.5);
        });
      }

      // 巨鯨成交標記
      const t0 = vis[0].t;
      this.markers.slice(-40).forEach(m => {
        if (m.t < t0) return;
        const idx = vis.findIndex(k => k.t + this.tfMs() > m.t);
        if (idx < 0 || m.price < mn || m.price > mx) return;
        const x = X(idx), y = Y(m.price);
        c.beginPath(); c.arc(x, y, Math.min(7, 2.5 + Math.log10(m.notional / 50000 + 1) * 2), 0, 6.2832);
        c.fillStyle = m.side === 'buy' ? 'rgba(38,255,168,.28)' : 'rgba(255,62,165,.28)';
        c.strokeStyle = m.side === 'buy' ? '#26ffa8' : '#ff3ea5';
        c.lineWidth = 1.2; c.fill(); c.stroke();
      });

      // 現價線
      if (isFinite(this.price)) {
        const y = Y(this.price);
        c.save();
        c.setLineDash([4, 3]); c.strokeStyle = 'rgba(234,252,255,.65)'; c.lineWidth = 1;
        c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke(); c.restore();
        const lbl = U.pxSym(this.price);
        c.font = 'bold 11px "Share Tech Mono",monospace';
        const tw = c.measureText(lbl).width + 8;
        c.fillStyle = '#38f6ff'; c.fillRect(x1 + 2, y - 8, tw, 16);
        c.fillStyle = '#04121a'; c.textAlign = 'left'; c.fillText(lbl, x1 + 6, y + 4);
      }

      // 十字準線與浮動提示
      if (this.hover && this.hover.x > x0 && this.hover.x < x1) {
        const i = U.clamp(Math.round((this.hover.x - x0) / (x1 - x0) * (vis.length - 1)), 0, vis.length - 1);
        const k = vis[i], x = X(i);
        c.save(); c.setLineDash([3, 3]); c.strokeStyle = 'rgba(56,246,255,.55)';
        c.beginPath(); c.moveTo(x, y0); c.lineTo(x, vy1); c.stroke();
        if (this.hover.y > y0 && this.hover.y < y1) { c.beginPath(); c.moveTo(x0, this.hover.y); c.lineTo(x1, this.hover.y); c.stroke(); }
        c.restore();
        const tip = document.getElementById('chartHover');
        if (tip) {
          const dp = k.c >= k.o ? '+' : '';
          tip.innerHTML = `<div class="chart-tip" style="left:${x}px;top:${Math.min(this.hover.y, y1 - 10)}px">` +
            `${new Date(k.t).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}\n` +
            `開 ${U.px(k.o)}  高 ${U.px(k.h)}\n低 ${U.px(k.l)}  收 ${U.px(k.c)}\n` +
            `漲跌 ${dp}${((k.c / k.o - 1) * 100).toFixed(2)}%\n量 ${U.usd(k.q)}\n主動買賣差 ${U.signed(k.delta || 0, v => U.money(v))}</div>`;
        }
      }
    },
    tfMs() { return { '1m': 6e4, '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5 }[this.tf] || 3e5; }
  };

  /* ══════════════ 深度熱圖 ══════════════ */
  const HM = S.heat = {
    canvas: null, off: null,
    init(canvas) { this.canvas = canvas; new ResizeObserver(U.raf(() => this.draw())).observe(canvas.parentElement); },
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
      c.font = '9px "Share Tech Mono",monospace'; c.textAlign = 'left'; c.fillStyle = 'rgba(143,178,201,.8)';
      for (let i = 0; i <= 4; i++) {
        const off = span * (1 - 2 * i / 4), y = padT + dh * i / 4;
        c.fillText(U.pxSym(cmid * (1 + off)), 4 + dw + 6, y + 3);
      }
      // 深度範圍標示
      c.fillStyle = 'rgba(93,125,148,.95)';
      c.fillText('±' + (span * 100).toFixed(3) + '%', 4 + dw + 6, padT + dh - 4);
      const mn = -span, mx = span;
      // 現價線
      const live = S.analytics.Book.mid;
      if (isFinite(live) && live >= mn && live <= mx) {
        const y = padT + dh * (1 - (live - mn) / (mx - mn));
        c.save(); c.setLineDash([3, 3]); c.strokeStyle = 'rgba(234,252,255,.8)'; c.lineWidth = 1;
        c.beginPath(); c.moveTo(4, y); c.lineTo(4 + dw, y); c.stroke(); c.restore();
      }
      c.textAlign = 'left'; c.fillStyle = 'rgba(93,125,148,.9)';
      c.fillText('← 較早', 6, H - 3);
      c.textAlign = 'right'; c.fillText('最新 →', 4 + dw, H - 3);
      c.textAlign = 'left'; c.fillStyle = 'rgba(93,125,148,.8)';
      c.fillText('掛單密度熱圖 · 縱軸為距現價距離（自適應深度範圍）', 6, padT + 11);

      U.text('#hFrames', F + ' 格 · ' + Math.round(F * 2) + ' 秒');
      U.text('#hMax', U.usd(gmax));
    }
  };

  /* ══════════════ 聰明錢壓力計 ══════════════ */
  const G = S.gauge = {
    canvas: null, val: 0, target: 0, raf: 0, cls: 'neu',
    init(canvas) { this.canvas = canvas; new ResizeObserver(U.raf(() => this.draw())).observe(canvas.parentElement); this.loop(); },
    set(v, cls) { this.target = U.clamp(v, 0, 100); this.cls = cls || 'neu'; },
    loop() {
      const d = this.target - this.val;
      if (Math.abs(d) > .15) { this.val += d * .12; this.draw(); }
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
      grad.addColorStop(0, 'rgba(255,77,109,.85)');
      grad.addColorStop(.35, 'rgba(255,200,87,.7)');
      grad.addColorStop(.5, 'rgba(143,178,201,.5)');
      grad.addColorStop(.7, 'rgba(56,246,255,.8)');
      grad.addColorStop(1, 'rgba(38,255,168,.95)');
      c.beginPath(); c.arc(cx, cy, R, A0, A1); c.arc(cx, cy, R - 12, A1, A0, true); c.closePath();
      c.fillStyle = 'rgba(255,255,255,.07)'; c.fill();
      c.strokeStyle = 'rgba(56,246,255,.18)'; c.lineWidth = 1; c.stroke();

      // 刻度
      for (let i = 0; i <= 10; i++) {
        const a = A0 + (A1 - A0) * i / 10;
        const r1 = R - 13, r2 = R - (i % 5 === 0 ? 22 : 18);
        c.beginPath();
        c.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
        c.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
        c.strokeStyle = i % 5 === 0 ? 'rgba(56,246,255,.55)' : 'rgba(56,246,255,.22)';
        c.lineWidth = i % 5 === 0 ? 1.6 : 1; c.stroke();
      }
      // 已達分數弧
      const k = U.clamp(this.val / 100, 0, 1);
      const aEnd = A0 + (A1 - A0) * k;
      c.beginPath(); c.arc(cx, cy, R, A0, aEnd); c.arc(cx, cy, R - 12, aEnd, A0, true); c.closePath();
      c.fillStyle = grad; c.globalAlpha = .95; c.fill(); c.globalAlpha = 1;
      c.save();
      c.shadowColor = k > .55 ? 'rgba(38,255,168,.8)' : (k < .45 ? 'rgba(255,77,109,.8)' : 'rgba(56,246,255,.8)');
      c.shadowBlur = 18;
      c.beginPath(); c.arc(cx, cy, R - 6, A0, aEnd);
      c.strokeStyle = 'rgba(255,255,255,.55)'; c.lineWidth = 2; c.stroke();
      c.restore();

      // 指針
      c.save();
      c.translate(cx, cy); c.rotate(aEnd);
      c.beginPath(); c.moveTo(R - 26, 0); c.lineTo(-6, -3.2); c.lineTo(-6, 3.2); c.closePath();
      c.fillStyle = '#eafcff'; c.shadowColor = '#38f6ff'; c.shadowBlur = 12; c.fill();
      c.restore();
      c.beginPath(); c.arc(cx, cy, 4.5, 0, 6.2832); c.fillStyle = '#38f6ff'; c.fill();
      c.beginPath(); c.arc(cx, cy, 8.5, 0, 6.2832); c.strokeStyle = 'rgba(56,246,255,.5)'; c.lineWidth = 1; c.stroke();

      // 中軸文字位置留給 DOM（gauge-center）
    }
  };

  /* ══════════════ 未平倉量走勢 ══════════════ */
  const OI = S.oiChart = {
    canvas: null, series: [], times: [],
    init(c) { this.canvas = c; new ResizeObserver(U.raf(() => this.draw())).observe(c.parentElement); },
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
      g.addColorStop(0, 'rgba(56,246,255,.35)'); g.addColorStop(1, 'rgba(56,246,255,0)');
      c.beginPath(); c.moveTo(X(0), Y(s[0]));
      s.forEach((v, i) => c.lineTo(X(i), Y(v)));
      c.lineTo(X(s.length - 1), H); c.lineTo(X(0), H); c.closePath(); c.fillStyle = g; c.fill();
      c.beginPath(); s.forEach((v, i) => i ? c.lineTo(X(i), Y(v)) : c.moveTo(X(i), Y(v)));
      c.strokeStyle = '#38f6ff'; c.lineWidth = 1.5;
      c.shadowColor = 'rgba(56,246,255,.7)'; c.shadowBlur = 6; c.stroke(); c.shadowBlur = 0;
      // 最新點
      const lx = X(s.length - 1), ly = Y(s[s.length - 1]);
      c.beginPath(); c.arc(lx, ly, 2.6, 0, 6.2832); c.fillStyle = '#eafcff'; c.fill();
      c.font = '9px "Share Tech Mono",monospace'; c.fillStyle = 'rgba(143,178,201,.85)'; c.textAlign = 'left';
      c.fillText('OI ' + U.money(s[s.length - 1]), 5, 10);
      const chg = (s[s.length - 1] / s[0] - 1) * 100;
      c.fillStyle = chg >= 0 ? '#26ffa8' : '#ff4d6b'; c.textAlign = 'right';
      c.fillText(U.pct(chg), W - 5, 10);
    }
  };
})(window);
