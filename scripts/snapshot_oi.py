# -*- coding: utf-8 -*-
"""snapshot_oi.py — 全市場未平倉（OI）與資金費率快照：每 15 分鐘累積一次歷史。

為什麼要有這支腳本
  Hyperliquid 的 /info 沒有「歷史 OI」查詢端點，只能拿到當下值。
  要判斷「OI 增加是新建倉還是平倉、是多方還是空方」，就必須把每個時間點的
  OI 與價格留下來，才有 ΔOI(5m/1h/4h/24h) 與資費百分位可用。
  這支腳本由 GitHub Actions 每 15 分鐘跑一次，把結果累積成 data/oi/<date>.json，
  前端「槓桿擁擠掃描（OI × 資費）」面板直接讀這些檔案補足歷史。
  累積幾週之後，同一份資料也可以拿來回測「OI 異動 × 資費極端」的訊號。

資料來源（單一請求，不新增外部 API）
  POST https://api.hyperliquid.xyz/info  {"type":"metaAndAssetCtxs"}
  → [ {universe:[{name,...}]}, [ {funding, openInterest, dayNtlVlm, markPx, prevDayPx, ...} ] ]
  第二個陣列與 universe 同序。

檔案格式（刻意精簡，235 檔 × 96 次/日 約 500~600 KB/日）
  {
    "date": "2026-11-01",
    "source": "Hyperliquid metaAndAssetCtxs",
    "generated_at": "2026-11-01T17:45:03Z",
    "step": 900,                       # 每個點間隔（秒）
    "unit": { ... 各欄位的單位說明 ... },
    "fields": ["oi", "fd", "vl", "px"],
    "coins": ["BTC", "ETH", ...],      # 幣種順序固定；盤中新增幣種會append到最後
    "points": [
      {"t": 1762014300, "r": [[40672.6, 1250, 680, 78117], ...]}   # 與 coins 同序
    ]
  }
  欄位意義（見 unit）：
    oi  未平倉（標的幣數量，6 位有效數字）
    fd  資金費率 × 1e8（整數；1250 → 0.0000125/小時）
    vl  24h 名目成交額，單位「百萬美元」（3 位有效數字）
    px  標記價
  前端換算：OI 美元名目 = oi × px；費率 = fd / 1e8；成交額 = vl × 1e6。
  缺值一律寫 null，不用 0 冒充資料。

節流與可靠性
  請求間隔 ≥ --sleep 秒（預設 0.45）；429 走指數退避（2/4/8/16 秒）並全域放慢；
  抓不到就整支結束並回非 0，不寫半成品（先寫 .tmp 再 os.replace）。

用法
  python scripts/snapshot_oi.py                # 正式寫入 data/oi/<今天UTC>.json
  python scripts/snapshot_oi.py --dry-run      # 只抓取與統計，不寫檔
  python scripts/snapshot_oi.py --date 2026-11-01 --out-dir data/oi
"""
import argparse
import datetime as dt
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://api.hyperliquid.xyz/info"
UA = "crypto-sentinel/1.0 (+https://github.com/yuchen0614/crypto-sentinel)"
STEP = 900                        # 15 分鐘一個點
FIELDS = ["oi", "fd", "vl", "px"]
UNIT = {
    "oi": "未平倉（標的幣數量，5 位有效數字）；美元名目 = oi × px",
    "fd": "資金費率 × 1e8（整數，每小時）；例：1250 = 0.0000125/hr = 0.00125%/hr",
    "vl": "24 小時名目成交額，單位百萬美元（3 位有效數字）",
    "px": "標記價（markPx），5 位有效數字",
    "note": "所有值皆為該時間點的當下值；Hyperliquid 沒有歷史 OI 端點，歷史只能這樣累積",
}


def num(v):
    """Hyperliquid 的數字幾乎都是字串；解析不出來回 NaN。"""
    try:
        f = float(v)
        return f if math.isfinite(f) else float("nan")
    except (TypeError, ValueError):
        return float("nan")


def sig(x, n):
    """四捨五入到 n 位有效數字（整數值直接回 int，序列化比較短）。"""
    if not isinstance(x, (int, float)) or not math.isfinite(x) or x == 0:
        return 0
    d = n - 1 - int(math.floor(math.log10(abs(x))))
    v = round(x, d)
    if d <= 0:
        return int(v)
    return v


