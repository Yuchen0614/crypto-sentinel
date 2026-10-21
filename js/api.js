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
  async function cached(key, ttl, fn) {
    const e = cache.get(key);
    if (e && Date.now() - e.t < ttl) return e.v;
    const v = await fn();
    if (v !== null && v !== undefined) cache.set(key, { t: Date.now(), v });
    else if (e) return e.v;              // 失敗時沿用舊資料
    return v;
  }
  api.cached = cached;

  /* ── 幣種宇宙（全市場）────────────────────────────── */
  const STABLE = /^(USDC|FDUSD|TUSD|BUSD|DAI|USDP|EURI|EUR|AEUR|USD1|XUSD|USDE|PYUSD|USDJ|SUSD|USTC|GBP|TRY|BRL|ARS|JPY|ZAR|PLN|RON|CZK|MXN|COP|UAH|NGN|IDRT|BIDR|VAI|BVND|PAXG?)$/;
  const LEV = /(UP|DOWN|BULL|BEAR)$/;

  api.universe = async function () {
    // 主：Binance 現貨
    try {
      const [info, tickers] = await Promise.all([
        cached('exinfo', 6 * 3600e3, () => jget(B.SPOT + '/api/v3/exchangeInfo')),
        jget(B.SPOT + '/api/v3/ticker/24hr', 15000)
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
      const d = await jget(B.BYBIT + '/v5/market/tickers?category=spot', 15000);
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
        const iv = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240' }[interval] || '5';
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
  api.hlWhales = async function () {
    return cached('hlwhales', 3600e3, async () => {
      try {
        const r = await fetch('data/whales.json', { cache: 'no-cache' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json();
        if (!d || !d.wallets) throw new Error('bad payload');
        api.health.chain = 'ok';
        return d;
      } catch (e) {
        S.errors.push('hlWhales: ' + e.message);
        return null;
      }
    });
  };

  /* Hyperliquid：單一錢包的即時持倉與保證金摘要 */
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
