# -*- coding: utf-8 -*-
"""Apply the 2026-10-21 layout/font revision to assets/css/main.css."""
import io

P = r"C:\Users\admin\OneDrive\桌面\projects\crypto-sentinel\assets\css\main.css"
s = io.open(P, encoding="utf-8", newline="").read()


def sub(old, new, n=1):
    global s
    assert old in s, "NOT FOUND: " + old[:70]
    s = s.replace(old, new, n)


# ── 1. fonts + palette vars ─────────────────────────────────────────────────
sub("""  --mono:'Share Tech Mono',ui-monospace,Consolas,'Courier New',monospace;
  --disp:'Orbitron','Rajdhani',system-ui,sans-serif;
  --ui:'Rajdhani',system-ui,'Microsoft JhengHei UI','Microsoft JhengHei',-apple-system,sans-serif;""",
    """  /* 2026-10-21：換掉 Orbitron/Rajdhani/Share Tech Mono（辨識度差、中英混排不協調），
     改用 Inter + Space Grotesk + JetBrains Mono，中文字走系統 CJK 字。 */
  --mono:'JetBrains Mono',ui-monospace,'SFMono-Regular',Consolas,monospace;
  --disp:'Space Grotesk','Inter',system-ui,sans-serif;
  --ui:'Inter',system-ui,-apple-system,'Noto Sans TC','PingFang TC','Microsoft JhengHei UI','Microsoft JhengHei',sans-serif;
  --cjk:'Noto Sans TC','PingFang TC','Microsoft JhengHei UI','Microsoft JhengHei',-apple-system,sans-serif;""")

sub("  font-size:13px;\n  line-height:1.35;", "  font-size:13px;\n  line-height:1.45;")

# ── 2. layout → views, and stop panels from being squashed ──────────────────
sub(""".layout{position:relative;z-index:10;display:grid;
  grid-template-columns:346px minmax(0,1fr) 372px;
  gap:10px;padding:10px;height:calc(100vh - 62px - 26px)}
.col{display:flex;flex-direction:column;gap:10px;min-height:0;min-width:0}
.col-a{overflow:hidden}
.col-b{overflow-y:auto;overflow-x:hidden;padding-right:2px}
.col-c{overflow-y:auto;overflow-x:hidden;padding-right:2px}""",
    """/* 檢視切換：市場行情（三欄）／鏈上大戶（整頁） */
.viewtabs{position:relative;z-index:10;display:flex;align-items:center;gap:8px;height:42px;
  padding:0 16px;border-bottom:1px solid var(--line);
  background:linear-gradient(180deg,rgba(9,16,28,.92),rgba(6,10,18,.55));backdrop-filter:blur(6px)}
.vtab{display:inline-flex;align-items:center;gap:7px;height:28px;padding:0 14px;font-family:var(--ui);
  font-size:12px;font-weight:600;letter-spacing:.03em;color:var(--tx-2);background:rgba(255,255,255,.02);
  border:1px solid var(--line);border-radius:var(--r);cursor:pointer;transition:.18s}
.vtab .ic{background:currentColor;opacity:.9}
.vtab:hover{color:var(--cy-2);border-color:var(--line-2);background:rgba(56,246,255,.07)}
.vtab.on{color:#04121a;background:linear-gradient(180deg,var(--cy),#12b6cf);border-color:transparent;
  box-shadow:0 0 18px -5px rgba(56,246,255,.85)}
.vtab-badge{font-family:var(--mono);font-size:10.5px;padding:0 6px;border-radius:2px;
  background:rgba(0,0,0,.3);color:inherit}
.vt-meta{margin-left:auto;font-family:var(--mono);font-size:10px;color:var(--tx-3);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

.views{position:relative;z-index:10;padding:10px;height:calc(100vh - 62px - 42px - 26px)}
.view{display:grid;gap:10px;height:100%;min-height:0}
.view[hidden]{display:none}
.view-market{grid-template-columns:346px minmax(0,1fr) 372px}
.view-onchain{grid-template-columns:minmax(0,1fr)}
.col{display:flex;flex-direction:column;gap:10px;min-height:0;min-width:0}
.col-a{overflow:hidden}
.col-b{overflow-y:auto;overflow-x:hidden;padding-right:2px}
.col-c{overflow-y:auto;overflow-x:hidden;padding-right:2px}
/* 面板是 flex 子項時不可壓縮（min-height:0 + flex-shrink:1 會把面板壓成 2px，
   內容因此溢出到視窗外、整區看不到） */
.col-b>*,.col-c>*{flex:0 0 auto}""")

