/* chainui.js — 鏈上情報面板渲染：大戶持倉表、倉位變化事件、鏈上換幣流、聰明錢錢包榜、錢包明節 */
'use strict';
(function (w) {
  const S = w.SENTINEL, U = S.util;
  const OC = S.onchain, HL = OC.hl, DX = OC.dex;
  const C = S.chainUI = {};
  const $ = s => document.querySelector(s);

  /* ── 大戶持倉彙總 ─────────────────────────────────── */
  C.agg = function () {
    const a = HL.agg; if (!a) return;
    /* 只輪詢到一小部分錢包時，比例會嚴重偏斜（例如 多 0.5% / 空 99.5%），
       因此標示「掃描中 n/N」，並在未掃完前用中性色，不讓它看起來像定論。 */
    const scanned = HL.states.size, total = HL.wallets.length || 0;
    const partial = total > 0 && scanned < total;
    const k = U.clamp(a.ratio, 0, 1);
    const fill = $('#aggFill'); if (fill) fill.style.width = (k * 100).toFixed(1) + '%';
    U.text('#aggLong', '多 $' + U.money(a.longUsd));
    U.text('#aggShort', '空 $' + U.money(a.shortUsd));
    const r = $('#aggRatio');
    if (r) {
      const named = isFinite(a.ratio) ? `名目加權 多 ${(a.ratio * 100).toFixed(0)}% / 空 ${((1 - a.ratio) * 100).toFixed(0)}%` : '—';
      const eq = isFinite(a.medRatio) ? `錢包等權 多 ${(a.medRatio * 100).toFixed(0)}% / 空 ${((1 - a.medRatio) * 100).toFixed(0)}%（中位數 ${a.sample || 0} 檔）` : '';
      r.textContent = named + (eq ? '　·　' + eq : '') + (partial ? `　·　取樣 ${scanned}/${total}` : '');
      r.style.color = partial ? 'var(--tx-2)'
        : a.ratio > 0.55 ? 'var(--gn)' : a.ratio < 0.45 ? 'var(--rd)' : 'var(--cy)';
      r.title = '兩個比例都看才準：名目加權容易被少數超大型帳戶主導（例如一個 $700M 的空單就把整體拉成偏空）；'
        + '錢包等權取中位數錢包的多空比，代表「一般大戶」的方向。想看個別差異請點下方任一錢包，'
        + '或用「大戶最擁擠倉位」看各幣別分佈。';
    }
    U.text('#aggWallets', String(a.wallets || 0));
    U.text('#aggPos', String(a.positions || 0));
    U.text('#aggNotional', '$' + U.money(a.total));
    const up = $('#aggUpnl');
    if (up) {
      up.textContent = U.signed(a.upnl, v => '$' + U.money(Math.abs(v)));
      up.style.color = a.upnl >= 0 ? 'var(--gn)' : 'var(--rd)';
    }
    // 頂部 HUD
    const g = $('#gChain');
    if (g) {
      if (isFinite(a.ratio) && a.wallets > 0) {
        g.innerHTML = `<span class="${partial ? '' : a.ratio > 0.55 ? 'up' : a.ratio < 0.45 ? 'down' : ''}">多 ${(a.ratio * 100).toFixed(0)}%</span> / 空 ${((1 - a.ratio) * 100).toFixed(0)}%` +
          (partial ? ` <span class="mini">掃描中 ${scanned}/${total}</span>` : '');
        g.title = `Hyperliquid 已回報 ${scanned}/${total} 個大戶錢包、${a.positions} 個倉位：多單 $${U.money(a.longUsd)}、空單 $${U.money(a.shortUsd)}`
          + (partial ? '（尚在輪詢，比例為暫定值）' : '');
        S.fx.bump(g);
      } else g.textContent = '—';
      const vt = $('#vtChain');
      if (vt) vt.textContent = (isFinite(a.ratio) && a.wallets)
        ? `多 ${(a.ratio * 100).toFixed(0)}% / 空 ${((1 - a.ratio) * 100).toFixed(0)}%` : '—';
    }
  };

  /* ── 大戶最擁擠倉位 ───────────────────────────────── */
  C.coinBars = function () {
    const box = $('#coinBars'); if (!box || !HL.agg) return;
    const list = (HL.agg.coins || []).slice(0, 6);
    if (!list.length) { box.innerHTML = '<div class="empty">尚無持倉資料</div>'; return; }
    const key = list.map(c => c.coin + Math.round(c.long / 1e6) + Math.round(c.short / 1e6)).join(',');
    if (box.__key === key) return;
    box.__key = key;
    const max = Math.max.apply(null, list.map(c => c.long + c.short)) || 1;
    box.innerHTML = list.map(c => {
      const tot = c.long + c.short;
      const lp = tot ? c.long / tot : 0;
      const net = c.net >= 0 ? 'bull' : 'bear';
      return `<div class="coin-bar">` +
        `<span class="cb-sym">${c.coin}</span>` +
        `<span class="cb-track">` +
        `<i class="cb-long" style="width:${(lp * 100).toFixed(1)}%"></i>` +
        `<i class="cb-short" style="width:${((1 - lp) * 100).toFixed(1)}%;left:${(lp * 100).toFixed(1)}%"></i>` +
        `</span>` +
        `<span class="cb-val ${net}">淨 ${U.signed(c.net, v => '$' + U.money(Math.abs(v)))}</span>` +
        `<span class="cb-tot">多 $${U.money(c.long)} · 空 $${U.money(c.short)} · ${c.wallets} 錢包</span></div>`;
    }).join('');
    const m = $('#coinMeta');
    if (m) {
      const sc = HL.states.size, tt = HL.wallets.length || 0;
      m.textContent = `依追蹤錢包持倉名目排序 · 多 ${(HL.agg.ratio * 100).toFixed(1)}% / 空 ${((1 - HL.agg.ratio) * 100).toFixed(1)}%`
        + (tt && sc < tt ? ` · 尚在掃描 ${sc}/${tt} 錢包` : ` · ${sc} 個錢包`);
    }
  };

  /* ── 大戶持倉表 ───────────────────────────────────── */
  C.hlTable = function () {
    const tb = $('#hlBody'); if (!tb) return;
    const rows = HL.wallets.map(wl => {
      const st = HL.states.get(wl.addr);
      const pos = st ? st.pos.slice().sort((a, b) => b.notional - a.notional) : null;
      const notional = pos ? pos.reduce((s, p) => s + p.notional, 0) : 0;
      const upnl = pos ? pos.reduce((s, p) => s + (p.upnl || 0), 0) : 0;
      return { wl, st, pos, notional, upnl, top: pos && pos.length ? pos[0] : null };
    }).sort((a, b) => (b.notional - a.notional) || (b.st ? 1 : 0) - (a.st ? 1 : 0));

    const key = rows.map(r => r.wl.addr.slice(0, 8) + (r.st ? '1' : '0') + Math.round(r.notional / 1000)).join(',');
    if (tb.__key !== key) {
      tb.__key = key;
      tb.innerHTML = rows.map(r => {
        const shortA = OC.short(r.wl.addr);
        const hasName = !!(r.wl.name && r.wl.name.length);
        const name = hasName ? r.wl.name : shortA;
        const sub = (r.wl.why || '') + (hasName ? ' · ' + shortA : '');
        const t = r.top;
        const posTxt = t ? `<span class="sidechip ${t.side}">${t.side === 'long' ? '多' : '空'}</span> ${t.coin} ${isFinite(t.lev) ? t.lev + '×' : ''}`
          : (r.st ? '<span class="mini">目前無持倉</span>' : '<span class="mini">掃描中…</span>');
        const upnlCls = r.upnl >= 0 ? 'up' : 'down';
        const roi = r.wl.roi30;
        return `<tr data-addr="${r.wl.addr}">` +
          `<td><div class="nm">${name}</div><div class="why">${sub}</div></td>` +
          `<td>${posTxt}${r.pos && r.pos.length > 1 ? `<span class="mini"> +${r.pos.length - 1}</span>` : ''}</td>` +
          `<td class="ta-r">${r.st ? '$' + U.money(r.notional) : '—'}</td>` +
          `<td class="ta-r ${upnlCls}">${r.st ? U.signed(r.upnl, v => '$' + U.money(Math.abs(v))) : '—'}</td>` +
          `<td class="ta-r ${roi >= 0 ? 'up' : 'down'}">${U.pct(roi, 1)}</td></tr>`;
      }).join('');
      if (!rows.length) tb.innerHTML = '<tr><td colspan="5" class="empty">大戶名單載入中…</td></tr>';
    }
    Array.prototype.forEach.call(tb.querySelectorAll('tr[data-addr]'), tr => {
      tr.onclick = () => C.overlay(tr.dataset.addr, 'hl');
    });
    const meta = $('#hlMeta');
    if (meta) {
      const dt = HL.listAt ? new Date(HL.listAt).toLocaleDateString('zh-TW') : '—';
      const src = S.api.hlSource;
      const base = `已回報 ${HL.states.size}/${HL.wallets.length} 個錢包 · 每 5 秒輪詢 6 個 · 名單 ${dt}`;
      if (src === 'fallback') {
        meta.innerHTML = base + ' · <span style="color:var(--am)">使用內建備援名單</span>'
          + ` <span class="mini">（${S.api.hlNote || '讀取 data/whales.json 失敗'}；改用線上網址或在本機以 python -m http.server 開啟即可自動更新名單）</span>`;
      } else {
        meta.textContent = base + '（每日由 GitHub Actions 自動更新）';
      }
    }
  };

  /* ── 倉位變化事件 ─────────────────────────────────── */
  C.hlEvent = function (e) {
    const box = $('#hlEvents'); if (!box) return;
    const empty = box.querySelector('.empty'); if (empty) empty.remove();
    const row = U.el('div', 'hle ' + e.kind);
    row.innerHTML = `<span class="w">${e.name}</span><span class="d"><b>${e.title}</b> — ${e.text}</span><span class="t">${U.time(e.ts)}</span>`;
    row.onclick = () => C.overlay(e.addr, 'hl');
    box.insertBefore(row, box.firstChild);
    while (box.children.length > 30) box.removeChild(box.lastChild);
    const m = $('#hlEventMeta');
    if (m) m.textContent = `${HL.events.length} 筆事件 · 每 6 秒輪詢 ${HL.wallets.length} 個錢包`;
  };

  /* ── 鏈上大額換幣流 ───────────────────────────────── */
  C.dexTrade = function (t) {
    const box = $('#chainTape'); if (!box) return;
    const empty = box.querySelector('.empty'); if (empty) empty.remove();
    const cls = t.usd >= 1e6 ? 'mega' : t.usd >= 250000 ? 'big' : '';
    const row = U.el('div', 'ctrow ' + t.side + ' ' + cls);
    row.dataset.wallet = t.wallet;
    row.innerHTML = `<span class="t">${U.time(t.ts)}</span><span>${OC.chainLabel(t.chain)}</span>` +
      `<span class="tok" title="${t.token || ''}">${t.tokenSym || '—'}</span>` +
      `<span class="side">${t.side === 'buy' ? '買' : '賣'}</span>` +
      `<span class="amt">$${U.money(t.usd)}</span>` +
      `<span class="wl">${OC.short(t.wallet)}</span>`;
    row.title = `${t.poolName || ''} · ${t.dex || 'DEX'} · 錢包 ${t.wallet} · 價格 $${U.pxSym(t.tokenPrice)}\n點擊查看錢包畫像`;
    row.onclick = () => C.overlay(t.wallet, 'dex', t.chain);
    box.insertBefore(row, box.firstChild);
    while (box.children.length > 60) box.removeChild(box.lastChild);
    if (t.usd >= 250000) S.fx.floatTag(row, (t.side === 'buy' ? '+' : '−') + '$' + U.money(t.usd), t.side === 'buy' ? 'var(--gn)' : 'var(--rd)');
    const cnt = $('#chainCount');
    if (cnt) cnt.textContent = String(DX.trades.length);
  };

  /* ── 聰明錢錢包榜 ─────────────────────────────────── */
  C.wallets = function () {
    const box = $('#walletList'); if (!box) return;
    const list = DX.leaderboard(14);
    if (!list.length) { box.innerHTML = '<div class="empty">累積鏈上錢包資料中…（每個池每輪掃描 1 次）</div>'; return; }
    const key = list.map(x => x.addr.slice(0, 8) + x.score + x.trades).join(',');
    if (box.__key === key) return;
    box.__key = key;
    box.innerHTML = list.map((x, i) => {
      const col = x.cls === 'bull' ? 'var(--gn)' : x.cls === 'bear' ? 'var(--rd)' : 'var(--cy)';
      const f = isFinite(x.followUp) ? `${x.followUp >= 0 ? '+' : ''}${(x.followUp * 100).toFixed(1)}%` : '—';
      return `<div class="wl" data-addr="${x.addr}">` +
        `<span class="rk">${i + 1}</span>` +
        `<div class="info"><div class="r1"><span>${OC.short(x.addr)}</span><em class="${x.cls}">${x.label}</em><span class="mini">${x.trades} 筆 · ${x.tokenCount} 幣</span></div>` +
        `<div class="r2"><span>淨買 ${U.signed(x.netUsd, v => '$' + U.money(Math.abs(v)))}</span>` +
        `<span>總量 $${U.money(x.totalUsd)}</span>` +
        `<span>交易後走勢 ${f}${x.judged ? ` (${x.judged} 筆)` : ''}</span></div></div>` +
        `<span class="sc" style="color:${col}">${x.score}</span>` +
        `<span class="bar"><i style="width:${x.score}%;background:${col}"></i></span></div>`;
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.wl'), el => {
      el.onclick = () => C.overlay(el.dataset.addr, 'dex');
    });
    const m = $('#walletMeta');
    if (m) m.textContent = `評分：規模 28%・方向 16%・交易後走勢 36%・廣度 20% · ${DX.wallets.size} 個錢包`;
  };

  /* ── 協同買入 ─────────────────────────────────────── */
  C.coBuy = function () {
    const box = $('#coBuyList'); if (!box) return;
    const key = DX.coBuy.map(x => x.token + x.wallets).join(',');
    if (box.__key === key) return;
    box.__key = key;
    box.innerHTML = DX.coBuy.slice(0, 8).map(x =>
      `<span class="chip" title="30 分鐘內 ${x.wallets} 個不同錢包共 ${x.n} 筆大額買入，合計 $${U.money(x.usd)} · ${x.poolName || ''}">⚑ ${x.wallets} 錢包同買 ${x.sym} $${U.money(x.usd)}</span>`
    ).join('');
  };

  /* ── 錢包明節 ─────────────────────────────────────── */
  C.overlay = function (addr, kind, chain) {
    const ov = $('#walletOverlay'), card = $('#overlayCard');
    if (!ov || !card || !addr) return;
    const hlW = HL.wallets.find(x => x.addr === addr);
    const st = HL.states.get(addr);
    let html = '';
    if (kind === 'hl' || (kind !== 'dex' && hlW)) {
      const name = (hlW && hlW.name) || OC.short(addr);
      const pos = st ? st.pos.slice().sort((a, b) => b.notional - a.notional) : [];
      const tot = pos.reduce((s, p) => s + p.notional, 0);
      const upnl = pos.reduce((s, p) => s + (p.upnl || 0), 0);
      html += `<h3>${name} <span class="mini">Hyperliquid 大戶錢包</span></h3><div class="addr">${addr}</div>`;
      html += `<div class="ov-grid">
        <div><label>帳戶淨值</label><b>${st ? '$' + U.money(st.value) : '—'}</b></div>
        <div><label>持倉總名目</label><b>${st ? '$' + U.money(tot) : '—'}</b></div>
        <div><label>未實現損益</label><b class="${upnl >= 0 ? 'up' : 'down'}">${st ? U.signed(upnl, v => '$' + U.money(Math.abs(v))) : '—'}</b></div>
        <div><label>月報酬 / 月損益</label><b class="${hlW && hlW.roi30 >= 0 ? 'up' : 'down'}">${hlW ? U.pct(hlW.roi30, 1) + ' · ' + U.signed(hlW.pnl30, v => '$' + U.money(Math.abs(v))) : '—'}</b></div></div>`;
      if (pos.length) {
        html += `<div class="ov-sub">目前持倉（${pos.length}）</div><table class="ov-table"><thead><tr>
          <th>幣種</th><th>方向</th><th>槓桿</th><th>數量</th><th>名目</th><th>進場</th><th>清算價</th><th>未實現</th><th>ROE</th></tr></thead><tbody>`;
        pos.forEach(p => {
          html += `<tr><td>${p.coin}</td><td class="${p.side === 'long' ? 'up' : 'down'}">${p.side === 'long' ? '多' : '空'}</td>` +
            `<td>${isFinite(p.lev) ? p.lev + '×' + (p.levType === 'cross' ? '' : '(逐)') : '—'}</td>` +
            `<td>${U.qty(Math.abs(p.szi))}</td><td>$${U.money(p.notional)}</td><td>${U.pxSym(p.entry)}</td>` +
            `<td>${isFinite(p.liq) && p.liq > 0 ? U.pxSym(p.liq) : '—'}</td>` +
            `<td class="${p.upnl >= 0 ? 'up' : 'down'}">${U.signed(p.upnl, v => '$' + U.money(Math.abs(v)))}</td>` +
            `<td class="${p.roe >= 0 ? 'up' : 'down'}">${U.pct(p.roe * 100, 1)}</td></tr>`;
        });
        html += '</tbody></table>';
      } else {
        html += '<div class="empty">目前沒有未平倉部位（可能是現貨/金庫帳戶或已空倉）</div>';
      }
      const ev = HL.events.filter(e => e.addr === addr).slice(0, 8);
      if (ev.length) {
        html += `<div class="ov-sub">偵測到的倉位變化</div>` + ev.map(e => `<div class="hle ${e.kind}"><span class="d"><b>${e.title}</b> — ${e.text}</span><span class="t">${U.time(e.ts)}</span></div>`).join('');
      }
      html += `<div class="ov-actions"><a href="https://app.hyperliquid.xyz/explorer/address/${addr}" target="_blank" rel="noopener">Hyperliquid 區塊瀏覽器 ↗</a>
        <button data-copy="${addr}">複製地址</button><button id="ovClose">關閉</button></div>`;
    } else {
      const pr = DX.profile(addr);
      if (!pr) { html = '<div class="empty">此錢包尚無足夠資料</div>'; return; }
      const f = isFinite(pr.followUp) ? `${pr.followUp >= 0 ? '+' : ''}${(pr.followUp * 100).toFixed(1)}%` : '—';
      html += `<h3>${OC.short(addr)} <span class="mini">鏈上錢包畫像</span></h3><div class="addr">${addr}</div>`;
      html += `<div class="ov-grid">
        <div><label>聰明錢評分</label><b>${pr.score}</b></div>
        <div><label>標籤</label><b>${pr.label}</b></div>
        <div><label>大額買 / 賣</label><b><span class="up">$${U.money(pr.buyUsd)}</span> / <span class="down">$${U.money(pr.sellUsd)}</span></b></div>
        <div><label>淨流向</label><b class="${pr.netUsd >= 0 ? 'up' : 'down'}">${U.signed(pr.netUsd, v => '$' + U.money(Math.abs(v)))}</b></div>
        <div><label>交易後價格變化</label><b class="${pr.followUp >= 0 ? 'up' : 'down'}">${f}</b></div>
        <div><label>命中率（觀察值）</label><b>${isFinite(pr.winRate) ? (pr.winRate * 100).toFixed(0) + '%' : '—'}</b></div>
        <div><label>最大單筆</label><b>$${U.money(pr.maxUsd)}</b></div>
        <div><label>活躍鏈 / 代幣</label><b>${pr.chains.map(OC.chainLabel).join('、')} · ${pr.tokenCount}</b></div></div>`;
      html += `<div class="ov-sub">近期大額交易（${pr.trades.length} 筆）</div><table class="ov-table"><thead><tr>
        <th>時間</th><th>鏈</th><th>代幣</th><th>方向</th><th>金額</th><th>成交價</th><th>交易</th></tr></thead><tbody>`;
      DX.wallets.get(addr).trades.slice(0, 12).forEach(t => {
        html += `<tr><td>${U.timeShort(t.ts)}</td><td>${OC.chainLabel(t.chain)}</td><td>${t.tokenSym || '—'}</td>` +
          `<td class="${t.side === 'buy' ? 'up' : 'down'}">${t.side === 'buy' ? '買' : '賣'}</td><td>$${U.money(t.usd)}</td>` +
          `<td>$${U.pxSym(t.tokenPrice)}</td><td><a href="https://${t.chain === 'solana' ? 'solscan.io/tx/' : (t.chain === 'bsc' ? 'bscscan.com/tx/' : t.chain === 'base' ? 'basescan.org/tx/' : 'etherscan.io/tx/') + t.tx}" target="_blank" rel="noopener" style="color:var(--cy)">${(t.tx || '').slice(0, 10)}…</a></td></tr>`;
      });
      html += '</tbody></table>';
      const tokens = pr.tokens.map(t => `<span class="chip" style="border-color:var(--line-2);color:var(--cy);background:rgba(56,246,255,.08)">${t.sym} $${U.money(t.usd)}</span>`).join(' ');
      html += `<div class="ov-sub">主要交易代幣</div><div class="cobuy">${tokens}</div>`;
      const ch = chain || (pr.chains[0] || 'eth');
      html += `<div class="ov-actions"><a href="${OC.explorer(ch, addr)}" target="_blank" rel="noopener">${OC.chainLabel(ch)} 區塊瀏覽器 ↗</a>
        <button data-copy="${addr}">複製地址</button><button id="ovClose">關閉</button></div>`;
    }
    card.innerHTML = html;
    ov.hidden = false;
    const close = () => { ov.hidden = true; };
    const cl = $('#ovClose'); if (cl) cl.onclick = close;
    ov.onclick = e => { if (e.target === ov) close(); };
    Array.prototype.forEach.call(card.querySelectorAll('[data-copy]'), b => {
      b.onclick = () => {
        const t = b.dataset.copy;
        (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(
          () => { b.textContent = '已複製 ✓'; setTimeout(() => b.textContent = '複製地址', 1500); },
          () => { b.textContent = '複製失敗'; });
      };
    });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
  };

  C.render = function () { C.agg(); C.coinBars(); C.hlTable(); C.wallets(); C.coBuy(); };
  C.dexMeta = function () {
    const d = DX, g = S.api.gtStats || { calls: 0, cools: 0 };
    const m = $('#dexMeta');
    if (m) m.textContent = `${OC.chainLabel(d.chain)} · ${d.pools.length} 個熱門池 · 每輪掃 1 池（限流）· 門檻 ≥$${U.money(d.min)} · 已收 ${d.trades.length} 筆 · 掃描 ${d.calls} 輪`;
    const cm = $('#chainMeta');
    if (cm) {
      const down = g.cooling;
      const fb = S.api.hlSource === 'fallback';
      cm.textContent = down
        ? `鏈上 API 冷卻中（GeckoTerminal 免費層限流）· 已收 ${d.trades.length} 筆 · 冷卻結束自動續掃`
        : `${OC.chainLabel(d.chain)} ${d.pools.length} 池 · DEX ${d.trades.length} 筆 · 錢包 ${d.wallets.size} 個 · 大戶倉位 ${HL.states.size}/${HL.wallets.length}`
          + (fb ? ' · 名單：內建備援' : '');
      cm.style.color = down ? 'var(--am)' : '';
      cm.title = fb ? ('目前使用內建備援大戶名單：' + (S.api.hlNote || '') + '\n用線上網址開啟，或在本機執行 python -m http.server 後以 http://localhost 開啟，即可載入完整且每日更新的名單。') : '';
    }
  };
})(window);
