# -*- coding: utf-8 -*-
"""Data-state + wording fixes from the 2026-10-21 audit.
Handles CRLF files; skips edits that are already applied."""
import io

B = r"C:\Users\admin\OneDrive\桌面\projects\crypto-sentinel"


def edit(rel, pairs):
    p = B + "\\" + rel.replace("/", "\\")
    raw = io.open(p, encoding="utf-8", newline="").read()
    crlf = "\r\n" in raw
    s = raw.replace("\r\n", "\n")
    changed = 0
    for old, new in pairs:
        o, n = old.replace("\r\n", "\n"), new.replace("\r\n", "\n")
        if o in s:
            s = s.replace(o, n, 1)
            changed += 1
        elif n in s:
            print("   (already applied)", o[:44].replace("\n", " "))
        else:
            raise AssertionError(rel + " NOT FOUND: " + o[:90].replace("\n", " "))
    out = s.replace("\n", "\r\n") if crlf else s
    io.open(p, "w", encoding="utf-8", newline="").write(out)
    print("patched", rel, f"({changed} edits)")


edit("js/chainui.js", [
    ("""  C.agg = function () {
    const a = HL.agg; if (!a) return;
    const k = U.clamp(a.ratio, 0, 1);""",
     """  C.agg = function () {
    const a = HL.agg; if (!a) return;
    /* 只輪詢到一小部分錢包時，比例會嚴重偏斜（例如 多 0.5% / 空 99.5%），
       因此標示「掃描中 n/N」，並在未掃完前用中性色，不讓它看起來像定論。 */
    const scanned = HL.states.size, total = HL.wallets.length || 0;
    const partial = total > 0 && scanned < total;
    const k = U.clamp(a.ratio, 0, 1);"""),
    ("""      r.textContent = isFinite(a.ratio) ? `多空比 ${(a.ratio * 100).toFixed(1)}% / ${((1 - a.ratio) * 100).toFixed(1)}%` : '—';
      r.style.color = a.ratio > 0.55 ? 'var(--gn)' : a.ratio < 0.45 ? 'var(--rd)' : 'var(--cy)';""",
     """      r.textContent = isFinite(a.ratio)
        ? `多空比 ${(a.ratio * 100).toFixed(1)}% / ${((1 - a.ratio) * 100).toFixed(1)}%`
          + (partial ? `（掃描中 ${scanned}/${total}）` : '')
        : '—';
      r.style.color = partial ? 'var(--tx-2)'
        : a.ratio > 0.55 ? 'var(--gn)' : a.ratio < 0.45 ? 'var(--rd)' : 'var(--cy)';"""),
    ("""      if (isFinite(a.ratio) && a.wallets > 0) {
        g.innerHTML = `<span class="${a.ratio > 0.55 ? 'up' : a.ratio < 0.45 ? 'down' : ''}">多 ${(a.ratio * 100).toFixed(0)}%</span> / 空 ${((1 - a.ratio) * 100).toFixed(0)}%`;
        g.title = `Hyperliquid 已追蹤 ${a.wallets} 個大戶錢包、${a.positions} 個倉位：多單 $${U.money(a.longUsd)}、空單 $${U.money(a.shortUsd)}`;
        S.fx.bump(g);
      } else g.textContent = '—';""",
     """      if (isFinite(a.ratio) && a.wallets > 0) {
        g.innerHTML = `<span class="${partial ? '' : a.ratio > 0.55 ? 'up' : a.ratio < 0.45 ? 'down' : ''}">多 ${(a.ratio * 100).toFixed(0)}%</span> / 空 ${((1 - a.ratio) * 100).toFixed(0)}%` +
          (partial ? ` <span class="mini">掃描中 ${scanned}/${total}</span>` : '');
        g.title = `Hyperliquid 已回報 ${scanned}/${total} 個大戶錢包、${a.positions} 個倉位：多單 $${U.money(a.longUsd)}、空單 $${U.money(a.shortUsd)}`
          + (partial ? '（尚在輪詢，比例為暫定值）' : '');
        S.fx.bump(g);
      } else g.textContent = '—';
      const vt = $('#vtChain');
      if (vt) vt.textContent = (isFinite(a.ratio) && a.wallets)
        ? `多 ${(a.ratio * 100).toFixed(0)}% / 空 ${((1 - a.ratio) * 100).toFixed(0)}%` : '—';"""),
    ("""        `<span class="cb-val ${net}">${U.signed(c.net, v => '$' + U.money(Math.abs(v)))}</span>` +
        `<span class="cb-tot">$${U.money(tot)} · ${c.wallets} 錢包</span></div>`;""",
     """        `<span class="cb-val ${net}">淨 ${U.signed(c.net, v => '$' + U.money(Math.abs(v)))}</span>` +
        `<span class="cb-tot">多 $${U.money(c.long)} · 空 $${U.money(c.short)} · ${c.wallets} 錢包</span></div>`;"""),
    ("""    const m = $('#coinMeta');
    if (m) m.textContent = `依追蹤錢包持倉名目排序 · 多 ${(HL.agg.ratio * 100).toFixed(1)}% / 空 ${((1 - HL.agg.ratio) * 100).toFixed(1)}%`;""",
     """    const m = $('#coinMeta');
    if (m) {
      const sc = HL.states.size, tt = HL.wallets.length || 0;
      m.textContent = `依追蹤錢包持倉名目排序 · 多 ${(HL.agg.ratio * 100).toFixed(1)}% / 空 ${((1 - HL.agg.ratio) * 100).toFixed(1)}%`
        + (tt && sc < tt ? ` · 尚在掃描 ${sc}/${tt} 錢包` : ` · ${sc} 個錢包`);
    }"""),
    ("""      meta.textContent = `${HL.wallets.length} 個錢包 · 已更新 ${HL.states.size} 個持倉 · 名單 ${dt ? dt.toLocaleDateString('zh-TW') : '—'}（GitHub Actions 每日更新）`;""",
     """      meta.textContent = `已回報 ${HL.states.size}/${HL.wallets.length} 個錢包 · 每 6 秒輪詢 4 個 · 名單 ${dt ? dt.toLocaleDateString('zh-TW') : '—'}（每日自動更新）`;"""),
    ("""    if (m) m.textContent = `${OC.chainLabel(d.chain)} · ${d.pools.length} 個熱門池 · 每輪 2 池 · 門檻 ≥$${U.money(d.min)} · 已收 ${d.trades.length} 筆 · API ${g.calls || 0} 次`;""",
     """    if (m) m.textContent = `${OC.chainLabel(d.chain)} · ${d.pools.length} 個熱門池 · 每輪掃 1 池（限流）· 門檻 ≥$${U.money(d.min)} · 已收 ${d.trades.length} 筆 · 掃描 ${d.calls} 輪`;"""),
    ("""      cm.textContent = down
        ? `鏈上 API 冷卻中（GeckoTerminal 免費層限流）· 已收 ${d.trades.length} 筆`
        : `${OC.chainLabel(d.chain)} ${d.pools.length} 池 · DEX ${d.trades.length} 筆 · 錢包 ${d.wallets.size} 個 · 大戶倉位 ${HL.states.size}/${HL.wallets.length}`;""",
     """      cm.textContent = down
        ? `鏈上 API 冷卻中（GeckoTerminal 免費層限流）· 已收 ${d.trades.length} 筆，冷卻結束自動續掃`
        : `${OC.chainLabel(d.chain)} ${d.pools.length} 池 · DEX ${d.trades.length} 筆 · 錢包 ${d.wallets.size} 個 · 大戶持倉 ${HL.states.size}/${HL.wallets.length}`;"""),
])

