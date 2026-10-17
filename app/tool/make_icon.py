#!/usr/bin/env python3
"""pi-bot 应用图标：斜扫的黑洞（程序化绘制，原创，不用任何影视素材）。

构图（参考"斜着扫过去"的那种感觉，不做对称的 -o-）：
  · 黑球偏左下，一圈**极细的白光环**贴着它 —— 辨识度的核心；
  · 一大片发光带从左上斜扫到右上，绕过球体，越往外越薄（引力透镜 + 多普勒增亮）；
  · 球体右下有一条更薄的亮带，暗示盘的另一侧；
  · 全图暖白调 + 轻微颗粒与暗角，像一帧被拉近的电影画面。

用法：
    python app/tool/make_icon.py --preview
    python app/tool/make_icon.py
"""
from __future__ import annotations

import argparse
import os

import numpy as np
from PIL import Image, ImageFilter

SIZE = 1024
SS = 2
N = SIZE * SS

CORE_X, CORE_Y = 0.46, 0.55   # 黑球位置（相对画布）
CORE_R = 0.190
DISK_A = 0.520           # 盘半长
DISK_B = 0.055           # 盘半厚
RING_W = 0.0050               # 光子环宽度
SPIRAL_A = 1.06               # 起始半径（相对 CORE_R）
SPIRAL_GROW = 1.35            # 扫出去时半径增长
SPIRAL_W0 = 0.30              # 起始厚度（相对 CORE_R）
SPIRAL_W1 = 0.04              # 末端厚度
TH0, TH1 = 205, -25           # 从左侧绕过顶部扫到右侧（角度制）

RAMP_X = [0.00, 0.10, 0.24, 0.40, 0.58, 0.76, 0.92, 1.15]
RAMP_R = [4, 24, 70, 148, 208, 238, 251, 255]
RAMP_G = [4, 17, 47, 108, 168, 214, 240, 252]
RAMP_B = [4, 13, 35, 84, 138, 192, 228, 247]


def _ss(a, b, x):
    t = np.clip((x - a) / (b - a + 1e-9), 0, 1)
    return t * t * (3 - 2 * t)


def render():
    y, x = np.mgrid[0:N, 0:N].astype(np.float32)
    cx, cy = CORE_X * N, CORE_Y * N
    dx, dy = x - cx, y - cy
    r = np.sqrt(dx * dx + dy * dy) + 1e-6
    R = CORE_R * N

    # 把坐标整体斜过来：盘是斜着扫过去的，这样才不会读成 -o-
    ang = np.radians(-26)
    u = dx * np.cos(ang) + dy * np.sin(ang)     # 沿盘方向
    v = -dx * np.sin(ang) + dy * np.cos(ang)    # 垂直盘方向

    # ---- 1) 吸积盘：斜向的细长带，向外变薄，带丝状条纹 ----
    a, b = DISK_A * N, DISK_B * N
    e = np.sqrt((u / a) ** 2 + (v / b) ** 2)
    disk = np.exp(-(((e - 1.0) / 0.55) ** 2))
    disk *= np.exp(-((v / (b * 3.0)) ** 2))
    disk *= np.clip(1 - (np.abs(u) / a) ** 3, 0, 1) ** 1.3          # 两端收尖
    disk *= 0.82 + 0.18 * np.sin(u * 0.010 + v * 0.030)             # 宽而缓的纹理
    disk *= 0.90 + 0.10 * np.sin(v * 0.05 - u * 0.006)

    # ---- 2) 透镜弧：绕球体的光带，上方更亮更厚（不对称）----
    th = np.arctan2(dy, dx)
    band = _ss(1.03, 1.10, r / R) * (1 - _ss(1.42, 1.62, r / R))
    lobes = 0.22 + 0.78 * np.clip(np.cos(th + np.radians(38)), 0, 1) ** 0.9
    arc = band * lobes * (0.80 + 0.20 * np.sin(r * 0.07 + th * 3.0))

    # ---- 3) 光子环 ----
    ring = np.exp(-(((r - R * 1.025) / (RING_W * N)) ** 2))

    # ---- 4) 黑球 ----
    shadow = 1 - _ss(R * 0.985, R * 1.01, r)

    # 盘的前半（靠观察者一侧）从球前面穿过：v>0 的小范围
    front = disk * np.clip(v / (b * 1.6), 0, 1)

    I = ring * 2.8 + arc * 0.82 + disk * 0.98 + front * 0.26
    I *= 1 - 0.94 * shadow * (1 - 0.80 * np.clip(front, 0, 1))
    I *= 1 - 0.32 * np.exp(-(((r - R * 1.004) / (N * 0.0035)) ** 2))

    # ---- 5) 辉光 / 暗角 / 颗粒 ----
    bloom = np.asarray(
        Image.fromarray((np.clip(I, 0, 2) / 2 * 255).astype(np.uint8), "L").filter(
            ImageFilter.GaussianBlur(int(N * 0.014))
        ),
        dtype=np.float32,
    ) / 255.0
    I = I + bloom * 0.45
    I *= 1 - 0.42 * np.clip((r / (N * 0.8)) ** 2, 0, 1)
    rng = np.random.default_rng(11)
    I = np.clip(I + rng.normal(0, 0.010, I.shape).astype(np.float32), 0, 1.3)

    img = np.empty((N, N, 3), dtype=np.float32)
    for ch, table in enumerate((RAMP_R, RAMP_G, RAMP_B)):
        img[..., ch] = np.interp(I, RAMP_X, np.array(table, dtype=np.float32))

    # 裁正方形（按内容居中，留 6%）
    mask = (I > 0.10) | (shadow > 0.5)
    ys, xs = np.where(mask)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    half = int(max(x1 - x0, y1 - y0) * 0.53)
    mx, my = (x0 + x1) // 2, (y0 + y1) // 2
    canvas = Image.new("RGB", (N + half * 2, N + half * 2), (4, 4, 4))
    canvas.paste(Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB"), (half, half))
    box = (mx - half + half, my - half + half, mx + half + half, my + half + half)
    return canvas.crop(box).resize((SIZE, SIZE), Image.LANCZOS)


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
    for folder, px in [("mipmap-mdpi", 48), ("mipmap-hdpi", 72), ("mipmap-xhdpi", 96),
                       ("mipmap-xxhdpi", 144), ("mipmap-xxxhdpi", 192)]:
        target = os.path.join(android, folder)
        if os.path.isdir(target):
            icon.resize((px, px), Image.LANCZOS).save(os.path.join(target, "ic_launcher.png"))
            print("ANDROID ->", folder)


if __name__ == "__main__":
    main()
