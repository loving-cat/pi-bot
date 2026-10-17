#!/usr/bin/env python3
"""生成 pi-bot 的应用图标：黑洞 + 美漫风格（原创绘制，不用任何影视素材）。

构图参考"黑洞"这个公开的物理意象：黑色事件视界 + 环绕的吸积盘 + 被引力透镜
弯到上下两侧的光弧。表现手法是美漫的：硬边色块（cel shading）、粗黑描边、
网点过渡、边缘速度线。

用法：
    python app/tool/make_icon.py            # 生成 1024 PNG + Windows ico + Android mipmap
    python app/tool/make_icon.py --preview  # 只生成 PNG，方便看效果

输出：
    app/assets/icon/app-icon-1024.png
    app/windows/runner/resources/app_icon.ico
    app/android/app/src/main/res/mipmap-*/ic_launcher.png
"""
from __future__ import annotations

import argparse
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# 尺寸：先按 2 倍渲染再缩小 —— 描边和网点在高倍下画，缩小后才不糊
SIZE = 1024
SS = 2
N = SIZE * SS

# 配色：深空底 + 吸积盘的白热→金→橙→暗红；美漫喜欢高对比
BG_IN = (7, 10, 18)
BG_OUT = (2, 3, 6)
DISK_BANDS = [
    (255, 253, 244),  # 白热
    (255, 238, 190),  # 浅金
    (255, 202, 110),  # 金
    (255, 158, 62),   # 橙
    (222, 100, 36),   # 深橙
    (150, 52, 24),    # 暗红（只在最外缘）
]
OUTLINE = (6, 7, 10)
ACCENT = (120, 180, 255)  # 一点点冷色点缀（星芒）


def _grid():
    y, x = np.mgrid[0:N, 0:N].astype(np.float32)
    cx = cy = N / 2.0
    return x - cx, y - cy


def _bg(dx, dy):
    r = np.sqrt(dx * dx + dy * dy) / (N * 0.72)
    r = np.clip(r, 0, 1)[..., None]
    inner = np.array(BG_IN, dtype=np.float32)
    outer = np.array(BG_OUT, dtype=np.float32)
    img = inner * (1 - r) + outer * r

    rng = np.random.default_rng(7)
    stars = rng.random((N, N)).astype(np.float32)
    mask = stars > 0.99965
    img[mask] = (210, 226, 255)
    return img


def _ring_mask(dx, dy, *, tilt_deg, rx_in, rx_out, ry_ratio_in=None, ry_ratio_out=None):
    """椭圆环遮罩，并给出"从内缘到外缘"的归一化位置 t（0=内缘，1=外缘）。

    用归一化椭圆坐标算：把点除以各自半径后，它到中心的距离就能直接当作
    环内位置 —— 比联立两个椭圆方程稳定得多。
    """
    t = math.radians(tilt_deg)
    cos_t, sin_t = math.cos(t), math.sin(t)
    xr = dx * cos_t + dy * sin_t
    yr = -dx * sin_t + dy * cos_t

    ry_in = rx_in * (ry_ratio_in if ry_ratio_in is not None else 0.22)
    ry_out = rx_out * (ry_ratio_out if ry_ratio_out is not None else 0.22)

    # 外椭圆归一化坐标（0..1 表示到外缘的比例）
    uo = xr / rx_out
    vo = yr / ry_out
    d_out = np.sqrt(uo * uo + vo * vo)

    # 内椭圆在外椭圆坐标里的"半径"
    d_in = min(rx_in / rx_out, ry_in / ry_out)

    mask = (d_out <= 1.0) & (d_out >= d_in)
    span = max(1e-4, 1.0 - d_in)
    pos = np.clip((d_out - d_in) / span, 0, 1)  # 0=内缘 1=外缘
    return mask, pos


