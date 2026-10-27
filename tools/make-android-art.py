# -*- coding: utf-8 -*-
"""用她的立绘生成 Android 图标。

源图：design/herta.png（512×512）。**不放 assets/**——那是 vite 的 publicDir，
放进去会被原样打进安装包。

产物（app/src/main/res/）：
  mipmap-*/ic_launcher.png              传统图标（整张，白底）
  mipmap-*/ic_launcher_round.png        圆形图标
  mipmap-*/ic_launcher_foreground.webp  自适应图标前景（108dp 画布，四角透明）

开屏不再是静态图：Android 12 的系统闪屏被压成纯色（见 values-v31/styles.xml），
旧版本用同一块纯色铺底，真正的开场动画由 web 侧的 assets/opening/ 播。
Android 工程不进 git，这份脚本是"换台机器怎么把图标变回来"的办法。
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "design", "herta.png")
RES = os.path.join(ROOT, "apps", "phone", "android", "app", "src", "main", "res")

DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}

BG = (255, 255, 255)


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


def drop(path: str) -> None:
    if os.path.exists(path):
        os.remove(path)


def main() -> None:
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
    print("icons done")


if __name__ == "__main__":
    main()
