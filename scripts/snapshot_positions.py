# -*- coding: utf-8 -*-
"""snapshot_positions.py — 每日部位快照：追蹤名單裡每個大戶錢包在 Hyperliquid 的即時持倉。

用途
  1. data/positions-YYYY-MM-DD.json（UTC 日期）
     每個錢包每個幣的「帶正負號的持倉數量（szi）、名目、進場均價、槓桿」，
     以及當天的多空彙總與每個幣的共識度／擁擠度。
     → 前端「持倉方向總覽」與「倉位異動分析（異動排行）」的資料來源。
  2. data/positions-daily.json
     每個錢包每日的總淨名目（Σ多 − Σ空），供長期趨勢；days 與各陣列同序，最後一格是最新一天。
     每天執行會覆蓋當天那一格（可重複執行，不會產生重複日期）。

節流
  Hyperliquid /info 很容易回 429，所以每個請求之間至少間隔 --sleep 秒（預設 0.55），
  遇到 429／網路錯誤走指數退避（2、4、8、16 秒），仍失敗的錢包在最後一輪補抓一次，
  真的抓不到就記在 failed 清單裡（不會用舊資料假裝是新資料）。

寫檔一律先寫 .tmp 再 os.replace，避免 GitHub Actions 中斷留下半個檔案。

用法
  python scripts/snapshot_positions.py                # 正式寫檔
  python scripts/snapshot_positions.py --dry-run      # 只抓取與統計，不寫檔
  python scripts/snapshot_positions.py --limit 5      # 只抓前 5 個錢包（測試用）
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
DATA = os.path.join(HERE, "data")
API = "https://api.hyperliquid.xyz/info"
WHALES = os.path.join(DATA, "whales.json")
DAILY = os.path.join(DATA, "positions-daily.json")
UA = "crypto-sentinel/1.0 (+https://github.com/yuchen0614/crypto-sentinel)"


def num(v):
    """Hyperliquid 的數字幾乎都是字串；解析不出來就回 NaN。"""
    try:
        f = float(v)
        return f if math.isfinite(f) else float("nan")
    except (TypeError, ValueError):
        return float("nan")


class Fetcher(object):
    """每個請求之間固定節流 + 遇到 429 指數退避。"""

    def __init__(self, sleep_s=0.55, tries=4, verbose=True):
        self.sleep_s = sleep_s
        self.extra = 0.0          # 被 429 之後全域加長間隔
        self.tries = tries
        self.verbose = verbose
        self.calls = 0
        self.retries = 0

    def _post(self, body, timeout=30):
        req = urllib.request.Request(
            API, data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "User-Agent": UA})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)

    def state(self, addr):
        """回傳 clearinghouseState（dict）或 None。"""
        body = {"type": "clearinghouseState", "user": addr}
        for i in range(self.tries):
            time.sleep(self.sleep_s + self.extra)      # 節流：每次請求前都等
            try:
                d = self._post(body)
                self.calls += 1
                return d if isinstance(d, dict) else None
            except urllib.error.HTTPError as e:
                self.calls += 1
                if e.code == 429:
                    self.extra = min(2.5, self.extra + 0.5)   # 被限流 → 之後放慢
                    wait = 2.0 * (2 ** i)
                    if self.verbose:
                        print("      429 被限流，等待 %.0f 秒後重試（第 %d 次）" % (wait, i + 1), flush=True)
                    time.sleep(wait)
                elif 500 <= e.code < 600:
                    wait = 1.5 * (i + 1)
                    time.sleep(wait)
                else:
                    if self.verbose:
                        print("      HTTP %s：%s" % (e.code, e.reason), flush=True)
                    return None
            except Exception as e:                      # 逾時、連線中斷、JSON 壞掉
                self.calls += 1
                if i == self.tries - 1:
                    if self.verbose:
                        print("      失敗：%s" % e, flush=True)
                    return None
                wait = 2.0 * (2 ** i)
                if self.verbose:
                    print("      %s → 等 %.0f 秒重試" % (e, wait), flush=True)
                time.sleep(wait)
            self.retries += 1
        return None


def parse_state(st):
    """clearinghouseState → {value, withdrawable, upnl, pos:[...]}（szi 保留正負號）。"""
    pos = []
    upnl = 0.0
    for ap in (st or {}).get("assetPositions") or []:
        p = ap.get("position") or {}
        coin = p.get("coin")
        if not coin:
            continue
        szi = num(p.get("szi"))
        if not math.isfinite(szi) or szi == 0:
            continue
        usd = abs(num(p.get("positionValue")))
        if not math.isfinite(usd):
            usd = 0.0
        u = num(p.get("unrealizedPnl"))
        if math.isfinite(u):
            upnl += u
        lev = num((p.get("leverage") or {}).get("value"))
        pos.append({
            "coin": coin,
            "szi": szi,
            "side": "long" if szi > 0 else "short",
            "usd": round(usd, 2),
            "entry": num(p.get("entryPx")),
            "lev": lev if math.isfinite(lev) else None,
        })
    ms = (st or {}).get("marginSummary") or {}
    return {
        "value": num(ms.get("accountValue")),
        "withdrawable": num((st or {}).get("withdrawable")),
        "upnl": upnl,
        "pos": pos,
    }


def summarize(wallets_state):
    """把 {addr: {pos:[...]}} 匯總成多空總計與每個幣的共識度／擁擠度。"""
    by_coin = {}
    long_usd = short_usd = upnl_total = value_total = 0.0
    n_wallet = 0
    for addr, s in wallets_state.items():
        if not s["pos"]:
            continue
        n_wallet += 1
        value_total += s["value"] if math.isfinite(s["value"]) else 0.0
        upnl_total += s["upnl"]
        for p in s["pos"]:
            if p["side"] == "long":
                long_usd += p["usd"]
            else:
                short_usd += p["usd"]
            c = by_coin.setdefault(p["coin"], {"coin": p["coin"], "long_usd": 0.0, "short_usd": 0.0,
                                               "long_wallets": 0, "short_wallets": 0,
                                               "lev_sum": 0.0, "lev_n": 0, "sizes": []})
            if p["side"] == "long":
                c["long_usd"] += p["usd"]
                c["long_wallets"] += 1
            else:
                c["short_usd"] += p["usd"]
                c["short_wallets"] += 1
            c["sizes"].append(p["usd"])
            if p["lev"] is not None:
                c["lev_sum"] += p["lev"]
                c["lev_n"] += 1

    coins = []
    for c in by_coin.values():
        total = c["long_usd"] + c["short_usd"]
        holders = c["long_wallets"] + c["short_wallets"]
        top3 = sum(sorted(c["sizes"], reverse=True)[:3])
        coins.append({
            "coin": c["coin"],
            "long_usd": round(c["long_usd"], 2),
            "short_usd": round(c["short_usd"], 2),
            "net_usd": round(c["long_usd"] - c["short_usd"], 2),
            "long_wallets": c["long_wallets"],
            "short_wallets": c["short_wallets"],
            "wallets": holders,
            # 共識度 = 同向錢包數 ÷ 持有該幣的錢包數（1.0 = 全部同向）
            "consensus": round(max(c["long_wallets"], c["short_wallets"]) / holders, 4) if holders else None,
            "side": "long" if c["long_wallets"] > c["short_wallets"] else ("short" if c["short_wallets"] > c["long_wallets"] else "flat"),
            # 擁擠度 = 該幣前 3 大持倉 ÷ 該幣總持倉
            "crowding": round(top3 / total, 4) if total > 0 else None,
            "avg_lev": round(c["lev_sum"] / c["lev_n"], 2) if c["lev_n"] else None,
        })
    coins.sort(key=lambda x: -(x["long_usd"] + x["short_usd"]))
    return {
        "long_usd": round(long_usd, 2),
        "short_usd": round(short_usd, 2),
        "net_usd": round(long_usd - short_usd, 2),
        "wallets": n_wallet,
        "coins": len(coins),
        "upnl": round(upnl_total, 2),
        "value": round(value_total, 2),
    }, coins


def write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def update_daily(day, totals, wl_state, names):
    """把今天那一格寫進 data/positions-daily.json（同一天重跑＝覆蓋）。"""
    doc = {"generated_at": "", "source": "Hyperliquid clearinghouseState · 每日部位快照",
           "note": "net_usd = Σ多 − Σ空（名目，美元）；days 與各陣列同序，最後一格是最新一天",
           "count": 0, "days": [], "dates": {}, "wallets": {}}
    if os.path.exists(DAILY):
        try:
            with open(DAILY, encoding="utf-8") as f:
                old = json.load(f)
            if isinstance(old, dict) and old.get("days"):
                doc["days"] = [str(x) for x in old["days"]]
                doc["dates"] = old.get("dates") or {}
                doc["wallets"] = old.get("wallets") or {}
        except Exception as e:
            print("  既有 positions-daily.json 讀不到（%s），改為重新建立" % e, flush=True)

    if day not in doc["days"]:
        doc["days"].append(day)
    idx = doc["days"].index(day)
    # days 必須遞增，否則索引對不上
    order = sorted(range(len(doc["days"])), key=lambda i: doc["days"][i])
    if order != list(range(len(doc["days"]))):
        remap = [doc["days"][i] for i in order]
        pos_of = {d: i for i, d in enumerate(doc["days"])}
        for w in doc["wallets"].values():
            for k in ("net_usd", "long_usd", "short_usd", "n_pos"):
                if isinstance(w.get(k), list):
                    w[k] = [w[k][pos_of[d]] if pos_of[d] < len(w[k]) else None for d in remap]
        doc["days"] = remap
        idx = doc["days"].index(day)

    doc["dates"][day] = totals
    for addr, s in wl_state.items():
        w = doc["wallets"].setdefault(addr, {"name": names.get(addr) or addr[:10],
                                             "net_usd": [], "long_usd": [], "short_usd": [], "n_pos": []})
        w["name"] = names.get(addr) or w.get("name") or addr[:10]
        lo = sum(p["usd"] for p in s["pos"] if p["side"] == "long")
        sh = sum(p["usd"] for p in s["pos"] if p["side"] == "short")
        for k, v in (("net_usd", lo - sh), ("long_usd", lo), ("short_usd", sh), ("n_pos", len(s["pos"]))):
            arr = w.get(k)
            if not isinstance(arr, list):
                arr = []
            while len(arr) < len(doc["days"]):
                arr.append(None)
            arr[idx] = round(v, 2)
            w[k] = arr[:len(doc["days"])]
    doc["count"] = len(doc["days"])
    doc["generated_at"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return doc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只抓取與統計，不寫入檔案")
    ap.add_argument("--limit", type=int, default=0, help="只處理前 N 個錢包（測試用）")
    ap.add_argument("--sleep", type=float, default=0.55, help="每個請求之間的最小間隔秒數（預設 0.55）")
    ap.add_argument("--date", default="", help="覆蓋快照日期（YYYY-MM-DD，預設為今天的 UTC 日期）")
    args = ap.parse_args()

    with open(WHALES, encoding="utf-8") as f:
        wl = json.load(f)
    wallets = wl.get("wallets") or []
    names = {}
    for w in wallets:
        names[str(w["addr"]).lower()] = w.get("name") or ""
    addrs = [str(w["addr"]).lower() for w in wallets]
    if args.limit:
        addrs = addrs[:args.limit]
    if not addrs:
        print("追蹤名單是空的（data/whales.json），結束")
        return 1

    day = args.date or dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
    print("部位快照 %s：%d 個錢包（間隔 %.2f 秒）" % (day, len(addrs), args.sleep), flush=True)

    fetcher = Fetcher(sleep_s=args.sleep)
    wl_state = {}
    failed = []
    for i, addr in enumerate(addrs):
        st = fetcher.state(addr)
        s = parse_state(st) if st else None
        if s is None:
            failed.append(addr)
        else:
            wl_state[addr] = s
        print("  [%d/%d] %s 倉位 %s" % (i + 1, len(addrs), addr[:10],
                                       len(s["pos"]) if s else "失敗"), flush=True)

    # 失敗的錢包最後再補一輪（等久一點，通常這時限流已解除）
    if failed:
        print("補抓 %d 個失敗的錢包…" % len(failed), flush=True)
        time.sleep(3.0)
        retry_failed = list(failed)
        failed = []
        for addr in retry_failed:
            st = fetcher.state(addr)
            s = parse_state(st) if st else None
            if s is None:
                failed.append(addr)
            else:
                wl_state[addr] = s
        print("  補抓後仍失敗：%d 個" % len(failed), flush=True)

    totals, coins = summarize(wl_state)
    wallets_out = {}
    for addr, s in wl_state.items():
        wallets_out[addr] = {
            "name": names.get(addr) or "",
            "value": round(s["value"], 2) if math.isfinite(s["value"]) else None,
            "upnl": round(s["upnl"], 2),
            "pos": [{"coin": p["coin"], "szi": p["szi"], "side": p["side"], "usd": p["usd"],
                     "entry": p["entry"] if math.isfinite(p["entry"]) else None, "lev": p["lev"]}
                    for p in s["pos"]],
        }

    snapshot = {
        "date": day,
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "Hyperliquid clearinghouseState",
        "note": "szi 帶正負號（正=多、負=空）；usd 為名目（美元，絕對值）；consensus=同向錢包數÷持有該幣錢包數；crowding=前 3 大持倉÷該幣總持倉",
        "wallet_count": len(addrs),
        "ok": len(wl_state),
        "failed": failed,
        "totals": totals,
        "coins": coins,
        "wallets": wallets_out,
    }

    print("\n結果：錢包 %d/%d（失敗 %d）· 有持倉的幣 %d 個" % (len(wl_state), len(addrs), len(failed), len(coins)))
    print("  Σ多 $%s · Σ空 $%s · 淨 %s$%s" % (
        "{:,.0f}".format(totals["long_usd"]), "{:,.0f}".format(totals["short_usd"]),
        "+" if totals["net_usd"] >= 0 else "-", "{:,.0f}".format(abs(totals["net_usd"]))))
    for c in coins[:5]:
        print("    %-6s 多 %2d 檔 / 空 %2d 檔 · 淨 $%s · 擁擠度 %s" % (
            c["coin"], c["long_wallets"], c["short_wallets"], "{:,.0f}".format(c["net_usd"]),
            ("%.0f%%" % (c["crowding"] * 100)) if c["crowding"] is not None else "—"))
    if failed:
        print("  失敗：%s" % ", ".join(a[:10] for a in failed))

    if args.dry_run:
        print("\n--dry-run：不寫入任何檔案")
        return 0

    out_day = os.path.join(DATA, "positions-%s.json" % day)
    write_json(out_day, snapshot)
    daily = update_daily(day, totals, wl_state, names)
    write_json(DAILY, daily)
    print("\n寫出 %s（%.0f KB）" % (os.path.relpath(out_day, HERE), os.path.getsize(out_day) / 1024))
    print("更新 %s：累積 %d 天（%s）" % (os.path.relpath(DAILY, HERE), daily["count"],
                                       " ".join(daily["days"][-5:])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
