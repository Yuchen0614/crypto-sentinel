/* sgmetrics.js — 帶單記錄頁的完整績效指標
   ─────────────────────────────────────────────────────────────
   資料來源：S.signals.rounds（已平倉回合）。每一筆同時有兩個盈虧：
     simUsd  = 固定名目模擬跟單的損益（扣雙邊估算手續費）
     realUsd = 錢包自己的實際已實現盈虧（Hyperliquid closedPnl）
   整頁指標可用右上切換「以哪一個為計算基礎」，兩者定義完全一致。

   指標定義（畫面上都有 tooltip，數字與定義必須對得上）：
     勝率        = 獲利筆數 ÷ 總筆數
     獲利因子 PF = 總獲利 ÷ |總虧損|          （>1 才是正期望；1.5 以上算不錯）
     賺賠比      = 平均獲利 ÷ |平均虧損|
     期望值      = 每筆平均淨盈虧
     標準差 σ    = 每筆淨盈虧的標準差
     穩定度      = 期望值 ÷ σ                 （每筆層級的類 Sharpe，愈大愈穩）
     最大回撤    = 累積盈虧曲線「從高點往下的最大跌幅」（金額 + 相當幾 R + 筆數）
     平均 R      = 每筆淨盈虧 ÷ R 基準；R 基準 = 每筆名目 × 假設停損%
                   （跟單的曝險就是名目本身，等同現貨式曝險，不乘大戶槓桿——
                     與 SG.simPnl 的算法一致。跟別人的單沒有固定停損，
                     所以用「假設停損%」當風險基準並在畫面明列，可切 1% / 1.5% / 2%）
     最大連續勝敗 = 連續獲利／連續虧損的最長筆數
   ══════════════════════════════════════════════════════════════ */
