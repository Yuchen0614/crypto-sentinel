# -*- coding: utf-8 -*-
"""Build the self-hosted webfonts for CRYPTO SENTINEL.

Everything lands in assets/fonts/ as static files — no build step at runtime and
no CDN dependency (the dashboard works offline / on Pages as-is).

  Inter.woff2           UI / body            (latin subset, variable)
  SpaceGrotesk.woff2    titles / display     (latin subset, variable)
  JetBrainsMono.woff2   numbers / tables     (latin subset, variable)
  NotoSansTC.woff2      Chinese — variable, **subset to the characters this UI
                        actually uses**. Without it every machine picks its own
                        fallback CJK face (Windows 微軟正黑體 / macOS 蘋方 /
                        Linux 文泉驛) and mixed Chinese+Latin text looks
                        inconsistent.

A full Noto Sans TC is ~12 MB; the ~700 characters this UI uses compress to a
fraction of that, which is why the subset step matters.

Run:  python scripts/fetch_fonts.py
"""
import hashlib
import os
import re
import subprocess
import sys
import urllib.request
from collections import OrderedDict

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FDIR = os.path.join(BASE, "assets", "fonts")
TMP = os.path.join(BASE, ".fontbuild")
os.makedirs(FDIR, exist_ok=True)
os.makedirs(TMP, exist_ok=True)

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36")

LATIN = [("Inter", [400, 500, 600, 700]),
         ("Space Grotesk", [500, 700]),
         ("JetBrains Mono", [400, 500, 700])]
# OFL-licensed variable font; the Subset/ folder drops unused CJK ranges.
NOTO_VF = ("https://raw.githubusercontent.com/notofonts/noto-cjk/main/"
           "Sans/Variable/TTF/Subset/NotoSansTC-VF.ttf")

LATIN_RANGE = ("U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,"
               "U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,"
               "U+2212,U+2215,U+FEFF,U+FFFD")


def get(url, timeout=120):
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}),
                                  timeout=timeout).read()


def used_chars():
    """Every non-ASCII character that appears in the shipped HTML/JS."""
    chars = set("0123456789")
    files = ["index.html"] + ["js/" + f for f in sorted(os.listdir(os.path.join(BASE, "js")))
                              if f.endswith(".js")]
    for name in files:
        with open(os.path.join(BASE, name), encoding="utf-8") as fh:
            for ch in fh.read():
                if ord(ch) > 0x2000:                 # CJK, CJK punctuation, ≥ · × → …
                    chars.add(ch)
    return "".join(sorted(chars))


def latin_fonts():
    """Fetch the latin subsets Google Fonts serves, collapsing identical files.

    Google serves one variable file per family, so the four Inter weights come
    back byte-identical: store once and declare a weight range.
    """
    by_family = OrderedDict()
    for fam, weights in LATIN:
        q = ("https://fonts.googleapis.com/css2?family=" + fam.replace(" ", "+") +
             ":wght@" + ";".join(str(x) for x in weights) + "&display=swap")
        css = get(q, 60).decode("utf-8")
        got = 0
        for face in re.findall(r"@font-face\s*\{(.*?)\}", css, re.S):
            ur = re.search(r"unicode-range:\s*([^;}]+)", face)
            if not ur or "U+0000-00FF" not in ur.group(1):
                continue                              # latin block only
            w = int(re.search(r"font-weight:\s*(\d+)", face).group(1))
            data = get(re.search(r"url\((https://[^)]+)\)", face).group(1), 60)
            key = hashlib.sha1(data).hexdigest()[:8]
            groups = by_family.setdefault(fam, OrderedDict())
            g = groups.setdefault(key, {"data": data, "weights": []})
            g["weights"].append(w)
            got += 1
        print(f"  {fam}: {got} latin faces")

    blocks, total = [], 0
    for fam, groups in by_family.items():
        for key, g in groups.items():
            fn = f"{fam.replace(' ', '')}.woff2"
            with open(os.path.join(FDIR, fn), "wb") as fh:
                fh.write(g["data"])
            total += len(g["data"])
            ws = sorted(g["weights"])
            weight = str(ws[0]) if len(ws) == 1 else f"{ws[0]} {ws[-1]}"
            blocks.append(f"@font-face{{font-family:'{fam}';font-style:normal;font-weight:{weight};"
                          f"font-display:swap;src:url('../fonts/{fn}') format('woff2');"
                          f"unicode-range:{LATIN_RANGE}}}")
            print(f"    {fn}  weight {weight}  {len(g['data']) // 1024} KB")
    return blocks, total


def cjk_font():
    """Download Noto Sans TC (variable) and subset it to the characters we use."""
    charset = used_chars()
    print(f"  charset: {len(charset)} characters")
    textfile = os.path.join(TMP, "charset.txt")
    with open(textfile, "w", encoding="utf-8") as fh:
        fh.write(charset)

    src = os.path.join(TMP, "NotoSansTC-VF.ttf")
    if not os.path.exists(src) or os.path.getsize(src) < 1_000_000:
        data = get(NOTO_VF, 600)
        if data[:4] != b"\x00\x01\x00\x00":
            raise RuntimeError("unexpected font payload from " + NOTO_VF)
        with open(src, "wb") as fh:
            fh.write(data)
    print(f"  source: NotoSansTC-VF.ttf {os.path.getsize(src) // 1024} KB")

    out = os.path.join(FDIR, "NotoSansTC.woff2")
    subprocess.run([sys.executable, "-m", "fontTools.subset", src,
                    f"--text-file={textfile}", "--flavor=woff2",
                    "--layout-features=*",
                    "--drop-tables+=DSIG",
                    f"--output-file={out}"], check=True)
    size = os.path.getsize(out)
    print(f"  subset -> NotoSansTC.woff2 {size // 1024} KB")
    block = ("@font-face{font-family:'Noto Sans TC';font-style:normal;font-weight:300 900;"
             "font-display:swap;src:url('../fonts/NotoSansTC.woff2') format('woff2')}")
    return [block], size


def main():
    print("— latin webfonts —")
    latin_blocks, total = latin_fonts()
    print("— chinese (subset) —")
    cjk_blocks, cjk_total = cjk_font()

    header = ("/* ══════════════════════════════════════════════════════════\n"
              "   CRYPTO SENTINEL — self-hosted webfonts（離線可用，執行期不連 CDN）\n"
              "   Inter           UI / 內文        (latin subset)\n"
              "   Space Grotesk   標題 / 顯示字     (latin subset)\n"
              "   JetBrains Mono  數字 / 表格       (latin subset)\n"
              "   Noto Sans TC    中文（只打包介面實際用到的字，跨機器外觀一致）\n"
              "   重新產生：python scripts/fetch_fonts.py\n"
              "   ══════════════════════════════════════════════════════════ */\n")
    with open(os.path.join(BASE, "assets", "css", "fonts.css"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(header + "\n".join(latin_blocks + cjk_blocks) + "\n")
    print(f"fonts.css written · latin {total // 1024} KB + chinese {cjk_total // 1024} KB")


if __name__ == "__main__":
    main()
