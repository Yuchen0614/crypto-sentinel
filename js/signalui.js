/* signalui.js — 帶單頁的畫面渲染（只讀 S.signals 的狀態，不改資料）
   元素 id 一律以 sg 開頭，避免與主控台／鏈上頁的樣式與邏輯互相干擾。 */
(function (w) {
  'use strict';
  const S = w.SENTINEL, U = S.util, OC = S.onchain, SG = S.signals;
  const G = S.signalUI = {};
  const $ = s => document.querySelector(s);

  const dur = ms => {
    if (!isFinite(ms) || ms <= 0) return '—';
    const m = ms / 60000;
    if (m < 60) return m < 1 ? '<1 分' : Math.round(m) + ' 分';
    const h = m / 60;
    if (h < 24) return h.toFixed(h < 10 ? 1 : 0) + ' 小時';
    return (h / 24).toFixed(1) + ' 天';
  };
  const money2 = v => U.signed(v, x => '$' + U.money(Math.abs(x)));
  const pct = v => isFinite(v) ? (v * 100 >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%' : '—';
  const cls = v => !isFinite(v) ? '' : (v > 0 ? 'up' : v < 0 ? 'down' : '');
  const when = ts => { const d = new Date(ts); return d.toLocaleTimeString('zh-TW', { hour12: false }); };
  const day = ts => { const d = new Date(ts); return d.toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' }); };
  const shortN = (addr, name) => name || OC.short(addr);

  /* ── 上方績效卡 ───────────────────────────────────────── */
  G.kpi = function (st) {
    U.text('#sgRounds', U.fmt(st.closed + st.openFresh));
    U.text('#sgRoundsSub', '已平倉 ' + st.closed + ' · 本次開倉 ' + st.openFresh
      + ' · 載入時既有持倉 ' + st.openPre + ' · 即時追蹤平倉 ' + st.tracked);
    U.text('#sgSim', money2(st.totalSim));
    const se = $('#sgSim'); if (se) se.className = cls(st.totalSim);
    U.text('#sgSimSub', '樣本 ' + st.simSample + ' 筆 · 每筆模擬 ' + U.usd(SG.cfg.copyNotional));
    U.text('#sgReal', money2(st.totalReal));
    const re = $('#sgReal'); if (re) re.className = cls(st.totalReal);
    U.text('#sgRealSub', '樣本 ' + st.realSample + ' 筆（來自 Hyperliquid 成交 closedPnl）');
    U.text('#sgWin', isFinite(st.winRate) ? (st.winRate * 100).toFixed(1) + '%' : '—');
    U.text('#sgWinSub', st.wins + ' 勝 / ' + st.loses + ' 負 · 模擬跟單 ' + (isFinite(st.winRateSim) ? (st.winRateSim * 100).toFixed(1) + '%' : '—'));
    U.text('#sgHold', dur(st.avgHold));
    U.text('#sgBest', st.best ? money2(st.best.realUsd) : '—');
    const be = $('#sgBest'); if (be && st.best) be.className = cls(st.best.realUsd);
    const ws = $('#sgWorst');
    if (ws) {
      ws.textContent = st.worst ? ('最差 ' + st.worst.coin + ' ' + money2(st.worst.realUsd)) : '樣本累積中';
      ws.className = 'mini ' + (st.worst ? cls(st.worst.realUsd) : '');
    }
    U.text('#sgEqMeta', '依平倉時間累計 · 最近 ' + (st.rows.length ? day(Math.max.apply(null, st.rows.map(r => r.closedAt))) : '—'));
  };

  /* ── 累計盈虧曲線（兩條線：模擬跟單 / 錢包實際）────────── */
  G.equity = function (st) {
    const cv = $('#sgEquity'); if (!cv) return;
    const f = S.fit(cv); if (!f) return;
    const { c, w: W, h: H } = f;
    c.clearRect(0, 0, W, H);
    const pad = { l: 52, r: 10, t: 12, b: 18 };
    const cur = st.curve || [];
    if (cur.length < 2) {
      c.fillStyle = 'rgba(152,162,179,.6)'; c.font = '12px "JetBrains Mono",monospace';
      c.fillText('累積資料中…（需要至少兩筆平倉記錄）', 12, H / 2);
      return;
    }
    const vals = cur.reduce((a, p) => a.concat([p.sim, p.real]), []);
    let mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
    if (mn > 0) mn = 0; if (mx < 0) mx = 0;
    const padV = (mx - mn) * 0.12 || Math.max(1, Math.abs(mx) * 0.1);
    mn -= padV; mx += padV;
    const X = i => pad.l + (W - pad.l - pad.r) * (cur.length === 1 ? .5 : i / (cur.length - 1));
    const Y = v => pad.t + (H - pad.t - pad.b) * (1 - (v - mn) / (mx - mn || 1));
    // 水平格線 + 金額刻度
    c.strokeStyle = 'rgba(255,255,255,.07)'; c.lineWidth = 1; c.font = '10px "JetBrains Mono",monospace';
    for (let i = 0; i <= 4; i++) {
      const v = mn + (mx - mn) * i / 4, y = Math.round(Y(v)) + .5;
      c.beginPath(); c.moveTo(pad.l, y); c.lineTo(W - pad.r, y); c.stroke();
      c.fillStyle = 'rgba(107,116,128,.9)'; c.textAlign = 'right';
      c.fillText((v >= 0 ? '+' : '−') + '$' + U.money(Math.abs(v)), pad.l - 6, y + 3.5);
    }
    // 0 線
    const y0 = Math.round(Y(0)) + .5;
    c.strokeStyle = 'rgba(255,255,255,.22)'; c.beginPath(); c.moveTo(pad.l, y0); c.lineTo(W - pad.r, y0); c.stroke();
    const line = (key, color) => {
      c.beginPath(); c.lineWidth = 1.6; c.strokeStyle = color;
      cur.forEach((p, i) => { const x = X(i), y = Y(p[key]); i ? c.lineTo(x, y) : c.moveTo(x, y); });
      c.stroke();
      // 末端點
      const last = cur[cur.length - 1];
      c.beginPath(); c.arc(X(cur.length - 1), Y(last[key]), 2.4, 0, 6.2832); c.fillStyle = color; c.fill();
    };
    line('real', '#0ecb81');
    line('sim', '#4d8dff');
    // 時間標籤
    c.fillStyle = 'rgba(107,116,128,.9)'; c.textAlign = 'left';
    c.fillText(day(cur[0].t), pad.l, H - 5);
    c.textAlign = 'right'; c.fillText(day(cur[cur.length - 1].t), W - pad.r, H - 5);
  };

  /* ── 開倉中（未實現）──────────────────────────────────── */
  G.open = function (minNotional) {
    const list = SG.openPositions(minNotional);
    const body = $('#sgOpenBody'); if (!body) return;
    U.text('#sgOpenMeta', list.length + ' 個持倉 ≥ ' + U.usd(minNotional) + ' · 依名目排序');
    if (!list.length) { body.innerHTML = '<tr><td colspan="10" class="empty">目前沒有符合門檻的持倉（或持倉資料還在載入）</td></tr>'; return; }
    body.innerHTML = list.slice(0, 40).map(p => {
      const held = p.openedAt ? dur(Date.now() - p.openedAt) : '—';
      return `<tr class="sg-row" data-addr="${p.addr}">
        <td class="w"><span class="nm">${shortN(p.addr, p.name)}</span>${p.name ? '<span class="mini">' + OC.short(p.addr) + '</span>' : ''}</td>
        <td><b>${p.coin}</b></td>
        <td><span class="sidechip ${p.side}">${p.side === 'long' ? '多' : '空'}</span>${isFinite(p.lev) ? ' <span class="mini">' + p.lev + '×</span>' : ''}</td>
        <td class="ta-r">${U.px(p.entryPx)}</td>
        <td class="ta-r">${U.px(p.mark)}</td>
        <td class="ta-r">$${U.money(p.notional)}</td>
        <td class="ta-r ${cls(p.upnl)}">${money2(p.upnl)}</td>
        <td class="ta-r ${cls(p.sim)}"><b>${money2(p.sim)}</b></td>
        <td class="ta-r ${cls(p.simPct)}">${pct(p.simPct)}</td>
        <td class="ta-r mini">${held}${p.adds ? ' · 加' + p.adds : ''}${p.cuts ? ' · 減' + p.cuts : ''}</td>
      </tr>`;
    }).join('');
  };

  /* ── 帶單流水 ─────────────────────────────────────────── */
  const KIND = { OPEN: '開倉', ADD: '加碼', CUT: '減碼', CLOSE: '平倉', FLIP: '翻倉' };
  G.feed = function () {
    const box = $('#sgFeed'); if (!box) return;
    const list = SG.events.slice(0, 60);
    U.text('#sgFeedMeta', SG.events.length + ' 筆事件' + (SG.since ? ' · 自 ' + day(SG.since) + ' ' + when(SG.since) : ''));
    if (!list.length) { box.innerHTML = '<div class="empty">等待大戶開倉／平倉…（每 5 秒輪詢持倉）</div>'; return; }
    const key = list.slice(0, 8).map(e => e.ts + e.kind).join(',') + '|' + list.length;
    if (box.__key === key) return;
    box.__key = key;
    box.innerHTML = list.map(e => {
      const side = e.side === 'long' ? '多' : '空';
      const pnl = isFinite(e.simUsd) ? '<b class="' + cls(e.simUsd) + '">' + money2(e.simUsd) + '</b>' : '';
      const d = isFinite(e.delta) ? '<span class="mini">' + U.signed(e.delta, v => '$' + U.money(Math.abs(v))) + '</span>' : '';
      return `<div class="sge k-${e.kind}" data-addr="${e.addr}">
        <span class="t">${when(e.ts)}</span>
        <span class="k">${KIND[e.kind] || e.kind}</span>
        <span class="w">${shortN(e.addr, e.name)}</span>
        <span class="c"><b>${e.coin}</b> <span class="sidechip ${e.side}">${side}</span></span>
        <span class="d">${e.text || ''} ${d} ${pnl}</span>
      </div>`;
    }).join('');
  };

  /* ── 平倉帳本 ─────────────────────────────────────────── */
  G.ledger = function (st) {
    const body = $('#sgLedgerBody'); if (!body) return;
    const rows = st.rows.slice().sort((a, b) => b.closedAt - a.closedAt).slice(0, 300);
    U.text('#sgLedgerMeta', st.rows.length + ' 筆（門檻 ≥ ' + U.usd(SG.cfg.minNotional) + '）· 顯示最新 ' + rows.length + ' 筆');
    if (!rows.length) { body.innerHTML = '<tr><td colspan="12" class="empty">還沒有平倉記錄。載入中會先抓最近的成交紀錄，之後持續累積。</td></tr>'; return; }
    body.innerHTML = rows.map(r => {
      const srcTag = r.src === 'track' ? '<span class="srcT">即時追蹤</span>' : '<span class="srcF">成交聚合</span>';
      const warn = (r.realSrc === 'capped' || r.partial) ? ' <span class="mini" title="此錢包該時段成交超過 2000 筆或進場資料不完整，數字可能低估">⚠</span>' : '';
      return `<tr class="sg-row" data-addr="${r.addr}">
        <td class="mini">${day(r.closedAt)} ${when(r.closedAt)}</td>
        <td class="w"><span class="nm">${shortN(r.addr, r.name)}</span>${r.name ? '<span class="mini">' + OC.short(r.addr) + '</span>' : ''}</td>
        <td><b>${r.coin}</b></td>
        <td><span class="sidechip ${r.side}">${r.side === 'long' ? '多' : '空'}</span></td>
        <td class="ta-r">${isFinite(r.entryPx) ? U.px(r.entryPx) : '—'}</td>
        <td class="ta-r">${isFinite(r.exitPx) ? U.px(r.exitPx) : '—'}</td>
        <td class="ta-r">$${U.money(r.notional)}</td>
        <td class="ta-r ${cls(r.realUsd)}"><b>${money2(r.realUsd)}</b>${warn}</td>
        <td class="ta-r ${cls(r.simUsd)}">${money2(r.simUsd)}</td>
        <td class="ta-r ${cls(r.realPct)}">${pct(r.realPct)}</td>
        <td class="ta-r mini">${dur(r.holdMs)}</td>
        <td class="mini">${srcTag}${r.fills > 1 ? ' <span class="mini">×' + r.fills + '</span>' : ''}</td>
      </tr>`;
    }).join('');
  };

  /* ── 錢包績效排行 ─────────────────────────────────────── */
  G.walletPerf = function (st) {
    const box = $('#sgWalletPerf'); if (!box) return;
    const list = st.wallets.slice(0, 12);
    if (!list.length) { box.innerHTML = '<div class="empty">累積記錄中…</div>'; return; }
    const max = Math.max.apply(null, list.map(x => Math.abs(x.real))) || 1;
    box.innerHTML = list.map((x, i) => {
      const w = Math.round(Math.abs(x.real) / max * 100);
      const neg = x.real < 0;
      return `<div class="wl-perf" data-addr="${x.addr}">
        <span class="rk">${i + 1}</span>
        <div class="info">
          <div class="r1"><span class="nm">${shortN(x.addr, x.name)}</span>
            <span class="mini">${x.n} 筆 · 勝率 ${isFinite(x.winRate) ? (x.winRate * 100).toFixed(0) + '%' : '—'}${x.track ? ' · 即時追蹤 ' + x.track : ''}</span></div>
          <div class="bar"><i class="${neg ? 'neg' : 'pos'}" style="width:${w}%"></i></div>
          <div class="r2"><span class="${cls(x.real)}">實際 ${money2(x.real)}</span><span class="${cls(x.sim)}">模擬 ${money2(x.sim)}</span></div>
        </div>
      </div>`;
    }).join('');
  };

  /* ── 每日績效快照（伺服器端，較耐久）──────────────────── */
  G.daily = function () {
    const box = $('#sgDaily'); if (!box) return;
    const d = SG.pnlDaily;
    if (!d || !d.wallets) { box.innerHTML = '<div class="empty">尚無伺服器快照（每日自動產生，第一次會在隔天出現）</div>'; return; }
    U.text('#sgDailyMeta', '截至 ' + String(d.generated_at || '').slice(0, 10) + ' · 近 ' + (d.window_hours || 24) + ' 小時');
    const rows = d.wallets.slice().sort((a, b) => b.realized_usd - a.realized_usd).slice(0, 14);
    box.innerHTML = '<div class="dh"><span>錢包</span><span class="ta-r">已實現</span><span class="ta-r">交易</span><span class="ta-r">勝率</span></div>' +
      rows.map(x => `<div class="dr" data-addr="${x.addr}">
        <span class="nm">${x.name || OC.short(x.addr)}<span class="mini">${OC.short(x.addr)}</span></span>
        <span class="ta-r ${cls(x.realized_usd)}">${money2(x.realized_usd)}${x.stale ? ' <span class="mini" title="這次抓取失敗，沿用上一次快照">*</span>' : ''}${x.capped ? ' <span class="mini" title="該期間成交超過單次 2000 筆上限，數字可能低估">⚠</span>' : ''}</span>
        <span class="ta-r mini">${x.closes || 0}</span>
        <span class="ta-r mini">${isFinite(x.win_rate) ? (x.win_rate * 100).toFixed(0) + '%' : '—'}</span>
      </div>`).join('') +
      `<div class="mini" style="padding:6px 10px">全體：${d.wallets.length} 個錢包 · 已實現合計 ${money2(d.total_realized)} · 平倉 ${d.total_closes || 0} 筆</div>`;
  };

  /* ── 設定列 ───────────────────────────────────────────── */
  G.settings = function () {
    const cp = $('#sgCopyVal'); if (cp) cp.textContent = U.usd(SG.cfg.copyNotional);
    const mn = $('#sgMinVal'); if (mn) mn.textContent = U.usd(SG.cfg.minNotional);
    const note = $('#sgNote');
    if (note) {
      note.innerHTML = '每筆模擬跟單固定 <b>' + U.usd(SG.cfg.copyNotional) + '</b> 名目，扣雙邊估算手續費 '
        + (SG.cfg.feeRate * 100).toFixed(2) + '%。這是<b>紙上計算</b>，不會下任何單。'
        + (SG.since ? '<br>本帳本自 ' + day(SG.since) + ' ' + when(SG.since) + ' 起累積（記錄存在瀏覽器，清快取會消失；長期請看每日快照）。' : '');
    }
  };

  G.all = function () {
    const st = SG.stats({ minNotional: 0 });
    G.kpi(st); G.equity(st); G.open(SG.cfg.minNotional);
    G.feed(); G.ledger(st); G.walletPerf(st); G.daily(); G.settings();
  };

  /* ── 錢包明細（點任一列開啟）────────────────────────── */
  G.walletModal = function (addr) {
    const ov = $('#sgOverlay'), card = $('#sgOverlayCard');
    if (!ov || !card) return;
    const meta = OC.hl.wallets.find(x => x.addr === addr) || {};
    const name = meta.name || '';
    const st = SG.stats({ minNotional: 0 });
    const w = st.wallets.find(x => x.addr === addr) || { n: 0, sim: 0, real: 0, wins: 0, loses: 0, winRate: NaN };
    const rows = st.rows.filter(r => r.addr === addr).sort((a, b) => b.closedAt - a.closedAt).slice(0, 25);
    const open = SG.openPositions(SG.cfg.minNotional).filter(x => x.addr === addr);
    const hl = 'https://app.hyperliquid.xyz/explorer/address/' + addr;
    card.innerHTML = `
      <div class="ov-head">
        <div>
          <h3>${name || '大戶錢包'} ${name ? '<span class="mini">' + OC.short(addr) + '</span>' : OC.short(addr)}</h3>
          <div class="addr">${addr}</div>
        </div>
        <button class="ghost" id="sgOvClose">關閉</button>
      </div>
      <div class="sg-ov-kv">
        <div><label>平倉記錄</label><b>${w.n} 筆</b></div>
        <div><label>實際已實現</label><b class="${cls(w.real)}">${money2(w.real)}</b></div>
        <div><label>模擬跟單</label><b class="${cls(w.sim)}">${money2(w.sim)}</b></div>
        <div><label>勝率</label><b>${isFinite(w.winRate) ? (w.winRate * 100).toFixed(1) + '%' : '—'}</b></div>
        <div><label>開倉中</label><b>${open.length} 個</b></div>
      </div>
      ${open.length ? `<h4>目前持倉（≥ ${U.usd(SG.cfg.minNotional)}）</h4>
      <table class="sg"><thead><tr><th>幣種</th><th>方向</th><th class="ta-r">進場</th><th class="ta-r">名目</th><th class="ta-r">未實現</th><th class="ta-r">模擬跟單</th></tr></thead><tbody>
      ${open.map(p => `<tr><td><b>${p.coin}</b></td><td><span class="sidechip ${p.side}">${p.side === 'long' ? '多' : '空'}</span></td>
        <td class="ta-r">${U.px(p.entryPx)}</td><td class="ta-r">$${U.money(p.notional)}</td>
        <td class="ta-r ${cls(p.upnl)}">${money2(p.upnl)}</td><td class="ta-r ${cls(p.sim)}">${money2(p.sim)}</td></tr>`).join('')}
      </tbody></table>` : ''}
      <h4>平倉記錄（最新 ${rows.length} 筆）</h4>
      <table class="sg"><thead><tr><th>平倉時間</th><th>幣種</th><th>方向</th><th class="ta-r">進場</th><th class="ta-r">出場</th><th class="ta-r">名目</th><th class="ta-r">實際盈虧</th><th class="ta-r">模擬</th><th>來源</th></tr></thead><tbody>
      ${rows.length ? rows.map(r => `<tr><td class="mini">${day(r.closedAt)} ${when(r.closedAt)}</td><td><b>${r.coin}</b></td>
        <td><span class="sidechip ${r.side}">${r.side === 'long' ? '多' : '空'}</span></td>
        <td class="ta-r">${isFinite(r.entryPx) ? U.px(r.entryPx) : '—'}</td><td class="ta-r">${isFinite(r.exitPx) ? U.px(r.exitPx) : '—'}</td>
        <td class="ta-r">$${U.money(r.notional)}</td><td class="ta-r ${cls(r.realUsd)}"><b>${money2(r.realUsd)}</b></td>
        <td class="ta-r ${cls(r.simUsd)}">${money2(r.simUsd)}</td><td class="mini">${r.src === 'track' ? '即時追蹤' : '成交聚合'}</td></tr>`).join('')
        : '<tr><td colspan="9" class="empty">這個錢包還沒有平倉記錄</td></tr>'}
      </tbody></table>
      <div class="ov-actions"><a href="${hl}" target="_blank" rel="noopener">在 Hyperliquid 檢視 ↗</a></div>`;
    ov.hidden = false;
    const close = card.querySelector('#sgOvClose');
    if (close) close.addEventListener('click', () => { ov.hidden = true; });
    if (!ov.__bound) {
      ov.__bound = true;
      ov.addEventListener('click', e => { if (e.target === ov) ov.hidden = true; });
      document.addEventListener('keydown', e => { if (e.key === 'Escape') ov.hidden = true; });
    }
  };

  /* 視窗大小改變時重畫曲線 */
  w.addEventListener('resize', U.debounce(() => G.equity(SG.stats({ minNotional: 0 })), 250));
})(window);
