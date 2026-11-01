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
  const FUND_DISTINCT = 5;        // 資費樣本至少要有 5 個不同數值才算百分位（見 pctile 的說明）
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

  /* 百分位：回傳「這個值在樣本裡排第幾百分位」（0~100）。
     兩個防呆（都會誠實回 null 而不是給一個看起來很極端的假數字）：
       1. 樣本數 < minN（預設 12）→ 不算。
       2. 不同數值的個數 < minDistinct → 不算。
          資金費率有一大票幣長期停在 Hyperliquid 的基準值 0.0000125，
          樣本全部相同時「百分位 = 100%」在數學上成立、在交易上毫無意義，
          會讓規則 2／3 對幾十檔幣同時亂發訊號。
     回傳 {v, n, nd}：v 百分位、n 樣本數、nd 不同數值個數。 */
  function pctile(arr, v, minN, minDistinct) {
    const need = minN || MIN_SAMPLES, needD = minDistinct || 1;
    let n = 0, c = 0, nd = 0;
    const seen = needD > 1 ? Object.create(null) : null;
    for (let i = 0; i < arr.length; i++) {
      const x = arr[i];
      if (x === null || x === undefined || !isFinite(x)) continue;
      n++; if (x <= v) c++;
      if (seen) { const k = '' + x; if (!seen[k]) { seen[k] = 1; nd++; } }
    }
    if (n < need) return null;
    if (seen && nd < needD) return null;
    return { v: c / n * 100, n: n, nd: seen ? nd : null };
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
    /* 窗口必須「真的存在」：太短（樣本還不到窗口）不算，
       太長（最近的點比窗口舊太多）也不算 —— 否則會拿 53 分鐘前的樣本
       冒充「ΔOI 5m」，數字看起來有值卻是錯的窗口。 */
    if (span < ms * 0.75) return null;
    if (span > ms * 1.6 + 60e3) return null;
    const a = s[field][i], b = s[field][last];
    if (a === null || b === null || !isFinite(a) || !isFinite(b) || a <= 0) return null;
    return { v: (b / a - 1) * 100, a: a, b: b, mins: span / 60000, n: last - i + 1 };
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

  /* 四象限要用的窗口：優先用完整 1 小時；剛開頁、歷史還沒累積到 1 小時時，
     退而用「目前真的存在的最長窗口」（30 分 → 15 分 → 10 分 → 5 分 → 3 分），
     並且明白標示這是短窗暫代。寧可誠實縮窗，也不要整個面板卡在「資料不足」。 */
  const QWINS = [3600e3, 1800e3, 900e3, 600e3, 300e3, 180e3];
  function quadWin(coin) {
    for (let i = 0; i < QWINS.length; i++) {
      const ms = QWINS[i];
      const o = C.dOI(coin, ms), p = C.dPx(coin, ms);
      if (o && p) {
        return { o: o, p: p, ms: ms, short: ms < 3600e3,
          tag: ms >= 3600e3 ? '1h' : (ms % 3600e3 === 0 ? (ms / 3600e3) + 'h' : (ms / 60000) + ' 分') };
      }
    }
    return null;
  }
  C.quadWin = quadWin;

  /* 資費百分位：現在的費率在最近 24 小時（或現有樣本）裡排第幾百分位。
     「哪一邊擁擠」一律看費率的正負號（正＝多方付錢＝多頭擁擠），
     百分位只用來判斷「這個讀數對這檔幣來說算不算極端」——
     兩者分開，才不會出現「負費率卻被百分位 97% 判成多頭擁擠」的相反方向。 */
  C.fundPct = function (coin) {
    const w = window24(coin);
    if (!w || w.n < MIN_SAMPLES) return null;
    const q = st.uni[coin];
    if (!q || q.fd === null) return null;
    const arr = w.s.f.slice(w.a);
    const p = pctile(arr, q.fd, MIN_SAMPLES, FUND_DISTINCT);
    if (p === null) return null;
    return {
      v: p.v, n: p.n, nd: p.nd, spanH: (w.nowT - w.from) / 3600e3,
      longPays: q.fd > 0,                                   // 正費率：多方付錢給空方
      extreme: (p.v >= FUND_HI || p.v <= FUND_LO)
    };
  };

  /* OI 高位判定：現在的美元 OI 在最近 24 小時裡排第幾百分位 */
  C.oiPct = function (coin) {
    const w = window24(coin);
    if (!w || w.n < MIN_SAMPLES) return null;
    const q = st.uni[coin];
    if (!q || q.oiu === null) return null;
    const arr = w.s.o.slice(w.a);
    const p = pctile(arr, q.oiu, MIN_SAMPLES, 4);
    if (p === null) return null;
    return { v: p.v, n: p.n, nd: p.nd, spanH: (w.nowT - w.from) / 3600e3 };
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

  /* ══════════════════════════════════════════════════════
     四象限：OI 變化 × 價格變化
     ══════════════════════════════════════════════════════ */
  const QUAD = {
    newlong:    { k: 'newlong',    t: '新多進場',      cls: 'q-nl', dir: 'long',  note: 'OI 增加 ＋ 價格上漲：新倉做多，趨勢啟動，可順勢。' },
    newshort:   { k: 'newshort',   t: '新空進場',      cls: 'q-ns', dir: 'short', note: 'OI 增加 ＋ 價格下跌：新倉做空，續跌機率高。' },
    shortcover: { k: 'shortcover', t: '空頭回補',      cls: 'q-sc', dir: 'warn',  note: 'OI 減少 ＋ 價格上漲：空方平倉推上去的漲勢，不可追多、常反殺。' },
    delev:      { k: 'delev',      t: '去槓桿／強平',  cls: 'q-dl', dir: 'rev',   note: 'OI 減少 ＋ 價格下跌：多頭被平倉或強制平倉，常是反轉起點。' },
    flat:       { k: 'flat',       t: '盤整',          cls: 'q-flat', dir: 'none', note: 'OI 與價格都在雜訊範圍內（|ΔOI| < ' + FLAT_OI + '%、|Δ價| < ' + FLAT_PX + '%）。' },
    na:         { k: 'na',         t: '資料不足',      cls: 'q-na', dir: 'none',  note: '還算不出 ΔOI(1h) 與 Δ價(1h) 的完整窗口，先不歸類。' }
  };
  C.QUAD = QUAD;
  C.quadrant = function (d1h, p1h) {
    if (!d1h || !p1h) return QUAD.na;
    const o = d1h.v, p = p1h.v;
    if (Math.abs(o) < FLAT_OI || Math.abs(p) < FLAT_PX) return QUAD.flat;
    if (o > 0 && p > 0) return QUAD.newlong;
    if (o > 0 && p < 0) return QUAD.newshort;
    if (o < 0 && p > 0) return QUAD.shortcover;
    return QUAD.delev;
  };

  /* 近 N 小時的標記價區間（突破判定用）。skipMs 讓最近一小段不列入基準，
     否則「現在」的價格會自己變成自己的高點。 */
  function range(coin, backMs, skipMs) {
    const s = series(coin);
    if (!s || s.t.length < 8) return null;
    const nowT = s.t[s.t.length - 1], hiT = nowT - (skipMs || 0), loT = nowT - backMs;
    let hi = -Infinity, lo = Infinity, n = 0, tNew = 0, tOld = 0;
    for (let i = s.t.length - 1; i >= 0; i--) {
      const t = s.t[i];
      if (t > hiT) continue;
      if (t < loT) break;
      const v = s.p[i];
      if (isFinite(v)) {
        if (v > hi) hi = v; if (v < lo) lo = v; n++;
        if (!tNew) tNew = t; tOld = t;
      }
    }
    if (n < 8 || !isFinite(hi)) return null;
    if ((tNew - tOld) < backMs * 0.5) return null;        // 涵蓋不到一半的區間 → 不算
    return { hi: hi, lo: lo, n: n, hours: (tNew - tOld) / 3600e3 };
  }

  /* ══ 單一幣種的完整分析（四象限 ＋ 五條訊號）══════════ */
  const BAR_MS = 5 * 3600e3;        // 突破基準：近 5 小時（≈ 20 根 15 分 K）
  const BAR_SKIP = 15 * 60e3;       // 最近 15 分不列入基準

  C.analyse = function (coin) {
    const q = st.uni[coin];
    if (!q) return null;
    const s = series(coin);
    const d5 = C.dOI(coin, 5 * 60e3), d1h = C.dOI(coin, 3600e3);
    const d4h = C.dOI(coin, 4 * 3600e3), d24h = C.dOI(coin, 24 * 3600e3);
    const p1h = C.dPx(coin, 3600e3);
    const fp = C.fundPct(coin), op = C.oiPct(coin);
    const rg = range(coin, BAR_MS, BAR_SKIP);
    const br = (rg && isFinite(q.px)) ? {
      hi: rg.hi, lo: rg.lo, hours: rg.hours, up: q.px > rg.hi, dn: q.px < rg.lo
    } : null;
    /* 四象限用的窗口：1 小時優先；歷史還沒累積到 1 小時時，
       退到「目前真的存在的最長窗口」並明白標示是短窗暫代。 */
    const qw = quadWin(coin);
    const quad = qw ? C.quadrant(qw.o, qw.p) : QUAD.na;
    const full = (s && s.t.length >= 3) ? (s.t[s.t.length - 1] - s.t[0]) / 60000 : 0;
    const oiuPrev = (d1h && d1h.a) ? d1h.a : null;

    /* ── 五條訊號 ────────────────────────────────────── */
    const sig = [];
    const pxTxt = U.px(q.px);
    const oiTxt = (a, b) => 'OI ' + U.usd(a) + '→' + U.usd(b);
    const fundTxt = fp ? ('資費 ' + (q.fd * 100).toFixed(5) + '%/hr（' + (fp.longPays ? '多方付錢' : '空方付錢') +
      '，近 24h 百分位 ' + fp.v.toFixed(0) + '%、樣本 ' + fp.n + '／' + fp.nd + ' 個相異值）') : null;

    /* 1. OI 暴增突破：ΔOI(1h) ≥ +8% 且標記價突破近 5 小時高／低 */
    if (d1h && d1h.v >= OI_SURGE && br && (br.up || br.dn)) {
      const up = br.up;
      sig.push({ id: 1, name: 'OI 暴增突破', dir: up ? 'long' : 'short', boost: 12,
        why: 'ΔOI(1h) ' + U.pct(d1h.v, 1) + '（' + oiTxt(d1h.a, d1h.b) + '）· 標記價 ' + pxTxt +
             ' ' + (up ? '突破' : '跌破') + '近 ' + br.hours.toFixed(1) + ' 小時' + (up ? '高 ' : '低 ') +
             U.px(up ? br.hi : br.lo) });
    }

    /* 2. 軋空／軋多：資費極端 ＋ OI 在高位 ＋ 價格已經往「被擠壓那一邊認輸」的方向突破
          方向一律由費率正負號決定：正＝多方付錢（多頭擁擠）→ 軋多偏空；負＝空方付錢 → 軋空偏多。 */
    if (fp && fp.extreme && op && op.v >= OI_HIGH && br && (br.up || br.dn)) {
      const squeezeLong = !fp.longPays;                 // 空方付錢 → 軋空（偏多）
      if ((squeezeLong && br.up) || (!squeezeLong && br.dn)) {
        sig.push({ id: 2, name: squeezeLong ? '軋空啟動' : '軋多啟動', dir: squeezeLong ? 'long' : 'short', boost: 15,
          why: fundTxt + '· OI 百分位 ' + op.v.toFixed(0) + '%（近 24h 高位）· 標記價 ' + pxTxt +
               ' 已' + (br.up ? '上破 ' + U.px(br.hi) : '下破 ' + U.px(br.lo)) + '：' +
               (squeezeLong ? '空方認輸回補，偏多' : '多方認輸出場，偏空') });
      }
    }

    /* 3. 資費極端反轉：資費百分位 ≥95% 或 ≤5% ＋ OI 高 → 反向（門檻一律用相對百分位，不寫死數值）*/
    if (fp && fp.extreme && op && op.v >= OI_HIGH) {
      sig.push({ id: 3, name: '資費極端反轉', dir: fp.longPays ? 'short' : 'long', boost: 10,
        why: fundTxt + '· OI 百分位 ' + op.v.toFixed(0) + '%（近 24h 高位）· ' +
             (fp.longPays ? '多方擁擠且持續付費，反向偏空' : '空方擁擠且持續付費，反向偏多') });
    }

    /* 4. 去槓桿反轉：ΔOI(24h) ≤ −15% ＋ 價格急跌 */
    if (d24h && d24h.v <= DELEV && ((p1h && p1h.v <= -3) || (q.chg !== null && q.chg <= -8))) {
      sig.push({ id: 4, name: '去槓桿反轉', dir: 'rev', boost: 12,
        why: 'ΔOI(24h) ' + U.pct(d24h.v, 1) + '（' + oiTxt(d24h.a, d24h.b) + '）· 24h 價格 ' +
             U.pct(q.chg, 2) + (p1h ? '、1h ' + U.pct(p1h.v, 2) : '') + '（急跌）· 槓桿已被清掉，常是反轉起點，等止跌訊號再進場' });
    }

    /* 5. 價格與 OI 背離：創新高但 OI 反而減少 → 這一段漲勢沒有新資金，禁止追多 */
    if (br && d1h) {
      if (br.up && d1h.v < 0) {
        sig.push({ id: 5, name: '價漲 OI 跌（禁止追多）', dir: 'avoid', boost: 6, warn: true,
          why: '標記價 ' + pxTxt + ' 突破近 ' + br.hours.toFixed(1) + ' 小時高 ' + U.px(br.hi) +
               '，但 ΔOI(1h) ' + U.pct(d1h.v, 1) + '（' + oiTxt(d1h.a, d1h.b) + '）· 沒有新倉位支撐，是空頭回補或拉高派貨，不可追多' });
      } else if (br.dn && d1h.v < 0) {
        sig.push({ id: 5, name: '價跌 OI 跌（禁止追空）', dir: 'avoid', boost: 5, warn: true,
          why: '標記價 ' + pxTxt + ' 跌破近 ' + br.hours.toFixed(1) + ' 小時低 ' + U.px(br.lo) +
               '，但 ΔOI(1h) ' + U.pct(d1h.v, 1) + '· 是平倉殺盤而非新空進場，不可追空' });
      }
    }

    /* ── 訊號強度（0~100）：OI 動能 45 ＋ 資費極端度 25 ＋ 價格動能 20 ＋ 象限 10 ──
       強度只用「真的 1 小時／4 小時」的窗口，短窗暫代不列入，避免把 5 分鐘的
       小波動換算成看起來很強的分數。 */
    let base = 0;
    if (d1h) base += Math.min(45, Math.abs(d1h.v) / OI_SURGE * 45);
    if (fp) base += Math.min(25, Math.abs(fp.v - 50) / 50 * 25);
    if (p1h) base += Math.min(20, Math.abs(p1h.v) / 6 * 20);
    if (qw && !qw.short && quad.k !== 'flat' && quad.k !== 'na') base += 10;
    const boost = sig.reduce((n, x) => Math.max(n, x.boost), 0);
    const strength = Math.round(Math.min(100, base + (sig.length ? boost * 0.6 : 0)));

    const main = sig.slice().sort((x, y) => y.boost - x.boost)[0] || null;
    /* 短窗時給一個替代排序鍵：|ΔOI(win)|，讓候選清單至少照「動得最多的」排 */
    const qwv = qw ? Math.abs(qw.o.v) : 0;

    return {
      coin: coin, q: q, quad: quad, sig: sig, main: main, strength: strength, qw: qw, qwv: qwv,
      d5: d5, d1h: d1h, d4h: d4h, d24h: d24h, p1h: p1h, fp: fp, op: op, br: br, rg: rg,
      oiu: q.oiu, oiuPrev: oiuPrev, chg: q.chg, vol: q.vol, px: q.px,
      small: (q.vol !== null && q.vol >= UNI_MIN && q.vol <= SMALL_MAX),
      spans: { full: full, d1h: d1h ? d1h.mins : null, d4h: d4h ? d4h.mins : null, d24h: d24h ? d24h.mins : null },
      /* 依據文字：把這一列的每個數字為什麼長這樣講清楚（面板上點列就看得見） */
      evid: (function () {
        const a = [];
        a.push('ΔOI：5 分 ' + (d5 ? U.pct(d5.v, 2) : '—') + '、1 小時 ' + (d1h ? U.pct(d1h.v, 2) : '—') +
               '、4 小時 ' + (d4h ? U.pct(d4h.v, 2) : '—') + '、24 小時 ' + (d24h ? U.pct(d24h.v, 2) : '—'));
        if (d1h) a.push('OI 美元名目 ' + U.usd(d1h.a) + ' → ' + U.usd(d1h.b) + '（實際區間 ' + d1h.mins.toFixed(0) + ' 分）');
        a.push('四象限窗口：' + (qw
          ? (qw.short ? qw.tag + '（短窗暫代，1 小時窗口還在累積）' : '1 小時') +
            '，ΔOI ' + U.pct(qw.o.v, 2) + '（' + U.usd(qw.o.a) + ' → ' + U.usd(qw.o.b) + '，實際區間 ' + qw.o.mins.toFixed(0) + ' 分）· Δ價 ' + U.pct(qw.p.v, 2)
          : '兩邊都還算不出來（需要至少 3 分鐘以上的連續觀測）'));
        if (q.oiu !== null) a.push('現值 OI ' + U.usd(q.oiu) + (op ? '（近 24h 百分位 ' + op.v.toFixed(0) + '%，樣本 ' + op.n + '）' : '（近 24h 樣本不足，不給百分位）'));
        if (fp) a.push('資費 ' + (q.fd * 100).toFixed(5) + '%/hr（' + (fp.longPays ? '多方付錢' : '空方付錢') +
          '，近 24h 百分位 ' + fp.v.toFixed(0) + '%，樣本 ' + fp.n + '／' + fp.nd + ' 個相異值' + (fp.extreme ? '，屬極端' : '，不算極端') + '）');
        else a.push('資費 ' + (q.fd !== null ? (q.fd * 100).toFixed(5) + '%/hr' : '—') +
          '（近 24h 樣本不足 ' + MIN_SAMPLES + ' 個、或相異值不足 ' + FUND_DISTINCT + ' 個，不給百分位）');
        a.push('24h 價格 ' + (q.chg !== null ? U.pct(q.chg, 2) : '—') + (p1h ? '、1 小時 ' + U.pct(p1h.v, 2) : '、1 小時 —'));
        a.push('象限：' + quad.t + (qw && qw.short ? '（以 ' + qw.tag + ' 窗口判定）' : ''));
        if (sig.length) a.push('訊號：' + sig.map(x => '【' + x.name + '】' + x.why).join(' ／ '));
        else a.push('訊號：目前不符合五條規則中的任何一條（OI 暴增需 ΔOI(1h) ≥ +' + OI_SURGE + '%、資費極端需百分位 ≥' + FUND_HI + '% 或 ≤' + FUND_LO + '%）');
        return a.join(' · ');
      })()
    };
  };

  /* 全市場：只掃 24h 成交額 ≥ $100K 的幣（長尾小幣也進來，不是只做大幣） */
  C.scanAll = function () {
    if (st.dirty) rebuild();
    const out = [];
    for (const coin in st.uni) {
      const q = st.uni[coin];
      if (q.vol === null || q.vol < UNI_MIN) continue;
      const a = C.analyse(coin);
      if (a) out.push(a);
    }
    /* 預設排序：訊號強度 → 四象限動能 → 成交額（強度都是 0 時也不會變成隨機順序） */
    out.sort((x, y) => (y.strength - x.strength) || (y.qwv - x.qwv) || ((y.vol || 0) - (x.vol || 0)));
    return out;
  };

  /* ══════════════════════════════════════════════════════
     面板渲染（UI）
     ══════════════════════════════════════════════════════ */
  const $ = s => d.querySelector(s);
  const ui = C.ui = { rows: [], list: [], filter: 'all', q: '', sort: null, evid: null, drawn: 0, lastRender: 0 };

  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  /* 置中發散橫條：正=綠（往右）、負=紅（往左） */
  function dbar(v, full, title) {
    if (v === null || !isFinite(v)) return '<span class="cw-dbar empty" title="' + esc(title || '資料不足') + '"></span>';
    const k = Math.max(-1, Math.min(1, v / full));
    const w = (Math.abs(k) * 50).toFixed(1);
    return '<span class="cw-dbar" title="' + esc(title || '') + '">' +
      '<i class="' + (k >= 0 ? 'p' : 'n') + '" style="width:' + w + '%"></i></span>';
  }

  function pctCell(c) { return c ? U.pct(c.v, 1) : '—'; }
  function cls(c) { return !c ? 'flat' : (c.v > 0 ? 'up' : (c.v < 0 ? 'down' : 'flat')); }

  function quadChip(q, title) {
    return '<span class="cw-q ' + q.cls + '" title="' + esc(title || q.note) + '">' + q.t + '</span>';
  }

  function fundCell(a) {
    if (a.q.fd === null) return '<span class="cw-n">—</span>';
    const v = a.q.fd * 100;
    return '<b class="' + (v > 0 ? 'up' : (v < 0 ? 'down' : 'flat')) + '">' + (v > 0 ? '+' : '') + v.toFixed(5) + '%</b>' +
      '<span class="mini">' + (a.fp ? '百分位 ' + a.fp.v.toFixed(0) + '%' : '百分位 —') + '</span>';
  }

  /* ── 暴漲暴跌候選（面板最上面，依訊號強度排序）────────── */
  function renderCands() {
    const host = $('#cwCands'); if (!host) return;
    /* 候選一律照「訊號強度」排，不受表格的排序影響 */
    const hits = ui.list.filter(a => a.sig.length).sort((x, y) => y.strength - x.strength);
    /* 本輪沒有任何幣種命中規則時，改用「象限明確」的幣種照動能排出前幾名，
       並明白寫出這是替代清單，而不是假裝有訊號。 */
    const alt = !hits.length;
    const cands = (alt
      ? ui.list.filter(a => a.qw && a.quad.k !== 'flat' && a.quad.k !== 'na').sort((x, y) => y.qwv - x.qwv)
      : hits).slice(0, 12);
    const nD1 = ui.list.filter(a => a.d1h).length;
    const nQ = ui.list.filter(a => a.qw).length;
    const head = '<div class="cw-chead"><b>暴漲暴跌候選</b>' +
      '<span class="mini">' + (alt
        ? '本輪沒有幣種命中五條規則；下面列出四象限較明確、OI 動得最多的 ' + cands.length + ' 檔（依 |ΔOI| 排序）'
        : '命中訊號 ' + hits.length + ' 檔，依訊號強度排序，只列前 ' + Math.min(12, hits.length) + ' 檔') +
      ' · 能量到完整 1 小時窗口的有 ' + nD1 + ' 檔、能判四象限的有 ' + nQ + ' 檔</span></div>';
    if (!cands.length) {
      host.innerHTML = head + '<div class="empty">目前連四象限都還判不出來。<br>' +
        'ΔOI 需要至少 3 分鐘的連續觀測（歷史 15 分粒度或本頁每 20 秒累積），' +
        '本頁開啟時間越久、或 GitHub Actions 的 data/oi 累積越多格，可判定的幣種就越多。</div>';
      ui.drawn = 0;
      return;
    }
    let h = head;
    for (const a of cands) {
      /* 有命中規則就用規則的方向；替代清單（還沒命中規則）用四象限的方向 */
      const side = a.main ? a.main.dir : a.quad.dir;
      const dirTxt = { long: '偏多', short: '偏空', rev: '反轉', avoid: '勿追', warn: '警示', none: '觀察' }[side] || '觀察';
      h += '<div class="cw-c ' + (a.main && a.main.warn ? 'warn ' : '') + 'side-' + side + '" data-c="' + esc(a.coin) + '" tabindex="0" title="' + esc(a.evid) + '">' +
        '<div class="r1">' +
        '<b class="nm">' + esc(a.coin) + (a.small ? '<i class="cw-small" title="小幣：24h 成交額 $100K~$50M">小</i>' : '') + '</b>' +
        '<span class="dir">' + dirTxt + '</span>' +
        quadChip(a.quad) +
        (a.main ? '<span class="cw-sig">' + esc(a.main.name) + '</span>' : '') +
        '<span class="st" title="訊號強度：OI 動能 45 ＋ 資費極端度 25 ＋ 價格動能 20 ＋ 象限 10，再加上命中的規則權重">強度 ' + a.strength + '</span>' +
        '</div>' +
        '<div class="r2">' +
        (function () {
          /* 有真的 1 小時窗口就顯示 1h；否則顯示四象限暫代用的短窗並標明 */
          const c = a.d1h || (a.qw && a.qw.short ? a.qw.o : null);
          const lb = a.d1h ? 'ΔOI 1h' : (a.qw ? 'ΔOI ' + a.qw.tag + '*' : 'ΔOI 1h');
          const tip = a.d1h
            ? 'ΔOI(1h)（相對 20% 為滿格）'
            : (a.qw ? 'ΔOI(' + a.qw.tag + ') 短窗暫代：1 小時窗口還在累積（相對 20% 為滿格）' : '還沒有可用的 ΔOI 窗口');
          return '<span class="cell"><label' + (a.d1h ? '' : ' class="short"') + ' title="' + esc(tip) + '">' + lb + '</label>' +
            dbar(c ? c.v : null, 20, tip) + '<b class="' + cls(c) + '">' + pctCell(c) + '</b></span>';
        })() +
        '<span class="cell"><label>資費</label>' + dbar(a.q.fd !== null ? a.q.fd * 100 : null, 0.02, '資金費率，±0.02%/hr 為滿格') +
        '<b class="' + (a.q.fd > 0 ? 'up' : (a.q.fd < 0 ? 'down' : 'flat')) + '">' +
        (a.q.fd === null ? '—' : (a.q.fd > 0 ? '+' : '') + (a.q.fd * 100).toFixed(5) + '%') + '</b>' +
        '<i class="cw-pct">' + (a.fp ? a.fp.v.toFixed(0) + '%' : '—') + '</i></span>' +
        '<span class="cell"><label>24h</label><b class="' + cls(a.chg === null ? null : { v: a.chg }) + '">' + (a.chg === null ? '—' : U.pct(a.chg, 2)) + '</b></span>' +
        '<span class="cell"><label>成交額</label><b>' + U.usd(a.vol) + '</b></span>' +
        '<span class="cell"><label>OI 走勢</label><canvas class="cw-spark"></canvas></span>' +
        '</div></div>';
    }
    host.innerHTML = h;
    /* 迷你 OI 走勢（有資料才畫，畫不出來就留空，不畫假線） */
    const cvs = host.querySelectorAll('.cw-c');
    for (let i = 0; i < cvs.length && i < cands.length; i++) {
      const a = cands[i], cv = cvs[i].querySelector('canvas.cw-spark');
      if (!cv) continue;
      const data = C.spark(a.coin, 72);
      if (data) U.spark(cv, data, a.quad.dir === 'short' ? '#f6465d' : '#5b8cff', true);
    }
    ui.drawn = cands.length;
  }

  /* ── 完整掃描表 ─────────────────────────────────────── */
  const COLS = [
    { k: 'coin', t: '幣種', a: 'ta-l', tip: 'Hyperliquid 永續，只列出 24h 成交額 ≥ $100K 的幣（含長尾小幣）' },
    { k: 'px', t: '標記價', a: 'ta-r', tip: '標記價 markPx，ΔOI 的美元換算與突破判定都用它' },
    { k: 'chg', t: '24h', a: 'ta-r', tip: '標記價相對前日價（prevDayPx）的 24 小時漲跌' },
    { k: 'vol', t: '成交額', a: 'ta-r', tip: '24 小時名目成交額（dayNtlVlm）' },
    { k: 'oiu', t: 'OI（美元）', a: 'ta-r', tip: '未平倉美元名目 ＝ openInterest × markPx。刻意用美元名目，才不會被價格上漲把 OI 撐大' },
    { k: 'd5', t: 'ΔOI 5m', a: 'ta-r', tip: '5 分鐘的美元名目 OI 變化率' },
    { k: 'd1h', t: 'ΔOI 1h', a: 'ta-r', tip: '1 小時的美元名目 OI 變化率 —— 四象限與規則 1／5 都用這個窗口' },
    { k: 'd4h', t: 'ΔOI 4h', a: 'ta-r', tip: '4 小時的美元名目 OI 變化率' },
    { k: 'fd', t: '資費（百分位）', a: 'ta-r', tip: '資金費率（每小時）＋ 現值在近 24 小時樣本中的百分位。正＝多方付錢給空方（多頭擁擠），負＝空方付錢（空頭擁擠）；百分位 ≥95% 或 ≤5% 才算「極端」，不寫死絕對數值' },
    { k: 'quad', t: '象限', a: 'ta-l', tip: 'OI 變化 × 價格變化：新多進場／新空進場／空頭回補／去槓桿（雜訊範圍內歸為盤整）' },
    { k: 'small', t: '小幣', a: 'ta-c', tip: '小幣 ＝ 24h 成交額 $100K ~ $50M' }
  ];

  function renderHead() {
    const tr = $('#cwHead'); if (!tr) return;
    let h = '';
    for (const c of COLS) {
      const on = ui.sort && ui.sort.k === c.k;
      h += '<th class="' + c.a + (on ? ' on' : '') + '" data-k="' + c.k + '" title="' + esc(c.tip) + '">' + esc(c.t) +
        (on ? '<span class="ar">' + (ui.sort.dir < 0 ? '▼' : '▲') + '</span>' : '') + '</th>';
    }
    tr.innerHTML = h;
  }

  function renderTable() {
    const body = $('#cwBody'); if (!body) return;
    const rows = ui.list;
    let h = '';
    for (const a of rows) {
      h += '<tr data-c="' + esc(a.coin) + '" title="' + esc(a.evid) + '">' +
        '<td class="ta-l"><b>' + esc(a.coin) + '</b>' + (a.small ? '<i class="cw-small">小</i>' : '') + '</td>' +
        '<td class="ta-r">' + U.px(a.px) + '</td>' +
        '<td class="ta-r ' + cls(a.chg === null ? null : { v: a.chg }) + '">' + (a.chg === null ? '—' : U.pct(a.chg, 2)) + '</td>' +
        '<td class="ta-r">$' + U.money(a.vol) + '</td>' +
        '<td class="ta-r">' + (a.oiu === null ? '—' : '$' + U.money(a.oiu)) + '</td>' +
        '<td class="ta-r ' + cls(a.d5) + '">' + pctCell(a.d5) + dbar(a.d5 ? a.d5.v : null, 10) + '</td>' +
        '<td class="ta-r ' + cls(a.d1h) + '">' + pctCell(a.d1h) + dbar(a.d1h ? a.d1h.v : null, 20) + '</td>' +
        '<td class="ta-r ' + cls(a.d4h) + '">' + pctCell(a.d4h) + dbar(a.d4h ? a.d4h.v : null, 40) + '</td>' +
        '<td class="ta-r">' + fundCell(a) + '</td>' +
        '<td class="ta-l">' + quadChip(a.quad) + '</td>' +
        '<td class="ta-c">' + (a.small ? '<span class="cw-small">小</span>' : '<span class="mini">—</span>') + '</td>' +
        '</tr>';
    }
    body.innerHTML = h || '<tr><td colspan="' + COLS.length + '" class="empty">沒有符合目前條件的幣種</td></tr>';
  }

  function renderKpi() {
    const a = C.meta();
    const list = ui.list;
    let sumOi = 0, nOi = 0, crowd = null, crowdScore = -1;
    for (const x of list) {
      if (x.d1h && x.oiu !== null) { sumOi += (x.oiu - (x.oiuPrev || 0)); nOi++; }
      if (x.fp && x.op) {
        /* 最擁擠＝資費讀數對這檔幣來說越極端、且 OI 越靠高位；非極端的只給一半權重 */
        const sc = Math.abs(x.fp.v - 50) * (x.op.v / 100) * (x.fp.extreme ? 1 : 0.5);
        if (sc > crowdScore) { crowdScore = sc; crowd = x; }
      }
    }
    U.text('#cwKCoins', String(list.length));
    const ko = $('#cwKOi');
    if (ko) {
      ko.textContent = nOi ? ((sumOi >= 0 ? '+' : '−') + '$' + U.money(Math.abs(sumOi))) : '—';
      ko.className = nOi ? (sumOi >= 0 ? 'up' : 'down') : '';
      ko.title = nOi ? ('Σ（現值 OI − 1 小時前 OI），共 ' + nOi + ' 檔有可比較的 1 小時窗口') : '還沒有可比較的 1 小時窗口';
    }
    U.text('#cwKOiSub', nOi ? ('Σ ΔOI(1h)，' + nOi + ' 檔可比') : 'Σ ΔOI(1h) 需要 1 小時資料');
    U.text('#cwKCrowd', crowd ? crowd.coin : '—');
    U.text('#cwKCrowdSub', crowd ? ('資費百分位 ' + crowd.fp.v.toFixed(0) + '% · OI 百分位 ' + crowd.op.v.toFixed(0) + '%') :
      '需要 24h 樣本才算得出來');
    const upd = $('#cwKUpd');
    if (upd) upd.textContent = st.lastOk ? U.time(st.lastOk) : '—';
    const everySec = (d.hidden ? HIDDEN_MS : POLL_MS) / 1000;
    U.text('#cwKUpdSub', st.lastOk
      ? ('每 ' + everySec + ' 秒更新一次' + (d.hidden ? '（分頁在背景，降頻不停更）' : ''))
      : '尚未取得資料');

    /* 「已累積多久」必須誠實寫出來：逐字說明歷史有幾格、區間多長、本頁累積多久 */
    const hist = !a.histOk
      ? ('歷史：尚無 data/oi 檔案' + (a.histErr ? '（' + a.histErr + '）' : ''))
      : (a.histPoints >= 2
        ? ('歷史 ' + fmtMin(a.histSpanMin) + '（' + a.histPoints + ' 個 15 分時間點）')
        : ('歷史僅 ' + a.histPoints + ' 個 15 分時間點（尚在累積）'));
    const nD1 = list.filter(x => x.d1h).length, nQ = list.filter(x => x.qw).length;
    U.text('#cwWatch', 'ΔOI 觀測：' + hist + ' ＋ 本次開頁即時 ' + fmtMin(a.liveMin) +
      ' ｜ 1 小時窗口 ' + nD1 + ' 檔、四象限可判 ' + nQ + ' 檔');
    U.text('#cwMeta', hist + ' · 本次開頁 +' + fmtMin(a.liveMin) +
      (nQ > nD1 ? '（四象限暫以短窗判定）' : ''));
  }

  function fmtMin(m) {
    if (!m || m < 1) return (m < 1 ? '不到 1 分鐘' : '0 分鐘');
    if (m < 90) return m.toFixed(0) + ' 分鐘';
    return (m / 60).toFixed(1) + ' 小時';
  }

  function renderFoot(extra) {
    const a = C.meta();
    const nc = ui.list.filter(x => x.sig.length).length;
    const el = $('#cwFoot');
    if (!el) return;
    const wq = ui.list.filter(x => x.qw);
    const full1h = wq.filter(x => !x.qw.short).length;
    const longest = wq.reduce((m, x) => Math.max(m, x.qw.ms), 0);
    const tag = longest >= 3600e3 ? '1 小時' : (longest ? (longest / 60000) + ' 分鐘' : '—');
    el.innerHTML =
      '<span>規則：① ΔOI(1h) ≥ +' + OI_SURGE + '% 且突破近 ' + (BAR_MS / 3600e3) + ' 小時高低 ② 資費百分位極端 ＋ OI 近 24h 高位 ＋ 價格已突破 ③ 資費百分位 ≥' + FUND_HI + '% 或 ≤' + FUND_LO +
      '% ＋ OI 高 → 反向 ④ ΔOI(24h) ≤ ' + DELEV + '% ＋ 急跌 ⑤ 突破高低但 ΔOI 為負 → 禁止追價</span>' +
      '<span>四象限窗口：' + (wq.length
        ? (full1h ? '已用完整 1 小時（' + full1h + ' 檔）' : '目前以短窗暫代（最長 ' + tag + '）：1 小時窗口會隨本頁開啟時間與 data/oi 累積自動升級')
        : '尚無可用窗口') + '</span>' +
      '<span>訊號 ' + nc + ' / ' + ui.list.length + ' 檔 · 請求 ' + C.net.polls + ' 次、失敗 ' + C.net.fails + ' 次' + extra + '</span>' +
      '<span>歷史由 GitHub Actions 每 15 分鐘蒐集，累積幾週後才有回測價值；OI 一律為美元名目（openInterest × markPx）</span>';
  }

  /* ── 篩選、搜尋、排序 ───────────────────────────────── */
  function filterList(rows) {
    const q = (ui.q || '').toUpperCase();
    return rows.filter(a => {
      if (ui.filter === 'small' && !a.small) return false;
      if (ui.filter === 'active' && !(a.vol >= ACTIVE_MIN)) return false;
      if (ui.filter === 'sig' && !a.sig.length) return false;
      if (q && a.coin.toUpperCase().indexOf(q) < 0) return false;
      return true;
    });
  }

  /* 排序鍵：一律回傳可以直接比大小的值；缺值用 -Infinity 沉到底部，不假裝是 0 */
  function sortVal(a, k) {
    switch (k) {
      case 'coin': return a.coin;
      case 'px': return isFinite(a.px) ? a.px : -Infinity;
      case 'chg': return a.chg === null ? -Infinity : a.chg;
      case 'vol': return a.vol === null ? -Infinity : a.vol;
      case 'oiu': return a.oiu === null ? -Infinity : a.oiu;
      case 'd5': return a.d5 ? a.d5.v : -Infinity;
      case 'd1h': return a.d1h ? a.d1h.v : -Infinity;
      case 'd4h': return a.d4h ? a.d4h.v : -Infinity;
      case 'fd': return a.q.fd === null ? -Infinity : a.q.fd;
      case 'fp': return a.fp ? a.fp.v : -Infinity;
      case 'quad': return a.quad.t;
      case 'small': return a.small ? 1 : 0;
      default: return a.strength;
    }
  }

  function sortList(rows) {
    if (!ui.sort) return rows;                 // 預設：訊號強度（C.scanAll 已經排好）
    const k = ui.sort.k, dir = ui.sort.dir < 0 ? -1 : 1;
    const arr = rows.slice();
    arr.sort((x, y) => {
      const a = sortVal(x, k), b = sortVal(y, k);
      if (typeof a === 'string' || typeof b === 'string') {
        return dir * String(a).localeCompare(String(b));
      }
      if (a === b) return (y.strength - x.strength) || String(x.coin).localeCompare(String(y.coin));
      return dir * (a < b ? -1 : 1);
    });
    return arr;
  }

  C.setFilter = function (f) { ui.filter = f || 'all'; rebuildView(); paint(); };
  C.setQuery = function (q) { ui.q = q || ''; rebuildView(); paint(); };
  C.toggleSort = function (k) {
    if (!k) return;
    if (ui.sort && ui.sort.k === k) ui.sort.dir = -ui.sort.dir;
    else ui.sort = { k: k, dir: (k === 'coin' || k === 'quad') ? 1 : -1 };   // 數字欄預設由大到小
    rebuildView(); paint();
  };

  function rebuildView() { ui.list = sortList(filterList(ui.rows)); }

  function paint() {
    U.text('#cwCount', String(ui.list.length));
    renderHead();
    renderKpi();
    renderCands();
    renderTable();
    renderFoot();
    ui.lastRender = Date.now();
  }

  function render() {
    if (!$('#cwPanel')) return;
    ui.rows = C.scanAll();
    rebuildView();
    paint();
  }
  C.render = render;

  /* ── 依據文字：點候選列或表格列就展開，把每個數字的來源寫清楚 ──── */
  function fmtWindow(c, label) {
    if (!c) return '<b>' + label + '</b> <span class="k">—（窗口資料不足 75%，不給值）</span>';
    return '<b>' + label + ' ' + U.pct(c.v, 2) + '</b>' +
      '<span class="k">（實際區間 ' + c.mins.toFixed(0) + ' 分、' + c.n + ' 個觀測點，' +
      U.usd(c.a) + ' → ' + U.usd(c.b) + '）</span>';
  }

  function showEvid(coin) {
    const box = $('#cwEvid'); if (!box) return;
    if (ui.evid === coin) { ui.evid = null; box.hidden = true; return; }
    const a = ui.rows.filter(x => x.coin === coin)[0];
    if (!a) return;
    ui.evid = coin;
    const rows = [];
    rows.push(fmtWindow(a.d5, 'ΔOI 5m'));
    rows.push(fmtWindow(a.d1h, 'ΔOI 1h'));
    rows.push(fmtWindow(a.d4h, 'ΔOI 4h'));
    rows.push(fmtWindow(a.d24h, 'ΔOI 24h'));
    rows.push('<b>OI 美元名目</b> <span class="k">' + (a.oiu === null ? '—' : U.usd(a.oiu)) + '</span>' +
      (a.op ? '<span class="k"> · 近 24h 百分位 ' + a.op.v.toFixed(0) + '%（樣本 ' + a.op.n + '、涵蓋 ' + a.op.spanH.toFixed(1) + ' 小時）</span>'
        : '<span class="k"> · 近 24h 樣本不足（需 ≥' + MIN_SAMPLES + ' 個），不給百分位</span>'));
    rows.push('<b>資金費率</b> <span class="k">' + (a.q.fd === null ? '—' : (a.q.fd * 100).toFixed(5) + '%/hr') + '</span>' +
      (a.fp ? '<span class="k"> · ' + (a.fp.longPays ? '多方付錢（多頭擁擠）' : '空方付錢（空頭擁擠）') +
        ' · 近 24h 百分位 ' + a.fp.v.toFixed(0) + '%' + (a.fp.extreme ? '（極端）' : '（未達極端門檻 ' + FUND_HI + '%／' + FUND_LO + '%）') +
        '（樣本 ' + a.fp.n + '／相異值 ' + a.fp.nd + '、涵蓋 ' + a.fp.spanH.toFixed(1) + ' 小時）</span>'
        : '<span class="k"> · 近 24h 樣本不足 ' + MIN_SAMPLES + ' 個或相異值不足 ' + FUND_DISTINCT + ' 個，不給百分位</span>'));
    rows.push('<b>價格</b> <span class="k">標記價 ' + U.px(a.px) + ' · 24h ' + (a.chg === null ? '—' : U.pct(a.chg, 2)) +
      (a.p1h ? ' · 1 小時 ' + U.pct(a.p1h.v, 2) : '') + '</span>');
    rows.push('<b>突破基準</b> <span class="k">' + (a.br
      ? ('近 ' + a.br.hours.toFixed(1) + ' 小時 高 ' + U.px(a.br.hi) + ' / 低 ' + U.px(a.br.lo) + '（最近 15 分不列入基準）')
      : '樣本不足 ' + MIN_SAMPLES + ' 個，不做突破判定') + '</span>');
    rows.push('<b>四象限</b> <span class="k">' + a.quad.t + ' —— ' + a.quad.note + '</span>');
    if (a.sig.length) {
      for (const s of a.sig) rows.push('<b>訊號 · ' + esc(s.name) + '</b> <span class="k">' + esc(s.why) + '</span>');
    } else {
      rows.push('<b>訊號</b> <span class="k">目前不符合五條規則中的任何一條（OI 暴增需 ΔOI(1h) ≥ +' + OI_SURGE +
        '%；資費極端需百分位 ≥' + FUND_HI + '% 或 ≤' + FUND_LO + '% 且 OI 在近 24h 高位）</span>');
    }
    box.innerHTML = '<div><b>' + esc(coin) + '</b> <span class="k">· 訊號強度 ' + a.strength +
      ' · 24h 成交額 $' + U.money(a.vol) + (a.small ? ' · 小幣' : '') + '</span></div>' +
      rows.map(r => '<div>' + r + '</div>').join('');
    box.hidden = false;
  }

  /* ── 事件綁定（只有行情總覽有這些節點）───────────────── */
  function wire() {
    const panel = $('#cwPanel'); if (!panel || panel.__cwWired) return;
    panel.__cwWired = true;

    panel.addEventListener('click', e => {
      const head = e.target.closest ? e.target.closest('th[data-k]') : null;
      if (head) { C.toggleSort(head.getAttribute('data-k')); return; }
      const row = e.target.closest ? e.target.closest('.cw-c, tbody tr[data-c]') : null;
      if (row) showEvid(row.getAttribute('data-c'));
    });
    panel.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest ? e.target.closest('.cw-c') : null;
      if (row) { e.preventDefault(); showEvid(row.getAttribute('data-c')); }
    });

    const seg = $('#cwFilter');
    if (seg) seg.addEventListener('click', e => {
      const b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      Array.prototype.forEach.call(seg.children, x => x.classList.toggle('on', x === b));
      C.setFilter(b.getAttribute('data-f'));
    });

    const s = $('#cwSearch');
    if (s) s.addEventListener('input', U.debounce(() => C.setQuery(s.value.trim()), 160));
  }

  C.wire = wire;

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

  /* ══════════════════════════════════════════════════════
     啟動：只有行情總覽有 #cwPanel，其他頁面不占用任何請求
     ══════════════════════════════════════════════════════ */
  S.ready(function () {
    if (!d.getElementById('cwPanel')) return;
    function redraw() {
      try { render(); } catch (e) { S.errors.push('crowd render: ' + (e && e.message)); }
    }
    S.on('crowd-update', redraw);
    wire();                       // 篩選鈕／搜尋／表頭排序／點列看依據文字
    /* 資料每 20 秒更新一次就重畫；再補一個每 20 秒的保底重畫，
       讓「已累積 X 分鐘」「最新更新時間」這種會隨時間變的文字不會停住。 */
    setInterval(function () { if (!d.hidden && Date.now() - ui.lastRender > 20000) redraw(); }, 20000);
    C.start().then(redraw);
  });
})(window, document);
