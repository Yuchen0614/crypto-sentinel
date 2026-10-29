/* api.js — 交易所公開 REST 資料層（無需金鑰），含容錯與快取 */
'use strict';
(function (w) {
  const S = w.SENTINEL, U = S.util, api = S.api = {};

  const B = {
    SPOT: 'https://api.binance.com',
    FAPI: 'https://fapi.binance.com',
    BYBIT: 'https://api.bybit.com',
    OKX: 'https://www.okx.com',
    CG: 'https://api.coingecko.com/api/v3',
    FNG: 'https://api.alternative.me',
    GT: 'https://api.geckoterminal.com/api/v2',        // 鏈上 DEX 資料（免費、無金鑰）
    HL: 'https://api.hyperliquid.xyz/info'             // 鏈上永續合約錢包持倉（免費、無金鑰）
  };
  api.health = { spot: 'wait', futures: 'wait', chain: 'wait', lastOk: 0, failures: 0 };

  /* ── 底層抓取 ─────────────────────────────────────── */
  async function jget(url, timeout) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), timeout || 12000);
    try {
      const r = await fetch(url, { signal: ac.signal, cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const t = await r.text();
      return JSON.parse(t);
    } finally { clearTimeout(to); }
  }
  api.jget = jget;

  const cache = new Map();
  /* 快取：記憶體 Map + sessionStorage 兩層。
   為什麼要 sessionStorage：這是多頁靜態站，換頁＝整頁重載，記憶體快取一定消失，
   所以每次點回行情總覽都要重抓一次全市場報價（24hr tickers 是最大的一包），
   使用者看到的就是「每次都在轉圈」。把高 TTL、體積可控的結果寫進 sessionStorage，
   換頁回來就能先沿用同一份資料立即出圖，背景再照原本的 TTL 決定要不要更新。
   只持久化 ttl >= 20 秒且序列化後 <= 250KB 的項目（每幣 K 線這種大包不寫），
   並限制最多 60 筆、超過就砍最舊的，避免把 5MB 配額塞爆；任何存取失敗都靜默回退。 */
  const SS_PREFIX = 'cs.cache.';
  function ssRead(key) {
    try {
      const raw = sessionStorage.getItem(SS_PREFIX + key);
      if (!raw) return null;
      const o = JSON.parse(raw);
      return (o && typeof o.t === 'number') ? o : null;
    } catch (e) { return null; }
  }
  /* 只有「能被 JSON 完整還原」的值才寫進 sessionStorage。
     踩過的坑：bybitLin 是 Set，JSON.stringify 之後變 {}，讀回來呼叫 .has() 就炸
     （promise: lin.has is not a function）。Map／Set／class 實例一律不寫。 */
  function ssSafe(v) {
    if (v === null) return true;
    const t = typeof v;
    if (t === 'number' || t === 'string' || t === 'boolean') return true;
    if (Array.isArray(v)) return true;
    if (t === 'object' && Object.getPrototypeOf(v) === Object.prototype) return true;
    return false;
  }
  function ssWrite(key, entry) {
    try {
      if (!ssSafe(entry.v)) return;                    // Set／Map 這種存了會壞
      const raw = JSON.stringify(entry);
      if (raw.length > 400000) return;                 // 太大不寫（例如整批 K 線）
      const idx = JSON.parse(sessionStorage.getItem(SS_PREFIX + '__idx') || '[]');
      sessionStorage.setItem(SS_PREFIX + key, raw);
      const next = idx.filter(k => k !== key).concat(key).slice(-60);
      sessionStorage.setItem(SS_PREFIX + '__idx', JSON.stringify(next));
      const drop = idx.filter(k => next.indexOf(k) < 0);
      drop.forEach(k => { try { sessionStorage.removeItem(SS_PREFIX + k); } catch (e) { } });
    } catch (e) { /* 配額滿或無 sessionStorage：靜默略過 */ }
  }
  async function cached(key, ttl, fn) {
    let e = cache.get(key);
    if (!e && ttl >= 20e3) { const d = ssRead(key); if (d && ssSafe(d.v)) { e = d; cache.set(key, d); } }
    if (e && Date.now() - e.t < ttl) return e.v;
    const v = await fn();
    if (v !== null && v !== undefined) {
      const entry = { t: Date.now(), v };
      cache.set(key, entry);
      if (ttl >= 20e3) ssWrite(key, entry);
    } else if (e) return e.v;            // 失敗時沿用舊資料（含跨頁帶回來的）
    return v;
  }
  api.cacheKeys = () => Array.from(cache.keys());
  api.cached = cached;

  /* ── 幣種宇宙（全市場）────────────────────────────── */
  const STABLE = /^(USDC|FDUSD|TUSD|BUSD|DAI|USDP|EURI|EUR|AEUR|USD1|XUSD|USDE|PYUSD|USDJ|SUSD|USTC|GBP|TRY|BRL|ARS|JPY|ZAR|PLN|RON|CZK|MXN|COP|UAH|NGN|IDRT|BIDR|VAI|BVND|PAXG?)$/;
  const LEV = /(UP|DOWN|BULL|BEAR)$/;

  api.universe = async function () {
    // 主：Binance 現貨
    try {
      const [info, tickers] = await Promise.all([
        cached('exinfo', 6 * 3600e3, () => jget(B.SPOT + '/api/v3/exchangeInfo')),
        cached('tk24', 60e3, () => jget(B.SPOT + '/api/v3/ticker/24hr', 15000))
      ]);
      const ok = new Map();
      (info.symbols || []).forEach(s => {
        if (s.status !== 'TRADING' || s.quoteAsset !== 'USDT' || s.isSpotTradingAllowed === false) return;
        const pf = (s.filters || []).find(f => f.filterType === 'PRICE_FILTER');
        const tick = pf ? U.num(pf.tickSize) : NaN;
        const dec = isFinite(tick) && tick > 0 ? Math.max(0, Math.round(-Math.log10(tick))) : 2;
        ok.set(s.symbol, { tick, dec });
      });
      const list = [];
      for (const t of tickers) {
        if (!ok.has(t.symbol)) continue;
        const meta = ok.get(t.symbol);
        const base = t.symbol.slice(0, -4);
        if (STABLE.test(base) || LEV.test(base)) continue;
        const qv = U.num(t.quoteVolume);
        if (!isFinite(qv) || qv < 200000) continue;
        list.push({
          symbol: t.symbol, base, quote: 'USDT',
          price: U.num(t.lastPrice), open: U.num(t.openPrice),
          changePct: U.num(t.priceChangePercent), change: U.num(t.priceChange),
          high: U.num(t.highPrice), low: U.num(t.lowPrice),
          volume: U.num(t.volume), quoteVolume: qv,
          trades: U.num(t.count), vwap: U.num(t.weightedAvgPrice),
          tick: meta.tick, dec: meta.dec
        });
      }
      if (!list.length) throw new Error('binance empty');
      list.sort((a, b) => b.quoteVolume - a.quoteVolume);
      api.health.spot = 'ok'; api.health.lastOk = Date.now(); api.health.failures = 0;
      api.source = 'Binance 現貨';
      return list.slice(0, 420).map((x, i) => (x.rank = i + 1, x));
    } catch (e) {
      S.errors.push('universe/binance: ' + e.message);
    }
    // 備：Bybit
    try {
      const d = await cached('bybitTk', 60e3, () => jget(B.BYBIT + '/v5/market/tickers?category=spot', 15000));
      const list = (d.result.list || []).filter(t => /USDT$/.test(t.symbol)).map(t => {
        const base = t.symbol.replace(/USDT$/, '');
        return {
          symbol: base + 'USDT', base, quote: 'USDT', price: U.num(t.lastPrice),
          open: U.num(t.prevPrice24h), changePct: U.num(t.price24hPcnt) * 100,
          change: U.num(t.lastPrice) - U.num(t.prevPrice24h),
          high: U.num(t.highPrice24h), low: U.num(t.lowPrice24h),
          volume: U.num(t.volume24h), quoteVolume: U.num(t.turnover24h),
          trades: NaN, vwap: U.num(t.turnover24h) / Math.max(1e-12, U.num(t.volume24h))
        };
      }).filter(t => !STABLE.test(t.base) && !LEV.test(t.base) && t.quoteVolume > 200000);
      list.sort((a, b) => b.quoteVolume - a.quoteVolume);
      api.health.spot = 'alt'; api.source = 'Bybit 現貨';
      return list.slice(0, 420).map((x, i) => (x.rank = i + 1, x));
    } catch (e2) {
      S.errors.push('universe/bybit: ' + e2.message);
      api.health.spot = 'off'; api.health.failures++;
      return null;
    }
  };

  /* ── 合約市場元資料（資金費率、標記價）───────────── */
  api.futures = async function () {
    return cached('futures', 30e3, async () => {
      try {
        const d = await jget(B.FAPI + '/fapi/v1/premiumIndex', 12000);
        const map = {};
        (Array.isArray(d) ? d : [d]).forEach(x => {
          map[x.symbol] = {
            funding: U.num(x.lastFundingRate), nextFunding: x.nextFundingTime,
            mark: U.num(x.markPrice), index: U.num(x.indexPrice)
          };
        });
        api.health.futures = 'ok';
        return map;
      } catch (e) {
        S.errors.push('futures: ' + e.message);
        api.health.futures = 'off';
        return null;
      }
    });
  };

  /* ── K 線 ─────────────────────────────────────────── */
  api.klines = async function (symbol, interval, limit) {
    try {
      const d = await jget(`${B.SPOT}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit || 300}`, 12000);
      return d.map(k => ({
        t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4],
        v: +k[5], q: +k[7], n: +k[8], tb: +k[9], tq: +k[10],
        delta: 2 * (+k[10]) - (+k[7])   // 主動買量 - 主動賣量（金額）
      }));
    } catch (e) {
      S.errors.push('klines: ' + e.message);
      try {
        /* 備援源（Bybit）的週期代碼；3 天以上沒有完全對應值，取最接近的日／週／月 */
        const iv = {
          '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30',
          '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720',
          '1d': 'D', '3d': 'D', '1w': 'W', '1M': 'M'
        }[interval] || '5';
        const d = await jget(`${B.BYBIT}/v5/market/kline?category=spot&symbol=${symbol}&interval=${iv}&limit=${limit || 300}`, 12000);
        return (d.result.list || []).map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], q: +k[6], n: 0, tb: 0, tq: 0, delta: 0 })).reverse();
      } catch (e2) { return null; }
    }
  };

  /* ── 訂單簿深度 ───────────────────────────────────── */
  api.depth = async function (symbol, limit) {
    try {
      const d = await jget(`${B.SPOT}/api/v3/depth?symbol=${symbol}&limit=${limit || 1000}`, 10000);
      return {
        bids: d.bids.map(x => [ +x[0], +x[1] ]),
        asks: d.asks.map(x => [ +x[0], +x[1] ]),
        ts: Date.now()
      };
    } catch (e) {
      try {
        const d = await jget(`${B.BYBIT}/v5/market/orderbook?category=spot&symbol=${symbol}&limit=50`, 10000);
        return { bids: d.result.b.map(x => [ +x[0], +x[1] ]), asks: d.result.a.map(x => [ +x[0], +x[1] ]), ts: Date.now() };
      } catch (e2) { return null; }
    }
  };

  /* ── 持倉 / 大戶部位（Binance 合約公開統計）────────── */
  async function dataEnd(path, symbol, period, limit) {
    const d = await jget(`${B.FAPI}/futures/data/${path}?symbol=${symbol}&period=${period || '5m'}&limit=${limit || 30}`, 12000);
    return (d || []).map(x => ({ t: +x.timestamp, v: U.num(x.sumLongShortRatio !== undefined ? x.sumLongShortRatio : x.longShortRatio), long: U.num(x.longAccount !== undefined ? x.longAccount : x.sumLongAccount), short: U.num(x.shortAccount !== undefined ? x.shortAccount : x.sumShortAccount), buy: U.num(x.buyVol), sell: U.num(x.sellVol), oi: U.num(x.sumOpenInterest), oiVal: U.num(x.sumOpenInterestValue) }));
  }

  api.positioning = async function (symbol) {
    return cached('pos:' + symbol, 55e3, async () => {
      const out = { symbol, ts: Date.now(), ok: false };
      const tasks = [
        dataEnd('topLongShortPositionRatio', symbol).then(v => out.topPosition = v).catch(() => out.topPosition = null),
        dataEnd('topLongShortAccountRatio', symbol).then(v => out.topAccount = v).catch(() => out.topAccount = null),
        dataEnd('globalLongShortAccountRatio', symbol).then(v => out.globalAccount = v).catch(() => out.globalAccount = null),
        dataEnd('takerlongshortRatio', symbol).then(v => out.taker = v).catch(() => out.taker = null),
        jget(`${B.FAPI}/fapi/v1/openInterest?symbol=${symbol}`, 10000).then(v => out.oiNow = U.num(v.openInterest)).catch(() => out.oiNow = NaN)
      ];
      try { await Promise.all(tasks) } catch (e) { S.errors.push('positioning: ' + e.message) }
      out.ok = !!(out.topPosition || out.topAccount || out.taker);
      return out;
    });
  };

  api.oiHist = async function (symbol, period, limit) {
    try {
      const d = await jget(`${B.FAPI}/futures/data/openInterestHist?symbol=${symbol}&period=${period || '5m'}&limit=${limit || 48}`, 12000);
      return (d || []).map(x => ({ t: +x.timestamp, oi: U.num(x.sumOpenInterest), val: U.num(x.sumOpenInterestValue) }));
    } catch (e) { return null; }
  };

  /* ── CoinGecko：市值排名 + 全球數據 ───────────────── */
  api.global = async function () {
    return cached('cg', 300e3, async () => {
      try {
        const d = await jget(B.CG + '/global', 12000);
        const g = d.data || {};
        return {
          mcap: U.num(g.total_market_cap && g.total_market_cap.usd),
          vol: U.num(g.total_volume && g.total_volume.usd),
          btcDom: U.num(g.market_cap_percentage && g.market_cap_percentage.btc),
          ethDom: U.num(g.market_cap_percentage && g.market_cap_percentage.eth),
          chg: U.num(g.market_cap_change_percentage_24h_usd),
          coins: U.num(g.active_cryptocurrencies)
        };
      } catch (e) { S.errors.push('cg/global: ' + e.message); return null; }
    });
  };

  api.mcapMap = async function () {
    return cached('cgm', 600e3, async () => {
      try {
        const d = await jget(B.CG + '/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false', 15000);
        const m = {};
        (d || []).forEach((c, i) => { m[(c.symbol || '').toUpperCase() + 'USDT'] = { rank: i + 1, mcap: c.market_cap, name: c.name, cgRank: c.market_cap_rank }; });
        return m;
      } catch (e) { S.errors.push('cg/mcap: ' + e.message); return null; }
    });
  };

  /* ── 恐懼貪婪指數 ─────────────────────────────────── */
  api.fng = async function () {
    return cached('fng', 900e3, async () => {
      try {
        const d = await jget(B.FNG + '/fng/?limit=2', 10000);
        const a = (d.data || []).map(x => ({ v: +x.value, label: x.value_classification, t: +x.timestamp * 1000 }));
        return a.length ? { now: a[0], prev: a[1] || null } : null;
      } catch (e) { return null; }
    });
  };

  /* ── Bybit 線性合約標的清單（用於訂閱清算串流）──────── */
  api.bybitLinear = async function () {
    return cached('bybitLin', 6 * 3600e3, async () => {
      try {
        const set = new Set();
        let cursor = '';
        for (let page = 0; page < 4; page++) {
          const d = await jget(`${B.BYBIT}/v5/market/instruments-info?category=linear&limit=1000${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`, 15000);
          const list = (d.result && d.result.list) || [];
          list.forEach(x => set.add(x.symbol));
          cursor = (d.result && d.result.nextPageCursor) || '';
          if (!cursor || list.length < 1000) break;
        }
        return set.size ? set : null;
      } catch (e) { S.errors.push('bybit instruments: ' + e.message); return null; }
    });
  };

  /* 內建備援大戶名單（24 筆，取自 2026-10-21）——用 file:// 直接開啟 index.html 時，
     瀏覽器會禁止 fetch 讀取 data/whales.json，屆時改用這份名單，讓鏈上持倉仍可運作。 */
  const HL_FALLBACK = {
    generated_at: "2026-10-21T05:15:09Z",
    source: "內建備援名單（2026-10-21 快照）",
    count: 24,
    wallets: [
      {addr:"0x5b5d51203a0f9079f8aeb098a6523a13f298c060",name:"",av:249083583,roi30:32.1,pnl30:63599017,why:"資金規模最大"},
      {addr:"0xb83de012dba672c76a7dbbbf3e459cb59d7d6e36",name:"",av:229392339,roi30:37.6,pnl30:61302895,why:"資金規模最大"},
      {addr:"0xfc667adba8d4837586078f4fdcdc29804337ca06",name:"",av:123864507,roi30:13.8,pnl30:15604188,why:"資金規模最大"},
      {addr:"0x87f9cd15f5050a9283b8896300f7c8cf69ece2cf",name:"",av:116783350,roi30:12.4,pnl30:13904377,why:"資金規模最大"},
      {addr:"0xecb63caa47c7c4e77f60f1ce858cf28dc2b82b00",name:"",av:96352455,roi30:7.4,pnl30:9329687,why:"資金規模最大"},
      {addr:"0xe867fbdad3291530e41530301ecb77693850c78e",name:"",av:87788595,roi30:9.0,pnl30:126361,why:"資金規模最大"},
      {addr:"0x856c35038594767646266bc7fd68dc26480e910d",name:"",av:80369494,roi30:12.8,pnl30:6665422,why:"資金規模最大"},
      {addr:"0xf5d81a135f756ca16544e53c20fc20643ec3ad53",name:"",av:76821493,roi30:6.7,pnl30:4963461,why:"資金規模最大"},
      {addr:"0xbdfa4f4492dd7b7cf211209c4791af8d52bf5c50",name:"",av:76138391,roi30:-39.0,pnl30:-10575,why:"資金規模最大"},
      {addr:"0x03b9a189e2480d1e4c3007080b29f362282130fa",name:"",av:67518845,roi30:-0.1,pnl30:-5022,why:"資金規模最大"},
      {addr:"0xdd53c5297309130ab5fe5623dc905752e3342b13",name:"",av:61578825,roi30:13.6,pnl30:7363671,why:"資金規模最大"},
      {addr:"0x85ecf584f25db6f146718b86d493e33c5af72052",name:"",av:60625785,roi30:-1.4,pnl30:-1025359,why:"資金規模最大"},
      {addr:"0x8def9f50456c6c4e37fa5d3d57f108ed23992dae",name:"",av:58427904,roi30:12.2,pnl30:6391040,why:"資金規模最大"},
      {addr:"0x77375a8c9d13bf79afb2a87f1b0ac1dfd5f5bf66",name:"",av:48550938,roi30:40.5,pnl30:5509781,why:"資金規模最大"},
      {addr:"0x7fdafde5cfb5465924316eced2d3715494c517d1",name:"BobbyBigSize",av:46292693,roi30:16.5,pnl30:11828279,why:"資金規模最大"},
      {addr:"0x936cf4fb95c30ce83f658b5bbb247e4bb381bb0f",name:"",av:11630490,roi30:23.9,pnl30:10048076,why:"月獲利最高"},
      {addr:"0x024294c53a69c1e6b39810b3fac87385752fffa1",name:"",av:20548179,roi30:73.0,pnl30:8424543,why:"月獲利最高"},
      {addr:"0xd47587702a91731dc1089b5db0932cf820151a91",name:"",av:17871461,roi30:26.1,pnl30:7374265,why:"月獲利最高"},
      {addr:"0xf02d16a272a842f8bac1d9a9e773aba1933454c6",name:"",av:32226798,roi30:57.4,pnl30:7188233,why:"月獲利最高"},
      {addr:"0xfe7ce058edc7cfcde9ef8262ba51f8d4796ab7ae",name:"",av:14806236,roi30:16.9,pnl30:6994971,why:"月獲利最高"},
      {addr:"0xd487e26c62ed8c28ce3cc70b5791e501c2934982",name:"",av:1596343,roi30:434.6,pnl30:374498,why:"月報酬率最高"},
      {addr:"0x352deb23bebae8b4c57d0ae341d9c1951fd8425a",name:"",av:1165967,roi30:236.3,pnl30:148003,why:"月報酬率最高"},
      {addr:"0x46926d8fad4a36047a73ed7be1cec963c77fef87",name:"",av:1376910,roi30:227.7,pnl30:1004316,why:"月報酬率最高"},
      {addr:"0x77ee3604adbdefa66a817b3cf776412a6613a018",name:"",av:5718868,roi30:155.7,pnl30:3329881,why:"月獲利最高"}
    ]
  };

  /* ══════════ 鏈上資料（無金鑰公開端點）══════════════ */

  /* GeckoTerminal 免費層限制很嚴：實測連續約 6 次呼叫後連線會被直接丟棄（不是回 429），
     因此統一排隊、固定 2.5 秒間隔（≈24 次/分），並在失敗後整條佇列冷卻 45 秒。 */
  let gtChain = Promise.resolve(), gtLast = 0, gtDownUntil = 0, gtErrLogged = 0;
  api.gtStats = { calls: 0, fails: 0, cooling: false };
  function gtCall(path) {
    const run = async () => {
      const now = Date.now();
      if (now < gtDownUntil) { api.gtStats.cooling = true; return null; }
      api.gtStats.cooling = false;
      const wait = Math.max(0, 14000 - (Date.now() - gtLast));
      if (wait) await new Promise(r => setTimeout(r, wait));
      gtLast = Date.now();
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await fetch(B.GT + path, { headers: { Accept: 'application/json' } });
          if (r.status === 429) { gtDownUntil = Date.now() + 30000; return null; }
          if (!r.ok) throw new Error('HTTP ' + r.status);
          api.gtStats.calls++;
          return await r.json();
        } catch (e) {
          api.gtStats.fails++;
          if (attempt === 1) {
            gtDownUntil = Date.now() + 90000;                       // 整條佇列冷卻，避免被暫時封鎖
            if (Date.now() - gtErrLogged > 300000) { gtErrLogged = Date.now(); S.errors.push('gt throttled: ' + e.message); }
            return null;
          }
          await new Promise(x => setTimeout(x, 3000));
        }
      }
      return null;
    };
    const p = gtChain.then(run, run);
    gtChain = p.catch(() => { });
    return p;
  }

  /* 各鏈熱門池（含價格、24H 量、漲跌、買賣筆數）*/
  api.gtTrending = async function (net) {
    return cached('gt:' + net, 600e3, async () => {
      const d = await gtCall(`/networks/${net}/trending_pools?page=1`);
      if (!d || !d.data) return null;
      return d.data.map(p => {
        const a = p.attributes || {};
        const chg = (a.price_change_percentage || {});
        const vol = (a.volume_usd || {});
        const tx = (a.transactions || {}).h24 || {};
        return {
          chain: net, pool: a.address, id: p.id,
          name: a.name || '', dex: (p.relationships && p.relationships.dex && p.relationships.dex.data && p.relationships.dex.data.id) || '',
          priceUsd: U.num(a.base_token_price_usd), quoteUsd: U.num(a.quote_token_price_usd),
          fdv: U.num(a.fdv_usd), liq: U.num(a.reserve_in_usd), created: a.pool_created_at,
          vol24: U.num(vol.h24), vol1: U.num(vol.h1), vol5: U.num(vol.m5),
          chg5: U.num(chg.m5), chg1: U.num(chg.h1), chg24: U.num(chg.h24),
          buys: U.num(tx.buys), sells: U.num(tx.sells)
        };
      }).filter(p => p.pool && isFinite(p.priceUsd));
    });
  };

  /* 單一池的大額鏈上成交（含發起交易的錢包地址）*/
  api.gtTrades = async function (net, pool, minUsd) {
    const d = await gtCall(`/networks/${net}/pools/${pool}/trades?trade_volume_in_usd_greater_than=${minUsd || 50000}`);
    if (!d || !d.data) return null;
    return d.data.map(t => {
      const a = t.attributes || {};
      return {
        chain: net, pool, wallet: (a.tx_from_address || '').toLowerCase(),
        side: a.kind === 'buy' ? 'buy' : 'sell',
        usd: U.num(a.volume_in_usd), ts: Date.parse(a.block_timestamp) || Date.now(),
        priceUsd: U.num(a.price_from_in_usd), toUsd: U.num(a.price_to_in_usd),
        fromToken: (a.from_token_address || '').toLowerCase(), toToken: (a.to_token_address || '').toLowerCase(),
        fromAmt: U.num(a.from_token_amount), toAmt: U.num(a.to_token_amount),
        tx: a.tx_hash, anomalous: !!a.is_anomalous
      };
    }).filter(t => t.wallet && isFinite(t.usd));
  };

  /* Hyperliquid：大戶追蹤名單（repo 內由 GitHub Actions 每日更新的小檔案）*/
  api.hlSource = 'wait'; api.hlNote = '';
  api.hlWhales = async function () {
    // file:// 直接開啟時瀏覽器會禁止讀取本機檔案（fetch data/whales.json 必定失敗），
    // 因此先用內建備援名單，讓大戶持倉在雙擊開啟的情境也能運作。
    const isFile = (typeof location !== 'undefined' && location.protocol === 'file:');
    return cached('hlwhales', 3600e3, async () => {
      api.health.chain = 'ok';
      if (isFile) {
        api.hlSource = 'fallback';
        api.hlNote = '以 file:// 直接開啟，瀏覽器禁止讀取 data/whales.json';
        return HL_FALLBACK;
      }
      try {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), 12000);
        let d = null;
        try {
          const r = await fetch('data/whales.json', { cache: 'no-cache', signal: ac.signal });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          d = await r.json();
        } finally { clearTimeout(to); }
        if (!d || !d.wallets || !d.wallets.length) throw new Error('名單格式異常');
        api.hlSource = 'live'; api.hlNote = '';
        return d;
      } catch (e) {
        api.hlSource = 'fallback';
        api.hlNote = e.message;
        S.errors.push('hlWhales 改用內建備援名單: ' + e.message);
        return HL_FALLBACK;
      }
    });
  };

  /* Hyperliquid：單一錢包的即時持倉與保證金摘要 */
  /* 逐筆成交：dir（Open/Close Long｜Short）與 closedPnl 是「開倉平倉＋真實盈虧」的來源。
     注意 Hyperliquid 單次最多回 2000 筆，大戶會把單子切成上百筆小成交，
     所以呼叫端一律用「時間窗」控制回傳量（增量輪詢時只問最後幾分鐘）。 */
  api.hlFills = async function (addr, sinceMs) {
    const k = 'hlfills:' + addr + ':' + Math.floor((sinceMs || 0) / 60000);
    return cached(k, 20e3, async () => {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), 10000);
      try {
        const r = await fetch(B.HL, {
          method: 'POST', signal: ac.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'userFillsByTime', user: addr, startTime: Math.max(0, sinceMs || 0), aggregateByTime: true })
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json();
        return Array.isArray(d) ? d : [];
      } catch (e) {
        S.errors.push('hlFills: ' + e.message);
        return null;
      } finally { clearTimeout(to); }
    });
  };

  /* 全市場標記價（一次 24 KB）：用來算開倉中的未實現盈虧 */
  api.hlMids = async function () {
    return cached('hlmids', 4000, async () => {
      try {
        const r = await fetch(B.HL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'allMids' })
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json();
        return (d && typeof d === 'object') ? d : null;
      } catch (e) { S.errors.push('hlMids: ' + e.message); return null; }
    });
  };

  api.hlState = async function (addr) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 10000);
    try {
      const r = await fetch(B.HL, {
        method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'clearinghouseState', user: addr })
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      api.health.chain = 'ok';
      return d;
    } catch (e) {
      return null;
    } finally { clearTimeout(to); }
  };

  api.updated = Date.now();
})(window);
