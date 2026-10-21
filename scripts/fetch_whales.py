#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
抓取 Hyperliquid 公開排行榜，篩出值得追蹤的「鏈上大戶錢包」清單。

資料來源（皆為公開端點、無需 API 金鑰）：
  https://stats-data.hyperliquid.xyz/Mainnet/leaderboard   （約 39 MB，含 4.7 萬個交易者）

輸出：data/whales.json —— 給前端使用的精簡追蹤名單（預設 50 筆），
前端只讀這個小檔案，再逐一查詢各錢包的即時持倉，不需要下載 39 MB。

由 GitHub Actions 每日自動執行（見 .github/workflows/refresh-whales.yml），
也可手動執行：python3 scripts/fetch_whales.py
"""
import json
import os
import sys
import time
import urllib.request

LEADERBOARD = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "whales.json")

MIN_ACCOUNT = 1_000_000      # 帳戶淨值門檻（美元）：低於此不算大戶
MIN_VOL30 = 5_000_000        # 近 30 日交易量門檻
ROI_MIN, ROI_MAX = -0.90, 5.0  # 月 ROI 合理區間，濾除統計雜訊（例如 +29894%）


def fetch(url, timeout=120):
    req = urllib.request.Request(url, headers={
        "User-Agent": "crypto-sentinel/1.0 (+https://github.com/Yuchen0614/crypto-sentinel)",
        "Accept-Encoding": "gzip",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            import gzip
            raw = gzip.decompress(raw)
        return json.loads(raw.decode("utf-8"))


def perf(row, key):
    for k, v in row.get("windowPerformances", []):
        if k == key:
            return v or {}
    return {}


def main():
    print("下載排行榜 …（約 39 MB）")
    data = fetch(LEADERBOARD)
    rows = data.get("leaderboardRows") or []
    print(f"  取得 {len(rows):,} 位交易者")

    cand = []
    for r in rows:
        try:
            av = float(r.get("accountValue") or 0)
        except ValueError:
            continue
        if av < MIN_ACCOUNT:
            continue
        m, w, d = perf(r, "month"), perf(r, "week"), perf(r, "day")
        try:
            roi30 = float(m.get("roi") or 0)
            vol30 = float(m.get("vlm") or 0)
            pnl30 = float(m.get("pnl") or 0)
            roi7 = float(w.get("roi") or 0)
            roi1 = float(d.get("roi") or 0)
        except ValueError:
            continue
        if vol30 < MIN_VOL30 or not (ROI_MIN <= roi30 <= ROI_MAX):
            continue
        cand.append({
            "addr": r["ethAddress"],
            "name": (r.get("displayName") or "").strip()[:24],
            "av": round(av, 2),
            "roi30": round(roi30 * 100, 2),
            "roi7": round(roi7 * 100, 2),
            "roi1": round(roi1 * 100, 2),
            "pnl30": round(pnl30, 2),
            "vol30": round(vol30, 2),
        })
    print(f"  符合大戶條件（淨值 ≥ ${MIN_ACCOUNT/1e6:.0f}M、30 日量 ≥ ${MIN_VOL30/1e6:.0f}M）：{len(cand):,} 位")

    # 三種角度各取一批，去重後成為追蹤名單
    picks, seen = [], set()

    def take(label, items, n):
        k = 0
        for c in items:
            if k >= n:
                break
            if c["addr"] in seen:
                continue
            seen.add(c["addr"])
            c["why"] = label
            picks.append(c)
            k += 1

    take("資金規模最大", sorted(cand, key=lambda x: -x["av"]), 18)
    take("月獲利最高", sorted(cand, key=lambda x: -x["pnl30"]), 20)
    take("月報酬率最高", sorted(cand, key=lambda x: -x["roi30"]), 14)
    picks = picks[:52]

    out = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "Hyperliquid public leaderboard (stats-data.hyperliquid.xyz)",
        "criteria": {
            "min_account_usd": MIN_ACCOUNT, "min_volume30_usd": MIN_VOL30,
            "roi30_range": [ROI_MIN, ROI_MAX],
        },
        "count": len(picks),
        "wallets": picks,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    old = None
    if os.path.exists(OUT):
        try:
            old = json.load(open(OUT, encoding="utf-8"))
        except Exception:
            old = None
    # 只在名單或關鍵指標有變動時才寫檔（避免 Actions 產生無意義 commit）
    if old:
        o = {(w["addr"], w["av"], w["roi30"], w["pnl30"]) for w in old.get("wallets", [])}
        n = {(w["addr"], w["av"], w["roi30"], w["pnl30"]) for w in picks}
        if o == n:
            print("名單與指標未變動，不更新檔案")
            return 0
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"已寫入 {OUT}（{len(picks)} 筆，{os.path.getsize(OUT)/1024:.1f} KB）")
    for w in picks[:6]:
        print(f"  {w['addr'][:12]}  {w['name'][:12]:12}  淨值 ${w['av']/1e6:8.1f}M  月ROI {w['roi30']:7.1f}%  月損益 ${w['pnl30']/1e6:7.2f}M  [{w['why']}]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