class Fetcher(object):
    """每次請求前固定節流；429／5xx 走指數退避。"""

    def __init__(self, sleep_s=0.45, tries=5, verbose=True):
        self.sleep_s = sleep_s
        self.tries = tries
        self.verbose = verbose
        self.extra = 0.0
        self.calls = 0

    def post(self, body, timeout=30):
        payload = json.dumps(body).encode("utf-8")
        last = None
        for i in range(self.tries):
            time.sleep(self.sleep_s + self.extra)          # 節流：每次請求前都等
            req = urllib.request.Request(
                API, data=payload,
                headers={"Content-Type": "application/json", "User-Agent": UA})
            try:
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    self.calls += 1
                    return json.load(r)
            except urllib.error.HTTPError as e:
                self.calls += 1
                last = "HTTP %s" % e.code
                if e.code == 429:
                    self.extra = min(3.0, self.extra + 0.6)  # 被限流 → 之後放慢
                    wait = 2.0 * (2 ** i)
                    if self.verbose:
                        print("      429 被限流，等 %.0f 秒後重試（第 %d 次）" % (wait, i + 1), flush=True)
                elif 500 <= e.code < 600:
                    wait = 1.5 * (i + 1)
                    if self.verbose:
                        print("      HTTP %s，等 %.1f 秒後重試" % (e.code, wait), flush=True)
                else:
                    if self.verbose:
                        print("      HTTP %s：%s" % (e.code, e.reason), flush=True)
                    return None
                time.sleep(wait)
            except Exception as e:                          # 逾時、連線中斷、JSON 壞掉
                self.calls += 1
                last = str(e)
                if i == self.tries - 1:
                    break
                wait = 2.0 * (2 ** i)
                if self.verbose:
                    print("      %s → 等 %.0f 秒重試" % (e, wait), flush=True)
                time.sleep(wait)
        if self.verbose and last:
            print("      連續失敗：%s" % last, flush=True)
        return None


def parse_ctxs(d):
    """metaAndAssetCtxs → [(coin, oi, funding, dayNtlVlm, markPx)]，順序照 universe。"""
    if not isinstance(d, list) or len(d) < 2:
        return None
    uni = d[0].get("universe") if isinstance(d[0], dict) else None
    ctx = d[1]
    if not isinstance(uni, list) or not isinstance(ctx, list):
        return None
    rows = []
    for i, u in enumerate(uni):
        if not isinstance(u, dict) or not u.get("name"):
            continue
        c = ctx[i] if i < len(ctx) and isinstance(ctx[i], dict) else {}
        px = num(c.get("markPx"))
        if not math.isfinite(px) or px <= 0:
            px = num(c.get("midPx"))
        if not math.isfinite(px) or px <= 0:
            px = num(c.get("oraclePx"))
        oi = num(c.get("openInterest"))
        rows.append((
            u["name"],
            oi if math.isfinite(oi) else None,
            num(c.get("funding")) if math.isfinite(num(c.get("funding"))) else None,
            num(c.get("dayNtlVlm")) if math.isfinite(num(c.get("dayNtlVlm"))) else None,
            px if math.isfinite(px) and px > 0 else None,
        ))
    return rows


def row_of(oi, funding, vol, px):
    """一列 → [oi, fd, vl, px]（單位見 UNIT）。缺值寫 null。"""
    out = []
    out.append(sig(oi, 5) if oi is not None else None)
    out.append(int(round(funding * 1e8)) if funding is not None else None)
    out.append(sig(vol / 1e6, 3) if vol is not None else None)
    out.append(sig(px, 5) if px is not None else None)
    return out


def bucket(ts):
    return int(ts // STEP * STEP)


def load_day(path):
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict) and isinstance(d.get("coins"), list) and isinstance(d.get("points"), list):
            return d
    except Exception as e:
        print("  既有 %s 讀不到（%s），重新建立" % (os.path.basename(path), e), flush=True)
    return None


def merge(doc, rows, t):
    """把這一輪的 rows 併進當天的 doc（同一個 15 分鐘格覆蓋，新幣 append）。"""
    coins = doc["coins"]
    index = {c: i for i, c in enumerate(coins)}
    new = [r[0] for r in rows if r[0] not in index]
    if new:
        if doc["points"]:
            print("  盤中新增 %d 個幣種：%s" % (len(new), ", ".join(new)), flush=True)
        for i, c in enumerate(new):
            index[c] = len(coins) + i
        for p in doc["points"]:                       # 舊的點補 null 對齊
            r = p.get("r")
            if isinstance(r, list):
                while len(r) < len(coins) + len(new):
                    r.append(None)
        coins.extend(new)
        print("  盤中新增 %d 個幣種：%s" % (len(new), ", ".join(new)), flush=True)

    arr = [None] * len(coins)
    for coin, oi, f, v, px in rows:
        arr[index[coin]] = row_of(oi, f, v, px)

    pts = doc["points"]
    for i, p in enumerate(pts):
        if p.get("t") == t:
            pts[i] = {"t": t, "r": arr}
            return doc, False
    pts.append({"t": t, "r": arr})
    pts.sort(key=lambda p: p.get("t") or 0)
    return doc, True


