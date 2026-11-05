# -*- coding: utf-8 -*-
"""黑塔币 · 持仓分享卡生成器

一次产出三种状态：盈利 / 空仓 / 破产。
- 浅色底：盈利、亏损、空仓（白天 A 那套 token）
- 深墨底：破产（左下暗红光晕 + 一枚 -9° 的「破产」印章）
- 每张都带一句她的吐槽（固定文案库，不调模型）

用法：python gen-coin-share.py  → 在同目录产出 *_share-*.png
改数字就改下面的 FIG 常量；改文案就改 QUIPS。
"""

import math
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT = r"."          # 输出目录
W, H, S = 1080, 1440, 2
w, h = W * S, H * S
f = lambda n, s: ImageFont.truetype(n, int(s * S))
CONS = r"C:\Windows\Fonts\consola.ttf"
MYH = r"C:\Windows\Fonts\msyh.ttc"
ARB = r"C:\Windows\Fonts\arialbd.ttf"

INK = (17, 20, 23); SOFT = (59, 67, 80); MUT = (113, 121, 132)
ACC = (47, 125, 146); UP = (194, 85, 79); FAINT = (150, 158, 166)
P1 = (250, 252, 253); P2 = (242, 247, 248)

# ---- 这里改数字 ----
FIG = dict(price="128.40", pct="+3.12%", qty="1,000 HTC", cost="96.20",
           value="128,400", pnl="+32,200", pnl_pct="+33.5%", net="228,400",
           cash="100,000", bankrupt="0", liabilities="18,420", bankrupt_times=2)
QUIPS = dict(profit="运气不错。别当成能力。", loss="你的操作很有观赏性。",
             empty="空着。挺诚实。", bankrupt="破产两次。你在这方面的确有天赋。")


def T(d, x, y, t, font, fill):
    d.text((x * S, y * S), t, font=font, fill=fill)

def CWd(d, t, font):
    return d.textlength(t, font=font) / S

def light_bg():
    base = Image.new("RGB", (w, h), P1); d = ImageDraw.Draw(base)
    for yy in range(h):
        t = yy / h
        d.line([0, yy, w, yy], fill=tuple(int(P1[i] + (P2[i] - P1[i]) * t) for i in range(3)))
    img = base.convert("RGBA")
    g = Image.new("RGBA", (w, h), (0, 0, 0, 0)); gd = ImageDraw.Draw(g)
    for i in range(360, 0, -3):
        t = i / 360
        gd.ellipse([-t*260*S, -t*220*S, t*260*S, t*220*S], fill=(223, int(243-8*t), 244, int(70*(1-t))))
    gd.ellipse([(W-260)*S, -160*S, (W+260)*S, 160*S], fill=(231, 238, 247, 60))
    img = Image.alpha_composite(img, g.filter(ImageFilter.GaussianBlur(60*S)))
    d = ImageDraw.Draw(img)
    for yy in range(0, h, int(22*S)):
        for xx in range(0, w, int(22*S)):
            dist = math.hypot(xx + 60*S, yy + 40*S) / (w * 0.5)
            r = max(0.0, 4.0 * (1.0 - dist)); a = int(34 * (1.0 - min(1.0, dist*1.15)))
            if r > 0.5 and a > 6:
                d.ellipse([xx-r, yy-r, xx+r, yy+r], fill=(ACC[0], ACC[1], ACC[2], a))
    return img

def light_head(d, sub):
    T(d, 72, 84, "HERTA COIN", f(ARB, 24), ACC)
    T(d, 72, 122, sub, f(MYH, 21), MUT)
    d.line([72*S, 170*S, (W-72)*S, 170*S], fill=(17, 20, 23, 24), width=int(1.6*S))

def light_price(d):
    T(d, 72, 196, "HTC / 信用点", f(MYH, 22), SOFT)
    T(d, 68, 224, FIG["price"], f(CONS, 84), INK)
    T(d, 68 + CWd(d, FIG["price"], f(CONS, 84)) + 20, 286, FIG["pct"], f(CONS, 30), UP)

def light_footer(d, quip):
    d.line([72*S, 1096*S, (W-72)*S, 1096*S], fill=(17, 20, 23, 20), width=int(1.4*S))
    d.rectangle([72*S, 1148*S, 75*S, 1192*S], fill=(47, 125, 146, 140))
    T(d, 90, 1150, quip, f(MYH, 24), SOFT)
    T(d, 72, 1300, "www.herta-st-gp.top", f(CONS, 22), MUT)


