# -*- coding: utf-8 -*-
"""Fetch latin subsets of the new UI fonts and write assets/css/fonts.css."""
import os, re, urllib.request

BASE = r"C:\Users\admin\OneDrive\桌面\projects\crypto-sentinel"
FDIR = os.path.join(BASE, "assets", "fonts")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36")

WANT = [("Inter", [400, 500, 600, 700]),
        ("Space Grotesk", [500, 700]),
        ("JetBrains Mono", [400, 500, 700])]

for f in os.listdir(FDIR):
    if f.endswith(".woff2"):
        os.remove(os.path.join(FDIR, f))

blocks_out, total = [], 0
for fam, weights in WANT:
    q = "https://fonts.googleapis.com/css2?family=" + fam.replace(" ", "+") + \
        ":wght@" + ";".join(str(x) for x in weights) + "&display=swap"
    req = urllib.request.Request(q, headers={"User-Agent": UA})
    css = urllib.request.urlopen(req, timeout=30).read().decode("utf-8")
    faces = re.findall(r"@font-face\s*\{(.*?)\}", css, re.S)
    print(f"--- {fam}: {len(faces)} faces in css2 response")
    kept = 0
    for face in faces:
        ur = re.search(r"unicode-range:\s*([^;}]+)", face)
        if not ur or "U+0000-00FF" not in ur.group(1):
            continue                                    # latin subset only
        w = re.search(r"font-weight:\s*(\d+)", face).group(1)
        url = re.search(r"url\((https://[^)]+)\)", face).group(1)
        fn = f"{fam.replace(' ', '')}-{w}.woff2"
        data = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}),
                                      timeout=30).read()
        open(os.path.join(FDIR, fn), "wb").write(data)
        total += len(data)
        kept += 1
        blocks_out.append(
            f"@font-face{{font-family:'{fam}';font-style:normal;font-weight:{w};"
            f"font-display:swap;src:url('../fonts/{fn}') format('woff2');"
            f"unicode-range:{ur.group(1).strip()}}}")
    print(f"    kept {kept} latin faces")

css_out = ("/* ══════════════════════════════════════════════════════════\n"
           "   CRYPTO SENTINEL — self-hosted webfonts (latin subsets)\n"
           "   Inter (UI) · Space Grotesk (display) · JetBrains Mono (numerals)\n"
           "   Downloaded from Google Fonts; latin subset only, ~"
           f"{total//1024} KB total.\n"
           "   ══════════════════════════════════════════════════════════ */\n"
           + "\n".join(blocks_out) + "\n")
open(os.path.join(BASE, "assets", "css", "fonts.css"), "w", encoding="utf-8", newline="\n").write(css_out)
print("fonts.css written,", len(blocks_out), "faces,", total // 1024, "KB")
