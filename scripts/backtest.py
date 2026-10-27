# -*- coding: utf-8 -*-
"""backtest.py — 大戶「錢包層級」策略回測引擎（不需要幣種價格）。

為什麼不需要價格：資料源是每個大戶錢包的真實帳戶權益 + 累積盈虧曲線（Hyperliquid portfolio
allTime），把「跟這個錢包」看成持有一檔以該錢包為標的的基金，報酬就直接來自他的交易盈虧。
因此回測 = 在 52 個錢包之間做資金配置，並用真實權益/盈虧序列結算。

輸入：data/whale-perf.json（eq 權益序列 + td 取樣點相對天數）、data/whales.json（av 淨值排序）
輸出：data/backtest.json（前端報表頁用；格式見檔尾 note）

六個策略（key 全英文小寫）
  equal   全部大戶等權（買入持有）
  top10av 淨值前 10 等權（買入持有）
  mom7    動能輪換 7 天：每 7 天重選「過去 30 天報酬最佳」前 10 名等權
  mom30   動能輪換 30 天：同上，每 30 天重選
  fade30  反向（fade）：每 30 天重選「過去 30 天報酬最差」前 10 名，做空他們（對其報酬取負）
  lowdd   低回撤優先：每 30 天重選「過去 30 天最大回撤最小」前 10 名等權

方法論重點（避免未來函數／偷看偏誤）
  1. 每個時間點先決定名單、再結算「之後」的報酬；選股只用 rebalance 當下（含）以前的資料。
  2. 逐時點可用性（point-in-time）：錢包在當下有實際取樣、權益 >= $1000、且最近 14 天內有
     新取樣才可被持有或入選；不用「整個視窗算完才知道可不可靠」的事後旗標，避免倖存者偏誤。
  3. 投資組合報酬 = 當期所有「選中且可用」錢包的等權平均報酬（單位區間報酬），資金每個區間
     重新等權分配；報酬逐期複利成權益曲線。
  4. 每期報酬 = (期末累積盈虧 - 期初累積盈虧) / 期初權益（Simple Dietz）：跟單者賺的是大戶的
     交易盈虧，不是他帳戶權益的變化（入金會讓權益暴增、出金會讓權益暴跌，用權益比會把資金流
     當成績效）。另外，期內權益倍數 >= 3 或 <= 1/3、期初權益 < $1000、單期報酬超出
     [-100%, +300%] 者，該錢包該期不計入（避免資金異動與資料異常被誤認為績效）。
  5. 年化/夏普一律用「區間實際經過天數」換算日等效對數報酬 r_d = ln(1+r)/天數，不把粗採樣
     的相鄰兩點硬當成一天。

執行：python scripts/backtest.py [--fetch-ts]
"""
import json, math, os, sys, datetime as dt

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DAY = 86400000
WINDOWS = [30, 60, 180, 360]

MIN_EQ = 1000.0      # 權益門檻（美元）
FLOW_X = 3.0         # 相鄰取樣點倍數 >= 3 或 <= 1/3 → 視為入金/出金
MAX_STALE = 14       # 超過 14 天沒有新取樣 → 資料過期，不再持有/入選
TOP_N = 10
LOOKBACK = 30        # 動能/回撤的排序回溯天數
MAX_DR = 0.5         # 日等效報酬 |r| > 50% 者排除於夏普/波動/勝率統計
ANN_CAP = 20.0       # 年化報酬顯示上限（+2000%）；短視窗幾何外推會失真，僅作相對比較
MAX_INT_R = 3.0      # 單期（1~14 天）報酬上限 +300%，超過視為資料異常，該期不計入


