# 发布约定（版本号 / tag / 资产命名）

给 agent 看的：这一页是**硬规则**，不是风格偏好。每条都对应代码里的一个约束，
违反的后果写在「违反会怎样」里。

## 一句话

**版本号只有一个，纯 semver。平台只出现在资产文件名里，绝不出现在 tag 里。**

## 1. tag 必须是纯 semver `vX.Y.Z`

```
✅ v1.3.0
❌ v1.3.0-win.20261022
❌ v1.3.0-macos
```

**为什么**：`server/src/update-check.js` 按 semver 解析 tag，`-` 之后一律算**预发布**，
而预发布**小于**同版本正式版（`compareVersions` 里 `if (!pb.pre.length) return -1`）：

| 远端 tag | 当前版本 | 内置更新检查的结论 |
|---|---|---|
| `v1.2.1` | `1.2.0` | ✅ 提示更新 |
| `v1.2.0-win.20261022` | `1.2.0` | ❌ 「远端版本比当前旧」→ 不提示 |
| `v1.2.1-win.20261022` | `1.2.1` | ❌ 「远端版本比当前旧」→ 不提示 |

**违反会怎样**：这个版本对所有已装用户**永久不可见**，更新提示形同虚设。

> 历史遗留：`v1.2.0-macos.20261021` 就是这种 tag。不用回改 —— 它同时勾了
> Pre-release，而 `/releases/latest` 不返回预发布，所以它既拿不到更新、也不会污染别人。

## 2. 发布必须勾普通 Release，不能勾 Pre-release

更新检查走 GitHub 的 `/releases/latest`，该接口**不返回** Pre-release 和 Draft。

**违反会怎样**：勾错了 → 这个版本对所有用户不可见（和上一条同样的后果）。

## 3. 版本号唯一真源是 `server/package.json`

`app/pubspec.yaml` 的 `version:` 必须与它一致（`+N` 是构建号，只增不减）：

```
server/package.json    "version": "1.3.0"
app/pubspec.yaml       version: 1.3.0+3
```

读取方：`server/src/version.js`（`/health`、ws hello、serverInfo 都用它）、
`scripts/pack-windows.ps1`、`scripts/pack-macos.sh`（产物名取自它）。

**`server/tests/version.mjs` 会断言两者一致** —— 只 bump 一处，`node tests/all.mjs` 会红。

## 4. 资产命名：`pi-bot-<平台>-v<版本>.<扩展名>`

```
pi-bot-windows-v1.3.0.zip     ← Windows（.exe / .msi 也认）
pi-bot-macos-v1.3.0.dmg
pi-bot-android-v1.3.0.apk
```

平台词**两侧必须有分隔符**。`server/src/update-check.js` 的 `PLATFORM_RULES` 用的是
`[-_. ]win[-_. ]` 这种带边界的匹配 —— 因为无锚点的 `/win/` 会命中 `darwin`，
把 Mac 包推给 Windows 用户。

**不要把 `.zip` 当万能兜底**：zip 判不出平台，`pickAssetFor()` 返回 `null`，
App 只能退化成「打开发布页」。

## 5. 多平台可以增量挂到同一个 release

各平台构建时间不同，不必等齐：

```bash
gh release upload v1.3.0 dist/pi-bot-windows-v1.3.0.zip --clobber
```

找不到本平台资产的客户端会自动退到发布页（`UpdateInfo.canDownload == false`），
不会崩、也不会装错包。

## 发布清单

```bash
# 1. 在 main 上确认工作区干净、测试全绿
cd server && node tests/all.mjs
cd ../app && flutter analyze && flutter test

# 2. bump 版本（两处必须一致）
#    server/package.json  +  app/pubspec.yaml

# 3. 提交 + 打 tag + 推
git commit -am "chore(release): 1.3.0"
git tag v1.3.0
git push origin main v1.3.0

# 4. 各平台构建（从 tag 对应的提交构建，不要从半路的分支）
powershell -File scripts/pack-windows.ps1 -Zip   # dist/pi-bot-windows.zip
./scripts/pack-macos.sh                          # dist/pi-bot-<ver>.dmg
cd app && flutter build apk --release            # build/app/outputs/flutter-apk/app-release.apk

# 5. 建 release（★普通 Release，不要勾 Pre-release），资产重命名后上传
gh release create v1.3.0 --title "pi-bot v1.3.0" --notes-file <说明> \
  dist/pi-bot-windows-v1.3.0.zip
```

## 平台差异不要写进版本号

同一个版本号 = 同一份代码 = 同一套服务端。平台差异只体现在**构建产物**和
`docs/WINDOWS.md` / `docs/MACOS.md` 的验收记录里。

如果两个平台各自需要独立的版本号，说明**代码又分叉了** —— 那是
[平台边界与共享规则](PLATFORMS.md) 要解决的问题，不是靠 tag 后缀掩盖的。
