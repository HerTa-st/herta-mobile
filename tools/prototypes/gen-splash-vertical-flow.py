# -*- coding: utf-8 -*-
import os, math
from PIL import Image, ImageDraw, ImageFont

OUT = r"<workspace>\_splash-flow"
W, H, CELL = 390, 844, 7
FONT = ImageFont.truetype(r"C:\Windows\Fonts\consola.ttf", 10)
RAMP = " .:-=+*#%@"
INK, PAPER = (17, 20, 23), (250, 252, 253)
ACCENT = (47, 125, 146)

gw, gh = W // CELL, H // CELL

def h2(a, b, c=0):
    v = math.sin(a*12.9898 + b*78.233 + c*37.719) * 43758.5453
    return v - math.floor(v)

def rain(t):
    """全屏竖流，无剪影"""
    img = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(img)
    for gy in range(gh):
        for gx in range(gw):
            speed = 0.6 + h2(gx, 7)*1.8
            phase = (t*H*speed) % (H*1.5) - H*0.25
            span = (0.20 + h2(gx, 3)*0.55) * H
            pos = gy*CELL
            active = max(0.0, 1.0 - (pos - phase)/span) if pos > phase else 0.0
            dens = 0.95*active*(0.40 + 0.60*h2(gx, gy, int(t*6)))
            if dens <= 0.05:
                continue
            ch = RAMP[min(9, int(dens*9.99))]
            if ch == " ":
                continue
            d.text((gx*CELL, gy*CELL), ch, font=FONT, fill=INK)
    return img

def home_mock():
    """主页示意：左轨 + 顶栏 + 气泡"""
    img = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 58, H], fill=(246, 248, 249))
    d.ellipse([15, 24, 43, 52], outline=ACCENT, width=2)
    for i, y in enumerate(range(96, 300, 40)):
        d.rounded_rectangle([19, y, 39, y+16], radius=4, fill=(206, 214, 219) if i else ACCENT)
    d.rounded_rectangle([19, H-56, 39, H-36], radius=4, fill=(206, 214, 219))
    d.line([58, 0, 58, H], fill=(229, 234, 237), width=1)
    d.rounded_rectangle([78, 18, 150, 32], radius=7, fill=(226, 231, 234))
    d.rounded_rectangle([78, 40, 118, 52], radius=6, fill=(236, 240, 242))
    ys = 110
    for side, w, h in [(0, 190, 46), (1, 216, 74), (0, 150, 38), (1, 196, 60), (0, 168, 44)]:
        x = 78 if side == 0 else W-12-w
        fill = (236, 239, 241) if side == 0 else (255, 255, 255)
        d.rounded_rectangle([x, ys, x+w, ys+h], radius=14, fill=fill, outline=(232, 236, 238))
        ys += h + 14
    d.rounded_rectangle([78, H-96, W-12, H-58], radius=22, outline=(222, 228, 232), width=2)
    return img

TS = [0.0, 0.18, 0.36, 0.54, 0.72, 0.90]
frames = [rain(t) for t in TS]
for i, f in enumerate(frames):
    f.save(os.path.join(OUT, "final-rain-" + str(i) + ".png"))

home = home_mock()
home.save(os.path.join(OUT, "final-home.png"))
# 过渡：开屏逐渐让位给主页
trans = []
for k, a in enumerate([0.0, 0.35, 0.65, 0.90, 1.0]):
    im = Image.blend(frames[-1], home, a)
    im.save(os.path.join(OUT, "final-cross-" + str(k) + ".png"))
    trans.append(im)

SW, SH = 200, 433
GAP = 9
seq = frames[1:4] + trans[1:4] + [home]
labels = ["30%", "55%", "80%", "交叉 35%", "交叉 65%", "交叉 90%", "主页"]
sheet = Image.new("RGB", (len(seq)*SW + (len(seq)+1)*GAP, SH + 56), (24, 27, 31))
ds = ImageDraw.Draw(sheet)
fo = ImageFont.truetype(r"C:\Windows\Fonts\arial.ttf", 14)
for i, im in enumerate(seq):
    x = GAP + i*(SW+GAP)
    sheet.paste(im.resize((SW, SH), Image.LANCZOS), (x, 30))
    ds.text((x, 10), labels[i], font=fo, fill=(196, 204, 211))
sheet.save(os.path.join(OUT, "_final.png"))
print("ok", len(seq))