# ----------------------------------------------------------------- 資料前處理
def load_inputs():
    perf = json.load(open(os.path.join(HERE, "data", "whale-perf.json"), encoding="utf-8"))
    wl = json.load(open(os.path.join(HERE, "data", "whales.json"), encoding="utf-8"))
    av = {w["addr"]: (w.get("av") or 0.0) for w in wl["wallets"]}
    out = {}
    for a, v in perf["wallets"].items():
        eq = [float(x) for x in v.get("eq") or []]
        pnl = [float(x) for x in v.get("pnl") or []]
        td = v.get("td")
        if not eq:
            continue
        if not (isinstance(td, list) and len(td) == len(eq)):
            td = list(range(len(eq)))      # 回退：等距一天（僅在缺少 td 時）
        if len(pnl) != len(eq):
            pnl = (pnl + [pnl[-1] if pnl else 0.0] * len(eq))[:len(eq)]
        ts0_day = int(v.get("ts0") or 0) // DAY
        series = {}                        # day_index -> (equity, 累積盈虧)，同日取最後一筆
        for d, e, p in zip(td, eq, pnl):
            series[ts0_day + int(d)] = (e, p)
        days = sorted(series)
        name = v.get("name") or a[:10]
        med = _median([series[d][0] for d in days])
        out[a] = {"addr": a, "name": name, "av": av.get(a, 0.0),
                  "days": days, "eq": [series[d][0] for d in days],
                  "pnl": [series[d][1] for d in days],
                  "d0": days[0], "d1": days[-1], "n": len(days), "med": med}
    return out, perf


def _median(xs):
    s = sorted(xs); m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2.0


def screen(wallets):
    """資料品質篩選：點數 >= 5、歷史權益中位數 >= $1000（排除長期歸零/已提空的錢包）。"""
    ok, drop = {}, {}
    for a, w in wallets.items():
        if w["n"] < 5:
            drop[a] = "points<5"; continue
        if w["med"] < MIN_EQ:
            drop[a] = "median_eq<1000"; continue
        if max(w["eq"]) < MIN_EQ:
            drop[a] = "max_eq<1000"; continue
        ok[a] = w
    return ok, drop


class Book:
    """單一錢包的階梯函數（mark-to-last）：查某天的權益/累積盈虧、最近取樣日、區間報酬。"""

    def __init__(self, w):
        self.name = w["name"]; self.av = w["av"]
        self.days = w["days"]; self.eq = w["eq"]; self.pnl = w["pnl"]

    def at(self, day):
        """回傳 (最後取樣日索引, 權益)；day 之前沒有資料則 (None, None)。"""
        lo, hi = 0, len(self.days) - 1
        if day < self.days[0]: return None, None
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if self.days[mid] <= day: lo = mid
            else: hi = mid - 1
        return lo, self.eq[lo]

    def ret_between(self, d1, d2):
        """[d1,d2] 的區間報酬 = 累積盈虧差分 / 期初權益（Simple Dietz）。

        用「盈虧差分」當分子，是因為跟單者的損益等於大戶的**交易盈虧**，
        不是他帳戶權益的變化：入金會讓權益暴增（0xba5d9cc8 權益 +590% 但盈虧 +0.1%）、
        出金會讓權益暴跌（0xa4432d49 權益 -100% 但盈虧 0%），用權益比會把資金流誤認為績效。
        起點權益 < $1000、權益倍數 >= 3 或 <= 1/3（資金異動）、或報酬不合理 → None（該期不計入）。
        """
        i1, e1 = self.at(d1)
        i2, e2 = self.at(d2)
        if i1 is None or i2 is None or e1 is None or e2 is None: return None
        if e1 < MIN_EQ or e1 <= 0: return None
        g = e2 / e1
        if g <= 0 or g >= FLOW_X or g <= 1.0 / FLOW_X: return None      # 期內疑似資金異動
        r = (self.pnl[i2] - self.pnl[i1]) / e1                          # 交易績效（排除入金/出金）
        if r < -1.0 or r > MAX_INT_R: return None                       # 不合理的單期報酬
        return r


