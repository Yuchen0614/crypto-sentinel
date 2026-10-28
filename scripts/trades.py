# -*- coding: utf-8 -*-
"""trades.py — 策略歷史報單：用真實 K 線跑的逐筆進出場回測 → data/trades.json

為什麼要另外一支腳本
  data/backtest.json 是「錢包層級」的回測：只有權益曲線與策略報酬，沒有幣種、沒有價格，
  因此做不出「開倉價／止損／TP1～TP4／出場價」這種像報單的逐筆紀錄。
  這一支改用 Hyperliquid 的 K 線（candleSnapshot），在幣種層級重跑四個規則化策略。

資料源
  POST https://api.hyperliquid.xyz/info
  {"type":"candleSnapshot","req":{"coin":"BTC","interval":"4h","startTime":<ms>,"endTime":<ms>}}
  回傳是陣列，每根 K 線 {"t":開盤毫秒,"T":收盤毫秒,"s":幣,"i":週期,"o":開,"h":高,"l":低,"c":收,"v":量,"n":成交筆數}
  單次請求上限 5000 根（實測 3 年 4h 只回 5000 根，起點被截掉），所以這裡分段抓（每段 ≤180 天）
  並快取在 .cache/kline/（.gitignore 已排除 .cache/）。請求間隔 ≥0.55 秒，429 走指數退避。

策略（4 個）
  brk20   突破 20 日高／低（收盤由下往上穿過前 20 日最高 → 做多；由上往下穿過前 20 日最低 → 做空）
  ma2060  均線動能（MA20 上穿 MA60 → 做多；下穿 → 做空）
  rsi_pb  回檔買入（MA20>MA60 的上升趨勢中 RSI14 < 35 → 做多；MA20<MA60 的下降趨勢中 RSI14 > 65 → 做空）
  consen  大戶共識幣動能（只做共識度 ≥0.7 的幣，收盤穿越前 10 日高／低；共識名單是單日快照，屬近似）

風控與出場
  止損 = 開倉價 ∓ 1.5 × ATR14（Wilder，以 1d 計算）   1R = |開倉價 − 止損|
  TP1/2/3/4 = 開倉價 ± 1R/2R/3R/4R
  每筆固定名目 $10,000、吃單手續費 0.045%/邊（來回 0.09%）
  出場用 4h K 線依時間順序推進，同一根先看止損（影線觸價）再看 TP；
  出場＝保本停損 + 階梯移動停利：打到 TP1 止損移開倉價、TP2 移 TP1、TP3 移 TP2、TP4 直接出場，
  被移動後的止損收掉就記 TP1／TP2 出場（結果 R 剛好 +1.0／+2.0），止損 −1.0、保本 0.0
  最長持有 30 天，逾時以最後一根 4h 收盤價出場

用法
  python scripts/trades.py                 # 正式產生 data/trades.json（K 線有快取，可重跑）
  python scripts/trades.py --dry-run       # 只算不寫檔
  python scripts/trades.py --no-fetch      # 只用快取（沒有快取就報錯，不會造假）
  python scripts/trades.py --coins BTC,ETH # 只跑指定幣（測試用）
  python scripts/trades.py --refresh       # 忽略快取重抓

寫檔一律先寫 .tmp 再 os.replace，避免中斷留下半個檔案。
"""
import argparse
import bisect
import datetime as dt
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from collections import deque

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "data")
CACHE = os.path.join(HERE, ".cache", "kline")
POSITIONS = os.path.join(DATA, "positions-2026-10-27.json")
OUT = os.path.join(DATA, "trades.json")
API = "https://api.hyperliquid.xyz/info"
UA = "crypto-sentinel/1.0 (+https://github.com/yuchen0614/crypto-sentinel)"

# ── 參數（全部會寫進輸出檔的 rules，畫面上的說明與這裡一字不差）──────────────
UNIVERSE_N = 10           # 主宇宙：依總名目排序前 10 個幣
CONSEN_MIN = 0.7          # 共識度門檻
CONSEN_N = 20             # 共識幣宇宙：共識度 ≥0.7、依總名目排序前 20 檔
SIGNAL_IV = "1d"
EXIT_IV = "4h"
WINDOWS = [30, 60, 180, 360]
SIGNAL_DAYS = 450         # 抓幾天 1d（360 天視窗 + 60 天均線暖身 + 緩衝）
EXIT_DAYS = 460           # 抓幾天 4h（一定要蓋過 1d 的第一根，否則早期訊號沒有 K 線可以模擬出場）
CHUNK_DAYS = 180          # 單次請求最多抓幾天（遠低於 5000 根上限，安全）
NOTIONAL = 10000.0        # 每筆固定名目（美元）
FEE_SIDE = 0.00045        # 吃單 0.045%/邊
ATR_LEN = 14
ATR_MULT = 1.5
MAX_HOLD_DAYS = 30
MAX_PER_WINDOW = 150      # 每個策略每個視窗最多保留最近幾筆
MAX_TOTAL = 2000          # 全檔筆數上限（控制檔案大小）
DAY_MS = 86400000
IV_MS = {"1d": DAY_MS, "4h": 4 * 3600000}


def num(v):
    try:
        f = float(v)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def round_sig(x, sig=10):
    if x is None or not math.isfinite(x) or x == 0:
        return x
    d = sig - 1 - math.floor(math.log10(abs(x)))
    return round(x, d) if -12 < d < 30 else x


def iso(ms):
    return dt.datetime.fromtimestamp(ms / 1000.0, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def day_str(ms):
    return dt.datetime.fromtimestamp(ms / 1000.0, dt.timezone.utc).strftime("%Y-%m-%d")


# ══════════════════════════════════════════════════════════════════════════════
# 抓取（節流 + 指數退避 + 分段 + 快取）
# ══════════════════════════════════════════════════════════════════════════════
class Fetcher(object):
    def __init__(self, sleep_s=0.55, tries=5, verbose=True):
        self.sleep_s = sleep_s
        self.extra = 0.0
        self.tries = tries
        self.verbose = verbose
        self.calls = 0
        self.retries = 0

    def _post(self, body, timeout=40):
        req = urllib.request.Request(
            API, data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "User-Agent": UA})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)

    def candles(self, coin, interval, start, end):
        """回傳 K 線陣列（原樣），失敗回空陣列。"""
        body = {"type": "candleSnapshot",
                "req": {"coin": coin, "interval": interval,
                        "startTime": int(start), "endTime": int(end)}}
        for i in range(self.tries):
            time.sleep(self.sleep_s + self.extra)
            try:
                d = self._post(body)
                self.calls += 1
                return d if isinstance(d, list) else []
            except urllib.error.HTTPError as e:
                self.calls += 1
                self.retries += 1
                if e.code in (429, 500, 502, 503, 504):
                    wait = min(60.0, 2.0 ** (i + 1))
                    self.extra = min(2.0, self.extra + 0.25)
                    if self.verbose:
                        print("    HTTP %s → 退避 %.0fs（已累計重試 %d 次）" % (e.code, wait, self.retries))
                    time.sleep(wait)
                    continue
                if self.verbose:
                    print("    HTTP %s：%s" % (e.code, coin))
                return []
            except Exception as e:  # 網路錯誤
                self.calls += 1
                self.retries += 1
                wait = min(30.0, 2.0 ** (i + 1))
                if self.verbose:
                    print("    %s → 退避 %.0fs（%s）" % (type(e).__name__, wait, coin))
                time.sleep(wait)
        if self.verbose:
            print("    ! %s %s 連續失敗，這段沒有抓到（不會用舊資料假裝）" % (coin, interval))
        return []


