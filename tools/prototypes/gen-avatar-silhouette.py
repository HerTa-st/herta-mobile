# -*- coding: utf-8 -*-
import math, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT = r"E:\\deepseek工作区\\HerTa\\_avatar-proto"
os.makedirs(OUT, exist_ok=True)
S = 1024            # supersample canvas
FINAL = 256
INK   = (17, 20, 23)
CYAN  = (47, 125, 146)
BLUE  = (37, 99, 235)
PAPER = (250, 252, 253)

def circle_mask(size, inset=0):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.ellipse([inset, inset, size-1-inset, size-1-inset], fill=255)
    return m

def finish(img, name):
    img = img.resize((FINAL, FINAL), Image.LANCZOS)
    img = img.convert("RGB")
    img.save(os.path.join(OUT, name), "PNG")
    return img

# ---------- A: halftone H ----------
def a_halftone():
    img = Image.new("RGB", (S, S), INK)
    d = ImageDraw.Draw(img, "RGBA")
    step = 18
    cx = cy = S/2
    for y in range(0, S, step):
        for x in range(0, S, step):
            dist = math.hypot(x-cx, y-cy) / (S*0.62)
            r = max(0.0, 3.2 * (1.0 - dist)) * step / 6
            a = int(140 * (1.0 - min(1.0, dist*1.15)))
            if r > 0.4 and a > 8:
                d.ellipse([x-r, y-r, x+r, y+r], fill=(CYAN[0], CYAN[1], CYAN[2], a))
    f = ImageFont.truetype(r"C:\\Windows\\Fonts\\arialbd.ttf", int(S*0.52))
    bb = d.textbbox((0,0), "H", font=f)
    d.text(((S-(bb[2]-bb[0]))/2 - bb[0], (S-(bb[3]-bb[1]))/2 - bb[1]), "H", font=f, fill=PAPER)
    img.putalpha(circle_mask(S))
    return finish(img, "A-halftone-H.png")

# ---------- B: orbit ----------
def b_orbit():
    img = Image.new("RGB", (S, S), (10, 16, 24))
    d = ImageDraw.Draw(img, "RGBA")
    for i in range(S//2, 0, -2):
        t = i / (S/2)
        col = (int(8 + 18*t), int(14 + 30*t), int(22 + 40*t), 255)
        d.ellipse([S/2-i, S/2-i, S/2+i, S/2+i], fill=col)
    for ang, rx, ry, w, a in [(0, 0.40, 0.16, 3, 150), (62, 0.38, 0.14, 2, 110), (-58, 0.34, 0.13, 2, 80)]:
        layer = Image.new("RGBA", (S, S), (0,0,0,0))
        dl = ImageDraw.Draw(layer)
        cx, cy = S/2, S/2
        dl.ellipse([cx-S*rx, cy-S*ry, cx+S*rx, cy+S*ry], outline=(CYAN[0],CYAN[1],CYAN[2],a), width=w)
        layer = layer.rotate(ang, resample=Image.BICUBIC, center=(cx, cy))
        img = Image.alpha_composite(img.convert("RGBA"), layer)
    d = ImageDraw.Draw(img, "RGBA")
    d.ellipse([S/2-S*0.085, S/2-S*0.085, S/2+S*0.085, S/2+S*0.085], fill=(INK[0],INK[1],INK[2],255), outline=(CYAN[0],CYAN[1],CYAN[2],200), width=3)
    sx, sy = S/2 + S*0.40, S/2 - S*0.02
    d.ellipse([sx-7, sy-7, sx+7, sy+7], fill=PAPER)
    glow = Image.new("RGBA", (S, S), (0,0,0,0))
    dg = ImageDraw.Draw(glow)
    dg.ellipse([sx-34, sy-34, sx+34, sy+34], fill=(CYAN[0],CYAN[1],CYAN[2],90))
    glow = glow.filter(ImageFilter.GaussianBlur(14))
    img = Image.alpha_composite(img.convert("RGBA"), glow)
    img.putalpha(circle_mask(S))
    return finish(img, "B-orbit.png")

# ---------- C: ascii H ----------
def c_ascii():
    img = Image.new("RGB", (S, S), PAPER)
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(r"C:\\Windows\\Fonts\\consola.ttf", 44)
    rows = 13
    art = [
        "#     #",
        "#     #",
        "##   ##",
        "##   ##",
        "# # # #",
        "#  #  #",
        "#     #",
        "#     #",
        "#     #",
        "#     #",
    ]
    cellw, cellh = 46, 46
    totalw = len(art[0]) * cellw
    totalh = len(art) * cellh
    ox, oy = (S-totalw)/2, (S-totalh)/2
    for ri, line in enumerate(art):
        for ci, ch in enumerate(line):
            if ch == "#":
                d.text((ox + ci*cellw, oy + ri*cellh), ch, font=f, fill=INK)
    # faint baseline grid
    for i in range(rows):
        y = oy + i*cellh + cellh*0.78
        d.line([ox-60, y, ox+totalw+60, y], fill=(230, 234, 236), width=1)
    d.text((S*0.5-38, S*0.90), "HERTA", font=ImageFont.truetype(r"C:\\Windows\\Fonts\\arial.ttf", 26), fill=(113,121,132))
    img.putalpha(circle_mask(S))
    return finish(img, "C-ascii-H.png")

# ---------- D: halo ----------
def d_halo():
    img = Image.new("RGB", (S, S), INK)
    d = ImageDraw.Draw(img)
    for i in range(S, 0, -1):
        t = i / S
        col = (int(INK[0] + (CYAN[0]-INK[0])*t*0.55), int(INK[1] + (CYAN[1]-INK[1])*t*0.55), int(INK[2] + (CYAN[2]-INK[2])*t*0.55))
        rr = i * 0.62
        d.ellipse([S/2-rr, S/2-rr, S/2+rr, S/2+rr], fill=col)
    for k, a in [(0.235, 190), (0.315, 120), (0.395, 70)]:
        r = S*k
        d.ellipse([S/2-r, S/2-r, S/2+r, S/2+r], outline=(PAPER[0],PAPER[1],PAPER[2],a), width=2)
    d.ellipse([S/2-S*0.028, S/2-S*0.028, S/2+S*0.028, S/2+S*0.028], fill=PAPER)
    img.putalpha(circle_mask(S))
    return finish(img, "D-halo.png")

imgs = [a_halftone(), b_orbit(), c_ascii(), d_halo()]

# contact sheet
PAD, LBL = 28, 34
sheet = Image.new("RGB", (FINAL*2 + PAD*3, FINAL*2 + PAD*3 + LBL*2), (24, 27, 30))
labels = ["A  HALFTONE H", "B  ORBIT", "C  ASCII H", "D  HALO"]
f = ImageFont.truetype(r"C:\\Windows\\Fonts\\arial.ttf", 20)
ds = ImageDraw.Draw(sheet)
for i, im in enumerate(imgs):
    x = PAD + (i % 2) * (FINAL + PAD)
    y = PAD + (i // 2) * (FINAL + PAD + LBL)
    sheet.paste(im, (x, y))
    ds.text((x, y + FINAL + 6), labels[i], font=f, fill=(190, 198, 205))
sheet.save(os.path.join(OUT, "_sheet.png"))
print("ok", os.listdir(OUT))