# ----------------------------------------------------------------- 統計工具
def stats_from_intervals(rets, dts, span_days):
    """由單位區間報酬（等權組合）算指標；dts 為各區間實際天數。"""
    mult = 1.0
    curve = [1.0]
    for r in rets:
        mult *= max(0.0, 1.0 + r)
        curve.append(mult)
    ret = mult - 1.0
    peak, dd = -1e18, 0.0
    for x in curve:
        peak = max(peak, x)
        dd = max(dd, (peak - x) / peak) if peak > 0 else dd
    # 日等效對數報酬 = ln(1+r)/實際天數（區間長短不一時的正規做法，且與複利方向一致）
    dr = []
    for r, d in zip(rets, dts):
        if d <= 0: continue
        g = 1.0 + r
        if g <= 1e-9: g = 1e-9
        v = math.log(g) / d
        if abs(v) > MAX_DR: continue          # 疑似資料跳動，排除統計
        dr.append(v)
    if len(dr) >= 2:
        mu = sum(dr) / len(dr)
        sd = math.sqrt(sum((x - mu) ** 2 for x in dr) / (len(dr) - 1))
        sharpe = (mu / sd * math.sqrt(365)) if sd > 0 else 0.0
        win = sum(1 for x in dr if x > 0) / len(dr)
        vol = sd * math.sqrt(365)
    else:
        sharpe = win = vol = 0.0
    ann = ((1.0 + ret) ** (365.0 / span_days) - 1.0) if (span_days > 0 and ret > -1.0) else -1.0
    ann = min(ANN_CAP, max(-1.0, ann))        # 短視窗幾何外推會失真，截斷在合理顯示範圍
    return {"ret": round(ret, 6), "ann": round(ann, 6), "dd": round(dd, 6),
            "sharpe": round(sharpe, 3), "win": round(win, 4), "vol": round(vol, 4),
            "final_mult": round(mult, 6)}


# ----------------------------------------------------------------- 選股規則
def trailing_ret(books, a, day, lb=LOOKBACK):
    _, e_now = books[a].at(day)
    _, e_then = books[a].at(day - lb)
    if e_now is None or e_then is None or e_then < MIN_EQ: return None
    return e_now / e_then - 1.0


def trailing_dd(books, a, day, lb=LOOKBACK):
    w = books[a]
    lo = day - lb
    _, _ = w.at(lo)
    # 視窗內（含端點）權益序列
    vals = [w.eq[i] for i in range(len(w.days)) if lo <= w.days[i] <= day]
    if len(vals) < 2 or vals[0] < MIN_EQ: return None
    _, e_now = w.at(day)
    if e_now is None: return None
    vals = vals + [e_now]
    peak, dd = -1e18, 0.0
    for x in vals:
        peak = max(peak, x)
        if peak > 0: dd = max(dd, (peak - x) / peak)
    return dd


def eligible(books, a, day):
    """逐時點可用性：當下有取樣、權益 >= $1000、資料不過期（14 天內有新取樣）。"""
    i, e = books[a].at(day)
    if i is None or e is None or e < MIN_EQ: return False
    return (day - books[a].days[i]) <= MAX_STALE


def eligible_at_start(books, a, start_day, end_day):
    """買入持有策略的入選條件：視窗起點就有可用估值，且視窗內還有新取樣（不是死資料）。"""
    w = books[a]
    i, e = w.at(start_day)
    if i is None or e is None or e < MIN_EQ: return False
    if (start_day - w.days[i]) > MAX_STALE: return False
    return any(start_day <= d <= end_day for d in w.days)


