# -*- coding: utf-8 -*-
"""fetch_history.py — 抓 365 天內的大戶成交，聚合成「每日每幣淨部位變化」
用途：鏈上大戶持倉方向分析 + 倉位異動分析 + 30/60/180/360 天策略回測。
輸出 data/whale-history.json（只留每天名目 >= $50K 的幣，控制檔案大小）；
原始快取放 .cache/（不進 repo）。可重複執行，會續抓缺少的部分。
"""
import json, os, sys, time, urllib.request, datetime as dt, collections

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DAYS = int(os.environ.get("HIST_DAYS", "365"))
MIN_NTL = 50000.0
API = "https://api.hyperliquid.xyz/info"

def post(body, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(API, data=json.dumps(body).encode(),
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception as e:
            if i == tries - 1: return None
            time.sleep(1.5 * (i + 1))

def fills_range(addr, t0, t1, depth=0):
    """抓 [t0,t1) 的成交；單次上限 2000 筆 → 二分遞迴確保不漏"""
    d = post({"type": "userFillsByTime", "user": addr, "startTime": int(t0),
              "endTime": int(t1), "aggregateByTime": True})
    if d is None: return []
    if len(d) >= 2000 and (t1 - t0) > 3600e3 and depth < 12:
        mid = (t0 + t1) / 2
        return fills_range(addr, t0, mid, depth + 1) + fills_range(addr, mid, t1, depth + 1)
    return d

def main():
    wl = json.load(open(os.path.join(HERE, "data", "whales.json"), encoding="utf-8"))
    wallets = wl["wallets"]
    now = int(time.time() * 1000)
    t0 = now - DAYS * 86400e3
    out = {}
    cache_p = os.path.join(HERE, ".cache", "hist_progress.json")
    if os.path.exists(cache_p):
        try: out = json.load(open(cache_p, encoding="utf-8"))
        except Exception: out = {}
    log = open(os.path.join(HERE, ".cache", "hist.log"), "a", encoding="utf-8")
    def say(m):
        s = "%s %s" % (dt.datetime.now().strftime("%H:%M:%S"), m)
        print(s, flush=True); log.write(s + "\n"); log.flush()
    say("開始：%d 個錢包 × %d 天" % (len(wallets), DAYS))
    STEP = 7 * 86400e3
    for wi, w in enumerate(wallets):
        addr = w["addr"]
        if out.get(addr, {}).get("done"):
            say("[%d/%d] %s 已完成，跳過" % (wi + 1, len(wallets), addr[:10])); continue
        t = t0
        daily = collections.defaultdict(lambda: collections.defaultdict(lambda: [0.0, 0.0, 0.0, 0]))
        nf = 0
        while t < now:
            end = min(t + STEP, now)
            for f in fills_range(addr, t, end):
                ts = int(f.get("time") or 0)
                if not ts: continue
                day = dt.datetime.utcfromtimestamp(ts / 1000).strftime("%Y-%m-%d")
                coin = f.get("coin") or "?"
                try:
                    sz = float(f.get("sz") or 0); px = float(f.get("px") or 0)
                    cp = float(f.get("closedPnl") or 0); fee = float(f.get("fee") or 0)
                except Exception:
                    continue
                d = f.get("dir") or ""
                sign = 1 if d.startswith("Open Long") or d.startswith("Close Short") else (-1 if d.startswith("Open Short") or d.startswith("Close Long") else 0)
                if sign == 0: continue
                a = daily[day][coin]
                a[0] += sign * abs(sz); a[1] += abs(sz) * px; a[2] += cp; a[3] += 1
                nf += 1
            t = end
            time.sleep(0.18)
        # 只留名目 >= MIN_NTL 的當日幣種
        keep = {}
        for day, coins in daily.items():
            k = {c: [round(v[0], 6), round(v[1]), round(v[2], 2), v[3]] for c, v in coins.items() if v[1] >= MIN_NTL}
            if k: keep[day] = k
        out[addr] = {"name": w.get("name") or addr[:10], "av": w.get("av"), "done": True,
                     "days": len(keep), "fills": nf, "d": keep}
        say("[%d/%d] %s 成交 %d 筆 · 有量天數 %d" % (wi + 1, len(wallets), addr[:10], nf, len(keep)))
        json.dump(out, open(cache_p, "w", encoding="utf-8"), ensure_ascii=False)
    # 輸出（去掉 av 以外的細節，控制大小）
    pub = {"generated_at": dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"), "days": DAYS,
           "min_notional": MIN_NTL, "source": "Hyperliquid userFillsByTime",
           "wallets": {a: {"name": v["name"], "av": v.get("av"), "d": v["d"]} for a, v in out.items() if v.get("done")}}
    p = os.path.join(HERE, "data", "whale-history.json")
    tmp = p + ".tmp"
    json.dump(pub, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, p)
    say("完成：%d 個錢包 → %s（%.1f MB）" % (len(pub["wallets"]), p, os.path.getsize(p) / 1e6))

if __name__ == "__main__":
    main()
