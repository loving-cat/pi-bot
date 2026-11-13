# Windows（桌面端）支持清单

这份文档只写 Windows 特有的东西：怎么构建、东西放在哪、哪些行为是刻意做的、
以及在真机上验证过什么。通用架构见 `ARCHITECTURE.md`，跨平台踩过的坑见 `PITFALLS.md`。

---

## 构建与打包

环境：Flutter 3.47+（桌面端已启用）、Visual Studio 2022（含 C++ 桌面负载）、Node 22+、npm，
以及在 PATH 上的 `nuget.exe`（NuGet CLI，见下文）。
脚本必须在 Windows 上跑；`pack-windows.ps1` 保持纯 ASCII，供 Windows PowerShell 5.1 解析。
不需要 Git，解压后的源码目录也可以打包。

```powershell
flutter config --enable-windows-desktop
.\scripts\pack-windows.ps1                 # dist/pi-bot-windows
.\scripts\pack-windows.ps1 -Zip            # + dist/pi-bot-windows.zip
.\scripts\pack-windows.ps1 -WithNode -Zip  # 把本机 node.exe 一起打进去
.\scripts\pack-windows.ps1 -NoBuild        # 复用已有 Release 产物
.\scripts\pack-windows.ps1 -SkipDeps       # 不预装依赖（首启动时 npm install）
.\scripts\pack-windows.ps1 -BuildRoot E:\builds  # 指定中立构建根目录
.\scripts\pack-windows.ps1 -Help

.\scripts\pack-windows-setup.ps1           # + dist/pi-bot-windows-v<ver>-setup.exe
.\scripts\pack-windows-setup.ps1 -Help     # 安装包打包的选项
```

**一键安装包（setup.exe）**：`pack-windows-setup.ps1` 不重新构建，它把
`dist/pi-bot-windows` 现成的目录整个封进 Inno Setup，所以要先跑上面那个带 `-WithNode -Zip`
的目录打包（封的就是那边已经扫过的字节：无本机路径、无 `.pdb`、无本地状态）。
它需要 Inno Setup 6：`winget install JRSoftware.InnoSetup`（按用户安装即可，脚本从 PATH
和常见安装位置找 `ISCC.exe`，也可以用 `-Iscc` 指定）。

安装包是**按用户安装**（无需管理员，不弹 UAC），装到
`%LOCALAPPDATA%\Programs\pi-bot`，自带桌面/开始菜单快捷方式，在「应用和功能」里卸载。
装前它读 `%LOCALAPPDATA%\pi-bot\server.pid`，先用 `tasklist` 确认为 `node.exe` 再
`taskkill /T /F` —— 既不留下锁住 `node.exe` 的孤儿进程导致覆盖失败，也不会因 pid 被回收而
误杀无关进程。`%LOCALAPPDATA%\pi-bot` 里的数据、配对、历史一律不动，所以升级就重跑安装包。

中文界面由 `scripts/installer/ChineseSimplified.isl` 提供（Inno 官方仓库不收中文，
这份取自上游客服端维护的 MIT 译本，已转为带 BOM 的 UTF-8，否则 ISCC 按 ANSI 解会碎码）。

默认构建不会在原源码目录里跑 Flutter。脚本把 `app/` 复制到中立构建根目录下本次运行专用的子目录，排除
`.dart_tool`、`build`、`.git`、`ephemeral`、`.vs`、`*.user`、`*.suo` 等生成缓存和用户工程状态，
固定使用 `https://pub.dev` 严格解析已提交的 `pubspec.lock`，再执行
`flutter build windows --release --no-pub --split-debug-info=...`。锁文件不匹配或被改动时停止。
成功后把 Release 目录换回
`app/build/windows/x64/runner/Release`，调试信息放到 `app/build/debug-info/windows`
（含分离出的 Dart 符号，以及从构建结果复制的 `.pdb`）。构建副本无论成功还是失败都会删掉，
原源码和上一份 Release 不会被半截构建改坏。

**构建根目录**：默认是源码所在盘符根下的 `.pi-bot-build`（例如源码在 `E:` 盘就是 `E:\.pi-bot-build`），
可用 `-BuildRoot <绝对路径>` 改。系统临时目录在用户目录里，构建产物会带上本机用户路径，发布扫描会拦下，
所以不再用它。规则：

- `-BuildRoot` 必须是绝对路径（带盘符或 UNC），相对路径直接报错；
- 不能落在用户目录（`USERPROFILE`）或源码目录里面，报错时不打印具体路径；
- 每次运行在根目录下新建 `pi-bot-windows-build-<rand>/`，写入标记文件 `.pi-bot-build-run`，
  结束时只删除标记和本次一致的那个子目录，根目录里的其他东西不碰；默认根目录若是本次新建且已空，会顺手删掉；
- 运行期间持有根目录下 `.pack-windows.lock` 的独占锁，同一根目录上的第二个打包会报「build root is busy」并直接退出。

