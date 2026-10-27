# -*- coding: utf-8 -*-
"""fetch_perf.py — 抓每個大戶錢包的「真實權益／盈虧曲線」，供實際績效報表與策略回測。
資料源：Hyperliquid POST /info {"type":"portfolio","user":...,"timeframe":"allTime"}
（allTime 可回溯一年以上；另存 day/week/month 供近期視窗交叉檢查）

輸出 data/whale-perf.json
  wallets: { addr: { name, av, t0, step_h, eq:[...], pnl:[...],           # 每日降採樣後的權益與累積盈虧
                     m: { "30": {...}, "60":.., "180":.., "360":.. } } }   # 各視窗預先算好的績效
  指標定義：ret=區間報酬率、dd=最大回撤、sharpe=日報酬年化夏普、win=日勝率、vol=年化波動
  用 pnl 差分算日報酬（排除入金/出金造成的權益跳動，這點很重要）
"""
import json, os, sys, time, math, urllib.request, datetime as dt

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://api.hyperliquid.xyz/info"
WINDOWS = [30, 60, 180, 360]

def post(b, tries=4):
    for i in range(tries):
        try:
            r = urllib.request.Request(API, data=json.dumps(b).encode(), headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(r, timeout=30) as x: return json.load(x)
        except Exception as e:
            if i == tries - 1: return None
            time.sleep(2.0 * (i + 1))

def daily(hist):
    """把 [(ts,val)] 降成每日最後一筆 → (ts_list, val_list)"""
    per = {}
    for p in hist or []:
        try:
            ts = int(p[0]); v = float(p[1])
        except Exception: continue
        day = ts // 86400000
        per[day] = (ts, v)
    ks = sorted(per)
    return [per[k][0] for k in ks], [per[k][1] for k in ks]

def metrics(ts, eq, pnl):
    out = {}
    if len(ts) < 2: return {}
    for wd in WINDOWS:
        cut = ts[-1] - wd * 86400000
        idx = [i for i, t in enumerate(ts) if t >= cut]
        out[str(wd)] = {}
        if len(idx) < 2: continue
        i0, i1 = idx[0], idx[-1]
        e0, e1 = eq[i0] or 1, eq[i1]
        p0, p1 = pnl[i0], pnl[i1]
        # 日報酬：用累積盈虧的差分 ÷ 期初權益（不受入金影響）
        rets = []
        for a, b in zip(idx, idx[1:]):
            d = b - a
            if d <= 0: continue
            den = eq[a] if eq[a] > 0 else (e0 or 1)
            rets.append(((pnl[b] - pnl[a]) / den) if den else 0.0)
        tot = (p1 - p0) / (e0 or 1)
        # 權益曲線回撤（以權益為準，含入金影響但可反映實際淨值）
        peak, dd = -1e18, 0.0
        for i in idx:
            peak = max(peak, eq[i])
            if peak > 0: dd = max(dd, (peak - eq[i]) / peak)
        if rets:
            mu = sum(rets) / len(rets)
            sd = math.sqrt(sum((r - mu) ** 2 for r in rets) / max(1, len(rets) - 1)) if len(rets) > 1 else 0
            sharpe = (mu / sd * math.sqrt(365)) if sd > 0 else 0
            win = sum(1 for r in rets if r > 0) / len(rets)
            vol = sd * math.sqrt(365)
        else:
            sharpe = win = vol = 0
        out[str(wd)] = {"ret": round(tot, 6), "dd": round(dd, 6), "sharpe": round(sharpe, 3),
                        "win": round(win, 4), "vol": round(vol, 4), "days": len(idx), "equity": round(e1)}
    return out

def main():
    wl = json.load(open(os.path.join(HERE, "data", "whales.json"), encoding="utf-8"))
    wallets = wl["wallets"]
    out = {}
    cache_p = os.path.join(HERE, ".cache", "perf_progress.json")
    if os.path.exists(cache_p):
        try: out = json.load(open(cache_p, encoding="utf-8"))
        except Exception: out = {}
    log = open(os.path.join(HERE, ".cache", "perf.log"), "a", encoding="utf-8")
    def say(m):
        s = "%s %s" % (dt.datetime.now().strftime("%H:%M:%S"), m)
        print(s, flush=True); log.write(s + "\n"); log.flush()
    say("開始：%d 個錢包（allTime 權益曲線）" % len(wallets))
    for i, w in enumerate(wallets):
        a = w["addr"]
        if out.get(a, {}).get("m"):
            say("[%d/%d] %s 已有，跳過" % (i + 1, len(wallets), a[:10])); continue
        d = post({"type": "portfolio", "user": a, "timeframe": "allTime"})
        if not d:
            say("[%d/%d] %s 失敗（稍後可重跑）" % (i + 1, len(wallets), a[:10])); time.sleep(1.2); continue
        seg = None
        for x in d:
            if isinstance(x, (list, tuple)) and len(x) == 2 and x[0] == "allTime": seg = x[1]
        if not isinstance(seg, dict): seg = {}
        ts, eq = daily(seg.get("accountValueHistory"))
        _, pnl = daily(seg.get("pnlHistory"))
        if len(pnl) != len(eq): pnl = pnl[:len(eq)] + [pnl[-1]] * max(0, len(eq) - len(pnl)) if pnl else [0.0] * len(eq)
        m = metrics(ts, eq, pnl)
        out[a] = {"name": w.get("name") or a[:10], "av": w.get("av"), "t0": ts[0] if ts else 0,
                  "step_h": 24, "ts0": ts[0] if ts else 0, "eq": [round(v) for v in eq],
                  "pnl": [round(v) for v in pnl], "n": len(ts), "m": m}
        say("[%d/%d] %s 點數 %d · 360d 報酬 %s · 30d %s" % (i + 1, len(wallets), a[:10], len(ts),
            ("%.1f%%" % (m.get("360", {}).get("ret", 0) * 100)) if m.get("360") else "—",
            ("%.1f%%" % (m.get("30", {}).get("ret", 0) * 100)) if m.get("30") else "—"))
        json.dump(out, open(cache_p, "w", encoding="utf-8"), ensure_ascii=False)
        time.sleep(0.9)
    pub = {"generated_at": dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
           "source": "Hyperliquid portfolio (allTime) · 每日降採樣",
           "windows": WINDOWS, "note": "ret 以累積盈虧差分計，排除入金影響；dd 以權益曲線計",
           "wallets": {a: v for a, v in out.items() if v.get("m")}}
    p = os.path.join(HERE, "data", "whale-perf.json"); tmp = p + ".tmp"
    json.dump(pub, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, p)
    say("完成：%d 個錢包 → %.0f KB" % (len(pub["wallets"]), os.path.getsize(p) / 1024))

if __name__ == "__main__":
    main()
