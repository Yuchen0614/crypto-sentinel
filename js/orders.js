/* orders.js —「即時報單」頁引擎：全市場永續幣 × 15 策略 × 即時艙位與事件流
   ------------------------------------------------------------------
   口徑：每筆固定 $100 艙位（不加槓桿），1R＝$100 ×（1R 距離%），
        吃單 0.045%/邊（來回 0.09%）已扣在損益裡；名目／費率與 pages 上說明一致。
   判定：一律用「最新一根已收完的 K 線」，前一根以前當作沒看到；
        指標與訊號在前端算，規則移植自 scripts/trades.py 並加上 8 個新策略。
   出場：階梯式（TP1 觸及→止損移開倉價、TP2→移 TP1、TP3→移 TP2、TP4→直接出場），
        同一根 K 線同時觸及止損與目標一律先算止損；超過 MAX_HOLD 根沒出場記逾時。
   速率：請求間隔 ≥400ms、429 指數退避、K 線存 localStorage、失敗不清空畫面。
   ================================================================== */
'use strict';
(function (w) {
  const S = w.SENTINEL, U = S.util;
  const OD = S.orders = {};
  const HL = 'https://api.hyperliquid.xyz/info';
  const d = id => document.getElementById(id);
  const q1 = s => document.querySelector(s);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ══ 參數 ══════════════════════════════════════════ */
  const TF_MS = { '1m': 6e4, '5m': 3e5, '15m': 9e5, '1h': 36e5 };
  const TF_TXT = { '1m': '1 分', '5m': '5 分', '15m': '15 分', '1h': '1 小時' };
  /* K 線快取時效：刻意小於「一根 K 線」的長度，讓新收完的那根在 1～2 分鐘內被看到
     （宇宙上百檔、每次請求間隔 ≥0.4 秒，所以整輪補齊本身就要一分鐘上下） */
  const TTL = { '1m': 7e4, '5m': 15e4, '15m': 42e4, '1h': 9e5 };
  const BARS = 260;                 // 每次抓幾根（EMA200／MA200 需要 >200 根才夠暖身）
  const FRESH_BARS = 3;             // 觸發時間在這幾根內才算「剛出現」的艙位
  const MAX_HOLD = { '1m': 180, '5m': 120, '15m': 96, '1h': 60 };
  const NOTIONAL = 100;             // 每筆固定 $100 艙位
  const FEE_SIDE = 4.5e-4;          // 吃單 0.045%/邊
  const FEE_RT = NOTIONAL * FEE_SIDE * 2;
  const FUND_X = 1e-4;              // 資金費率極端門檻（0.01%/小時）
  const THROTTLE = 400;             // 公開 API 請求間隔下限（毫秒）
  const UNI_MIN = 3e6, UNI_ACTIVE = 2e7, UNI_MAJOR = 2e8, UNI_SMALL = 5e7;
  const POS_CAP = 300, EV_CAP = 160, CARD_CAP = 30;
  const LSK = { pos: 'cs.od.pos.v1', ev: 'cs.od.ev.v1', kl: 'cs.od.kl1.' };
  const MODES = {
    agg: { nm: '積極', mult: 1.0, tps: [0.5, 1, 1.5, 2.5] },
    std: { nm: '標準', mult: 1.5, tps: [1, 2, 3, 4] },
    wide: { nm: '寬鬆', mult: 2.0, tps: [1, 2, 3, 4] }
  };

  /* ══ 指標（不依賴任何套件；warmup 期一律 null，不硬湊）══ */
  function sma(a, n) {
    const o = new Array(a.length).fill(null); let s = 0;
    for (let i = 0; i < a.length; i++) {
      const v = a[i]; if (v === null || !isFinite(v)) { o[i] = null; continue; }
      s += v; if (i >= n) { const pv = a[i - n]; s -= (pv === null ? 0 : pv); }
      if (i >= n - 1) o[i] = s / n;
    }
    return o;
  }
  function ema(a, n) {
    const o = new Array(a.length).fill(null);
    if (a.length < n) return o;
    const k = 2 / (n + 1); let seed = 0;
    for (let i = 0; i < n; i++) seed += a[i];
    o[n - 1] = seed / n;
    for (let i = n; i < a.length; i++) o[i] = a[i] * k + o[i - 1] * (1 - k);
    return o;
  }
  function tr14(h, l, c) {
    const tr = new Array(c.length);
    for (let i = 0; i < c.length; i++) tr[i] = i ? Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])) : h[i] - l[i];
    return tr;
  }
  function atr14(h, l, c, n) {
    n = n || 14; const tr = tr14(h, l, c), o = new Array(c.length).fill(null);
    if (c.length < n + 1) return o;
    let s = 0; for (let i = 1; i <= n; i++) s += tr[i];
    o[n] = s / n;
    for (let i = n + 1; i < c.length; i++) o[i] = (o[i - 1] * (n - 1) + tr[i]) / n;
    return o;
  }
  function rsi14(c, n) {
    n = n || 14; const o = new Array(c.length).fill(null);
    if (c.length < n + 2) return o;
    let g = 0, l = 0;
    for (let i = 1; i <= n; i++) { const dd = c[i] - c[i - 1]; if (dd >= 0) g += dd; else l -= dd; }
    let ag = g / n, al = l / n;
    o[n] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    for (let i = n + 1; i < c.length; i++) {
      const dd = c[i] - c[i - 1], up = dd > 0 ? dd : 0, dn = dd < 0 ? -dd : 0;
      ag = (ag * (n - 1) + up) / n; al = (al * (n - 1) + dn) / n;
      o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
    return o;
  }
  /* MACD：(線, 訊號線, 柱狀體)；訊號線以「線的第一個有效值」開始跑 EMA */
  function macd(c, f, s, g) {
    const ef = ema(c, f), es = ema(c, s), line = new Array(c.length).fill(null);
    for (let i = 0; i < c.length; i++) if (ef[i] !== null && es[i] !== null) line[i] = ef[i] - es[i];
    const idx = []; for (let i = 0; i < c.length; i++) if (line[i] !== null) idx.push(i);
    const sg = new Array(c.length).fill(null), hi = new Array(c.length).fill(null);
    if (idx.length) {
      const part = ema(idx.map(i => line[i]), g);
      for (let j = 0; j < part.length; j++) if (part[j] !== null) sg[idx[j]] = part[j];
    }
    for (let i = 0; i < c.length; i++) if (line[i] !== null && sg[i] !== null) hi[i] = line[i] - sg[i];
    return [line, sg, hi];
  }
  /* 前 n 根的最高／最低（不含自己）：單調佇列 O(n) */
  function rollPrev(a, n, wantMax) {
    const o = new Array(a.length).fill(null), dq = [];
    for (let i = 0; i < a.length; i++) {
      if (dq.length && i >= n) o[i] = a[dq[0]];
      while (dq.length && (wantMax ? a[dq[dq.length - 1]] <= a[i] : a[dq[dq.length - 1]] >= a[i])) dq.pop();
      dq.push(i);
      while (dq.length && dq[0] <= i - n) dq.shift();
    }
    return o;
  }
  function bb(c, n, k) {
    const mid = sma(c, n), up = new Array(c.length).fill(null), dn = new Array(c.length).fill(null);
    let s = 0, s2 = 0;
    for (let i = 0; i < c.length; i++) {
      s += c[i]; s2 += c[i] * c[i];
      if (i >= n) { s -= c[i - n]; s2 -= c[i - n] * c[i - n]; }
      if (i >= n - 1 && mid[i] !== null) {
        const v = Math.max(0, s2 / n - mid[i] * mid[i]);
        up[i] = mid[i] + k * Math.sqrt(v); dn[i] = mid[i] - k * Math.sqrt(v);
      }
    }
    return [up, mid, dn];
  }
  /* 滾動 VWAP（n 根的量價加權均價，典型價 (h+l+c)/3） */
  function rollVwap(h, l, c, v, n) {
    const o = new Array(c.length).fill(null);
    let pv = 0, vv = 0;
    for (let i = 0; i < c.length; i++) {
      const tp = (h[i] + l[i] + c[i]) / 3;
      pv += tp * v[i]; vv += v[i];
      if (i >= n) { const j = i - n, tpj = (h[j] + l[j] + c[j]) / 3; pv -= tpj * v[j]; vv -= v[j]; }
      if (i >= n - 1 && vv > 0) o[i] = pv / vv;
    }
    return o;
  }
  /* 擺動高低點：第 i 根嚴格高於（低於）左右各 k 根 */
  function swings(h, l, k) {
    const hi = [], lo = [];
    for (let i = k; i < h.length - k; i++) {
      let ok = true;
      for (let j = 1; j <= k; j++) if (!(h[i] > h[i - j] && h[i] > h[i + j])) { ok = false; break; }
      if (ok) hi.push(i);
      ok = true;
      for (let j = 1; j <= k; j++) if (!(l[i] < l[i - j] && l[i] < l[i + j])) { ok = false; break; }
      if (ok) lo.push(i);
    }
    return [hi, lo];
  }
  function pxTxt(x) {
    if (x === null || x === undefined || !isFinite(x)) return '—';
    const a = Math.abs(x);
    const dec = a > 0 ? Math.max(0, Math.min(10, 4 - Math.floor(Math.log10(a)))) : 0;
    return x.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }
  function sig(x, n) {                       // 有效位數（避免 localStorage 塞滿長尾小數）
    n = n || 10; if (!isFinite(x) || x === 0) return x;
    const p = n - 1 - Math.floor(Math.log10(Math.abs(x)));
    return (p > -12 && p < 30) ? +x.toFixed(p) : x;
  }

  /* ══ 15 個策略（全部雙向；f＝觸發、b＝目前偏向）═══════════ */
  function crossUp(a, b, i) { return a[i] !== null && b[i] !== null && a[i - 1] !== null && b[i - 1] !== null && a[i - 1] <= b[i - 1] && a[i] > b[i]; }
  function crossDn(a, b, i) { return a[i] !== null && b[i] !== null && a[i - 1] !== null && b[i - 1] !== null && a[i - 1] >= b[i - 1] && a[i] < b[i]; }

  const STRATS = [
    {
      k: 'brk', nm: '突破 20 根高低', s: '突破',
      f: (x, i) => {
        if (x.h20[i] === null || x.h20[i - 1] === null) return null;
        if (x.c[i] > x.h20[i] && x.c[i - 1] <= x.h20[i - 1]) return { side: 'long', note: '收盤 ' + pxTxt(x.c[i]) + ' 創 20 根新高 ' + pxTxt(x.h20[i]) };
        if (x.c[i] < x.l20[i] && x.c[i - 1] >= x.l20[i - 1]) return { side: 'short', note: '收盤 ' + pxTxt(x.c[i]) + ' 創 20 根新低 ' + pxTxt(x.l20[i]) };
        return null;
      },
      b: (x, i) => x.h20[i] === null ? '' : (x.c[i] > x.h20[i] ? 'long' : (x.c[i] < x.l20[i] ? 'short' : ''))
    },
    {
      k: 'ma2060', nm: '均線動能 MA20／MA60', s: '均線',
      f: (x, i) => crossUp(x.ma20, x.ma60, i) ? { side: 'long', note: 'MA20 ' + pxTxt(x.ma20[i]) + ' 上穿 MA60 ' + pxTxt(x.ma60[i]) }
        : (crossDn(x.ma20, x.ma60, i) ? { side: 'short', note: 'MA20 ' + pxTxt(x.ma20[i]) + ' 下穿 MA60 ' + pxTxt(x.ma60[i]) } : null),
      b: (x, i) => (x.ma20[i] === null || x.ma60[i] === null) ? '' : (x.ma20[i] > x.ma60[i] ? 'long' : 'short')
    },
    {
      k: 'rsi_pb', nm: 'RSI14 回檔買入', s: 'RSI回檔',
      f: (x, i) => {
        const r = x.rsi[i], m = x.ma60[i]; if (r === null || m === null) return null;
        if (x.c[i] > m && r < 35) return { side: 'long', note: '上升趨勢（收盤 ' + pxTxt(x.c[i]) + ' > MA60 ' + pxTxt(m) + '）RSI14 ' + r.toFixed(1) + ' < 35' };
        if (x.c[i] < m && r > 65) return { side: 'short', note: '下降趨勢（收盤 ' + pxTxt(x.c[i]) + ' < MA60 ' + pxTxt(m) + '）RSI14 ' + r.toFixed(1) + ' > 65' };
        return null;
      },
      b: (x, i) => {
        const r = x.rsi[i], m = x.ma60[i]; if (r === null || m === null) return '';
        if (x.c[i] > m && r < 40) return 'long'; if (x.c[i] < m && r > 60) return 'short'; return '';
      }
    },
    {
      k: 'macd_hist', nm: 'MACD 柱狀體翻正／翻負', s: '柱狀',
      f: (x, i) => {
        const h = x.hi[i], p = x.hi[i - 1]; if (h === null || p === null) return null;
        if (h > 0 && p <= 0) return { side: 'long', note: '柱狀體由負轉正 ' + pxTxt(p) + ' → ' + pxTxt(h) };
        if (h < 0 && p >= 0) return { side: 'short', note: '柱狀體由正轉負 ' + pxTxt(p) + ' → ' + pxTxt(h) };
        return null;
      },
      b: (x, i) => x.hi[i] === null ? '' : (x.hi[i] > 0 ? 'long' : 'short')
    },
    {
      k: 'macd_zero', nm: 'MACD 零軸突破＋量能', s: '零軸',
      f: (x, i) => {
        const g = x.sg2[i], p = x.sg2[i - 1], r = x.rsi[i], vs = x.vsma[i];
        if (g === null || p === null || r === null || vs === null || !(x.v[i] > 1.5 * vs)) return null;
        if (g > 0 && p <= 0 && r > 50) return { side: 'long', note: '訊號線 ' + pxTxt(g) + ' 上穿零軸 · 量 ' + pxTxt(x.v[i]) + ' > 均量 ' + pxTxt(vs) + '×1.5 · RSI ' + r.toFixed(1) };
        if (g < 0 && p >= 0 && r < 50) return { side: 'short', note: '訊號線 ' + pxTxt(g) + ' 下穿零軸 · 量 ' + pxTxt(x.v[i]) + ' > 均量 ' + pxTxt(vs) + '×1.5 · RSI ' + r.toFixed(1) };
        return null;
      },
      b: (x, i) => {
        const g = x.sg2[i], r = x.rsi[i]; if (g === null || r === null) return '';
        return (g > 0 && r > 50) ? 'long' : ((g < 0 && r < 50) ? 'short' : '');
      }
    },
    {
      k: 'macd_ema200', nm: 'MACD 訊號線交叉＋EMA200', s: '訊號線',
      f: (x, i) => {
        if (x.e200[i] === null) return null;
        if (crossUp(x.ln, x.sg, i) && x.c[i] > x.e200[i]) return { side: 'long', note: 'MACD ' + pxTxt(x.ln[i]) + ' 上穿訊號線 ' + pxTxt(x.sg[i]) + ' · 收盤 ' + pxTxt(x.c[i]) + ' > EMA200 ' + pxTxt(x.e200[i]) };
        if (crossDn(x.ln, x.sg, i) && x.c[i] < x.e200[i]) return { side: 'short', note: 'MACD ' + pxTxt(x.ln[i]) + ' 下穿訊號線 ' + pxTxt(x.sg[i]) + ' · 收盤 ' + pxTxt(x.c[i]) + ' < EMA200 ' + pxTxt(x.e200[i]) };
        return null;
      },
      b: (x, i) => {
        if (x.e200[i] === null || x.sg[i] === null) return '';
        if (x.ln[i] > x.sg[i] && x.c[i] > x.e200[i]) return 'long';
        if (x.ln[i] < x.sg[i] && x.c[i] < x.e200[i]) return 'short'; return '';
      }
    },
    {
      k: 'macd_div', nm: 'MACD 背離（擺動點＋突破確認）', s: '背離',
      f: (x, i) => divFire(x, i, 'macd'),
      b: (x, i) => divBias(x, i, 'macd')
    },
    {
      k: 'boll', nm: '布林通道突破（20, 2σ）', s: '布林',
      f: (x, i) => {
        if (x.bbu[i] === null || x.bbu[i - 1] === null) return null;
        if (x.c[i] > x.bbu[i] && x.c[i - 1] <= x.bbu[i - 1]) return { side: 'long', note: '收盤 ' + pxTxt(x.c[i]) + ' 突破布林上軌 ' + pxTxt(x.bbu[i]) + '（中軌 ' + pxTxt(x.bbm[i]) + '）' };
        if (x.c[i] < x.bbd[i] && x.c[i - 1] >= x.bbd[i - 1]) return { side: 'short', note: '收盤 ' + pxTxt(x.c[i]) + ' 跌破布林下軌 ' + pxTxt(x.bbd[i]) + '（中軌 ' + pxTxt(x.bbm[i]) + '）' };
        return null;
      },
      b: (x, i) => x.bbu[i] === null ? '' : (x.c[i] > x.bbu[i] ? 'long' : (x.c[i] < x.bbd[i] ? 'short' : ''))
    },
    {
      k: 'donchian', nm: 'Donchian 10／55', s: '唐奇安',
      f: (x, i) => {
        if (x.h10[i] === null || x.h55[i] === null) return null;
        const mid = (x.h55[i] + x.l55[i]) / 2, up = x.c[i] > mid;
        if (x.c[i] > x.h10[i] && x.c[i - 1] <= x.h10[i - 1] && up) return { side: 'long', note: '收盤 ' + pxTxt(x.c[i]) + ' 突破前 10 根高 ' + pxTxt(x.h10[i]) + '（55 根中線 ' + pxTxt(mid) + ' 之下方向上）' };
        if (x.c[i] < x.l10[i] && x.c[i - 1] >= x.l10[i - 1] && !up) return { side: 'short', note: '收盤 ' + pxTxt(x.c[i]) + ' 跌破前 10 根低 ' + pxTxt(x.l10[i]) + '（55 根中線 ' + pxTxt(mid) + ' 之上方向下）' };
        return null;
      },
      b: (x, i) => {
        if (x.h10[i] === null || x.h55[i] === null) return '';
        const mid = (x.h55[i] + x.l55[i]) / 2;
        if (x.c[i] > x.h10[i] && x.c[i] > mid) return 'long';
        if (x.c[i] < x.l10[i] && x.c[i] < mid) return 'short'; return '';
      }
    },
    {
      k: 'ema821', nm: 'EMA 8／21 交叉', s: 'EMA8/21',
      f: (x, i) => crossUp(x.e8, x.e21, i) ? { side: 'long', note: 'EMA8 ' + pxTxt(x.e8[i]) + ' 上穿 EMA21 ' + pxTxt(x.e21[i]) }
        : (crossDn(x.e8, x.e21, i) ? { side: 'short', note: 'EMA8 ' + pxTxt(x.e8[i]) + ' 下穿 EMA21 ' + pxTxt(x.e21[i]) } : null),
      b: (x, i) => (x.e8[i] === null || x.e21[i] === null) ? '' : (x.e8[i] > x.e21[i] ? 'long' : 'short')
    },
    {
      k: 'vwap', nm: 'VWAP 回歸（偏離 1.5×ATR）', s: 'VWAP',
      f: (x, i) => {
        const v = x.vw[i], a = x.atr[i]; if (v === null || a === null || !(a > 0)) return null;
        const dev = (x.c[i] - v) / a, pdev = (i > 0 && x.vw[i - 1] !== null) ? (x.c[i - 1] - x.vw[i - 1]) / a : 0;
        if (dev <= -1.5 && pdev > -1.5) return { side: 'long', note: '收盤 ' + pxTxt(x.c[i]) + ' 低於 20 根 VWAP ' + pxTxt(v) + ' 達 ' + Math.abs(dev).toFixed(2) + '×ATR → 做多等回歸' };
        if (dev >= 1.5 && pdev < 1.5) return { side: 'short', note: '收盤 ' + pxTxt(x.c[i]) + ' 高於 20 根 VWAP ' + pxTxt(v) + ' 達 ' + dev.toFixed(2) + '×ATR → 做空等回歸' };
        return null;
      },
      b: (x, i) => {
        const v = x.vw[i], a = x.atr[i]; if (v === null || a === null || !(a > 0)) return '';
        const dev = (x.c[i] - v) / a;
        return dev <= -1.5 ? 'long' : (dev >= 1.5 ? 'short' : '');
      }
    },
    {
      k: 'atr_ch', nm: 'ATR 通道突破（1.5×ATR）', s: 'ATR通道',
      f: (x, i) => {
        const a = x.atr[i]; if (a === null || !(a > 0) || i < 1) return null;
        const chg = x.c[i] - x.c[i - 1];
        if (chg >= 1.5 * a) return { side: 'long', note: '單根收盤 ' + pxTxt(x.c[i]) + ' 較前一根 ' + pxTxt(x.c[i - 1]) + ' 上漲 ' + (chg / a).toFixed(2) + '×ATR' };
        if (chg <= -1.5 * a) return { side: 'short', note: '單根收盤 ' + pxTxt(x.c[i]) + ' 較前一根 ' + pxTxt(x.c[i - 1]) + ' 下跌 ' + Math.abs(chg / a).toFixed(2) + '×ATR' };
        return null;
      },
      b: (x, i) => {
        const a = x.atr[i]; if (a === null || !(a > 0) || i < 1) return '';
        const dev = (x.c[i] - x.c[i - 1]) / a;
        return dev >= 1 ? 'long' : (dev <= -1 ? 'short' : '');
      }
    },
    {
      k: 'vol_brk', nm: '量價突破（量 > 2×均量）', s: '量價',
      f: (x, i) => {
        const vs = x.vsma[i]; if (vs === null || x.h20[i] === null || !(x.v[i] > 2 * vs)) return null;
        if (x.c[i] > x.h20[i] && x.c[i - 1] <= x.h20[i - 1]) return { side: 'long', note: '量 ' + pxTxt(x.v[i]) + ' > 20 根均量 ' + pxTxt(vs) + '×2 · 收盤 ' + pxTxt(x.c[i]) + ' 創 20 根新高 ' + pxTxt(x.h20[i]) };
        if (x.c[i] < x.l20[i] && x.c[i - 1] >= x.l20[i - 1]) return { side: 'short', note: '量 ' + pxTxt(x.v[i]) + ' > 20 根均量 ' + pxTxt(vs) + '×2 · 收盤 ' + pxTxt(x.c[i]) + ' 創 20 根新低 ' + pxTxt(x.l20[i]) };
        return null;
      },
      b: (x, i) => {
        const vs = x.vsma[i]; if (vs === null || !(x.v[i] > 2 * vs)) return '';
        if (x.h20[i] !== null && x.c[i] > x.h20[i]) return 'long';
        if (x.l20[i] !== null && x.c[i] < x.l20[i]) return 'short'; return '';
      }
    },
    {
      k: 'rsi_div', nm: 'RSI 背離（擺動點＋突破確認）', s: 'RSI背離',
      f: (x, i) => divFire(x, i, 'rsi'),
      b: (x, i) => divBias(x, i, 'rsi')
    },
    { k: 'funding_rev', nm: '資金費率極端反轉', s: '資金費反轉', f: () => null, b: fundingBias, q: true }
  ];
  const SMAP = {}; STRATS.forEach(s => SMAP[s.k] = s);

  /* 背離：擺動點左右各 3 根，價格創更低低點／更高高點但指標反向 → 等收盤突破前一個擺動高／低才成立 */
  function divScan(x, src) {
    const [sh, sl] = swings(x.h, x.l, 3);
    const hp = {}, lp = {}; sh.forEach((j, p) => hp[j] = p); sl.forEach((j, p) => lp[j] = p);
    const srcArr = src === 'rsi' ? x.rsi : x.ln;
    const out = {}, biasArr = new Array(x.n).fill('');
    let arm = null;
    for (let i = 5; i < x.n; i++) {
      if (arm && i > arm.exp) arm = null;
      const j2 = i - 3;                               // 這一根才確認的擺動點
      if (!arm) {
        if (lp[j2] !== undefined && lp[j2] > 0) {
          const j1 = sl[lp[j2] - 1];
          if (x.l[j2] < x.l[j1] && srcArr[j2] !== null && srcArr[j1] !== null && srcArr[j2] > srcArr[j1]) {
            const prev = sh.filter(v => v < j2);
            if (prev.length) arm = { side: 'long', tgt: prev[prev.length - 1], exp: i + 30, note: '看多背離：低點 ' + pxTxt(x.l[j2]) + '<' + pxTxt(x.l[j1]) + '、' + (src === 'rsi' ? 'RSI' : 'MACD') + ' 低點 ' + pxTxt(srcArr[j2]) + '>' + pxTxt(srcArr[j1]) };
          }
        } else if (hp[j2] !== undefined && hp[j2] > 0) {
          const j1 = sh[hp[j2] - 1];
          if (x.h[j2] > x.h[j1] && srcArr[j2] !== null && srcArr[j1] !== null && srcArr[j2] < srcArr[j1]) {
            const prev = sl.filter(v => v < j2);
            if (prev.length) arm = { side: 'short', tgt: prev[prev.length - 1], exp: i + 30, note: '看空背離：高點 ' + pxTxt(x.h[j2]) + '>' + pxTxt(x.h[j1]) + '、' + (src === 'rsi' ? 'RSI' : 'MACD') + ' 高點 ' + pxTxt(srcArr[j2]) + '<' + pxTxt(srcArr[j1]) };
          }
        }
      }
      if (arm) {
        biasArr[i] = arm.side;
        if (arm.side === 'long' && x.c[i] > x.h[arm.tgt]) {
          out[i] = { side: 'long', note: arm.note + ' · 收盤 ' + pxTxt(x.c[i]) + ' 突破前一個擺動高 ' + pxTxt(x.h[arm.tgt]) };
          arm = null;
        } else if (arm.side === 'short' && x.c[i] < x.l[arm.tgt]) {
          out[i] = { side: 'short', note: arm.note + ' · 收盤 ' + pxTxt(x.c[i]) + ' 跌破前一個擺動低 ' + pxTxt(x.l[arm.tgt]) };
          arm = null;
        }
      }
    }
    return { fire: out, bias: biasArr };
  }
  function divFire(x, i, src) { if (!x[srckey(src)]) x[srckey(src)] = divScan(x, src); return x[srckey(src)].fire[i] || null; }
  function divBias(x, i, src) { if (!x[srckey(src)]) x[srckey(src)] = divScan(x, src); return x[srckey(src)].bias[i] || ''; }
  function srckey(src) { return src === 'rsi' ? '_dv_rsi' : '_dv_macd'; }
  function fundingBias(x, i) {
    const f = x.funding; if (f === null || f === undefined || !isFinite(f)) return '';
    return f >= FUND_X ? 'short' : (f <= -FUND_X ? 'long' : '');
  }

  /* ══ 單一幣種的指標包（每輪重算一次）═════════════════════ */
  function mkctx(bars, funding) {
    const n = bars.length;
    const x = { n, funding };
    x.t = new Array(n); x.o = new Array(n); x.h = new Array(n); x.l = new Array(n); x.c = new Array(n); x.v = new Array(n);
    for (let i = 0; i < n; i++) { const b = bars[i]; x.t[i] = b[0]; x.o[i] = b[1]; x.h[i] = b[2]; x.l[i] = b[3]; x.c[i] = b[4]; x.v[i] = b[5]; }
    x.atr = atr14(x.h, x.l, x.c, 14);
    x.rsi = rsi14(x.c, 14);
    x.ma20 = sma(x.c, 20); x.ma60 = sma(x.c, 60); x.ma200 = sma(x.c, 200);
    x.e8 = ema(x.c, 8); x.e21 = ema(x.c, 21); x.e200 = ema(x.c, 200);
    const m1 = macd(x.c, 12, 26, 9); x.ln = m1[0]; x.sg = m1[1]; x.hi = m1[2];
    const m2 = macd(x.c, 12, 17, 9); x.ln2 = m2[0]; x.sg2 = m2[1]; x.hi2 = m2[2];
    x.vsma = sma(x.v, 20);
    const b1 = bb(x.c, 20, 2); x.bbu = b1[0]; x.bbm = b1[1]; x.bbd = b1[2];
    x.h20 = rollPrev(x.h, 20, true); x.l20 = rollPrev(x.l, 20, false);
    x.h10 = rollPrev(x.h, 10, true); x.l10 = rollPrev(x.l, 10, false);
    x.h55 = rollPrev(x.h, 55, true); x.l55 = rollPrev(x.l, 55, false);
    x.vw = rollVwap(x.h, x.l, x.c, x.v, 20);
    return x;
  }

  OD.STRATS = STRATS; OD.MODES = MODES; OD.mkctx = mkctx;

  /* ══ 狀態 ══════════════════════════════════════════ */
  const ST = {
    tf: '5m', mode: 'std', side: 'both', uni: 'all', qtx: '', openOnly: false,
    stratOn: {}, uniList: [], quotes: {}, ctxs: {}, pos: [], ev: [],
    seen: {}, armFund: {}, prog: { done: 0, total: 0 },
    lastMeta: 0, lastSweep: 0, busy: false, scroll: false,
    posSort: { k: 'ts', d: true }, scanSort: { k: 'vol', d: true }, expand: {}, sel: null
  };
  STRATS.forEach(s => ST.stratOn[s.k] = true);
  OD.ST = ST;
  OD.net = { req: 0, fail: 0, backoff: 0, klOff: false };
  const STRATNM = {}; STRATS.forEach(s => STRATNM[s.k] = s.nm);

  /* ══ localStorage（艙位／事件／K 線快取）══════════════ */
  function lsGet(k, def) { try { const v = JSON.parse(localStorage.getItem(k)); return (v === null || v === undefined) ? def : v; } catch (e) { return def; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function loadStore() {
    const p = lsGet(LSK.pos, []);
    if (Array.isArray(p)) ST.pos = p.filter(x => x && x.coin && isFinite(x.entryPx) && isFinite(x.rAbs) && x.rAbs > 0);
    const e = lsGet(LSK.ev, []);
    if (Array.isArray(e)) ST.ev = e.filter(x => x && x.coin && x.kind);
    ST.pos.forEach(x => { if (x.new === undefined) x.new = false; });
  }
  function savePos() { lsSet(LSK.pos, ST.pos.slice(0, POS_CAP)); }
  function saveEv() { lsSet(LSK.ev, ST.ev.slice(0, EV_CAP)); }
  function klKey(coin, tf) { return LSK.kl + tf + '.' + coin; }
  function loadKL(coin, tf) {
    try {
      const o = JSON.parse(localStorage.getItem(klKey(coin, tf)));
      if (!o || !Array.isArray(o.b) || o.b.length < 60) return null;
      if (!o.t || Date.now() - o.t > TTL[tf] * 4) return null;      // 放太久當作沒有
      return o;
    } catch (e) { return null; }
  }
  function saveKL(coin, tf, bars) {
    if (OD.net.klOff) return;
    const key = klKey(coin, tf), val = JSON.stringify({ t: Date.now(), b: bars });
    try { localStorage.setItem(key, val); }
    catch (e) {
      // 配額滿了：清掉其他時間框的快取再試一次，還不行就整輪關掉快取（功能不受影響，只是每次重抓）
      try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k && k.indexOf(LSK.kl) === 0 && k.indexOf(LSK.kl + tf + '.') !== 0) localStorage.removeItem(k);
        }
        localStorage.setItem(key, val);
      } catch (e2) { OD.net.klOff = true; }
    }
  }

  /* ══ 公開 API：單一出口、序列化、≥400ms 間隔、429 指數退避 ══ */
  let gateT = 0, gateChain = Promise.resolve();
  async function hl(body, timeout) {
    const prev = gateChain; let rel;
    gateChain = new Promise(r => rel = r);
    await prev;
    const wait = gateT + THROTTLE + OD.net.backoff - Date.now();
    if (wait > 0) await sleep(wait);
    gateT = Date.now();
    OD.net.req++;
    const ac = new AbortController(), to = setTimeout(() => ac.abort(), timeout || 15000);
    try {
      const r = await fetch(HL, {
        method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (r.status === 429 || r.status >= 500) {
        OD.net.fail++;
        OD.net.backoff = Math.min(8000, OD.net.backoff ? OD.net.backoff * 2 : 800);
        return null;
      }
      if (!r.ok) { OD.net.fail++; return null; }
      const j = await r.json();
      OD.net.backoff = Math.max(0, OD.net.backoff - 250);
      return j;
    } catch (e) {
      OD.net.fail++;
      OD.net.backoff = Math.min(8000, OD.net.backoff ? OD.net.backoff * 2 : 400);
      return null;
    } finally { clearTimeout(to); rel(); }
  }

  /* ══ 幣種宇宙與即時報價（metaAndAssetCtxs）════════════ */
  async function pollMeta() {
    const j = await hl({ type: 'metaAndAssetCtxs' }, 15000);
    if (!Array.isArray(j) || j.length < 2 || !Array.isArray(j[0] && j[0].universe) || !Array.isArray(j[1])) return false;
    const uni = j[0].universe, ctx = j[1], Q = {};
    for (let i = 0; i < uni.length; i++) {
      const u = uni[i], c = ctx[i] || {};
      if (!u || !u.name) continue;
      const px = U.num(c.markPx) || U.num(c.midPx);
      if (!isFinite(px) || px <= 0) continue;
      const prev = U.num(c.prevDayPx), vol = U.num(c.dayNtlVlm);
      Q[u.name] = {
        coin: u.name, px: px, prev: prev,
        vol: isFinite(vol) ? vol : 0,
        chg: (isFinite(prev) && prev > 0) ? (px / prev - 1) * 100 : NaN,
        funding: U.num(c.funding), oi: U.num(c.openInterest),
        szd: u.szDecimals === undefined ? 2 : u.szDecimals, lev: u.maxLeverage
      };
    }
    if (!Object.keys(Q).length) return false;
    ST.quotes = Q; ST.lastMeta = Date.now();
    buildUni();
    checkFunding();
    return true;
  }
  function buildUni() {
    const all = []; for (const k in ST.quotes) all.push(ST.quotes[k]);
    let list = all.filter(q => q.vol >= UNI_MIN);
    if (ST.uni === 'active') list = list.filter(q => q.vol >= UNI_ACTIVE);
    else if (ST.uni === 'major') list = list.filter(q => q.vol >= UNI_MAJOR);
    else if (ST.uni === 'small') list = list.filter(q => q.vol >= UNI_MIN && q.vol <= UNI_SMALL).sort((a, b) => a.vol - b.vol);
    if (ST.uni !== 'small') list.sort((a, b) => b.vol - a.vol);
    ST.uniList = list;
    ST.prog.total = list.length;
    ST.prog.done = list.reduce((n, q) => n + (freshCtx(q.coin) ? 1 : 0), 0);
  }
  function freshCtx(coin) {
    const c = ST.ctxs[coin];
    return !!(c && c.tf === ST.tf && c.x && Date.now() - c.at < TTL[ST.tf]);
  }

  /* ══ K 線輪詢佇列：一次一檔、慢慢把宇宙補齊 ═══════════ */
  const KLQ = { list: [], i: 0, run: false };
  function rebuildQueue() {
    // 有開艙位的幣先補（畫面上的未實現損益要靠它），其餘照成交額排序
    const has = {}; ST.pos.forEach(p => { if (p.exitTs === null) has[p.coin] = 1; });
    const stale = ST.uniList.filter(q => !freshCtx(q.coin));
    stale.sort((a, b) => (has[b.coin] ? 1 : 0) - (has[a.coin] ? 1 : 0));
    KLQ.list = stale.map(q => q.coin);
    KLQ.i = 0;
  }
  async function pump() {
    if (KLQ.run) return;
    KLQ.run = true;
    try {
      while (KLQ.i < KLQ.list.length) {
        const coin = KLQ.list[KLQ.i++];
        if (!ST.quotes[coin]) continue;
        await fetchKL(coin);
        if (document.hidden) await sleep(700);        // 分頁在背景：降頻但不停更
        if (KLQ.i % 5 === 0) { renderSoft(); }
      }
      ST.lastSweep = Date.now();
      renderSoft();
    } finally { KLQ.run = false; }
  }
  async function fetchKL(coin) {
    const tf = ST.tf, ms = TF_MS[tf], now = Date.now();
    const cached = loadKL(coin, tf);
    if (cached && now - cached.t <= TTL[tf]) { applyCandles(coin, cached.b, tf, cached.t); return; }
    const j = await hl({ type: 'candleSnapshot', req: { coin: coin, interval: tf, startTime: Math.floor(now - BARS * ms), endTime: now } }, 15000);
    let bars = null;
    if (Array.isArray(j) && j.length) {
      bars = [];
      for (let k = 0; k < j.length; k++) {
        const r = j[k];
        if (!r) continue;
        const t = U.num(r.t), o = U.num(r.o), h = U.num(r.h), l = U.num(r.l), c = U.num(r.c), v = U.num(r.v);
        if (!isFinite(t) || !isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) continue;
        bars.push([t, sig(o, 10), sig(h, 10), sig(l, 10), sig(c, 10), sig(isFinite(v) ? v : 0, 8)]);
      }
      bars.sort((a, b) => a[0] - b[0]);
    }
    if (bars && bars.length >= 60) { saveKL(coin, tf, bars); applyCandles(coin, bars, tf, Date.now()); }
    else if (cached) applyCandles(coin, cached.b, tf, cached.t);   // 抓失敗就沿用舊 K 線，不清空畫面
  }
  function applyCandles(coin, bars, tf, at) {
    if (tf !== ST.tf) return;
    const now = Date.now(), ms = TF_MS[tf], n = bars.length;
    let cut = n;
    if (n && bars[n - 1][0] + ms > now + 500) cut = n - 1;         // 最後一根還沒收完 → 一律不用
    const b = cut === n ? bars : bars.slice(0, cut);
    if (b.length < 60) { ST.ctxs[coin] = { tf: tf, at: at, x: null }; return; }
    const x = mkctx(b, ST.quotes[coin] ? ST.quotes[coin].funding : null);
    ST.ctxs[coin] = { tf: tf, at: at, x: x };
    scanCoin(coin, x);
  }

  /* ══ 掃描：新訊號開艙位、既有艙位推進 ════════════════ */
  function openFor(coin, strat) { return ST.pos.some(p => p.coin === coin && p.strat === strat && p.exitTs === null); }
  function scanCoin(coin, x) {
    const ms = TF_MS[ST.tf], i = x.n - 1, now = Date.now(), floorT = now - (FRESH_BARS + 1) * ms;
    const q = ST.quotes[coin];
    for (let s = 0; s < STRATS.length; s++) {
      const S1 = STRATS[s];
      if (!ST.stratOn[S1.k] || S1.q) continue;                      // S1.q＝吃報價（資金費率），另一條路處理
      for (let j = i; j > i - FRESH_BARS && j >= 2; j--) {
        const barClose = x.t[j] + ms;
        if (barClose < floorT) break;
        const g = S1.f(x, j);
        if (!g) continue;
        if (ST.side !== 'both' && ST.side !== g.side) continue;
        const key = ST.tf + '|' + coin + '|' + S1.k + '|' + g.side + '|' + barClose;
        if (ST.seen[key]) continue;
        if (openFor(coin, S1.k)) { ST.seen[key] = 1; continue; }
        const atr = x.atr[j];
        if (!(atr > 0) || !(x.c[j] > 0)) { ST.seen[key] = 1; continue; }
        ST.seen[key] = 1;
        openPos({
          coin: coin, strat: S1.k, side: g.side, tf: ST.tf, entryTs: barClose,
          entryPx: (q && q.px > 0) ? q.px : x.c[j], barPx: x.c[j], atr: atr, note: g.note,
          ind: { atr: atr, rsi: x.rsi[j], macd: x.ln[j], hist: x.hi[j], ma20: x.ma20[j], ma60: x.ma60[j], vwap: x.vw[j], vol: x.v[j], vsma: x.vsma[j] }
        });
      }
    }
    for (let k = 0; k < ST.pos.length; k++) {
      const p = ST.pos[k];
      if (p.coin === coin && p.exitTs === null) advance(p, x);
    }
  }
  function openPos(o) {
    const m = MODES[ST.mode], dir = o.side === 'long' ? 1 : -1;
    const sl0 = o.entryPx - dir * m.mult * o.atr, rAbs = Math.abs(o.entryPx - sl0);
    if (!(rAbs > 0) || !(o.entryPx > 0)) return;
    const p = {
      id: o.coin + '|' + o.strat + '|' + o.entryTs + '|' + o.side,
      coin: o.coin, strat: o.strat, side: o.side, tf: o.tf, mode: ST.mode,
      entryTs: o.entryTs, entryPx: o.entryPx, barPx: o.barPx, atr: o.atr,
      rAbs: rAbs, rPct: rAbs / o.entryPx, mMult: m.mult, mTps: m.tps.slice(),
      sl0: sl0, sl: sl0, slR: 'sl', tps: m.tps.map(k => o.entryPx + dir * k * rAbs),
      maxTp: 0, exitTs: null, exitPx: null, why: null, lastT: o.entryTs - 1, bars: 0,
      mfe: 0, mae: 0, cur: o.entryPx, rNow: 0, usd: -FEE_RT, note: o.note, ind: o.ind, new: true
    };
    ST.pos.unshift(p);
    if (ST.pos.length > POS_CAP) ST.pos.length = POS_CAP;
    pushEv({
      kind: 'open', ts: o.entryTs, det: Date.now(), coin: o.coin, strat: o.strat, side: o.side,
      px: o.entryPx, sl: sl0, tp1: p.tps[0], rPct: p.rPct
    });
    savePos();
    if (OD.onOpen) OD.onOpen(p);
  }
  function closePos(p, ts, px, why) {
    const dir = p.side === 'long' ? 1 : -1;
    p.exitTs = ts; p.exitPx = px; p.why = why; p.new = false;
    p.rNow = dir * (px - p.entryPx) / p.rAbs;
    p.usd = NOTIONAL * p.rNow * p.rAbs / p.entryPx - FEE_RT;
    pushEv({
      kind: 'close', ts: ts, det: Date.now(), coin: p.coin, strat: p.strat, side: p.side,
      px: px, why: why, r: p.rNow, usd: p.usd, maxTp: p.maxTp
    });
    savePos();
  }
  function advance(p, x) {
    const ms = TF_MS[p.tf];
    if (p.tf !== ST.tf) return;                                   // 別的時間框的艙位只跟現價
    const dir = p.side === 'long' ? 1 : -1;
    let i0 = x.n;
    for (let i = 0; i < x.n; i++) if (x.t[i] > p.lastT) { i0 = i; break; }
    for (let i = i0; i < x.n; i++) {
      const hi = x.h[i], lo = x.l[i];
      p.bars++;
      const fav = dir > 0 ? (hi - p.entryPx) / p.rAbs : (p.entryPx - lo) / p.rAbs;
      const adv = dir > 0 ? (lo - p.entryPx) / p.rAbs : (p.entryPx - hi) / p.rAbs;
      if (fav > p.mfe) p.mfe = fav;
      if (adv < p.mae) p.mae = adv;
      if (dir > 0 ? lo <= p.sl : hi >= p.sl) {                    // 同一根先算止損
        closePos(p, x.t[i] + ms, p.sl, p.slR);
        break;
      }
      let k = 0;
      for (let m = 4; m >= 1; m--) if (dir > 0 ? hi >= p.tps[m - 1] : lo <= p.tps[m - 1]) { k = m; break; }
      if (k > p.maxTp) {
        p.maxTp = k;
        if (k >= 4) { closePos(p, x.t[i] + ms, p.tps[3], 'tp4'); break; }
        p.sl = k === 1 ? p.entryPx : p.tps[k - 2];
        p.slR = k === 1 ? 'be' : 'tp' + (k - 1);
      }
      p.lastT = x.t[i];
    }
    if (p.exitTs === null) {
      if (i0 < x.n) p.lastT = x.t[x.n - 1];
      if (p.bars >= MAX_HOLD[p.tf]) closePos(p, x.t[x.n - 1] + ms, x.c[x.n - 1], 'timeout');
    }
    const q = ST.quotes[p.coin];
    if (q) setCur(p, q.px);
  }
  function setCur(p, px) {
    const dir = p.side === 'long' ? 1 : -1;
    p.cur = px;
    p.rNow = dir * (px - p.entryPx) / p.rAbs;
    p.usd = NOTIONAL * p.rNow * p.rAbs / p.entryPx - FEE_RT;
  }
  function updateLive() {
    for (let i = 0; i < ST.pos.length; i++) {
      const p = ST.pos[i], q = ST.quotes[p.coin];
      if (p.exitTs === null && q) setCur(p, q.px);
    }
  }
  /* 資金費率極端反轉：跨過門檻那一刻才觸發（不分 K 線） */
  function checkFunding() {
    if (!ST.stratOn['funding_rev']) return;
    const now = Date.now(), ms = TF_MS[ST.tf];
    for (let i = 0; i < ST.uniList.length; i++) {
      const q = ST.uniList[i], f = q.funding;
      if (f === null || f === undefined || !isFinite(f)) continue;
      const sign = f >= FUND_X ? 1 : (f <= -FUND_X ? -1 : 0);
      const prev = ST.armFund[q.coin];
      ST.armFund[q.coin] = sign;
      if (prev === undefined || prev === sign || sign === 0) continue;
      const side = sign > 0 ? 'short' : 'long';
      if (ST.side !== 'both' && ST.side !== side) continue;
      const bucket = Math.floor(now / ms) * ms;
      const key = ST.tf + '|' + q.coin + '|funding_rev|' + side + '|' + bucket;
      if (ST.seen[key]) continue;
      ST.seen[key] = 1;
      if (openFor(q.coin, 'funding_rev')) continue;
      const c = ST.ctxs[q.coin], x = c && c.tf === ST.tf ? c.x : null;
      const atr = x ? x.atr[x.n - 1] : null;
      if (!(atr > 0)) continue;
      openPos({
        coin: q.coin, strat: 'funding_rev', side: side, tf: ST.tf, entryTs: bucket,
        entryPx: q.px, barPx: q.px, atr: atr,
        note: '資金費率 ' + (f * 100).toFixed(4) + '%／小時 越過 ' + (sign > 0 ? '+' : '−') + '0.01% 門檻（'
          + (prev > 0 ? '翻回正常' : '由正常轉極端') + '）→ ' + (side === 'long' ? '做多（空方付費擁擠）' : '做空（多方付費擁擠）'),
        ind: { atr: atr, funding: f }
      });
    }
  }

  /* ══ 統計（KPI、策略列、損益曲線共用）════════════════ */
  function isWin(p) { return p.usd > 0; }
  function agg(list) {
    const closed = list.filter(p => p.exitTs !== null), live = list.filter(p => p.exitTs === null);
    const rc = closed.map(p => p.rNow), uc = closed.map(p => p.usd), ul = live.map(p => p.usd);
    const w = closed.filter(isWin).length;
    return {
      n: list.length, nClosed: closed.length, nLive: live.length,
      nTp1: list.filter(p => p.maxTp >= 1).length, nTp2: list.filter(p => p.maxTp >= 2).length,
      nTp3: list.filter(p => p.maxTp >= 3).length, nTp4: list.filter(p => p.maxTp >= 4).length,
      nSl: closed.filter(p => p.why === 'sl').length, nBe: closed.filter(p => p.why === 'be').length,
      nTo: closed.filter(p => p.why === 'timeout').length,
      nLong: list.filter(p => p.side === 'long').length, nShort: list.filter(p => p.side === 'short').length,
      sumR: U.sum(rc), sumUsd: U.sum(uc), liveR: U.sum(live.map(p => p.rNow)), liveUsd: U.sum(ul),
      totalUsd: U.sum(uc) + U.sum(ul),
      winRate: closed.length ? w / closed.length : NaN,
      avgR: closed.length ? U.sum(rc) / closed.length : NaN,
      closed: closed, live: live
    };
  }
  function equityCurve(list) {
    const cs = list.filter(p => p.exitTs !== null).sort((a, b) => a.exitTs - b.exitTs);
    let acc = 0; const pts = [[t0ms(), 0]];
    cs.forEach(p => { acc += p.usd; pts.push([p.exitTs, acc]); });
    pts.push([Date.now(), acc]);
    return pts;
  }
  function stateChip(p) {
    if (p.exitTs === null) return p.maxTp >= 1 ? { t: '到 TP' + p.maxTp, c: 'tp' } : { t: '持有中', c: 'live' };
    if (p.why === 'sl') return { t: '止損', c: 'sl' };
    if (p.why === 'be') return { t: '保本平倉', c: 'be' };
    if (p.why === 'timeout') return { t: '逾時平倉', c: 'exp' };
    return { t: 'TP' + p.why.slice(2) + ' 平倉', c: 'tp' };
  }
  function t0ms() { const ts = ST.pos.map(p => p.entryTs); return ts.length ? Math.min.apply(null, ts) : Date.now(); }

  /* ══ 主輪詢：報價 7 秒（背景 45 秒）＋ K 線佇列 ════════ */
  async function loopMeta() {
    for (;;) {
      const ok = await pollMeta();
      if (ok) {
        updateLive();
        if (!KLQ.run && (ST.lastSweep === 0 || ST.lastSweep + TTL[ST.tf] < Date.now())) { rebuildQueue(); pump(); }
        else if (!KLQ.run && KLQ.i >= KLQ.list.length && ST.uniList.length) { rebuildQueue(); if (KLQ.list.length) pump(); }
        ST.prog.done = ST.uniList.reduce((n, q) => n + (freshCtx(q.coin) ? 1 : 0), 0);
        renderSoft();
      } else {
        renderSoft();
      }
      await sleep(document.hidden ? 45000 : 7000);
    }
  }
  function loopClock() {
    const now = new Date();
    U.text('#odClock', U.time(now.getTime()));
    U.text('#odDate', (now.getMonth() + 1) + '/' + now.getDate() + ' 台北');
    setTimeout(loopClock, 1000);
  }
})(window);
