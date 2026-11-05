# -*- coding: utf-8 -*-
import os, math
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT = r"<workspace>\_avatar-mine"
os.makedirs(OUT, exist_ok=True)
S = 1024
INK   = (17, 20, 23)
PAPER = (250, 252, 253)
CYAN  = (47, 125, 146)
DEEP  = (9, 13, 19)

def mask(size):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).ellipse([0, 0, size-1, size-1], fill=255)
    return m

def finish(img, name):
    img = img.convert("RGBA")
    img.putalpha(mask(S))
    corner = img.getpixel((S//2, 4))[:3]
    img = Image.alpha_composite(Image.new("RGBA", (S, S), corner + (255,)), img).convert("RGB")
    out = img.resize((256, 256), Image.LANCZOS)
    out.save(os.path.join(OUT, name + ".png"))
    return out

def A_halftone():
    img = Image.new("RGB", (S, S), INK)
    d = ImageDraw.Draw(img, "RGBA")
    step = 16
    for y in range(0, S, step):
        for x in range(0, S, step):
            dist = math.hypot(x-S/2, y-S/2) / (S*0.62)
            r = max(0.0, 3.4*(1.0-dist)) * step / 6
            a = int(150*(1.0-min(1.0, dist*1.15)))
            if r > 0.4 and a > 8:
                d.ellipse([x-r, y-r, x+r, y+r], fill=(CYAN[0], CYAN[1], CYAN[2], a))
    f = ImageFont.truetype(r"C:\Windows\Fonts\arialbd.ttf", int(S*0.50))
    bb = d.textbbox((0, 0), "H", font=f)
    d.text(((S-(bb[2]-bb[0]))/2-bb[0], (S-(bb[3]-bb[1]))/2-bb[1]), "H", font=f, fill=PAPER)
    return finish(img, "A-halftone-H")

def B_orbit():
    img = Image.new("RGB", (S, S), DEEP)
    d = ImageDraw.Draw(img, "RGBA")
    for i in range(S//2, 0, -2):
        u = i/(S/2)
        d.ellipse([S/2-i, S/2-i, S/2+i, S/2+i], fill=(int(8+14*u), int(13+26*u), int(21+38*u), 255))
    for ang, rx, ry, w, a in [(0, .40, .15, 4, 165), (64, .37, .13, 3, 115), (-56, .33, .12, 3, 80)]:
        layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        dl = ImageDraw.Draw(layer)
        dl.ellipse([S/2-S*rx, S/2-S*ry, S/2+S*rx, S/2+S*ry], outline=(CYAN[0], CYAN[1], CYAN[2], a), width=w)
        img = Image.alpha_composite(img.convert("RGBA"), layer.rotate(ang, resample=Image.BICUBIC, center=(S/2, S/2))).convert("RGB")
    d = ImageDraw.Draw(img, "RGBA")
    d.ellipse([S/2-S*.08, S/2-S*.08, S/2+S*.08, S/2+S*.08], fill=(INK[0], INK[1], INK[2], 255), outline=(CYAN[0], CYAN[1], CYAN[2], 210), width=4)
    sx, sy = S/2 + S*.40, S/2 - S*.01
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([sx-40, sy-40, sx+40, sy+40], fill=(CYAN[0], CYAN[1], CYAN[2], 100))
    img = Image.alpha_composite(img.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(16))).convert("RGB")
    d = ImageDraw.Draw(img)
    d.ellipse([sx-9, sy-9, sx+9, sy+9], fill=PAPER)
    return finish(img, "B-orbit")

def C_hat():
    img = Image.new("RGB", (S, S), PAPER)
    d = ImageDraw.Draw(img)
    d.ellipse([18*S/100, 58*S/100, 82*S/100, 74*S/100], fill=INK)
    d.polygon([(50*S/100, 16*S/100), (66*S/100, 62*S/100), (34*S/100, 62*S/100)], fill=INK)
    d.polygon([(50*S/100, 45*S/100), (61*S/100, 60*S/100), (39*S/100, 60*S/100)], fill=CYAN)
    d.ellipse([48.4*S/100, 9*S/100, 51.6*S/100, 12.2*S/100], fill=CYAN)
    return finish(img, "C-hat")

def D_halo():
    img = Image.new("RGB", (S, S), INK)
    d = ImageDraw.Draw(img)
    for i in range(S, 0, -1):
        t = i/S
        d.ellipse([S/2-i*.62, S/2-i*.62, S/2+i*.62, S/2+i*.62],
                  fill=(int(INK[0]+(CYAN[0]-INK[0])*t*.55), int(INK[1]+(CYAN[1]-INK[1])*t*.55), int(INK[2]+(CYAN[2]-INK[2])*t*.55)))
    for k, a in [(0.225, 200), (0.305, 130), (0.385, 75)]:
        r = S*k
        d.ellipse([S/2-r, S/2-r, S/2+r, S/2+r], outline=(PAPER[0], PAPER[1], PAPER[2], a), width=3)
    d.ellipse([S/2-S*.026, S/2-S*.026, S/2+S*.026, S/2+S*.026], fill=PAPER)
    return finish(img, "D-halo")

def E_starrail():
    img = Image.new("RGB", (S, S), PAPER)
    d = ImageDraw.Draw(img)
    d.line([(16*S/100, 84*S/100), (84*S/100, 16*S/100)], fill=(31, 36, 33), width=5)
    d.ellipse([30*S/100, 34*S/100, 70*S/100, 66*S/100], outline=(31, 36, 33), width=5)
    d.ellipse([58*S/100, 20*S/100, 66*S/100, 28*S/100], fill=CYAN)
    return finish(img, "E-starrail")

def F_grid():
    img = Image.new("RGB", (S, S), PAPER)
    d = ImageDraw.Draw(img)
    art = ["#   #", "#   #", "##  #", "## ##", "# # #", "#  ##", "#   #", "#   #"]
    cw, ox, oy = 11.0, 28.0, 22.0
    for ri, line in enumerate(art):
        for ci, ch in enumerate(line):
            if ch == "#":
                x, y = (ox+ci*cw)*S/100, (oy+ri*cw*1.05)*S/100
                d.rounded_rectangle([x, y, x+cw*S/100*0.78, y+cw*S/100*0.78], radius=3, fill=INK)
    d.rounded_rectangle([28*S/100, 78*S/100, 72*S/100, 82*S/100], radius=6, fill=CYAN)
    return finish(img, "F-grid")

imgs = [A_halftone(), B_orbit(), C_hat(), D_halo(), E_starrail(), F_grid()]
names = ["A  HALFTONE H", "B  ORBIT", "C  HAT", "D  HALO", "E  STAR RAIL", "F  GRID H"]

PAD, LBL, SMALL, cols = 22, 30, 48, 3
sheet = Image.new("RGB", (cols*(256+PAD)+PAD, 2*(256+LBL+SMALL+PAD)+PAD), (24, 27, 31))
ds = ImageDraw.Draw(sheet)
fo = ImageFont.truetype(r"C:\Windows\Fonts\arial.ttf", 17)
fs2 = ImageFont.truetype(r"C:\Windows\Fonts\arial.ttf", 12)
for i, im in enumerate(imgs):
    x = PAD + (i % cols)*(256+PAD)
    y = PAD + (i // cols)*(256+LBL+SMALL+PAD)
    sheet.paste(im, (x, y))
    ds.text((x, y+256+6), names[i], font=fo, fill=(196, 204, 211))
    sheet.paste(im.resize((SMALL, SMALL), Image.LANCZOS), (x+256-SMALL, y+256+LBL+6))
    ds.text((x, y+256+LBL+12), "48px", font=fs2, fill=(120, 128, 136))
sheet.save(os.path.join(OUT, "_sheet.png"))
print("ok")
