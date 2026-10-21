/* fx.js — 動畫特效層：通知、浮動金額、數字跳動、切換閃光、開機資料雨與掃描環、鏈上聲納雷達 */
'use strict';
(function (w) {
  const S = w.SENTINEL, U = S.util;
  const FX = S.fx = {};
  const reduced = () => w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── 通知 toast ───────────────────────────────────── */
  const toasts = [];
  FX.toast = function (a) {
    const box = document.getElementById('toasts'); if (!box || reduced()) return;
    while (toasts.length >= 4) { const old = toasts.shift(); old && old.remove(); }
    const el = U.el('div', 'toast ' + (a.sev || 'low'));
    el.innerHTML = `<span class="tk">${a.tag || 'ALERT'} · ${U.time(Date.now())}</span><b>${a.title}</b>` + (a.text ? `<span>${a.text}</span>` : '');
    box.appendChild(el);
    toasts.push(el);
    const kill = () => { el.classList.add('out'); setTimeout(() => { el.remove(); const i = toasts.indexOf(el); if (i >= 0) toasts.splice(i, 1); }, 420); };
    el.addEventListener('click', kill);
    setTimeout(kill, 6500);
  };

  /* ── 浮動金額標籤（從某個元素上方飄升）──────────────── */
  FX.floatTag = function (anchorEl, text, color) {
    if (!anchorEl || reduced()) return;
    const r = anchorEl.getBoundingClientRect();
    const el = U.el('div', 'float-tag', text);
    el.style.color = color || 'var(--cy)';
    el.style.left = Math.max(8, Math.min(innerWidth - 120, r.left + r.width / 2 - 30)) + 'px';
    el.style.top = (r.top + 2) + 'px';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2000);
  };

  /* ── 數字跳動 ─────────────────────────────────────── */
  FX.bump = function (el) {
    if (!el || reduced()) return;
    if (el.__bt) clearTimeout(el.__bt);
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    el.__bt = setTimeout(() => el.classList.remove('bump'), 480);
  };

  /* ── 全螢幕切換閃光 ───────────────────────────────── */
  FX.glitch = function () {
    const v = document.getElementById('glitchVeil'); if (!v || reduced()) return;
    v.classList.remove('on'); void v.offsetWidth; v.classList.add('on');
  };

  /* ── 面板資料流動線 ───────────────────────────────── */
  FX.streamLine = function (panel) {
    if (!panel || reduced()) return;
    let l = panel.querySelector('.stream-line');
    if (!l) { l = U.el('div', 'stream-line'); panel.appendChild(l); }
    l.classList.remove('go'); void l.offsetWidth; l.classList.add('go');
    setTimeout(() => l.classList.remove('go'), 1100);
  };

  /* ── 開機：資料雨 + 逐步打勾 ──────────────────────── */
  FX.bootRain = function () {
    const cv = document.getElementById('bootrain'); if (!cv || reduced()) return;
    const c = cv.getContext('2d');
    let W, H, cols = [];
    function size() {
      W = cv.width = innerWidth; H = cv.height = innerHeight;
      const n = Math.floor(W / 16);
      cols = new Array(n).fill(0).map(() => ({ y: Math.random() * H, v: 3 + Math.random() * 9, ch: Math.random() }));
    }
    size(); addEventListener('resize', size);
    const CH = '01ABCDEF#$%&@{}[]<>+=ABCDEF0123456789';
    let last = 0;
    (function loop(t) {
      if (t - last < 60) return requestAnimationFrame(loop);
      last = t;
      c.fillStyle = 'rgba(4,6,13,.30)'; c.fillRect(0, 0, W, H);
      c.font = '13px "Share Tech Mono",monospace';
      cols.forEach((col, i) => {
        col.y += col.v;
        if (col.y > H + 40) { col.y = -20 - Math.random() * 200; col.v = 3 + Math.random() * 9; }
        const x = i * 16 + 4;
        c.fillStyle = 'rgba(56,246,255,.55)';
        c.fillText(CH[(Math.random() * CH.length) | 0], x, col.y);
        c.fillStyle = 'rgba(56,246,255,.16)';
        c.fillText(CH[(Math.random() * CH.length) | 0], x, col.y - 14);
      });
      if (!document.getElementById('boot').classList.contains('done')) requestAnimationFrame(loop);
      else { c.clearRect(0, 0, W, H); }
    })(0);
  };

  /* ── 鏈上聲納雷達 ─────────────────────────────────── */
  FX.initRadar = function (canvas) {
    if (!canvas) return;
    const R = S.onchain.radar;
    let sweep = 0, prevCount = 0, t0 = performance.now();
    const ripples = [];
    let lastFrame = 0;
    function loop(t) {
      requestAnimationFrame(loop);
      if (t - lastFrame < 33) return;         // ~30fps
      lastFrame = t;
      const f = S.fit(canvas); if (!f) return;
      const { c, w: W, h: H } = f;
      c.clearRect(0, 0, W, H);
      const cx = W / 2, cy = H / 2, Rr = Math.min(W, H) * 0.44;

      // 格線與同心圓
      c.save();
      c.strokeStyle = 'rgba(56,246,255,.18)'; c.lineWidth = 1;
      [0.33, 0.66, 1].forEach(k => { c.beginPath(); c.arc(cx, cy, Rr * k, 0, 6.2832); c.stroke(); });
      c.strokeStyle = 'rgba(56,246,255,.10)';
      c.beginPath(); c.moveTo(cx - Rr, cy); c.lineTo(cx + Rr, cy); c.moveTo(cx, cy - Rr); c.lineTo(cx, cy + Rr); c.stroke();
      c.setLineDash([3, 4]); c.strokeStyle = 'rgba(56,246,255,.08)';
      c.beginPath(); c.moveTo(cx - Rr * .7, cy - Rr * .7); c.lineTo(cx + Rr * .7, cy + Rr * .7);
      c.moveTo(cx + Rr * .7, cy - Rr * .7); c.lineTo(cx - Rr * .7, cy + Rr * .7); c.stroke();
      c.setLineDash([]);

      // 掃描扇形
      sweep += 0.021;
      const g = c.createConicGradient ? null : null;
      const N = 40;
      for (let i = 0; i < N; i++) {
        const a = sweep - i * 0.035;
        c.strokeStyle = 'rgba(56,246,255,' + (0.30 * (1 - i / N)) + ')';
        c.beginPath(); c.moveTo(cx, cy);
        c.lineTo(cx + Math.cos(a) * Rr, cy + Math.sin(a) * Rr); c.stroke();
      }
      c.strokeStyle = 'rgba(127,249,255,.85)'; c.lineWidth = 1.4;
      c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(sweep) * Rr, cy + Math.sin(sweep) * Rr); c.stroke();
      c.lineWidth = 1;

      // 新 ping → 產生漣漪
      if (R.pings.length > prevCount) {
        const p = R.pings[R.pings.length - 1];
        ripples.push({ x: cx + Math.cos(p.ang) * Rr * p.r, y: cy + Math.sin(p.ang) * Rr * p.r, r: 2, max: 26, col: p.side === 'buy' ? '38,255,168' : '255,62,165', t: Date.now(), label: p.sym, usd: p.usd });
        prevCount = R.pings.length;
      } else if (R.pings.length < prevCount) prevCount = R.pings.length;

      // 既有光點（依存在時間淡出）
      const now = Date.now();
      R.pings.slice(-28).forEach(p => {
        const age = (now - p.ts) / 1000;
        const a = U.clamp(1 - age / 240, 0.12, 1);
        const x = cx + Math.cos(p.ang) * Rr * p.r, y = cy + Math.sin(p.ang) * Rr * p.r;
        const sz = U.clamp(1.4 + Math.log10(p.usd / 5000 + 1) * 1.9, 1.6, 6);
        c.beginPath(); c.arc(x, y, sz, 0, 6.2832);
        c.fillStyle = p.side === 'buy' ? `rgba(38,255,168,${a})` : `rgba(255,62,165,${a})`;
        c.shadowColor = c.fillStyle; c.shadowBlur = 12; c.fill(); c.shadowBlur = 0;
      });

      // 漣漪
      for (let i = ripples.length - 1; i >= 0; i--) {
        const rp = ripples[i];
        rp.r += 0.75; rp.max -= 0.02;
        const life = 1 - rp.r / (rp.max + 26);
        if (life <= 0 || rp.r > 60) { ripples.splice(i, 1); continue; }
        c.beginPath(); c.arc(rp.x, rp.y, rp.r, 0, 6.2832);
        c.strokeStyle = `rgba(${rp.col},${0.55 * life})`; c.stroke();
        c.beginPath(); c.arc(rp.x, rp.y, rp.r * 0.55, 0, 6.2832);
        c.strokeStyle = `rgba(${rp.col},${0.30 * life})`; c.stroke();
        if (rp.label && life > 0.55) {
          c.font = '9px "Share Tech Mono",monospace'; c.fillStyle = `rgba(234,252,255,${life})`;
          c.textAlign = 'left'; c.fillText(rp.label + ' $' + U.money(rp.usd), rp.x + 7, rp.y - 5);
        }
      }
      // 中心
      c.beginPath(); c.arc(cx, cy, 3, 0, 6.2832); c.fillStyle = 'rgba(127,249,255,.9)'; c.fill();
      c.restore();

      const st = document.getElementById('radarStatus');
      if (st) st.textContent = 'SCANNING · ' + (S.onchain.dex.chain || 'eth').toUpperCase();
      const rs = document.getElementById('radarStat');
      if (rs) {
        const d = S.onchain.dex;
        const big = d.trades.slice(0, 200).filter(t => t.usd >= d.min).length;
        rs.textContent = `${d.pools.length} 池 · ${d.wallets.size} 錢包 · ${big} 筆大額`;
      }
    }
    requestAnimationFrame(loop);
  };

  /* ── 背景：透視地板 + 隨機雜訊條 ──────────────────── */
  FX.initBackground = function () {
    const cv = document.getElementById('starfield'); if (!cv) return;
    const c = cv.getContext('2d');
    let W, H, dots = [], bars = [], scan = 0;
    function size() {
      const dpr = Math.min(2, w.devicePixelRatio || 1);
      W = cv.width = innerWidth * dpr; H = cv.height = innerHeight * dpr;
      cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px';
      const n = Math.min(150, Math.round(innerWidth * innerHeight / 16000));
      dots = [];
      for (let i = 0; i < n; i++) dots.push({ x: Math.random() * W, y: Math.random() * H, z: Math.random() * .8 + .2, s: Math.random() * 1.6 + .4 });
    }
    size(); addEventListener('resize', U.debounce(size, 250));
    let last = 0, floor = 0;
    (function loop(t) {
      requestAnimationFrame(loop);
      if (t - last < 33) return;
      last = t;
      c.clearRect(0, 0, W, H);
      // 星空
      for (const d of dots) {
        d.y -= d.z * .35;
        if (d.y < 0) { d.y = H; d.x = Math.random() * W; }
        const a = .12 + d.z * .5;
        c.fillStyle = d.z > .7 ? `rgba(56,246,255,${a})` : `rgba(143,178,201,${a * .7})`;
        c.fillRect(d.x, d.y, d.s, d.s);
      }
      // 透視地板格線（緩慢逼近，科幻感）
      if (!reduced()) {
        floor = (floor + 0.6) % 60;
        c.strokeStyle = 'rgba(56,246,255,.055)';
        for (let i = 0; i < 12; i++) {
          const y = H * 0.62 + Math.pow((i * 60 - floor) / 720, 2) * H * 2.1;
          if (y > H) continue;
          c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke();
        }
        for (let i = -8; i <= 8; i++) {
          c.beginPath(); c.moveTo(W / 2 + i * W * 0.055, H * 0.62); c.lineTo(W / 2 + i * W * 0.30, H); c.stroke();
        }
      }
      // 掃描光
      scan += 1.6;
      if (scan > H + 300) scan = -300;
      const g = c.createLinearGradient(0, scan - 120, 0, scan);
      g.addColorStop(0, 'rgba(56,246,255,0)'); g.addColorStop(1, 'rgba(56,246,255,.055)');
      c.fillStyle = g; c.fillRect(0, scan - 120, W, 120);
      // 雜訊條（極低機率）
      if (Math.random() < 0.004 && !reduced()) {
        bars.push({ y: Math.random() * H, h: 1 + Math.random() * 3, t: Date.now() });
      }
      for (let i = bars.length - 1; i >= 0; i--) {
        const b = bars[i], life = 1 - (Date.now() - b.t) / 240;
        if (life <= 0) { bars.splice(i, 1); continue; }
        c.fillStyle = `rgba(255,62,165,${0.10 * life})`;
        c.fillRect(0, b.y, W, b.h);
      }
    })(0);
  };
})(window);
