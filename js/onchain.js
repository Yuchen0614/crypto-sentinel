/* onchain.js — 鏈上聰明錢情報
   A. Hyperliquid 大戶錢包：即時持倉、倉位變化事件、全體多空彙總
   B. 多鏈 DEX 大額換幣：錢包級別的大額買賣、聰明錢錢包評分、協同買入偵測、雷達事件
*/
'use strict';
(function (w) {
  const S = w.SENTINEL, U = S.util;
  const OC = S.onchain = {};

  OC.CHAINS = [
    { id: 'eth', label: '以太坊', sym: 'ETH', ex: 'etherscan.io/address/' },
    { id: 'solana', label: 'Solana', sym: 'SOL', ex: 'solscan.io/account/' },
    { id: 'base', label: 'Base', sym: 'BASE', ex: 'basescan.org/address/' },
    { id: 'bsc', label: 'BNB', sym: 'BSC', ex: 'bscscan.com/address/' }
  ];
  OC.explorer = (chain, addr) => {
    const c = OC.CHAINS.find(x => x.id === chain) || OC.CHAINS[0];
    return 'https://' + c.ex + addr;
  };
  OC.chainLabel = id => (OC.CHAINS.find(x => x.id === id) || {}).label || id;
  OC.short = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '—';

  /* ══════════════ A. Hyperliquid 大戶錢包 ══════════════ */
  const HL = OC.hl = {
    wallets: [], listAt: 0, states: new Map(), agg: null, events: [], polled: 0, ok: 0, pollIdx: 0,
    setWallets(d) {
      if (!d || !d.wallets) return;
      this.wallets = d.wallets.map(x => Object.assign({}, x, { addr: String(x.addr).toLowerCase() }));
      this.listAt = Date.parse(d.generated_at) || Date.now();
      this.meta = d;
      S.emit('hl-wallets', this.wallets);
    },
    parse(state) {
      const out = { value: U.num(state && state.marginSummary && state.marginSummary.accountValue), withdrawable: U.num(state && state.withdrawable), pos: [] };
      ((state && state.assetPositions) || []).forEach(ap => {
        const p = ap.position || {}; if (!p.coin) return;
        const szi = U.num(p.szi), notional = U.num(p.positionValue);
        if (!isFinite(szi) || szi === 0) return;
        out.pos.push({
          coin: p.coin, szi, side: szi > 0 ? 'long' : 'short', notional: Math.abs(notional),
          entry: U.num(p.entryPx), liq: U.num(p.liquidationPx), upnl: U.num(p.unrealizedPnl),
          roe: U.num(p.returnOnEquity), margin: U.num(p.marginUsed),
          lev: p.leverage ? U.num(p.leverage.value) : NaN, levType: p.leverage ? p.leverage.type : ''
        });
      });
      return out;
    },
    /* 收到某錢包的最新持倉：與上次比對 → 產生倉位變化事件（這就是「鏈上錢包交易偵測」） */
    ingest(addr, state) {
      const now = Date.now(), cur = this.parse(state);
      const prev = this.states.get(addr);
      this.states.set(addr, Object.assign(cur, { ts: now }));
      this.polled++;
      if (state) this.ok++;
      const meta = this.wallets.find(x => x.addr === addr) || {};
      const name = meta.name || OC.short(addr);
      if (prev) {
        const pm = new Map(prev.pos.map(p => [p.coin, p]));
        cur.pos.forEach(p => {
          const q = pm.get(p.coin);
          if (!q) {
            this.push(addr, name, p.notional >= 100000 ? 'high' : 'mid', 'OPEN',
              `${p.side === 'long' ? '新開多單' : '新開空單'} ${p.coin}`,
              `規模 $${U.money(p.notional)} · 進場 ${U.px(p.entry)} · 槓桿 ${isFinite(p.lev) ? p.lev + '×' : '—'}`);
          } else {
            const d = p.szi - q.szi, dn = p.notional - q.notional;
            const flipped = (q.szi > 0) !== (p.szi > 0);
            const changed = Math.abs(d) / Math.max(1e-12, Math.abs(q.szi)) > 0.02;
            if (flipped) {
              this.push(addr, name, 'high', 'FLIP', `${p.coin} 由${q.side === 'long' ? '多' : '空'}翻${p.side === 'long' ? '多' : '空'}`,
                `持倉 ${U.qty(Math.abs(q.szi))} → ${U.qty(Math.abs(p.szi))} ${p.coin}`);
            } else if (changed && Math.abs(dn) >= 100000) {
              const add = Math.abs(p.szi) > Math.abs(q.szi);
              this.push(addr, name, Math.abs(dn) >= 1e6 ? 'high' : 'mid', add ? 'ADD' : 'CUT',
                `${add ? '加碼' : '減碼'}${p.side === 'long' ? '多單' : '空單'} ${p.coin}`,
                `名目 ${U.signed(dn, v => '$' + U.money(Math.abs(v)))} → ${U.usd(p.notional)} · 未實現 ${U.signed(p.upnl, v => '$' + U.money(Math.abs(v)))}`);
            } else if (Math.abs(p.upnl - q.upnl) > Math.max(250000, Math.abs(p.upnl) * 0.25) && Math.abs(p.upnl) > 500000) {
              this.push(addr, name, 'low', 'PNL', `${p.coin} 未實現損益變動`,
                `${U.signed(q.upnl, v => '$' + U.money(Math.abs(v)))} → ${U.signed(p.upnl, v => '$' + U.money(Math.abs(v)))}`);
            }
            pm.delete(p.coin);
          }
        });
        pm.forEach(p => {
          if (p.notional >= 100000) this.push(addr, name, 'mid', 'CLOSE', `平倉 ${p.coin}`,
            `原本${p.side === 'long' ? '多單' : '空單'} $${U.money(p.notional)} 已出場`);
        });
      }
      this.aggregate();
      S.emit('hl-state', addr);
    },
    push(addr, name, sev, kind, title, text) {
      const e = { ts: Date.now(), addr, name, sev, kind, title, text, chain: 'hyperliquid' };
      this.events.unshift(e);
      if (this.events.length > 200) this.events.pop();
      S.emit('hl-event', e);
      S.analytics.anomaly.push({
        type: 'CHAIN_' + kind, sev: sev, symbol: '鏈上大戶',
        title: `${name} ${title}`, text: `${text}（Hyperliquid · ${OC.short(addr)}）`
      });
    },
    /* 全體追蹤錢包的多空彙總 */
    aggregate() {
      let longUsd = 0, shortUsd = 0, n = 0, upnl = 0, value = 0;
      const byCoin = new Map();
      this.states.forEach((s, addr) => {
        if (!s.pos || !s.pos.length) return;
        n++; value += s.value || 0;
        s.pos.forEach(p => {
          upnl += p.upnl || 0;
          if (p.side === 'long') longUsd += p.notional; else shortUsd += p.notional;
          const c = byCoin.get(p.coin) || { coin: p.coin, long: 0, short: 0, wallets: new Set() };
          if (p.side === 'long') c.long += p.notional; else c.short += p.notional;
          c.wallets.add(addr);
          byCoin.set(p.coin, c);
        });
      });
      const arr = Array.from(byCoin.values()).map(c => ({
        coin: c.coin, long: c.long, short: c.short, net: c.long - c.short, wallets: c.wallets.size
      })).sort((a, b) => (b.long + b.short) - (a.long + a.short));
      this.agg = {
        longUsd, shortUsd, total: longUsd + shortUsd,
        ratio: (longUsd + shortUsd) ? longUsd / (longUsd + shortUsd) : NaN,
        net: longUsd - shortUsd, wallets: n, positions: byCoin.size, value, upnl, coins: arr
      };
      return this.agg;
    },
    /* 輪詢：每次挑幾個錢包更新持倉（避免一次打太多請求） */
    nextBatch(n) {
      if (!this.wallets.length) return [];
      const out = [];
      for (let i = 0; i < n; i++) out.push(this.wallets[(this.pollIdx + i) % this.wallets.length]);
      this.pollIdx = (this.pollIdx + n) % this.wallets.length;
      return out;
    }
  };

  /* ══════════════ B. 多鏈 DEX 大額換幣 ══════════════════ */
  const DX = OC.dex = {
    chain: 'eth', min: 20000,
    pools: [], trades: [], wallets: new Map(), tokenPrice: new Map(), coBuy: [], ready: false,
    poolIdx: 0, calls: 0, scanAt: 0,
    labels: { eth: '以太坊', solana: 'Solana', base: 'Base', bsc: 'BNB Chain' },
    /* 一次掃描：更新熱門池 → 輪流抓幾個池的大額成交 */
    async scan() {
      const net = this.chain;
      const pools = await S.api.gtTrending(net);
      if (pools) {
        // 依 24 小時成交量排序：優先掃高流量池，單次呼叫就能帶回較多大額成交
        this.pools = pools.slice().sort((a, b) => (b.vol24 || 0) - (a.vol24 || 0)).slice(0, 14);
        pools.forEach(p => { if (isFinite(p.priceUsd)) this.tokenPrice.set(p.pool, p.priceUsd); });
        S.emit('dex-pools', this.pools);
      }
      const list = this.pools.length ? this.pools : [];
      if (!list.length) return 0;
      let got = 0;
      const per = Math.min(1, list.length);      // 受限流影響，每輪 1 池（約 14 秒一輪）
      for (let i = 0; i < per; i++) {
        const p = list[this.poolIdx % list.length];
        this.poolIdx++;
        const ts = await S.api.gtTrades(net, p.pool, this.min);
        this.calls++;
        if (ts && ts.length) {
          ts.forEach(t => {
            const full = Object.assign({}, t, {
              poolName: p.name, chain: net, dex: p.dex,
              token: t.side === 'buy' ? t.toToken : t.fromToken,
              quote: t.side === 'buy' ? t.fromToken : t.toToken,
              tokenPrice: t.side === 'buy' ? t.toUsd : t.priceUsd
            });
            if (net === 'solana') full.tokenSym = (p.name || '').split('/')[0].trim();
            else full.tokenSym = (p.name || '').split('/')[0].trim();
            this.addTrade(full);
            got++;
          });
        }
      }
      this.ready = true;
      this.scanAt = Date.now();
      S.emit('dex-scan', got);
      return got;
    },
    addTrade(t) {
      if (!t.wallet || !isFinite(t.usd)) return;
      const key = t.wallet;
      // 同一筆交易去重（不同池可能重複抓）
      for (let i = this.trades.length - 1; i >= 0 && i > this.trades.length - 400; i--) {
        const x = this.trades[i];
        if (x.tx === t.tx && x.wallet === t.wallet && x.usd === t.usd) return;
      }
      this.trades.unshift(t);
      if (this.trades.length > 800) this.trades.pop();
      if (isFinite(t.tokenPrice) && t.token) this.tokenPrice.set(t.token, t.tokenPrice);
      // 錢包畫像
      let p = this.wallets.get(key);
      if (!p) { p = { addr: key, trades: [], buyUsd: 0, sellUsd: 0, tokens: new Map(), chains: new Set(), first: t.ts, last: t.ts, maxUsd: 0 }; this.wallets.set(key, p); }
      p.trades.unshift(t);
      if (p.trades.length > 40) p.trades.pop();
      if (t.side === 'buy') p.buyUsd += t.usd; else p.sellUsd += t.usd;
      p.tokens.set(t.token || t.pool, { sym: t.tokenSym || '?', usd: (p.tokens.get(t.token) || { usd: 0 }).usd + t.usd, buy: t.side === 'buy' });
      p.chains.add(t.chain);
      p.first = Math.min(p.first, t.ts); p.last = Math.max(p.last, t.ts);
      p.maxUsd = Math.max(p.maxUsd, t.usd);
      p.label = null;   // 讓 label 重算
      S.emit('dex-trade', t);
      if (t.usd >= 250000) {
        S.analytics.anomaly.push({
          type: 'CHAIN_SWAP', sev: t.usd >= 1e6 ? 'high' : 'mid', symbol: '鏈上 ' + OC.chainLabel(t.chain),
          title: `${t.side === 'buy' ? '大額買入' : '大額賣出'} ${t.tokenSym || '代幣'} $${U.money(t.usd)}`,
          text: `錢包 ${OC.short(t.wallet)} 在 ${t.dex || 'DEX'} ${t.side === 'buy' ? '買進' : '賣出'} ${t.tokenSym || ''}，金額 $${U.money(t.usd)}（${OC.chainLabel(t.chain)}）`
        });
      }
      this.coBuyCheck(t);
    },
    /* 多錢包協同買入：同一代幣 30 分鐘內 ≥3 個不同錢包買入 */
    coBuyCheck(t) {
      if (t.side !== 'buy' || !t.token) return;
      const cut = Date.now() - 30 * 60e3;
      const set = new Set();
      let usd = 0, n = 0;
      for (const x of this.trades) {
        if (x.ts < cut) break;
        if (x.token === t.token && x.side === 'buy') { set.add(x.wallet); usd += x.usd; n++; }
      }
      if (set.size >= 3) {
        const sym = t.tokenSym || '代幣';
        const exist = this.coBuy.find(c => c.token === t.token);
        const rec = { token: t.token, sym, wallets: set.size, usd, n, ts: Date.now(), chain: t.chain, poolName: t.poolName };
        if (exist) Object.assign(exist, rec);
        else this.coBuy.unshift(rec);
        if (this.coBuy.length > 12) this.coBuy.pop();
        if (!exist || Date.now() - (exist.__alert || 0) > 600000) {
          rec.__alert = Date.now();
          S.analytics.anomaly.push({
            type: 'CHAIN_COBUY', sev: 'high', symbol: '鏈上 ' + OC.chainLabel(t.chain),
            title: `${set.size} 個錢包同步買入 ${sym}`,
            text: `30 分鐘內 ${set.size} 個不同錢包、共 ${n} 筆大額買入 ${sym}，合計 $${U.money(usd)}（疑似集團式進場）`
          });
        }
      }
    },
    /* 錢包評分：規模 / 方向 / 交易後價格變化（觀察值）/ 代幣廣度 */
    profile(addr) {
      const p = this.wallets.get(addr);
      if (!p) return null;
      const now = Date.now();
      let followed = 0, judged = 0, sum = 0;
      p.trades.forEach(t => {
        const cur = this.tokenPrice.get(t.token);
        if (!isFinite(cur) || !isFinite(t.tokenPrice) || !t.tokenPrice) return;
        if (t.ts > now - 5 * 60e3) return;               // 太新的交易不列入評分
        const chg = t.side === 'buy' ? (cur / t.tokenPrice - 1) : (1 - cur / t.tokenPrice);
        judged++; sum += chg;
        if (chg > 0) followed++;
      });
      const totalUsd = p.buyUsd + p.sellUsd;
      const buyRatio = totalUsd ? p.buyUsd / totalUsd : 0.5;
      const c1 = U.clamp((Math.log10(Math.max(1, totalUsd)) - 4) / 2.2, 0, 1);      // 規模 $10K→$1.5M
      const c2 = U.clamp((buyRatio - 0.5) * 2 * 0.5 + 0.5, 0, 1);                    // 方向
      const c3 = judged >= 1 ? U.clamp(0.5 + (sum / judged) * 2.5, 0, 1) : 0.5;      // 交易後價格變化
      const c4 = U.clamp(p.tokens.size / 6, 0, 1);                                    // 代幣廣度
      const score = Math.round(100 * (c1 * 0.28 + c2 * 0.16 + c3 * 0.36 + c4 * 0.2));
      if (!p.label) {
        let lb = '觀察中', cls = 'neu';
        if (score >= 74 && buyRatio >= 0.6) { lb = '鏈上吸籌主力'; cls = 'bull'; }
        else if (score >= 74) { lb = '高勝率錢包'; cls = 'bull'; }
        else if (score >= 60) { lb = '活躍聰明錢'; cls = 'bull'; }
        else if (buyRatio >= 0.75 && p.trades.length >= 4) { lb = '持續買入'; cls = 'bull'; }
        else if (buyRatio <= 0.3 && p.trades.length >= 4) { lb = '持續派發'; cls = 'bear'; }
        else if (score <= 38) { lb = '追高型'; cls = 'bear'; }
        p.label = lb; p.cls = cls;
      }
      return {
        addr, label: p.label, cls: p.cls, score,
        trades: p.trades.length, buyUsd: p.buyUsd, sellUsd: p.sellUsd, netUsd: p.buyUsd - p.sellUsd,
        totalUsd, maxUsd: p.maxUsd, tokens: Array.from(p.tokens.values()).sort((a, b) => b.usd - a.usd).slice(0, 5),
        tokenCount: p.tokens.size, chains: Array.from(p.chains), last: p.last, first: p.first,
        followUp: judged ? sum / judged : NaN, judged, followed,
        winRate: judged ? followed / judged : NaN
      };
    },
    leaderboard(limit) {
      const out = [];
      this.wallets.forEach((v, k) => { const pr = this.profile(k); if (pr) out.push(pr); });
      out.sort((a, b) => b.score - a.score || b.totalUsd - a.totalUsd);
      return out.slice(0, limit || 14);
    },
    recent(minUsd, limit) {
      const lim = limit || 40;
      return this.trades.filter(t => t.usd >= (minUsd || 0)).slice(0, lim);
    },
    reset() { this.trades = []; this.wallets = new Map(); this.coBuy = []; this.tokenPrice = new Map(); this.pools = []; this.poolIdx = 0; }
  };

  /* ══════════════ 雷達事件（給動畫用）══════════════ */
  const R = OC.radar = {
    pings: [],
    add(t) {
      // 用地址雜湊決定固定方位角，讓同一個錢包每次都出現在同一方向
      let h = 0; for (let i = 0; i < t.wallet.length; i++) h = (h * 31 + t.wallet.charCodeAt(i)) >>> 0;
      this.pings.push({ ang: (h % 360) * Math.PI / 180, r: 0.25 + ((h >> 8) % 70) / 100, usd: t.usd, side: t.side, ts: Date.now(), wallet: t.wallet, sym: t.tokenSym });
      if (this.pings.length > 40) this.pings.shift();
    }
  };
  S.on('dex-trade', t => R.add(t));
})(window);