def write_json(path, obj):
    tmp = path + ".tmp"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只抓取與統計，不寫入檔案")
    ap.add_argument("--date", default="", help="覆蓋日期（YYYY-MM-DD，預設今天的 UTC 日期）")
    ap.add_argument("--out-dir", default=os.path.join(HERE, "data", "oi"), help="輸出資料夾")
    ap.add_argument("--sleep", type=float, default=0.45, help="每個請求之間的最小間隔秒數")
    args = ap.parse_args()

    now = dt.datetime.now(dt.timezone.utc)
    day = args.date or now.strftime("%Y-%m-%d")
    t = bucket(now.timestamp())

    print("OI/資費快照 %s（時間格 %s）" % (
        day, dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")), flush=True)

    fetcher = Fetcher(sleep_s=args.sleep)
    raw = fetcher.post({"type": "metaAndAssetCtxs"})
    rows = parse_ctxs(raw) if raw is not None else None
    if not rows:
        print("✗ 取不到 metaAndAssetCtxs，結束（不寫任何檔案）", flush=True)
        return 1

    # ── 統計（同時就是驗證輸出）─────────────────────────────────
    oi_usd_total = 0.0
    with_fund = []
    for coin, oi, f, v, px in rows:
        if oi is not None and px is not None:
            oi_usd_total += oi * px
        if f is not None:
            with_fund.append((f, coin))
    with_fund.sort()
    n_fund = len(with_fund)

    print("\n幣種數：%d 檔（有費率 %d 檔）" % (len(rows), n_fund))
    print("Σ OI（美元名目）：$%.2fB（$%s）" % (oi_usd_total / 1e9, "{:,.0f}".format(oi_usd_total)))
    if n_fund >= 3:
        print("資費最低前三： " + " · ".join("%s %+.6f%%/hr" % (c, f * 100) for f, c in with_fund[:3]))
        print("資費最高前三： " + " · ".join("%s %+.6f%%/hr" % (c, f * 100) for f, c in with_fund[-3:][::-1]))
    top = sorted([r for r in rows if r[1] is not None and r[4] is not None],
                 key=lambda r: -(r[1] * r[4]))[:5]
    print("OI 最大前五： " + " · ".join("%s $%.2fB" % (c, oi * px / 1e9) for c, oi, f, v, px in top))

    if args.dry_run:
        print("\n--dry-run：不寫入任何檔案")
        return 0

    os.makedirs(args.out_dir, exist_ok=True)
    path = os.path.join(args.out_dir, "%s.json" % day)
    doc = load_day(path)
    if doc is None:
        doc = {"date": day, "source": "Hyperliquid metaAndAssetCtxs",
               "step": STEP, "unit": UNIT, "fields": FIELDS, "coins": [], "points": []}
    doc["date"] = day
    doc["source"] = "Hyperliquid metaAndAssetCtxs"
    doc["step"] = STEP
    doc["unit"] = UNIT
    doc["fields"] = FIELDS
    doc["generated_at"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    doc, added = merge(doc, rows, t)

    write_json(path, doc)
    size = os.path.getsize(path)
    print("\n寫出 %s：%d 個時間點 · %d 檔幣 · %.0f KB（%s）" % (
        os.path.relpath(path, HERE), len(doc["points"]), len(doc["coins"]), size / 1024.0,
        "新增一格" if added else "覆蓋同一格"))

    # 讀回來驗證（確認檔案是完整可解析的 JSON，而不是寫到一半）
    try:
        with open(path, encoding="utf-8") as f:
            back = json.load(f)
        assert len(back["points"]) == len(doc["points"]) and back["coins"] == doc["coins"]
    except Exception as e:
        print("✗ 寫出的檔案讀不回來：%s" % e, flush=True)
        return 1
    print("驗證：json.load 成功 · %d 個時間點 · 最後一格 %s" % (
        len(back["points"]),
        dt.datetime.fromtimestamp(back["points"][-1]["t"], dt.timezone.utc).strftime("%H:%M UTC")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
