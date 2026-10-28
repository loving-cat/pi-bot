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
脚本会检查 Xcode 初始化和 macOS SDK，再执行 `flutter build macos --release`。

- 构建来源：`app/build/macos/Build/Products/Release/pi-bot.app`，兼容 `pi_bot.app`。
- 发行 App：`dist/pi-bot.app`；服务端位于其 `Contents/Resources/server`。
- DMG：`dist/pi-bot-<服务端版本>.dmg`，版本取自 `server/package.json`。
- 服务端目录内执行 `npm install --omit=dev` 并检查声明依赖可解析；包内不附带 Node。
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

## 验证状态

2026-10-19 已使用 Xcode 16.4 在真实 Mac 上完成 Flutter Release 构建，真实打包得到
`.app` 与 `.dmg`，并通过脚本内签名和 DMG 校验。命令桩测试只覆盖脚本分支与失败恢复，
不能替代这项原生构建验证。

以下是 2026-10-19 本轮真实 Mac 验证结果。模型调用观察到 HTTP 401 认证拒绝与
HTTP 403 权限拒绝，相关聊天流程仍需在凭据及模型权限有效后复验。未勾选项不能
因编译、单元测试或假模型测试通过而视为通过。

- [x] 打开 `dist/pi-bot.app`，自动拉起服务端并进入主界面。
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

## 已知限制

- 目标机器需自行安装 Node 22+；安装包不包含 Node。
- 当前为 ad-hoc 签名，未做 Developer ID 签名与公证。对外分发需另行配置证书与公证流程；
  清除隔离属性不等于完成公证。
- 本地通知目前仅在 Android/iOS 启用；macOS 不初始化该插件，暂不提供本地通知。
- 首次监听局域网地址时可能出现系统防火墙提示；手机连接需网络权限与可达性。
- 中文使用系统字体回退；不同平台的字体渲染可能存在差异。
