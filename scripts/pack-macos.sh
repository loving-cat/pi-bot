#!/usr/bin/env bash
# 打包 macOS（.app → .dmg）。只能在 macOS 上跑。
#
#   ./scripts/pack-macos.sh                 # dist/pi-bot.app + dist/pi-bot-<ver>.dmg
#   ./scripts/pack-macos.sh --no-build      # 复用已有 build/macos 产物
#
# 依赖：Xcode command line tools、Flutter（macOS desktop 已启用）、node（用来装服务端依赖）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="pi-bot"
BUILD="$ROOT/app/build/macos/Build/Products/Release"
OUT="$ROOT/dist"
APP="$OUT/${APP_NAME}.app"
SKIP_BUILD=0
[[ "${1:-}" == "--no-build" ]] && SKIP_BUILD=1

if [[ $SKIP_BUILD -eq 0 ]]; then
  echo "== flutter build macos --release =="
  ( cd "$ROOT/app" && flutter build macos --release )
fi

if [[ ! -d "$BUILD/${APP_NAME}.app" ]]; then
  echo "找不到构建产物：$BUILD/${APP_NAME}.app" >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$BUILD/${APP_NAME}.app" "$APP"

# 服务端放在 .app 的 Resources 里；launcher 会先在"可执行文件同级"找 server/
SERVER_DST="$APP/Contents/Resources/server"
mkdir -p "$SERVER_DST"
cp -R "$ROOT/server/src" "$ROOT/server/tools" "$SERVER_DST/"
cp "$ROOT/server/package.json" "$ROOT/server/package-lock.json" "$SERVER_DST/" 2>/dev/null || true
cp "$ROOT/server/.env.example" "$SERVER_DST/" 2>/dev/null || true

# 依赖装进包里（目标机器不需要 npm）
echo "== 安装服务端依赖 =="
( cd "$SERVER_DST" && npm install --omit=dev --no-audit --no-fund )

# node 不在包里：macOS 用户需要自己装 Node 22+（launcher 会去 PATH 里找）
VERSION="$(node -p "require('$ROOT/server/package.json').version" 2>/dev/null || echo 0.0.0)"
DMG="$OUT/${APP_NAME}-${VERSION}.dmg"
rm -f "$DMG"
hdiutil create -volname "$APP_NAME" -srcfolder "$APP" -ov -format UDZO "$DMG" >/dev/null

echo "完成：$APP"
echo "      $DMG"
echo
echo "首次打开若被 Gatekeeper 拦：右键 → 打开，或"
echo "  xattr -dr com.apple.quarantine \"$APP\""
