# macOS（DMG）支持清单

桌面端负责启动本机 Node 服务端，数据保存在用户目录。构建与打包入口为
`scripts/pack-macos.sh`，脚本必须在 macOS 上运行。

## 构建与打包

准备完整 Xcode 并完成首次启动、许可与组件安装；只有 Xcode 命令行工具不足以完成
Flutter 原生构建。另需 Flutter macOS desktop、Node 22+ 和 npm：

```bash
flutter config --enable-macos-desktop
cd app
flutter pub get
flutter analyze
flutter test
cd ..
./scripts/pack-macos.sh
```

多个 Xcode 并存时，用 `xcode-select` 或 `DEVELOPER_DIR` 选择对应的 Developer 目录。
使用临时 `DEVELOPER_DIR` 时，依赖准备与构建须使用同一环境；依赖准备阶段未找到完整
Xcode 可能生成空的 Swift 插件包清单，随后以 `--no-pub` 构建会缺少插件模块。
脚本会检查 Xcode 初始化和 macOS SDK，把应用源码复制到系统临时目录再构建 Release。
副本排除生成缓存、Pods 和用户工程状态，保留真实 HOME，不修改原源码；构建完成将完整
App 复制回下述构建路径，并将调试信息保存到 `app/build/debug-info/macos`。临时副本在成功或
失败时清理；调试信息不进入安装包。此流程不依赖 Git，解压的源码目录也可使用。

正常构建固定使用 `https://pub.dev`，先严格解析已提交的 `pubspec.lock`，再以 `--no-pub`
构建；锁文件不匹配或被改动时停止打包。`--no-build` 复用现有产物，不验证其依赖锁版本。

- 构建来源：`app/build/macos/Build/Products/Release/Orbis.app`，兼容旧的
  `pi-bot.app` / `pi_bot.app`（v1.7 品牌改名前的产物名）。
- 发行 App：`dist/Orbis.app`；服务端位于其 `Contents/Resources/server`。
- DMG：`dist/orbis-<服务端版本>.dmg`，版本取自 `server/package.json`。
  App 名用品牌名（`Orbis`），产物前缀用小写 slug（`orbis`）—— 与
  `orbis-windows-*` / `orbis-android-*` 一致。
- 服务端目录内执行 `npm install --omit=dev` 并检查声明依赖可解析；包内不附带 Node。
- 签名前整理前端原生文件的调试符号，仅移除已有系统及应用内回退的本机工具链搜索路径，
  再检查原生资产文件及架构。本机目录仍残留时停止打包，不静默发布。
- 上述原生处理使用命令行工具中的 `strip`、`otool`、`install_name_tool` 和 `lipo`；
  服务端第三方原生依赖只检查路径，不修改符号或加载命令。
- App 使用 ad-hoc 签名，脚本执行签名与 DMG 完整性校验后才替换旧成品；重复运行保留
  `dist` 中其他文件，失败时保留或恢复旧成品。

已有 Release App 时可只重新组装服务端和 DMG：

```bash
./scripts/pack-macos.sh --no-build
```

`--no-build` 不检查完整 Xcode、不调用 Flutter，但仍需已有构建产物、macOS、Node 与 npm。
只修改服务端时可以复用；修改 Flutter 或原生工程后须重新构建。
`--clear-quarantine` 仅在显式传入时清除本轮产物的隔离属性，默认关闭。
`.app`、`.dmg` 和 `node_modules` 不应提交到仓库；发布安装包时使用 Release 附件。

## 本机更新与预览清理

- 客户端更新须使用完整构建产物，不能只替换 `App.framework`。Dart 代码可能依赖新增的
  原生库；`Frameworks`、`MacOS`、资源和应用信息必须来自同一次构建。
- 保留已有服务端时，将 `Contents/Resources/server` 原位保留，仅同步其余完整客户端
  内容，先备份、再重签名并校验。Flutter 引擎相同不能代替原生依赖检查。
- 按 `NativeAssetsManifest.json` 检查每个目标架构要求的原生库存在；更新后启动正式
  `lib/main.dart` 入口，确认主界面加载。合成预览不覆盖正式初始化流程。
