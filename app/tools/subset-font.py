#!/usr/bin/env python3
"""生成随包分发的中文子集字体（Noto Sans SC，可变字重）。

为什么要自备字体
----------------
正文的中文原先回落到系统字体（Windows 雅黑，macOS 苹方）。雅黑只有
Regular / Bold 两档，所以 TextStyle 里写 w500 是死的（渲染结果和 w400
逐像素相同），写 w600 会直接跳到 Bold（墨量约 1.6 倍）。一屏之内拉丁
用 Inter 的 SemiBold、中文却是粗黑，字重就断档了 —— 中英混排看着不齐。

换成带 wght 轴的可变字体后，w400/500/600 对中文都连续可用，两个平台的
观感也一致，不再各自回落。

为什么是子集
------------
上游 NotoSansSC[wght].ttf 有 17MB。本 app 的 UI 文案 + bot 名字 + 用户
消息里出现的汉字，用 GB2312 全集（6763 字，覆盖现代中文 99.9% 以上）
兜住即可，加上 ASCII / 全角标点 / 拉丁扩展后是 7097 字符，压到约 3.6MB，
和 Inter 加起来仍远小于打包一个图片资源。

注意
----
· 子集**必须保留 fvar/gvar**（可变字重轴），不能加 --no-variations。
· 字体 wght 轴的默认值是 100，正文不显式写 fontWeight 就会变极细；
  接入时在 theme.dart 里显式给了 w400，别依赖默认值。
· 新增了生僻字（GB2312 之外）时，把它加进 EXTRA_CHARS 再重跑本脚本。

用法
----
    python tools/subset-font.py                # 从上游下载并生成
    python tools/subset-font.py --src X.ttf    # 用本地已下载的上游文件

依赖 fonttools：  pip install fonttools
"""

import argparse
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
OUT = os.path.join(APP, "assets", "fonts", "NotoSansSC.ttf")

UPSTREAM = (
    "https://raw.githubusercontent.com/google/fonts/main/ofl/"
    "notosanssc/NotoSansSC%5Bwght%5D.ttf"
)
LICENSE_URL = "https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/OFL.txt"
LICENSE_OUT = os.path.join(APP, "assets", "fonts", "NotoSansSC-OFL.txt")

# GB2312 之外的补充字符：界面里用到、但不在国标一二级字库里的
EXTRA_CHARS = "　、。〃々〈〉《》「」『』【】〔〕〖〗！？…–—‘’“”°′″※→←↑↓↔⇄●○◆◇■□▲△▼▽★☆✓✔✕✖✗✘♥♡"


def gb2312_chars():
    out = set()
    for hi in range(0xB0, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                out.add(bytes([hi, lo]).decode("gb2312"))
            except UnicodeDecodeError:
                pass
    return out


def wanted_chars(cmap):
    chars = set(gb2312_chars())
    chars.update(chr(c) for c in range(0x20, 0x7F))       # ASCII
    chars.update(chr(c) for c in range(0xC0, 0x180))      # 拉丁扩展（人名）
    chars.update(chr(c) for c in range(0xFF01, 0xFF5F))   # 全角
    chars.update(EXTRA_CHARS)
    present = {c for c in chars if ord(c) in cmap}
    missing = sorted(c for c in chars if ord(c) not in cmap)
    return present, missing


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", help="本地上游字体路径（默认自动下载）")
    args = ap.parse_args()

    try:
        from fontTools import subset
        from fontTools.ttLib import TTFont
    except ImportError:
        sys.exit("需要 fonttools：pip install fonttools")

    src = args.src
    if not src:
        src = os.path.join(HERE, ".NotoSansSC-src.ttf")
        if not os.path.exists(src):
            print(f"下载上游字体（约 17MB）… {UPSTREAM}")
            urllib.request.urlretrieve(UPSTREAM, src)
    print(f"上游字体：{src}  {os.path.getsize(src) / 1024 / 1024:.1f}MB")

    font = TTFont(src)
    if "fvar" not in font:
        sys.exit("上游文件不是可变字体（没有 fvar），字重会退化成两档")
    axes = {a.axisTag: (a.minValue, a.defaultValue, a.maxValue) for a in font["fvar"].axes}
    print(f"字重轴：{axes.get('wght')}")

    chars, missing = wanted_chars(font.getBestCmap())
    if missing:
        # 用码位打印：Windows 控制台是 GBK，直接打拉丁扩展会抛 UnicodeEncodeError
        codes = " ".join(f"U+{ord(c):04X}" for c in missing[:20])
        print(f"上游字体缺 {len(missing)} 个目标字符（跳过）：{codes}")

    text_file = os.path.join(HERE, ".subset-chars.txt")
    with open(text_file, "w", encoding="utf-8") as fh:
        fh.write("".join(sorted(chars)))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    subset.main([
        src,
        f"--text-file={text_file}",
        f"--output-file={OUT}",
        "--layout-features=*",   # 保留字距调整等排版特性
        "--glyph-names",
        "--drop-tables+=DSIG",
        "--no-hinting",          # 屏显渲染器不用 TrueType 提示
        "--name-IDs=*",
        "--recalc-bounds",
        "--recalc-average-width",
        # 不加 --no-variations：fvar/gvar 必须留着
    ])
    os.remove(text_file)

    result = TTFont(OUT)
    if "fvar" not in result or "gvar" not in result:
        sys.exit("子集产物丢了可变轴，检查是否误加了 --no-variations")
    used = len(result.getBestCmap())

    if not os.path.exists(LICENSE_OUT):
        print("下载 LICENSE…")
        urllib.request.urlretrieve(LICENSE_URL, LICENSE_OUT)

    print(f"完成：{OUT}")
    print(f"  {used} 个字符 · {os.path.getsize(OUT) / 1024 / 1024:.2f}MB · "
          f"wght 轴 {axes.get('wght')}")


if __name__ == "__main__":
    main()