def card_profit():
    card = [72*S, 404*S, (W-72)*S, 610*S]
    img = light_bg()
    sh = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle([card[0], card[1]+7*S, card[2], card[3]+7*S], radius=24*S, fill=(32, 45, 58, 24))
    img = Image.alpha_composite(img, sh.filter(ImageFilter.GaussianBlur(15*S)))
    ov = Image.new("RGBA", (w, h), (0, 0, 0, 0)); od = ImageDraw.Draw(ov)
    od.rounded_rectangle(card, radius=24*S, fill=(255, 255, 255, 200), outline=(17, 20, 23, 20), width=int(2*S))
    od.line([72*S, 786*S, (W-72)*S, 786*S], fill=(17, 20, 23, 24), width=int(1.6*S))
    img = Image.alpha_composite(img, ov); d = ImageDraw.Draw(img)
    light_head(d, "模拟宇宙交易所 · 虚构行情"); light_price(d)
    y = 404 + 36
    for k, v in [("持仓", FIG["qty"]), ("成本价", FIG["cost"]), ("市值", FIG["value"])]:
        T(d, 104, y, k, f(MYH, 21), MUT)
        vw = d.textlength(v, font=f(CONS, 30))
        d.text(((W-104)*S - vw, y*S), v, font=f(CONS, 30), fill=SOFT); y += 58
    T(d, 72, 644, "浮动盈亏", f(MYH, 21), MUT)
    T(d, 68, 672, FIG["pnl"], f(CONS, 48), UP)
    T(d, 70, 736, FIG["pnl_pct"], f(CONS, 28), UP)
    T(d, 72, 812, "净资产", f(MYH, 21), MUT); T(d, 72, 842, FIG["net"], f(CONS, 32), INK)
    T(d, 72, 896, "破产", f(MYH, 21), MUT); T(d, 72, 926, FIG["bankrupt"], f(CONS, 32), SOFT)
    T(d, 72 + CWd(d, FIG["bankrupt"], f(CONS, 32)) + 10, 936, "次", f(MYH, 21), SOFT)
    light_footer(d, QUIPS["profit"])
    img.convert("RGB").resize((W, H), Image.LANCZOS).save(OUT + r"\_share-profit.png")


def card_empty():
    img = light_bg(); od = Image.new("RGBA", (w, h), (0, 0, 0, 0)); odr = ImageDraw.Draw(od)
    odr.line([72*S, 170*S, (W-72)*S, 170*S], fill=(17, 20, 23, 24), width=int(1.6*S))
    odr.line([72*S, 740*S, (W-72)*S, 740*S], fill=(17, 20, 23, 24), width=int(1.6*S))
    x0, y0, x1, y1 = 72*S, 404*S, (W-72)*S, 600*S
    dash, gap, width = int(15*S), int(10*S), int(2*S)
    x = x0
    while x < x1:
        odr.line([x, y0, min(x+dash, x1), y0], fill=(17,20,23,58), width=width)
        odr.line([x, y1, min(x+dash, x1), y1], fill=(17,20,23,58), width=width); x += dash + gap
    y = y0
    while y < y1:
        odr.line([x0, y, x0, min(y+dash, y1)], fill=(17,20,23,58), width=width)
        odr.line([x1, y, x1, min(y+dash, y1)], fill=(17,20,23,58), width=width); y += dash + gap
    img = Image.alpha_composite(img, od); d = ImageDraw.Draw(img)
    T(d, 72, 84, "HERTA COIN", f(ARB, 24), ACC)
    T(d, 72, 122, "模拟宇宙交易所 · 虚构行情", f(MYH, 21), MUT)
    light_price(d)
    T(d, (W - CWd(d, "空仓", f(MYH, 32))) / 2, 466, "空仓", f(MYH, 32), FAINT)
    T(d, (W - CWd(d, "还没有持仓", f(MYH, 20))) / 2, 516, "还没有持仓", f(MYH, 20), (176, 182, 188))
    T(d, 72, 632, "现金", f(MYH, 21), MUT); T(d, 72, 662, FIG["cash"], f(CONS, 38), SOFT)
    T(d, 72 + CWd(d, FIG["cash"], f(CONS, 38)) + 12, 680, "信用点", f(MYH, 21), MUT)
    T(d, 72, 768, "净资产", f(MYH, 21), MUT); T(d, 72, 798, FIG["cash"], f(CONS, 32), INK)
    T(d, 72, 852, "破产", f(MYH, 21), MUT); T(d, 72, 882, FIG["bankrupt"], f(CONS, 32), SOFT)
    T(d, 72 + CWd(d, FIG["bankrupt"], f(CONS, 32)) + 10, 892, "次", f(MYH, 21), SOFT)
    light_footer(d, QUIPS["empty"])
    img.convert("RGB").resize((W, H), Image.LANCZOS).save(OUT + r"\_share-empty.png")