- 预览使用独立的应用标识和显示名。验证结束后退出预览、注销应用注册记录并删除
  Debug/Profile 预览 App；重复构建 App 无需保留。源码、用户数据和需要分发的 DMG 保留。
- 本机只保留一个明确的主程序入口；桌面快捷入口应指向该主程序，避免另放同名副本。

## 平台实现

macOS 窗口边缘由可缩放的 `NSWindow` 处理，不挂载 Flutter 的透明缩放热区。
Windows/Linux 的自定义热区继续交给各自的窗口插件，平台之间不共用原生缩放调用。

桌面页面不预留全宽标题行，各分栏从窗口顶部开始。自绘窗口控制簇位于 Mac 左上角、
Windows 右上角；只有接触控制角的标题工具区局部避让。普通放大/还原调用系统 zoom/maximize，
全屏状态下还原按钮退出全屏，普通窗口位置不会被全屏尺寸覆盖。标题空白或 π 把手可拖动，
双击可放大/还原；浏览器地址栏、消息胶囊和其它按钮保持独立点击。
Windows 的自绘放大按钮不提供系统按钮悬停的 Snap 菜单。

右侧浏览器使用临时 WebKit 会话，允许网页自身的 Cookie 和本地存储，不导入宿主 Cookie。
HTTP/HTTPS 页面正常浏览，文件资源由 WebKit 内容规则限制，网页不能调用原生消息桥。
关闭后不承诺保留登录状态。网页加载失败时保留恢复入口，前后退同时恢复文件名与查看模式。

附件按实际可用宽度选择阅读位置：能够并排时在右侧展开，否则使用独立二级预览页。
文件名、图片缩略图和预览按钮共用此规则。打开文件不会自动收起 Bot 信息；二级页关闭后
回到原聊天布局。附件交给系统程序期间，
文件卡持续显示打开状态，完成或失败后保留结果，避免重复请求。

表格与 Word 的阅读依赖同版本服务端的转换接口；PDF 由 WebKit 阅读器显示原文件。
HTML 附件在两种阅读位置都使用独立离线预览策略。客户端和服务端应配套更新，避免旧服务端缺少转换接口
或新服务端的请求头校验与旧客户端不匹配。

| 位置 | 说明 |
|---|---|
| `server/src/config.js` | macOS 默认数据目录为 `~/Library/Application Support/pi-bot/data` |
| `app/lib/server/locate.dart` | 查找 App Resources 中的服务端；Node 支持用户设置、环境变量、应用目录、PATH 与 macOS 常见安装目录 |
| `app/lib/server/health.dart` | 限制健康响应大小，校验成功标记、服务名和版本 |
| `app/lib/server/spawn_posix.dart` | 独立进程组启动服务端，标准输出直接写日志，释放辅助进程 |
| `app/lib/server/supervisor.dart` | Windows 与 POSIX 分流启动、停止和 PID 管理 |
| `app/lib/server/launcher.dart` | 启动编排；macOS 状态与日志保存在 `~/Library/Application Support/pi-bot` |
| `app/lib/clipboard_image_macos.dart` | 使用系统 `osascript` 与 AppKit 读取 PNG，支持 TIFF 转 PNG；读取完成或失败后清理私有临时目录 |
| `app/lib/widgets/server_config_section.dart` | 正常设置页与启动失败页共用启动配置入口，可修改端口、数据目录、服务端入口和 Node 路径 |
| 模型配置 | Windows/macOS 共用独立模型卡片，每个模型分别编辑 ID、显示名、上下文窗口与最大输出 |

模型容量单位为 tokens，必须是正整数，最大输出不能超过上下文窗口。已有模型的容量
留空保留原值，新模型留空采用服务端默认值；配置值不代表接口已确认支持该容量。
`/models` 可访问只证明模型列表接口可达，仍需实际推理鉴权通过。

### 桌面输入（`desktop_input` / `desktop_lease`）