def _posterize_bands(band):
    """把连续亮度切成有限档 —— 美漫的硬边色块"""
    idx = np.clip((band * len(DISK_BANDS) * 1.15).astype(np.int32), 0, len(DISK_BANDS) - 1)
    return idx


def _halftone(lum, cell=9, strength=0.55):
    """网点：亮度越低的地方点越小，模拟漫画印刷"""
    yy, xx = np.mgrid[0:N, 0:N]
    cx = xx % cell
    cy = yy % cell
    d = np.sqrt((cx - cell / 2) ** 2 + (cy - cell / 2) ** 2) / (cell / 2)
    radius = np.clip(lum * 1.35, 0, 1)
    dots = (d < radius).astype(np.float32)
    return dots * strength


def _outline(mask, width):
    """从遮罩生成粗描边（膨胀 - 原图）"""
    m = Image.fromarray((mask * 255).astype(np.uint8), "L")
    grown = m.filter(ImageFilter.MaxFilter(width * 2 + 1))
    edge = np.asarray(grown, dtype=np.float32) / 255.0 - mask
    return np.clip(edge, 0, 1)


def _speed_lines(img, dx, dy, count=26, inner=0.60, outer=1.02):
    """边缘速度线：从外侧射进来的短线，漫画里表示冲击/能量"""
    d = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB")
    draw = ImageDraw.Draw(d, "RGBA")
    rng = np.random.default_rng(11)
    cx = cy = N / 2
    for i in range(count):
        a = (i / count) * math.tau + rng.normal(0, 0.03)
        r0 = N * (inner + rng.random() * 0.03)
        r1 = N * (outer - rng.random() * 0.01)
        x0, y0 = cx + math.cos(a) * r0, cy + math.sin(a) * r0
        x1, y1 = cx + math.cos(a) * r1, cy + math.sin(a) * r1
        alpha = int(30 + rng.random() * 40)
        draw.line([(x0, y0), (x1, y1)], fill=(255, 236, 200, alpha), width=max(2, int(SS * 1.2)))
    return np.asarray(d, dtype=np.float32)


def _paint(img, mask, heat, alpha=1.0):
    """把盘/弧的颜色按色块贴上去；alpha 可以是标量，也可以是逐像素数组（端部渐隐）"""
    idx = _posterize_bands(np.clip(heat, 0, 1))
    rgb = np.array(DISK_BANDS, dtype=np.float32)[idx]
    if isinstance(alpha, np.ndarray):
        a = np.clip(alpha, 0, 1)[..., None]
        img[mask] = img[mask] * (1 - a[mask]) + rgb[mask] * a[mask]
        return
    a = float(alpha)
    if a >= 1.0:
        img[mask] = rgb[mask]
    else:
        img[mask] = img[mask] * (1 - a) + rgb[mask] * a


