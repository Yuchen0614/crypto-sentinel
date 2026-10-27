/* sgpanel.js — 帶單頁最上方的「控制列」+ 跟單對象選擇器 + 重建歷史
   ─────────────────────────────────────────────────────────────
   為什麼搬到最上面：本金／每筆名目／跟誰的單／從什麼時候開始算，
   是這一頁最常用也最容易搞混的四件事。做成頁面頂端一條控制列，
   打開就先看到，不必捲到最下面才找得到。

   1. 模擬本金：帳戶層級數字（淨值、報酬率、相對本金回撤）的基準。
   2. 每筆名目：固定金額或本金百分比（固定名目、不複利，數字可重現）。
   3. 跟單對象：開啟選擇器勾選（全部不勾＝跟全部大戶）。
   4. 重建歷史：清空本機帳本，重新抓「最近 N 分鐘／小時」的成交。
      單次上限 2000 筆，會自動往前翻頁（最多 4 次）。
   5. 重新開始：不抓歷史，只從現在累積新的回合。
   ══════════════════════════════════════════════════════════════ */
(function (w) {
  'use strict';
  const S = w.SENTINEL, U = S.util, SG = S.signals;
  const SS = S.sgPanel = { whales: null, draft: null, win: 360, busy: false, ingest: null, draft: new Set() };

  const $ = s => document.querySelector(s);
  const usd = v => '$' + U.money(Math.abs(v));
  const short = a => (a ? String(a).slice(0, 6) + '…' + String(a).slice(-4) : '—');
  const say = t => U.text('#sgTicker', t);
  const wl = () => (SS.whales && SS.whales.wallets) || [];
  const find = a => wl().find(x => x.addr.toLowerCase() === String(a || '').toLowerCase());
  const nameOf = a => { const h = find(a); return h ? (h.name || short(h.addr)) : short(a); };
  const pctTxt = (v, d) => (isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(d === undefined ? 1 : d) + '%' : '—');

  /* signals.js 的「吃成交」函式名字會被工具鏈遮蔽，改用特徵在執行期找出來：
     3 個參數、函式內含 Array.isArray(fills)。 */
  function ingestFn() {
    if (SS.ingest) return SS.ingest;
    SS.ingest = Object.keys(SG).map(k => SG[k]).find(f =>
      typeof f === 'function' && f.length === 3 && /Array\.isArray\(fills\)/.test(String(f))) || null;
    return SS.ingest;
  }

  /* ── 控制列 ───────────────────────────────────────────── */
  function render() {
    const c = SG.cfg, size = SG.copySize(), f = c.follow || [];
    const inp = $('#sgCapInput');
    if (inp && document.activeElement !== inp) inp.value = String(Math.round(c.capital));
    U.text('#sgCapVal', usd(c.capital));
    U.text('#sgSizeVal', usd(size));
    U.text('#sgSizeNote', c.sizeMode === 'pct' ? ('本金 ' + c.sizePct + '%')
      : (c.sizeMode === 'mirror' ? ('大戶名目 ÷' + (c.mirrorDiv || 500) + '，單筆上限本金 ' + (c.mirrorCapPct || 100) + '%') : '固定每筆'));
    basis();
    const ps = $('#sgPctSeg'); if (ps) ps.hidden = c.sizeMode !== 'pct';
    const ms = $('#sgMirrorSeg'); if (ms) ms.hidden = c.sizeMode !== 'mirror';
    if (c.sizeMode === 'mirror') U.text('#sgSizeVal', '÷' + (c.mirrorDiv || 500));
    [['#sgCapSeg', 'cap', Math.round(c.capital)], ['#sgSizeSeg', 'mode', c.sizeMode === 'pct' ? 'pct' : 'fixed'], ['#sgWinSeg', 'win', SS.win]]
      .forEach(([sel, key, cur]) => {
        const el = $(sel); if (!el) return;
        Array.prototype.forEach.call(el.children, b => {
          const v = key === 'cap' ? +b.dataset.cap : (key === 'win' ? +b.dataset.win : b.dataset.mode);
          b.classList.toggle('on', v === cur);
        });
      });
    const fv = $('#sgFollowVal');
    if (fv) fv.textContent = f.length ? (f.length + ' 個錢包') : ('全部大戶' + (wl().length ? '（' + wl().length + '）' : ''));
    const pb = $('#sgPickBtn'); if (pb) pb.classList.toggle('picked', f.length > 0);
    const rb = $('#sgRebuildBtn'); if (rb) rb.disabled = SS.busy;
    const fm = SG.cfg.feeMode || 'whale';
    U.text('#sgFeeVal', fm === 'taker' ? '吃單 0.045%/邊' : (fm === 'maker' ? '掛單 0.015%/邊' : '同大戶（實際費率）'));
    const fe = $('#sgFeeSeg');
    if (fe) Array.prototype.forEach.call(fe.children, b => b.classList.toggle('on', b.dataset.fee === fm));
  }

  /* 同口徑比較：兩邊都用「名目加權報酬率」看，$ 的差距才拆得開 */
  function basis() {
    const el = $('#sgBasis'); if (!el) return;
    const R = SG.rounds.filter(r => r.status === 'closed' && isFinite(r.realUsd) && isFinite(r.notional) && r.notional > 0);
    if (!R.length) { el.textContent = '同口徑比較：還沒有已平倉回合'; return; }
    const pc = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
    let rr = 0, rn = 0, sr = 0, sn = 0, fee = 0, used = 0, capped = 0, skipped = 0;
    R.forEach(r => {
      const cp = SG.roundCopy(r.notional), fr = SG.feeRatio(r.realFee, r.notional);
      const s = SG.simPnl(r.entryPx, r.exitPx, r.side, cp, fr);
      // 兩邊必須是同一批回合才比得起來：沒有進場價（快照推得、抓不到成交）的回合，
      // 模擬算不出來，就不該只算進「錢包真實」那一邊，否則差距會被這批回合放大。
      if (!isFinite(s) || !(cp > 0)) { skipped++; return; }
      rr += r.realUsd; rn += r.notional; sr += s; sn += cp; fee += cp * fr; used++;
      if (SG.mirrorCapped && SG.mirrorCapped(r.notional)) capped++;
    });
    const rRate = rn > 0 ? rr / rn : NaN, sRate = sn > 0 ? sr / sn : NaN;
    if (!used || !isFinite(sRate)) {
      el.innerHTML = '<b>同口徑比較</b>：這批回合還沒有可計算的模擬名目（部分回合是用持倉快照推的，沒有進場價）。按「重建歷史」抓成交明細後即可比較。';
      return;
    }
    el.innerHTML = '<b>同口徑比較（' + used + ' / ' + R.length + ' 個回合）</b>：錢包真實 <b>' + pc(rRate) + '</b>（名目加權 · 名目 $'
      + U.money(rn) + '）｜ 你的跟單 <b>' + pc(sRate) + '</b>（' + (SG.cfg.sizeMode === 'mirror' ? '同比例' : '等權重')
      + ' · 名目 $' + U.money(sn) + '）｜ 差距 <b>' + pc(sRate - rRate) + '</b>，其中手續費占 ' + pc(-fee / sn)
      + '（' + (SG.cfg.sizeMode === 'mirror' ? '切成同比例後，剩下的差距就是手續費與配對差異' : '切成「同比例」可對齊大戶的下注大小') + '）'
      + (skipped ? '　※ 另有 ' + skipped + ' 個回合抓不到進場價（快照推得）已排除，兩邊只比同一批 ' + used + ' 個回合' : '')
      + (capped ? '　※ 其中 ' + capped + ' 筆被單筆上限壓住（大戶名目超過本金 ' + (SG.cfg.mirrorCapPct || 100) + '%÷' + (SG.cfg.mirrorDiv || 500) + ' 的上限）' : '');
  }

  /* ── 跟單對象選擇器 ───────────────────────────────────── */
  function openPick() {
    const box = $('#sgPick'); if (!box) return;
    SS.draft = new Set((SG.cfg.follow || []).length ? SG.cfg.follow : wl().map(x => x.addr));
    $('#sgPickQ').value = ''; renderPick(); box.hidden = false;
    const q = $('#sgPickQ'); if (q) setTimeout(() => q.focus(), 30);
  }
  const closePick = () => { const b = $('#sgPick'); if (b) b.hidden = true; };
  function countTxt() {
    const n = SS.draft.size, m = wl().length;
    return n ? ('已選 ' + n + ' 個' + (m && n === m ? '（等於全部）' : '')) : '全部不勾＝跟全部大戶';
  }
  function renderPick() {
    const list = $('#sgPickList'); if (!list) return;
    if (!SS.draft) SS.draft = new Set();
    const q = ($('#sgPickQ').value || '').trim().toLowerCase();
    const rows = wl()
      .filter(x => !q || String(x.name || '').toLowerCase().includes(q) || x.addr.toLowerCase().includes(q))
      .sort((a, b) => b.av - a.av);
    list.innerHTML = rows.length ? rows.map(x => {
      const on = SS.draft.has(x.addr);
      return '<label class="pk-row' + (on ? ' on' : '') + '" data-addr="' + x.addr + '">' +
        '<input type="checkbox"' + (on ? ' checked' : '') + '>' +
        '<span class="pk-nm"><b>' + (x.name || short(x.addr)) + '</b>' +
        '<span class="mini">' + short(x.addr) + ' · 淨值 ' + usd(x.av) +
        (isFinite(x.roi30) ? ' · 月 ' + pctTxt(x.roi30) : '') + '</span></span></label>';
    }).join('') : '<div class="empty" style="padding:12px">名單還沒載入，或沒有符合的錢包</div>';
    U.text('#sgPickCount', countTxt());
  }
  function applyPick() {
    const n = SS.draft.size, m = wl().length;
    SG.cfg.follow = (!n || (m && n === m)) ? [] : [...SS.draft];
    SG.save(); closePick(); render();
    say(SG.cfg.follow.length ? ('跟單對象：' + SG.cfg.follow.length + ' 個錢包（只影響之後的新回合）') : '跟單對象：全部大戶');
  }

  /* ── 重建歷史 ─────────────────────────────────────────── */
  async function rebuild() {
    if (SS.busy) return;
    const ing = ingestFn();
    if (!ing) { say('找不到成交寫入函式，請重新整理後再試'); return; }
    const mins = SS.win;
    const all = !(SG.cfg.follow || []).length;
    const scope = all ? wl().slice().sort((a, b) => b.av - a.av).slice(0, 14).map(x => x.addr) : SG.cfg.follow.slice();
    if (!scope.length) { say('大戶名單還沒載入，稍候再試'); return; }
    const label = mins >= 60 ? (mins / 60) + ' 小時' : mins + ' 分鐘';
    if (!confirm('重建歷史紀錄？\n\n範圍：最近 ' + label + '\n對象：' + scope.length + ' 個錢包' + (all ? '（跟全部時，取淨值前 14 名以控制請求量）' : '（你指定的名單）') +
      '\n\n・會先清空這台裝置上的帳本，再重新抓成交組成回合\n・模擬跟單盈虧改用目前的每筆名目計算\n・Hyperliquid 單次上限 2000 筆，會自動往前翻頁\n（伺服器端每日快照不受影響）')) return;

    SS.busy = true; render();
    SG.clear(); SG.startAt = 0;             // 重建＝由這個期間重新組，起點限制要清掉
    const since = Date.now() - mins * 60e3;
    const pg = $('#sgProg'), bar = pg && pg.querySelector('i'), pt = $('#sgProgTxt');
    if (pg) { pg.hidden = false; if (bar) bar.style.width = '2%'; }
    let added = 0, done = 0, failed = 0;
    const MAX_PAGES = 4;
    for (const addr of scope) {
      let cur = since, pages = 0;
      while (pages < MAX_PAGES) {
        const fills = await S.api.hlFills(addr, cur);
        if (fills === null) { failed++; break; }
        if (!fills.length) break;
        added += ing(addr, fills, nameOf(addr));
        pages++;
        if (fills.length < 2000) break;
        cur = +fills[fills.length - 1].time + 1;
      }
      done++;
      SG.prune(); SG.save();
      if (pt) pt.textContent = '重建中 ' + done + '/' + scope.length + ' 個錢包 · 成交 ' + added + ' 筆 · 回合 ' + SG.rounds.length;
      if (bar) bar.style.width = Math.round(done / scope.length * 100) + '%';
      await new Promise(r => setTimeout(r, 250));
    }
    SG.save();
    if (pt) pt.textContent = '完成：' + done + ' 個錢包 · 成交 ' + added + ' 筆 · 回合 ' + SG.rounds.length + (failed ? ' · ' + failed + ' 個讀取失敗' : '');
    say('已重建 ' + label + '的歷史：' + done + ' 個錢包、' + SG.rounds.length + ' 個回合' + (failed ? '（' + failed + ' 個錢包讀取失敗）' : ''));
    SS.busy = false; render();
    setTimeout(() => { if (pg) pg.hidden = true; }, 2800);
  }

  /* ── 綁定 ─────────────────────────────────────────────── */
  /* 改設定後重算既有回合（真實盈虧不動），並回報筆數 */
  function recalc(what) {
    const f = SG.recomputeAll || SG.recompute;
    const n = (typeof f === 'function') ? (f.call(SG) || 0) : 0;
    render();
    say((what ? what + '；' : '') + '已重算 ' + n + ' 筆回合');
  }

  function wire() {
    const inp = $('#sgCapInput');
    if (inp) {
      const apply = () => {
        let v = Math.round(+inp.value || 0);
        if (!v || v < 1000) v = 1000; if (v > 1e9) v = 1e9;
        SG.cfg.capital = v; SG.save(); render();
      };
      inp.addEventListener('change', apply);
      inp.addEventListener('blur', apply);
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { apply(); inp.blur(); } });
    }
    const on = (sel, fn) => { const e = $(sel); if (e) e.addEventListener('click', fn); };
    const seg = (sel, fn) => { const e = $(sel); if (e) e.addEventListener('click', ev => { const b = ev.target.closest('button'); if (b) fn(b); }); };

    seg('#sgCapSeg', b => { SG.cfg.capital = +b.dataset.cap; SG.save(); render(); say('模擬本金 ' + usd(SG.cfg.capital) + '（既有回合的數字要按「重算名目」才更新）'); });
    seg('#sgSizeSeg', b => { SG.cfg.sizeMode = b.dataset.mode; SG.save(); render(); recalc('每筆名目改成「' + b.textContent.trim() + '」'); });
    seg('#sgPctSeg', b => { SG.cfg.sizePct = +b.dataset.pct; SG.cfg.sizeMode = 'pct'; SG.save(); render(); recalc('每筆名目＝本金 ' + SG.cfg.sizePct + '%＝' + usd(SG.copySize())); });
    seg('#sgMirrorSeg', b => { SG.cfg.mirrorDiv = +b.dataset.div; SG.cfg.sizeMode = 'mirror'; SG.save(); render(); recalc('每筆名目＝大戶該回合名目 ÷' + SG.cfg.mirrorDiv + '（單筆上限本金 ' + (SG.cfg.mirrorCapPct || 100) + '%）'); });
    seg('#sgWinSeg', b => { SS.win = +b.dataset.win; render(); });
    seg('#sgFeeSeg', b => {
      SG.cfg.feeMode = b.dataset.fee; SG.save(); render();
      const f = SG.recomputeAll || SG.recompute;
      const n = (typeof f === 'function') ? (f.call(SG) || 0) : 0;
      say('手續費改用「' + b.textContent.trim() + '」重算 ' + n + ' 筆回合：模擬跟單累計 ' + (SG.stats ? '' : '') + '已更新');
    });
    const legacy = $('#sgCopySeg');   // 舊的固定金額分段鈕仍在畫面上，切回固定時要同步
    if (legacy) legacy.addEventListener('click', () => { if (SG.cfg.sizeMode === 'pct') { SG.cfg.sizeMode = 'fixed'; SG.save(); render(); } });

    on('#sgPickBtn', openPick);
    on('#sgPickCancel', closePick);
    on('#sgPickApply', applyPick);
    const quick = (set) => { SS.draft = set; const q = $('#sgPickQ'); if (q) q.value = ''; renderPick(); };
    on('#sgPickAll', () => quick(new Set(wl().map(x => x.addr))));
    on('#sgPickNone', () => quick(new Set()));
    on('#sgPickTop', () => quick(new Set(wl().slice().sort((a, b) => b.av - a.av).slice(0, 10).map(x => x.addr))));
    const pk = $('#sgPick');
    if (pk) pk.addEventListener('click', e => { if (e.target.id === 'sgPick') closePick(); });
    const pq = $('#sgPickQ'); if (pq) pq.addEventListener('input', U.debounce(renderPick, 150));
    const pl = $('#sgPickList');
    if (pl) pl.addEventListener('change', e => {
      const row = e.target.closest('.pk-row'); if (!row) return;
      if (e.target.checked) SS.draft.add(row.dataset.addr); else SS.draft.delete(row.dataset.addr);
      row.classList.toggle('on', e.target.checked);
      U.text('#sgPickCount', countTxt());
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closePick(); });

    on('#sgRebuildBtn', rebuild);
    on('#sgRecalcBtn', () => {
      const f = SG.recomputeAll || SG.recompute || SG.recalc;
      if (typeof f !== 'function') { say('這個版本沒有提供重算功能'); return; }
      const n = f.call(SG) || 0;
      render();
      say('已用每筆 ' + usd(SG.copySize()) + ' 重算 ' + n + ' 筆回合');
    });
    on('#sgRestartBtn', () => {
      if (!confirm('重新開始計算？\n\n・清空本機帳本與流水\n・只記錄「現在之後」新發生的回合\n・以本金 ' + usd(SG.cfg.capital) + '、每筆 ' + usd(SG.copySize()) + ' 重新累積\n\n要保留歷史請改用「重建歷史」')) return;
      SG.restart(); render();
      say('已重新開始：本金 ' + usd(SG.cfg.capital) + '、每筆 ' + usd(SG.copySize()) + '，開始累積新回合…');
    });
  }

  function boot() {
    if (!$('#sgCapInput')) return;            // 只在帶單頁作用
    wire(); render();
    const fill = d => { if (d && d.wallets) { SS.whales = d; render(); renderPick(); } };
    S.api.hlWhales().then(fill);
    S.on('hl-wallets', () => { if (!SS.whales) S.api.hlWhales().then(fill); });
    setInterval(() => { if (!document.hidden) render(); }, 4000);
  }
  S.ready(() => setTimeout(boot, 900));
})(window);