**状态：空壳，未实现。** `server/src/desktop-input-mac.js` 的六个入口
全部返回 `not_platform`；`describePlatform('darwin').supported === false`。
`server/tests/desktop-input-mac.mjs` 的 13 项测试守着这一点 ——
空壳不许谎报成功，也不许抛异常。

要做什么、改哪些文件、先验哪三件事，全部写在
**[MACOS-DESKTOP-INPUT.md](MACOS-DESKTOP-INPUT.md)**。一句话概览：

| | Windows（已实机） | macOS（待填） |
|---|---|---|
| 坐标单位 | 物理像素 | **点**（points，Retina = 像素 ÷ 2） |
| 移动 | `SetCursorPos` | `CGWarpMouseCursorPosition` |
| 点击/按键 | `SendInput` | `CGEventPost` |
| 输入探针 | `GetLastInputInfo` | `CGEventSourceSecondsSinceLastEventType` |
| 文字输入 | 剪贴板 + Ctrl+V | `NSPasteboard` + **⌘V** |
| 系统授权 | 无（UAC/安全桌面会拦） | **辅助功能 + 屏幕录制两道** |

**判定逻辑一行都不用重写**：租约、接管检测、动作规划、坐标校验、
输入噪声判据全部是平台无关的纯逻辑（`desktop-lease.js` /
`desktop-takeover.js` / `desktop-input.js`），已有 106 项测试守着。
macOS 侧只需要实现六个函数，签名与返回形状与 Windows 版完全一致。

---

## 验证状态

2026-10-19 已使用 Xcode 16.4 在真实 Mac 上完成 Flutter Release 构建，真实打包得到
`.app` 与 `.dmg`，并通过脚本内签名和 DMG 校验。命令桩测试只覆盖脚本分支与失败恢复，
不能替代这项原生构建验证。

以下是 2026-10-19 本轮真实 Mac 验证结果。模型调用观察到 HTTP 401 认证拒绝与
HTTP 403 权限拒绝，相关聊天流程仍需在凭据及模型权限有效后复验。未勾选项不能
因编译、单元测试或假模型测试通过而视为通过。

- [x] 打开 `dist/Orbis.app`，自动拉起服务端并进入主界面。
- [x] `/health` 返回 `ok:true`；本轮使用空闲端口 18787，保留原占用端口上的其他程序。
- [x] 数据落在默认用户数据目录，而非临时目录。
- [x] 正常退出 App 后原服务端 PID 仍在，再次打开复用同一进程。
- [x] 强制结束已核对归属的服务端后，4379ms 内恢复健康检查并产生新 PID。
- [ ] 空私聊先自我介绍再出选项卡片：本轮模型请求被拒绝，未通过。
- [x] 任务板真实完成新增、置顶、勾完成、展开与删除，面板即时刷新。
- [ ] 审批后实际写文件并继续执行：受模型认证/权限阻塞，完整流程未完成。
- [ ] 附件部分通过：文件选择器上传 PDF、Excel 与 9437783 字节 PDF，落盘及下载
  字节均一致；大文件按客户端大于 8MB 的分支使用分片上传，未另抓网络路由；
  Finder 拖拽入口未完成实测，整项不能记为通过。
- [ ] 群聊派活与两条私聊回执：受模型认证/权限阻塞，完整流程未完成。
- [x] 设置页切换到 18788、指定 Node 与隔离数据目录后生效；再通过设置页恢复
  18787、自动 Node 和默认目录，原模型组仍在。

设置页已真实展示逐模型容量，编辑窗口可新增第二张独立卡片；验证草稿取消后原配置保留。
本轮最终静态检查无问题，Flutter 267 项通过、1 项跳过；服务端测试报告 495 项通过，
其中上游 `secrets` 的 3 个异步用例没有可靠等待，可靠完成数为 492，不能将其计为完整证明。

后续验收应在可用模型配置下补齐未通过项，并复验系统剪贴板截图粘贴、纯文本回退及无图场景。

## 端口与加密（v1.4.2 起）

手机连电脑的那条链路从 v1.4.1 起加密了，**桌面端没有变化** —— 它仍然连本机
`http://127.0.0.1:<端口>`。桌面端是回环，没有中间人，也就不必为它维护一张
要跟着网卡一起重签的证书。

