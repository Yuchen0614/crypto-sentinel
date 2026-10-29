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
  /* 拖曳視窗時的重繪策略：邊拖邊畫（最多每 100ms 一次，畫面不會變形或殘影），
     放手後 140ms 再補最後一次（尺寸一定是最終值）。
     單純 debounce 會讓拖曳過程中畫布被瀏覽器拉伸變形，單純 rAF 又等於每個事件都重畫。 */
  U.resizeRedraw = (f, ms) => {
    const wait = ms || 140;
    let last = 0, t = null;
    return function () {
      const now = performance.now();
      if (t) clearTimeout(t);
      if (now - last >= 100) { last = now; f(); }
      t = setTimeout(() => { t = null; last = performance.now(); f(); }, wait);
    };
  };

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

  /* ════════════════════════════════════════════════════════════
     介面偏好保存與還原（localStorage，鍵名一律 cs.ui.<key>）
     ────────────────────────────────────────────────────────────
     目的：換頁或重新整理回來時，選中的交易對、K 線週期、排序／篩選、
     捲動位置跟離開前一樣，而且是在第一次渲染之前就還原（不先畫預設再跳過去）。

     鍵名一覽：
       cs.ui.symbol        行情總覽選中的交易對
       cs.ui.tf            K 線週期（含「更多」下拉的冷門週期）
       cs.ui.scanSort      掃描表排序        cs.ui.scanQ    搜尋字串
       cs.ui.scanOnlyFut   僅合約            cs.ui.scanFavOnly 只看收藏
       cs.ui.whaleMin      巨鯨門檻
       cs.ui.index.scroll  行情總覽捲動位置（.0 主視窗 / .1 中欄 / .2 右欄 / .3 掃描表）
       cs.ui.oc.chain      鏈上頁選鏈        cs.ui.oc.min   鏈上門檻      cs.ui.oc.scroll
       cs.ui.sg.sort       持倉分析排序      cs.ui.sg.openMin 持倉門檻    cs.ui.sg.scroll
       cs.ui.rp.*          回測報表各分段鈕、搜尋、只看可靠資料、捲動位置
     檢視：SENTINEL.util.pref.keys()      清空：SENTINEL.util.pref.reset()
     ════════════════════════════════════════════════════════════ */
  const PFX = 'cs.ui.';
  /* 捲動容器可以用 id、CSS 選擇器或 'window' 指定（不必為了記位置去改 HTML 標記） */
  const pick = sel => sel === 'window' ? w : (document.getElementById(sel) || document.querySelector(sel));
  const pickAll = list => (list && list.length ? list.map(pick).filter(Boolean) : [w]);
  const LS = (function () {                     // localStorage 不可用（隱私模式等）時全部靜靜略過
    try { w.localStorage.setItem(PFX + '__t', '1'); w.localStorage.removeItem(PFX + '__t'); return w.localStorage; } catch (e) { return null; }
  })();

  const Pref = U.pref = {
    PFX,
    raw(key) { if (!LS) return null; try { return LS.getItem(PFX + key); } catch (e) { return null; } },
    get(key, dflt) {
      const s = this.raw(key); if (s === null || s === undefined) return dflt;
      try { return JSON.parse(s); } catch (e) { return dflt; }
    },
    set(key, val) {
      if (!LS) return;
      try { if (val === undefined || val === null) LS.removeItem(PFX + key); else LS.setItem(PFX + key, JSON.stringify(val)); } catch (e) { }
    },
    del(key) { if (!LS) return; try { LS.removeItem(PFX + key); } catch (e) { } },
    keys() {
      const o = {}; if (!LS) return o;
      try { for (let i = 0; i < LS.length; i++) { const k = LS.key(i); if (k && k.indexOf(PFX) === 0) o[k.slice(PFX.length)] = this.raw(k.slice(PFX.length)); } } catch (e) { }
      return o;
    },
    reset() {
      const n = Object.keys(this.keys()).length;
      Object.keys(this.keys()).forEach(k => this.del(k));
      try { console.info('[CS] 已清空 ' + n + ' 筆介面偏好（' + PFX + '*），重新整理就回到預設。'); } catch (e) { }
      return n;
    },

    /* ── 分段鈕（.seg）───────────────────────────────────
       各頁的按鈕用的 data-* 屬性名不同（data-sort／data-tf／data-win／data-key…），
       一律取「第一個 data-* 的值」當作辨識值，不必逐頁設定。 */
    segVal(btn) {
      if (!btn || !btn.attributes) return null;
      for (let i = 0; i < btn.attributes.length; i++) { const a = btn.attributes[i]; if (a.name.indexOf('data-') === 0) return a.value; }
      return btn.value || null;
    },
    bindSeg(id, key) {
      const box = document.getElementById(id); if (!box || box.__prefBound) return;
      box.__prefBound = true;
      box.addEventListener('click', e => {
        const b = e.target && e.target.closest ? e.target.closest('button') : null;
        if (!b || !box.contains(b)) return;
        const v = this.segVal(b); if (v !== null) this.set(key, v);
      });
    },
    /* 按下去等同使用者自己按：沿用各頁原本的 click 處理（狀態、重繪一起做）。
       requireLive：容器裡還沒出現任何 .on 按鈕時先不動（代表那一頁還沒綁好事件）。 */
    restoreSeg(id, key, requireLive) {
      const want = this.get(key, null);
      if (want === null || want === undefined) return true;
      const box = document.getElementById(id); if (!box) return true;
      const bs = box.querySelectorAll('button'); if (!bs.length) return false;
      if (requireLive !== false && !box.querySelector('button.on')) return false;
      for (let i = 0; i < bs.length; i++) {
        if (this.segVal(bs[i]) === String(want)) {
          if (!bs[i].classList.contains('on')) bs[i].click();
          return true;
        }
      }
      return true;    // 存的值在這個版本已經不存在（選項被移除）→ 當成完成
    },
    /* 分段鈕是後端資料到齊才由 JS 產生時（回測報表的策略清單），等它長出來再還原 */
    watchSeg(id, key) {
      if (this.restoreSeg(id, key)) return;
      if (!LS) return;
      const box = document.getElementById(id); if (!box) return;
      const t0 = Date.now();
      const tryIt = () => this.restoreSeg(id, key);
      if (w.MutationObserver) {
        const mo = new MutationObserver(() => { if (tryIt() || Date.now() - t0 > 30000) mo.disconnect(); });
        mo.observe(box, { childList: true });
      }
      let n = 0;
      const iv = setInterval(() => { if (tryIt() || ++n > 60) clearInterval(iv); }, 500);
    },

    bindInput(id, key) {
      const el = document.getElementById(id); if (!el || el.__prefBound) return;
      el.__prefBound = true;
      const save = () => this.set(key, el.value);
      el.addEventListener('input', save); el.addEventListener('change', save);
    },
    restoreInput(id, key, fire) {
      const v = this.get(key, null);
      if (v === null || v === undefined || v === '') return;
      const el = document.getElementById(id); if (!el) return;
      el.value = String(v);
      /* 這一頁是把輸入框的值讀進自己的 state，所以要補一次事件讓它同步 */
      if (fire && el.__prefBound) { try { el.dispatchEvent(new w.Event('input', { bubbles: true })); } catch (e) { } }
    },
    bindCheck(id, key) {
      const el = document.getElementById(id); if (!el || el.__prefBound) return;
      el.__prefBound = true;
      el.addEventListener('change', () => this.set(key, !!el.checked));
    },
    restoreCheck(id, key, fire) {
      const v = this.get(key, null); if (v === null || v === undefined) return;
      const el = document.getElementById(id); if (!el) return;
      el.checked = !!v;
      if (fire && el.__prefBound) { try { el.dispatchEvent(new w.Event('change', { bubbles: true })); } catch (e) { } }
    },

    /* ── 捲動位置 ──────────────────────────────────────────
       targets：捲動容器陣列（第 0 個是主視窗時傳 window；後面幾個各自加索引後綴）。
       還原期間先把該容器的寫入鎖住，否則內容還沒長出來時我們自己捲到 0
       會被當成「使用者捲到最上面」而把偏好值蓋掉。 */
    bindScroll(key, targets) {
      const list = (targets && targets.length) ? targets : [w];
      list.forEach((t, i) => {
        if (!t || t.__prefScroll) return;
        t.__prefScroll = true;
        const k = key + (i ? '.' + i : '');
        t.addEventListener('scroll', () => {
          if (t.__prefLock || t.__prefRaf) return;
          t.__prefRaf = requestAnimationFrame(() => {
            t.__prefRaf = 0;
            if (t.__prefLock) return;
            const v = (t === w) ? w.scrollY : t.scrollTop;
            this.set(k, Math.round(v));
          });
        }, { passive: true });
      });
    },
    restoreScroll(key, targets) {
      const list = (targets && targets.length) ? targets : [w];
      list.forEach((t, i) => {
        if (!t || t.__prefDone) return;
        const k = key + (i ? '.' + i : '');
        const want = this.get(k, null);
        if (!want || !isFinite(want) || want < 4) { t.__prefDone = true; return; }
        const t0 = Date.now();
        t.__prefLock = true;
        const put = v => { if (t === w) w.scrollTo(0, v); else t.scrollTop = v; };
        const cur = () => (t === w) ? w.scrollY : t.scrollTop;
        const apply = () => {
          const max = (t === w) ? Math.max(0, document.documentElement.scrollHeight - w.innerHeight)
                                : Math.max(0, t.scrollHeight - t.clientHeight);
          /* 只在「內容真的夠長」而且確實捲到了才收工；
             內容還沒長出來時先捲到能到的位置並繼續等，才不會把位置停在半路。 */
          if (max > 8) {
            const v = Math.min(want, max);
            put(v);
            if (max >= want - 2 && Math.abs(cur() - v) <= 3) { t.__prefLock = false; t.__prefDone = true; return; }
          }
          if (Date.now() - t0 < 9000) { setTimeout(apply, 350); return; }
          /* 內容長不到那麼高（例如清單變短）→ 停在目前位置並把偏好值更新成實際值 */
          t.__prefLock = false; t.__prefDone = true;
          this.set(k, Math.round(cur()));
        };
        apply();
      });
    },

    /* ── 每一頁要記住什麼 ───────────────────────────────────
       restore:false 的頁面（行情總覽）由 app.js 在第一次渲染前自己還原，
       這裡只做事件綁定，避免兩邊搶著還原而閃爍。 */
    auto() {
      const reg = REG[PAGE]; if (!reg) return;
      (reg.segs || []).forEach(x => this.bindSeg(x[0], x[1]));
      (reg.inputs || []).forEach(x => this.bindInput(x[0], x[1]));
      (reg.checks || []).forEach(x => this.bindCheck(x[0], x[1]));
      const scrolls = (reg.scroll || []).map(x => ({ key: x[0], els: pickAll(x[1]) }));
      scrolls.forEach(s => this.bindScroll(s.key, s.els));
      if (reg.restore === false) { setTimeout(() => scrolls.forEach(s => this.restoreScroll(s.key, s.els)), 0); return; }
      /* 等所有頁面的 DOMContentLoaded 處理器都跑完（事件已綁好）再還原 */
      setTimeout(() => {
        (reg.segs || []).forEach(x => this.watchSeg(x[0], x[1]));
        (reg.inputs || []).forEach(x => this.restoreInput(x[0], x[1], true));
        (reg.checks || []).forEach(x => this.restoreCheck(x[0], x[1], true));
        scrolls.forEach(s => this.restoreScroll(s.key, s.els));
      }, 0);
    }
  };

  const PAGE = (function () {
    const f = (w.location.pathname.split('/').pop() || '').toLowerCase();
    return f || 'index.html';
  })();

  const REG = {
    'index.html': {
      restore: false,     // app.js 在第一次 render 之前自己還原（不閃爍）
      segs: [['scanSort', 'scanSort']],
      inputs: [['scanSearch', 'scanQ']],
      checks: [['onlyFutures', 'scanOnlyFut']],
      /* 寬螢幕時捲的是中／右欄與掃描表，窄螢幕時整頁在主視窗捲動 */
      scroll: [['index.scroll', ['window', '.col-b', '.col-c', '.col-a .table-wrap']]]
    },
    'onchain.html': {
      segs: [['chainSeg', 'oc.chain'], ['chainMin', 'oc.min']],
      scroll: [['oc.scroll', ['.oc-page']]]
    },
    'signals.html': {
      segs: [['psSortSeg', 'sg.sort'], ['psOpenSeg', 'sg.openMin']],
      scroll: [['sg.scroll', ['.sg-page']]]
    },
    'report.html': {
      segs: [['rpDistSeg', 'rp.distWin'], ['rpDistMetric', 'rp.distMetric'], ['rpStrSeg', 'rp.strWin'],
             ['rpDetSeg', 'rp.detWin'], ['rpTkSeg', 'rp.tkKey'], ['rpTkWin', 'rp.tkWin']],
      inputs: [['rpQ', 'rp.q']],
      checks: [['rpRel', 'rp.rel']],
      scroll: [['rp.scroll', ['#rpRoot']]]
    }
  };

  /* 讓使用者自己清掉偏好（不會有任何誤觸按鈕）：
     console 執行 SENTINEL.resetUiPrefs() 就會清空 cs.ui.*，重新整理即回到預設。 */
  S.resetUiPrefs = () => Pref.reset();
  S.uiPrefs = () => Pref.keys();

  S.ready(() => {
    Pref.auto();
    try {
      const n = Object.keys(Pref.keys()).length;
      if (n) console.info('[CS] 已還原 ' + n + ' 筆介面偏好（localStorage 的 cs.ui.* 鍵）。'
        + '檢視：SENTINEL.uiPrefs()　清空：SENTINEL.resetUiPrefs()');
    } catch (e) { }
  });
})(window);