def kfile(coin, interval):
    return os.path.join(CACHE, "%s_%s.json" % (coin.replace("/", "_"), interval))


def load_cache(coin, interval):
    p = kfile(coin, interval)
    if not os.path.exists(p):
        return {"candles": [], "head_exhausted": False}
    try:
        with open(p, "r", encoding="utf-8") as f:
            d = json.load(f)
        if not isinstance(d, dict) or not isinstance(d.get("candles"), list):
            return {"candles": [], "head_exhausted": False}
        # 舊版快取只存 5 欄（沒有量），M2 的量能條件要用量 → 整份重抓，不混用
        if any(len(x) < 6 for x in d["candles"]):
            if d["candles"]:
                print("    快取格式過舊（沒有成交量），重新抓取")
            return {"candles": [], "head_exhausted": False}
        return d
    except Exception:
        return {"candles": [], "head_exhausted": False}


def save_cache(coin, interval, cache):
    if not os.path.isdir(CACHE):
        os.makedirs(CACHE)
    p = kfile(coin, interval)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cache, f, separators=(",", ":"))
    os.replace(tmp, p)


def merge_candles(cache, rows):
    """rows 是 API 原樣；統一轉成 [t,o,h,l,c,v]，用 t 去重、排序。（v 是 M2 的量能條件要用）"""
    have = {}
    for c in cache["candles"]:
        if len(c) >= 6:
            have[int(c[0])] = c
    for r in rows:
        t = r.get("t")
        o, h, l, c = num(r.get("o")), num(r.get("h")), num(r.get("l")), num(r.get("c"))
        v = num(r.get("v"))
        if t is None or None in (o, h, l, c):
            continue
        have[int(t)] = [int(t), round_sig(o, 12), round_sig(h, 12), round_sig(l, 12),
                        round_sig(c, 12), round_sig(v, 8) if v is not None else 0.0]
    out = [have[k] for k in sorted(have)]
    cache["candles"] = out
    return out


def ensure_history(coin, interval, want_start, want_end, f, no_fetch=False, refresh=False):
    """把 [want_start, want_end] 的 K 線補進快取，只抓缺的部分，分段 ≤CHUNK_DAYS。"""
    if refresh and not no_fetch:
        cache = {"candles": [], "head_exhausted": False}
    else:
        cache = load_cache(coin, interval)
    step = IV_MS[interval]
    jobs = []
    rows = cache["candles"]
    if not rows:
        jobs.append((want_start, want_end))
    else:
        first, last = int(rows[0][0]), int(rows[-1][0])
        if want_start < first and not cache.get("head_exhausted"):
            jobs.append((want_start, first - step))
        if want_end > last + step:
            jobs.append((last + step, want_end))
    if jobs and no_fetch:
        raise RuntimeError("%s %s 快取不足又指定 --no-fetch（快取 %d 根）" % (coin, interval, len(rows)))
    for (s0, e0) in jobs:
        s = s0
        while s <= e0:
            e = min(e0, s + CHUNK_DAYS * DAY_MS)
            got = f.candles(coin, interval, s, e)
            if got:
                merge_candles(cache, got)
                if f.verbose:
                    print("    %s %s %s~%s → %d 根" % (coin, interval, day_str(s), day_str(e), len(got)))
            else:
                if f.verbose:
                    print("    %s %s %s~%s → 0 根" % (coin, interval, day_str(s), day_str(e)))
            s = e + step
        # 往前抓的那一段如果抓不到更早的（回傳第一根比要求的起點晚很多），記下來別每次重抓
        if s0 < (int(cache["candles"][0][0]) if cache["candles"] else want_end):
            pass
    if cache["candles"] and not jobs:
        pass
    # head_exhausted：要求往前抓、但抓完之後第一根還是沒有比 want_start 早多少 → 視為已到底
    if cache["candles"]:
        first = int(cache["candles"][0][0])
        if first > want_start + 7 * DAY_MS:
            cache["head_exhausted"] = True
    save_cache(coin, interval, cache)
    return cache["candles"]


# ══════════════════════════════════════════════════════════════════════════════
# 指標（不依賴任何套件）
# ══════════════════════════════════════════════════════════════════════════════
def sma(a, n):
    out = [None] * len(a)
    s = 0.0
    for i, v in enumerate(a):
        s += v
        if i >= n:
            s -= a[i - n]
        if i >= n - 1:
            out[i] = s / n
    return out


def true_range(h, l, c):
    tr = [None] * len(c)
    for i in range(len(c)):
        if i == 0:
            tr[i] = h[i] - l[i]
        else:
            tr[i] = max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
    return tr


def wilder_atr(h, l, c, n=14):
    """Wilder ATR：首值 = 前 n 根 TR 的簡單平均（放在索引 n），之後 ATR_t=(ATR_{t-1}×(n-1)+TR_t)/n。"""
    tr = true_range(h, l, c)
    out = [None] * len(c)
    if len(c) < n + 1:
        return out
    out[n] = sum(tr[1:n + 1]) / n
    for i in range(n + 1, len(c)):
        out[i] = (out[i - 1] * (n - 1) + tr[i]) / n
    return out


def wilder_rsi(c, n=14):
    out = [None] * len(c)
    if len(c) < n + 2:
        return out
    g = 0.0
    l = 0.0
    for i in range(1, n + 1):
        d = c[i] - c[i - 1]
        if d >= 0:
            g += d
        else:
            l -= d
    ag, al = g / n, l / n
    out[n] = 100.0 if al == 0 else 100.0 - 100.0 / (1.0 + ag / al)
    for i in range(n + 1, len(c)):
        d = c[i] - c[i - 1]
        up = d if d > 0 else 0.0
        dn = -d if d < 0 else 0.0
        ag = (ag * (n - 1) + up) / n
        al = (al * (n - 1) + dn) / n
        out[i] = 100.0 if al == 0 else 100.0 - 100.0 / (1.0 + ag / al)
    return out


def ema(a, n):
    """指數移動平均：以「前 n 根的簡單平均」當種子（放在索引 n-1），之後 EMA_t=價×k+EMA_{t-1}×(1-k)。"""
    out = [None] * len(a)
    if len(a) < n or n <= 0:
        return out
    k = 2.0 / (n + 1.0)
    seed = sum(a[:n]) / n
    out[n - 1] = seed
    for i in range(n, len(a)):
        out[i] = a[i] * k + out[i - 1] * (1 - k)
    return out


def macd(closes, fast=12, slow=26, sig=9):
    """回傳 (MACD 線, 訊號線, 柱狀體)；MACD 線＝EMA(fast)−EMA(slow)，訊號線＝MACD 線的 EMA(sig)。"""
    ef = ema(closes, fast)
    es = ema(closes, slow)
    line = [None] * len(closes)
    for i in range(len(closes)):
        if ef[i] is not None and es[i] is not None:
            line[i] = ef[i] - es[i]
    nz = [i for i, v in enumerate(line) if v is not None]
    sigl = [None] * len(closes)
    hist = [None] * len(closes)
    if nz:
        first = nz[0]
        part = ema([line[i] for i in nz], sig)
        for j, v in enumerate(part):
            if v is not None:
                sigl[nz[j]] = v
    for i in range(len(closes)):
        if line[i] is not None and sigl[i] is not None:
            hist[i] = line[i] - sigl[i]
    return line, sigl, hist