edit("js/ui.js", [
    ("""      U.html('#whaleFoot', `累計 <b>${this.count}</b> 筆大額成交 · 現行門檻 ≥ $${U.money(this.thrNow)}${this.min === 'auto' ? '（自動：近 10 分鐘成交金額中位數 ×10）' : ''} · 分級：≥$250K 大型、≥$1M 巨鯨`);""",
     """      U.html('#whaleFoot', `累計 <b>${this.count}</b> 筆大額成交 · 現行門檻 ≥ $${U.money(this.thrNow)}${this.min === 'auto' ? '（自動：近 10 分鐘成交金額中位數 ×10）' : ''} · 分級：≥$250K 大型、≥$1M 巨鯨`);
      const tape = document.getElementById('whaleTape');
      const empty = tape && tape.querySelector('.empty');
      if (empty && !this.count) empty.textContent = `監聽中 · 現行門檻 ≥ $${U.money(this.thrNow)} — 尚無達門檻的成交，可按「≥10萬」看更多`;"""),
])

edit("index.html", [
    ("""            <span class="mini" title="分數＝交易規模 28% + 買賣方向 16% + 交易後價格變化 36% + 代幣廣度 20%">評分：規模 28%・方向 16%・交易後走勢 36%・廣度 20%</span>""",
     """            <span class="mini" id="walletMeta" title="分數＝交易規模 28% + 買賣方向 16% + 交易後價格變化 36% + 代幣廣度 20%">評分：規模 28%・方向 16%・交易後走勢 36%・廣度 20%</span>"""),
])

edit("js/chart.js", [('"Share Tech Mono",monospace', '"JetBrains Mono",monospace'),
                     ('"Share Tech Mono", monospace', '"JetBrains Mono", monospace')])
edit("js/fx.js", [('"Share Tech Mono",monospace', '"JetBrains Mono",monospace')])
print("all patches applied")