| 端口 | 协议 | 用途 |
|---|---|---|
| 8787 | TCP | 桌面端连本机（明文，仅回环） |
| 8443 | TCP | 手机连过来（HTTPS / WSS，自签证书 + 手机端固定指纹） |
| 8788 | UDP | 手机「附近的电脑」发现 |

自签证书落在 `<数据目录>/tls/`（`cert.pem` / `key.pem`，权限 0600），
SAN 覆盖 `localhost`、`127.0.0.1` 和本机每张网卡的 IPv4；网卡地址变了会重签。
换数据目录时 `tls/` 会跟着搬（`data-migration.js` 的 ENTRIES），
否则手机上固定的指纹全部失效、每台手机都要重配一遍。

**身份靠人眼比对，不靠证书链**：证书指纹的 6 位校验码会显示在电脑的配对弹窗上，
手机设置页显示同一串，两边对上才点允许（详见 [ANDROID.md](ANDROID.md)）。

### 端口顺延

8787 被占时桌面端会自动往后挑（v1.3.14 起）；**8443 同理**（v1.4.2 起）——
挑不到空闲口时只是手机那条腿退回明文，不拦启动：

```
加密端口 8443 被占用，改用 8445          ← 正常顺延
加密端口 8443 附近都不可用 —— 手机将回退到明文连接
```

服务端自己也有兜底：它在 8443 上绑不上会打一行 `⚠ 加密监听起不来`，
继续以明文提供服务，手机界面上会显示「未加密」。

### 防火墙

macOS 首次监听局域网时会弹「是否允许 node 接受传入网络连接」。**要点允许** ——
点拒绝之后手机侧症状是：

- 「附近的电脑」列表是空的（UDP 8788 的广播应答被拦）；
- 或列表里能看到、点进去握手失败（TCP 8443 被拦）。

排查：系统设置 → 网络 → 防火墙 → 选项，确认允许该程序；或临时关掉防火墙对照一次。
桌面端本机路径（回环 8787）不受影响，所以会出现「电脑上一切正常、手机连不上」。

## v1.7 品牌改名在 Mac 上的落地

v1.7 起产品名从 **pi-bot** 改成 **Orbis**（仓库也改名为 `loving-cat/orbis`，
GitHub 会重定向旧地址）。Mac 上的影响面只有三处，且都带兼容：

| 项 | 变化 | 兼容策略 |
|---|---|---|
| App 名 | `pi-bot.app` → `Orbis.app` | `pack-macos.sh` 两种构建名都认 |
| DMG | `pi-bot-<版本>.dmg` → `orbis-<版本>.dmg` | 旧产物留在 `dist/` 不自动删 |
| 用户目录 | `~/Library/Application Support/pi-bot` → `.../orbis` | 新目录优先；`orbis` 不存在而 `pi-bot` 存在时**沿用旧的** |

**不做自动迁移**是刻意的：迁移半途失败（磁盘满 / 权限 / 进程被杀）会让用户
看到「聊天记录都没了」。沿用旧目录零风险，想换的用户可以手动搬。

### 桌面端与 App 端的目录判定必须一致

服务端在 `server/src/config.js` 的 `resolveHomeDir()`，App 在
`app/lib/server/launcher.dart` 的 `resolveStateDirName()` —— 两处都实现
「新版优先、旧版存在则沿用」。

两边不一致的后果是分叉：App 的 `server.log` / pid 在新目录，服务端数据在旧目录。
pid 分叉尤其麻烦 —— 会出现「服务端在跑、App 以为自己没起过」而重复拉进程。

`app/test/state_dir_test.dart` 守着 App 侧的判定，并断言两个品牌常量与服务端
逐字一致（改一处必须改两处）。

### 环境变量

服务端统一走 `readBrandEnv`：`ORBIS_*` 优先，未设置或空串时回退 `PI_BOT_*`。
桌面端传的 `PI_BOT_PORT` / `PI_BOT_TLS_PORT` / `PI_BOT_HOME` **继续有效**，
不需要改；新代码/文档一律写 `ORBIS_*`。2.0 起只认 `ORBIS_*`。

