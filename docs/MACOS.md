# macOS（DMG）支持清单

目标：在 MacBook 上双击图标就能用，体验与 Windows 版一致。
构建脚本：`scripts/pack-macos.sh`（必须在 macOS 上跑）。

## 已经跨平台的

| 位置 | 说明 |
|---|---|
| `server/src/config.js` | 数据目录按平台选（macOS `~/Library/Application Support/pi-bot/data`） |
| `app/lib/server/locate.dart` | 找 node：`PI_BOT_NODE` → 可执行文件同级 → `which node`；只在 Windows 查 Program Files |
| `app/lib/server/supervisor.dart` | 停进程按平台分流（Windows `taskkill` / 其它 `killPid`） |
| `app/lib/server/launcher.dart` | 状态目录按平台选（已补 macOS，不再落到临时目录） |
| `server/src/shells.js` | `spawn(command, { shell: true })`，两种系统都走各自 shell |
| 窗口 | `window_manager` 支持 macOS；无标题栏与自绘按钮同一套代码 |

## 需要在本机验证或改的

1. **剪贴板贴图**：`app/lib/clipboard_image.dart` 目前只实现了 Windows
   （PowerShell + `Clipboard.GetImage`）。macOS 上现在会返回 null —— 纯文本粘贴正常，
   截图粘贴不可用。要补：用 `osascript` 写临时 PNG，或用 `pngpaste`/`NSPasteboard` 原生调用。
2. **Node 依赖**：安装包不内置 node（体积考虑）。用户机器需要 Node 22+；
   也可以在 `Contents/Resources` 里放 `node` 并让 locator 优先用它。
3. **签名 / 公证**：分发 DMG 给外部用户时，macOS 会拦未签名应用。
   需要 Apple Developer 证书 + `codesign` + `notarytool`（这一步不影响本机自用）。
4. **服务端进程生命周期**：macOS 上父进程退出不会带走子进程（我们本来就要这个行为），
   但"关掉 App 后服务端还在"要验证一次；看 `ps aux | grep server/src/index.js`。
5. **firewall**：首次启动 node 监听 0.0.0.0 时 macOS 会弹"是否允许接受传入连接"，
   要点允许，否则手机连不上。

## 验证清单（在 Mac 上跑一遍）

- [ ] `flutter analyze` / `flutter test` 全绿
- [ ] `./scripts/pack-macos.sh` 产出 `.app` 与 `.dmg`
- [ ] 双击 App：自动拉起服务端（`/health` 通），界面进主界面
- [ ] 关掉 App：服务端仍在（`ps` 能看到），再打开直接连上
- [ ] 杀掉服务端：4~5 秒自动重启
- [ ] 私聊开场（自我介绍 + 卡片）、任务板、审批卡片、改动文件卡片都正常
- [ ] 群聊：派活 → 私聊回执；`ask_user` 在群里被拒
- [ ] 附件：拖 PDF/Word/Excel 进窗口；>8MB 走分片
- [ ] 设置里能改端口 / 数据目录 / node 路径，保存后自动重启

## 已知差异（可接受）

- 剪贴板贴图（上表第 1 条）暂缺；
- 托盘/通知与 Windows 实现不同（`flutter_local_notifications` 在 macOS 需要额外权限声明）；
- 字体渲染差异：中文回退到苹方（Windows 是微软雅黑），排版已在设计时按两套字体留了余量。
