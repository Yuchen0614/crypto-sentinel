/* ui.js — 介面渲染：全市場掃描、巨鯨動向、清算流、持倉結構、異常事件、頂部統計、開機動畫 */
'use strict';
(function (w) {
  const S = w.SENTINEL, U = S.util;
  const UI = S.ui = {};

  /* ══════ 全市場掃描表 ══════ */
  const Scan = UI.scan = {
    rows: new Map(), list: [], sort: 'quoteVolume', q: '', onlyFut: false, max: 120,
    order: [], orderKey: '', orderAt: 0,
    setList(l) { this.list = l || []; this.render(); },
    sorted() {
      let l = this.list;
      if (this.onlyFut && S.state.futuresSet) l = l.filter(x => S.state.futuresSet.has(x.symbol));
      if (this.q) { const q = this.q.toUpperCase(); l = l.filter(x => x.symbol.indexOf(q) >= 0 || (x.name || '').toUpperCase().indexOf(q) >= 0); }
      const s = this.sort;
      l = l.slice();
      if (s === 'priceChangePercent') l.sort((a, b) => b.changePct - a.changePct);
      else if (s === 'absChange') l.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
      else if (s === 'smart') l.sort((a, b) => (b.smart || 50) - (a.smart || 50));
      else l.sort((a, b) => b.quoteVolume - a.quoteVolume);
      return l.slice(0, this.max);
    },
    render(force) {
      const body = document.getElementById('scanBody'); if (!body) return;
      let list = this.sorted();
      // 只有在「排序/搜尋變更」或每 10 秒才重新排序，其餘時間維持列序（數字就地更新）
      const key = this.sort + '|' + this.q + '|' + this.onlyFut + '|' + list.length;
      const now = Date.now();
      if (force || key !== this.orderKey || now - this.orderAt > 10000) {
        this.order = list.map(x => x.symbol); this.orderKey = key; this.orderAt = now;
      } else {
        const by = new Map(list.map(x => [x.symbol, x]));
        const out = [];
        this.order.forEach(s => { const c = by.get(s); if (c) out.push(c); });
        list.forEach(c => { if (this.order.indexOf(c.symbol) < 0) { this.order.push(c.symbol); out.push(c); } });
        list = out;
      }
      // 若先前顯示「查無資料」提示列，先清空
      if (body.firstChild && !body.firstChild.dataset.sym && !list.length) return;
      if (body.firstChild && !body.firstChild.dataset.sym) body.innerHTML = '';
      // 條數不足時補齊 DOM
      while (body.children.length < list.length) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td class="ta-l"><span class="rk"></span><span class="sym"><b></b></span><em></em></td>' +
          '<td class="ta-r px"></td><td class="ta-r ch"></td><td class="ta-r vol"></td><td class="ta-c sm"></td>';
        body.appendChild(tr);
      }
      while (body.children.length > list.length) body.removeChild(body.lastChild);

      list.forEach((c, i) => {
        const tr = body.children[i];
        tr.dataset.sym = c.symbol;
        if (tr.__sym !== c.symbol) {
          tr.__sym = c.symbol;
          tr.children[0].querySelector('.rk').textContent = c.rank || (i + 1);
          tr.children[0].querySelector('.sym b').textContent = c.base;
          tr.children[0].querySelector('em').textContent = '/USDT';
        }
        const pxEl = tr.children[1], chEl = tr.children[2], volEl = tr.children[3], smEl = tr.children[4];
        if (tr.__px !== c.price) {
          const prev = tr.__px;
          pxEl.textContent = U.pxSym(c.price);
          if (prev !== undefined && isFinite(prev) && prev !== c.price) {
            pxEl.classList.remove('flash-up', 'flash-down'); void pxEl.offsetWidth;
            pxEl.classList.add(c.price > prev ? 'flash-up' : 'flash-down');
          }
          tr.__px = c.price;
        }
        const ct = U.pct(c.changePct);
        if (chEl.textContent !== ct) { chEl.textContent = ct; chEl.className = 'ta-r ch ' + U.cls(c.changePct); }
        volEl.textContent = U.money(c.quoteVolume);
        const sc = Math.round(c.smart || 50);
        const cls = sc >= 60 ? 'bull' : sc <= 40 ? 'bear' : 'neu';
        if (tr.__sc !== sc) {
          tr.__sc = sc;
          smEl.innerHTML = `<span class="smbadge ${cls}">${sc}</span>`;
        }
        tr.classList.toggle('sel', c.symbol === S.state.symbol);
        tr.onclick = () => S.select(c.symbol);
      });
      // 搜尋結果為空
      if (!list.length) body.innerHTML = '<tr><td colspan="5" class="empty">找不到符合條件的幣種</td></tr>';
      U.text('#scanCount', list.length);
      const up = this.list.filter(x => x.changePct > 0).length, dn = this.list.filter(x => x.changePct < 0).length, fl = this.list.length - up - dn;
      U.text('#scanFoot', `顯示 ${list.length} / ${this.list.length} 檔 · 上漲 ${up} · 下跌 ${dn} · 平盤 ${fl} · 資料源 ${S.api.source || '—'}`);
      const bb = document.getElementById('breadthBar');
      if (bb) {
        const t = this.list.length || 1;
        bb.innerHTML = `<i class="b" style="width:${(up / t * 100).toFixed(1)}%"></i><i class="f" style="width:${(fl / t * 100).toFixed(1)}%"></i><i class="s" style="width:${(dn / t * 100).toFixed(1)}%"></i>`;
      }
    },
    // 即時微型行情更新（WS）
    patch(map) {
      let hit = 0;
      this.list.forEach(c => {
        const m = map[c.symbol];
        if (!m) return;
        hit++;
        c.price = m.c;
        c.changePct = m.o ? (m.c / m.o - 1) * 100 : c.changePct;
        c.high = Math.max(c.high, m.h); c.low = Math.min(c.low, m.l);
        c.quoteVolume = m.q;
      });
      if (hit) this.render();
      return hit;
    }
  };

  /* ══════ 巨鯨動向 ══════ */
  const Whale = UI.whale = {
    min: 'auto', count: 0, els: [], thrNow: 25000,
    // 自動門檻：近期成交金額中位數的 10 倍，最低 8 千美元（不同幣種自動調整規模）
    threshold() {
      if (this.min !== 'auto') return this.min;
      const m = S.analytics.Trades.medianNotional(600e3);
      if (!isFinite(m) || m <= 0) return 25000;
      const t = Math.max(8000, m * 10);
      const p = Math.pow(10, Math.max(0, Math.floor(Math.log10(t)) - 1));
      return Math.round(t / p) * p;
    },
    add(t) {
      const tape = document.getElementById('whaleTape'); if (!tape) return;
      this.thrNow = this.threshold();
      if (t.notional < this.thrNow) return;
      this.count++;
      const empty = tape.querySelector('.empty'); if (empty) empty.remove();
      const row = document.createElement('div');
      const cls = t.notional >= 1e6 ? 'mega' : t.notional >= 250000 ? 'big' : '';
      row.className = 'trow ' + t.side + ' ' + cls;
      row.innerHTML = `<span class="t">${U.time(t.ts)}</span>` +
        `<span class="side">${t.side === 'buy' ? '買' : '賣'}</span>` +
        `<span>${U.px(t.price)}</span><span>${U.qty(t.qty)}</span>` +
        `<span class="amt">$${U.money(t.notional)}</span>`;
      row.title = `${t.market === 'futures' ? '合約（Bybit）' : '現貨（Binance）'} · ${t.symbol} · ${new Date(t.ts).toLocaleString('zh-TW')}`;
      tape.insertBefore(row, tape.firstChild);
      if (t.notional >= 250000) S.fx.floatTag(row, (t.side === 'buy' ? '+' : '−') + '$' + U.money(t.notional), t.side === 'buy' ? 'var(--gn)' : 'var(--rd)');
      this.els.push(row);
      while (this.els.length > 60) { const e = this.els.shift(); if (e.parentNode) e.parentNode.removeChild(e); }
      while (tape.children.length > 60) tape.removeChild(tape.lastChild);
    },
    renderNetflow() {
      const T = S.analytics.Trades;
      const w = [60e3, 300e3, 900e3];
      const ids = ['#nf1', '#nf5', '#nf15'];
      w.forEach((ms, i) => {
        const n = T.netflow(ms);
        const el = document.querySelector(ids[i]); if (!el) return;
        el.textContent = U.signed(n.whaleDelta, v => '$' + U.money(Math.abs(v)));
        el.style.color = n.whaleDelta > 0 ? 'var(--gn)' : n.whaleDelta < 0 ? 'var(--rd)' : 'var(--tx-2)';
        el.title = `大單買 $${U.money(n.whaleBuy)} / 賣 $${U.money(n.whaleSell)}`;
      });
      const n5 = T.netflow(300e3);
      const bar = document.getElementById('nfBar');
      if (bar) bar.style.left = (U.clamp((n5.whaleDelta / Math.max(200000, Math.abs(n5.whaleBuy) + Math.abs(n5.whaleSell))) / 2 + 0.5, 0, 1) * 100).toFixed(1) + '%';
      this.thrNow = this.threshold();
      U.html('#whaleFoot', `累計 <b>${this.count}</b> 筆大額成交 · 現行門檻 ≥ $${U.money(this.thrNow)}${this.min === 'auto' ? '（自動：近 10 分鐘成交金額中位數 ×10）' : ''} · 分級：≥$250K 大型、≥$1M 巨鯨`);
      const tape = document.getElementById('whaleTape');
      const empty = tape && tape.querySelector('.empty');
      if (empty && !this.count) empty.textContent = `監聽中 · 現行門檻 ≥ $${U.money(this.thrNow)} — 尚無達門檻的成交，可按「≥10萬」看更多`;
    }
  };

  /* ══════ 清算流 ══════ */
  const Liq = UI.liq = {
    els: [], count: 0,
    add(e) {
      const tape = document.getElementById('liqTape'); if (!tape) return;
      if (e.notional < 1000) return;
      this.count++;
      const empty = tape.querySelector('.empty'); if (empty) empty.remove();
      const row = document.createElement('div');
      row.className = 'lrow ' + e.side;
      row.innerHTML = `<span class="t">${U.time(e.ts)}</span>` +
        `<span class="side">${e.side === 'long' ? '多殺' : '空軋'}</span>` +
        `<span class="sym">${e.symbol.replace('USDT', '')}</span>` +
        `<span class="amt">$${U.money(e.notional)}</span>`;
      tape.insertBefore(row, tape.firstChild);
      this.els.push(row);
      while (this.els.length > 50) { const x = this.els.shift(); if (x.parentNode) x.parentNode.removeChild(x); }
      while (tape.children.length > 50) tape.removeChild(tape.lastChild);
    },
    render() {
      const m1 = S.analytics.Liq.sum(60e3), m15 = S.analytics.Liq.sum(900e3);
      const e1 = document.getElementById('liq1'), e15 = document.getElementById('liq15'), er = document.getElementById('liqRatio');
      if (e1) { e1.textContent = '$' + U.money(m1.total); e1.style.color = m1.total > 200000 ? 'var(--am)' : 'var(--tx)'; }
      if (e15) e15.textContent = '$' + U.money(m15.total);
      if (er) {
        er.textContent = m15.total > 0 ? `多 ${(m15.ratio * 100).toFixed(0)}% / 空 ${((1 - m15.ratio) * 100).toFixed(0)}%` : '—';
        er.style.color = m15.long > m15.short ? 'var(--rd)' : 'var(--gn)';
      }
      U.text('#liqMeta', `Bybit 線性合約 · 涵蓋 ${S.stream.liqSymbols.length || 0} 個幣種 · 顯示 ≥$1K · 累計 ${this.count} 筆`);
    }
  };

  /* ══════ 異常事件面板 ══════ */
  const Alerts = UI.alerts = {
    list: [],
    push(a) {
      this.list.unshift(a); if (this.list.length > 40) this.list.pop();
      this.render();
    },
    render() {
      const box = document.getElementById('alertList'); if (!box) return;
      if (!this.list.length) { box.innerHTML = '<div class="empty">尚未偵測到異常事件 — 系統持續掃描中</div>'; U.text('#alertCount', 0); return; }
      box.innerHTML = this.list.map(a =>
        `<div class="alert ${a.sev}"><span class="sev">${a.sev === 'high' ? 'HIGH' : a.sev === 'mid' ? 'MED' : 'INFO'}</span>` +
        `<div class="body"><b>${a.title}<span class="mini" style="margin-left:6px">${a.symbol || ''}</span></b><span>${a.text}</span></div>` +
        `<span class="t">${U.time(a.ts)}</span></div>`
      ).join('');
      U.text('#alertCount', this.list.length);
    },
    clear() { this.list = []; this.render(); }
  };

  /* ══════ 持倉結構面板 ══════ */
  const Pos = UI.pos = {
    render(priceStats) {
      const p = S.analytics.Pos, o = p.out || {}, d = p.data || {};
      U.text('#posPair', d.symbol ? d.symbol + ' 永續' : '無合約資料');
      const set = (sel, val, chgSel, chg, chgInv) => {
        const e = document.querySelector(sel); if (!e) return;
        e.textContent = val;
        const c = document.querySelector(chgSel); if (!c) return;
        c.textContent = chg;
        const good = chgInv ? -1 : 1;
        c.style.color = chg.indexOf('-') === 0 ? (good > 0 ? 'var(--rd)' : 'var(--gn)') : (good > 0 ? 'var(--gn)' : 'var(--rd)');
      };
      U.text('#pOi', isFinite(o.oiNow) ? U.money(o.oiNow) : '—');
      const oiEl = document.getElementById('pOiChg');
      if (oiEl) {
        oiEl.textContent = isFinite(o.oi1h) ? '1H ' + U.pct(o.oi1h) : '無歷史';
        oiEl.style.color = isFinite(o.oi1h) ? (o.oi1h > 0 ? 'var(--am)' : 'var(--cy)') : 'var(--tx-3)';
      }
      U.text('#pFund', isFinite(o.funding) ? (o.funding * 100).toFixed(4) + '%' : '—');
      const fEl = document.getElementById('pFundNext');
      if (fEl) {
        if (isFinite(o.funding)) { const ann = o.funding * 3 * 365 * 100; fEl.textContent = '年化 ' + ann.toFixed(1) + '%'; fEl.style.color = Math.abs(o.funding) > 0.0005 ? 'var(--am)' : 'var(--tx-3)'; }
        else fEl.textContent = '—';
      }
      U.text('#pTop', isFinite(o.topRatioNow) ? o.topRatioNow.toFixed(2) : '—');
      const tp = document.getElementById('pTopChg');
      if (tp && isFinite(o.topRatioNow) && isFinite(o.topRatioPrev)) {
        const dv = o.topRatioNow - o.topRatioPrev;
        tp.textContent = '1H ' + (dv >= 0 ? '+' : '') + dv.toFixed(2);
        tp.style.color = dv > 0 ? 'var(--gn)' : dv < 0 ? 'var(--rd)' : 'var(--tx-3)';
      } else if (tp) tp.textContent = '—';
      U.text('#pAcct', isFinite(o.topAccountRatio) ? o.topAccountRatio.toFixed(2) : '—');
      U.text('#pGlobal', isFinite(o.globalRatio) ? o.globalRatio.toFixed(2) : '—');
      const gp = document.getElementById('pGlobalChg');
      if (gp && isFinite(o.globalRatio) && isFinite(o.globalPrev)) {
        const dv = o.globalRatio - o.globalPrev;
        gp.textContent = '1H ' + (dv >= 0 ? '+' : '') + dv.toFixed(2);
        gp.style.color = dv > 0 ? 'var(--gn)' : dv < 0 ? 'var(--rd)' : 'var(--tx-3)';
      } else if (gp) gp.textContent = '—';
      U.text('#pTaker', isFinite(o.takerRatio) ? (o.takerRatio * 100).toFixed(1) + '%' : '—');
      const tk = document.getElementById('pTakerChg');
      if (tk && isFinite(o.takerRatio) && isFinite(o.takerPrev)) {
        const dv = (o.takerRatio - o.takerPrev) * 100;
        tk.textContent = '1H ' + (dv >= 0 ? '+' : '') + dv.toFixed(1) + 'pt';
        tk.style.color = dv > 0 ? 'var(--gn)' : dv < 0 ? 'var(--rd)' : 'var(--tx-3)';
      } else if (tk) tk.textContent = '—';

      // 訊號列表
      const sig = p.signalsFor(priceStats);
      const box = document.getElementById('posSignals');
      if (box) {
        box.innerHTML = sig.length ? sig.map(x => `<div class="sig ${x.cls}"><b>${x.fn}</b><span>${x.txt}</span></div>`).join('')
          : '<div class="empty">目前持倉結構無明顯異常</div>';
      }
      S.chart && S.oiChart.set(o.oiSeries, o.oiTimes);
      return sig;
    }
  };

  /* ══════ 聰明錢壓力計面板 ══════ */
  UI.smart = function (res) {
    if (!res) return;
    U.animateNum(document.getElementById('smScore'), res.score, v => Math.round(v), 500);
    const sc = document.getElementById('smScore');
    if (sc) sc.style.color = res.cls === 'bull' ? 'var(--gn)' : res.cls === 'bear' ? 'var(--rd)' : '#f2f5fa';
    const v = document.getElementById('smVerdict');
    if (v) { v.textContent = res.verdict; v.className = 'verdict ' + res.cls; }
    S.gauge.set(res.score, res.cls);
    const box = document.getElementById('smComps');
    if (box) {
      if (box.children.length !== res.comps.length) {
        box.innerHTML = res.comps.map(c =>
          `<div class="comp"><label>${c.label}<i class="d"></i></label><div class="comp-bar"><i></i></div><span class="comp-val"></span></div>`
        ).join('');
      }
      res.comps.forEach((c, i) => {
        const el = box.children[i]; if (!el) return;
        const bar = el.querySelector('.comp-bar i');
        const val = el.querySelector('.comp-val');
        const w = Math.abs(c.v) * 50;
        const col = c.v >= 0 ? 'var(--gn)' : 'var(--rd)';
        bar.style.left = c.v >= 0 ? '50%' : (50 - w) + '%';
        bar.style.width = w + '%';
        bar.style.background = col;
        bar.style.boxShadow = '0 0 10px -2px ' + col;
        val.textContent = (c.v >= 0 ? '+' : '') + (c.v * 100).toFixed(0);
        val.style.color = c.v >= 0 ? 'var(--gn)' : 'var(--rd)';
        el.querySelector('i.d').textContent = c.detail;
      });
    }
    U.text('#smNote', res.note);
  };

  /* ══════ 頂部統計 / 時鐘 / 狀態 ══════ */
  const Hud = UI.hud = {
    global(g, fng) {
      if (g) {
        U.animateNum(document.getElementById('gMcap'), g.mcap, v => '$' + U.money(v), 700);
        U.animateNum(document.getElementById('gVol'), g.vol, v => '$' + U.money(v), 700);
        S.fx.bump(document.getElementById('gMcap')); S.fx.bump(document.getElementById('gVol'));
        const d = document.getElementById('gDom');
        if (d) { U.animateNum(d, g.btcDom, v => v.toFixed(1) + '%', 600); }
        const c = document.getElementById('gMcap');
        if (c) c.className = g.chg > 0 ? 'up' : g.chg < 0 ? 'down' : '';
      }
      if (fng && fng.now) {
        const e = document.getElementById('gFng'); if (e) {
          e.textContent = `${fng.now.v} · ${fng.now.label}`;
          e.className = fng.now.v >= 60 ? 'up' : fng.now.v <= 40 ? 'down' : '';
          e.title = 'Crypto Fear & Greed Index（alternative.me）';
        }
      }
    },
    breadth(up, dn, total) {
      const e = document.getElementById('gBreadth'); if (!e) return;
      e.innerHTML = `<span class="up">${up}</span> / <span class="down">${dn}</span>`;
      e.title = `上漲 ${up} · 下跌 ${dn} · 共 ${total} 檔`;
    },
    clock() {
      const d = new Date();
      U.text('#clock', d.toLocaleTimeString('zh-TW', { hour12: false }));
      U.text('#clockSub', '台北 · UTC+08 · ' + d.toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' }));
    },
    pills(st) {
      const ws = document.getElementById('pillWs');
      if (ws) {
        const ok = st.sel === 'open';
        ws.dataset.state = ok ? 'ok' : (st.sel === 'retry' || st.sel === 'closed' ? 'off' : 'wait');
        const rate = S.stream.stats().selRate;
        ws.innerHTML = `<i></i>即時流 ${ok ? '● ' + rate + '/s' : (st.sel === 'off' ? '中斷' : '連線中')}`;
      }
      const pf = document.getElementById('pillFut');
      if (pf) {
        const ft = st.fut === 'open';
        pf.dataset.state = ft ? 'ok' : (st.fut === 'retry' || st.fut === 'closed' ? 'off' : 'wait');
        pf.innerHTML = `<i></i>合約/清算 ${ft ? '● ' + (S.stream.stats().liqEvents || 0) + ' 筆' : '連線中'}`;
        pf.title = 'Bybit 線性合約：選定幣種成交明細 + 主要幣種清算事件';
      }
      const pc = document.getElementById('pillChain');
      if (pc) {
        const h = S.api.health.chain, oc = S.onchain;
        pc.dataset.state = h === 'ok' ? 'ok' : h === 'wait' ? 'wait' : 'off';
        pc.innerHTML = `<i></i>鏈上 ${h === 'ok' ? '● ' + (oc.dex.trades.length + oc.hl.states.size) + ' 筆' : '連線中'}`;
        pc.title = `Hyperliquid 大戶錢包 ${oc.hl.wallets.length} 個（已取得 ${oc.hl.states.size} 個持倉）· DEX 大額換幣 ${oc.dex.trades.length} 筆 / ${oc.dex.wallets.size} 個錢包`;
      }
      const rs = document.getElementById('pillRest');
      if (rs) {
        const h = S.api.health.spot;
        rs.dataset.state = h === 'ok' || h === 'alt' ? 'ok' : h === 'off' ? 'off' : 'wait';
        rs.innerHTML = `<i></i>行情 ${h === 'ok' ? '正常' : h === 'alt' ? '備援' : h === 'off' ? '異常' : '載入'}`;
      }
    },
    ticker(txt) {
      const e = document.getElementById('statusTicker');
      if (e && e.textContent.trim() !== txt) e.innerHTML = '<span>' + txt + '</span>';
    }
  };

  /* ══════ 主圖表上方數據條 ══════ */
  UI.stats = function (c, stats, extra) {
    U.text('#sHigh', U.pxSym(c.high)); U.text('#sLow', U.pxSym(c.low));
    U.text('#sVol', '$' + U.money(c.quoteVolume));
    U.text('#sTrades', isFinite(c.trades) ? U.fmt(c.trades, 0) : '—');
    U.text('#sVwap', U.pxSym(stats.vwap));
    U.text('#sAtr', isFinite(stats.atr) ? stats.atr.toFixed(2) + '%' : '—');
    const cvdEl = document.getElementById('sCvd');
    if (cvdEl) {
      const n = S.analytics.Trades.netflow(900e3);
      cvdEl.textContent = U.signed(n.delta, v => '$' + U.money(Math.abs(v)));
      cvdEl.style.color = n.delta > 0 ? 'var(--gn)' : 'var(--rd)';
      cvdEl.title = '近 15 分鐘主動買量 − 主動賣量（由逐筆成交累積）';
    }
    const poc = document.getElementById('sPoc');
    if (poc) {
      poc.textContent = isFinite(stats.poc) ? U.pxSym(stats.poc) + ' ±' + (stats.pocBand * 100).toFixed(2) + '%' : '—';
      poc.title = '近 24 小時成交量最集中的價位（Volume Profile 控制點 POC）與其 ±1σ 區間';
    }
    U.text('#symPrice', U.pxSym(c.price));
    const ch = document.getElementById('symChange');
    if (ch) { ch.textContent = U.pct(c.changePct) + ' · $' + U.money(c.quoteVolume) + ' 量'; ch.className = 'chg ' + U.cls(c.changePct); }
    U.text('#symName', c.base + '/USDT');
    U.text('#symTag', (S.state.futuresSet && S.state.futuresSet.has(c.symbol)) ? 'SPOT + 合約' : 'SPOT');
    const meta = document.getElementById('klineMeta');
    if (meta) meta.textContent = `K線 ${S.chart.tf} · ${S.chart.k.length} 根 · ${new Date().toLocaleTimeString('zh-TW', { hour12: false })}`;
  };
})(window);
