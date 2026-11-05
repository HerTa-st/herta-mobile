# -*- coding: utf-8 -*-
import os, math
from PIL import Image, ImageDraw, ImageFont
OUT = r"E:\deepseek工作区\HerTa\_icon-a"
INK = (17, 20, 23); PAPER = (250, 252, 253); CYAN = (47, 125, 146)

def legacy(S, round_crop):
    SS = S*4
    img = Image.new("RGBA", (SS, SS), (0,0,0,0)); d = ImageDraw.Draw(img, "RGBA")
    if round_crop:
        d.ellipse([0,0,SS-1,SS-1], fill=INK+(255,))
    else:
        d.rounded_rectangle([0,0,SS-1,SS-1], radius=int(SS*0.22), fill=INK+(255,))
    step = max(4, int(SS/64))
    for y in range(0, SS, step):
        for x in range(0, SS, step):
            dist = math.hypot(x-SS/2, y-SS/2)/(SS*0.62)
            r = max(0.0, 3.6*(1.0-dist))*step/6
            a = int(150*(1.0-min(1.0, dist*1.15)))
            if r > 0.4 and a > 8:
                d.ellipse([x-r,y-r,x+r,y+r], fill=(CYAN[0],CYAN[1],CYAN[2],a))
    f = ImageFont.truetype(r"C:\Windows\Fonts\arialbd.ttf", int(SS*0.50))
    bb = d.textbbox((0,0), "H", font=f)
    d.text(((SS-(bb[2]-bb[0]))/2-bb[0], (SS-(bb[3]-bb[1]))/2-bb[1]), "H", font=f, fill=PAPER+(255,))
    if round_crop:
        m = Image.new("L",(SS,SS),0); ImageDraw.Draw(m).ellipse([0,0,SS-1,SS-1], fill=255); img.putalpha(m)
    return img.resize((S,S), Image.LANCZOS)

fg = Image.open(os.path.join(OUT, "mipmap-xxxhdpi", "ic_launcher_foreground.png")).convert("RGBA")
S = fg.size[0]
bg = Image.new("RGBA", (S,S), INK+(255,))
comp = Image.alpha_composite(bg, fg)
m = Image.new("L",(S,S),0)
ImageDraw.Draw(m).ellipse([S*0.085, S*0.085, S*0.915, S*0.915], fill=255)
backdrop = Image.new("RGBA",(S,S),(52,56,60,255))
adapt = Image.composite(comp, backdrop, m).resize((256,256), Image.LANCZOS)

sheet = Image.new("RGB", (3*256+4*26, 256+26*2+26), (24,27,31))
ds = ImageDraw.Draw(sheet); fo = ImageFont.truetype(r"C:\Windows\Fonts\arial.ttf", 16)
for i,(im,lab) in enumerate([(legacy(256,False),"legacy square"),(legacy(256,True),"legacy round"),(adapt,"adaptive, circular mask")]):
    x = 26+i*(256+26); sheet.paste(im,(x,26)); ds.text((x,26+256+8), lab, font=fo, fill=(196,204,211))
sheet.save(os.path.join(OUT,"_sheet.png"))
print("ok")
