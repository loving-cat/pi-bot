#!/bin/bash
# 构建 macOS 桌面输入原生助手（零第三方依赖，只用系统 Swift 工具链）。
#
#   ./scripts/build-desktop-mac.sh            # 当前架构 + 能编的另一个架构（universal）
#   ./scripts/build-desktop-mac.sh --native   # 只编当前架构（快）
#
# 产物：
#   native/orbis-desktop-mac/build/orbis-desktop-mac         （开发用）
#   server/resources/orbis-desktop-mac                       （发行包用；pack-macos.sh 会带进 Orbis.app）
#
# 二进制不进 git：和 Windows 沙箱启动器一样，走构建脚本产出、随发版编译。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/native/orbis-desktop-mac/main.swift"
OUT_DIR="$ROOT/native/orbis-desktop-mac/build"
OUT="$OUT_DIR/orbis-desktop-mac"
RES_DIR="$ROOT/server/resources"
RES="$RES_DIR/orbis-desktop-mac"
MODE="${1:-universal}"

die() { echo "✗ $*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "这个脚本只能在 macOS 上跑（当前 $(uname -s)）"
[[ -f "$SRC" ]] || die "找不到源码：$SRC"
command -v swiftc >/dev/null 2>&1 || die "找不到 swiftc —— 装 Xcode 或 Command Line Tools"

mkdir -p "$OUT_DIR" "$RES_DIR"
chmod 700 "$OUT_DIR" 2>/dev/null || true

# 当前架构
HOST_ARCH="$(uname -m)"
case "$HOST_ARCH" in
  arm64) OTHER_ARCH="x86_64" ;;
  x86_64) OTHER_ARCH="arm64" ;;
  *) die "不认识的架构：$HOST_ARCH" ;;
esac

COMMON_FLAGS=(-O -whole-module-optimization -framework CoreGraphics -framework ApplicationServices -framework AppKit)

echo "== 编译（$MODE） =="
if [[ "$MODE" == "--native" ]]; then
  swiftc "${COMMON_FLAGS[@]}" -o "$OUT" "$SRC"
else
  TMP_HOST="$(mktemp -d /tmp/orbis-desktop-mac.XXXXXX)"
  trap 'rm -rf "$TMP_HOST"' EXIT
  # Apple Silicon 上编 x86_64 需要 SDK 支持；失败就退回单架构（如实说明，不静默）
  if swiftc "${COMMON_FLAGS[@]}" -target "${HOST_ARCH}-apple-macos12.0" -o "$TMP_HOST/host" "$SRC" 2>"$TMP_HOST/host.log" \
     && swiftc "${COMMON_FLAGS[@]}" -target "${OTHER_ARCH}-apple-macos12.0" -o "$TMP_HOST/other" "$SRC" 2>"$TMP_HOST/other.log"; then
    lipo -create -output "$OUT" "$TMP_HOST/host" "$TMP_HOST/other"
    echo "   universal（$HOST_ARCH + $OTHER_ARCH）"
  else
    echo "   ⚠ 另一个架构编不过（多半是缺 SDK），只出当前架构 $HOST_ARCH"
    sed -n "1,4p" "$TMP_HOST/other.log" || true
    swiftc "${COMMON_FLAGS[@]}" -o "$OUT" "$SRC"
  fi
fi

chmod 755 "$OUT"

echo "== 自检 =="
VERSION_JSON="$(echo '{}' | "$OUT" version)" || die "助手跑不起来"
echo "   version: $VERSION_JSON"
echo "$VERSION_JSON" | grep -q '"protocol":1' || die "协议版本不对：$VERSION_JSON"
echo "   arch: $(lipo -archs "$OUT" 2>/dev/null || echo "$HOST_ARCH")"
echo "   size: $(stat -f%z "$OUT") 字节"

echo "== 同步到发行目录 =="
cp -f "$OUT" "$RES"
chmod 755 "$RES"
echo "   $RES"

# 校验和（pack-macos.sh / prepare-macos-bundle 会核对）
HASH="$(shasum -a 256 "$OUT" | awk '{print $1}')"
printf "%s  orbis-desktop-mac\n" "$HASH" > "$OUT_DIR/orbis-desktop-mac.sha256"
printf "%s  orbis-desktop-mac\n" "$HASH" > "$RES_DIR/orbis-desktop-mac.sha256"
echo "   sha256: ${HASH:0:16}…"

echo ""
echo "完成："
echo "  $OUT"
echo "  $RES"
echo ""
echo "下一步（真机验收需要辅助功能授权）："
echo "  系统设置 → 隐私与安全性 → 辅助功能 → 加上运行它的宿主（终端 / Orbis.app）"
