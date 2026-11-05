# -*- coding: utf-8 -*-
import os, math
from PIL import Image, ImageDraw, ImageFont

OUT = r"E:\deepseek工作区\HerTa\_icon-a"
INK   = (17, 20, 23)
PAPER = (250, 252, 253)
CYAN  = (47, 125, 146)

LEGACY = {"mipmap-mdpi": 48, "mipmap-hdpi": 72, "mipmap-xhdpi": 96, "mipmap-xxhdpi": 144, "mipmap-xxxhdpi": 192}
FORE   = {"mipmap-mdpi": 108, "mipmap-hdpi": 162, "mipmap-xhdpi": 216, "mipmap-xxhdpi": 324, "mipmap-xxxhdpi": 432}

def hfont(px):
    return ImageFont.truetype(r"C:\Windows\Fonts\arialbd.ttf", px)

def dot_field(d, S, r_max, alpha_max, fade=0.62):
    step = max(4, int(S/64))
    for y in range(0, S, step):
        for x in range(0, S, step):
            dist = math.hypot(x-S/2, y-S/2)/(S*fade)
            r = max(0.0, r_max*(1.0-dist))*step/6
            a = int(alpha_max*(1.0-min(1.0, dist*1.15)))
            if r > 0.4 and a > 8:
                d.ellipse([x-r, y-r, x+r, y+r], fill=(CYAN[0], CYAN[1], CYAN[2], a))

def legacy(S, round_crop):
    SS = S*4
    img = Image.new("RGBA", (SS, SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img, "RGBA")
    if round_crop:
        d.ellipse([0, 0, SS-1, SS-1], fill=INK + (255,))
    else:
        r = int(SS*0.22)
        d.rounded_rectangle([0, 0, SS-1, SS-1], radius=r, fill=INK + (255,))
    dot_field(d, SS, 3.6, 150)
    f = hfont(int(SS*0.50))
    bb = d.textbbox((0, 0), "H", font=f)
    d.text(((SS-(bb[2]-bb[0]))/2-bb[0], (SS-(bb[3]-bb[1]))/2-bb[1]), "H", font=f, fill=PAPER + (255,))
    if round_crop:
        m = Image.new("L", (SS, SS), 0)
        ImageDraw.Draw(m).ellipse([0, 0, SS-1, SS-1], fill=255)
        img.putalpha(m)
    return img.resize((S, S), Image.LANCZOS)

def foreground(S):
    """自适应前景层：108dp 画布，内容压在中间 66dp 安全区里，四周透明"""
    SS = S*4
    img = Image.new("RGBA", (SS, SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img, "RGBA")
    # 点阵铺满整块画布，边缘自然淡出，被系统遮罩裁掉也不突兀
    dot_field(d, SS, 3.2, 140, fade=0.70)
    # H 只占安全区内
    f = hfont(int(SS*0.34))
    bb = d.textbbox((0, 0), "H", font=f)
    d.text(((SS-(bb[2]-bb[0]))/2-bb[0], (SS-(bb[3]-bb[1]))/2-bb[1]), "H", font=f, fill=PAPER + (255,))
    return img.resize((S, S), Image.LANCZOS)

for folder, S in LEGACY.items():
    os.makedirs(os.path.join(OUT, folder), exist_ok=True)
    legacy(S, False).save(os.path.join(OUT, folder, "ic_launcher.png"))
    legacy(S, True).save(os.path.join(OUT, folder, "ic_launcher_round.png"))

for folder, S in FORE.items():
    os.makedirs(os.path.join(OUT, folder), exist_ok=True)
    foreground(S).save(os.path.join(OUT, folder, "ic_launcher_foreground.png"))

# 预览：整枚方标 / 圆标 / 按圆遮罩裁的自适应图标
big = legacy(256, False)
rnd = legacy(256, True)
fg = foreground(432)
d = ImageDraw.Draw(fg)
mask_l = Image.new("L", (432, 432), 0)
ImageDraw.Draw(mask_l).ellipse([432*0.11, 432*0.11, 432*0.89, 432*0.89], fill=255)
mask_m = Image.new("L", (432, 432), 255)
ImageDraw.Draw(mask_m).ellipse([432*0.11, 432*0.11, 432*0.89, 432*0.89], fill=0)
bgc = Image.new("RGBA", (432, 432), INK + (255,))
adapt = Image.composite(Image.alpha_composite(bgc, fg), Image.new("RGBA", (432, 432), (60, 64, 68, 255)), mask_m)
adapt = adapt.resize((256, 256), Image.LANCZOS)

sheet = Image.new("RGB", (3*256 + 4*26, 256 + 26*2 + 26), (24, 27, 31))
ds = ImageDraw.Draw(sheet)
fo = ImageFont.truetype(r"C:\Windows\Fonts\arial.ttf", 16)
for i, (im, lab) in enumerate([(big, "legacy square / pre-8"), (rnd, "legacy round"), (adapt, "adaptive (circular mask)")]):
    x = 26 + i*(256+26)
    sheet.paste(im, (x, 26))
    ds.text((x, 26+256+8), lab, font=fo, fill=(196, 204, 211))
sheet.save(os.path.join(OUT, "_sheet.png"))
print("ok")
