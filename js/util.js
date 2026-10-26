/* util.js — 共用工具、格式化、事件匯流排、健康檢查 */
'use strict';
(function (w) {
  const S = w.SENTINEL = w.SENTINEL || {};
  S.errors = [];
  w.addEventListener('error', e => S.errors.push('error: ' + (e.message || e.type) + ' @' + (e.filename || '') + ':' + (e.lineno || 0)));
  w.addEventListener('unhandledrejection', e => S.errors.push('promise: ' + (e.reason && e.reason.message || e.reason)));

  const U = S.util = {};

  /* ── 數字 ─────────────────────────────────────────── */
  U.num = v => (v === null || v === undefined || v === '' || isNaN(v)) ? NaN : (typeof v === 'number' ? v : parseFloat(v));
  U.fmt = (v, d) => { const n = U.num(v); if (!isFinite(n)) return '—'; return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); };

  // 自適應價位精度
  U.px = v => {
    const n = U.num(v); if (!isFinite(n)) return '—';
    const a = Math.abs(n);
    if (a >= 10000) return U.fmt(n, 1);
    if (a >= 1000) return U.fmt(n, 2);
    if (a >= 100) return U.fmt(n, 3);
    if (a >= 1) return U.fmt(n, 4);
    if (a >= 0.01) return U.fmt(n, 5);
    if (a >= 0.0001) return U.fmt(n, 6);
    return n.toPrecision(4);
  };
  // 數量精度（依價格量級）
  U.qty = v => {
    const n = U.num(v); if (!isFinite(n)) return '—';
    if (n >= 10000) return U.fmt(n, 0);
    if (n >= 100) return U.fmt(n, 2);
    if (n >= 1) return U.fmt(n, 3);
    return U.fmt(n, 4);
  };
  // 金額縮寫
  U.money = v => {
    const n = U.num(v); if (!isFinite(n)) return '—';
    const s = n < 0 ? '-' : '', a = Math.abs(n);
    if (a >= 1e12) return s + (a / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return s + (a / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return s + (a / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return s + (a / 1e3).toFixed(1) + 'K';
    return s + a.toFixed(2);
  };
  U.usd = v => '$' + U.money(v);
  U.pct = (v, d) => { const n = U.num(v); if (!isFinite(n)) return '—'; return (n > 0 ? '+' : '') + n.toFixed(d === undefined ? 2 : d) + '%'; };
  U.signed = (v, fmt) => { const n = U.num(v); if (!isFinite(n)) return '—'; return (n > 0 ? '+' : '') + (fmt ? fmt(n) : U.money(n)); };
  U.cls = v => { const n = U.num(v); return !isFinite(n) || n === 0 ? 'flat' : (n > 0 ? 'up' : 'down'); };
  U.clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  U.time = ts => { const d = new Date(ts); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0'); };
  U.timeShort = ts => { const d = new Date(ts); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  /* 依 K 線週期選時間軸格式：日內給 HH:MM，跨日以上給日期（否則大週期每格都長一樣） */
  U.timeAxis = (ts, tf) => {
    const d = new Date(ts);
    const mo = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
    const HH = String(d.getHours()).padStart(2, '0'), MM = String(d.getMinutes()).padStart(2, '0');
    if (tf === '1M' || tf === '1w' || tf === '3d' || tf === '1d') return mo + '/' + dd;
    if (tf === '12h' || tf === '6h' || tf === '4h' || tf === '2h') return mo + '/' + dd + ' ' + HH + ':00';
    return HH + ':' + MM;
  };
  U.ago = ts => { const s = Math.max(0, (Date.now() - ts) / 1000); if (s < 60) return Math.round(s) + 's'; if (s < 3600) return Math.round(s / 60) + 'm'; return Math.round(s / 3600) + 'h'; };

  /* ── 統計 ─────────────────────────────────────────── */
  U.median = a => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  U.mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
  U.stdev = a => { if (a.length < 2) return 0; const m = U.mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };
  U.sum = a => a.reduce((x, y) => x + y, 0);
  U.last = a => a[a.length - 1];
  U.slope = (a, n) => { // 最近 n 點的線性回歸斜率（歸一化為每點變化率）
    const s = a.slice(-(n || a.length)).filter(isFinite); if (s.length < 3) return 0;
    const N = s.length, sx = N * (N - 1) / 2, sxx = (N - 1) * N * (2 * N - 1) / 6, sy = U.sum(s), sxy = s.reduce((t, y, i) => t + i * y, 0);
    const den = N * sxx - sx * sx; if (!den) return 0;
    return (N * sxy - sx * sy) / den;
  };
  U.pcorr = (a, b) => { // 皮爾森相關
    const n = Math.min(a.length, b.length); if (n < 3) return 0;
    const A = a.slice(-n), B = b.slice(-n), ma = U.mean(A), mb = U.mean(B);
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { const x = A[i] - ma, y = B[i] - mb; num += x * y; da += x * x; db += y * y; }
    return (da && db) ? num / Math.sqrt(da * db) : 0;
  };

  /* ── DOM ──────────────────────────────────────────── */
  U.$ = s => document.querySelector(s);
  U.$$ = s => Array.prototype.slice.call(document.querySelectorAll(s));
  U.el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
  U.text = (sel, v) => { const e = typeof sel === 'string' ? document.querySelector(sel) : sel; if (e && e.textContent !== v) e.textContent = v; return e; };
  U.html = (sel, v) => { const e = typeof sel === 'string' ? document.querySelector(sel) : sel; if (e && e.innerHTML !== v) e.innerHTML = v; return e; };
  // 數字滾動動畫
  U.animateNum = (el, to, render, dur) => {
    if (!el) return; const from = el.__v === undefined ? to : el.__v; el.__v = to;
    if (!isFinite(from) || !isFinite(to) || from === to) { el.textContent = render(to); return; }
    const t0 = performance.now(), D = dur || 420;
    cancelAnimationFrame(el.__raf || 0);
    const step = t => {
      const k = U.clamp((t - t0) / D, 0, 1), e = 1 - Math.pow(1 - k, 3), v = from + (to - from) * e;
      el.textContent = render(v);
      if (k < 1) el.__raf = requestAnimationFrame(step);
    };
    el.__raf = requestAnimationFrame(step);
  };

  /* ── 事件匯流排 ───────────────────────────────────── */
  const bus = {};
  S.on = (n, f) => { (bus[n] = bus[n] || []).push(f); return () => { bus[n] = bus[n].filter(x => x !== f); }; };
  S.emit = (n, d) => { (bus[n] || []).forEach(f => { try { f(d); } catch (e) { S.errors.push('handler ' + n + ': ' + e.message); } }); };

  /* ── 節流／去抖 ───────────────────────────────────── */
  U.raf = f => { let q = false, l = null; return function () { l = arguments; if (q) return; q = true; requestAnimationFrame(() => { q = false; f.apply(null, l); }); }; };
  U.debounce = (f, ms) => { let t; return function () { clearTimeout(t); const a = arguments; t = setTimeout(() => f.apply(null, a), ms); }; };

  /* ── sparkline（迷你走勢）──────────────────────────── */
  U.spark = (canvas, data, color, fill) => {
    if (!canvas || !data || data.length < 2) return;
    const dpr = Math.min(2, w.devicePixelRatio || 1), W = canvas.clientWidth || 56, H = canvas.clientHeight || 16;
    if (canvas.width !== W * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
    const c = canvas.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    let mn = Infinity, mx = -Infinity;
    for (const v of data) { if (v < mn) mn = v; if (v > mx) mx = v; }
    if (mn === mx) { mn -= 1; mx += 1; }
    const X = i => i / (data.length - 1) * (W - 2) + 1, Y = v => H - 2 - (v - mn) / (mx - mn) * (H - 4);
    if (fill) {
      const g = c.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, color + '55'); g.addColorStop(1, color + '00');
      c.beginPath(); c.moveTo(X(0), Y(data[0]));
      data.forEach((v, i) => c.lineTo(X(i), Y(v)));
      c.lineTo(X(data.length - 1), H); c.lineTo(X(0), H); c.closePath(); c.fillStyle = g; c.fill();
    }
    c.beginPath(); c.moveTo(X(0), Y(data[0]));
    data.forEach((v, i) => c.lineTo(X(i), Y(v)));
    c.strokeStyle = color; c.lineWidth = 1.2; c.lineJoin = 'round'; c.stroke();
  };

  // 依該交易對的 tick 精度顯示價位（避免 BTC 的 82,756.0 / 82,756.01 被顯示成同一價）
  U.pxSym = v => {
    const n = U.num(v); if (!isFinite(n)) return '—';
    const dec = (S.state && S.state.cur && S.state.cur.dec !== undefined) ? S.state.cur.dec : null;
    const a = Math.abs(n);
    if (dec === null || a < 1) return U.px(n);
    return U.fmt(n, Math.max(dec, a >= 1000 ? 2 : 4));
  };

  U.hsl = (h, s, l, a) => `hsla(${h},${s}%,${l}%,${a === undefined ? 1 : a})`;
  // 熱圖色帶（低→高）
  U.heatColor = t => {
    t = U.clamp(t, 0, 1);
    const stops = [[20, 26, 34], [30, 58, 96], [52, 110, 160], [92, 170, 215], [150, 215, 235], [245, 165, 36]];
    const k = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(k)), f = k - i;
    const a = stops[i], b = stops[i + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  };

  /* Canvas 尺寸適配（DPR 縮放）：繪圖模組共用。
     原本定義在 chart.js，但獨立頁 onchain.html 只載入 fx.js 畫雷達、不載 chart.js，
     所以搬到 util 這一層，避免 S.fit 找不到。 */
  S.fit = function (canvas) {
    const dpr = Math.min(2, w.devicePixelRatio || 1);
    const r = canvas.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) return null;
    const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { c, w: r.width, h: r.height };
  };

  S.ready = (fn) => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', fn) : fn();
})(window);
