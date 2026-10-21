/* book.js — 訂單簿 DOM 渲染：買賣階梯、深度條、價差、掛單牆 */
'use strict';
(function (w) {
  const S = w.SENTINEL, U = S.util;
  const N = 11;   // 每側顯示檔數
  const Bk = S.bookUI = {
    askRows: [], bidRows: [], built: false,
    init() {
      const ab = document.getElementById('bookAsks'), bb = document.getElementById('bookBids');
      if (!ab || !bb) return;
      ab.innerHTML = ''; bb.innerHTML = '';
      for (let i = 0; i < N; i++) {
        const tr = document.createElement('tr'); tr.className = 'ask';
        tr.innerHTML = '<td class="ta-r px ask-px">—</td><td class="ta-r">—</td><td class="ta-r">—</td><td class="ta-r">—</td>';
        ab.appendChild(tr); this.askRows.push(tr);
      }
      for (let i = 0; i < N; i++) {
        const tr = document.createElement('tr'); tr.className = 'bid';
        tr.innerHTML = '<td class="ta-r px bid-px">—</td><td class="ta-r">—</td><td class="ta-r">—</td><td class="ta-r">—</td>';
        bb.appendChild(tr); this.bidRows.push(tr);
      }
      this.built = true;
    },
    _fill(rows, list, side) {
      if (!list || !list.length) return;
      const maxN = Math.max.apply(null, list.slice(0, N).map(x => x[1] * x[0])) || 1;
      let cum = 0;
      // asks 自上而下 = 由遠到近
      const ordered = side === 'ask' ? list.slice(0, N).reverse() : list.slice(0, N);
      for (let i = 0; i < N; i++) {
        const tr = rows[i], d = ordered[i];
        const tds = tr.children;
        if (!d) { tds[0].textContent = '—'; tds[1].textContent = ''; tds[2].textContent = ''; tds[3].textContent = ''; tr.style.setProperty('--w', '0%'); continue; }
        const notional = d[0] * d[1];
        const pct = U.clamp(notional / maxN * 100, 2, 100);
        // 深度條：以背景漸層表現相對掛單量（相容性優於偽元素）
        tr.style.backgroundImage = side === 'ask'
          ? `linear-gradient(90deg, rgba(255,77,109,0) 0%, rgba(255,77,109,.22) ${pct}%, transparent ${pct}%)`
          : `linear-gradient(90deg, rgba(38,255,168,0) 0%, rgba(38,255,168,.22) ${pct}%, transparent ${pct}%)`;
        tr.style.backgroundSize = '100% 100%';
        tr.style.backgroundRepeat = 'no-repeat';
        const qtyTxt = U.qty(d[1]);
        if (tds[0].textContent !== U.pxSym(d[0])) {
          tds[0].textContent = U.pxSym(d[0]);
          if (side === 'bid') { tr.classList.remove('newrow'); void tr.offsetWidth; tr.classList.add('newrow'); }
        }
        if (tds[1].textContent !== qtyTxt) tds[1].textContent = qtyTxt;
        tds[2].textContent = U.money(notional);
        const pctStr = ((d[0] / (S.analytics.Book.mid || d[0]) - 1) * 100);
        tds[3].textContent = (side === 'ask' ? '+' : '') + pctStr.toFixed(2) + '%';
        tds[3].style.color = side === 'ask' ? 'rgba(255,77,109,.65)' : 'rgba(38,255,168,.65)';
      }
    },
    render(b) {
      if (!this.built) this.init();
      if (!b || !b.bids || !b.bids.length) return;
      const bt = b.mergedBids || b.bids, at = b.mergedAsks || b.asks;
      this._fill(this.askRows, at, 'ask');
      this._fill(this.bidRows, bt, 'bid');

      // 價差
      const m = b.metrics || {};
      if (isFinite(b.spread)) {
        const bp = (b.spread / b.mid) * 100;
        U.html('#bookSpread', `價差 <b>${U.px(b.spread)}</b> · ${bp.toFixed(3)}% · 中價 <b>${U.px(b.mid)}</b>`);
      }
      U.text('#bookMeta', `深度 ${b.levels || 0} 檔 · 涵蓋中價 ±${((b.depthRange || 0) * 100).toFixed(3)}% · 2.2 秒快照`);
      // 不平衡條
      const imb = m.imb || 0, k = U.clamp((imb + 1) / 2, 0, 1);
      const fill = document.getElementById('imbFill');
      if (fill) fill.style.width = (k * 100).toFixed(1) + '%';
      U.text('#imbBid', '買 ' + U.usd(m.bNear || 0));
      U.text('#imbAsk', '賣 ' + U.usd(m.aNear || 0));
      const rEl = document.getElementById('imbRatio');
      if (rEl) {
        const rb = (m.bNear || 0) / ((m.aNear || 0) || 1);
        rEl.textContent = (imb > 0 ? '買方主導 ' : '賣方主導 ') + (imb * 100).toFixed(1) + '% · 買賣比 ' + rb.toFixed(2) + '×';
        rEl.style.color = imb > 0 ? 'var(--gn)' : 'var(--rd)';
        rEl.title = '前 200 檔買賣掛單金額不平衡度（近端 + 中段）';
      }
      // 各檔位區段買賣壓力
      const bw = document.getElementById('imbBands');
      if (bw && m.segs) {
        if (bw.children.length !== m.segs.length) {
          bw.innerHTML = m.segs.map(x => `<div class="band"><label>${x.label}</label><b>—</b><i></i></div>`).join('');
        }
        m.segs.forEach((x, i) => {
          const el = bw.children[i]; if (!el) return;
          const v = U.clamp((x.imb + 1) / 2, 0, 1);
          el.querySelector('b').textContent = (x.imb * 100).toFixed(1) + '%';
          el.querySelector('b').style.color = x.imb > 0 ? 'var(--gn)' : 'var(--rd)';
          const col = x.imb >= 0 ? 'var(--gn)' : 'var(--rd)';
          el.querySelector('i').style.background =
            `linear-gradient(90deg, ${col} 0%, ${col} ${(v * 100).toFixed(1)}%, rgba(255,255,255,.08) ${(v * 100).toFixed(1)}%)`;
        });
      }
      // 掛單牆
      const wl = document.getElementById('wallList');
      if (wl) {
        const walls = b.walls || [];
        if (!walls.length) wl.innerHTML = '<div class="empty">目前無明顯掛單牆（10 檔之後、金額達同側中位數 5 倍且 ≥$15 萬）</div>';
        else {
          const key = walls.map(x => x.side + x.px.toFixed(8)).join(',');
          if (wl.__key !== key) {
            wl.__key = key;
            wl.innerHTML = walls.map(x =>
              `<div class="wall ${x.side}"><span class="tag">${x.side === 'bid' ? '買牆' : '賣牆'}</span>` +
              `<span class="px">${U.pxSym(x.px)}</span>` +
              `<span class="dist">距中價 ${(x.dist * 100).toFixed(3)}%</span>` +
              `<span class="sz">$${U.money(x.notional)} <em style="font-style:normal;color:var(--am)" title="佔該側可見 ${x.levels || 0} 檔掛單總額比例">${(x.share || 0).toFixed(2)}%</em></span></div>`
            ).join('');
          } else {
            walls.forEach((x, i) => {
              const el = wl.children[i]; if (!el) return;
              el.querySelector('.sz').innerHTML = `$${U.money(x.notional)} <em style="font-style:normal;color:var(--am)">${(x.share || 0).toFixed(2)}%</em>`;
            });
          }
        }
      }
    }
  };
})(window);
