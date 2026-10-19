# Windows（桌面端）支持清单

这份文档只写 Windows 特有的东西：怎么构建、东西放在哪、哪些行为是刻意做的、
以及在真机上验证过什么。通用架构见 `ARCHITECTURE.md`，跨平台踩过的坑见 `PITFALLS.md`。

---

## 构建与打包

环境：Flutter 3.47+（桌面端已启用）、Visual Studio 2022（含 C++ 桌面负载）、Node 22+。

```powershell
# 只构建
cd app
flutter build windows --release
# 产物：app/build/windows/x64/runner/Release/pi_bot.exe

# 打完整包（exe + Flutter 运行库 + server/ + 服务端依赖）
.\scripts\pack-windows.ps1                 # dist/pi-bot-windows
.\scripts\pack-windows.ps1 -Zip            # + dist/pi-bot-windows.zip
.\scripts\pack-windows.ps1 -WithNode -Zip  # 把本机 node.exe 一起打进去
.\scripts\pack-windows.ps1 -NoBuild        # 复用已有 Release 产物
.\scripts\pack-windows.ps1 -SkipDeps       # 不预装依赖（首启动时 npm install）
.\scripts\pack-windows.ps1 -Help
```

包内布局：

```
pi-bot-windows/
  pi_bot.exe
  <flutter_windows.dll / *_plugin.dll / data/>
  node.exe          （仅 -WithNode）
  server/
    src/ tools/ package.json [package-lock.json] .env.example
    node_modules/   （由打包脚本装入，不是从开发目录复制）
```

**打包是"先暂存再换成品"**：所有内容先在 `dist/.pack-windows-<rand>/` 里铺好，
`npm install` 和布局校验（`pi_bot.exe` / `server/src/index.js` / `server/package.json`）
都通过后，才把旧的 `dist/pi-bot-windows` 换下去。任何一步失败都会把旧包搬回原处 ——
打坏一次不该把上一版能发的包弄丢。这一点和 `pack-macos.sh` 是同一套规则。

目标机器：

- 默认需要 **Node 22+ 在 PATH 上**（App 会自己找，找不到会在启动失败页让你指定路径）；
- 只有 `-SkipDeps` 才需要目标机器有 npm（首启动会执行 `npm install`）；
- 没有代码签名，首次运行会弹 SmartScreen 提示，属预期。

---

## 平台实现

### 启动本机服务端（不闪黑框）

Windows 的 GUI 进程没有控制台，`Process.start` 拉起 Node 时系统会**新建一个控制台窗口**，
之后服务端派生的每个控制台子进程（rg / fd / git）都会再闪一次。做法：

1. 写一个短命辅助脚本 `spawn-server.mjs`；
2. 用 `WScript.Shell.Run(cmdline, 0, False)`（0 = 隐藏窗口）启动它；
3. 服务端继承那个**隐藏控制台**，日志 fd 直连 `server.log`；
4. `spawn` 里**不能**加 `windowsHide` / `detached` —— 两者都会把继承来的控制台剥掉，
   于是工具一跑又闪黑框（`spawn-server.mjs` 里有注释说明）。

停止用 `taskkill /PID <pid> /T /F`（Windows 没有可用的优雅信号）。
POSIX 走 `spawn_posix.dart` 的独立进程组，两边在 `supervisor.dart` 分流。

### 找 node / npm

候选顺序：`PI_BOT_NODE` → exe 同级 → `%ProgramFiles%\nodejs` → 各版本管理器 → PATH。

版本管理器都认（目录里按**主/次/补丁降序**挑最新的）：

| 方式 | 位置 |
|---|---|
| nvm-windows | `NVM_HOME` / `%APPDATA%\nvm\vX.Y.Z\node.exe`、`NVM_SYMLINK` |
| fnm | `FNM_DIR` / `%APPDATA%\fnm\node-versions\vX.Y.Z\installation` |
| Volta | `%LOCALAPPDATA%\Volta\bin` |
| Scoop | `%USERPROFILE%\scoop\apps\nodejs\current`、`scoop\shims` |

