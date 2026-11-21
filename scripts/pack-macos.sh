#!/usr/bin/env bash
# 构建、组装并校验 macOS App 与 DMG；成功后替换 dist 下的同名产物。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Orbis"
# 产物名用小写前缀（与 orbis-windows-* / orbis-android-* 保持一致）
ARTIFACT_PREFIX="orbis"
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

产物：dist/Orbis.app、dist/orbis-macos-v<服务端版本>.dmg
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
# ★ Apple 的 CFBundleShortVersionString 只接受**纯数字 X.Y.Z**（三段）。
#   2.0.0-alpha.1 直接写进 Info.plist，在公证 / App Store 链路上会被拒，
#   系统版本比较也容易把它当成非法值。所以：
#     · 产物名与界面展示用完整版本（含 -alpha.1，界面读的是服务端 version）；
#     · Info.plist 用去掉预发布段的数字版 + pubspec 里的 build number。
APPLE_VERSION="${VERSION%%-*}"
APPLE_VERSION="${APPLE_VERSION%%+*}"
[[ "$APPLE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || fail "无法从 $VERSION 推出纯数字的 macOS 版本号（CFBundleShortVersionString 需要 X.Y.Z）"
APPLE_BUILD="$(node -e 'const fs = require("node:fs"); const m = fs.readFileSync(process.argv[1], "utf8").match(/^version:[^\n]*?\+(\d+)\s*$/m); process.stdout.write(m ? m[1] : "1")' "$ROOT/app/pubspec.yaml")"
[[ "$APPLE_BUILD" =~ ^[0-9]+$ ]] || APPLE_BUILD=1
DMG="$OUT/${ARTIFACT_PREFIX}-macos-v${VERSION}.dmg"
STAGE=''
BUILD_WORK=''
BUILD_COPY=''
BUILD_REPLACING=0
BUILD_INSTALLING=0
BUILD_PUBLISHED=0
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
  if [[ $BUILD_REPLACING -eq 1 && $BUILD_PUBLISHED -eq 0 ]]; then
    if [[ $BUILD_INSTALLING -eq 1 ]]; then rm -rf -- "$BUILD/${APP_NAME}.app" || restore_failed=1; fi
    if [[ -e "$BUILD_COPY/previous.app" || -L "$BUILD_COPY/previous.app" ]]; then
      mv "$BUILD_COPY/previous.app" "$BUILD/${APP_NAME}.app" || restore_failed=1
    fi
  fi
  if [[ $restore_failed -eq 0 ]]; then
    [[ -z "$STAGE" ]] || rm -rf -- "$STAGE"
    [[ -z "$BUILD_COPY" ]] || rm -rf -- "$BUILD_COPY"
    [[ -z "$BUILD_WORK" ]] || rm -rf -- "$BUILD_WORK"
  else
    echo "恢复旧成品失败，备份保留在：$STAGE $BUILD_COPY $BUILD_WORK" >&2
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ $SKIP_BUILD -eq 0 ]]; then
  [[ -f "$ROOT/app/pubspec.lock" ]] || fail "缺少 app/pubspec.lock，不能进行锁定构建"
  for tool in flutter xcodebuild xcrun; do
    require_command "$tool"
  done
  xcodebuild -version >/dev/null 2>&1 \
    || fail "构建需要完整 Xcode；请安装并在 xcode-select 中选择其 Developer 目录"
  xcodebuild -checkFirstLaunchStatus >/dev/null 2>&1 \
    || fail "Xcode 初始化未完成，请启动 Xcode 并完成许可与组件安装"
  xcrun --sdk macosx --show-sdk-path >/dev/null 2>&1 \
    || fail "找不到 macOS SDK，请检查 Xcode 安装与首次启动设置"
  BUILD_WORK="$(mktemp -d /tmp/orbis-macos-build.XXXXXX)"
  node "$ROOT/scripts/stage-macos-build.mjs" "$ROOT/app" "$BUILD_WORK/app"
  echo "== flutter pub get --enforce-lockfile =="
  (cd "$BUILD_WORK/app" && PUB_HOSTED_URL=https://pub.dev flutter pub get --enforce-lockfile --no-example)
  cmp -s "$ROOT/app/pubspec.lock" "$BUILD_WORK/app/pubspec.lock" \
    || fail "依赖解析改动了 pubspec.lock，已停止打包"
  echo "== flutter build macos --release =="
  # --build-name 必须是纯数字（理由见上方 APPLE_VERSION）：完整版本 2.0.0-alpha.1
  # 仍留在 server/package.json，界面显示的也是服务端版本，不受影响。
  (cd "$BUILD_WORK/app" && PUB_HOSTED_URL=https://pub.dev flutter build macos --release --no-pub --build-name="$APPLE_VERSION" --build-number="$APPLE_BUILD" --split-debug-info="$BUILD_WORK/debug-info")
  cmp -s "$ROOT/app/pubspec.lock" "$BUILD_WORK/app/pubspec.lock" \
    || fail "构建改动了 pubspec.lock，已停止打包"
  NEUTRAL_APP="$BUILD_WORK/app/build/macos/Build/Products/Release/${APP_NAME}.app"
  if [[ ! -d "$NEUTRAL_APP" && -d "$BUILD_WORK/app/build/macos/Build/Products/Release/pi_bot.app" ]]; then
    NEUTRAL_APP="$BUILD_WORK/app/build/macos/Build/Products/Release/pi_bot.app"
  fi
  [[ -f "$NEUTRAL_APP/Contents/Info.plist" && -d "$NEUTRAL_APP/Contents/MacOS" ]] \
    || fail "中性目录构建没有生成完整 App"
  mkdir -p "$BUILD"
  BUILD_COPY="$(mktemp -d "$BUILD/.pack-build.XXXXXX")"
  ditto "$NEUTRAL_APP" "$BUILD_COPY/next.app"
  BUILD_REPLACING=1
  if [[ -e "$BUILD/${APP_NAME}.app" || -L "$BUILD/${APP_NAME}.app" ]]; then
    mv "$BUILD/${APP_NAME}.app" "$BUILD_COPY/previous.app"
  fi
  BUILD_INSTALLING=1
  mv "$BUILD_COPY/next.app" "$BUILD/${APP_NAME}.app"
  BUILD_PUBLISHED=1
  if [[ -d "$BUILD_WORK/debug-info" ]]; then
    mkdir -p "$ROOT/app/build/debug-info/macos"
    ditto "$BUILD_WORK/debug-info" "$ROOT/app/build/debug-info/macos"
  fi
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
PAYLOAD="$STAGE/payload"
STAGED_APP="$PAYLOAD/${APP_NAME}.app"
# 暂存名直接取最终 DMG 的文件名：以前这里写 ${APP_NAME}（大写 Orbis），而最终名用
# ARTIFACT_PREFIX（小写 orbis），两个名字不一致，测试里按最终名断言就对不上。
STAGED_DMG="$STAGE/$(basename "$DMG")"
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

# 桌面输入原生助手（macOS）。事先构建好再打包：
#   ./scripts/build-desktop-mac.sh
# 缺它的话 App 能起来，但 desktop_input 会一路返回 not_platform ——
# 发版包里少一个能力却没人发现，比构建失败更糟，所以这里直接挡。
DESKTOP_HELPER="$ROOT/server/resources/orbis-desktop-mac"
[[ -f "$DESKTOP_HELPER" ]] || fail "缺少桌面输入助手：${DESKTOP_HELPER} —— 先跑 ./scripts/build-desktop-mac.sh"
DESKTOP_RES="$SERVER_DST/resources"
mkdir -p "$DESKTOP_RES"
ditto "$DESKTOP_HELPER" "$DESKTOP_RES/orbis-desktop-mac"
chmod 755 "$DESKTOP_RES/orbis-desktop-mac"
if [[ -f "$ROOT/server/resources/orbis-desktop-mac.sha256" ]]; then
  ditto "$ROOT/server/resources/orbis-desktop-mac.sha256" "$DESKTOP_RES/orbis-desktop-mac.sha256"
fi

echo "== 安装服务端依赖 =="
(cd "$SERVER_DST" && npm install --omit=dev --no-audit --no-fund)
(cd "$SERVER_DST" && node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const { dependencies = {} } = JSON.parse(readFileSync("package.json", "utf8"));
  for (const name of Object.keys(dependencies)) import.meta.resolve(name);
')

echo "== 签名并校验 App =="
node "$ROOT/scripts/prepare-macos-bundle.mjs" "$STAGED_APP"
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
