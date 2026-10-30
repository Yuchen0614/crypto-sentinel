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
  const TTL = { '1m': 9e4, '5m': 24e4, '15m': 45e4, '1h': 9e5 };     // K 線快取時效（毫秒）
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

  OD.STRATS = STRATS; OD.MODES = MODES; OD.mkctx = mkctx; OD.const = {
    TF_MS, TF_TXT, TTL, BARS, FRESH_BARS, MAX_HOLD, NOTIONAL, FEE_SIDE, FEE_RT, FUND_X, THROTTLE,
    UNI_MIN, UNI_ACTIVE, UNI_MAJOR, UNI_SMALL, LSK, pxTxt, sig, d, q1, sleep
  };
})(window);
