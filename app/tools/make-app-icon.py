#!/usr/bin/env python3
"""
pi-bot 应用图标生成器。

设计口径（2026-11 重做）：
  · 纯 2D 扁平，不做 3D 体积与渐变
  · 只用两个颜色：玫红 HOT + 电光柠檬绿 LIME，深靛底
  · 黑洞 + 斜穿吸积盘，整体倾斜 26° 制造动势
  · 所有几何用数学椭圆，不引入位图素材，随时可重生成

用法：python3 app/tools/make-app-icon.py
输出：Flutter 资产 + macOS / Windows / Android 各尺寸
"""
import math
import os
from PIL import Image, ImageDraw

S, SS = 1024, 4
W = S * SS


def sup(v):
    return v * SS


def rot(pts, deg, cx, cy):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return [(cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c) for x, y in pts]


def ell(cx, cy, rx, ry, a0=0, a1=360, steps=360):
    return [
        (cx + rx * math.cos(math.radians(a0 + (a1 - a0) * i / steps)),
         cy + ry * math.sin(math.radians(a0 + (a1 - a0) * i / steps)))
        for i in range(steps + 1)
    ]


def ring(cx, cy, rxo, ryo, rxi, ryi):
    return ell(cx, cy, rxo, ryo) + list(reversed(ell(cx, cy, rxi, ryi)))


def P(pts):
    return [(sup(x), sup(y)) for x, y in pts]


# 只用两个颜色
BG = (10, 9, 26)
INK = (18, 10, 40)
HOT = (255, 61, 129)
LIME = (198, 255, 0)
VOID = (8, 6, 20)

CX = CY = 512.0
TILT = -26
RXO, RYO = 326.0, 314.0
RXI, RYI = 212.0, 202.0
DRX, DRY = 492.0, 88.0


def render():
    img = Image.new("RGB", (W, W), BG).convert("RGBA")

    def add(layer):
        nonlocal img
        img = Image.alpha_composite(img, layer)

    def new_layer():
        return Image.new("RGBA", (W, W), (0, 0, 0, 0))

    # 吸积盘：整条贯穿，两端收尖
    disk = new_layer()
    d = ImageDraw.Draw(disk)
    d.polygon(P(rot(ell(CX, CY, DRX + 18, DRY + 15), TILT, CX, CY)), fill=INK + (255,))
    d.polygon(P(rot(ell(CX, CY, DRX, DRY), TILT, CX, CY)), fill=LIME + (255,))
    add(disk)

    # 黑洞环
    body = new_layer()
    d = ImageDraw.Draw(body)
    d.polygon(P(rot(ring(CX, CY, RXO + 15, RYO + 13, RXI - 15, RYI - 13), TILT, CX, CY)), fill=INK + (255,))
    d.polygon(P(rot(ring(CX, CY, RXO, RYO, RXI, RYI), TILT, CX, CY)), fill=HOT + (255,))
    add(body)

    # 视界
    hole = new_layer()
    d = ImageDraw.Draw(hole)
    d.polygon(P(rot(ell(CX, CY, RXI + 15, RYI + 13), TILT, CX, CY)), fill=INK + (255,))
    d.polygon(P(rot(ell(CX, CY, RXI, RYI), TILT, CX, CY)), fill=VOID + (255,))
    add(hole)

    # 近侧半盘盖回中间，形成横穿黑洞的那一段
    front = new_layer()
    d = ImageDraw.Draw(front)
    d.polygon(P(rot(ell(CX, CY, DRX, DRY, 0, 180), TILT, CX, CY)), fill=LIME + (255,))
    add(front)

    return img.convert("RGB").resize((S, S), Image.LANCZOS)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    app = os.path.dirname(here)
    icon = render()

    icon.save(os.path.join(app, "assets/icon/app-icon-1024.png"), optimize=True)

    iconset = os.path.join(app, "macos/Runner/Assets.xcassets/AppIcon.appiconset")
    for name, size in {
        "app_icon_16.png": 16, "app_icon_32.png": 32, "app_icon_64.png": 64,
        "app_icon_128.png": 128, "app_icon_256.png": 256,
        "app_icon_512.png": 512, "app_icon_1024.png": 1024,
    }.items():
        icon.resize((size, size), Image.LANCZOS).save(os.path.join(iconset, name), optimize=True)

    win = os.path.join(app, "windows/runner/resources")
    os.makedirs(win, exist_ok=True)
    icon.save(os.path.join(win, "app_icon.ico"),
              sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    res = os.path.join(app, "android/app/src/main/res")
    for folder, size in {"mipmap-mdpi": 48, "mipmap-hdpi": 72, "mipmap-xhdpi": 96,
                         "mipmap-xxhdpi": 144, "mipmap-xxxhdpi": 192}.items():
        path = os.path.join(res, folder)
        if os.path.isdir(path):
            icon.resize((size, size), Image.LANCZOS).save(
                os.path.join(path, "ic_launcher.png"), optimize=True)

    print("图标已生成：Flutter 资产 + macOS / Windows / Android")


if __name__ == "__main__":
    main()