def card_bankrupt():
    I0, I1 = (9, 10, 12), (30, 16, 16)
    RED, DEEP, SS, MM = (233, 118, 106), (194, 85, 79), (178, 170, 168), (120, 130, 138)
    b = Image.new("RGB", (w, h), I0); d = ImageDraw.Draw(b)
    for yy in range(h):
        t = (yy/h) ** 1.15
        d.line([0, yy, w, yy], fill=tuple(int(I0[i] + (I1[i]-I0[i])*t) for i in range(3)))
    img = b.convert("RGBA")
    g = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(g).ellipse([-200*S, (H-240)*S, (W+200)*S, (H+300)*S], fill=(194, 85, 79, 50))
    img = Image.alpha_composite(img, g.filter(ImageFilter.GaussianBlur(110*S))); d = ImageDraw.Draw(img)
    for yy in range(0, h, int(24*S)):
        for xx in range(0, w, int(24*S)):
            dist = math.hypot(xx + 40*S, yy + 30*S) / (w * 0.55)
            r = max(0.0, 3.6 * (1.0 - dist)); a = int(38 * (1.0 - min(1.0, dist*1.15)))
            if r > 0.5 and a > 6:
                d.ellipse([xx-r, yy-r, xx+r, yy+r], fill=(DEEP[0], DEEP[1], DEEP[2], a))
    sw, shh = 340, 190
    stamp = Image.new("RGBA", (sw*S, shh*S), (0, 0, 0, 0)); sd = ImageDraw.Draw(stamp)
    sd.rounded_rectangle([5*S, 5*S, (sw-5)*S, (shh-5)*S], radius=14*S, outline=(233, 118, 106, 190), width=int(8*S))
    fst = f(MYH, 98); bb = sd.textbbox((0, 0), "破产", font=fst)
    sd.text(((sw*S-(bb[2]-bb[0]))/2 - bb[0], (shh*S-(bb[3]-bb[1]))/2 - bb[1]), "破产", font=fst, fill=(233, 118, 106, 200))
    stamp = stamp.rotate(-9, resample=Image.BICUBIC, expand=False)
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0)); layer.paste(stamp, (int(664*S), int(900*S)), stamp)
    img = Image.alpha_composite(img, layer); d = ImageDraw.Draw(img)
    T(d, 72, 84, "HERTA COIN", f(ARB, 24), RED)
    T(d, 72, 122, "模拟宇宙交易所 · 破产记录", f(MYH, 21), MM)
    d.line([72*S, 170*S, (W-72)*S, 170*S], fill=(233, 118, 106, 55), width=int(1.6*S))
    T(d, 72, 196, "净资产", f(MYH, 22), SS)
    T(d, 64, 224, "-" + FIG["liabilities"], f(CONS, 84), RED)
    T(d, 72, 318, "已达负数 · 无下限", f(MYH, 21), MM)
    d.line([72*S, 376*S, (W-72)*S, 376*S], fill=(255, 255, 255, 24), width=int(1.6*S))
    y = 404
    for k, v in [("负债合计", FIG["liabilities"]), ("破产次数", str(FIG["bankrupt_times"]) + " 次"),
                 ("重开起点", "1,000 HTC / 10,000 信用点")]:
        T(d, 72, y, k, f(MYH, 21), MM)
        if any(ch in v for ch in "次点"):
            T(d, 72, y+28, v, f(MYH, 23), SS); y += 86
        else:
            vw = d.textlength(v, font=f(CONS, 30))
            d.text(((W-72)*S - vw, (y+28)*S), v, font=f(CONS, 30), fill=SS); y += 86
    d.line([72*S, 660*S, (W-72)*S, 660*S], fill=(255, 255, 255, 20), width=int(1.4*S))
    d.rectangle([72*S, 700*S, 75*S, 746*S], fill=(233, 118, 106, 135))
    T(d, 90, 702, QUIPS["bankrupt"], f(MYH, 24), SS)
    T(d, 72, 1300, "www.herta-st-gp.top", f(CONS, 22), (96, 104, 112))
    img.convert("RGB").resize((W, H), Image.LANCZOS).save(OUT + r"\_share-bankrupt.png")


card_profit(); card_empty(); card_bankrupt()
print("ok")
