# -*- coding: utf-8 -*-
"""Restructure index.html: add a view-tab bar and move 鏈上聰明錢追蹤 into its own
full-width view, so 大戶持倉 is reachable in one click instead of 2000px of scroll."""
import io, re

P = r"C:\Users\admin\OneDrive\桌面\projects\crypto-sentinel\index.html"
s = io.open(P, encoding="utf-8", newline="").read()
orig = s

# ── 1. cut the chain panel out of the middle column ───────────────────────────
start = s.index("    <!-- 鏈上情報 -->")
end = s.index("  <!-- 右：聰明錢")
chain = s[start:end]
s = s[:start] + s[end:]

# ── 2. wrap the market layout in a view, add the tab bar ─────────────────────
NAV = """<!-- ── 檢視切換 ──────────────────────────────────────── -->
<nav class="viewtabs" id="viewTabs">
  <button class="vtab on" data-view="market"><i class="ic ic-scan"></i>市場行情</button>
  <button class="vtab" data-view="onchain"><i class="ic ic-chain"></i>鏈上大戶 · 聰明錢<span class="vtab-badge" id="vtChain">—</span></button>
  <span class="vt-meta" id="vtMeta">全市場掃描 · K 線 · 訂單簿 · 深度熱圖 · 持倉與清算</span>
</nav>

"""
s = s.replace('<main class="layout">', NAV + '<main class="views">\n\n  <section class="view view-market" id="viewMarket">', 1)
assert 'view-market' in s

# ── 3. close the market view, add the on-chain view holding the chain panel ──
close_market = "  </section>\n\n  <section class=\"view view-onchain\" id=\"viewOnchain\" hidden>\n" + chain + "  </section>\n"
s = s.replace("</main>", close_market + "</main>", 1)

# ── 4. re-indent the market view's children by 2 spaces (cosmetic) ───────────
i0 = s.index('<section class="view view-market"')
i1 = s.index("  </section>\n\n  <section class=\"view view-onchain\"")
body = s[i0:i1]
body = "\n".join(("  " + ln) if ln.startswith("  ") and not ln.startswith("   ") else ln
                 for ln in body.split("\n"))
s = s[:i0] + body + s[i1:]

# ── 5. load the view controller ──────────────────────────────────────────────
s = s.replace('<script src="js/app.js"></script>',
              '<script src="js/views.js"></script>\n<script src="js/app.js"></script>', 1)

io.open(P, "w", encoding="utf-8", newline="").write(s)
print("index.html restructured:", len(orig), "->", len(s), "bytes")
print("chain panel moved:", "鏈上聰明錢追蹤" in s, "| views:", s.count('class="view view-'))
