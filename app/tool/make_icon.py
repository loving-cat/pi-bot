#!/usr/bin/env python3
"""生成 pi-bot 应用图标：**破环 + 漏出的光 + 一个点**（原创设计）。

设计语言（为什么长这样）：
  · **破环** —— 环是开的，缺口就是 "open"：不封闭、可接入、可改；
  · **缺口漏光** —— 光从缝里射出来，是"能量/算力"在跑；
  · **一个点** —— 就是那个跑在你自己机器上的 agent；
  · 手绘美漫：粗黑描边、平涂高饱和色、圆的半径带一点不规则。

刻意**不画**"星球 + 横穿的光带"——那会读成 `-o-`，是插画不是标志。

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

BG = (14, 18, 29)
INK = (9, 10, 13)
ORANGE = (255, 122, 26)
LIGHT = (255, 214, 110)
CREAM = (255, 247, 220)

# 几何（相对画布）
R_OUT = 0.392
R_IN = 0.238
GAP_DEG = 46          # 缺口角度：越大越"开"
DOT_R = 0.074
STROKE = 0.020


def _wob(r, t, k=0.016):
    """手绘感：半径叠两条低频正弦"""
    return r * (1 + k * math.sin(3 * t + 0.7) + k * 0.6 * math.sin(7 * t + 2.3))


def _arc_ring(cx, cy, r_in, r_out, a0, a1, steps=220):
    """环形扇段（含缺口）的多边形"""
    outer, inner = [], []
    for i in range(steps + 1):
        t = math.radians(a0 + (a1 - a0) * i / steps)
        outer.append((cx + _wob(r_out, t) * math.cos(t), cy + _wob(r_out, t) * math.sin(t)))
        inner.append((cx + _wob(r_in, t, -0.012) * math.cos(t), cy + _wob(r_in, t, -0.012) * math.sin(t)))
    return outer + inner[::-1]


def _beam(cx, cy, r0, r1, a0, a1, steps=40):
    """从缺口射出的光：里窄外宽的楔形"""
    pts = []
    for i in range(steps + 1):
        t = math.radians(a0 + (a1 - a0) * 0.42 * i / steps + (a0 + a1) / 2 * 0)
        pts.append((cx + r0 * math.cos(t), cy + r0 * math.sin(t)))
    # 外缘：张角更大
    outer_span = (a1 - a0) * 1.45
    mid = (a0 + a1) / 2
    for i in range(steps + 1):
        t = math.radians(mid + outer_span / 2 - outer_span * i / steps)
        pts.append((cx + r1 * math.cos(t), cy + r1 * math.sin(t)))
    return pts


def _circle(cx, cy, r, steps=120, wobble=0.0):
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        rr = r * (1 + wobble * math.sin(3 * t + 1.2))
        pts.append((cx + rr * math.cos(t), cy + rr * math.sin(t)))
    return pts


def _outline(d, pts, width):
    d.line(pts + [pts[0]], fill=INK, width=width, joint="curve")


def render():
    img = Image.new("RGB", (N, N), BG)
    d = ImageDraw.Draw(img)
    cx = cy = N / 2
    r_out = R_OUT * N
    r_in = R_IN * N
    stroke = max(3, int(STROKE * N))

    # 缺口朝右，稍微偏下一点（更有动势）
    gap_mid = 8
    a0 = gap_mid + GAP_DEG / 2
    a1 = gap_mid - GAP_DEG / 2 + 360

    # ---- 1) 光：先画，让它从环的下层透出来 ----
    # 三束光从缺口射出（平涂、不描边）—— 像"能量漏出来"，比一整块楔形更像设计
    for k, (ang, length, half) in enumerate(
        [(-14, 0.474, 0.020), (0, 0.492, 0.026), (14, 0.470, 0.018)]
    ):
        a = math.radians(gap_mid + ang)
        bx = cx + r_in * 0.94 * math.cos(a)
        by = cy + r_in * 0.94 * math.sin(a)
        tip = N * length
        tx = cx + tip * math.cos(a)
        ty = cy + tip * math.sin(a)
        nx, ny = -math.sin(a), math.cos(a)
        bw = N * half
        d.polygon(
            [
                (bx + nx * bw, by + ny * bw),
                (tx, ty),
                (bx - nx * bw, by - ny * bw),
            ],
            fill=LIGHT,
        )

    # ---- 2) 环：粗描边 + 平涂橙 ----
    ring = _arc_ring(cx, cy, r_in, r_out, a0, a1)
    d.polygon(ring, fill=ORANGE)
    _outline(d, ring, stroke)

    # ---- 3) 点：那个 agent ----
    dot = _circle(cx - N * 0.035, cy - N * 0.012, DOT_R * N, wobble=0.02)
    d.polygon(dot, fill=CREAM)
    _outline(d, dot, max(3, int(stroke * 0.8)))

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