npm 依次找 `<node 目录>\npm.cmd` → `<node 目录>\node_modules\npm\bin\npm-cli.js`
（只带 node.exe 的发行包就是这种形态）→ PATH 上的 npm。

### 用户填的命令（MCP / 外部 CLI）

`npx` / `npm` / `pnpm` / `uvx` 在 Windows 上是 `.cmd` 批处理 shim。
`server/src/spawn-command.js` 先按 `PATHEXT` 解析真实文件，再对 `.cmd/.bat`
用 `cmd.exe /d /s /c` + 逐参数转义启动；只有 npm 生成的
`node_modules/.bin/*.cmd` 才做双转义（它内部会再展开一次 `%*`）。
原因和代价见 `PITFALLS.md` 第 33 条。

### 剪贴板图片

PowerShell（`-STA`）读 `[Windows.Forms.Clipboard]::GetImage()`，存成临时 PNG，
把路径打到 stdout；App 读回字节后删临时文件。脚本保持纯 ASCII —— PowerShell 5.1
会把无 BOM 的脚本按当前代码页解码，中文注释能把解析器搞崩。

### 窗口与快捷键

- 无边框 + 自绘标题栏（`widgets/window_title_bar.dart`），位置/大小记在
  `window_state.dart`，拖动时夹回当前显示器可见区（避免跨屏触发 DPI 重缩放）。
- 快捷键按系统习惯：Windows 是 Ctrl（`desktop_shortcuts.dart` 的
  `shortcutModifier` / `shortcutLabel`），不要写死 ⌘。
- 输入法组词期间的回车不当作"发送"（`ime_guard.dart`），中文/日文/韩文输入法都要过这一层。

---

## 验证状态（2026-10-19，Windows 11 x64）

| 项目 | 结果 |
|---|---|
| `flutter analyze` | 无 issue |
| `flutter test` | 280 passed / 3 skipped（跳过的是 POSIX 专属的停止语义） |
| `node server/tests/all.mjs` | 37/37 文件通过 |
| `flutter build windows --release` | 成功（约 36s） |
| 真机启动 App | 由 supervisor 拉起服务端，`server.pid` 生成，无黑框闪烁 |
| `GET /health` | 200，`serverName=pi-bot`，版本 1.1.0 |
| `GET /api/mcp` | 200，返回服务库与限额 |
| `GET /api/local-capabilities` | 200，正确扫描 `C:\Users\<用户>\.pi\agent` |
| `POST /api/mcp/test`（本地 .cmd 服务） | ok，3.02s 返回；不存在的命令返回中文提示 |
| `pack-windows.ps1` 真机打包 | 成功，dist 约 296MB，server 带 160 个依赖目录 |

---

## 已知限制

1. **创建进程偶尔阻塞 3~6 秒**：在装了实时防护的机器上，`CreateProcessW(taskkill)`
   实测同步阻塞约 2.8s，`reg.exe` 3~6s（都会间隔性重来）。处理方式：
   - "测试连接"的探测进程不调 taskkill，改成关 stdin + 结束直接子进程；
   - 读系统代理的 `reg query` 放进 **worker 线程**，主线程不被冻；
   - 代理缓存过期时先返回旧值、后台刷新，调用方不为探测付等待；
   - 只有用户主动停止服务端时才用 `taskkill /T /F`（一次操作，可接受）。
2. **.cmd 参数转义**：`spawn-command.js` 的规则与 cross-spawn 一致，但只覆盖
   `.cmd/.bat`；其它脚本类型（`.ps1`、`.py`）仍按普通可执行文件处理。
3. **没有签名**：SmartScreen 会警告；企业环境可能需要 IT 放行。
4. **Node 不在 PATH 且未 `-WithNode`**：启动失败页可直接改端口/路径，
   也能打开日志目录看服务端为什么没起来。
5. **Windows 上的 nvm 支持是"读目录"**，不执行 `nvm use`，也不改用户环境变量。