def roll_prev(arr, n, want_max=True):
    """第 i 格 = arr[i-n .. i-1] 的最大（或最小）值；資料不足 n 根時為 None。"""
    out = [None] * len(arr)
    dq = deque()
    for i in range(len(arr)):
        if dq and i >= n:
            out[i] = arr[dq[0]]
        while dq and ((arr[dq[-1]] <= arr[i]) if want_max else (arr[dq[-1]] >= arr[i])):
            dq.pop()
        dq.append(i)
        while dq and dq[0] <= i - n:
            dq.popleft()
    return out


def px_txt(x):
    """給 note 用的精簡價位（5 位有效數字、不用科學記號）。"""
    if x is None or not math.isfinite(x):
        return "—"
    a = abs(x)
    dec = 4 - math.floor(math.log10(a)) if a > 0 else 0
    dec = max(0, min(10, dec))
    return ("{:,." + str(dec) + "f}").format(x)


# ══════════════════════════════════════════════════════════════════════════════
# 訊號
# ══════════════════════════════════════════════════════════════════════════════
STRATEGIES = [
    {"key": "brk20", "name": "突破 20 日高／低", "order": 1, "tf": "1d",
     "desc": "收盤由下往上穿過前 20 日最高 → 做多；由上往下穿過前 20 日最低 → 做空。"
             "只在「穿越那一根」進場，持倉期間的新訊號一律忽略。",
     "params": "20 日突破 · 1d 訊號 · 4h 出場 · 出處：本站自訂規則"},
    {"key": "ma2060", "name": "均線動能（MA20／MA60）", "order": 2, "tf": "1d",
     "desc": "MA20 上穿 MA60 那根收盤做多、下穿那根做空。慢策略，單數少、持有久。",
     "params": "MA20 上／下穿 MA60 · 1d 訊號 · 4h 出場 · 出處：本站自訂規則"},
    {"key": "rsi_pb", "name": "回檔買入（RSI14）", "order": 3, "tf": "1d",
     "desc": "MA20>MA60 的上升趨勢中，RSI14 跌到 35 以下做多；MA20<MA60 的下降趨勢中，"
             "RSI14 漲到 65 以上做空。屬「趨勢中接回檔」的狀態式進場。",
     "params": "RSI(14) 35／65 + MA20／MA60 趨勢過濾 · 1d 訊號 · 4h 出場 · 出處：本站自訂規則"},
    {"key": "consen", "name": "大戶共識幣動能", "order": 4, "tf": "1d",
     "desc": "只做當日大戶共識度 ≥ 0.7 的幣（單日快照，屬近似），收盤穿越前 10 日高／低進場。"
             "和 brk20 同一套邏輯，差別在幣種集合與 10 日（而非 20 日）的突破長度。",
     "params": "10 日突破 + 共識度 ≥ 0.7 · 1d 訊號 · 4h 出場 · 出處：本站自訂規則"},

    # ── 以下 4 個是網路上找來的 MACD 變體，規則與出處照原文寫進輸出檔 ──────────
    {"key": "macd_hist", "name": "MACD 柱狀體翻正（教科書版）", "order": 5, "tf": "4h", "longOnly": True,
     "histExit": True,
     "desc": "MACD(12,26,9) 在 4h：柱狀體由負轉正、且收盤站在 MA200(4h) 之上 → 做多（只做多）。"
             "除了共通的止損與停利，這一條還原原始研究的出場條件：柱狀體轉負就出場。",
     "params": "MACD(12,26,9) · 4h · 過濾＝收盤 > MA200(4h) · 只做多 · 指標出場＝柱狀體轉負",
     "source": {"name": "Keel Research", "url": "https://usekeel.io/strategies/macd-crossover-crypto"},
     "original": {
         "market": "Hyperliquid 永續", "period": "2024-08-15 ~ 2026-09-29", "timeframe": "4h",
         "ret": "+408.8%", "sharpe": 1.87, "maxDD": "−33.3%",
         "cost": "已扣 4.5bp 手續費 + 4.5bp 滑價 + 資金費",
         "notes": ["原始研究沒有止損，這一區照共通規則加掛 1.5×ATR(14) 止損（所以會比原始研究更早出場）",
                   "同一套規則跑日線只有 +25.8%，幾乎打平 → 時間框是關鍵"]}},
    {"key": "macd_zero", "name": "MACD 零軸突破＋量能", "order": 6, "tf": "4h",
     "desc": "MACD(12,17,9) 在 4h：訊號線上穿零軸、且該根量 > 20 根均量×1.5、且 RSI(14) > 50 → 做多；"
             "訊號線下穿零軸、量能條件同樣成立、RSI(14) < 50 → 做空。",
     "params": "MACD(12,17,9) · 4h · 量 > MA20(量)×1.5 · RSI(14) 同向 50 之上／之下",
     "source": {"name": "SpreadAtlas", "url": "https://spreadatlas.com/indicators/macd/"},
     "original": {
         "market": "加密貨幣永續", "period": "兩段期間（研究只採計扣費後仍成立的組合）", "timeframe": "4h",
         "ret": "+39.4%／年", "sharpe": None, "maxDD": "−17.4%",
         "cost": "已扣手續費（研究以扣費後的結果為準）",
         "notes": ["研究結論：要求 MACD 在零軸之上（順勢那一側）是最有用的單一過濾條件",
                   "研究結論：4 小時以下的時間框，MACD 策略全面虧損，所以這一條也定在 4h"]}},
    {"key": "macd_ema200", "name": "MACD 訊號線交叉＋EMA200", "order": 7, "tf": "4h",
     "desc": "MACD(12,26,9) 在 4h：MACD 線上穿訊號線且收盤 > EMA200(4h) → 做多；下穿且收盤 < EMA200 → 做空。",
     "params": "MACD(12,26,9) · 4h · 過濾＝EMA200(4h) 同向",
     "source": {"name": "cryptoprofitcalc（規則 D ＋教科書交叉）",
                "url": "https://cryptoprofitcalc.com/macd-strategy-for-crypto-best-settings-signals-and-backtesting-guide/"},
     "original": {
         "market": "加密貨幣", "period": "出處未標明單一區間", "timeframe": "4h",
         "ret": None, "sharpe": None, "maxDD": None,
         "cost": "出處沒有提供可直接對比的扣費後數字",
         "notes": ["出處建議止損 1.5×ATR、目標 1.5R~3R；這一區照共通規則統一用 1/2/3/4R，結果不會和出處一樣",
                   "出處沒有公布單一可比的績效數字，所以這裡只借它的進場規則，不假造它的報酬"]}},
    {"key": "macd_div", "name": "MACD 背離（擺動點＋突破確認）", "order": 8, "tf": "4h",
     "desc": "4h 擺動高低點左右各 3 根。看多背離＝價格創更低低點、但 MACD 線創更高低點，"
             "之後要等收盤突破前一個擺動高點才進場（30 根 K 線內沒突破就作廢）；看空反過來做。",
     "params": "擺動點左右各 3 根 4h · MACD 線背離 · 突破前一個擺動高／低點確認 · 訊號 30 根內有效",
     "source": {"name": "cryptoprofitcalc（規則 C）",
                "url": "https://cryptoprofitcalc.com/macd-strategy-for-crypto-best-settings-signals-and-backtesting-guide/"},
     "original": {
         "market": "加密貨幣", "period": "出處未標明單一區間", "timeframe": "4h",
         "ret": None, "sharpe": None, "maxDD": None,
         "cost": "出處沒有提供可直接對比的扣費後數字",
         "notes": ["背離的判定在實作上很容易有歧義（哪一組高低點算擺動點），這一區把判定寫死成"
                   "「左右各 3 根、嚴格高於／低於」並公開規則，數字只在這套定義下成立",
                   "樣本數天生比交叉類策略少，請看單數再決定要不要當參考"]}},
]


