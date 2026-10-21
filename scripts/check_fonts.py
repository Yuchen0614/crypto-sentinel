# -*- coding: utf-8 -*-
"""Fail loudly if the UI uses a Chinese character that is not in the bundled subset.

Why this exists: assets/fonts/NotoSansTC.woff2 only carries the characters the
interface actually uses. Any Chinese text outside that set does NOT disappear —
it silently falls back to another face (Windows 微軟正黑體 / macOS 蘋方 / Linux
文泉驛), which is exactly the "two Chinese faces on one screen" bug that was
fixed by bundling the font. This check keeps it fixed.

Sources scanned: index.html, js/*.js, data/*.json  (data files carry UI strings
such as the whale-list "why" labels).

Run:  python scripts/check_fonts.py           (exit 1 when something is missing)
      python scripts/check_fonts.py --fix     (regenerate the subset first)
"""
import glob
import os
import subprocess
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SUBSET = os.path.join(BASE, "assets", "fonts", "NotoSansTC.woff2")


def sources():
    files = [os.path.join(BASE, "index.html")]
    files += sorted(glob.glob(os.path.join(BASE, "js", "*.js")))
    files += sorted(glob.glob(os.path.join(BASE, "data", "*.json")))
    return [f for f in files if os.path.exists(f)]


def used_chars():
    chars = set()
    for path in sources():
        with open(path, encoding="utf-8") as fh:
            for ch in fh.read():
                if ord(ch) > 0x2000:
                    chars.add(ch)
    return chars


def subset_chars():
    from fontTools.ttLib import TTFont
    font = TTFont(SUBSET)
    cmap = set()
    for table in font["cmap"].tables:
        cmap.update(table.cmap.keys())
    return {chr(c) for c in cmap if c > 0x2000}


def is_cjk(ch):
    """Han + CJK punctuation — the characters that must never fall back to a
    *different Chinese* face. Other non-ASCII characters (☰ ⚑ ✗ ↗ …) come from
    the platform symbol font by design and are not part of the CJK subset."""
    o = ord(ch)
    return (0x3400 <= o <= 0x9FFF or 0xF900 <= o <= 0xFAFF or
            0x3000 <= o <= 0x303F or 0xFF00 <= o <= 0xFFEF or
            0x20000 <= o <= 0x2FA1F)


def main():
    if "--fix" in sys.argv:
        subprocess.run([sys.executable, os.path.join(BASE, "scripts", "fetch_fonts.py")], check=True)
    used, covered = used_chars(), subset_chars()
    missing = sorted(used - covered)
    cjk_missing = [c for c in missing if is_cjk(c)]
    symbol_missing = [c for c in missing if not is_cjk(c)]
    print(f"sources: {len(sources())} files · UI uses {len(used)} non-ASCII chars · "
          f"subset covers {len(covered)} (overlap {len(used & covered)})")
    if symbol_missing:
        print(f"note: {''.join(symbol_missing)} are not in Noto Sans TC — they render from the "
              f"platform symbol font (expected)")
    if cjk_missing:
        print(f"MISSING Chinese from {os.path.relpath(SUBSET, BASE)}: {''.join(cjk_missing)}")
        print("→ run: python scripts/fetch_fonts.py   (then commit the new woff2)")
        return 1
    print("OK — every Chinese character the UI uses is inside the bundled subset")
    return 0


if __name__ == "__main__":
    sys.exit(main())
