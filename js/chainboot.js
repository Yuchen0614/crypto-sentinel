/* chainboot.js — 鏈上聰明錢子系統：啟動與排程
   ─────────────────────────────────────────────────────────────
   這份邏輯原本寫在主控台 app.js 裡；抽出來的原因：
     * 主控台（index.html）與獨立頁（onchain.html）共用同一套排程，避免兩邊行為不一致。
     * 主控台不再輪詢鏈上資料（把 GeckoTerminal 免費層的額度全部留給獨立頁）。
   載入順序：util → api → analytics → onchain → chainui → fx → chainboot */
(function (w) {
  'use strict';
  const S = w.SENTINEL, U = S.util, OC = S.onchain, FX = S.fx;
  const CB = S.chainBoot = { started: false, hlDirty: false, timers: [] };

  /* ── 大戶名單 ─────────────────────────────────────────── */
  CB.loadWhales = async function () {
    const d = await S.api.hlWhales();
    if (d) { OC.hl.setWallets(d); S.chainUI.render(); }
  };

  /* 首輪快速預掃：不照輪詢順序，先把名單前段（最大的錢包）一次補齊，
     讓「大戶持倉」在十幾秒內就有內容，而不是等整輪掃完。 */
  CB.primeWallets = async function (n) {
    const list = OC.hl.wallets.slice(0, n || 24);
    const chunk = 6;
    for (let i = 0; i < list.length; i += chunk) {
      await Promise.all(list.slice(i, i + chunk).map(wl =>
        S.api.hlState(wl.addr).then(st => { if (st) OC.hl.ingest(wl.addr, st); })));
      S.chainUI.agg();
      await new Promise(r => setTimeout(r, 250));
    }
    OC.hl.pollIdx = list.length % Math.max(1, OC.hl.wallets.length);   // 接續輪詢，不重掃同一批
    S.chainUI.render();
  };

  CB.hlPoll = function (batchSize) {
    OC.hl.nextBatch(batchSize || 4).forEach(wl =>
      S.api.hlState(wl.addr).then(st => { if (st) OC.hl.ingest(wl.addr, st); }));
  };

  /* ── DEX 大額換幣掃描（單一佇列，避免被 WAF 斷線）──────── */
  let dexBusy = false;
  CB.dexScan = async function () {
    if (dexBusy) return;
    dexBusy = true;
    try { await OC.dex.scan(); } catch (e) { S.errors.push('dexScan: ' + e.message); }
    dexBusy = false;
    S.chainUI.dexMeta();
  };

  /* ── 事件綁定 ─────────────────────────────────────────── */
  CB.wire = function () {
    S.on('hl-wallets', () => {
      S.chainUI.render();
      // 主控台才有 HUD 狀態燈；獨立頁沒有 S.ui / S.stream，這裡必須容錯
      if (S.ui && S.ui.hud && S.ui.hud.pills && S.stream) S.ui.hud.pills(S.stream.state);
    });
    S.on('hl-state', () => { CB.hlDirty = true; });
    S.on('hl-event', e => {
      S.chainUI.hlEvent(e);
      if (e.sev === 'high' || e.kind === 'FLIP') {
        FX.toast({ title: e.name + ' ' + e.title, text: e.text, sev: e.sev === 'high' ? 'high' : 'mid', tag: '鏈上大戶' });
      }
    });
    S.on('dex-trade', t => {
      S.chainUI.dexTrade(t);
      if (t.usd >= 1000000) {
        FX.toast({
          title: '鏈上大額' + (t.side === 'buy' ? '買入' : '賣出') + ' ' + (t.tokenSym || '') + ' $' + U.money(t.usd),
          text: '錢包 ' + OC.short(t.wallet) + ' · ' + OC.chainLabel(t.chain) + ' · ' + (t.poolName || t.dex || ''),
          sev: 'mid', tag: '鏈上換幣'
        });
      }
    });
    S.on('dex-scan', () => S.chainUI.dexMeta());
  };

  /* ── DOM 互動：鏈別、門檻、展開／收合 ─────────────────── */
  CB.initDom = function () {
    const seg = document.getElementById('chainSeg');
    if (seg) seg.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      Array.prototype.forEach.call(b.parentNode.children, x => x.classList.toggle('on', x === b));
      OC.dex.chain = b.dataset.chain;
      OC.dex.reset();
      const tape = document.getElementById('chainTape');
      if (tape) tape.innerHTML = '<div class="empty">切換鏈別，重新掃描中…</div>';
      const wl = document.getElementById('walletList');
      if (wl) { wl.__key = ''; wl.innerHTML = '<div class="empty">累積鏈上錢包資料中…</div>'; }
      const cb = document.getElementById('coBuyList');
      if (cb) { cb.__key = ''; cb.innerHTML = ''; }
      S.chainUI.dexMeta();
      if (FX.glitch) FX.glitch();
      setTimeout(() => CB.dexScan(), 120);
    });

    const min = document.getElementById('chainMin');
    if (min) min.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      Array.prototype.forEach.call(b.parentNode.children, x => x.classList.toggle('on', x === b));
      OC.dex.min = +b.dataset.min;
      S.chainUI.dexMeta();
      setTimeout(() => CB.dexScan(), 120);
    });

    /* 「展開 / 收合」只存在於主控台的嵌入式區塊；獨立頁本身就是全頁，沒有這個按鈕。
       高度用 inline + important 指定（外面的 flex 與媒體查詢都蓋不掉），
       並在 JS 裡先算成 px：CSS 的 min()/calc() 混用在 inline style 不一定被接受。
       上限 62vh：矮螢幕展開時仍要留空間給上面的三欄，否則三欄會被壓成幾十 px。 */
    const btn = document.getElementById('chainExpand');
    const wrap = document.querySelector('.chain-wrap');
    if (btn && wrap) {
      btn.addEventListener('click', () => {
        const on = wrap.classList.toggle('full');
        btn.textContent = on ? '收合' : '展開';
        btn.classList.toggle('on', on);
        const fit = () => Math.round(Math.max(300, Math.min(innerHeight * 0.62, innerHeight - 118)));
        if (on) {
          wrap.style.setProperty('height', fit() + 'px', 'important');
          if (!wrap.__fitBound) {
            wrap.__fitBound = true;
            w.addEventListener('resize', () => { if (wrap.classList.contains('full')) wrap.style.setProperty('height', fit() + 'px', 'important'); });
          }
        } else wrap.style.removeProperty('height');
        try { localStorage.setItem('cs.chainFull', on ? '1' : '0'); } catch (e) { }
        requestAnimationFrame(() => { w.dispatchEvent(new Event('resize')); S.chainUI.dexMeta(); });
      });
      let saved = false;
      try { saved = localStorage.getItem('cs.chainFull') === '1'; } catch (e) { }
      if (saved && innerHeight >= 760) btn.click();
    }
  };

  /* ── 啟動：載入名單 → 快速預掃 → 建立所有定時器 ─────────── */
  CB.start = async function (opts) {
    if (CB.started) return;
    CB.started = true;
    const o = opts || {};

    await CB.loadWhales();
    CB.primeWallets(o.prime || 24);

    // 25 秒後若完全沒有持倉，明講原因（不要讓畫面永遠停在「載入中」）
    setTimeout(() => {
      const m = document.getElementById('hlMeta');
      if (OC.hl.wallets.length && !OC.hl.states.size) {
        S.api.health.chain = 'off';
        if (m) m.innerHTML = '<span style="color:var(--am)">無法取得持倉資料 — 可能是網路阻擋 api.hyperliquid.xyz（此站需要瀏覽器直連該端點）</span>';
      }
    }, 25000);

    setTimeout(() => CB.dexScan(), 1500);

    let renderTick = 0;
    CB.timers.push(
      // 每 5 秒：鏈上大戶錢包（每輪 6 個；背景分頁降為 2 個）
      setInterval(() => { if (!document.hidden) CB.hlPoll(6); else CB.hlPoll(2); }, 5000),
      // 每 14 秒：DEX 大額換幣掃描（每輪 1 個高流量池；GeckoTerminal 免費層約 5 次/分即被擋）
      setInterval(() => CB.dexScan(), 14000),
      setInterval(() => { if (!document.hidden) S.chainUI.dexMeta(); }, 3000),
      // 每 1.2 秒：鏈上面板渲染
      // 背景分頁只降頻、不停止：否則使用者切走再切回來，面板會停在舊資料或空狀態。
      // （畫布動畫（雷達、熱圖）由各自的 rAF 迴圈處理，瀏覽器本來就會自動節流。）
      setInterval(() => {
        renderTick++;
        if (document.hidden && renderTick % 5 !== 0) return;
        S.chainUI.agg();
        if (CB.hlDirty) { CB.hlDirty = false; S.chainUI.hlTable(); S.chainUI.coinBars(); }
        S.chainUI.wallets();
        S.chainUI.coBuy();
        const cnt = document.getElementById('chainCount');
        if (cnt) cnt.textContent = String(OC.dex.trades.length + OC.hl.events.length);
      }, 1200),
      // 每 5 分鐘：重新載入大戶名單
      setInterval(() => CB.loadWhales(), 300000)
    );
  };
})(window);
