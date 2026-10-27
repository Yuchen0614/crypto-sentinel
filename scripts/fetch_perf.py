# -*- coding: utf-8 -*-
"""fetch_perf.py — 抓每個大戶錢包的「真實權益／盈虧曲線」，供實際績效報表與策略回測。
資料源：Hyperliquid POST /info {"type":"portfolio","user":...,"timeframe":"allTime"}
（allTime 可回溯一年以上；另存 day/week/month 供近期視窗交叉檢查）

輸出 data/whale-perf.json
  wallets: { addr: { name, av, t0, step_h, ts0, td, eq, pnl, n,
                     m: { "30": {...}, "60":.., "180":.., "360":.. } } }
  · td = 每個取樣點相對 ts0 的「經過天數」（整數），與 eq/pnl 等長 → 真正的取樣時間。
    allTime 是粗採樣（實測點距 5~14 天、每錢包 33~105 點），不是每天一點；
    年化換算一律用 td 的實際天數，不可把相鄰兩點硬當成一天。
  · eq = 每個取樣點的帳戶權益（美元）、pnl = 同時點的累積盈虧。
  · m 指標定義（2026-10 修訂）：
      ret       = 期末權益 / 期初權益 - 1（權益為基準）
      unreliable= 期初權益 < $1000 或 < 視窗內最大權益的 1% → true（此時 ret = null）
      dd        = 權益曲線最大回撤
      sharpe/vol/win = 由「相鄰取樣點報酬」換算日等效對數報酬 ln(1+r)/實際天數 後年化
      days      = 視窗內取樣點數（不是日曆天數）
執行：
  python scripts/fetch_perf.py              # 抓 API（會續用 .cache/perf_progress.json）
  python scripts/fetch_perf.py --recompute  # 不抓 API，就地用既有曲線重算 m 並寫回
"""
import json, os, sys, time, math, urllib.request, datetime as dt

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://api.hyperliquid.xyz/info"
WINDOWS = [30, 60, 180, 360]

MIN_EQ = 1000.0        # 視窗起點權益門檻（美元）；低於此分母不可信
MIN_RATIO = 0.01       # 起點權益 / 視窗內最大權益 的下限
MAX_DAILY = 0.5        # 相鄰取樣點日等效報酬 |r| > 50% 視為入金/出金跳動，排除統計
FLOW_X = 3.0           # 相鄰取樣點權益倍數 >= 3 或 <= 1/3 → 視為入金/出金造成，視窗不可靠


def _median(xs):
    s = sorted(xs); m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2.0


def unreliable_reason(eq, idx):
    """判斷某視窗的權益序列是否「資金變動過大／不可信」，回傳原因字串或 None。"""
    if len(idx) < 2: return "points<2"
    e = [float(eq[i]) for i in idx]
    e0, e1, mx = e[0], e[-1], max(e)
    if e0 < MIN_EQ: return "start<1000"
    if mx > 0 and e0 < MIN_RATIO * mx: return "start<1%max"
    if e1 < MIN_EQ: return "end<1000"
    if _median(e) < MIN_EQ: return "median<1000"
    for a, b in zip(e, e[1:]):
        if a <= 0: continue
        if b / a >= FLOW_X or b / a <= 1.0 / FLOW_X: return "flow_jump"
    return None


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