# ----------------------------------------------------------------- 回測主體
def run_window(books, uni, start_day, end_day, kind, cadence=None, lookback=LOOKBACK):
    """跑一個策略 × 一個視窗。

    kind: 'static'（start 決定名單後持有）或 'rotate'（每 cadence 天重選）
    return: (metrics_dict, selected_names, turnover, rebalances)
    """
    grid = sorted({d for a in uni for d in books[a].days if start_day <= d <= end_day})
    if not grid or grid[0] > start_day: grid = [start_day] + grid
    if grid[-1] < end_day: grid = grid + [end_day]
    span = max(1, end_day - start_day)

    held, prev = [], set()
    turnover, rebalances = 0, 0
    next_reb = start_day
    rets, dts = [], []

    for i in range(len(grid) - 1):
        d1, d2 = grid[i], grid[i + 1]

        # 1) 先決定名單（只用 d1 含以前的資料），再結算 [d1,d2] 報酬
        if i == 0 or (cadence and d1 >= next_reb):
            if kind == "static":
                if i == 0:
                    held = [a for a in uni if eligible_at_start(books, a, start_day, end_day)]
            elif kind == "av":
                if i == 0:
                    cand = [a for a in uni if eligible_at_start(books, a, start_day, end_day)]
                    held = sorted(cand, key=lambda a: -books[a].av)[:TOP_N]
            else:
                cand = [a for a in uni if eligible(books, a, d1)]
                scored = []
                for a in cand:
                    if kind == "mom":
                        s = trailing_ret(books, a, d1, lookback)
                        if s is None: continue
                        scored.append((s, a))
                    elif kind == "fade":
                        s = trailing_ret(books, a, d1, lookback)
                        if s is None: continue
                        scored.append((-s, a))          # 取最差（報酬最低）
                    elif kind == "lowdd":
                        s = trailing_dd(books, a, d1, lookback)
                        if s is None: continue
                        scored.append((-s, a))          # 取回撤最小
                scored.sort(key=lambda x: (-x[0], x[1]))
                held = [a for _, a in scored[:TOP_N]]
                rebalances += 1
                if prev: turnover += len([a for a in held if a not in prev])
                prev = set(held)
            if cadence: next_reb = d1 + cadence

        # 2) 結算：等權平均所有「選中且該期可用」的錢包報酬
        rs = []
        for a in held:
            r = books[a].ret_between(d1, d2)
            if r is None: continue
            if kind == "fade": r = max(-1.0, -r)        # 做空：對其報酬取負，單期最多賠光
            rs.append(r)
        rets.append(sum(rs) / len(rs) if rs else 0.0)   # 無可用成員 → 視為空手（現金），報酬 0
        dts.append(max(1, d2 - d1))

    m = stats_from_intervals(rets, dts, span)
    m["turnover"] = turnover
    m["days"] = span
    return m, [books[a].name for a in held], turnover, rebalances


def build_note(uni_n, drop, totals):
    return (
        "【方法論】回測在「錢包層級」進行：把跟單某大戶視為持有一檔以該錢包為標的的基金，"
        "報酬直接來自 Hyperliquid portfolio(allTime) 的真實帳戶權益與累積盈虧序列，"
        "因此不需要幣種價格，也不受進出場價假設影響。"
        "每個區間把資金等權分配到當時選中的錢包，取各錢包該區間報酬的等權平均，逐期複利成組合權益曲線。"
        "｜每期報酬採 Simple Dietz = (期末累積盈虧 - 期初累積盈虧) / 期初權益：跟單者的損益等於大戶的"
        "交易盈虧，不是他帳戶權益的變化（實例：0xba5d9cc8 權益 +590%% 但盈虧只 +0.1%%，是入金；"
        "0xa4432d49 權益 -100%% 但盈虧 0%%，是提空），用權益比會把資金流誤認成績效。"
        "｜選股只用「當下（含）以前」的資料：輪換策略在 rebalance 當日用過去 %d 天報酬（或回撤）排序，"
        "先決定名單、再結算之後的報酬，因此沒有未來函數、也沒有『先看名單再回推』的偷看偏誤。"
        "入選同時要求逐時點可用性：當下有實際取樣、權益 >= $%d、且最近 %d 天內有新取樣；"
        "刻意不使用「整個視窗算完才知道可不可靠」的事後旗標，避免倖存者偏誤。"
        "｜資料異常處理：期初權益 < $%d、期內權益倍數 >= %.1f 或 <= 1/%.1f（資金異動）、"
        "或單期報酬超出 [-100%%, +%d%%] 者，該錢包該期不計入；日等效報酬 |r| > %.0f%% 者僅排除於"
        "夏普/波動/勝率統計，不影響總報酬。"
        "｜粗採樣限制：allTime 序列實測 33~%d 點、點距 5~14 天（不是每日一筆），"
        "所以「日」勝率與夏普是取樣區間換算後的近似值；回撤以取樣點為準，可能低估區間內的極端回撤。"
        "｜入金/出金：大戶常把獲利提走或補保證金，這會讓權益曲線的漲跌不等於交易績效；已用上述倍數規則排除"
        "明顯的資金異動，但小幅度的出入金無法完全分離，屬本回測的固有限制。"
        "｜宇宙：%d 個錢包中 %d 個通過資料品質篩選（點數 >= 5、歷史權益中位數 >= $%d）並成為回測宇宙，"
        "另外 %d 個明確排除（%s，多為權益長期歸零或已提空）。"
        "｜年化與夏普：以區間實際經過天數換算日等效對數報酬 r_d=ln(1+r)/天數 後年化，"
        "不把相鄰兩點硬當一天；年化報酬為區間幾何外推，30/60 天外推僅供相對比較，"
        "顯示上限截斷於 +2000%%。｜換手(turnover) = 各次重選中「新增成員」的累計個數（買入持有策略為 0）。"
        "｜反向(fade30) 為理論對照：以做空大戶報酬近似，未計資金費率、借貸成本與滑價，單期最大虧損以 -100%% 為限。"
        "｜買入持有策略（equal/top10av）名單在視窗起點固定；其後若錢包資料停止更新，以最後一次估值持有（權益不變）。"
        % (LOOKBACK, int(MIN_EQ), MAX_STALE, int(MIN_EQ), FLOW_X, FLOW_X, int(MAX_INT_R * 100),
           MAX_DR * 100,
           totals["max_pts"], totals["wallets"], uni_n, int(MIN_EQ), len(drop),
           "、".join("%s:%d" % (k, v) for k, v in sorted(_count(drop).items())) or "無")
    )


