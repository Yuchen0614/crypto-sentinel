/* signals.js — 開倉／平倉「帶單」記錄與盈虧引擎
   ─────────────────────────────────────────────────────────────
   兩種資料來源，互補：

   1. 即時追蹤（持倉差分）：每 5 秒輪詢 Hyperliquid 大戶持倉，把
      「從無到有 → 加減碼 → 歸零」串成一個回合（round），進場價用錢包自己的
      進場均價，出場價由最後一次快照的未實現損益反推，精確度高、但只有我們
      開著頁面時才觀察得到。
   2. 成交聚合（userFillsByTime）：Hyperliquid 每一筆成交都帶 dir（Open/Close
      Long|Short）、成交價與 closedPnl（該筆已實現盈虧）。用 FIFO 隊列把
      開倉成交與平倉成交配對，可以得到「這一輪平倉實際賺賠多少」——這是真實
      數字，也是歷史記錄的來源（本頁一載入就有內容）。

   注意（畫面上也會標示）：
   * 這些大戶把單子切成上百筆小成交（單筆常見數百至數千美元），所以「帶單」
     一律以回合／批次聚合，不用單筆成交當訊號。
   * 「模擬跟單盈虧」是若以固定名目（預設 $10,000）同方向跟進、並在該錢包平倉
     時出場的結果，扣掉估算手續費；這是紙上計算，不是下單、也不是投資建議。
   * Hyperliquid 單次最多回 2000 筆成交；成交極度頻繁的錢包在長窗期可能被截斷，
     這種情況會在該列標示「可能低估」。
*/
(function (w) {
  'use strict';
  const S = w.SENTINEL, U = S.util, OC = S.onchain;
  const SG = S.signals = {};

  SG.cfg = {
    copyNotional: 10000,   // 模擬跟單：每筆固定名目（USDC）
    capital: 100000,       // 模擬本金（USDC）：帳戶層級的績效（淨值／報酬率／回撤%）用它當基準
    sizeMode: 'fixed',     // 'fixed' 固定名目 ｜ 'pct' 每筆＝本金 × sizePct%
    sizePct: 5,            // sizeMode='pct' 時使用
    follow: [],            // 跟單錢包白名單（空陣列＝跟全部大戶）
    feeRate: 0.00045,      // 手續費估算（單邊 taker）
    minNotional: 250000,   // 記錄門檻：回合／批次名目 ≥ 此值才進帳
    seedWallets: 12,       // 首次載入時抓成交紀錄的錢包數
    seedMinutes: 10,       // 首次載入的回看分鐘數
    gapMs: 15 * 60e3,      // 同幣同方向的平倉成交，相隔小於此值算同一批次
    maxRounds: 800, maxEvents: 400
  };

  SG.rounds = [];     // 帳本：即時追蹤的回合 + 成交聚合的批次
  SG.events = [];     // 帶單流水（OPEN/ADD/CUT/CLOSE/FLIP）
  SG.seen = {};       // 成交去重（tid / hash）
  SG.prev = new Map();// addr → 上次持倉快照（自己維護，與 onchain.js 的差分互不影響）
  SG.queues = new Map();// coin → { long: [...], short: [...] } FIFO 開倉隊列
  SG.mids = null;
  SG.pnlDaily = null;
  SG.startAt = 0;     // 「重新開始計算」的時間點：早於此的成交不再進帳本
  SG.lastFillAt = 0;

  const F = v => (isFinite(v) ? v : NaN);
  const dirOf = side => (side === 'long' ? 1 : -1);
  const now = () => Date.now();

  /* ── 持久化（瀏覽器端）───────────────────────────────────
     記錄存在 localStorage，重新整理不會消失；但清快取會。
     長期保存請看頁面上的「每日績效快照」（由 GitHub Actions 每日寫入 data/pnl-daily.json）。 */
  SG.load = function () {
    try {
      const j = JSON.parse(localStorage.getItem('cs.signals.v2') || 'null');
      if (j) {
        SG.rounds = Array.isArray(j.rounds) ? j.rounds : [];
        SG.events = Array.isArray(j.events) ? j.events : [];
        SG.seen = j.seen || {};
        SG.cfg = Object.assign(SG.cfg, j.cfg || {});
        SG.since = j.since || 0;
        SG.startAt = j.startAt || 0;
      }
    } catch (e) { S.errors.push('signals load: ' + e.message); }
  };
  SG.save = function () {
    try {
      localStorage.setItem('cs.signals.v2', JSON.stringify({
        v: 2, at: now(), cfg: SG.cfg, since: SG.since || 0, startAt: SG.startAt || 0,
        rounds: SG.rounds.slice(-SG.cfg.maxRounds), events: SG.events.slice(0, SG.cfg.maxEvents),
        seen: SG.trimSeen()
      }));
    } catch (e) { /* 容量滿就放棄這一輪 */ }
  };
  SG.trimSeen = function () {
    const keys = Object.keys(SG.seen);
    if (keys.length > 6000) keys.sort((a, b) => SG.seen[a] - SG.seen[b]).slice(0, 3000).forEach(k => delete SG.seen[k]);
    return SG.seen;
  };
  SG.clear = function () { SG.rounds = []; SG.events = []; SG.seen = {}; SG.prev.clear(); SG.queues.clear(); SG.since = 0; SG.save(); };

  /* ── 模擬本金與每筆名目 ───────────────────────────────
     固定名目：直接用 copyNotional。
     本金百分比：每筆名目 = 本金 × sizePct%（固定本金、不複利，數字可重現）。
     跟單的曝險就是這個名目本身（等同現貨式曝險），不再乘大戶槓桿——
     這點與 simPnl 的算法一致，也是 R 基準不乘槓桿的原因。 */
  SG.copySize = function () {
    const c = SG.cfg;
    if (c.sizeMode === 'pct') {
      const n = (+c.capital || 0) * (+c.sizePct || 0) / 100;
      if (n > 0) return n;
    }
    return +c.copyNotional || 0;
  };
  /* 跟單範圍：名單為空＝跟全部大戶 */
  SG.follows = function (addr) {
    const f = SG.cfg.follow;
    if (!f || !f.length) return true;
    return f.indexOf(addr) >= 0;
  };
  /* 重新開始計算：清空本機帳本，並把起點設為現在（早於起點的成交不再進帳本） */
  SG.restart = function () {
    SG.clear();
    SG.startAt = now();
    SG.since = SG.startAt;
    SG.save();
    S.emit('sig-restart', { at: SG.startAt });
    return SG.startAt;
  };
  /* 用目前的名目設定重算已記錄回合（只動模擬跟單那條線，真實盈虧不變） */
  SG.recomputeAll = function () {
    let n = 0;
    SG.rounds.forEach(r => {
      if (r.status !== 'closed') return;
      const v = SG.simPnl(r.entryPx, r.exitPx, r.side);
      if (isFinite(v)) { r.simUsd = v; r.simPct = SG.simPct(r.entryPx, r.exitPx, r.side); n++; }
    });
    SG.save();
    return n;
  };
  /* 帳戶層級（以本金為基準） */
  SG.account = function () {
    const cap = +SG.cfg.capital || 0;
    const rows = SG.rounds.filter(r => r.status === 'closed' && isFinite(r.simUsd));
    const net = rows.reduce((a, r) => a + r.simUsd, 0);
    let peak = cap, mdd = 0, eq = cap;
    rows.slice().sort((a, b) => a.closedAt - b.closedAt).forEach(r => {
      eq += r.simUsd;
      if (eq > peak) peak = eq;
      const dip = eq - peak;
      if (dip < mdd) mdd = dip;
    });
    return {
      capital: cap, net, equity: cap + net,
      ret: cap > 0 ? net / cap : NaN,
      mdd: cap > 0 ? mdd / cap : NaN,     // 相對本金的回撤比例
      peak, size: SG.copySize(), trades: rows.length
    };
  };

  /* ── 標記價與模擬跟單損益 ───────────────────────────── */
  SG.setMids = function (m) { if (m) SG.mids = m; };
  SG.mid = function (coin) { const v = SG.mids ? parseFloat(SG.mids[coin]) : NaN; return isFinite(v) ? v : NaN; };
  SG.fee = function (notional) { return Math.abs(notional) * SG.cfg.feeRate; };
  /* 模擬跟單：固定名目、同方向、進出場各收一次估算手續費 */
  SG.simPnl = function (entryPx, exitPx, side, copy) {
    if (!isFinite(entryPx) || !isFinite(exitPx) || entryPx <= 0) return NaN;
    const n = isFinite(copy) ? copy : SG.copySize();
    const gross = n * dirOf(side) * (exitPx / entryPx - 1);
    return gross - SG.fee(n) * 2;
  };
  SG.simPct = function (entryPx, exitPx, side) {
    if (!isFinite(entryPx) || !isFinite(exitPx) || !entryPx) return NaN;
    return dirOf(side) * (exitPx / entryPx - 1);
  };

  /* ── 1. 即時追蹤：持倉差分 → 回合 ───────────────────── */
  const rkey = (addr, coin, side) => addr + '|' + coin + '|' + side;
  SG.findOpen = function (addr, coin, side) {
    for (let i = SG.rounds.length - 1; i >= 0; i--) {
      const r = SG.rounds[i];
      if (r.status === 'open' && r.addr === addr && r.coin === coin && r.side === side) return r;
    }
    return null;
  };

  SG.event = function (kind, r, extra) {
    const e = Object.assign({
      ts: now(), kind, addr: r.addr, name: r.name, coin: r.coin, side: r.side,
      notional: r.notional, entryPx: r.entryPx, lev: r.lev, id: r.id
    }, extra || {});
    SG.events.unshift(e);
    if (SG.events.length > SG.cfg.maxEvents) SG.events.pop();
    S.emit('sig-event', e);
  };

  /* pre = true：這是「頁面載入前就已經存在」的持倉，不算新開倉
     → 不發開倉事件、開倉時間未知（0）、只出現在開倉中清單。 */
  SG.openRound = function (addr, name, p, ts, pre) {
    if (!SG.follows(addr)) return null;                        // 不在跟單名單內
    if (!(p.notional >= SG.cfg.minNotional)) return null;
    if (SG.findOpen(addr, p.coin, p.side)) return null;
    const r = {
      id: 'r' + ts + '-' + Math.random().toString(36).slice(2, 6),
      src: 'track', status: 'open', addr, name, coin: p.coin, side: p.side,
      pre: !!pre, openedAt: pre ? 0 : ts, firstSeen: ts, closedAt: 0, entryPx: F(p.entry), exitPx: NaN,
      size: Math.abs(p.szi), maxSize: Math.abs(p.szi), notional: p.notional, maxNotional: p.notional,
      lev: F(p.lev), adds: 0, cuts: 0, upnlNow: F(p.upnl), realUsd: NaN, simUsd: NaN, holdMs: 0
    };
    SG.rounds.push(r);
    if (!pre) SG.event('OPEN', r, { text: (p.side === 'long' ? '新開多單' : '新開空單'), lev: F(p.lev) });
    return r;
  };

  SG.observePosition = function (addr, snap, name) {
    const ts = now();
    const cur = new Map((snap.pos || []).map(p => [p.coin, p]));
    const prev = SG.prev.get(addr);
    if (!prev) {
      /* 第一次看到這個錢包：它目前的持倉都是「本次載入前就開好的」，
         不算新開倉 —— 記成 pre 回合放進開倉中清單，之後的增減／平倉才會有事件。 */
      cur.forEach(p => SG.openRound(addr, name, p, ts, true));
      SG.prev.set(addr, cur);
      return;
    }
    {
      cur.forEach((p, coin) => {
        const q = prev.get(coin);
        if (!q) { SG.openRound(addr, name, p, ts); return; }
        const flipped = (q.szi > 0) !== (p.szi > 0);
        if (flipped) {
          SG.closeRound(addr, name, q, ts, 'FLIP');
          SG.openRound(addr, name, p, ts);
          return;
        }
        const d = p.notional - q.notional;
        const r = SG.findOpen(addr, coin, p.side);
        if (r) {
          r.entryPx = F(p.entry); r.size = Math.abs(p.szi); r.notional = p.notional;
          r.lev = F(p.lev); r.upnlNow = F(p.upnl);
          if (p.notional > r.maxNotional) r.maxNotional = p.notional;
          if (Math.abs(p.szi) > r.maxSize) r.maxSize = Math.abs(p.szi);
          if (d >= SG.cfg.minNotional * 0.2) {
            r.adds++;
            SG.event('ADD', r, { delta: d, text: '加碼 ' + U.usd(d) + ' → ' + U.usd(p.notional) });
          } else if (-d >= SG.cfg.minNotional * 0.2) {
            r.cuts++;
            SG.event('CUT', r, { delta: d, text: '減碼 ' + U.usd(-d) + ' → ' + U.usd(p.notional) });
          }
        } else if (p.notional >= SG.cfg.minNotional) {
          SG.openRound(addr, name, p, ts, true); // 之前低於門檻，長大了才開始記錄（開倉時間未知）
        }
      });
      prev.forEach((q, coin) => { if (!cur.has(coin)) SG.closeRound(addr, name, q, ts, 'CLOSE'); });
    }
    SG.prev.set(addr, cur);
  };

  /* 平倉：出場價由最後一次快照反推（entry + 未實現損益/數量），
     真實盈虧再向 Hyperliquid 要該段時間的成交 closedPnl 補上。 */
  SG.closeRound = function (addr, name, q, ts, why) {
    const r = SG.findOpen(addr, q.coin, q.side);
    if (!r) return;
    const sz = Math.abs(q.szi) || 1;
    const px = F(q.entry) + dirOf(q.side) * (F(q.upnl) / sz);
    r.status = 'closed'; r.closedAt = ts; r.exitPx = isFinite(px) ? px : NaN;
    r.holdMs = Math.max(0, ts - r.openedAt);
    r.simUsd = SG.simPnl(r.entryPx, r.exitPx, r.side);
    r.simPct = SG.simPct(r.entryPx, r.exitPx, r.side);
    r.realSrc = 'pending';
    SG.event('CLOSE', r, {
      why: why, exitPx: r.exitPx, simUsd: r.simUsd,
      text: '平倉 ' + U.px(r.exitPx) + (isFinite(r.simUsd) ? ' · 模擬跟單 ' + U.signed(r.simUsd, v => '$' + U.money(Math.abs(v))) : '')
    });
    SG.attachReal(r);
    SG.save();
  };

  /* 向 HL 要這一輪的真實已實現盈虧（成交 closedPnl 加總） */
  SG.attachReal = async function (r) {
    const from = Math.max(r.openedAt - 60e3, (r.closedAt || now()) - 7 * 24 * 3600e3);
    const fills = await S.api.hlFills(r.addr, from);
    if (!fills) { r.realSrc = 'na'; return; }
    let pnl = 0, fee = 0, n = 0, capped = fills.length >= 2000;
    fills.forEach(f => {
      if (f.coin !== r.coin) return;
      if (f.time < r.openedAt - 60e3 || f.time > (r.closedAt || now()) + 60e3) return;
      if (typeof f.dir !== 'string' || f.dir.indexOf('Close') !== 0) return;
      pnl += (+f.closedPnl || 0); fee += (+f.fee || 0); n++;
    });
    r.realUsd = pnl; r.realFee = fee; r.realFills = n; r.realSrc = capped ? 'capped' : 'fills';
    SG.save();
  };

  /* ── 2. 成交聚合：FIFO 配對 → 平倉批次（真實盈虧、可回溯）── */
  const qOf = (coin) => { if (!SG.queues.has(coin)) SG.queues.set(coin, { long: [], short: [] }); return SG.queues.get(coin); };

  SG.ingestFills = function (addr, fills, name) {
    if (!Array.isArray(fills) || !fills.length) return 0;
    const list = fills.slice().sort((a, b) => a.time - b.time)
      .filter(f => SG.follows(addr) && (!SG.startAt || +f.time >= SG.startAt));
    if (!list.length) return 0;
    let added = 0;
    for (const f of list) {
      const k = String(f.tid || f.hash || (addr + f.time + f.coin + f.px + f.sz));
      if (SG.seen[k]) continue;
      SG.seen[k] = now(); added++;
      const coin = f.coin, px = +f.px, sz = +f.sz, ts = +f.time, dir = String(f.dir || '');
      if (!coin || !isFinite(px) || !isFinite(sz)) continue;
      if (dir === 'Buy' || dir === 'Sell') continue;              // 現貨，不是合約倉位
      const notional = px * sz;
      const q = qOf(coin);
      if (dir.indexOf('Open') === 0) {
        const side = dir.indexOf('Long') > 0 ? 'long' : 'short';
        q[side].push({ px, remain: sz, ts, notional });
        continue;
      }
      if (dir.indexOf('Close') === 0) {
        const side = dir.indexOf('Long') > 0 ? 'long' : 'short';
        SG.bookClose(addr, name, coin, side, px, sz, ts, +f.closedPnl || 0, +f.fee || 0, q, f);
        continue;
      }
      if (dir === 'Long > Short' || dir === 'Short > Long') {
        const wasLong = dir === 'Long > Short';
        SG.bookClose(addr, name, coin, wasLong ? 'long' : 'short', px, sz, ts, +f.closedPnl || 0, +f.fee || 0, q, f);
        q[wasLong ? 'short' : 'long'].push({ px, remain: sz, ts, notional });
      }
    }
    if (added) { SG.since = Math.max(SG.since || 0, ...list.map(f => +f.time)); SG.save(); }
    return added;
  };

  /* 消耗 FIFO 開倉隊列，得到這一筆平倉的進場均價，聚合成「平倉批次」 */
  SG.bookClose = function (addr, name, coin, side, px, sz, ts, closedPnl, fee, q, f) {
    let remain = sz, entryNum = 0, entrySz = 0, firstTs = ts;
    const qq = q[side];
    while (remain > 1e-12 && qq.length) {
      const o = qq[0];
      const take = Math.min(remain, o.remain);
      entryNum += o.px * take; entrySz += take; firstTs = Math.min(firstTs, o.ts);
      o.remain -= take; remain -= take;
      if (o.remain <= 1e-12) qq.shift();
    }
    const notional = px * sz;
    const entryPx = entrySz > 0 ? entryNum / entrySz : NaN;
    const partial = remain > 1e-12;                   // 隊列不夠 → 進場資料不完整
    // 找同一幣別、同方向、時間相近且「來源為成交聚合」的批次，併成一列
    let row = null;
    for (let i = SG.rounds.length - 1; i >= 0 && i > SG.rounds.length - 40; i--) {
      const r = SG.rounds[i];
      if (r.src === 'fills' && r.coin === coin && r.side === side && r.status === 'closed' && (ts - r.closedAt) <= SG.cfg.gapMs) { row = r; break; }
    }
    if (!row) {
      row = {
        id: 'f' + ts + '-' + Math.random().toString(36).slice(2, 6), src: 'fills', status: 'closed',
        addr, name, coin, side, openedAt: firstTs, closedAt: ts, entryPx: entryPx, exitPx: px,
        notional, maxNotional: notional, realUsd: 0, realFee: 0, realFills: 0, realSrc: partial ? 'partial' : 'fills',
        simUsd: NaN, simPct: NaN, holdMs: ts - firstTs, fills: 0, lev: NaN, size: sz
      };
      SG.rounds.push(row);
    } else {
      const w = row.notional / (row.notional + notional);
      row.entryPx = isFinite(row.entryPx) && isFinite(entryPx) ? row.entryPx * w + entryPx * (1 - w) : (isFinite(entryPx) ? entryPx : row.entryPx);
      row.exitPx = row.exitPx * w + px * (1 - w);
      row.notional += notional; row.maxNotional = Math.max(row.maxNotional, row.notional);
      row.closedAt = ts; row.holdMs = Math.max(0, ts - row.openedAt);
    }
    row.realUsd = (row.realUsd || 0) + closedPnl;
    row.realFee = (row.realFee || 0) + fee;
    row.realFills = (row.realFills || 0) + 1;
    row.fills = (row.fills || 0) + 1;
    row.partial = row.partial || partial;
    row.simUsd = SG.simPnl(row.entryPx, row.exitPx, row.side);
    row.simPct = SG.simPct(row.entryPx, row.exitPx, row.side);
    row.realPct = isFinite(row.realUsd) && row.notional > 0 ? row.realUsd / row.notional : NaN;
  };

  /* 丟掉低於門檻的批次（掃描表的顯示門檻由 UI 控制，不影響這裡的累計） */
  SG.prune = function () {
    if (SG.rounds.length <= SG.cfg.maxRounds) return;
    const closed = SG.rounds.filter(r => r.status === 'closed').sort((a, b) => a.closedAt - b.closedAt);
    const drop = new Set(closed.slice(0, SG.rounds.length - SG.cfg.maxRounds).map(r => r.id));
    SG.rounds = SG.rounds.filter(r => !drop.has(r.id));
  };

  /* ── 3. 開倉中（未實現）────────────────────────────────
     直接看追蹤錢包目前的持倉，用標記價算「若跟單」的未實現損益。 */
  SG.openPositions = function (minNotional) {
    const min = isFinite(minNotional) ? minNotional : SG.cfg.minNotional;
    const out = [];
    OC.hl.states.forEach((s, addr) => {
      const meta = OC.hl.wallets.find(x => x.addr === addr) || {};
      (s.pos || []).forEach(p => {
        if (!(p.notional >= min)) return;
        const r = SG.findOpen(addr, p.coin, p.side);
        const sim = isFinite(p.entry) && isFinite(SG.mid(p.coin))
          ? SG.simPnl(p.entry, SG.mid(p.coin), p.side)
          : NaN;
        out.push({
          addr, name: meta.name || OC.short(addr), coin: p.coin, side: p.side,
          entryPx: p.entry, mark: SG.mid(p.coin), notional: p.notional, lev: p.lev,
          upnl: p.upnl, roe: p.roe, sim, simPct: SG.simPct(p.entry, SG.mid(p.coin), p.side),
          openedAt: r ? r.openedAt : 0, adds: r ? r.adds : 0, cuts: r ? r.cuts : 0
        });
      });
    });
    out.sort((a, b) => (b.notional - a.notional));
    return out;
  };

  /* ── 4. 統計 ─────────────────────────────────────────── */
  SG.stats = function (opts) {
    const o = opts || {};
    const min = isFinite(o.minNotional) ? o.minNotional : 0;
    const wallet = o.wallet || '';
    const rows = SG.rounds.filter(r => r.status === 'closed'
      && r.maxNotional >= min && (!wallet || r.addr === wallet));
    const sim = rows.filter(r => isFinite(r.simUsd));
    const real = rows.filter(r => isFinite(r.realUsd));
    const sum = (a, k) => a.reduce((s, x) => s + (isFinite(x[k]) ? x[k] : 0), 0);
    const totalSim = sum(sim, 'simUsd'), totalReal = sum(real, 'realUsd');
    const wins = real.filter(r => r.realUsd > 0).length;
    const winsSim = sim.filter(r => r.simUsd > 0).length;
    const best = real.slice().sort((a, b) => b.realUsd - a.realUsd)[0];
    const worst = real.slice().sort((a, b) => a.realUsd - b.realUsd)[0];
    const hold = sim.filter(r => r.holdMs > 0);
    /* 依平倉時間排序的累計曲線（兩條：錢包實際 / 模擬跟單）*/
    const byTime = rows.slice().sort((a, b) => a.closedAt - b.closedAt);
    let cs = 0, cr = 0;
    const curve = byTime.map(r => {
      if (isFinite(r.simUsd)) cs += r.simUsd;
      if (isFinite(r.realUsd)) cr += r.realUsd;
      return { t: r.closedAt, sim: cs, real: cr };
    });
    /* 每個錢包的績效 */
    const byWallet = new Map();
    rows.forEach(r => {
      const m = byWallet.get(r.addr) || { addr: r.addr, name: r.name, n: 0, sim: 0, real: 0, wins: 0, loses: 0, fills: 0, track: 0 };
      m.n++;
      if (isFinite(r.simUsd)) m.sim += r.simUsd;
      if (isFinite(r.realUsd)) { m.real += r.realUsd; if (r.realUsd > 0) m.wins++; else m.loses++; }
      if (r.src === 'track') m.track++;
      byWallet.set(r.addr, m);
    });
    const wallets = Array.from(byWallet.values()).map(m => Object.assign(m, {
      winRate: (m.wins + m.loses) ? m.wins / (m.wins + m.loses) : NaN
    })).sort((a, b) => b.real - a.real);
    /* 每個幣別 */
    const byCoin = new Map();
    rows.forEach(r => {
      const c = byCoin.get(r.coin) || { coin: r.coin, n: 0, sim: 0, real: 0 };
      c.n++; c.sim += isFinite(r.simUsd) ? r.simUsd : 0; c.real += isFinite(r.realUsd) ? r.realUsd : 0;
      byCoin.set(r.coin, c);
    });
    return {
      rows, closed: rows.length,
      open: SG.rounds.filter(r => r.status === 'open').length,
      openFresh: SG.rounds.filter(r => r.status === 'open' && !r.pre).length,
      openPre: SG.rounds.filter(r => r.status === 'open' && r.pre).length,
      totalSim, totalReal, wins, loses: real.length - wins, winsSim, losesSim: sim.length - winsSim,
      winRate: real.length ? wins / real.length : NaN, winRateSim: sim.length ? winsSim / sim.length : NaN,
      best, worst, avgHold: hold.length ? sum(hold, 'holdMs') / hold.length : NaN,
      realSample: real.length, simSample: sim.length,
      curve, wallets, coins: Array.from(byCoin.values()).sort((a, b) => b.real - a.real),
      tracked: rows.filter(r => r.src === 'track').length,
      since: SG.since || 0
    };
  };

  /* ── 5. 匯出（方便自己留存）────────────────────────── */
  SG.toCSV = function (opts) {
    const st = SG.stats(opts);
    const head = ['平倉時間', '錢包', '幣別', '方向', '進場價', '出場價', '名目(USD)', '實際盈虧(USD)', '模擬跟單盈虧(USD)', '報酬率', '持有分鐘', '來源'];
    const lines = [head.join(',')];
    st.rows.slice().sort((a, b) => b.closedAt - a.closedAt).forEach(r => {
      lines.push([
        new Date(r.closedAt).toISOString(), r.addr, r.coin, r.side === 'long' ? '多' : '空',
        isFinite(r.entryPx) ? r.entryPx : '', isFinite(r.exitPx) ? r.exitPx : '',
        Math.round(r.notional || 0),
        isFinite(r.realUsd) ? Math.round(r.realUsd) : '',
        isFinite(r.simUsd) ? Math.round(r.simUsd) : '',
        isFinite(r.realPct) ? (r.realPct * 100).toFixed(2) + '%' : '',
        Math.round((r.holdMs || 0) / 60000), r.src === 'track' ? '即時追蹤' : '成交聚合'
      ].join(','));
    });
    return lines.join('\n');
  };
})(window);