# ── 3. chain panel fills the whole on-chain view ────────────────────────────
sub("/* ── responsive ───────────────────────────────────────────── */",
    """/* ── 鏈上大戶：整頁檢視 ───────────────────────────────────── */
.view-onchain>.chain-panel{height:100%}
.view-onchain .chain-body{flex:1;min-height:0;
  grid-template-columns:minmax(0,1.45fr) minmax(0,1fr)}
.view-onchain .chain-col{min-height:0;overflow-y:auto;padding-right:3px}
.view-onchain .chain-col:first-child{overflow:hidden}
.view-onchain .hl-table-wrap{max-height:none;flex:1 1 auto;min-height:200px}
.view-onchain .hl-events{max-height:none;flex:0 0 auto;max-height:190px}
.view-onchain .coin-bars{max-height:none;flex:0 0 auto}
.view-onchain .subtle-note{font-family:var(--mono);font-size:10px;color:var(--tx-3);padding:2px 0 0}

/* ── responsive ───────────────────────────────────────────── */""")

# ── 4. market view breathing room ───────────────────────────────────────────
sub("#chart{display:block;width:100%;height:316px}", "#chart{display:block;width:100%;height:300px}")
sub("#heat{display:block;width:100%;height:250px;", "#heat{display:block;width:100%;height:232px;")
sub(".book-cols{display:flex;flex-direction:column;padding:0 11px 6px}",
    ".book-cols{display:flex;flex-direction:column;padding:0 11px 6px;max-height:300px;overflow-y:auto}")

# ── 5. headings: Space Grotesk without the gamey tracking ───────────────────
sub(".hud-brand h1{font-family:var(--disp);font-weight:700;font-size:17px;letter-spacing:.14em;",
    ".hud-brand h1{font-family:var(--disp);font-weight:700;font-size:17px;letter-spacing:.08em;")
sub(".hud-brand h1 b{color:var(--cy)}", ".hud-brand h1 b{color:var(--cy);font-weight:700}")
sub(".panel-head h2{font-family:var(--disp);font-size:12px;font-weight:700;letter-spacing:.14em;",
    ".panel-head h2{font-family:var(--disp);font-size:12.5px;font-weight:700;letter-spacing:.055em;")
sub(".boot-logo{font-family:var(--disp);font-weight:900;font-size:clamp(26px,4.4vw,46px);letter-spacing:.16em;",
    ".boot-logo{font-family:var(--disp);font-weight:700;font-size:clamp(26px,4.4vw,46px);letter-spacing:.1em;")
sub(".boot-sub{font-family:var(--mono);color:var(--tx-3);letter-spacing:.34em;font-size:10px;",
    ".boot-sub{font-family:var(--mono);color:var(--tx-3);letter-spacing:.22em;font-size:10px;")
sub(".gauge-center b{display:block;font-family:var(--disp);font-size:32px;font-weight:900;",
    ".gauge-center b{display:block;font-family:var(--disp);font-size:32px;font-weight:700;")

# ── 6. responsive breakpoints follow the new wrappers ───────────────────────
sub("""@media (max-width:1560px){
  .layout{grid-template-columns:308px minmax(0,1fr) 340px}
}
@media (max-width:1360px){
  body{overflow:auto}
  .layout{grid-template-columns:1fr;height:auto;overflow:visible}
  .col-a,.col-b,.col-c{overflow:visible;padding-right:0}
  .table-wrap{max-height:420px}
  .hud{flex-wrap:wrap;height:auto;padding:8px 12px;gap:10px}
  .hud-stats{order:3;width:100%}
  .row2{grid-template-columns:1fr}
}""",
    """@media (max-width:1560px){
  .view-market{grid-template-columns:308px minmax(0,1fr) 340px}
}
@media (max-width:1360px){
  body{overflow:auto}
  .views{height:auto}
  .view{height:auto}
  .view-market,.view-onchain{grid-template-columns:1fr}
  .col-a,.col-b,.col-c{overflow:visible;padding-right:0}
  .view-onchain .chain-col,.view-onchain .chain-col:first-child{overflow:visible}
  .table-wrap{max-height:420px}
  .hud{flex-wrap:wrap;height:auto;padding:8px 12px;gap:10px}
  .hud-stats{order:3;width:100%}
  .viewtabs{height:auto;flex-wrap:wrap;padding:8px 12px}
  .vt-meta{display:none}
  .row2{grid-template-columns:1fr}
}""")

io.open(P, "w", encoding="utf-8", newline="").write(s)
print("main.css patched,", len(s), "bytes")