def render():
    dx, dy = _grid()
    img = _bg(dx, dy)

    hole_r = N * 0.17
    r = np.sqrt(dx * dx + dy * dy)

    # ---- 吸积盘：很扁的斜椭圆环（edge-on）----
    disk_mask, disk_pos = _ring_mask(
        dx, dy, tilt_deg=-8, rx_in=hole_r * 1.30, rx_out=N * 0.48, ry_ratio_in=0.125, ry_ratio_out=0.125
    )
    heat = np.clip(1.0 - disk_pos, 0, 1) ** 0.42          # 内白外橙
    heat = np.clip(heat * (1.0 + 0.20 * np.clip(dy / (N * 0.30), -1, 1)), 0, 1)

    # ---- 引力透镜：上下两段弧，贴着视界，端部渐隐（不硬切）----
    lens_mask, lens_pos = _ring_mask(
        dx, dy, tilt_deg=0, rx_in=hole_r * 1.05, rx_out=hole_r * 1.48, ry_ratio_in=1.12, ry_ratio_out=1.12
    )
    v = np.abs(dy) / max(1e-6, hole_r)
    weight = np.clip((v - 0.42) / 0.42, 0, 1)              # 端部 0→1 渐显
    lens_mask = lens_mask & (weight > 0.02)
    lheat = np.clip(1.0 - lens_pos, 0, 1) ** 0.45

    # ---- 外发光（让盘看起来在发光）----
    glow = np.zeros((N, N), dtype=np.float32)
    glow[disk_mask] = 0.55
    glow[lens_mask] = 0.40
    glow_img = Image.fromarray((glow * 255).astype(np.uint8), "L").filter(
        ImageFilter.GaussianBlur(int(24 * SS))
    )
    g = np.asarray(glow_img, dtype=np.float32)[..., None] / 255.0
    img = img * (1 - g * 0.5) + np.array((255, 150, 70), dtype=np.float32) * g * 0.5

    # ---- 先画"背面那半"：盘的上半 + 透镜弧 ----
    _paint(img, lens_mask, lheat, np.clip(weight * 1.8, 0, 1))
    _paint(img, disk_mask & (dy <= 0), heat)

    # ---- 事件视界：纯黑 + 光子环 ----
    horizon = r <= hole_r
    img[horizon] = (0, 0, 0)
    rim = (r > hole_r) & (r <= hole_r * 1.018)
    img[rim] = (255, 252, 240)
    rim2 = (r > hole_r * 1.018) & (r <= hole_r * 1.050)
    img[rim2] = (255, 190, 104)

    # ---- 再画"前面那半"：盘的下半从黑洞前面穿过（真实感/辨识度都靠它）----
    near = disk_mask & (dy > 0)
    _paint(img, near, np.clip(heat * 1.08, 0, 1))

    # ---- 网点：只压在盘和弧上 ----
    lum = np.clip(img.max(axis=2) / 255.0, 0, 1)
    dots_src = np.where(disk_mask | lens_mask, lum, 0).astype(np.float32)
    dots = _halftone(dots_src, cell=max(4, int(6 * SS)), strength=0.45)
    img = img * (1 - dots[..., None] * 0.45) + np.array((18, 10, 6), dtype=np.float32) * dots[..., None] * 0.45

    # ---- 粗黑描边：盘的外沿 + 视界（视界里不画，避免黑球上一道划痕）----
    outer_edge = _outline(disk_mask.astype(np.float32), max(1, int(1.2 * SS)))
    horizon_edge = _outline(horizon.astype(np.float32), max(1, int(1.4 * SS)))
    edge = np.clip(outer_edge + horizon_edge, 0, 1) * (~horizon)
    edge = edge[..., None]
    img = img * (1 - edge) + np.array(OUTLINE, dtype=np.float32) * edge

    out = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB")

    # ---- 收紧构图：按内容外框裁掉多余留白（小尺寸下图标才够大）----
    mask = (disk_mask | lens_mask | horizon)
    ys, xs = np.where(mask)
    if len(xs) and len(ys):
        w = xs.max() - xs.min()
        h = ys.max() - ys.min()
        pad = int(max(w, h) * 0.10)
        cx = (xs.min() + xs.max()) // 2
        cy = (ys.min() + ys.max()) // 2
        half = max(w, h) // 2 + pad
        # 先扩一圈背景再裁，避免裁到画布外变成黑边
        margin = int(N * 0.15)
        canvas = Image.new("RGB", (N + margin * 2, N + margin * 2), BG_OUT)
        canvas.paste(out, (margin, margin))
        box = (
            cx - half + margin,
            cy - half + margin,
            cx + half + margin,
            cy + half + margin,
        )
        out = canvas.crop(box)

    return out.resize((SIZE, SIZE), Image.LANCZOS)


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

    # Windows .ico（多尺寸，资源管理器/任务栏/标题栏各取所需）
    ico = os.path.join(root, "windows", "runner", "resources", "app_icon.ico")
    icon.save(ico, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("ICO ->", ico)

    # Android mipmap
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