def metrics(ts, eq, pnl, windows=WINDOWS):
    """以權益為基準計算各視窗指標。

    ret = eq_end/eq_start - 1；起點權益過小的視窗標記 unreliable 並讓 ret = null
    （避免分母太小產生 +1.5 億% 這種荒謬數字，例如期初權益只有 $10）。
    dd 以權益曲線計算（保留）。sharpe/win/vol 用「相鄰取樣點報酬」並以實際經過天數
    換算日等效報酬後年化（不是硬當成一天；allTime 為粗採樣）。
    """
    out = {}
    if len(ts) < 2: return {}
    t_end = ts[-1]
    for wd in windows:
        cut = t_end - wd * 86400000
        idx = [i for i, t in enumerate(ts) if t >= cut]
        if len(idx) < 2:
            out[str(wd)] = {}
            continue
        i0, i1 = idx[0], idx[-1]
        e0, e1 = float(eq[i0]), float(eq[i1])
        reason = unreliable_reason(eq, idx)          # 起點/終點權益過小、或資金異動跳動
        unreliable = reason is not None

        # 回撤：權益曲線（含入金/出金造成的淨值跳動，反映實際淨值）
        peak, dd = -1e18, 0.0
        for i in idx:
            peak = max(peak, float(eq[i]))
            if peak > 0: dd = max(dd, (peak - float(eq[i])) / peak)

        # 相鄰取樣點報酬 → 日等效報酬（依實際經過天數）
        dr, jumped = [], 0
        for a, b in zip(idx, idx[1:]):
            ea, eb = float(eq[a]), float(eq[b])
            dts = (ts[b] - ts[a]) / 86400000.0
            if dts <= 0 or ea < MIN_EQ: continue
            g = eb / ea
            if g <= 1e-9: continue
            d = math.log(g) / dts      # 日等效對數報酬（依實際經過天數，不硬當一天）
            if abs(d) > MAX_DAILY:      # 疑似資金異動跳動，排除於統計
                jumped += 1; continue
            dr.append(d)

        if len(dr) >= 2:
            mu = sum(dr) / len(dr)
            sd = math.sqrt(sum((r - mu) ** 2 for r in dr) / (len(dr) - 1))
            sharpe = (mu / sd * math.sqrt(365)) if sd > 0 else 0.0
            win = sum(1 for r in dr if r > 0) / len(dr)
            vol = sd * math.sqrt(365)
        else:
            sharpe = win = vol = 0.0

        rec = ({"ret": None, "unreliable": True, "why": reason} if (unreliable or e0 <= 0)
               else {"ret": round(e1 / e0 - 1, 6)})
        rec.update({"dd": round(dd, 6), "sharpe": round(sharpe, 3), "win": round(win, 4),
                    "vol": round(vol, 4), "days": len(idx), "equity": round(e1)})
        if jumped: rec["jumps"] = jumped
        out[str(wd)] = rec
    return out


def _load_ts_cache():
    p = os.path.join(HERE, ".cache", "perf_ts.json")
    if os.path.exists(p):
        try: return json.load(open(p, encoding="utf-8"))
        except Exception: pass
    return {}


def _ts_for(addr, v, tsc):
    """還原取樣時間戳：優先 .cache/perf_ts.json，其次既有 td 欄位，最後等距回退。"""
    eq = v.get("eq") or []
    ts = tsc.get(addr)
    if isinstance(ts, list) and len(ts) == len(eq): return [int(t) for t in ts]
    td = v.get("td")
    if isinstance(td, list) and len(td) == len(eq):
        return [int(v.get("ts0") or 0) + int(d) * 86400000 for d in td]
    return [int(v.get("ts0") or 0) + i * 86400000 for i in range(len(eq))]


def _write_pub(out):
    wallets = {a: v for a, v in out.items() if v.get("m")}
    pub = {"generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "source": "Hyperliquid portfolio (allTime) · 每日降採樣",
           "windows": WINDOWS,
           "note": ("ret = 期末權益/期初權益 - 1；期初權益 < $1000 或 < 視窗內最大權益 1% 的視窗"
                    "標記 unreliable 且 ret = null（前端顯示「—（資金變動過大）」）。dd 以權益曲線計算。"
                    "sharpe/win/vol 由相鄰取樣點報酬換算日等效對數報酬 r_d=ln(1+r)/實際天數 後年化；allTime 是粗採樣"
                    "（實測點距 5~14 天、每錢包 33~105 點），days 為取樣點數而非日曆天數；"
                    "日等效報酬 |r| > 50% 視為入金/出金跳動，排除於統計並以 jumps 記錄筆數。"),
           "wallets": wallets}
    p = os.path.join(HERE, "data", "whale-perf.json"); tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(pub, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, p)
    return pub, p


