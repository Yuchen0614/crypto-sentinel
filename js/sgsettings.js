/* sgsettings.js — 模擬跟單的設定面板
   ─────────────────────────────────────────────────────────────
   這一支負責三件事（其餘記錄流程不動）：

   1. 模擬本金：帳戶層級的績效（淨值／報酬率／相對本金回撤）用它當基準。
   2. 每筆名目：可用「固定金額」，也可用「本金百分比」（固定本金、不複利，
      數字可重現）。實際名目一律走 S.signals.copySize()，與 simPnl 同一來源。
   3. 跟單錢包名單：名單為空＝跟全部大戶；加入／移除後只影響「之後的新回合」，
      要立刻套用到乾淨的起點請按「重新開始計算」。

   注意：跟單的曝險就是每筆名目本身（等同現貨式曝險），不乘大戶槓桿。
   ══════════════════════════════════════════════════════════════ */
(function (w) {
  'use strict';
  const S = w.SENTINEL, U = S.util, SG = S.signals;
  const SS = S.sgSettings = { whales: null };

  const $ = s => document.querySelector(s);
  const usd = v => '$' + U.money(Math.abs(v));
  const short = a => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '—');
  const say = t => U.text('#sgTicker', t);

  const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
  const nameOf = addr => {
    const ws = SS.whales && SS.whales.wallets;
    const hit = ws && ws.find(x => x.addr.toLowerCase() === String(addr).toLowerCase());
    return hit ? (hit.name || short(hit.addr)) : short(addr);
  };
  const avOf = addr => {
    const ws = SS.whales && SS.whales.wallets;
    const hit = ws && ws.find(x => x.addr.toLowerCase() === String(addr).toLowerCase());
    return hit ? hit.av : NaN;
  };

  /* ── 名單 ─────────────────────────────────────────────── */
  function addFollow(addr) {
    const f = SG.cfg.follow;
    if (!f.length) {
      // 從「跟全部」切到白名單：以目前的錢包為起點會太多，直接從空的開始
      SG.cfg.follow = [addr];
    } else if (f.indexOf(addr) < 0) {
      f.push(addr);
    } else { say('這個錢包已經在名單內'); return false; }
    SG.save(); render();
    say('已加入跟單：' + nameOf(addr) + '（目前 ' + SG.cfg.follow.length + ' 個，僅影響之後的新回合）');
    return true;
  }
  function removeFollow(addr) {
    SG.cfg.follow = SG.cfg.follow.filter(a => a !== addr);
    SG.save(); render();
    say(SG.cfg.follow.length ? ('已移除 ' + short(addr) + '（剩 ' + SG.cfg.follow.length + ' 個）') : '名單已清空 → 改為跟全部大戶');
  }

  function renderFollow() {
    const box = $('#sgFollowList'); if (!box) return;
    const f = SG.cfg.follow || [];
    const scope = $('#sgFollowVal');
    if (scope) {
      scope.textContent = f.length
        ? ('指定 ' + f.length + ' 個錢包')
        : ('全部大戶' + (SS.whales && SS.whales.wallets ? '（' + SS.whales.wallets.length + ' 個）' : ''));
    }
    if (!f.length) {
      box.innerHTML = '<div class="empty">目前跟全部大戶。加入特定錢包後，就只跟這些錢包。</div>';
      return;
    }
    box.innerHTML = f.map(a => {
      const av = avOf(a), nm = nameOf(a);
      // 沒有名字時 nameOf 回傳的就是縮短地址，這時不再重複顯示一次地址
      const meta = (nm !== short(a) ? short(a) : '') + (isFinite(av) ? (nm !== short(a) ? ' · ' : '') + '淨值 ' + usd(av) : '');
      return '<div class="sf-row" data-addr="' + a + '">' +
        '<span class="nm"><b>' + nm + '</b>' + (meta ? '<span class="mini">' + meta + '</span>' : '') + '</span>' +
        '<button class="sf-x" data-remove="' + a + '" title="從跟單名單移除">移除</button></div>';
    }).join('');
  }

  /* ── 名目與本金 ───────────────────────────────────────── */
  function renderMoney() {
    const c = SG.cfg, size = SG.copySize();
    U.text('#sgCapVal', usd(c.capital) + ' 本金');
    const inp = $('#sgCapInput');
    if (inp && document.activeElement !== inp) inp.value = String(Math.round(c.capital));
    const pct = c.sizeMode === 'pct';
    const sv = $('#sgSizeVal');
    if (sv) {
      sv.innerHTML = pct
        ? (usd(size) + ' <span class="mini">＝ 本金 ' + usd(c.capital) + ' × ' + c.sizePct + '%（固定本金、不複利）</span>')
        : (usd(size) + ' <span class="mini">固定金額</span>');
    }
    const ps = $('#sgPctSeg'); if (ps) ps.hidden = !pct;
    const legacy = $('#sgCopySeg');
    if (legacy) {
      legacy.classList.toggle('muted', pct);
      legacy.title = pct ? '目前是「本金百分比」模式，點這裡可切回固定金額' : '';
    }
    const segs = { '#sgSizeSeg': 'mode' };
    Object.keys(segs).forEach(sel => {
      const el = $(sel); if (!el) return;
      Array.prototype.forEach.call(el.children, b => b.classList.toggle('on', (b.dataset.mode === 'fixed' ? 'fixed' : 'pct') === (pct ? 'pct' : 'fixed')));
    });
    const cap = $('#sgCapSeg');
    if (cap) Array.prototype.forEach.call(cap.children, b => b.classList.toggle('on', +b.dataset.cap === Math.round(c.capital)));
  }

  function render() { renderMoney(); renderFollow(); }

  /* ── 綁定 ─────────────────────────────────────────────── */
  function wire() {
    /* 本金：輸入框 + 常用級距 */
    const inp = $('#sgCapInput');
    if (inp) {
      const apply = () => {
        let v = Math.round(+inp.value || 0);
        if (v < 1000) v = 1000;
        if (v > 1e9) v = 1e9;
        SG.cfg.capital = v; SG.save(); renderMoney();
      };
      inp.addEventListener('change', apply);
      inp.addEventListener('blur', apply);
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { apply(); inp.blur(); } });
    }
    const cs = $('#sgCapSeg');
    if (cs) cs.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      SG.cfg.capital = +b.dataset.cap || SG.cfg.capital;
      SG.save(); renderMoney();
      say('模擬本金設為 ' + usd(SG.cfg.capital) + '（既有回合不動，要從頭算請按「重新開始計算」）');
    });

    /* 名目模式 */
    const ss = $('#sgSizeSeg');
    if (ss) ss.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      SG.cfg.sizeMode = b.dataset.mode === 'pct' ? 'pct' : 'fixed';
      SG.save(); renderMoney();
      say(SG.cfg.sizeMode === 'pct'
        ? ('每筆名目改為本金的 ' + SG.cfg.sizePct + '% ＝ ' + usd(SG.copySize()))
        : ('每筆名目改為固定 ' + usd(SG.copySize())));
    });
    const ps = $('#sgPctSeg');
    if (ps) ps.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      SG.cfg.sizePct = +b.dataset.pct || 5;
      SG.cfg.sizeMode = 'pct';
      SG.save(); renderMoney();
      say('每筆名目＝本金的 ' + SG.cfg.sizePct + '% ＝ ' + usd(SG.copySize()));
    });
    /* 舊的固定金額分段（由 signalsboot 綁定）：點它等於切回固定模式 */
    const legacy = $('#sgCopySeg');
    if (legacy) legacy.addEventListener('click', () => {
      if (SG.cfg.sizeMode === 'pct') { SG.cfg.sizeMode = 'fixed'; SG.save(); renderMoney(); }
    });

    /* 名單 */
    const list = $('#sgFollowList');
    if (list) list.addEventListener('click', e => {
      const b = e.target.closest('[data-remove]'); if (!b) return;
      removeFollow(b.getAttribute('data-remove'));
    });
    const addBtn = $('#sgFollowAdd'), addInp = $('#sgFollowInput');
    const tryAdd = () => {
      if (!addInp) return;
      const raw = addInp.value.trim();
      if (!raw) return;
      if (ADDR_RE.test(raw)) { addFollow(raw); addInp.value = ''; return; }
      // 允許用名字加入（比對資料/備援名單）
      const ws = (SS.whales && SS.whales.wallets) || [];
      const q = raw.toLowerCase();
      const hit = ws.find(x => (x.name || '').toLowerCase().includes(q)) || ws.find(x => x.addr.toLowerCase().startsWith(q));
      if (hit) { addFollow(hit.addr); addInp.value = ''; }
      else say('找不到這個錢包：請貼完整地址（0x 開頭 42 字元）或輸入名單中的名字');
    };
    if (addBtn) addBtn.addEventListener('click', tryAdd);
    if (addInp) addInp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); tryAdd(); } });

    const top = $('#sgFollowTop');
    if (top) top.addEventListener('click', () => {
      const ws = (SS.whales && SS.whales.wallets) || [];
      if (!ws.length) { say('大戶名單還在載入，稍後再試'); return; }
      const pick = ws.slice().sort((a, b) => b.av - a.av).slice(0, 5);
      SG.cfg.follow = pick.map(x => x.addr);
      SG.save(); render();
      say('已加入淨值前 5 名：' + pick.map(x => x.name || short(x.addr)).join('、'));
    });
    const all = $('#sgFollowAll');
    if (all) all.addEventListener('click', () => {
      SG.cfg.follow = []; SG.save(); render();
      say('已改為跟全部大戶（' + ((SS.whales && SS.whales.wallets) || []).length + ' 個）');
    });

    /* 重算 / 重新開始 */
    const rc = $('#sgRecalcBtn');
    if (rc) rc.addEventListener('click', () => {
      const n = SG.recomputeAll();
      render();
      say('已用目前名目（' + usd(SG.copySize()) + '）重算 ' + n + ' 筆已平倉回合的模擬跟單盈虧');
    });
    const rs = $('#sgRestartBtn');
    if (rs) rs.addEventListener('click', () => {
      const cap = SG.cfg.capital, size = SG.copySize(), n = SG.rounds.length;
      if (!confirm('重新開始計算？\n\n・清空本機帳本（目前 ' + n + ' 筆回合）與流水\n・只記錄「現在之後」新發生的回合\n・以本金 ' + usd(cap) + '、每筆名目 ' + usd(size) + ' 重新累積績效\n\n（伺服器端的每日快照不受影響，無法復原本機紀錄）')) return;
      SG.restart();
      render();
      say('已重新開始：本金 ' + usd(cap) + '、每筆 ' + usd(size) + '，正在累積新的回合…');
    });
  }

  /* ── 啟動 ─────────────────────────────────────────────── */
  function boot() {
    if (!$('#sgCapInput')) return;         // 只在帶單頁作用
    wire();
    render();
    // 大戶名單（給 datalist 與「淨值前 5 名」用）
    const fill = d => {
      if (!d || !d.wallets) return;
      SS.whales = d;
      const dl = $('#sgWhaleList');
      if (dl) dl.innerHTML = d.wallets.slice().sort((a, b) => b.av - a.av).slice(0, 60)
        .map(x => '<option value="' + x.addr + '">' + (x.name || short(x.addr)) + ' · 淨值 ' + usd(x.av) + '</option>').join('');
      render();
    };
    S.api.hlWhales().then(fill);
    S.on('hl-wallets', () => { if (!SS.whales) S.api.hlWhales().then(fill); });
    S.on('sig-restart', () => { render(); });
    setInterval(() => { if (!document.hidden) renderMoney(); }, 4000);
  }

  S.ready(() => setTimeout(boot, 900));
})(window);