**NuGet**：部分 Windows 插件在 CMake 阶段需要 NuGet CLI，其中有的插件找不到时会自己从网上下载 `nuget.exe`。
打包脚本不允许这种隐式下载：非 `-NoBuild` 构建开始前会检查 PATH 上是否有 `nuget.exe`，没有就停止并提示，
不会替你下载或安装。请自行安装 NuGet CLI 并把它所在目录加入 PATH；`-NoBuild` 不需要它。

`-NoBuild` 不检查 Flutter、不复制源码，只要求上述 Release 目录里已经有 `pi_bot.exe`。
此选项不验证重用产物的依赖锁版本。
只改了服务端时可以复用；改了 Flutter 或 `app/windows` 之后要重新构建。

仍使用实验协程头的两个插件在 MSVC 下启用目标级兼容宏，避免新版编译器的弃用错误。
该兼容措施只作用于相关插件；后续插件升级到标准协程后应移除。

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

- 本机用户目录（文件内容里的 UTF-8 和 UTF-16 都会扫；另外也扫本次源码目录、Release 目录和本次构建目录）
- 调试符号文件（`.pdb`。打包会先把前端 `.pdb` 挪到 `app/build/debug-info/windows`，扫的是挪完之后的发行目录；服务端里删不掉的 `.pdb` 仍会失败）
- 本机状态：`.pi`、`_inbox`、`server/.env`、任意 `.log`
- `NativeAssetsManifest.json` 里列出的 DLL 在包内缺失（服务端目录里的清单不参与这项检查）

报错只说明哪一类问题、有几个文件，不打印本机路径或清单里的原始路径。

`server/.env.example` 会保留。声明的生产依赖必须能从发行目录里解析；`-SkipDeps` 跳过安装和这项检查，
但路径和符号扫描照旧。

目标机器：

- 默认需要 **Node 22+ 在 PATH 上**（App 会自己找，找不到会在启动失败页让你指定路径）；
- 只有 `-SkipDeps` 才需要目标机器有 npm（首启动会执行 `npm install`）；
- 没有代码签名，首次运行会弹 SmartScreen 提示，属预期。

和 macOS 一样，命令桩 / Node 单测只覆盖脚本分支，不能代替一次真实的 Flutter Windows 构建。
Linux 上可以跑 `node scripts/tests/all.mjs`。Windows CI 会跑
`node scripts/tests/prepare-windows-bundle-test.mjs`（假包目录：每种问题报错，干净包通过）、
`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/tests/pack-windows-test.ps1` 和
`pack-windows-setup-test.ps1`（缺目录 / 缺 server / 坏 -Iscc 各自报错；装了 Inno Setup 时
再用假 bundle 真编译一次，验证产物名、sha256、临时目录清理）。

## 本机更新

两种装法各走各的路：

- **setup.exe 装的**：直接跑新版安装包覆盖，不需要先卸载。安装程序自己停服务端，
  `%LOCALAPPDATA%\pi-bot` 原封不动。应用内的「检查更新」会优先拿到 setup.exe。
- **zip 免安装的**：用同一次构建的完整客户端换掉整个程序目录：`pi_bot.exe`、Flutter 运行库、
  `data/` 和清单里的原生 DLL 必须来自同一次构建，不要只替换单个 exe 或 DLL。

两种情况下用户数据目录（`%LOCALAPPDATA%\pi-bot`）都保持不动。要沿用已经配对、装好依赖的服务端时，
原来的 `server` 目录也原样留下，只替换其余客户端文件。换完后确认 `NativeAssetsManifest.json`
列出的每个 DLL 都在，再从正式入口启动。源码和需要分发的 zip 另外保留。

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

## 验证状态（2026-11-11，Windows 11 x64，v1.3.14）

包内自带 `node.exe`（v24.18.0），不依赖系统 Node。

| 项目 | 结果 |
|---|---|
| `node server/tests/all.mjs` | 85/85 文件通过 |
| `node scripts/tests/all.mjs` | 32/32 通过 |
| `pack-windows-test.ps1` | 27 项命令桩检查通过 |
| `pack-windows-setup-test.ps1` | 错误分支 + 假包真编译 通过 |
| `flutter analyze` | 无 issue |
| `flutter test` | 689 passed / 3 skipped |
| `pack-windows.ps1 -WithNode -Zip` | 成功；中立构建根构建，Flutter 构建 307s |
| 发行包扫描 | `{"files":18442,"removedPdbs":0,"rewrittenDebugPaths":1,"rewrittenBuildRoots":2,"serverPeFiles":3,"nativeAssets":0,"dependencies":8}` |
| 产物 | `dist/pi-bot-windows` 391MB / zip 123.7MB（18538 个文件） |
| 真机启动 | 包内 node 拉起 `server/src/index.js`，监听 8787，本机连接正常 |
| `GET /health` | `ok=true version=1.3.14` |
| `pack-windows-setup.ps1` | 成功；setup.exe 71.8MB，编译 57s |
| setup.exe 升级安装 | 1.3.12 → 1.3.14 覆盖装成功，卸载项版本随之更新，数据目录 57 房间 / 424 消息未动 |
| 安装后启动 | 从 `%LOCALAPPDATA%\Programs\pi-bot` 启动，`/health` 返回 `version=1.3.14` |
| **端口自动顺延（1.3.14 新功能）** | 先让一个非 pi-bot 的 HTTP 服务占住 8787，再启动客户端：服务端自动改听 **8788**，`/health` 正常，界面没有失败页 |
| 端口空着时 | 仍用偏好端口 8787，不顺延（顺延只在被占 / 没权限时发生） |
| `pickAssetFor`（v1.3.14 真实资产） | 同时挂 dmg + setup.exe + zip → win32 选 `pi-bot-windows-v1.3.14-setup.exe`，darwin 选 `pi-bot-1.3.14.dmg` |
| 发布 | `pi-bot-windows-v1.3.14-setup.exe` + `.zip` 已补挂到 v1.3.14 |

