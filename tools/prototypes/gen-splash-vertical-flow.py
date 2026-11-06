# -*- coding: utf-8 -*-
# 开屏竖流：出原型图 + 出运行时参数。
#   python tools/prototypes/gen-splash-vertical-flow.py
#   → E:/deepseek工作区/HerTa/_splash-flow/*.png（设计原型用）
#   → assets/opening/vertical-flow.json（B9 播放器读的参数，不存帧）
import os, math, json
from PIL import Image, ImageDraw, ImageFont

OUT = r"E:\deepseek工作区\HerTa\_splash-flow"
RT = r"E:\deepseek工作区\HerTa\herta-mobile\assets\opening\vertical-flow.json"
W, H, CELL = 390, 844, 7
FONT_SIZE = 10
FONT = ImageFont.truetype(r"C:\Windows\Fonts\consola.ttf", FONT_SIZE)
RAMP = " .:-=+*#%@"
INK, PAPER = (17, 20, 23), (250, 252, 253)
ACCENT = (47, 125, 146)

# 时间与流动：JS 播放器按同一组数算，两边不许各自发明。
DURATION_MS = 2800   # 流多久开始交叉淡入（+FADE_MS 必须 < 4000 兜底）
FADE_MS = 600
FLICKER_HZ = 6       # int(t*6)：每格字符换字的速度
SPEED_MIN, SPEED_MAX = 0.6, 2.4
SPAN_MIN, SPAN_MAX = 0.20, 0.75
CYCLE, DROP = 1.5, 0.25
DENSITY, DENS_BASE, DENS_VARY = 0.95, 0.40, 0.60
CUTOFF = 0.05
INK_DARK, PAPER_DARK = (230, 238, 242), (13, 17, 22)

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
            speed = SPEED_MIN + h2(gx, 7)*(SPEED_MAX - SPEED_MIN)
            phase = (t*H*speed) % (H*CYCLE) - H*DROP
            span = (SPAN_MIN + h2(gx, 3)*(SPAN_MAX - SPAN_MIN)) * H
            pos = gy*CELL
            active = max(0.0, 1.0 - (pos - phase)/span) if pos > phase else 0.0
            dens = DENSITY*active*(DENS_BASE + DENS_VARY*h2(gx, gy, int(t*FLICKER_HZ)))
            if dens <= CUTOFF:
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
os.makedirs(OUT, exist_ok=True)
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


def runtime_config():
    """
    播放器要的东西全在这里：参数 + 两套明暗配色，不含任何帧。
    字段名与 assets/opening/vertical-flow.js 的 FALLBACK_CONFIG 一一对应。
    """
    return {
        "version": 1,
        "source": "tools/prototypes/gen-splash-vertical-flow.py",
        "reference": {"width": W, "height": H},
        "cell": CELL,
        "font": {"family": 'Consolas, "Courier New", ui-monospace, monospace', "size": FONT_SIZE},

        "ramp": RAMP,
        "themes": {
            "light": {"paper": list(PAPER), "ink": list(INK)},
            "dark": {"paper": list(PAPER_DARK), "ink": list(INK_DARK)},
        },
        "accent": list(ACCENT),
        "durationMs": DURATION_MS,
        "fadeMs": FADE_MS,
        "hash": {"a": 12.9898, "b": 78.233, "c": 37.719, "scale": 43758.5453},
        "rain": {
            "speedMin": SPEED_MIN, "speedMax": SPEED_MAX,
            "spanMin": SPAN_MIN, "spanMax": SPAN_MAX,
            "cycle": CYCLE, "drop": DROP,
            "density": DENSITY, "base": DENS_BASE, "vary": DENS_VARY,
            "flickerHz": FLICKER_HZ, "cutoff": CUTOFF,
        },
    }


cfg = runtime_config()
os.makedirs(os.path.dirname(RT), exist_ok=True)
with open(RT, "w", encoding="utf-8") as fh:
    json.dump(cfg, fh, ensure_ascii=False, separators=(",", ":"))
    fh.write("\n")
print("runtime", RT, os.path.getsize(RT), "bytes")
