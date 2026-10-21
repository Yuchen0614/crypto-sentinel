/* stream.js — 即時資料流（WebSocket）
   現貨：Binance（成交明細 aggTrade + 20 檔訂單簿 @depth20@100ms + 全市場 miniTicker）
   合約：Bybit 線性合約（成交明細 publicTrade + 清算 allLiquidation）
   註：Binance 合約串流（fstream）在此環境可連線但不會推送任何資料，
       因此合約行情與清算一律以 Bybit 為來源；REST 統計仍使用 Binance 合約端點。
   含指數退避重連、心跳看門狗、現貨串流失敗自動切換 Bybit。 */
'use strict';
(function (w) {
  const S = w.SENTINEL, U = S.util;
  const st = S.stream = {
    state: { sel: 'closed', glob: 'closed', fut: 'closed' },
    lastMsg: { sel: 0, glob: 0 },
    msgs: { sel: 0, glob: 0 },
    symbol: null, futuresSym: null, liqCount: 0, liqSymbols: [],
    recv: { binance: 0, bybitTrade: 0, bybitLiq: 0, bybitOther: 0, binanceTrades: 0 }
  };

  /* ── 通用連線包裝 ─────────────────────────────────── */
  function link(opts) {
    const L = { ws: null, tries: 0, alive: false, closed: false, url: opts.url, name: opts.name, timer: null };
    function open() {
      if (L.closed) return;
      let ws;
      try { ws = new WebSocket(L.url); } catch (e) { schedule(); return; }
      L.ws = ws;
      ws.onopen = () => {
        L.tries = 0; L.alive = true; L.openedAt = Date.now();
        opts.onState && opts.onState('open', L);
        if (opts.onOpen) { try { opts.onOpen(L); } catch (e) { S.errors.push('onOpen ' + L.name + ': ' + e.message); } }
      };
      ws.onmessage = ev => {
        st.msgs[opts.group]++; st.lastMsg[opts.group] = Date.now(); L.last = Date.now(); L.n = (L.n || 0) + 1;
        let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
        opts.onMsg(d);
      };
      ws.onerror = () => { };
      ws.onclose = () => {
        L.alive = false;
        opts.onState && opts.onState('closed', L);
        if (L.openedAt && Date.now() - L.openedAt < 3000) L.tries = Math.max(L.tries, 3);
        schedule();
      };
    }
    function schedule() {
      if (L.closed) return;
      L.tries++;
      const wait = Math.min(30000, 800 * Math.pow(1.7, Math.min(L.tries, 8)));
      clearTimeout(L.timer);
      L.timer = setTimeout(open, wait);
      opts.onState && opts.onState(L.tries > 3 ? 'retry' : 'wait', L);
    }
    L.start = open;
    L.stop = () => { L.closed = true; clearTimeout(L.timer); try { L.ws && L.ws.close(); } catch (e) { } };
    L.send = o => { try { L.ws && L.ws.readyState === 1 && L.ws.send(JSON.stringify(o)); } catch (e) { } };
    L.ping = () => { if (!L.closed && (!L.alive || (L.last && Date.now() - L.last > 90000))) { try { L.ws && L.ws.close(); } catch (e) { } } };
    L.info = () => ({
      name: L.name, url: L.url.replace('wss://stream.bybit.com/v5/public/', 'bybit:').replace('wss://stream.binance.com:9443/', 'bnc:'),
      ready: L.ws ? L.ws.readyState : -1, alive: L.alive, tries: L.tries,
      msgs: L.n || 0, lastAge: L.last ? Date.now() - L.last : null,
      subs: L.subs ? L.subs.length : 0, sub0: L.subs ? L.subs[0] : null
    });
    open();
    return L;
  }

  const BYBIT_LINEAR = 'wss://stream.bybit.com/v5/public/linear';
  function bybitSub(L, args) {
    L.subs = args.slice();
    for (let i = 0; i < args.length; i += 8) L.send({ op: 'subscribe', args: args.slice(i, i + 8) });
  }

  let selSpot = null, selBybit = null, glob = null, liqFeed = null, watchdog = null;

  /* ── 選定幣種 ─────────────────────────────────────── */
  st.startSelected = function (symbol, futuresSym) {
    st.stopSelected();
    st.symbol = symbol;
    st.futuresSym = futuresSym || null;
    const s = symbol.toLowerCase();

    selSpot = link({
      url: `wss://stream.binance.com:9443/stream?streams=${s}@aggTrade/${s}@depth20@100ms`,
      name: 'binance-spot:' + s, group: 'sel', onState: (v, L) => { if (selSpot === L) setState('sel', v); },
      onMsg: d => {
        if (!d.stream) return;
        const dd = d.data;
        if (d.stream.indexOf('aggTrade') >= 0) {
          st.recv.binanceTrades++;
          S.emit('trade', {
            symbol: dd.s, price: +dd.p, qty: +dd.q, ts: dd.T, src: 'Binance',
            side: dd.m ? 'sell' : 'buy', notional: +dd.p * +dd.q, market: 'spot'
          });
        } else if (dd.bids) {
          S.emit('depth', { bids: dd.bids.map(x => [+x[0], +x[1]]), asks: dd.asks.map(x => [+x[0], +x[1]]), market: 'spot', ts: Date.now() });
        }
      }
    });

    if (futuresSym) st.attachFutures(symbol);

    setTimeout(() => { if (st.symbol === symbol && st.state.sel !== 'open') st.useBybitFallback(symbol); }, 8000);

    if (watchdog) clearInterval(watchdog);
    watchdog = setInterval(() => { [selSpot, selBybit, glob, liqFeed].forEach(L => L && L.ping()); }, 20000);
  };

  st.stopSelected = function () {
    if (selSpot) { selSpot.stop(); selSpot = null; }
    if (selBybit) { selBybit.stop(); selBybit = null; }
    st.futSymAttached = null;
  };

  /* ── 掛載/切換合約流（可在合約清單載入後再呼叫）──────── */
  st.attachFutures = function (symbol) {
    if (!symbol || st.futSymAttached === symbol) return;
    if (selBybit) { selBybit.stop(); selBybit = null; }
    st.futSymAttached = symbol;
    selBybit = link({
      url: BYBIT_LINEAR, name: 'bybit-linear:' + symbol, group: 'sel',
      onState: (v, L) => { if (selBybit === L && st.state.fut !== 'open') setState('fut', v); },
      onOpen: L => bybitSub(L, ['publicTrade.' + symbol, 'allLiquidation.' + symbol]),
      onMsg: d => {
        if (!d.topic) return;
        if (d.topic.indexOf('publicTrade') === 0) {
          (d.data || []).forEach(t => {
            st.recv.bybitTrade++;
            S.emit('trade', {
              symbol: t.s, price: +t.p, qty: +t.v, ts: +t.T, src: 'Bybit',
              side: t.S === 'Buy' ? 'buy' : 'sell', notional: +t.p * +t.v, market: 'futures'
            });
          });
        } else if (d.topic.indexOf('allLiquidation') === 0) {
          (d.data || []).forEach(x => { st.recv.bybitLiq++; liqEvent(x.s, x.S, +x.p, +x.v, +x.T); });
        } else st.recv.bybitOther++;
      }
    });
  };

  /* ── 清算事件（Bybit allLiquidation：S = 平倉單方向，Sell 代表多單被清算）── */
  function liqEvent(sym, orderSide, price, qty, ts) {
    if (!isFinite(price) || !isFinite(qty)) return;
    st.liqCount++;
    S.emit('liquidation', {
      symbol: sym, side: orderSide === 'Sell' ? 'long' : 'short',
      price: price, qty: qty, ts: ts || Date.now(), notional: price * qty, src: 'Bybit'
    });
  }

  /* ── 全市場輕量行情 ───────────────────────────────── */
  st.startGlobal = function () {
    glob = link({
      url: 'wss://stream.binance.com:9443/ws/!miniTicker@arr',
      name: 'binance-mini', group: 'glob', onState: (v, L) => { if (glob === L) setState('glob', v); },
      onMsg: d => { const dd = d.data || d; if (Array.isArray(dd)) S.emit('miniTicker', dd); }
    });
  };

  /* ── 主要幣種清算流（清單由 app 依成交量決定）────────── */
  st.startLiquidations = function (symbols) {
    if (liqFeed) { liqFeed.stop(); liqFeed = null; }
    if (!symbols || !symbols.length) return;
    st.liqSymbols = symbols.slice();
    liqFeed = link({
      url: BYBIT_LINEAR, name: 'bybit-liq', group: 'glob',
      onState: (v, L) => { if (liqFeed === L && st.state.fut !== 'open') setState('fut', v); },
      onOpen: L => bybitSub(L, symbols.map(s => 'allLiquidation.' + s)),
      onMsg: d => { if (d.topic && d.topic.indexOf('allLiquidation') === 0) (d.data || []).forEach(x => liqEvent(x.s, x.S, +x.p, +x.v, +x.T)); }
    });
  };

  function setState(group, v) { st.state[group] = v; S.emit('ws-state', st.state); }

  /* ── Bybit 現貨備援 ─────────────────────────────── */
  st.useBybitFallback = function (symbol) {
    if (selBybit || !symbol) return;
    S.errors.push('spot ws fallback → bybit ' + symbol);
    selBybit = link({
      url: 'wss://stream.bybit.com/v5/public/spot', name: 'bybit-spot', group: 'sel', onState: (v, L) => { if (selBybit === L) setState('sel', v); },
      onOpen: L => bybitSub(L, ['publicTrade.' + symbol, 'orderbook.50.' + symbol]),
      onMsg: d => {
        if (!d.topic) return;
        if (d.topic.indexOf('publicTrade') === 0) {
          (d.data || []).forEach(t => S.emit('trade', {
            symbol: t.s, price: +t.p, qty: +t.v, ts: +t.T, src: 'Bybit',
            side: t.S === 'Buy' ? 'buy' : 'sell', notional: +t.p * +t.v, market: 'spot'
          }));
        } else if (d.topic.indexOf('orderbook') === 0 && d.data) {
          S.emit('depth', { bids: (d.data.b || []).map(x => [+x[0], +x[1]]), asks: (d.data.a || []).map(x => [+x[0], +x[1]]), market: 'spot', ts: Date.now() });
        }
      }
    });
  };

  st.conns = () => [selSpot, selBybit, glob, liqFeed].filter(Boolean).map(L => L.info());

  st.stats = () => ({
    sel: st.state.sel, glob: st.state.glob, fut: st.state.fut,
    selRate: st.msgs.sel, globRate: st.msgs.glob,
    selAge: Date.now() - (st.lastMsg.sel || 0), globAge: Date.now() - (st.lastMsg.glob || 0),
    liqEvents: st.liqCount, liqSymbols: st.liqSymbols.length, recv: Object.assign({}, st.recv)
  });
  setInterval(() => { st.msgs.sel = 0; st.msgs.glob = 0; }, 1000);
})(window);