def recompute():
    """不抓 API：用既有權益/盈虧曲線就地重算 m，補上 td（取樣點相對天數）後寫回。"""
    cp = os.path.join(HERE, ".cache", "perf_progress.json")
    pub_p = os.path.join(HERE, "data", "whale-perf.json")
    if os.path.exists(cp):
        src = json.load(open(cp, encoding="utf-8"))
    else:
        src = json.load(open(pub_p, encoding="utf-8"))["wallets"]
    tsc = _load_ts_cache()
    out = {}
    for a, v in src.items():
        eq = [float(x) for x in (v.get("eq") or [])]
        ts = _ts_for(a, v, tsc)[:len(eq)] or _ts_for(a, v, {})[:len(eq)]
        pnl = [float(x) for x in (v.get("pnl") or [])]
        if len(pnl) != len(eq):
            pnl = (pnl + [pnl[-1] if pnl else 0.0] * len(eq))[:len(eq)]
        ts0 = ts[0] if ts else int(v.get("ts0") or 0)
        td = [round((t - ts0) / 86400000.0) for t in ts]
        gaps = sorted((ts[i + 1] - ts[i]) / 3600000.0 for i in range(len(ts) - 1))
        step_h = round(gaps[len(gaps) // 2]) if gaps else 24
        nv = dict(v)
        nv.update({"t0": ts0, "ts0": ts0, "td": td, "step_h": step_h, "n": len(ts),
                   "eq": [round(x) for x in eq], "pnl": [round(x) for x in pnl],
                   "m": metrics(ts, eq, pnl)})
        out[a] = nv
    with open(cp + ".tmp", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    os.replace(cp + ".tmp", cp)
    pub, p = _write_pub(out)
    bad = [(a[:10], w, mm["ret"]) for a, v in pub["wallets"].items() for w, mm in v["m"].items()
           if mm.get("ret") is not None and not (-0.999 <= mm["ret"] <= 50)]
    unrel = sum(1 for v in pub["wallets"].values() for mm in v["m"].values() if mm.get("unreliable"))
    why = {}
    for v in pub["wallets"].values():
        for mm in v["m"].values():
            if mm.get("unreliable"): why[mm.get("why", "?")] = why.get(mm.get("why", "?"), 0) + 1
    print("重算完成：%d 個錢包 → %s (%.0f KB)" % (len(pub["wallets"]), p, os.path.getsize(p) / 1024))
    print("unreliable 視窗數：%d（原因分布 %s）；仍異常的 ret：%d" % (unrel, why, len(bad)))
    for b in bad[:10]: print("  異常", b)
    return pub

def main():
    if "--recompute" in sys.argv:
        recompute(); return
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
        gaps = sorted((ts[k + 1] - ts[k]) / 3600000.0 for k in range(len(ts) - 1))
        ts0 = ts[0] if ts else 0
        out[a] = {"name": w.get("name") or a[:10], "av": w.get("av"), "t0": ts0,
                  "step_h": round(gaps[len(gaps) // 2]) if gaps else 24, "ts0": ts0,
                  "td": [round((t - ts0) / 86400000.0) for t in ts],
                  "eq": [round(v) for v in eq],
                  "pnl": [round(v) for v in pnl], "n": len(ts), "m": m}
        r360 = m.get("360", {}).get("ret"); r30 = m.get("30", {}).get("ret")
        say("[%d/%d] %s 點數 %d · 360d %s · 30d %s" % (i + 1, len(wallets), a[:10], len(ts),
            ("%.1f%%" % (r360 * 100)) if r360 is not None else "—",
            ("%.1f%%" % (r30 * 100)) if r30 is not None else "—"))
        with open(cache_p + ".tmp", "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False)
        os.replace(cache_p + ".tmp", cache_p)
        time.sleep(0.9)
    # 補上真實取樣時間（td），讓回測能正確按時間對齊
    tsc = _load_ts_cache()
    pubw = {}
    for a, v in out.items():
        if not v.get("m"): continue
        nv = dict(v)
        if len(nv.get("td") or []) != len(v.get("eq") or []):
            eq = [float(x) for x in v["eq"]]
            ts = _ts_for(a, v, tsc)[:len(eq)]
            nv["td"] = [round((t - ts[0]) / 86400000.0) for t in ts] if ts else []
        pubw[a] = nv
    pub, p = _write_pub(pubw)
    say("完成：%d 個錢包 → %.0f KB" % (len(pub["wallets"]), os.path.getsize(p) / 1024))

if __name__ == "__main__":
    main()
