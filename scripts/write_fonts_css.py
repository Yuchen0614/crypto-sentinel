# -*- coding: utf-8 -*-
import io

FACE = ("@font-face {{\n"
        "  font-family: '{fam}';\n"
        "  font-style: normal;\n"
        "  font-weight: {w};\n"
        "  font-display: swap;\n"
        "  src: url('../fonts/{f}.woff2') format('woff2');\n"
        "  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, "
        "U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, "
        "U+FEFF, U+FFFD;\n"
        "}}\n")

head = ("/* ══════════════════════════════════════════════════════════════\n"
        "   CRYPTO SENTINEL — 自帶字型（latin 子集，離線可用，共 100 KB）\n"
        "   Inter           UI / 內文\n"
        "   Space Grotesk   標題 / 顯示字\n"
        "   JetBrains Mono  數字、價格、表格\n"
        "   中文字自動接系統字：Noto Sans TC → 蘋方 → 微軟正黑體。\n"
        "   三者皆為可變字型，單一檔案涵蓋全部字重。\n"
        "   ══════════════════════════════════════════════════════════════ */\n")

body = (FACE.format(fam="Inter", w="100 900", f="Inter")
        + FACE.format(fam="Space Grotesk", w="300 700", f="SpaceGrotesk")
        + FACE.format(fam="JetBrains Mono", w="100 800", f="JetBrainsMono"))

io.open(r"C:\Users\admin\OneDrive\桌面\projects\crypto-sentinel\assets\css\fonts.css",
        "w", encoding="utf-8", newline="\n").write(head + body)
print("fonts.css rewritten")
