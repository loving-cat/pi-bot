#!/usr/bin/env python3
"""生成 pi-bot 的应用图标：扁平美漫风黑洞（原创绘制，不用任何影视素材）。

风格要点：**纯平面**。没有渐变、没有发光、没有网点，只有
  · 2~3 个平涂色块（橙 / 浅橙 / 黑）
  · 粗黑描边
  · 几何化形状（扁长吸积盘 + 上下两道弧 + 黑色视界）
所有形状都是矢量式的几何体，先按 4 倍画再缩，边缘干净。

用法：
    python app/tool/make_icon.py            # 生成 1024 PNG + Windows ico + Android mipmap
    python app/tool/make_icon.py --preview  # 只出 PNG

输出：
    app/assets/icon/app-icon-1024.png
    app/windows/runner/resources/app_icon.ico
    app/android/app/src/main/res/mipmap-*/ic_launcher.png
"""
from __future__ import annotations

import argparse
import math
import os

from PIL import Image, ImageDraw

SIZE = 1024
SS = 4  # 超采样倍数：几何图形按 4 倍画再缩，边缘才干净
N = SIZE * SS

# 平涂配色（只有这几个）
BG = (12, 15, 20)
DISK = (255, 122, 24)      # 主橙
DISK_LIGHT = (255, 197, 120)  # 浅橙（内缘 / 弧 / 光子环）
INK = (8, 9, 12)           # 描边/视界

# 几何比例（相对画布边长）
HOLE_R = 0.158
DISK_HALF_W = 0.470
DISK_THICK = 0.055
ARC_R = 0.240
ARC_W = 0.034
STROKE = 0.012


def _lens(cx, cy, half_w, thick, steps=180):
    """扁平吸积盘：中间厚、两端尖的"透镜"形（edge-on 的盘）"""
    top, bottom = [], []
    for i in range(steps + 1):
        u = -1 + 2 * i / steps
        x = cx + half_w * u
        h = thick * max(0.0, 1 - u * u) ** 0.85
        top.append((x, cy - h))
        bottom.append((x, cy + h))
    return top + bottom[::-1]


def render():
    img = Image.new("RGB", (N, N), BG)
    d = ImageDraw.Draw(img)
    cx = cy = N / 2
    stroke = STROKE * N

    # ---- 1. 吸积盘：平涂橙 + 粗黑描边 ----
    lens = _lens(cx, cy, DISK_HALF_W * N, DISK_THICK * N)
    d.polygon(lens, fill=DISK, outline=INK, width=int(stroke))

    # ---- 2. 视界：纯黑圆；内缘一圈浅橙（光子环），也是平涂 ----
    r = HOLE_R * N
    d.ellipse(
        [cx - r, cy - r, cx + r, cy + r],
        fill=INK,
    )
    ring_w = max(2, int(0.010 * N))
    d.ellipse(
        [cx - r, cy - r, cx + r, cy + r],
        outline=DISK_LIGHT,
        width=ring_w,
    )

    # ---- 3. 上下两道弧（被引力透镜弯过来的盘）----
    ar = ARC_R * N
    arc_w = int(ARC_W * N)
    box = [cx - ar, cy - ar, cx + ar, cy + ar]
    for start, end in [(196, 344), (16, 164)]:
        # 平涂一道橙弧就够了：深底上对比足够，再加深色描边会糊成一圈脏边
        d.arc(box, start, end, fill=DISK, width=arc_w)

    # ---- 5. 裁成方形构图（内容四周留 8% 白边）----
    return img.resize((SIZE, SIZE), Image.LANCZOS)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", action="store_true", help="只出 PNG")
    args = ap.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # app/
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