本次是纯代码同步（main `7889222` → `b7bf613`，28 文件 / +1662 / −92）：
`app/windows`、`scripts/`、`.github/` 全程零改动，新增的客户端代码里没有一处
`Platform.*` / `defaultTargetPlatform` / `kIsWeb` 分支，服务端改动（记忆脱敏、
上下文预算、decision-router）也没引入 POSIX 专属路径。

**唯一与 Windows 有关的新增是客户端的端口探测**（`app/lib/server/port_picker.dart`，
纯 `dart:io`，两端同一份代码）：用 `ServerSocket.bind(0.0.0.0, port)` 真实试绑来区分
「空着」和「没权限」（按 `err.osError.errorCode` 判 13/1）。这条在 Windows 上更值得留意 ——
Windows 下低端口失败往往是「端口保留」（`netsh int ipv4 show excludedportrange protocol=tcp`）
而不是 EACCES，所以探测落到 `occupied` 分支也照样会顺延，行为是对的。实机验证见上表两行。

### 1.3.13 / 1.3.14 的 Windows 资产曾经缺挂

v1.3.13、v1.3.14 两个 tag 当时只挂了 `.dmg`。`pickAssetFor(assets, 'win32')` 在没有
exe/zip 时返回 `null` → Windows 客户端的「检查更新」只能退到「打开发布页」，拿不到直链。
已按 `RELEASE.md` 第 5 条增量补挂，并用真实资产重跑 `pickAssetFor` 确认优先级。
以后 bump 版本时记住：**同一个版本号，三个平台各有自己的资产名**。

上一版记录（2026-11-10，v1.3.11，82/82 测试、660 passed、390MB）早于本次同步，
再上一版（2026-11-05，v1.3.7，66/66 测试、590 passed、390MB）仅作历史对照。

### 本机环境的一个坑（不是产品问题）

这台开发机设了 `PUB_HOSTED_URL=https://pub.flutter-io.cn`，而 `pubspec.lock` 里记的是
`https://pub.dev`，直接 `flutter pub get --enforce-lockfile` 会报
「Unable to satisfy `pubspec.yaml` using `pubspec.lock`」（117 个包全要"变"）。
`pack-windows.ps1` 内部已经把 `PUB_HOSTED_URL` 强制设成 `pub.dev`（见脚本第 293 行），
所以打包不受影响；手动跑 analyze / test 时要自己带一句：

```powershell
$env:PUB_HOSTED_URL = 'https://pub.dev'; flutter analyze --no-pub
```

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
3. **没有签名**：SmartScreen 会警告（setup.exe 和 zip 都一样）；企业环境可能需要 IT 放行。
4. **Node 不在 PATH 且未 `-WithNode`**：启动失败页可直接改端口/路径，
   也能打开日志目录看服务端为什么没起来。
5. **Windows 上的 nvm 支持是"读目录"**，不执行 `nvm use`，也不改用户环境变量。
6. **发行包扫描是字节级的**：前端 PE 只会改 CodeView 里的绝对 PDB 路径。调试信息若写在别的节里，
   或者服务端原生模块、自编译的 `node.exe` 带有本机路径，打包会失败，脚本不会改那些文件。
   预编译的官方 `node.exe` 一般只含构建机自己的路径，不包含打包者的用户目录。
7. **真实的 `flutter build windows` 只能在装了 Visual Studio 的 Windows 上验证**。
   当前自动化测试使用假的 `flutter` / `npm` 和合成 PE，证明分支、回滚和扫描，不证明链接器产物。
8. **沙箱启动器需要 Rust 工具链单独构建**：`server/resources/pibot-sandbox.exe`
   不在仓库里（`scripts/build-sandbox-win.ps1` 生成）。打包机没装 Rust 时
   仍能出包，但**挂了 MCP 的 bot 在那些机器上会 fail-closed 拒绝 shell**。
   细节、实测坑与验收见 [WINDOWS-SANDBOX.md](WINDOWS-SANDBOX.md)。
