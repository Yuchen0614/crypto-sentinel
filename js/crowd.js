/* crowd.js —「槓桿擁擠掃描（OI × 資費）」：全市場永續的未平倉 × 資金費率四象限
   ══════════════════════════════════════════════════════════════════════════
   為什麼不是「OI 增加就進場」
     OI（未平倉）增加只代表有新倉位，但分不出那是「新多」還是「新空」。
     真正有用的分法是拿 OI 變化 × 價格變化做四象限：

                       價格 ↑                    價格 ↓
        OI ↑   新多進場（趨勢啟動，可順勢）   新空進場（續跌機率高）
        OI ↓   空頭回補（假漲，不可追多）     去槓桿／強平（常是反轉起點）

   防假訊號
     OI 的「合約張數」會因價格上漲而自然變大（同樣的倉位換算成幣數不變、
     美元名目卻變大）。所以一律用 **美元名目的 OI**（openInterest × markPx）
     比較，並在畫面上標明。

   資料來源與誠實界線（重要）
     Hyperliquid 的 /info **沒有歷史 OI 端點**，只能拿到當下值。因此本模組：
       1. 每 20 秒輪詢一次 metaAndAssetCtxs（可一次拿到全市場 235 檔的
          OI／資金費率／成交額／標記價），在記憶體維護每幣的環狀緩衝；
       2. 讀 data/oi/<date>.json（GitHub Actions 每 15 分鐘蒐集的歷史）補足
          ΔOI(1h/4h/24h) 與資費百分位；
       3. 任何窗口只要資料不足就回 null，畫面顯示「—」，**不編數字**。
     觀測到的實際區間一律顯示在面板上（見 C.meta()）。

   節流：請求間隔 ≥450ms；失敗指數退避（×2，上限 90 秒）；
         document.hidden 時降頻到 2 分鐘一次（降頻不停更）。
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';
(function (w, d) {
  const S = w.SENTINEL, U = S && S.util;
  if (!S || !U) return;
  const C = S.crowd = S.crowd || {};

  /* ══ 參數 ══════════════════════════════════════════════ */
  const HL = 'https://api.hyperliquid.xyz/info';
  const POLL_MS = 20000;          // 可見時：20 秒一次
  const HIDDEN_MS = 120000;       // 背景分頁：2 分鐘一次（降頻不停更）
  const MIN_GAP = 450;            // 兩個請求之間至少 450ms
  const REQ_TIMEOUT = 15000;
  const LIVE_CAP = 180;           // 每幣最多留 180 筆即時觀測（20 秒 × 180 ＝ 1 小時）
  const HIST_KEEP = 26 * 3600e3;  // 歷史只留最近 26 小時（規則 4 要 24h，多留一點餘裕）
  const LSKEY = 'cs.crowd.buf.v1';
  const LS_SAVE_MS = 60000;       // localStorage 最多每一分鐘寫一次
  const LS_SAMPLE_MS = 60000;     // 存進 localStorage 的取樣間隔
  const LS_CAP = 60;              // 每幣最多存 60 筆（60 分 × 1 分）
  const LS_MIN_VOL = 1e5;         // 只存成交額 ≥ $100K 的幣，控制大小
  const LS_MAXBYTES = 900 * 1024; // 序列化後超過這個大小就不存（不要卡住主執行緒）

  /* 市場門檻（與「即時報單」頁同一組口徑，方便對照） */
  const UNI_MIN = 1e5;            // 有效宇宙下限：24h 成交額 ≥ $100K（長尾小幣也進來）
  const SMALL_MAX = 5e7;          // 「小幣」上限 $50M
  const ACTIVE_MIN = 2e7;         // 「活躍」下限 $20M

  /* 四象限判定：低於門檻視為盤整，不硬歸類，避免把雜訊講成訊號 */
  const FLAT_OI = 1.0;            // |ΔOI(1h)| < 1% 視為沒動
  const FLAT_PX = 0.15;           // |Δ價(1h)| < 0.15% 視為沒動

  /* 訊號門檻 */
  const OI_SURGE = 8;             // 規則 1：ΔOI(1h) ≥ +8%
  const FUND_LO = 5;              // 規則 2／3：資費百分位 ≤ 5%（空方付錢 → 空頭擁擠）
  const FUND_HI = 95;             // 規則 2／3：資費百分位 ≥ 95%（多方付錢 → 多頭擁擠）
  const OI_HIGH = 75;             // 「OI 在高位」＝ 近 24h 百分位 ≥ 75%（前 25%）
  const DELEV = -15;              // 規則 4：ΔOI(24h) ≤ −15%
  const MIN_SAMPLES = 12;         // 算百分位至少要 12 個樣本，否則回 null
  const BARS = 20;                // 突破判定用「最近 20 個觀測點」（歷史 15 分粒度 ≈ 5 小時）

  /* ══ 狀態 ══════════════════════════════════════════════ */
  const st = C.st = {
    uni: {},        // coin -> {coin, px, prev, chg, oi, oiu, fd, vol}
    ser: {},        // coin -> {t:[], o:[], p:[], f:[]} 合併：歷史 + 即時（依時間遞增）
    live: {},       // coin -> {t:[], o:[], p:[], f:[]} 只含本次開頁後累積的觀測
    hist: {},       // coin -> {t:[], o:[], p:[], f:[]} 只含 data/oi/*.json 的歷史
    histMeta: { ok: false, days: [], points: 0, from: 0, to: 0, coins: 0, err: '' },
    lastPoll: 0, lastOk: 0, polls: 0, fails: 0, backoff: 0,
    startedAt: Date.now(), liveSince: 0, dirty: true,
    timer: null, running: false, lastErr: ''
  };

  C.net = { polls: 0, fails: 0, lastMs: 0, backoff: 0 };

  /* ══ 工具 ══════════════════════════════════════════════ */
  const nowDay = off => new Date(Date.now() + off * 864e5).toISOString().slice(0, 10);

  function hl(body) {
    return new Promise(resolve => {
      const ac = typeof AbortController === 'function' ? new AbortController() : null;
      const to = ac ? setTimeout(() => ac.abort(), REQ_TIMEOUT) : null;
      fetch(HL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac ? ac.signal : undefined
      }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(j => { if (to) clearTimeout(to); resolve(j); })
        .catch(e => { if (to) clearTimeout(to); resolve(null); S.crowd.st.lastErr = String(e && e.message || e); });
    });
  }

  /* 在遞增的 t 陣列裡找「最後一個 ≤ x」的索引；找不到回 -1 */
  function lastLE(t, x) {
    let lo = 0, hi = t.length - 1, r = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (t[m] <= x) { r = m; lo = m + 1; } else hi = m - 1;
    }
    return r;
  }

  /* 百分位：回傳「這個值在樣本裡排第幾百分位」（0~100）；樣本太少回 null */
  function pctile(arr, v, minN) {
    const need = minN || MIN_SAMPLES;
    let n = 0, c = 0;
    for (let i = 0; i < arr.length; i++) {
      const x = arr[i];
      if (x === null || x === undefined || !isFinite(x)) continue;
      n++; if (x <= v) c++;
    }
    if (n < need) return null;
    return c / n * 100;
  }

  /* ══ 歷史：data/oi/<date>.json ═════════════════════════
     檔案格式見 scripts/snapshot_oi.py：coins 固定順序、points[].r 與 coins 同序，
     欄位 [oi(幣數量), fd(費率×1e8), vl(百萬美元), px]。
     讀不到（GitHub Actions 還沒跑過、或本機 file:// 直開）就誠實記在 histMeta 裡。 */
  function ingestDoc(doc) {
    if (!doc || !Array.isArray(doc.coins) || !Array.isArray(doc.points)) return 0;
    const idx = {}, coins = doc.coins;
    for (let i = 0; i < coins.length; i++) idx[coins[i]] = i;
    let used = 0, minT = Infinity, maxT = -Infinity;
    for (let p = 0; p < doc.points.length; p++) {
      const pt = doc.points[p], t = pt && pt.t;
      if (!isFinite(t) || !Array.isArray(pt.r)) continue;
      const tms = t * 1000;
      if (Date.now() - tms > HIST_KEEP) continue;         // 太舊的點丟掉
      if (tms < minT) minT = tms;
      if (tms > maxT) maxT = tms;
      used++;
      for (const coin in idx) {
        const row = pt.r[idx[coin]];
        if (!row || row.length < 4) continue;
        const oi = row[0], fd = row[1], px = row[3];
        if (!isFinite(px) || px <= 0) continue;
        const oiu = (isFinite(oi) && oi !== null) ? oi * px : null;
        const s = st.hist[coin] || (st.hist[coin] = { t: [], o: [], p: [], f: [] });
        s.t.push(tms);
        s.o.push(oiu);
        s.p.push(px);
        s.f.push(isFinite(fd) ? fd / 1e8 : null);
      }
    }
    st.histMeta.points += used;
    st.histMeta.coins = Math.max(st.histMeta.coins, coins.length);
    st.histMeta.from = st.histMeta.from ? Math.min(st.histMeta.from, minT) : minT;
    st.histMeta.to = st.histMeta.to ? Math.max(st.histMeta.to, maxT) : maxT;
    return used;
  }

  async function loadHistory() {
    const days = [nowDay(0), nowDay(-1)];      // 今天 + 昨天（跨日後仍有 24h 可算）
    const meta = st.histMeta;
    meta.ok = false; meta.err = ''; meta.days = [];
    for (const day of days) {
      let doc = null;
      try {
        const r = await fetch('data/oi/' + day + '.json', { cache: 'no-store' });
        if (!r.ok) { meta.days.push(day + '(無檔)'); continue; }
        doc = await r.json();
      } catch (e) {
        meta.days.push(day + '(讀取失敗)');
        continue;
      }
      const n = ingestDoc(doc);
      meta.days.push(day + '(' + n + ' 格)');
      if (n) meta.ok = true;
    }
    if (!meta.ok) meta.err = meta.days.join(' · ') || '尚未產生';
    st.dirty = true;
  }

  /* ══ 即時輪詢 + 環狀緩衝 ══════════════════════════════ */
  function pushLive(coin, t, o, p, f) {
    const s = st.live[coin] || (st.live[coin] = { t: [], o: [], p: [], f: [] });
    const n = s.t.length;
    if (n && t <= s.t[n - 1]) return;                    // 同一個時間點不重複塞
    s.t.push(t); s.o.push(o); s.p.push(p); s.f.push(f);
    if (s.t.length > LIVE_CAP) { s.t.shift(); s.o.shift(); s.p.shift(); s.f.shift(); }
  }

  function applyMeta(j) {
    if (!Array.isArray(j) || j.length < 2 || !j[0] || !Array.isArray(j[0].universe) || !Array.isArray(j[1])) return false;
    const uni = j[0].universe, ctx = j[1], t = Date.now(), seen = {};
    let n = 0;
    for (let i = 0; i < uni.length; i++) {
      const u = uni[i], c = ctx[i] || {};
      if (!u || !u.name) continue;
      const px = U.num(c.markPx) || U.num(c.midPx) || U.num(c.oraclePx);
      if (!isFinite(px) || px <= 0) continue;
      const oi = U.num(c.openInterest), vol = U.num(c.dayNtlVlm), prev = U.num(c.prevDayPx);
      const fd = U.num(c.funding);
      const q = { coin: u.name, px: px, prev: prev, szd: u.szDecimals,
        chg: (isFinite(prev) && prev > 0) ? (px / prev - 1) * 100 : null,
        oi: isFinite(oi) ? oi : null,
        oiu: (isFinite(oi) && oi > 0) ? oi * px : null,
        fd: isFinite(fd) ? fd : null,
        vol: isFinite(vol) ? vol : null,
        lev: u.maxLeverage };
      st.uni[u.name] = q; seen[u.name] = 1; n++;
      pushLive(u.name, t, q.oiu, px, q.fd);
    }
    if (!n) return false;
    for (const k in st.uni) if (!seen[k]) delete st.uni[k];   // 下架的幣不要留在畫面上
    if (!st.liveSince) st.liveSince = t;
    return true;
  }

  /* 合併歷史 + 即時（兩邊都已排序，線性合併；即時點優先覆蓋同時刻的歷史點） */
  function rebuild() {
    const out = {};
    const keys = {};
    for (const k in st.hist) keys[k] = 1;
    for (const k in st.live) keys[k] = 1;
    for (const k in keys) {
      const h = st.hist[k], l = st.live[k];
      if (!h) { out[k] = { t: l.t.slice(), o: l.o.slice(), p: l.p.slice(), f: l.f.slice() }; continue; }
      if (!l) { out[k] = { t: h.t.slice(), o: h.o.slice(), p: h.p.slice(), f: h.f.slice() }; continue; }
      const t = [], o = [], p = [], f = [];
      let i = 0, j = 0;
      while (i < h.t.length || j < l.t.length) {
        if (j >= l.t.length || (i < h.t.length && h.t[i] < l.t[j])) {
          t.push(h.t[i]); o.push(h.o[i]); p.push(h.p[i]); f.push(h.f[i]); i++;
        } else if (i >= h.t.length || l.t[j] < h.t[i]) {
          t.push(l.t[j]); o.push(l.o[j]); p.push(l.p[j]); f.push(l.f[j]); j++;
        } else {                                   // 同時刻：用即時的值
          t.push(l.t[j]); o.push(l.o[j]); p.push(l.p[j]); f.push(l.f[j]); i++; j++;
        }
      }
      out[k] = { t: t, o: o, p: p, f: f };
    }
    st.ser = out;
    st.dirty = false;
  }

  function series(coin) {
    if (st.dirty) rebuild();
    return st.ser[coin] || null;
  }

  /* ══ 變化量：ΔOI、Δ價、百分位 ═════════════════════════
     全部回傳 {v, mins, n} 或 null。mins 是「實際用到的區間長度」，
     讓面板可以誠實說「ΔOI(1h) 實際只有 22 分鐘的資料」。 */
  function change(coin, ms, field) {
    const s = series(coin);
    if (!s || s.t.length < 3) return null;
    const last = s.t.length - 1, nowT = s.t[last];
    const need = nowT - ms;
    const i = lastLE(s.t, need);
    if (i < 0) return null;                                  // 沒有夠舊的點
    const span = nowT - s.t[i];
    if (span < ms * 0.75) return null;                       // 差超過 25% 就當作沒有這個窗口
    const a = s[field][i], b = s[field][last];
    if (a === null || b === null || !isFinite(a) || !isFinite(b) || a <= 0) return null;
    return { v: (b / a - 1) * 100, mins: span / 60000, n: last - i + 1 };
  }

  /* 近 24h 的樣本切片（給百分位／高位判定用） */
  function window24(coin) {
    const s = series(coin);
    if (!s || !s.t.length) return null;
    const nowT = s.t[s.t.length - 1], from = nowT - 24 * 3600e3;
    const i = lastLE(s.t, from);
    const a = (i < 0 ? 0 : i + 1);
    return { s: s, a: a, n: s.t.length - a, nowT: nowT, from: s.t[a] };
  }

  C.dOI = (coin, ms) => change(coin, ms, 'o');
  C.dPx = (coin, ms) => change(coin, ms, 'p');

  /* 資費百分位：現在的費率在最近 24 小時（或現有樣本）裡排第幾百分位 */
  C.fundPct = function (coin) {
    const w = window24(coin);
    if (!w || w.n < MIN_SAMPLES) return null;
    const q = st.uni[coin];
    if (!q || q.fd === null) return null;
    const arr = w.s.f.slice(w.a);
    const v = pctile(arr, q.fd);
    if (v === null) return null;
    return { v: v, n: arr.filter(x => x !== null && isFinite(x)).length, spanH: (w.nowT - w.from) / 3600e3 };
  };

  /* OI 高位判定：現在的美元 OI 在最近 24 小時裡排第幾百分位 */
  C.oiPct = function (coin) {
    const w = window24(coin);
    if (!w || w.n < MIN_SAMPLES) return null;
    const q = st.uni[coin];
    if (!q || q.oiu === null) return null;
    const arr = w.s.o.slice(w.a);
    const v = pctile(arr, q.oiu);
    if (v === null) return null;
    return { v: v, n: arr.filter(x => x !== null && isFinite(x)).length, spanH: (w.nowT - w.from) / 3600e3 };
  };

  /* 迷你走勢用的資料點（最近 N 筆美元 OI，最少 3 筆才畫） */
  C.spark = function (coin, n) {
    const s = series(coin);
    if (!s) return null;
    const k = Math.min(n || 60, s.t.length);
    if (k < 3) return null;
    const out = [];
    for (let i = s.t.length - k; i < s.t.length; i++) if (isFinite(s.o[i])) out.push(s.o[i]);
    return out.length >= 3 ? out : null;
  };

  /* ══ 資料來源說明（面板底要顯示，不可省）══════════════ */
  C.meta = function () {
    const liveSpan = st.liveSince ? (Date.now() - st.liveSince) / 60000 : 0;
    const m = st.histMeta;
    const histSpan = (m.ok && m.from && m.to) ? (m.to - m.from) / 60000 : 0;
    return {
      liveMin: liveSpan,                                  // 本次開頁已累積幾分鐘
      liveFrom: st.liveSince,
      histOk: !!m.ok, histDays: m.days.slice(), histPoints: m.points,
      histSpanMin: histSpan, histFrom: m.from, histTo: m.to,
      histErr: m.err,
      /* 合併後實際能算多遠的窗口（分鐘） */
      spanMin: Math.max(liveSpan, histSpan),
      step: 900
    };
  };

  /* ══ localStorage：只存精簡版（60 分 × 1 分、成交額 ≥ $100K）══
     純粹是「重新整理後不至於全部重來」。主要歷史仍以 data/oi/*.json 為準。 */
  function saveLS() {
    if (!C._ls) return;
    const bundle = {}, step = LS_SAMPLE_MS;
    for (const coin in st.live) {
      const q = st.uni[coin];
      if (q && q.vol !== null && q.vol < LS_MIN_VOL) continue;
      const l = st.live[coin];
      const t = [], o = [], p = [], f = [];
      let nextT = 0;
      for (let i = 0; i < l.t.length; i++) {
        if (t.length === 0 || l.t[i] - nextT >= step - 1) {
          t.push(l.t[i]); o.push(l.o[i]); p.push(l.p[i]); f.push(l.f[i]);
          nextT = l.t[i];
        }
      }
      while (t.length > LS_CAP) { t.shift(); o.shift(); p.shift(); f.shift(); }
      if (t.length >= 3) bundle[coin] = { t: t, o: o, p: p, f: f };
    }
    let json;
    try { json = JSON.stringify({ at: Date.now(), step: step, ser: bundle }); } catch (e) { return; }
    if (json.length > LS_MAXBYTES) { C._lsBytes = json.length; C._lsSkipped = true; return; }
    try { w.localStorage.setItem(LSKEY, json); C._lsBytes = json.length; C._lsSkipped = false; } catch (e) { C._ls = false; }
  }

  function loadLS() {
    try {
      const raw = w.localStorage.getItem(LSKEY);
      if (!raw) return;
      const d0 = JSON.parse(raw);
      if (!d0 || !d0.ser) return;
      const stale = Date.now() - (d0.at || 0) > 6 * 3600e3;   // 超過 6 小時的前一輪不算
      if (stale) { w.localStorage.removeItem(LSKEY); return; }
      let n = 0;
      for (const coin in d0.ser) {
        const s = d0.ser[coin];
        if (!s || !s.t || s.t.length < 3) continue;
        st.live[coin] = { t: s.t.slice(), o: s.o.slice(), p: s.p.slice(), f: s.f.slice() };
        if (!st.liveSince || s.t[0] < st.liveSince) st.liveSince = s.t[0];
        n++;
      }
      C._lsLoaded = n;
    } catch (e) { /* 壞掉就當沒有 */ }
  }

  /* ══ 輪詢主迴圈 ═══════════════════════════════════════ */
  async function poll() {
    if (Date.now() - C.net.lastMs < MIN_GAP) return false;
    C.net.lastMs = Date.now();
    st.polls++; C.net.polls++;
    const j = await hl({ type: 'metaAndAssetCtxs' });
    if (!applyMeta(j)) {
      st.fails++; C.net.fails++;
      C.net.backoff = Math.min(90000, C.net.backoff ? C.net.backoff * 2 : 20000);
      C.st.lastErr = C.st.lastErr || 'metaAndAssetCtxs 回傳格式不符';
      return false;
    }
    st.lastPoll = Date.now(); st.lastOk = st.lastPoll;
    C.net.backoff = 0;
    st.dirty = true;
    if (Date.now() - (C._lsAt || 0) > LS_SAVE_MS) { C._lsAt = Date.now(); saveLS(); }
    S.emit && S.emit('crowd-update', C);
    return true;
  }

  function tick() {
    poll().finally(() => {
      const wait = d.hidden ? HIDDEN_MS : POLL_MS;
      const extra = C.net.backoff || 0;
      st.timer = setTimeout(tick, wait + extra);
    });
  }

  C.start = async function () {
    if (st.running) return;
    st.running = true;
    C._ls = (function () {
      try { w.localStorage.setItem('cs.__t', '1'); w.localStorage.removeItem('cs.__t'); return true; } catch (e) { return false; }
    })();
    loadLS();
    st.dirty = true;
    await poll();
    loadHistory().finally(() => { st.dirty = true; S.emit && S.emit('crowd-update', C); });
    tick();
  };

  /* 診斷（驗證用）：SENTINEL.crowd.status() */
  C.status = function () {
    const m = C.meta();
    let oi = 0, n = 0, fdHi = null, fdLo = null;
    for (const c in st.uni) {
      const q = st.uni[c];
      if (q.oiu !== null) { oi += q.oiu; n++; }
      if (q.fd !== null) {
        if (!fdHi || q.fd > fdHi.fd) fdHi = q;
        if (!fdLo || q.fd < fdLo.fd) fdLo = q;
      }
    }
    return {
      coins: n, sumOiUsd: oi, fundHi: fdHi ? fdHi.coin : null, fundLo: fdLo ? fdLo.coin : null,
      polls: st.polls, fails: st.fails, lastErr: st.lastErr,
      live: m.liveMin, histOk: m.histOk, histDays: m.histDays, histPoints: m.histPoints,
      histSpanMin: m.histSpanMin, spanMin: m.spanMin, seriesCoins: Object.keys(st.ser).length,
      lsBytes: C._lsBytes, lsSkipped: !!C._lsSkipped, lsLoaded: C._lsLoaded || 0
    };
  };
})(window, document);
