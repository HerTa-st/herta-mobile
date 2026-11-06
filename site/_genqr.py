# -*- coding: utf-8 -*-
import math, os
from PIL import Image, ImageDraw, ImageFont

OUT = r"E:\deepseek工作区\HerTa\site\assets\screens"
os.makedirs(OUT, exist_ok=True)

def qr(seed, label, path):
    N = 25            # 模块数
    Q = 2             # 静区
    PX = 10           # 每模块像素
    S = (N + Q * 2) * PX
    img = Image.new("RGB", (S, S), (255, 255, 255))
    d = ImageDraw.Draw(img)
    def h(a, b):
        v = math.sin(a * 12.9898 + b * 78.233 + seed * 37.719) * 43758.5453
        return v - math.floor(v)
    def finder(cx, cy):
        d.rectangle([(cx)*PX, (cy)*PX, (cx+6)*PX, (cy+6)*PX], fill=(17,20,23))
        d.rectangle([(cx+1)*PX, (cy+1)*PX, (cx+5)*PX, (cy+5)*PX], fill=(255,255,255))
        d.rectangle([(cx+2)*PX, (cy+2)*PX, (cx+4)*PX, (cy+4)*PX], fill=(17,20,23))
    for y in range(N):
        for x in range(N):
            near = (x < 8 and y < 8) or (x > N-9 and y < 8) or (x < 8 and y > N-9)
            if near: continue
            if h(x, y) > 0.52:
                d.rectangle([(x+Q)*PX, (y+Q)*PX, (x+Q+1)*PX-1, (y+Q+1)*PX-1], fill=(17,20,23))
    finder(Q, Q); finder(Q + N - 7, Q); finder(Q, Q + N - 7)
    # 中间压一块白，写占位
    m = S // 2
    half = int(S * 0.20)
    d.rectangle([m-half, m-half, m+half, m+half], fill=(255,255,255))
    try:
        f = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 20)
    except Exception:
        f = ImageFont.load_default()
    d.text((m, m), label, font=f, fill=(113,121,132), anchor="mm")
    img.save(path)

qr(1, "微信", os.path.join(OUT, "qr-wechat.png"))
qr(2, "支付宝", os.path.join(OUT, "qr-alipay.png"))
print("ok")