def _daily_sigs(key, ctx):
    """1d 訊號：回傳 [{i, side, note}]；i 是日線索引（該根收盤時成立）。"""
    c = ctx["c"]
    out = []
    if key == "brk20":
        hi = roll_prev(ctx["h"], 20, True)
        lo = roll_prev(ctx["l"], 20, False)
        for i in range(21, len(c)):
            if hi[i] is None or lo[i] is None or hi[i - 1] is None or lo[i - 1] is None:
                continue
            if c[i] > hi[i] and c[i - 1] <= hi[i - 1]:
                out.append({"i": i, "side": "long",
                            "note": "收盤 %s 穿越前 20 日高 %s" % (px_txt(c[i]), px_txt(hi[i]))})
            elif c[i] < lo[i] and c[i - 1] >= lo[i - 1]:
                out.append({"i": i, "side": "short",
                            "note": "收盤 %s 跌破前 20 日低 %s" % (px_txt(c[i]), px_txt(lo[i]))})
    elif key == "ma2060":
        m20, m60 = ctx["ma20"], ctx["ma60"]
        for i in range(61, len(c)):
            a, b, pa, pb = m20[i], m60[i], m20[i - 1], m60[i - 1]
            if None in (a, b, pa, pb):
                continue
            if pa <= pb and a > b:
                out.append({"i": i, "side": "long", "note": "MA20 %s 上穿 MA60 %s" % (px_txt(a), px_txt(b))})
            elif pa >= pb and a < b:
                out.append({"i": i, "side": "short", "note": "MA20 %s 下穿 MA60 %s" % (px_txt(a), px_txt(b))})
    elif key == "rsi_pb":
        m20, m60, rsi = ctx["ma20"], ctx["ma60"], ctx["rsi"]
        for i in range(61, len(c)):
            if None in (m20[i], m60[i], rsi[i]):
                continue
            if m20[i] > m60[i] and rsi[i] < 35:
                out.append({"i": i, "side": "long", "note": "上升趨勢（MA20>MA60）RSI %0.1f<35" % rsi[i]})
            elif m20[i] < m60[i] and rsi[i] > 65:
                out.append({"i": i, "side": "short", "note": "下降趨勢（MA20<MA60）RSI %0.1f>65" % rsi[i]})
    elif key == "consen":
        hi = roll_prev(ctx["h"], 10, True)
        lo = roll_prev(ctx["l"], 10, False)
        cs = ctx.get("consensus")
        for i in range(11, len(c)):
            if hi[i] is None or lo[i] is None or hi[i - 1] is None or lo[i - 1] is None:
                continue
            if c[i] > hi[i] and c[i - 1] <= hi[i - 1]:
                out.append({"i": i, "side": "long",
                            "note": "共識 %s · 收盤 %s 穿越前 10 日高 %s" % (("%0.2f" % cs) if cs else "—", px_txt(c[i]), px_txt(hi[i]))})
            elif c[i] < lo[i] and c[i - 1] >= lo[i - 1]:
                out.append({"i": i, "side": "short",
                            "note": "共識 %s · 收盤 %s 跌破前 10 日低 %s" % (("%0.2f" % cs) if cs else "—", px_txt(c[i]), px_txt(lo[i]))})
    return out


# ── 4h 訊號（MACD 變體）────────────────────────────────────────────────────
def swing_idx(h, l, k=3):
    """擺動高低點：第 i 根的高點嚴格高於左右各 k 根才算擺動高點（低點反之）。"""
    n = len(h)
    highs, lows = [], []
    for i in range(k, n - k):
        ok = True
        for d in range(1, k + 1):
            if not (h[i] > h[i - d] and h[i] > h[i + d]):
                ok = False
                break
        if ok:
            highs.append(i)
        ok = True
        for d in range(1, k + 1):
            if not (l[i] < l[i - d] and l[i] < l[i + d]):
                ok = False
                break
        if ok:
            lows.append(i)
    return highs, lows


def _fourh_sigs(key, ctx4):
    """4h 訊號：回傳 [{i, side, note}]；i 是 4h 索引（該根收盤時成立）。"""
    c = ctx4["c"]
    out = []
    if key == "macd_hist":
        hist, ma200 = ctx4["hist"], ctx4["ma200"]
        for i in range(201, len(c)):
            if None in (hist[i], hist[i - 1], ma200[i]):
                continue
            if hist[i] > 0 and hist[i - 1] <= 0 and c[i] > ma200[i]:
                out.append({"i": i, "side": "long",
                            "note": "柱狀體翻正 %s→%s · 收盤 %s > MA200 %s"
                                    % (px_txt(hist[i - 1]), px_txt(hist[i]), px_txt(c[i]), px_txt(ma200[i]))})
    elif key == "macd_zero":
        sg, rsi, vsma, vol = ctx4["sig"], ctx4["rsi"], ctx4["vsma"], ctx4["v"]
        for i in range(21, len(c)):
            if None in (sg[i], sg[i - 1], rsi[i], vsma[i]):
                continue
            big = vol[i] > 1.5 * vsma[i]
            if not big:
                continue
            if sg[i] > 0 and sg[i - 1] <= 0 and rsi[i] > 50:
                out.append({"i": i, "side": "long",
                            "note": "訊號線 %s 上穿零軸 · 量 %s > 均量 %s×1.5 · RSI %0.1f"
                                    % (px_txt(sg[i]), px_txt(vol[i]), px_txt(vsma[i]), rsi[i])})
            elif sg[i] < 0 and sg[i - 1] >= 0 and rsi[i] < 50:
                out.append({"i": i, "side": "short",
                            "note": "訊號線 %s 下穿零軸 · 量 %s > 均量 %s×1.5 · RSI %0.1f"
                                    % (px_txt(sg[i]), px_txt(vol[i]), px_txt(vsma[i]), rsi[i])})
    elif key == "macd_ema200":
        line, sg, e200 = ctx4["line"], ctx4["sig"], ctx4["ema200"]
        for i in range(201, len(c)):
            if None in (line[i], line[i - 1], sg[i], sg[i - 1], e200[i]):
                continue
            if line[i - 1] <= sg[i - 1] and line[i] > sg[i] and c[i] > e200[i]:
                out.append({"i": i, "side": "long",
                            "note": "MACD %s 上穿訊號線 %s · 收盤 %s > EMA200 %s"
                                    % (px_txt(line[i]), px_txt(sg[i]), px_txt(c[i]), px_txt(e200[i]))})
            elif line[i - 1] >= sg[i - 1] and line[i] < sg[i] and c[i] < e200[i]:
                out.append({"i": i, "side": "short",
                            "note": "MACD %s 下穿訊號線 %s · 收盤 %s < EMA200 %s"
                                    % (px_txt(line[i]), px_txt(sg[i]), px_txt(c[i]), px_txt(e200[i]))})
    elif key == "macd_div":
        line, h4, l4 = ctx4["line"], ctx4["h"], ctx4["l"]
        highs, lows = swing_idx(h4, l4, 3)
        hi_pos = {j: p for p, j in enumerate(highs)}
        lo_pos = {j: p for p, j in enumerate(lows)}
        arm = None
        for i in range(5, len(c)):
            if arm and i > arm["expire"]:
                arm = None
            j2 = i - 3                                   # 這一根才確認的擺動點
            if arm is None:
                if j2 in lo_pos and lo_pos[j2] > 0:
                    j1 = lows[lo_pos[j2] - 1]
                    if (l4[j2] < l4[j1] and line[j2] is not None and line[j1] is not None
                            and line[j2] > line[j1]):
                        prev_hi = [x for x in highs if x < j2]
                        if prev_hi:
                            arm = {"side": "long", "tgt": prev_hi[-1], "expire": i + 30,
                                   "note": "看多背離：低點 %s<%s、MACD 低點 %s>%s"
                                           % (px_txt(l4[j2]), px_txt(l4[j1]), px_txt(line[j2]), px_txt(line[j1]))}
                elif j2 in hi_pos and hi_pos[j2] > 0:
                    j1 = highs[hi_pos[j2] - 1]
                    if (h4[j2] > h4[j1] and line[j2] is not None and line[j1] is not None
                            and line[j2] < line[j1]):
                        prev_lo = [x for x in lows if x < j2]
                        if prev_lo:
                            arm = {"side": "short", "tgt": prev_lo[-1], "expire": i + 30,
                                   "note": "看空背離：高點 %s>%s、MACD 高點 %s<%s"
                                           % (px_txt(h4[j2]), px_txt(h4[j1]), px_txt(line[j2]), px_txt(line[j1]))}
            if arm is not None:
                if arm["side"] == "long" and c[i] > h4[arm["tgt"]]:
                    out.append({"i": i, "side": "long",
                                "note": arm["note"] + " · 收盤 %s 突破前一個擺動高 %s"
                                        % (px_txt(c[i]), px_txt(h4[arm["tgt"]]))})
                    arm = None
                elif arm["side"] == "short" and c[i] < l4[arm["tgt"]]:
                    out.append({"i": i, "side": "short",
                                "note": arm["note"] + " · 收盤 %s 跌破前一個擺動低 %s"
                                        % (px_txt(c[i]), px_txt(l4[arm["tgt"]]))})
                    arm = None
    return out


