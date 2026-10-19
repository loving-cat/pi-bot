#!/usr/bin/env bash
# 构建、组装并校验 macOS App 与 DMG；成功后替换 dist 下的同名产物。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="pi-bot"
BUILD="$ROOT/app/build/macos/Build/Products/Release"
OUT="$ROOT/dist"
APP="$OUT/${APP_NAME}.app"
ENTITLEMENTS="$ROOT/app/macos/Runner/Release.entitlements"
SKIP_BUILD=0
CLEAR_QUARANTINE=0

usage() {
  cat <<'USAGE'
用法：./scripts/pack-macos.sh [--no-build] [--clear-quarantine] [--help]

  --no-build          复用已有 macOS Release App，不检查 Xcode 或调用 Flutter
  --clear-quarantine  清除本轮 App 与 DMG 的隔离属性，默认关闭
  --help              显示帮助

产物：dist/pi-bot.app、dist/pi-bot-<服务端版本>.dmg
构建需要完整 Xcode、Flutter macOS desktop；打包需要 Node 22+ 与 npm。
App 使用本机 ad-hoc 签名；目标机器仍需安装 Node 22+。
USAGE
}

fail() {
  echo "错误：$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "缺少命令：$1"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build) SKIP_BUILD=1 ;;
    --clear-quarantine) CLEAR_QUARANTINE=1 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; fail "未知参数：$1" ;;
  esac
  shift
done

[[ "$(uname -s)" == Darwin ]] || fail "此脚本只能在 macOS 上运行"
for tool in node npm ditto codesign hdiutil; do
  require_command "$tool"
done
if [[ $CLEAR_QUARANTINE -eq 1 ]]; then
  require_command xattr
fi
node -e 'const major = Number(process.versions.node.split(".")[0]); process.exit(major >= 22 ? 0 : 1)' \
  || fail "需要 Node 22+，当前为 $(node --version)"

for item in src tools package.json .env.example; do
  [[ -e "$ROOT/server/$item" ]] || fail "缺少服务端文件：server/$item"
