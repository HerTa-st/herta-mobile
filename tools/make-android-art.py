# -*- coding: utf-8 -*-
"""用她的立绘生成 Android 图标与启动图。

源图：design/herta.png（512×512）。**不放 assets/**——那是 vite 的 publicDir，
放进去会被原样打进安装包（一张 290KB 的图没人下载得到好处）。

产物：
  assets/art/herta-320.png          启动页那张（随 web 包走）
  mipmap-*/ic_launcher.png          传统图标（整张，白底）
  mipmap-*/ic_launcher_round.png    圆形图标
  mipmap-*/ic_launcher_foreground.webp  自适应图标前景（108dp 画布，四角透明）
  drawable*/splash.webp             原生闪屏（浅底 + 居中立绘）

Android 工程不进 git（.gitignore 里有 apps/phone/android/），所以这份脚本是
"换台机器怎么把它变回来"的答案；源图在 design/ 里，跟着仓库走。

启动图用 webp 不用 png：11 张全屏 png 要 1.8MB，webp(q=90) 只要零头，
而 minSdk 是 24，WebP 早就不是问题了。
"""
import os
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "design", "herta.png")
WEB_ART = os.path.join(ROOT, "assets", "art", "herta-320.png")
RES = os.path.join(ROOT, "apps", "phone", "android", "app", "src", "main", "res")

DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
SPLASH_DIMS = {
    "drawable": (480, 320),
    "drawable-land-mdpi": (480, 320),
    "drawable-land-hdpi": (800, 480),
    "drawable-land-xhdpi": (1280, 720),
    "drawable-land-xxhdpi": (1600, 960),
    "drawable-land-xxxhdpi": (1920, 1280),
    "drawable-port-mdpi": (320, 480),
    "drawable-port-hdpi": (480, 800),
    "drawable-port-xhdpi": (720, 1280),
    "drawable-port-xxhdpi": (960, 1600),
    "drawable-port-xxxhdpi": (1280, 1920),
}

BG = (255, 255, 255)
SPLASH_BG = (248, 251, 250)


def art(size: int) -> Image.Image:
    im = Image.open(SRC).convert("RGBA")
    return im.resize((size, size), Image.LANCZOS)


def square(size: int) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), BG + (255,))
    canvas.alpha_composite(art(size))
    return canvas


def round_icon(size: int) -> Image.Image:
    base = square(size)
    mask = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
    mask = mask.resize((size, size), Image.LANCZOS)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(base, (0, 0), mask)
    return out


def foreground(size: int) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(art(size))
    return canvas


def splash(w: int, h: int) -> Image.Image:
    canvas = Image.new("RGB", (w, h), SPLASH_BG)
    glow = Image.new("RGB", (w, h), SPLASH_BG)
    d = ImageDraw.Draw(glow)
    r = int(min(w, h) * 0.52)
    d.ellipse(((w - r) // 2, int(h * 0.40) - r // 2, (w + r) // 2, int(h * 0.40) + r // 2), fill=(238, 233, 247))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=max(8, min(w, h) // 14)))
    canvas = Image.blend(canvas, glow, 0.85)
    side = int(min(w, h) * 0.46)
    card = art(side)
    canvas.paste(card, ((w - side) // 2, int(h * 0.40) - side // 2), card)
    return canvas


def drop(path: str) -> None:
    if os.path.exists(path):
        os.remove(path)


def main() -> None:
    os.makedirs(os.path.dirname(WEB_ART), exist_ok=True)
    art(320).save(WEB_ART, optimize=True)

    for name, scale in DENSITIES.items():
        folder = os.path.join(RES, "mipmap-" + name)
        os.makedirs(folder, exist_ok=True)
        size = round(48 * scale)
        square(size).save(os.path.join(folder, "ic_launcher.png"))
        round_icon(size).save(os.path.join(folder, "ic_launcher_round.png"))
        drop(os.path.join(folder, "ic_launcher_foreground.png"))
        foreground(round(108 * scale)).save(
            os.path.join(folder, "ic_launcher_foreground.webp"), "WEBP", quality=90, method=6
        )

    for folder_name, (w, h) in SPLASH_DIMS.items():
        folder = os.path.join(RES, folder_name)
        os.makedirs(folder, exist_ok=True)
        drop(os.path.join(folder, "splash.png"))
        splash(w, h).save(os.path.join(folder, "splash.webp"), "WEBP", quality=90, method=6)

    print("icons + splash done")


if __name__ == "__main__":
    main()