def daily_atr_at(ctxD, ts):
    """進場當下「最後一根收完的日線」的 ATR14（4h 變體用；不會用到還沒收完的當天日線）。"""
    idx = bisect.bisect_right(ctxD["t"], ts - DAY_MS) - 1
    if idx < 0:
        return None
    return ctxD["atr"][idx]


def entries_for(st, ctxD, ctx4):
    """把兩種時間框的訊號統一成 [{ts, px, side, note, atr}]。

    ts＝訊號那根收盤、可以下單的時間點；px＝那根的收盤價（＝開倉價）。
    """
    key = st["key"]
    out = []
    if st["tf"] == "1d":
        for sg in _daily_sigs(key, ctxD):
            i = sg["i"]
            out.append({"ts": ctxD["t"][i] + DAY_MS, "px": ctxD["c"][i], "side": sg["side"],
                        "note": sg["note"], "atr": ctxD["atr"][i]})
    else:
        for sg in _fourh_sigs(key, ctx4):
            i = sg["i"]
            ts = ctx4["t"][i] + IV_MS["4h"]
            out.append({"ts": ts, "px": ctx4["c"][i], "side": sg["side"],
                        "note": sg["note"], "atr": daily_atr_at(ctxD, ts)})
    return out


# ══════════════════════════════════════════════════════════════════════════════
# 出場模擬（4h 逐根推進）
# ══════════════════════════════════════════════════════════════════════════════
def simulate(bars, t4, side, entry_ts, entry_px, sl, tps, deadline, data_end, ind_exit=None):
    """回傳 (exit_ts, exit_px, reason, r_mult, r_abs, mfe, mae, bars_used, max_tp)。

    出場口徑＝「保本停損 + 階梯移動停利」：
      · 止損一開始在開倉價 ∓ 1.5×ATR14
      · 打到 TP1 → 止損移到開倉價（保本）
      · 打到 TP2 → 止損移到 TP1；打到 TP3 → 止損移到 TP2（+1R／+2R 就被停利收掉）
      · 打到 TP4 → 直接以 TP4 出場
      · 同一根 4h K 線先算止損（影線觸價）、再算 TP；同一根不重複套用移動後的新止損
      · ind_exit（選用，M1 教科書版用）：該根收盤時指標成立（柱狀體轉負）→ 以該根收盤價出場，原因記 ind
      · 30 天到期還沒出場 → 以最後一根 4h 收盤價出場（逾時）
    出場價永遠是「開倉價／止損價／某個 TP 價／逾時那根的收盤價」，所以 R 倍數都是整數（逾時除外），
    報單上的數字可以一根一根 K 線對回來。

    bars: [[t,o,h,l,c], ...] 依 t 遞增；t4: 對應的 t 陣列。
    """
    R = abs(entry_px - sl)
    if not (R > 0):
        return None
    sgn = 1 if side == "long" else -1
    s = bisect.bisect_left(t4, entry_ts)
    e = min(len(t4), bisect.bisect_left(t4, deadline))
    if e <= s:
        return None              # 這個區間沒有任何 4h K 線（資料涵蓋不到）→ 直接不模擬，不硬湊
    stop = sl
    stop_label = "sl"
    max_tp = 0
    mfe = 0.0
    mae = 0.0
    used = 0
    for j in range(s, e):
        b = bars[j]
        hi, lo = b[2], b[3]
        used += 1
        fav = ((hi - entry_px) if side == "long" else (entry_px - lo)) / R
        adv = ((lo - entry_px) if side == "long" else (entry_px - hi)) / R
        if adv < mae:
            mae = adv
        # 1) 止損（同一根先算）
        if ((lo <= stop) if side == "long" else (hi >= stop)):
            rm = (stop - entry_px) * sgn / R
            return (b[0] + IV_MS["4h"] - 1, stop, stop_label, rm, R, mfe, mae, used, max_tp)
        if fav > mfe:
            mfe = fav
        # 2) 觸及 TP：取該根觸及的最高那個
        k = 0
        for m in range(4, 0, -1):
            t = tps[m - 1]
            if ((hi >= t) if side == "long" else (lo <= t)):
                k = m
                break
        if k > max_tp:
            max_tp = k
            if k >= 4:
                return (b[0] + IV_MS["4h"] - 1, tps[3], "tp4", 4.0, R, mfe, mae, used, max_tp)
            # 移動後的止損從下一根 K 線才生效
            stop = entry_px if k == 1 else tps[k - 2]
            stop_label = "be" if k == 1 else "tp%d" % (k - 1)
        # 3) 指標出場（3 個條件都成立後才做）：該根收盤時指標轉向 → 以收盤價出場
        if ind_exit is not None and j < len(ind_exit) and ind_exit[j]:
            rm = (b[4] - entry_px) * sgn / R
            return (b[0] + IV_MS["4h"] - 1, b[4], "ind", rm, R, mfe, mae, used, max_tp)
    # 期限內沒有出場
    if e >= len(t4):                 # 4h 資料到這裡就沒了 → 視為還在持倉
        px = bars[len(t4) - 1][4] if len(t4) else entry_px
        return (data_end, px, "open", (px - entry_px) * sgn / R, R, mfe, mae, used, max_tp)
    last = bars[e - 1]
    return (last[0] + IV_MS["4h"] - 1, last[4], "timeout",
            (last[4] - entry_px) * sgn / R, R, mfe, mae, used, max_tp)


