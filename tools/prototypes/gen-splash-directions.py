# -*- coding: utf-8 -*-
import json, os, math, random
from PIL import Image, ImageDraw, ImageFont

SRC = r"E:\\deepseek工作区\\HerTa\\herta-mobile\\apps\\phone\\android\\app\\src\\main\\assets\\public\\opening\\segment-b-0.json"
OUT = r"E:\\deepseek工作区\\HerTa\\_splash-proto"
os.makedirs(OUT, exist_ok=True)

INK   = (17, 20, 23)
PAPER = (250, 252, 253)
CYAN  = (47, 125, 146)
GREY  = (113, 121, 132)

data = json.load(open(SRC, encoding="utf-8"))
cells = data["cells"]
xs = [c[0] for c in cells]; ys = [c[1] for c in cells]
x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
cx, cy = (x0+x1)/2, (y0+y1)/2
span = max(x1-x0, y1-y0)

F = 360          # frame size
random.seed(7)
jitter = [(random.uniform(-1,1), random.uniform(-1,1), random.random()) for _ in cells]

def circle_mask(size):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).ellipse([0,0,size-1,size-1], fill=255)
    return m

def draw_pts(d, t, fg, base_alpha=255, inside_frac=0.90):
    sc = (F*inside_frac) / span
    r = max(1.4, F*0.0032)
    for (px, py, _c), (jx, jy, rnd) in zip(cells, jitter):
        # 散点 → 归位：t 越大越靠近真实位置
        spread = (1.0 - t) * F * 0.75 * (0.35 + rnd)
        X = F/2 + (px-cx)*sc + jx*spread
        Y = F/2 + (py-cy)*sc + jy*spread
        if -r <= X <= F+r and -r <= Y <= F+r:
            a = 255
            if t < 0.35:
                a = int(90 + 165*(t/0.35))
            d.ellipse([X-r, Y-r, X+r, Y+r], fill=(fg[0], fg[1], fg[2], min(255, a)))

def frame_A(t):
    img = Image.new("RGB", (F, F), PAPER)
    d = ImageDraw.Draw(img, "RGBA")
    draw_pts(d, t, INK)
    if t >= 0.95:
        img.putalpha(circle_mask(F))
        bg = Image.new("RGB", (F, F), (250,252,253))
        img = Image.alpha_composite(bg.convert("RGBA"), img).convert("RGB")
    return img

def frame_B(t):
    img = Image.new("RGB", (F, F), (9, 13, 19))
    d = ImageDraw.Draw(img, "RGBA")
    for i in range(F//2, 0, -2):
        u = i/(F/2)
        d.ellipse([F/2-i, F/2-i, F/2+i, F/2+i], fill=(int(8+14*u), int(13+24*u), int(21+34*u), 255))
    ring = F*(0.30 + 0.14*(1-t))
    d.ellipse([F/2-ring, F/2-ring, F/2+ring, F/2+ring], outline=(CYAN[0],CYAN[1],CYAN[2],170), width=2)
    ang = math.radians(-120 + 300*t)
    sx, sy = F/2 + ring*math.cos(ang), F/2 + ring*math.sin(ang)
    d.ellipse([sx-4, sy-4, sx+4, sy+4], fill=PAPER)
    if t > 0.35:
        a = int(40 + 200*((t-0.35)/0.65))
        d2 = ImageDraw.Draw(img, "RGBA")
        sc = (F*0.62) / span
        r = max(1.0, F*0.0026)
        for (px, py, _c) in cells:
            X = F/2 + (px-cx)*sc; Y = F/2 + (py-cy)*sc
            d2.ellipse([X-r, Y-r, X+r, Y+r], fill=(PAPER[0],PAPER[1],PAPER[2], int(a*0.55)))
    img2 = img.convert("RGBA")
    img2.putalpha(circle_mask(F))
    return Image.alpha_composite(Image.new("RGBA",(F,F),(9,13,19,255)), img2).convert("RGB")

LOG = ["  h e r t a   o s", "", "  boot  h3rta 0.31", "  mem   nms ......... ok",
       "  board broadcast ... ok", "  coin  market ...... ok", "", "  > she is awake"]

def frame_C(t):
    img = Image.new("RGB", (F, F), PAPER)
    d = ImageDraw.Draw(img)
    mono = ImageFont.truetype(r"C:\\Windows\\Fonts\\consola.ttf", 15)
    big  = ImageFont.truetype(r"C:\\Windows\\Fonts\\arialbd.ttf", 72)
    if t < 0.18:
        d.rectangle([F*0.5-3, F*0.5-10, F*0.5+3, F*0.5+10], fill=INK)
        return img
    d.text((F*0.5-92, F*0.30), "HERTA", font=big, fill=INK)
    n = int(max(0, (t-0.18)/0.82) * len(LOG)) if t > 0.18 else 0
    y = F*0.30 + 92
    for line in LOG[:n] + ([""] if n else []):
        d.text((F*0.18, y), line, font=mono, fill=GREY if line.strip().startswith(("mem","board","coin")) else INK)
        y += 19
    if n >= len(LOG):
        w = int(F*0.64)
        d.rectangle([F*0.18, y+8, F*0.18+w, y+10], fill=(226,231,234))
        d.rectangle([F*0.18, y+8, F*0.18+int(w*0.94), y+10], fill=CYAN)
    if t > 0.93:
        img = Image.blend(img, Image.new("RGB",(F,F),(255,255,255)), 0.45)
    return img

TS = [0.0, 0.18, 0.36, 0.55, 0.78, 1.0]
rows = []
for name, fn in [("A", frame_A), ("B", frame_B), ("C", frame_C)]:
    frames = [fn(t) for t in TS]
    for i, f in enumerate(frames):
        f.save(os.path.join(OUT, f"{name}-{i}.png"))
    rows.append(frames)

GAP, LBL = 12, 44
W = len(TS)*F + (len(TS)+1)*GAP
H = len(rows)*(F + LBL) + (len(rows)+1)*GAP
sheet = Image.new("RGB", (W, H), (26, 29, 33))
ds = ImageDraw.Draw(sheet)
fo = ImageFont.truetype(r"C:\\Windows\\Fonts\\arial.ttf", 19)
names = ["A  POINT-CLOUD DEVELOP", "B  ORBIT WINDOW", "C  TERMINAL BOOT"]
for ri, frames in enumerate(rows):
    y = GAP + ri*(F+LBL+GAP)
    ds.text((GAP, y), names[ri], font=fo, fill=(196, 204, 211))
    for ci, f in enumerate(frames):
        x = GAP + ci*(F+GAP)
        sheet.paste(f, (x, y+28))
sheet.save(os.path.join(OUT, "_sheet.png"))
print("ok", len(rows), "rows")
