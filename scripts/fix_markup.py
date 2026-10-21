# -*- coding: utf-8 -*-
"""Repair the view markup: the moved chain panel had swallowed col-b's closing
tag, so the on-chain view was parsed INSIDE the market view."""
import io

P = r"C:\Users\admin\OneDrive\桌面\projects\crypto-sentinel\index.html"
raw = io.open(P, encoding="utf-8", newline="").read()
crlf = "\r\n" in raw
s = raw.replace("\r\n", "\n")

# 1. close col-b (its </section> travelled with the chain panel)
old1 = """    </section>

    <!-- 右：聰明錢 / 巨鯨 / 持倉 -->"""
new1 = """    </section>
    </section><!-- /col-b -->

    <!-- 右：聰明錢 / 巨鯨 / 持倉 -->"""
assert old1 in s, "col-b anchor missing"
s = s.replace(old1, new1, 1)

# 2. drop the duplicated close tag left behind inside the on-chain view
old2 = """    </section>
  </section>

  </section>
</main>"""
new2 = """    </section>
  </section>
</main>"""
assert old2 in s, "on-chain tail anchor missing"
s = s.replace(old2, new2, 1)

io.open(P, "w", encoding="utf-8", newline="").write(s.replace("\n", "\r\n") if crlf else s)
print("markup repaired")
