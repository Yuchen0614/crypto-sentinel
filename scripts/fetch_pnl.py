#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
每日績效快照：把追蹤中的大戶錢包「近 N 小時已實現盈虧」寫成小檔，供帶單頁顯示。

為什麼要這支腳本（而不是全部在瀏覽器算）：
  * 瀏覽器端的帳本存在 localStorage，清快取就沒了；這份快照是伺服器端的耐久記錄。
  * Hyperliquid 單次最多回 2000 筆成交，活躍錢包幾十分鐘就滿了；
    在伺服器端可以用「分段時間窗」把整段期間補齊，得到完整的已實現盈虧。

資料來源（公開端點、無需金鑰）：
  POST https://api.hyperliquid.xyz/info  {"type":"userFillsByTime","user":...,"startTime":...}

輸出：data/pnl-daily.json
由 GitHub Actions 每日執行（.github/workflows/refresh-pnl.yml）。
"""
import argparse
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

HL = "https://api.hyperliquid.xyz/info"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WHALES = os.path.join(ROOT, "data", "whales.json")
OUT = os.path.join(ROOT, "data", "pnl-daily.json")

WINDOW_HOURS = 24        # 快照回看期間
CHUNK_HOURS = 2          # 每段時間窗（縮小以避開 2000 筆上限）
SLEEP = 0.25             # 每個請求間隔，避免打太快


def post(body, timeout=60, retries=2):
    data = json.dumps(body).encode("utf-8")
    for attempt in range(retries + 1):
        req = urllib.request.Request(HL, data=data, method="POST", headers={
            "Content-Type": "application/json",
            "User-Agent": "crypto-sentinel/1.0 (+https://github.com/Yuchen0614/crypto-sentinel)",
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:                                   # noqa: BLE001
            if attempt == retries:
                print("  請求失敗：%s" % e, file=sys.stderr)
                return None
            time.sleep(1.5 * (attempt + 1))


def wallet_pnl(addr, start_ms, now_ms):
    """分段抓成交，加總平倉成交的 closedPnl（真正的已實現盈虧）。"""
    realized = 0.0
    fees = 0.0
    closes = 0
    wins = 0
    coins = {}
    capped = False
    t0 = start_ms
    while t0 < now_ms:
        t1 = min(t0 + CHUNK_HOURS * 3600_000, now_ms)
        fills = post({"type": "userFillsByTime", "user": addr, "startTime": t0, "aggregateByTime": True})
        if fills is None:
            return None
        if isinstance(fills, list):
            if len(fills) >= 2000:
                capped = True
            for f in fills:
                d = str(f.get("dir") or "")
                if not d.startswith("Close"):
                    continue
                pnl = float(f.get("closedPnl") or 0)
                realized += pnl
                fees += float(f.get("fee") or 0)
                closes += 1
                if pnl > 0:
                    wins += 1
                c = f.get("coin") or "?"
                w = coins.setdefault(c, 0.0)
                coins[c] = w + pnl
        t0 = t1
        time.sleep(SLEEP)
    return {
        "realized_usd": round(realized, 2),
        "fees_usd": round(fees, 2),
        "closes": closes,
        "wins": wins,
        "win_rate": round(wins / closes, 3) if closes else None,
        "capped": capped,
        "top_coins": [{"coin": k, "realized_usd": round(v, 2)}
                      for k, v in sorted(coins.items(), key=lambda kv: -abs(kv[1]))[:5]],
    }


def main():
    ap = argparse.ArgumentParser(description="Hyperliquid 大戶錢包每日已實現盈虧快照")
    ap.add_argument("--hours", type=int, default=WINDOW_HOURS, help="回看小時數（預設 %d）" % WINDOW_HOURS)
    ap.add_argument("--limit", type=int, default=0, help="只處理名單前 N 個錢包（測試用，0 = 全部）")
    ap.add_argument("--out", default=OUT, help="輸出檔案路徑")
    args = ap.parse_args()
    hours, out_path = args.hours, args.out

    if not os.path.exists(WHALES):
        print("找不到 %s，先執行 scripts/fetch_whales.py" % WHALES)
        return 1
    with open(WHALES, encoding="utf-8") as fh:
        whales = json.load(fh).get("wallets", [])
    if args.limit:
        whales = whales[:args.limit]
    print("追蹤錢包 %d 個，回看 %d 小時" % (len(whales), hours))

    now_ms = int(time.time() * 1000)
    start_ms = now_ms - hours * 3600_000

    # 上一份快照：某個錢包這次抓不到（限流／逾時）時沿用舊數字，
    # 不要讓它從記錄裡消失（否則快照會出現破洞）。標記 stale 供前端辨識。
    prev = {}
    if os.path.exists(out_path):
        try:
            with open(out_path, encoding="utf-8") as fh:
                prev = {x["addr"]: x for x in json.load(fh).get("wallets", [])}
        except Exception:                                       # noqa: BLE001
            prev = {}

    out, total, total_closes, stale_n = [], 0.0, 0, 0
    for i, w in enumerate(whales, 1):
        addr = str(w.get("addr", "")).lower()
        if not addr:
            continue
        r = wallet_pnl(addr, start_ms, now_ms)
        if r is None:
            old = prev.get(addr)
            if not old:
                print("  [%2d/%d] %s  抓取失敗且無舊資料，略過" % (i, len(whales), addr[:10]))
                continue
            r = dict(old)
            r["stale"] = True
            stale_n += 1
            print("  [%2d/%d] %s  抓取失敗，沿用上一次快照（%+0.0f）" % (
                i, len(whales), addr[:10], r.get("realized_usd") or 0))
        r["addr"] = addr
        r["name"] = w.get("name") or r.get("name") or ""
        r["account_value"] = w.get("av")
        out.append(r)
        total += r["realized_usd"]
        total_closes += r["closes"]
        if not r.get("stale"):
            print("  [%2d/%d] %s  %s  已實現 %+12.0f  平倉 %4d 筆" % (
                i, len(whales), addr[:10], (w.get("name") or "")[:10].ljust(10), r["realized_usd"], r["closes"]))
        time.sleep(0.6)                                          # 每個錢包之間稍作停頓，降低被限流機率

    doc = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "window_hours": hours,
        "source": "Hyperliquid userFillsByTime（平倉成交的 closedPnl 加總）",
        "note": "分段抓取避開單次 2000 筆上限；標記 capped 的錢包在該段期間成交過多，數字可能低估。",
        "total_realized": round(total, 2),
        "total_closes": total_closes,
        "stale_wallets": stale_n,
        "wallets": sorted(out, key=lambda x: -x["realized_usd"]),
    }
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:            # 原子寫入：先寫暫存再置換
        json.dump(doc, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, out_path)
    print("已寫入 %s（%d 個錢包 · 合計 %+.0f · %d 筆平倉）" % (out_path, len(out), total, total_closes))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
