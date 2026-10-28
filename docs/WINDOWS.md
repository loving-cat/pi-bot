# Windows（桌面端）支持清单

这份文档只写 Windows 特有的东西：怎么构建、东西放在哪、哪些行为是刻意做的、
以及在真机上验证过什么。通用架构见 `ARCHITECTURE.md`，跨平台踩过的坑见 `PITFALLS.md`。

---

## 构建与打包

环境：Flutter 3.47+（桌面端已启用）、Visual Studio 2022（含 C++ 桌面负载）、Node 22+、npm。
脚本必须在 Windows 上跑；`pack-windows.ps1` 保持纯 ASCII，供 Windows PowerShell 5.1 解析。
不需要 Git，解压后的源码目录也可以打包。

```powershell
flutter config --enable-windows-desktop
.\scripts\pack-windows.ps1                 # dist/pi-bot-windows
.\scripts\pack-windows.ps1 -Zip            # + dist/pi-bot-windows.zip
.\scripts\pack-windows.ps1 -WithNode -Zip  # 把本机 node.exe 一起打进去
.\scripts\pack-windows.ps1 -NoBuild        # 复用已有 Release 产物
.\scripts\pack-windows.ps1 -SkipDeps       # 不预装依赖（首启动时 npm install）
.\scripts\pack-windows.ps1 -Help
```

默认构建不会在原源码目录里跑 Flutter。脚本把 `app/` 复制到系统临时目录，排除
`.dart_tool`、`build`、`.git`、`ephemeral`、`.vs`、`*.user`、`*.suo` 等生成缓存和用户工程状态，
再执行 `flutter build windows --release --split-debug-info=...`。成功后把 Release 目录换回
`app/build/windows/x64/runner/Release`，调试信息放到 `app/build/debug-info/windows`
（含分离出的 Dart 符号，以及从构建结果复制的 `.pdb`）。临时副本无论成功还是失败都会删掉，
原源码和上一份 Release 不会被半截构建改坏。

`-NoBuild` 不检查 Flutter、不复制源码，只要求上述 Release 目录里已经有 `pi_bot.exe`。
只改了服务端时可以复用；改了 Flutter 或 `app/windows` 之后要重新构建。

Runner 在 MSVC 上使用 `/PDBALTPATH:%_PDB%`，让主程序只记录 PDB 文件名。打包时还会把前端
PE 的 CodeView 绝对路径收成文件名，并删掉发行目录里的前端 `.pdb`。`node.exe` 和服务端目录
（含 `server/node_modules` 里的第三方原生模块）只扫描、不改写。

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

**打包是「先暂存再换成品」**：内容先铺在 `dist/.pack-windows-<rand>/`，装完依赖并做完下面的
检查，才替换 `dist/pi-bot-windows`。失败时把上一版目录和 zip 搬回去。本地 Release 的替换也是
同一套备份；构建失败不会拿一份残缺产物覆盖它。

换成品之前，`scripts/prepare-windows-bundle.mjs` 会让这次发布失败（而不是悄悄发出去），如果暂存目录里还有：

- 本机绝对路径：当前用户目录，以及本次源码目录、Release 目录、临时构建目录（含正斜杠和 JSON 转义形式）
- 调试符号文件（`.pdb`，包括服务端目录里删不掉的那些）
- 本机状态：`.pi`、`_inbox`、`server/.env`、任意 `.log`

`server/.env.example` 会保留。声明的生产依赖必须能从发行目录里解析；`-SkipDeps` 跳过安装和这项检查，
但路径和符号扫描照旧。

目标机器：

- 默认需要 **Node 22+ 在 PATH 上**（App 会自己找，找不到会在启动失败页让你指定路径）；
- 只有 `-SkipDeps` 才需要目标机器有 npm（首启动会执行 `npm install`）；
- 没有代码签名，首次运行会弹 SmartScreen 提示，属预期。

和 macOS 一样，命令桩 / Node 单测只覆盖脚本分支，不能代替一次真实的 Flutter Windows 构建。
Linux 上可以跑 `node scripts/tests/all.mjs`；Windows 上再跑
`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/tests/pack-windows-test.ps1`。

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

上表是 2026-10-19 的真机记录，早于「临时目录构建 + 发行包扫描」。那次结果不能当作
当前脚本已经在真实 Flutter Windows 构建上通过扫描。新的检查需要在装有 Visual Studio
的 Windows 上再跑一次 `.\scripts\pack-windows.ps1`。

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
6. **发行包扫描是字节级的**：前端 PE 只会改 CodeView 里的绝对 PDB 路径。调试信息若写在别的节里，
   或者服务端原生模块、自编译的 `node.exe` 带有本机路径，打包会失败，脚本不会改那些文件。
   预编译的官方 `node.exe` 一般只含构建机自己的路径，不包含打包者的用户目录。
7. **真实的 `flutter build windows` 只能在装了 Visual Studio 的 Windows 上验证**。
   当前自动化测试使用假的 `flutter` / `npm` 和合成 PE，证明分支、回滚和扫描，不证明链接器产物。