### 从旧版本升上来的自查

```bash
curl -s http://127.0.0.1:18787/health | python3 -m json.tool | head -8
# 期望：serverName 变成 "Orbis"，version 是新版本，
#       rooms/bots/messages 数量与升级前一致（数据沿用了旧目录）
ls -d ~/Library/Application\ Support/pi-bot ~/Library/Application\ Support/orbis 2>/dev/null
# 老用户：只有 pi-bot；新装用户：只有 orbis
```

## 已知限制

- 目标机器需自行安装 Node 22+；安装包不包含 Node。
- 当前为 ad-hoc 签名，未做 Developer ID 签名与公证。对外分发需另行配置证书与公证流程；
  清除隔离属性不等于完成公证。
- 本地通知目前仅在 Android/iOS 启用；macOS 不初始化该插件，暂不提供本地通知。
- 首次监听局域网地址时可能出现系统防火墙提示；手机连接需网络权限与可达性。
- 中文使用系统字体回退；不同平台的字体渲染可能存在差异。

## v1.4.1 起在 Mac 上的行为（适配起点）

这一版加的东西大多是 Windows 相关的，Mac 上会**降级但不崩**。逐项说清"Mac 上现在是什么样"，
免得对着代码猜。

| 功能 | Windows 上 | macOS 现在 | 需要做什么 |
|---|---|---|---|
| 调研后台浏览器 `browser_research` | 岛里起真 Chromium（窗口在另一张桌面）+ CDP 驱动 | **自动降级为无头**（`islandSupported()` 为假）。登录态照旧带：快照路径取 `~/Library/Application Support/Google/Chrome`，Cookie 由 Keychain 里 "Chrome Safe Storage" 那把钥匙解开，同一用户可读 | 不用改代码。真机跑一次**需要登录**的站点，确认 `open` 返回的是登录后的正文 |
| 岛 `desktop_island_*` | `CreateDesktop` 独立桌面 | **明确拒绝**并说明原因（macOS 没有 `CreateDesktop` 等价 API），不会静默降级成"动用户鼠标" | 二选一：虚拟机做 GUI 隔离，或接受"操作当前桌面"（必须先单独确认）。见 GitHub Issues |
| 桌面输入 `desktop_input` | `SendInput` + 租约 + 接管检测 | 空壳：六个函数留了槽位，13 项测试守着"不许谎报成功" | GitHub Issue「桌面输入：macOS 实现（W2d）」 |
| ego 收尾与全屏 | 退全屏 + `handOff()` 把控制权交回用户 | 同一份脚本（ego 是跨平台 Chromium），未在 Mac 实测 | 跑一次"打开给我看"，确认收尾后页面能点、底下没有 "Agent is in control" |
| 退出快捷键 | `Ctrl+Shift+Q` | `⌘+Shift+Q`（同一份代码，control 与 meta 都认） | 无需改动 |
| 收浏览器进程 | `taskkill /PID /T /F` 杀整棵树 | `kill()`（按平台分支） | 若偶发"profile 目录被占"，说明有子进程没退，记一笔 |

### 适配时的自查顺序

```bash
cd server && node tests/all.mjs                    # 136 个测试文件
cd ../app && flutter analyze && flutter test       # 783 项（~3 跳过）
cd .. && node scripts/check-secrets.mjs            # 提交身份/凭据
cd server && node scripts/check-consistency.mjs    # 八项一致性（含锁文件不许带镜像地址）
./scripts/pack-macos.sh                            # .app + .dmg
```

⚠ 打包时不要设 `PUB_HOSTED_URL` 到镜像：`flutter pub get` 会把镜像地址写进
`pubspec.lock`，一旦提交，CI 用官方源跑 `--enforce-lockfile` 会红。现在有检查拦
（`check-consistency.mjs` 第 8 项），但仍然别提交镜像版锁文件。

⚠ 本地打包机若跑过测试，`app/build` 与 `dist/` 会变大很多 —— `pack-macos.sh` 自己会清理暂存目录，
旧成品按脚本的恢复逻辑保留。