# ══════════════════════════════════════════════════════════════════════════════
# 主流程
# ══════════════════════════════════════════════════════════════════════════════
def pick_universe(positions):
    coins = positions.get("coins") or []
    ranked = sorted(coins, key=lambda x: -((x.get("long_usd") or 0) + (x.get("short_usd") or 0)))
    uni = [x["coin"] for x in ranked[:UNIVERSE_N]]
    cons = [x for x in ranked if (x.get("consensus") or 0) >= CONSEN_MIN]
    top = cons[:CONSEN_N]
    cons_coins = [x["coin"] for x in top]
    cmap = {}
    for x in top:
        cmap[x["coin"]] = x.get("consensus")
    return {"coins": uni, "consensusCoins": cons_coins, "consensus": cmap,
            "consensusAll": len(cons), "notional": {x["coin"]: (x.get("long_usd") or 0) + (x.get("short_usd") or 0) for x in ranked}}


def stats_for(trades, win, now_ms):
    """視窗統計。trades 是該策略在該視窗內的紀錄（已含 open 的）。"""
    closed = [x for x in trades if x["exitReason"] != "open"]
    opens = [x for x in trades if x["exitReason"] == "open"]
    rs = [x["rMult"] for x in closed]
    pnls = [x["pnlUsd"] for x in closed]
    n = len(closed)
    def share(pred):
        return (sum(1 for x in closed if pred(x)) / n) if n else None
    cur = 0.0
    peak = 0.0
    dd = 0.0
    for x in sorted(closed, key=lambda y: y["entryTs"]):
        cur += x["pnlUsd"]
        peak = max(peak, cur)
        dd = max(dd, peak - cur)
    out = {
        "n": n,
        "nOpen": len(opens),
        "nSignals": sum(1 for x in trades),
        "winRate": share(lambda x: x["pnlUsd"] > 0),
        "avgR": (sum(rs) / n) if n else None,
        "totalR": sum(rs) if n else 0.0,
        "expR": (sum(rs) / n) if n else None,
        "medR": (sorted(rs)[n // 2] if n % 2 else (sorted(rs)[n // 2 - 1] + sorted(rs)[n // 2]) / 2.0) if n else None,
        "bestR": max(rs) if n else None,
        "worstR": min(rs) if n else None,
        "tp1Hit": share(lambda x: x["maxTp"] >= 1),
        "tp2Hit": share(lambda x: x["maxTp"] >= 2),
        "tp3Hit": share(lambda x: x["maxTp"] >= 3),
        "tp4Hit": share(lambda x: x["maxTp"] >= 4),
        "be": share(lambda x: x["exitReason"] == "be"),
        "slHit": share(lambda x: x["exitReason"] == "sl"),
        "timeout": share(lambda x: x["exitReason"] == "timeout"),
        "exitMix": {
            "tp1": sum(1 for x in closed if x["exitReason"] == "tp1"),
            "tp2": sum(1 for x in closed if x["exitReason"] == "tp2"),
            "tp3": sum(1 for x in closed if x["exitReason"] == "tp3"),
            "tp4": sum(1 for x in closed if x["exitReason"] == "tp4"),
            "be": sum(1 for x in closed if x["exitReason"] == "be"),
            "sl": sum(1 for x in closed if x["exitReason"] == "sl"),
            "timeout": sum(1 for x in closed if x["exitReason"] == "timeout"),
        },
        "avgMaxTp": (sum(x["maxTp"] for x in closed) / n) if n else None,
        "pnlUsd": sum(pnls) if n else 0.0,
        "pnlPerTrade": (sum(pnls) / n) if n else None,
        "feeUsd": round(NOTIONAL * FEE_SIDE * 2 * n, 2),
        "maxDDUsd": dd,
        "avgHoldHours": (sum(x["holdHours"] for x in closed) / n) if n else None,
        "avgBars": (sum(x["bars"] for x in closed) / n) if n else None,
        "avgMfeR": (sum(x["mfeR"] for x in closed) / n) if n else None,
        "avgMaeR": (sum(x["maeR"] for x in closed) / n) if n else None,
        "coins": len(set(x["coin"] for x in trades)),
        "longN": sum(1 for x in trades if x["side"] == "long"),
        "shortN": sum(1 for x in trades if x["side"] == "short"),
        "firstEntryTs": min((x["entryTs"] for x in trades), default=None),
        "lastEntryTs": max((x["entryTs"] for x in trades), default=None),
    }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-fetch", action="store_true")
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--sleep", type=float, default=0.55)
    ap.add_argument("--coins", default="")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    with open(POSITIONS, "r", encoding="utf-8") as fh:
        positions = json.load(fh)
    uni = pick_universe(positions)
    if args.coins:
        want = [x.strip() for x in args.coins.split(",") if x.strip()]
        uni["coins"] = [x for x in want]
        uni["consensusCoins"] = [x for x in want]
        uni["consensus"] = {k: uni["consensus"].get(k) for k in want}

    all_coins = []
    for x in uni["coins"] + uni["consensusCoins"]:
        if x not in all_coins:
            all_coins.append(x)
    print("宇宙：主宇宙 %d 幣 %s" % (len(uni["coins"]), "、".join(uni["coins"])))
    print("      共識宇宙 %d 幣 %s" % (len(uni["consensusCoins"]), "、".join(uni["consensusCoins"])))

    now_ms = int(time.time() // 1) * 1000
    f = Fetcher(sleep_s=args.sleep, verbose=not args.quiet)
    daily = {}
    bars4 = {}
    history = {}
    want_d0 = now_ms - SIGNAL_DAYS * DAY_MS
    want_e0 = now_ms - EXIT_DAYS * DAY_MS
    for coin in all_coins:
        print("  ▸ %s" % coin)
        try:
            d1 = ensure_history(coin, SIGNAL_IV, want_d0, now_ms, f, args.no_fetch, args.refresh)
            d4 = ensure_history(coin, EXIT_IV, want_e0, now_ms, f, args.no_fetch, args.refresh)
        except RuntimeError as e:
            print("    ! %s" % e)
            return 2
        if len(d1) < 80:
            print("    ! %s 1d 只有 %d 根，不足以算 MA60／ATR14，略過" % (coin, len(d1)))
            continue
        if len(d4) < 40:
            print("    ! %s 4h 只有 %d 根，不足以做出場模擬，略過" % (coin, len(d4)))
            continue
        daily[coin] = d1
        bars4[coin] = d4
        history[coin] = {
            "d1": {"n": len(d1), "from": day_str(d1[0][0]), "to": day_str(d1[-1][0])},
            "h4": {"n": len(d4), "from": day_str(d4[0][0]), "to": day_str(d4[-1][0])},
        }
    if not daily:
        print("沒有可用的幣種資料，中止（不寫檔）")
        return 2

    data_end = max(int(b[-1][0]) + IV_MS["4h"] - 1 for b in bars4.values())
    print("請求：%d 次（重試 %d 次）· 資料結束 %s" % (f.calls, f.retries, iso(data_end)))

    # ── 指標：日線（1d 訊號用）與 4h（MACD 變體用）──────────────────────
    ctxs = {}
    ctx4s = {}
    for coin, d1 in daily.items():
        t = [int(x[0]) for x in d1]
        o = [x[1] for x in d1]
        h = [x[2] for x in d1]
        l = [x[3] for x in d1]
        c = [x[4] for x in d1]
        # 最後一根日線若還沒收完（收盤時間晚於資料結束）就丟掉，避免用到未來的收盤價
        if t and t[-1] + DAY_MS - 1 > data_end:
            t, o, h, l, c = t[:-1], o[:-1], h[:-1], l[:-1], c[:-1]
        ctxs[coin] = {"t": t, "o": o, "h": h, "l": l, "c": c,
                      "atr": wilder_atr(h, l, c, ATR_LEN),
                      "rsi": wilder_rsi(c, ATR_LEN),
                      "ma20": sma(c, 20), "ma60": sma(c, 60),
                      "consensus": uni["consensus"].get(coin)}

        b = bars4[coin]
        t4 = [int(x[0]) for x in b]
        h4 = [x[2] for x in b]
        l4 = [x[3] for x in b]
        c4 = [x[4] for x in b]
        v4 = [x[5] for x in b]
        line, sigl, hist = macd(c4, 12, 26, 9)          # M1、M3、M4
        line2, sigl2, hist2 = macd(c4, 12, 17, 9)       # M2（出處用 12,17,9）
        ctx4s[coin] = {
            "t": t4, "o": [x[1] for x in b], "h": h4, "l": l4, "c": c4, "v": v4,
            "line": line, "sig": sigl, "hist": hist,
            "line2": line2, "sig2": sigl2, "hist2": hist2,
            "ma200": sma(c4, 200), "ema200": ema(c4, 200),
            "rsi": wilder_rsi(c4, ATR_LEN), "vsma": sma(v4, 20),
            # M1 的原始出場條件：柱狀體轉負（只做多，所以看 hist < 0）
            "hist_neg": [1 if (hist[i] is not None and hist[i] < 0) else 0 for i in range(len(c4))],
        }

    # ── 八個策略（4 個自訂 + 4 個 MACD 變體）──────────────────────────
    strategies_out = []
    all_records = []          # (key, win, record) 供最後裁切
    for st in STRATEGIES:
        key = st["key"]
        pool = uni["consensusCoins"] if key == "consen" else uni["coins"]
        pool = [x for x in pool if x in ctxs and x in ctx4s]
        n_sig = 0
        n_skip_pos = 0
        n_skip_atr = 0
        n_skip_nodata = 0
        per_coin = {}
        for coin in pool:
            ctx = ctxs[coin]
            sigs = entries_for(st, ctx, ctx4s[coin])
            if st.get("longOnly"):
                sigs = [s for s in sigs if s["side"] == "long"]
            n_sig += len(sigs)
            t4 = [int(x[0]) for x in bars4[coin]]
            trades = []
            busy_until = -1          # 同時最多一筆持倉：持倉期間的訊號略過
            for sg in sigs:
                entry_ts = sg["ts"]
                if entry_ts < busy_until:
                    n_skip_pos += 1
                    continue
                if entry_ts > data_end:
                    continue
                atr = sg["atr"]
                if atr is None or atr <= 0 or sg["px"] <= 0:
                    n_skip_atr += 1
                    continue
                side = sg["side"]
                entry_px = sg["px"]
                sl = entry_px - ATR_MULT * atr if side == "long" else entry_px + ATR_MULT * atr
                R = abs(entry_px - sl)
                tps = [entry_px + k * R if side == "long" else entry_px - k * R for k in (1, 2, 3, 4)]
                sim = simulate(bars4[coin], t4, side, entry_ts, entry_px, sl, tps,
                               entry_ts + MAX_HOLD_DAYS * DAY_MS, data_end,
                               ind_exit=ctx4s[coin]["hist_neg"] if st.get("histExit") else None)
                if sim is None:
                    n_skip_nodata += 1
                    continue
                exit_ts, exit_px, reason, rm, r_abs, mfe, mae, used, max_tp = sim
                if reason != "open":
                    busy_until = exit_ts
                notional = NOTIONAL
                gross = rm * r_abs / entry_px
                pnl_usd = round(notional * gross - notional * FEE_SIDE * 2, 2)
                rec = {
                    "id": "", "win": "", "coin": coin, "side": side,
                    "entryTs": entry_ts, "entryPx": round_sig(entry_px),
                    "sl": round_sig(sl), "tp1": round_sig(tps[0]), "tp2": round_sig(tps[1]),
                    "tp3": round_sig(tps[2]), "tp4": round_sig(tps[3]),
                    "atr": round_sig(atr), "rAbs": round_sig(r_abs),
                    "exitTs": exit_ts, "exitPx": round_sig(exit_px), "exitReason": reason,
                    "rMult": round(rm, 4), "pnlPct": round(gross * 100 - FEE_SIDE * 200, 4),
                    "pnlUsd": pnl_usd,
                    "mfeR": round(mfe, 3), "maeR": round(mae, 3), "maxTp": max_tp,
                    "bars": used, "holdHours": round((exit_ts - entry_ts) / 3600000.0, 1),
                    "note": sg["note"],
                }
                trades.append(rec)
            if trades:
                per_coin[coin] = trades

        n_trade = sum(len(v) for v in per_coin.values())
        print("  ■ %-7s %-14s 訊號 %5d · 持倉中略過 %5d · 缺 ATR 略過 %3d · 無 K 線略過 %3d · 成單 %5d"
              % (key, st["name"], n_sig, n_skip_pos, n_skip_atr, n_skip_nodata, n_trade))

        # 依視窗切（開倉時間落在最近 N 天內），每窗最多留最近 MAX_PER_WINDOW 筆
        by_window = {}
        for win in WINDOWS:
            cut = data_end - win * DAY_MS
            rows = []
            for coin, trs in per_coin.items():
                for r0 in trs:
                    if r0["entryTs"] >= cut:
                        rows.append(r0)
            rows.sort(key=lambda x: x["entryTs"])
            if len(rows) > MAX_PER_WINDOW:
                rows = rows[-MAX_PER_WINDOW:]
            for j, r0 in enumerate(rows):
                r0 = dict(r0)
                r0["id"] = "%s#%s#%d" % (key, r0["coin"], j + 1)
                r0["win"] = str(win)
                by_window[str(win)] = by_window.get(str(win), [])
                by_window[str(win)].append(r0)
                all_records.append((key, str(win), r0))

        stats = {}
        for win in WINDOWS:
            stats[str(win)] = stats_for(by_window.get(str(win), []), win, data_end)
        strategies_out.append({
            "key": key, "name": st["name"], "desc": st["desc"], "order": st["order"],
            "pool": pool,
            "signals": n_sig, "skippedInPosition": n_skip_pos, "skippedNoAtr": n_skip_atr,
            "skippedNoKline": n_skip_nodata,
            "trades": [r for win in WINDOWS for r in by_window.get(str(win), [])],
            "byWindow": stats,
        })

    # ── 全域裁切（控制檔案大小）──────────────────────────────────────
    total = sum(len(s["trades"]) for s in strategies_out)
    if total > MAX_TOTAL:
        # 從最舊的開始丟，直到符合上限
        flat = []
        for s in strategies_out:
            for r in s["trades"]:
                flat.append(r)
        flat.sort(key=lambda x: x["entryTs"])
        drop = set(id(r) for r in flat[:total - MAX_TOTAL])
        for s in strategies_out:
            s["trades"] = [r for r in s["trades"] if id(r) not in drop]
            for win in WINDOWS:
                s["byWindow"][str(win)]["nTrimmed"] = s["byWindow"][str(win)]["n"] - sum(
                    1 for r in s["trades"] if r["win"] == str(win))
        print("  裁切：%d → %d 筆" % (total, sum(len(s['trades']) for s in strategies_out)))

    rules_text = (
        "這一區的數字全部由 scripts/trades.py 用 Hyperliquid 的真實 K 線重算，不是既有回測檔（data/backtest.json）的數字。"
        "訊號看 1d 收盤、出場模擬走 4h K 線，價格沒有任何一處是補的。"
        "① 進場：訊號成立當天的日線收盤價就是開倉價（當天那根 1d 還沒收完一律丟掉，不會用到未來的收盤價）。"
        "② 止損：開倉價 ∓ 1.5×ATR14（ATR 用 Wilder 平滑、以 1d 計算）。1R 就是開倉價到止損的距離。"
        "③ 目標：TP1=1R、TP2=2R、TP3=3R、TP4=4R，價格印在報單上。"
        "④ 出場＝保本停損 + 階梯移動停利：打到 TP1 止損移到開倉價（保本）、打到 TP2 移到 TP1、打到 TP3 移到 TP2，"
        "被移動後的止損收掉就記 TP1／TP2 出場（結果 R 剛好 +1.0／+2.0）；打到 TP4 直接以 TP4 出場（+4.0）。"
        "⑤ 同一根 4h K 線先算止損（影線觸價）再算 TP，所以同一根同時碰到止損與目標時一律算止損（保守）；"
        "移動後的新止損從下一根 K 線才生效，不會用同一根的上下影線各算一次。"
        "⑥ 持倉上限：每筆最多 30 天，時間到就用當下最後一根 4h 收盤價出場，原因記逾時（timeout）。"
        "⑦ 同一幣同時最多一筆（持倉期間的新訊號略過），所以單數是「獨立的一段行情」而不是同一段重複疊單。"
        "⑧ 資金：每筆固定名目 $10,000，手續費吃單 0.045%/邊、來回 0.09%（$9）已經扣在損益裡；沒有算資金費率與滑價。"
        "⑨ 結果 R＝實際出場距離 ÷ 1R（TP2 出場就是 +2.0、止損是 −1.0、保本是 0.0）；"
        "損益 $＝名目 ×（結果 R × 1R ÷ 開倉價）− 手續費（單一幣種、不加槓桿的線性口徑）。"
        "⑩ 視窗（30／60／180／360 天）看的是「開倉時間」；同一筆單的開倉時間只要同時落在兩個視窗裡，兩邊都會出現，所以各視窗的數字不能相加。"
        "⑪ 觸及率（TP1／TP2／TP3）＝該筆單在出場前價格真的到過第 n 個目標的比例，用 K 線的高低點判定，"
        "和「最後在哪裡出場」是兩件事：到過 TP2 的單最後可能是被移到 TP1 的止損收掉。"
        "⑫ 已知限制：共識幣名單只有 data/positions-2026-10-27.json 這一天的快照（不是每天的歷史共識度），consen 屬於近似；"
        "同一根 4h K 線一次穿過多個目標時，只認最高的那個（同一根不會先停利再重複利用該根的低點）；"
        "訊號用收盤價、沒有模擬盤中掛單的滑價與部分成交；還沒出場的單標示「持倉中」、不列入統計。"
    )

    out = {
        "generated_at": iso(int(time.time() * 1000)),
        "source": "Hyperliquid /info candleSnapshot（4h 出場模擬、1d 訊號）",
        "universe": {
            "coins": uni["coins"],
            "consensusCoins": uni["consensusCoins"],
            "consensusMin": CONSEN_MIN,
            "consensusPoolAll": uni["consensusAll"],
            "consensusByCoin": {k: v for k, v in uni["consensus"].items() if v is not None},
            "interval": EXIT_IV, "signalInterval": SIGNAL_IV,
            "windows": WINDOWS,
            "selection": "主宇宙＝data/positions-2026-10-27.json 依總名目（多+空）排序前 %d 個幣；"
                         "共識宇宙＝同檔共識度 ≥ %.1f 的幣依總名目排序前 %d 檔（共識名單是單日快照，屬近似）。"
                         % (UNIVERSE_N, CONSEN_MIN, CONSEN_N),
            "history": history,
            "dataEndTs": data_end,
            "fetchedDays": {"signal": SIGNAL_DAYS, "exit": EXIT_DAYS},
        },
        "rules": {
            "text": rules_text,
            "params": {
                "signalInterval": SIGNAL_IV, "exitInterval": EXIT_IV,
                "atr": {"len": ATR_LEN, "method": "Wilder", "mult": ATR_MULT},
                "tpR": [1, 2, 3, 4], "maxHoldDays": MAX_HOLD_DAYS,
                "notionalUsd": NOTIONAL, "feePerSide": FEE_SIDE, "feeRoundTrip": FEE_SIDE * 2,
                "windows": WINDOWS, "maxPerWindow": MAX_PER_WINDOW,
                "sameBarRule": "同一根 4h K 線同時觸及 TP 與止損時先算止損",
                "onePositionPerCoin": True,
                "tpTouch": "影線觸價；同一根觸及多個目標只認最高的那個，移動後的新止損下一根才生效",
                "exitModel": "保本停損 + 階梯移動停利：TP1→止損移開倉價、TP2→移 TP1、TP3→移 TP2、TP4→直接出場",
                "exitReasonLabels": {
                    "sl": "止損", "be": "保本停損", "tp1": "TP1 出場", "tp2": "TP2 出場",
                    "tp3": "TP3 出場", "tp4": "TP4 出場", "timeout": "逾時", "open": "持倉中"
                },
            },
            "perStrategy": {s["key"]: s["desc"] for s in STRATEGIES},
        },
        "strategies": strategies_out,
    }

    # 檔案大小檢查
    blob = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    print("輸出：%d 筆單 · %.0f KB" % (sum(len(s["trades"]) for s in strategies_out), len(blob.encode("utf-8")) / 1024.0))
    for s in strategies_out:
        for win in WINDOWS:
            b = s["byWindow"][str(win)]
            print("   %-7s %4s 天  n=%3d 勝率=%s 平均R=%s 總R=%s TP1/2/3=%s/%s/%s 止損=%s 損益=$%s"
                  % (s["key"], win, b["n"],
                     ("%.1f%%" % (b["winRate"] * 100)) if b["winRate"] is not None else "—",
                     ("%+.3f" % b["avgR"]) if b["avgR"] is not None else "—",
                     ("%+.1f" % b["totalR"]),
                     ("%.0f%%" % (b["tp1Hit"] * 100)) if b["tp1Hit"] is not None else "—",
                     ("%.0f%%" % (b["tp2Hit"] * 100)) if b["tp2Hit"] is not None else "—",
                     ("%.0f%%" % (b["tp3Hit"] * 100)) if b["tp3Hit"] is not None else "—",
                     ("%.0f%%" % (b["slHit"] * 100)) if b["slHit"] is not None else "—",
                     ("%+.0f" % b["pnlUsd"])))
    if args.dry_run:
        print("--dry-run：不寫檔")
        return 0
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(blob)
    os.replace(tmp, OUT)
    print("已寫入 %s" % OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