done
[[ -f "$ROOT/server/src/index.js" ]] || fail "缺少服务端入口：server/src/index.js"
[[ -f "$ENTITLEMENTS" ]] || fail "缺少 macOS Runner 的 Release.entitlements"
VERSION="$(node -e 'const fs = require("node:fs"); const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (typeof p.version !== "string") process.exit(1); process.stdout.write(p.version)' "$ROOT/server/package.json")"
[[ "$VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]*$ ]] || fail "服务端版本不能用作产物文件名：$VERSION"
DMG="$OUT/${APP_NAME}-${VERSION}.dmg"

if [[ $SKIP_BUILD -eq 0 ]]; then
  for tool in flutter xcodebuild xcrun; do
    require_command "$tool"
  done
  xcodebuild -version >/dev/null 2>&1 \
    || fail "构建需要完整 Xcode；请安装并在 xcode-select 中选择其 Developer 目录"
  xcodebuild -checkFirstLaunchStatus >/dev/null 2>&1 \
    || fail "Xcode 初始化未完成，请启动 Xcode 并完成许可与组件安装"
  xcrun --sdk macosx --show-sdk-path >/dev/null 2>&1 \
    || fail "找不到 macOS SDK，请检查 Xcode 安装与首次启动设置"
  echo "== flutter build macos --release =="
  (cd "$ROOT/app" && flutter build macos --release)
fi

SOURCE_APP="$BUILD/${APP_NAME}.app"
if [[ ! -d "$SOURCE_APP" && -d "$BUILD/pi_bot.app" ]]; then
  SOURCE_APP="$BUILD/pi_bot.app"
fi
[[ -d "$SOURCE_APP" ]] || fail "找不到构建产物：$BUILD/${APP_NAME}.app（或 pi_bot.app）"
[[ -f "$SOURCE_APP/Contents/Info.plist" && -d "$SOURCE_APP/Contents/MacOS" ]] \
  || fail "构建产物不是完整的 macOS App：$SOURCE_APP"

mkdir -p "$OUT"
STAGE="$(mktemp -d "$OUT/.pack-macos.XXXXXX")"
PUBLISHING=0
PUBLISHED=0
APP_INSTALLING=0
DMG_INSTALLING=0

# 发布失败时恢复旧成品；只清理本轮创建的暂存目录与目标文件。
cleanup() {
  local result=$?
  local restore_failed=0
  trap - EXIT HUP INT TERM
  set +e
  if [[ $PUBLISHING -eq 1 && $PUBLISHED -eq 0 ]]; then
    if [[ $APP_INSTALLING -eq 1 ]]; then rm -rf -- "$APP" || restore_failed=1; fi
    if [[ $DMG_INSTALLING -eq 1 ]]; then rm -f -- "$DMG" || restore_failed=1; fi
    if [[ -e "$STAGE/previous.app" || -L "$STAGE/previous.app" ]]; then
      if [[ ! -e "$APP" && ! -L "$APP" ]]; then
        mv "$STAGE/previous.app" "$APP" || restore_failed=1
      else
        restore_failed=1
      fi
    fi
    if [[ -e "$STAGE/previous.dmg" || -L "$STAGE/previous.dmg" ]]; then
      if [[ ! -e "$DMG" && ! -L "$DMG" ]]; then
        mv "$STAGE/previous.dmg" "$DMG" || restore_failed=1
      else
        restore_failed=1
      fi
    fi
  fi
  if [[ $restore_failed -eq 0 ]]; then
    rm -rf -- "$STAGE"
  else
    echo "恢复旧成品失败，备份保留在：$STAGE" >&2
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

PAYLOAD="$STAGE/payload"
STAGED_APP="$PAYLOAD/${APP_NAME}.app"
STAGED_DMG="$STAGE/${APP_NAME}-${VERSION}.dmg"
mkdir -p "$PAYLOAD"
ditto "$SOURCE_APP" "$STAGED_APP"
SERVER_DST="$STAGED_APP/Contents/Resources/server"
mkdir -p "$SERVER_DST"
for item in src tools package.json .env.example; do
  ditto "$ROOT/server/$item" "$SERVER_DST/$item"
done
if [[ -f "$ROOT/server/package-lock.json" ]]; then
  ditto "$ROOT/server/package-lock.json" "$SERVER_DST/package-lock.json"
fi

echo "== 安装服务端依赖 =="
(cd "$SERVER_DST" && npm install --omit=dev --no-audit --no-fund)
(cd "$SERVER_DST" && node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const { dependencies = {} } = JSON.parse(readFileSync("package.json", "utf8"));
  for (const name of Object.keys(dependencies)) import.meta.resolve(name);
')

echo "== 签名并校验 App =="
codesign --force --deep --sign - --entitlements "$ENTITLEMENTS" "$STAGED_APP"
codesign --verify --deep --strict "$STAGED_APP"
if [[ $CLEAR_QUARANTINE -eq 1 ]]; then
  xattr -dr com.apple.quarantine "$STAGED_APP"
fi
ln -s /Applications "$PAYLOAD/Applications"
hdiutil create -volname "$APP_NAME" -srcfolder "$PAYLOAD" -format UDZO "$STAGED_DMG" >/dev/null
hdiutil verify "$STAGED_DMG" >/dev/null
if [[ $CLEAR_QUARANTINE -eq 1 ]]; then
  xattr -dr com.apple.quarantine "$STAGED_DMG"
fi

PUBLISHING=1
if [[ -e "$APP" || -L "$APP" ]]; then mv "$APP" "$STAGE/previous.app"; fi
if [[ -e "$DMG" || -L "$DMG" ]]; then mv "$DMG" "$STAGE/previous.dmg"; fi
APP_INSTALLING=1
mv "$STAGED_APP" "$APP"
DMG_INSTALLING=1
mv "$STAGED_DMG" "$DMG"
PUBLISHED=1

echo "完成：$APP"
echo "      $DMG"
echo "签名：ad-hoc（未公证）；运行环境：目标机器需要 Node 22+"