(function (w) {
  'use strict';
  const S = w.SENTINEL, U = S.util;
  const M = S.sgMetrics = {
    basis: 'sim',      // 'sim' 模擬跟單 | 'real' 大戶真實
    slPct: 1.5,        // R 基準用的假設停損%
    canvas: null, res: null, lastKey: ''
  };

  const money = v => (v >= 0 ? '+$' : '−$') + U.money(Math.abs(v));
  const pct = (v, d) => isFinite(v) ? (v * 100).toFixed(d === undefined ? 1 : d) + '%' : '—';
  const rnum = v => isFinite(v) ? (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2) + 'R' : '—';
  const hold = ms => {
    if (!isFinite(ms) || ms <= 0) return '—';
    const m = ms / 60000;
    if (m < 60) return Math.round(m) + ' 分';
    const h = m / 60;
    return h < 24 ? h.toFixed(1) + ' 小時' : (h / 24).toFixed(1) + ' 天';
  };

  /* ── 取樣：已平倉且有該基準盈虧的回合（時間序） ─────────── */
  M.netOf = function (r) {
    const v = M.basis === 'real' ? r.realUsd : r.simUsd;
    return isFinite(v) ? v : NaN;
  };
  M.riskOf = function () {
    const SG = S.signals;
    const size = (SG && SG.copySize) ? SG.copySize() : 0;
    return size * (M.slPct / 100);
  };
  M.samples = function () {
    const SG = S.signals;
    if (!SG || !SG.rounds) return [];
    return SG.rounds
      .filter(r => r.status === 'closed' && isFinite(M.netOf(r)))
      .sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0));
  };

  /* ── 指標計算 ─────────────────────────────────────────── */
  M.compute = function () {
    const rows = M.samples();
    const nets = rows.map(M.netOf);
    const N = nets.length;
    const out = { rows, N, nets, empty: N === 0 };
    if (!N) return out;

    let sum = 0, wins = 0, losses = 0, gw = 0, gl = 0, best = -Infinity, worst = Infinity;
    let sumR = 0, rCount = 0;
    nets.forEach(n => {
      sum += n;
      if (n > 0) { wins++; gw += n; } else if (n < 0) { losses++; gl += -n; }
      if (n > best) best = n;
      if (n < worst) worst = n;
    });
    out.sum = sum; out.wins = wins; out.losses = losses;
    out.winRate = wins / N;
    out.avg = sum / N;
    out.grossWin = gw; out.grossLoss = gl;
    out.pf = gl > 0 ? gw / gl : (gw > 0 ? Infinity : NaN);
    out.avgWin = wins ? gw / wins : NaN;
    out.avgLoss = losses ? gl / losses : NaN;
    out.payoff = (wins && losses) ? (gw / wins) / (gl / losses) : NaN;
    out.best = best; out.worst = worst;

    const varr = nets.reduce((a, n) => a + (n - out.avg) * (n - out.avg), 0) / N;
    out.sd = Math.sqrt(varr);
    out.stability = out.sd > 0 ? out.avg / out.sd : NaN;

    /* 累積曲線 + 回撤（金額、R、筆數、期間） */
    const eq = []; const dd = []; let peak = 0, peakIdx = 0, mdd = 0, mddAt = 0, mddFrom = 0, mddLen = 0, curDD = 0;
    nets.forEach((n, i) => {
      const prev = i ? eq[i - 1] : 0;
      const v = prev + n;
      eq.push(v);
      if (v > peak) { peak = v; peakIdx = i; }
      const dip = v - peak;
      dd.push(dip);
      if (dip < mdd) { mdd = dip; mddAt = i; mddFrom = peakIdx; }
    });
    out.eq = eq; out.dd = dd; out.mdd = mdd; out.mddAt = mddAt;
    out.mddLen = Math.max(0, mddAt - mddFrom);
    out.curDD = dd[N - 1];
    out.peak = Math.max.apply(null, eq);
    out.mddPct = out.peak > 0 ? mdd / out.peak : NaN;

    /* 連續勝敗 */
    let cw = 0, cl = 0, mw = 0, ml = 0;
    nets.forEach(n => {
      if (n > 0) { cw++; cl = 0; } else if (n < 0) { cl++; cw = 0; } else { cw = 0; cl = 0; }
      if (cw > mw) mw = cw;
      if (cl > ml) ml = cl;
    });
    out.maxWinStreak = mw; out.maxLossStreak = ml;

    /* 持倉時間 */
    const holds = rows.map(r => r.holdMs).filter(v => isFinite(v) && v > 0);
    out.avgHold = holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : NaN;
    out.maxHold = holds.length ? Math.max.apply(null, holds) : NaN;

    /* R 基準與 R 倍數 */
    let riskSum = 0;
    rows.forEach(r => {
      const risk = M.riskOf(r);
      if (risk > 0) { riskSum += risk; sumR += M.netOf(r) / risk; rCount++; }
    });
    out.avgRisk = rCount ? riskSum / rCount : NaN;
    out.avgR = rCount ? sumR / rCount : NaN;
    out.sumR = rCount ? sumR : NaN;
    out.mddR = out.avgRisk > 0 ? mdd / out.avgRisk : NaN;

    /* 分組：依幣種、依跟單錢包 */
    const group = (keyFn, nameFn) => {
      const map = new Map();
      rows.forEach(r => {
        const k = keyFn(r);
        if (!k) return;
        let g = map.get(k);
        if (!g) { g = { key: k, name: nameFn(r), n: 0, net: 0, win: 0, sumR: 0, rn: 0, holds: 0, hn: 0 }; map.set(k, g); }
        const n = M.netOf(r);
        g.n++; g.net += n; if (n > 0) g.win++;
        const risk = M.riskOf(r);
        if (risk > 0) { g.sumR += n / risk; g.rn++; }
        if (isFinite(r.holdMs) && r.holdMs > 0) { g.holds += r.holdMs; g.hn++; }
      });
      return Array.from(map.values()).map(g => ({
        key: g.key, name: g.name, n: g.n, net: g.net, winRate: g.win / g.n,
        avgR: g.rn ? g.sumR / g.rn : NaN, avgHold: g.hn ? g.holds / g.hn : NaN
      })).sort((a, b) => b.net - a.net);
    };
    out.byCoin = group(r => r.coin, r => r.coin);
    out.byWallet = group(r => r.addr, r => r.name || (S.onchain ? S.onchain.short(r.addr) : r.addr));
    return out;
  };

  /* ── 回撤曲線（水下圖）────────────────────────────────── */
  M.drawDD = function (res) {
    const cv = document.getElementById('sgDrawdown'); if (!cv) return;
    const f = S.fit(cv); if (!f) return;
    const { c, w: W, h: H } = f;
    c.clearRect(0, 0, W, H);
    if (!res || !res.N) {
      c.fillStyle = 'rgba(104,113,126,.85)'; c.font = '11px "JetBrains Mono",monospace';
      c.fillText('尚無平倉回合，回撤曲線會在累積後出現', 10, 20); return;
    }
    const pad = { l: 54, r: 10, t: 10, b: 16 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const dd = res.dd, N = dd.length;
    const minDD = Math.min(res.mdd, 0), maxAbs = Math.abs(minDD) || 1;

    // 網格與 Y 軸（0 / -50% / -100% of MDD）
    c.strokeStyle = 'rgba(255,255,255,.06)'; c.lineWidth = 1;
    c.font = '9.5px "JetBrains Mono",monospace'; c.textAlign = 'right';
    [0, .5, 1].forEach(k => {
      const y = Math.round(pad.t + ih * k) + .5;
      c.beginPath(); c.moveTo(pad.l, y); c.lineTo(W - pad.r, y); c.stroke();
      const v = -maxAbs * (1 - k);
      c.fillStyle = 'rgba(104,113,126,.9)';
      c.fillText((v >= 0 ? '+' : '−') + '$' + U.money(Math.abs(v)), pad.l - 6, y + 3);
    });

    const X = i => pad.l + (N === 1 ? iw : (i / (N - 1)) * iw);
    const Y = v => pad.t + ih * (1 - (v / -maxAbs));
    // 水下填色
    const grad = c.createLinearGradient(0, pad.t, 0, pad.t + ih);
    grad.addColorStop(0, 'rgba(246,70,93,.06)'); grad.addColorStop(1, 'rgba(246,70,93,.26)');
    c.beginPath(); c.moveTo(X(0), Y(0));
    dd.forEach((v, i) => c.lineTo(X(i), Y(v)));
    c.lineTo(X(N - 1), Y(0)); c.closePath();
    c.fillStyle = grad; c.fill();
    c.beginPath(); dd.forEach((v, i) => i ? c.lineTo(X(i), Y(v)) : c.moveTo(X(i), Y(v)));
    c.strokeStyle = 'rgba(246,70,93,.85)'; c.lineWidth = 1.2; c.stroke();

    // 最大回撤標記
    if (res.mdd < 0) {
      const x = X(res.mddAt), y = Y(res.mdd);
      c.setLineDash([3, 3]); c.strokeStyle = 'rgba(245,165,36,.55)';
      c.beginPath(); c.moveTo(x, pad.t); c.lineTo(x, pad.t + ih); c.stroke(); c.setLineDash([]);
      c.fillStyle = 'rgba(245,165,36,.95)'; c.textAlign = 'left';
      c.fillText('最大回撤 ' + money(res.mdd), Math.min(x + 5, W - 110), pad.t + 10);
      c.beginPath(); c.arc(x, y, 2.4, 0, 6.2832); c.fill();
    }
    // 時間軸
    c.fillStyle = 'rgba(104,113,126,.85)'; c.textAlign = 'left';
    const t0 = res.rows[0].closedAt, t1 = res.rows[N - 1].closedAt;
    const dstr = t => new Date(t).toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' });
    c.fillText(dstr(t0), pad.l, H - 4);
    c.textAlign = 'right'; c.fillText(dstr(t1), W - pad.r, H - 4);
    c.textAlign = 'center'; c.fillStyle = 'rgba(104,113,126,.7)';
    c.fillText('回撤曲線（累積盈虧自高點往下的幅度）', pad.l + iw / 2, H - 4);
  };

  /* ── 渲染 ─────────────────────────────────────────────── */
  const tile = (label, value, sub, cls, tip) =>
    `<div class="kpi"${tip ? ` title="${tip}"` : ''}><label>${label}</label>` +
    `<b class="${cls || ''}">${value}</b>${sub ? `<span class="mini">${sub}</span>` : ''}</div>`;

  M.render = function () {
    const res = M.compute();
    M.res = res;
    const box = document.getElementById('sgKpi');
    const meta = document.getElementById('sgMetMeta');
    const basisLabel = M.basis === 'real' ? '大戶實際已實現' : '模擬跟單';
    const SG = S.signals, acc = SG && SG.account ? SG.account() : null;
    if (meta) {
      const sizeTxt = (SG && SG.copySize) ? ('每筆名目 ' + ' $' + U.money(SG.copySize()))
        + (SG.cfg.sizeMode === 'pct' ? `（本金 ${SG.cfg.sizePct}%）` : '（固定）') : '';
      meta.innerHTML = `樣本 <b>${res.N}</b> 筆平倉 · 計算基礎：<b>${basisLabel}</b> · `
        + (acc && acc.capital > 0 ? `本金 $${U.money(acc.capital)} · ` : '') + sizeTxt
        + ` · R 基準＝名目×${M.slPct}%（不乘槓桿）`;
    }

    if (box) {
      if (!res.N) {
        box.innerHTML = '<div class="empty" style="padding:12px">尚無平倉回合。大戶平倉後會自動累積，指標隨之出現。</div>';
      } else {
        const pfTxt = !isFinite(res.pf) ? (res.pf === Infinity ? '∞' : '—') : res.pf.toFixed(2);
        box.innerHTML = [
          (acc ? tile('模擬本金', '$' + U.money(acc.capital), (SG.cfg.sizeMode === 'pct' ? ('每筆 = 本金 ' + SG.cfg.sizePct + '%') : '每筆固定名目'), '', '設定的模擬本金（帳戶層級績效的基準）') : ''),
          (acc ? tile('帳戶淨值', (acc.equity >= 0 ? '$' : '−$') + U.money(Math.abs(acc.equity)), '本金 ' + money(acc.net) + ' 累計', acc.equity >= acc.capital ? 'up' : 'down', '本金 + 累計淨盈虧（固定本金、不複利）') : ''),
          (acc ? tile('總報酬率', isFinite(acc.ret) ? ((acc.ret >= 0 ? '+' : '−') + Math.abs(acc.ret * 100).toFixed(2) + '%') : '—', '相對本金', acc.ret >= 0 ? 'up' : 'down', '累計淨盈虧 ÷ 模擬本金') : ''),
          (acc ? tile('回撤（相對本金）', isFinite(acc.mdd) ? (acc.mdd * 100).toFixed(2) + '%' : '—', '$' + U.money(Math.abs(acc.mdd * acc.capital)) + ' 高點回落', 'warn', '累積淨值自高點往下的最大跌幅 ÷ 模擬本金') : ''),
          tile('總淨盈虧', money(res.sum), `期望值 ${money(res.avg)}／筆`, res.sum >= 0 ? 'up' : 'down', '所有已平倉回合的淨盈虧總和（含雙邊估算手續費）'),
          tile('勝率', pct(res.winRate), `${res.wins} 勝 / ${res.losses} 敗`, res.winRate >= .5 ? 'up' : '', '獲利筆數 ÷ 總筆數'),
          tile('獲利因子', pfTxt, `總獲利 ${'$' + U.money(res.grossWin)} ÷ 總虧損 ${'$' + U.money(res.grossLoss)}`, res.pf >= 1 ? 'up' : 'down', '總獲利 ÷ |總虧損|。>1 為正期望，>1.5 算穩健'),
          tile('賺賠比', isFinite(res.payoff) ? res.payoff.toFixed(2) : '—', `均賺 ${money(res.avgWin)}／均賠 ${money(-Math.abs(res.avgLoss))}`, res.payoff >= 1 ? 'up' : '', '平均獲利 ÷ |平均虧損|'),
          tile('最大回撤', money(res.mdd), `${isFinite(res.mddR) ? Math.abs(res.mddR).toFixed(2) + 'R · ' : ''}${res.mddLen ? res.mddLen + ' 筆內' : '單筆'}`, 'warn', '累積盈虧曲線從高點往下的最大跌幅（金額）'),
          tile('當前回撤', res.curDD < 0 ? money(res.curDD) : '$0', `${pct(res.mddPct)}（相對最高點）`, res.curDD < 0 ? 'warn' : '', '目前距離歷史高點還差多少'),
          tile('平均 R', rnum(res.avgR), `總計 ${isFinite(res.sumR) ? (res.sumR >= 0 ? '+' : '−') + Math.abs(res.sumR).toFixed(1) + 'R' : '—'} · 基準 $${U.money(res.avgRisk)}`, res.avgR >= 0 ? 'up' : 'down', '每筆淨盈虧 ÷ R 基準（名目×槓桿×假設停損%）'),
          tile('盈虧穩定度', isFinite(res.stability) ? res.stability.toFixed(3) : '—', `標準差 $${U.money(res.sd)}`, res.stability > 0 ? 'up' : 'down', '期望值 ÷ 標準差（每筆層級的類 Sharpe，愈大愈穩）'),
          tile('最大連續獲利', res.maxWinStreak + ' 筆', `最大連續虧損 ${res.maxLossStreak} 筆`, '', '連續獲利／連續虧損的最長筆數'),
          tile('最佳單筆', money(res.best), '', 'up', '單筆最大獲利'),
          tile('最差單筆', money(res.worst), '', 'down', '單筆最大虧損'),
          tile('平均持倉', hold(res.avgHold), `最長 ${hold(res.maxHold)}`, '', '模擬跟單的持有時間平均／最長'),
          tile('大戶真實累計', (() => { const t = res.rows.reduce((a, r) => a + (isFinite(r.realUsd) ? r.realUsd : 0), 0); return (t >= 0 ? '+$' : '−$') + U.money(Math.abs(t)); })(), '同期間錢包自己的已實現盈虧', '', '同一個樣本區間內，這些錢包自己賺賠多少（Hyperliquid closedPnl）'),
          tile('樣本區間', `${new Date(res.rows[0].closedAt).toLocaleDateString('zh-TW')} 起`, `${res.N} 筆 · 約 ${Math.max(1, Math.round((res.rows[res.N - 1].closedAt - res.rows[0].closedAt) / 3600e3))} 小時`, '', '第一批與最後一批平倉的時間範圍')
        ].join('');
      }
    }
    M.drawDD(res);

    /* 分組表 */
    const gtable = (el, list, nameHead) => {
      if (!el) return;
      if (!list || !list.length) { el.innerHTML = '<div class="empty" style="padding:8px 0">尚無資料</div>'; return; }
      const max = Math.max.apply(null, list.map(g => Math.abs(g.net))) || 1;
      el.innerHTML = `<div class="ggh"><span>${nameHead}</span><span class="ta-r">筆數</span><span class="ta-r">勝率</span><span class="ta-r">平均R</span><span class="ta-r">淨盈虧</span></div>` +
        list.slice(0, 6).map(g => {
          const w = Math.round(Math.abs(g.net) / max * 100);
          const cls = g.net >= 0 ? 'up' : 'down';
          return `<div class="ggr"${g.key && g.key.length > 20 ? ` data-addr="${g.key}"` : ''}>
            <span class="nm"><b>${g.name}</b><i class="gbar ${cls}" style="width:${w}%"></i></span>
            <span class="ta-r mini">${g.n}</span>
            <span class="ta-r mini">${pct(g.winRate, 0)}</span>
            <span class="ta-r ${cls}">${rnum(g.avgR)}</span>
            <span class="ta-r ${cls}">${money(g.net)}</span>
          </div>`;
        }).join('');
    };
    gtable(document.getElementById('sgByCoin'), res.byCoin, '幣種');
    gtable(document.getElementById('sgByWallet'), res.byWallet, '跟單錢包');
  };

  /* ── 互動與排程 ───────────────────────────────────────── */
  M.init = function () {
    const b = document.getElementById('sgBasisSeg');
    if (b) b.addEventListener('click', e => {
      const btn = e.target.closest('button'); if (!btn) return;
      Array.prototype.forEach.call(b.parentNode.children, x => x.classList.toggle('on', x === btn));
      M.basis = btn.dataset.basis === 'real' ? 'real' : 'sim';
      M.render();
    });
    const s = document.getElementById('sgSlSeg');
    if (s) s.addEventListener('click', e => {
      const btn = e.target.closest('button'); if (!btn) return;
      Array.prototype.forEach.call(s.parentNode.children, x => x.classList.toggle('on', x === btn));
      M.slPct = +btn.dataset.sl || 1.5;
      M.render();
    });
    if (window.ResizeObserver) new ResizeObserver(U.raf(() => M.drawDD(M.res))).observe(document.body);
    /* 背景分頁降頻、但不要停：若整段跳過，分頁在背景開啟時會一直停在
       「尚無平倉回合」的空狀態，切回來也還要是舊的。 */
    let tick = 0;
    setInterval(() => {
      tick++;
      if (document.hidden && tick % 4 !== 0) return;
      M.render();
    }, 2500);
    M.render();
  };

  S.ready(() => {
    if (!document.getElementById('sgKpi')) return;   // 只在帶單頁作用
    // 等 signals 載入完成後再開跑
    setTimeout(M.init, 600);
  });
})(window);