def _count(d):
    c = {}
    for v in d.values(): c[v] = c.get(v, 0) + 1
    return c


def main():
    wallets, perf = load_inputs()
    uni, drop = screen(wallets)
    books = {a: Book(w) for a, w in uni.items()}
    t_end = max(w["d1"] for w in wallets.values())
    print("錢包 %d 個，通過品質篩選 %d 個，排除 %d 個 %s" % (len(wallets), len(uni), len(drop), _count(drop)))

    STRATS = [
        ("equal",   "全部大戶等權",   "所有可靠的鏈上大戶等權持有（買入持有）",        "static", None),
        ("top10av", "淨值前 10",      "以 whales.json 的帳戶淨值(av)排序取前 10 名等權持有", "av",     None),
        ("mom7",    "動能輪換 7 天",  "每 7 天重選過去 30 天報酬最佳的前 10 名等權",   "mom",    7),
        ("mom30",   "動能輪換 30 天", "每 30 天重選過去 30 天報酬最佳的前 10 名等權",  "mom",    30),
        ("fade30",  "反向（fade）",   "每 30 天重選過去 30 天報酬最差的前 10 名並做空他們", "fade",   30),
        ("lowdd",   "低回撤優先",     "每 30 天重選過去 30 天最大回撤最小的前 10 名等權", "lowdd",  30),
    ]

    strategies = []
    for key, name, desc, kind, cad in STRATS:
        bw = {}
        for W in WINDOWS:
            start, end = t_end - W, t_end
            m, sel, tv, rb = run_window(books, uni, start, end, kind, cad)
            m["selected"] = sel
            bw[str(W)] = m
            print("  %-8s %4dd ret=%+9.2f%% ann=%+10.2f%% dd=%6.2f%% sharpe=%7.2f win=%5.1f%% vol=%6.1f%% tv=%3d x%.3f (%d 名 / %d 次重選)"
                  % (key, W, m["ret"] * 100, m["ann"] * 100, m["dd"] * 100, m["sharpe"],
                     m["win"] * 100, m["vol"] * 100, m["turnover"], m["final_mult"], len(sel), rb))
        strategies.append({"key": key, "name": name, "desc": desc, "byWindow": bw})

    best = {}
    for W in WINDOWS:
        cand = [(s["byWindow"][str(W)]["ret"], s["key"], s["name"]) for s in strategies]
        r, k, n = max(cand)
        best[str(W)] = {"key": k, "name": n, "ret": r}

    totals = {"wallets": len(wallets), "max_pts": max(w["n"] for w in wallets.values())}
    out = {"generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "windows": WINDOWS,
           "universe": {"wallets": len(wallets), "reliable": len(uni)},
           "strategies": strategies,
           "best": best,
           "note": build_note(len(uni), drop, totals)}

    p = os.path.join(HERE, "data", "backtest.json"); tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, p)
    print("寫出 %s (%.0f KB)" % (p, os.path.getsize(p) / 1024))
    print("各視窗最佳：", {k: (v["name"], "%.1f%%" % (v["ret"] * 100)) for k, v in best.items()})


if __name__ == "__main__":
    main()
