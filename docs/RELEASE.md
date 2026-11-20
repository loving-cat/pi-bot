# 发布约定（版本号 / tag / 资产命名）

给 agent 看的：这一页是**硬规则**，不是风格偏好。每条都对应代码里的一个约束，
违反的后果写在「违反会怎样」里。

## 0. 版本线（2026-11-19 起）

| 版本 | 定位 | 里面有什么 |
|---|---|---|
| **1.7.x** | **品牌过渡版** | 展示层全面换成 Orbis（`orbis.exe`、`orbis-*` 资产、安装器 Orbis、
|  |  | 窗口/UI 文案）；系统身份与协议头**保留旧值兼容**，见下面的 `@remove-2.0` |
| **1.7.1** | **弃用告警版**（已发布 2026-11-20） | 过渡版收官：命中旧 env（`PI_BOT_*`）/ 旧数据目录 / 旧请求头时打**去重告警**，
|  |  | 旧头请求回 `x-orbis-deprecated`；**App 改发 `x-orbis-*`**（1.7.0 服务端本就双读，向前兼容） |
| **2.0.0** | **收尾版** | 把 `@remove-2.0` 标记的兼容层一次性删掉：旧数据目录回退、
|  |  | `PI_BOT_*` 环境变量、`x-pi-bot-*` 请求头 |

> 2.0 的**阶段划分、三条主线（清债 / 基座化 / SIM-Lite 自进化）、验收门禁与新版本线**
> 见 [`docs/ROADMAP-2.0.md`](ROADMAP-2.0.md)。本页只定「版本号与资产命名」的硬规则。

**2.0 之前不要删兼容层** —— 1.7 发布时所有已装用户的数据目录还叫 `pi-bot`，
删了等于让他们的聊天记录“消失”（文件还在，但程序不看了）。

**升级路径**：`1.7.0 → 1.7.1 → 2.0.0`。跳版直接上 2.0 会出现「1.7.0 客户端还在发旧头 →
首个请求 403」，1.7.1 就是为了提前把这一步走完（App 先改发 `x-orbis-*`）。

清理时一条命令列出全部待删点：

```bash
grep -rn "@remove-2.0" server/src app/lib
```

哪些**永远不删**（系统身份，改了就是换新应用）：

| 标识 | 值 | 为什么不动 |
|---|---|---|
| Android `APP_ID` | `com.pibot.pi_bot` | 改了手机装不上更新，必须卸载重装（聊天数据在应用私有目录） |
| macOS `PRODUCT_BUNDLE_IDENTIFIER` | `io.pibot.piBot` | 改了等于新应用：权限、钥匙串、偏好全部重来 |
| Inno `AppId` GUID | `{7A31C4E8-...}` | 升级替换旧安装靠它；改了会并列装两份 |

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

## 4. 资产命名：`orbis-<平台>-v<版本>.<扩展名>`

```
orbis-windows-v1.3.0-setup.exe   ← Windows 一键安装（推荐给普通用户）
orbis-windows-v1.3.0.zip         ← Windows 免安装（要解压自己运行）
orbis-macos-v1.3.0.dmg
orbis-android-v1.3.0.apk
```

平台词**两侧必须有分隔符**。`server/src/update-check.js` 的 `PLATFORM_RULES` 用的是
`[-_. ]win[-_. ]` 这种带边界的匹配 —— 因为无锚点的 `/win/` 会命中 `darwin`，
把 Mac 包推给 Windows 用户。

**不要把 `.zip` 当万能兜底**：zip 判不出平台，`pickAssetFor()` 返回 `null`，
App 只能退化成「打开发布页」。

**同时挂 setup.exe 和 zip 时**：`PLATFORM_RULES` 里 `.exe` 排在平台词之前，
`pickAssetFor()` 按规则序号取最优，所以选中的一定是安装包，跟上传顺序无关。
这条有回归测试（`server/tests/update-check.mjs` 里的「同时挂安装包和免安装 zip」）。

## 5. 多平台可以增量挂到同一个 release

各平台构建时间不同，不必等齐：

```bash
gh release upload v1.3.0 dist/orbis-windows-v1.3.0.zip --clobber
```

找不到本平台资产的客户端会自动退到发布页（`UpdateInfo.canDownload == false`），
不会崩、也不会装错包。

## 6. 提交身份只用 noreply 邮箱

仓库是公开的，**每个提交的作者 / 提交者邮箱任何人都能看到**，而且进了历史就删不掉。

```bash
# 每台开发机、每个 agent 环境都要设（地址在 GitHub 设置 → Emails 里看）
git config --global user.email "<id>+<账号>@users.noreply.github.com"
```

**违反会怎样**：macOS 没配邮箱时 git 会自动用 `用户名@主机名.local`，把本机主机名公开；
用 QQ 邮箱等于公开 QQ 号。两种都发生过（2026-10），只能改写整个历史、强推全部分支和 tag 来清。

CI 的 secret scan 会拦：PR 扫 PR 里的提交（`--meta`），直接 push 到 main 扫新推的提交（`--push`）。
但 CI 是在**推上去之后**才跑的 —— 拦下来时地址已经公开了，所以提交前自己先跑一遍：

```bash
node scripts/check-secrets.mjs --push origin/main HEAD
```

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
powershell -File scripts/pack-windows.ps1 -WithNode -Zip   # dist/orbis-windows{,.zip}
powershell -File scripts/pack-windows-setup.ps1            # dist/orbis-windows-v1.3.0-setup.exe
./scripts/pack-macos.sh                                    # dist/orbis-<ver>.dmg
node scripts/pack-android.mjs                              # dist/orbis-android-v<版本>.apk

# 5. 建 release（★普通 Release，不要勾 Pre-release），资产重命名后上传
gh release create v1.3.0 --title "Orbis v1.3.0" --notes-file <说明> \
  dist/orbis-windows-v1.3.0-setup.exe dist/orbis-windows-v1.3.0.zip \
  dist/orbis-android-v1.3.0.apk
```

## 平台差异不要写进版本号

同一个版本号 = 同一份代码 = 同一套服务端。平台差异只体现在**构建产物**和
`docs/WINDOWS.md` / `docs/MACOS.md` 的验收记录里。

如果两个平台各自需要独立的版本号，说明**代码又分叉了** —— 那是
[平台边界与共享规则](PLATFORMS.md) 要解决的问题，不是靠 tag 后缀掩盖的。
