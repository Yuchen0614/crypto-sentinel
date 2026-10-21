/* signalsboot.js — 帶單頁的啟動與輪詢
   ─────────────────────────────────────────────────────────────
   這一頁刻意不載入 chainui / chainboot：不需要 DEX 掃描（保留 GeckoTerminal 額度），
   只要「持倉輪詢 → 回合追蹤」與「成交輪詢 → 真實盈虧」。

   請求節奏（總計約 70 次/分，與鏈上頁相同等級）：
     * 持倉：每 6 秒 4 個錢包（52 個約 80 秒輪完一輪）
     * 成交：每 2 秒 1 個錢包，只追蹤名單前段（預設 16 個），每個約 32 秒刷新一次
     * 標記價（allMids）：每 5 秒一次
*/
(function (w) {
  'use strict';
  const S = w.SENTINEL, U = S.util, OC = S.onchain, SG = S.signals, G = S.signalUI;
  const SB = S.signalsBoot = { started: false, posIdx: 0, fillIdx: 0, seeded: 0, fillsAdded: 0, lastSave: 0 };

  SG.cfg.fillsWallets = SG.cfg.fillsWallets || 16;
  SG.cfg.posBatch = SG.cfg.posBatch || 4;
  SG.cfg.fillEveryMs = SG.cfg.fillEveryMs || 2000;
  SG.cfg.fillWindowMs = SG.cfg.fillWindowMs || 6 * 60e3;

  const nameOf = addr => { const m = OC.hl.wallets.find(x => x.addr === addr); return m ? (m.name || '') : ''; };
  const tick = n => { const e = document.getElementById('sgTicker'); if (e) e.innerHTML = '<span>' + n + '</span>'; };

  /* ── 事件：持倉快照 → 回合追蹤 ───────────────────────── */
  function wire() {
    S.on('hl-state', addr => {
      const s = OC.hl.states.get(addr);
      if (s) SG.observePosition(addr, s, nameOf(addr));
    });
    S.on('sig-event', e => {
      if (e.kind === 'OPEN' || e.kind === 'CLOSE' || e.kind === 'FLIP') G.feed();
    });
  }

  /* ── 持倉輪詢（自己來，不透過 chainboot）─────────────── */
  async function pollPositions() {
    const batch = OC.hl.nextBatch(SG.cfg.posBatch);
    await Promise.all(batch.map(wl => S.api.hlState(wl.addr).then(st => { if (st) OC.hl.ingest(wl.addr, st); })));
  }

  /* ── 成交輪詢（增量）────────────────────────────────── */
  async function pollFills() {
    const ws = OC.hl.wallets.slice(0, SG.cfg.fillsWallets);
    if (!ws.length) return;
    const wl = ws[SB.fillIdx % ws.length];
    SB.fillIdx++;
    const since = Date.now() - SG.cfg.fillWindowMs;
    const fills = await S.api.hlFills(wl.addr, since);
    if (!fills) return;
    const n = SG.ingestFills(wl.addr, fills, nameOf(wl.addr));
    SB.fillsAdded += n;
  }

  /* 補齊「已平倉但還沒拿到真實盈虧」的回合（每輪最多 2 個） */
  async function resolvePending() {
    const pend = SG.rounds.filter(r => r.status === 'closed' && r.realSrc === 'pending').slice(-2);
    for (const r of pend) await SG.attachReal(r);
  }

  /* ── 首次載入：抓最近幾分鐘成交，讓帳本立刻有內容 ─────── */
  async function seed() {
    const ws = OC.hl.wallets.slice(0, SG.cfg.seedWallets);
    const since = Date.now() - SG.cfg.seedMinutes * 60e3;
    for (const wl of ws) {
      const fills = await S.api.hlFills(wl.addr, since);
      if (fills) { SG.ingestFills(wl.addr, fills, nameOf(wl.addr)); SB.seeded++; }
      SG.prune();
      G.all();
      await new Promise(r => setTimeout(r, 600));
    }
    SG.save();
  }

  /* ── 設定列 ─────────────────────────────────────────── */
  function settingsUI() {
    const wireSeg = (sel, attr, fn) => {
      const el = document.querySelector(sel); if (!el) return;
      el.addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        Array.prototype.forEach.call(b.parentNode.children, x => x.classList.toggle('on', x === b));
        fn(+b.dataset[attr]);
        G.all();
      });
    };
    wireSeg('#sgCopySeg', 'copy', v => { SG.cfg.copyNotional = v; SG.save(); });
    wireSeg('#sgMinSeg', 'min', v => { SG.cfg.minNotional = v; SG.save(); });

    const ex = document.getElementById('sgExport');
    if (ex) ex.addEventListener('click', () => {
      const rows = SG.stats({ minNotional: 0 }).rows.slice().sort((a, b) => b.closedAt - a.closedAt).slice(0, 300);
      const csv = SG.toCSV({ minNotional: 0 });
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'sentinel-signals-' + new Date().toISOString().slice(0, 10) + '.csv';
      document.body.appendChild(a); a.click(); a.remove();
      U.text('#sgTicker', '已匯出 ' + rows.length + ' 筆平倉記錄（CSV）');
    });

    const cl = document.getElementById('sgClear');
    if (cl) cl.addEventListener('click', () => {
      if (!confirm('確定要清除本機的帶單帳本嗎？（伺服器端的每日快照不受影響）')) return;
      SG.clear(); G.all(); tick('已清除本機記錄');
    });

    /* 點錢包 → 看該錢包的明細 */
    document.addEventListener('click', e => {
      const row = e.target.closest('[data-addr]');
      if (row && document.getElementById('sgOverlay')) G.walletModal(row.dataset.addr);
    });
  }

  /* ── 啟動 ───────────────────────────────────────────── */
  async function main() {
    SG.load();
    wire();
    settingsUI();
    G.all();

    // 每日績效快照（伺服器端，可能還不存在）
    fetch('data/pnl-daily.json', { cache: 'no-cache' })
      .then(r => r.ok ? r.json() : null).then(d => { if (d) { SG.pnlDaily = d; G.daily(); } })
      .catch(() => { });

    await S.api.hlWhales().then(d => { if (d) OC.hl.setWallets(d); });
    G.all();

    const clock = () => {
      const d = new Date();
      const c = document.getElementById('sgClock'), t = document.getElementById('sgDate');
      if (c) c.textContent = d.toLocaleTimeString('zh-TW', { hour12: false });
      if (t) t.textContent = '台北 · ' + d.toLocaleDateString('zh-TW');
    };
    clock(); setInterval(clock, 1000);

    seed();

    // 標記價（算未實現損益）
    const mids = async () => { const m = await S.api.hlMids(); if (m) { SG.setMids(m); } };
    mids(); setInterval(mids, 5000);

    // 持倉輪詢
    const prime = OC.hl.wallets.slice(0, 24);
    (async () => {
      for (let i = 0; i < prime.length; i += 4) {
        await Promise.all(prime.slice(i, i + 4).map(wl => S.api.hlState(wl.addr).then(st => { if (st) OC.hl.ingest(wl.addr, st); })));
        G.all();
        await new Promise(r => setTimeout(r, 200));
      }
    })();
    setInterval(() => { if (!document.hidden) pollPositions(); else pollPositions(); }, 6000);

    // 成交增量輪詢 + 補真實盈虧
    setInterval(() => pollFills(), SG.cfg.fillEveryMs);
    setInterval(() => resolvePending(), 20000);

    // 畫面（背景分頁降頻但不停更）
    const hdr = document.getElementById('sgListMeta');
    let t = 0;
    setInterval(() => {
      t++;
      if (document.hidden && t % 5 !== 0) return;
      G.all();
      if (hdr) {
        const s2 = SG.stats({ minNotional: 0 });
        hdr.innerHTML = '追蹤 <b>' + OC.hl.wallets.length + '</b> 個大戶 · 已取得持倉 ' + OC.hl.states.size
          + ' 個 · 帳本 <b>' + s2.rows.length + '</b> 筆平倉' + (SG.since ? '（自 ' + new Date(SG.since).toLocaleString('zh-TW', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) + '）' : '');
      }
    }, 1500);

    // 定期保存 + 狀態列
    setInterval(() => {
      SG.save();
      const st = SG.stats({ minNotional: 0 });
      const msgs = [
        '本帳本：已記錄 ' + st.rows.length + ' 筆平倉 · 開倉中 ' + SG.openPositions(SG.cfg.minNotional).length + ' 個持倉 ≥ ' + U.usd(SG.cfg.minNotional),
        '模擬跟單累計 ' + U.signed(st.totalSim, v => '$' + U.money(Math.abs(v))) + '（每筆 ' + U.usd(SG.cfg.copyNotional) + ' 名目）· 錢包實際已實現 ' + U.signed(st.totalReal, v => '$' + U.money(Math.abs(v))),
        '追蹤 ' + OC.hl.wallets.length + ' 個大戶錢包 · 成交樣本 ' + SB.fillsAdded + ' 筆 · 真實盈虧取自 Hyperliquid 成交 closedPnl',
        '記錄存在這台裝置的瀏覽器；長期保存請用「匯出 CSV」或看每日績效快照'
      ];
      tick(msgs[Math.floor(Date.now() / 6000) % msgs.length]);
    }, 3000);

    // 診斷（自動化檢查用）
    w.__SENTINEL_STATUS = () => {
      const st = SG.stats({ minNotional: 0 });
      return {
        page: 'signals',
        wallets: OC.hl.wallets.length, states: OC.hl.states.size,
        rounds: SG.rounds.length, closed: st.closed, open: st.open, tracked: st.tracked,
        seeded: SB.seeded, fillsAdded: SB.fillsAdded, events: SG.events.length,
        totalSim: Math.round(st.totalSim), totalReal: Math.round(st.totalReal),
        winRate: isFinite(st.winRate) ? +st.winRate.toFixed(3) : null,
        simSample: st.simSample, realSample: st.realSample,
        openPositions: SG.openPositions(SG.cfg.minNotional).length,
        ledgerRows: document.querySelectorAll('#sgLedgerBody tr.sg-row').length,
        openRows: document.querySelectorAll('#sgOpenBody tr.sg-row').length,
        feedRows: document.querySelectorAll('#sgFeed .sge').length,
        walletRows: document.querySelectorAll('#sgWalletPerf .wl-perf').length,
        dailyRows: document.querySelectorAll('#sgDaily .dr').length,
        mids: SG.mids ? Object.keys(SG.mids).length : 0,
        persisted: !!(function () { try { return localStorage.getItem('cs.signals.v2'); } catch (e) { return null; } })(),
        errors: S.errors.slice(-10)
      };
    };
  }

  S.ready(main);
})(window);
