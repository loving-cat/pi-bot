#!/usr/bin/env python3
"""生成 pi-bot 应用图标：黑洞（**Rick and Morty 那种美漫**，原创绘制）。

风格三要素（缺一不可）：
  1. 粗黑描边，而且**略微歪**（不是几何圆，手绘感）；
  2. 平涂高饱和色，只用一层**硬边阴影**，没有渐变；
  3. 形状圆胖、对比强，小尺寸也认得出。

构图：黑洞 = 黑色圆核 + 一圈被引力弯折的光环（黄）+ 横穿的橙色吸积盘。

用法：
    python app/tool/make_icon.py --preview
    python app/tool/make_icon.py
"""
from __future__ import annotations

import argparse
import math
import os

from PIL import Image, ImageDraw

SIZE = 1024
SS = 4
N = SIZE * SS

# 配色：高饱和平涂 + 一个近黑描边
BG = (16, 19, 28)
INK = (10, 10, 12)
YELLOW = (255, 201, 60)      # 透镜光环
YELLOW_D = (226, 165, 34)    # 光环阴影（硬边）
ORANGE = (255, 122, 26)      # 吸积盘
ORANGE_D = (214, 90, 15)     # 盘阴影（硬边）
CREAM = (255, 246, 214)      # 高光 / 内核亮边

CORE_R = 0.163      # 黑洞半径（相对画布）
HALO_IN = 1.14      # 光环内径（相对核半径）
HALO_OUT = 1.66     # 光环外径
DISK_A = 0.475      # 盘半长
DISK_B = 0.060      # 盘半厚
STROKE = 0.011      # 描边宽度（相对画布）


def _wobble(t, seed):
    """手绘感：半径上叠两条低频正弦，看起来像人画的圆"""
    return 1.0 + 0.014 * math.sin(3 * t + seed) + 0.009 * math.sin(7 * t + seed * 2.1)


def _circle_pts(cx, cy, r, seed=0.0, steps=240):
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        rr = r * _wobble(t, seed)
        pts.append((cx + rr * math.cos(t), cy + rr * math.sin(t)))
    return pts


def _ring_pts(cx, cy, r_out, r_in, seed=0.0, steps=240):
    outer = _circle_pts(cx, cy, r_out, seed, steps)
    inner = _circle_pts(cx, cy, r_in, seed + 1.7, steps)
    return outer + inner[::-1]


def _lens_pts(cx, cy, a, b, seed=0.0, steps=200, inner=False):
    """扁盘（中间厚、两头尖）。inner=True 时给出内轮廓（用作"挖空"）"""
    top, bottom = [], []
    for i in range(steps + 1):
        u = -1 + 2 * i / steps
        x = cx + a * u
        h = b * max(0.0, 1 - u * u) ** 0.9
        # 手绘感：让边缘轻微起伏
        h *= 1.0 + 0.05 * math.sin(u * 9 + seed)
        if inner:
            h *= 0.34
        top.append((x, cy - h))
        bottom.append((x, cy + h))
    return top + bottom[::-1]


def _stroke(d, pts, width):
    """沿多边形画一圈粗描边"""
    d.line(pts + [pts[0]], fill=INK, width=width, joint="curve")


def render():
    img = Image.new("RGB", (N, N), BG)
    d = ImageDraw.Draw(img)
    cx = cy = N / 2
    r = CORE_R * N
    stroke = max(3, int(STROKE * N))

    # ---- 1) 光环：黄，带一层硬边阴影（下半圈）----
    halo = _ring_pts(cx, cy, r * HALO_OUT, r * HALO_IN, seed=0.6)
    d.polygon(halo, fill=YELLOW)
    # 阴影：下半圈挖出来填暗黄（硬边，不渐变）
    shadow = []
    for i in range(121):
        t = math.pi * i / 120
        rr = r * (HALO_IN + (HALO_OUT - HALO_IN) * 1.02)
        shadow.append((cx + rr * math.cos(t), cy + rr * math.sin(t)))
    for i in range(120, -1, -1):
        t = math.pi * i / 120
        rr = r * (HALO_IN + (HALO_OUT - HALO_IN) * 0.42)
        shadow.append((cx + rr * math.cos(t), cy + rr * math.sin(t)))
    d.polygon(shadow, fill=YELLOW_D)
    _stroke(d, halo, stroke)

    # ---- 2) 吸积盘：橙，横穿；下半加一道硬边阴影 ----
    disk = _lens_pts(cx, cy, DISK_A * N, DISK_B * N, seed=2.2)
    d.polygon(disk, fill=ORANGE)
    a, b = DISK_A * N, DISK_B * N
    lower = []
    for i in range(101):
        u = -1 + 2 * i / 100
        h = b * max(0.0, 1 - u * u) ** 0.9
        lower.append((cx + a * u, cy + h * 0.32))
    for i in range(100, -1, -1):
        u = -1 + 2 * i / 100
        h = b * max(0.0, 1 - u * u) ** 0.9
        lower.append((cx + a * u, cy + h))
    d.polygon(lower, fill=ORANGE_D)
    _stroke(d, disk, stroke)

    # ---- 3) 核心：黑色圆核 + 一圈奶油色亮边（手绘圆）----
    core = _circle_pts(cx, cy, r, seed=1.1)
    d.polygon(core, fill=INK)
    rim = _circle_pts(cx, cy, r * 0.90, seed=1.1)
    d.line(rim + [rim[0]], fill=CREAM, width=max(4, int(0.026 * N)), joint="curve")

    # ---- 4) 关键光线：环上一点"反光斑"（漫画式高光，不渐变）----
    spark = _circle_pts(
        cx - r * 0.46,
        cy - r * 0.50,
        r * 0.16,
        seed=3.3,
        steps=60,
    )
    d.polygon(spark, fill=CREAM)

    return img.resize((SIZE, SIZE), Image.LANCZOS)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", action="store_true")
    args = ap.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    icon = render()

    png_dir = os.path.join(root, "assets", "icon")
    os.makedirs(png_dir, exist_ok=True)
    png = os.path.join(png_dir, "app-icon-1024.png")
    icon.save(png)
    print("PNG ->", png)
    if args.preview:
        return

    ico = os.path.join(root, "windows", "runner", "resources", "app_icon.ico")
    icon.save(ico, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("ICO ->", ico)

    android = os.path.join(root, "android", "app", "src", "main", "res")
    for folder, px in [
        ("mipmap-mdpi", 48),
        ("mipmap-hdpi", 72),
        ("mipmap-xhdpi", 96),
        ("mipmap-xxhdpi", 144),
        ("mipmap-xxxhdpi", 192),
    ]:
        target = os.path.join(android, folder)
        if not os.path.isdir(target):
            continue
        icon.resize((px, px), Image.LANCZOS).save(os.path.join(target, "ic_launcher.png"))
        print("ANDROID ->", folder)


if __name__ == "__main__":
    main()
