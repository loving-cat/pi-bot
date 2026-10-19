# 平台边界与共享规则

一句话：**一条主干，平台目录共存，靠代码路径隔离，不靠长期分支隔离。**

## 为什么不再用长期平台分支

`codex/macos-current-main` 走了 20 个提交后，main 与它的共享层已经分叉。合并回 Windows 时
`flutter test` 直接红了 4 个：macOS 的 `.app/Contents` 判断看主机分隔符、版本目录只按 `/` 切
（`C:\...\node\v22.10.0` 被当成 `[0,0,0]`，排序失效）——这类问题在分叉期间**谁也发现不了**，
只有两端代码重新碰面才暴露。

Flutter 官方的做法就是所有平台目录放在一个仓库里：`flutter build windows` 只编译
`app/windows/`，`flutter build macos` 只编译 `app/macos/`，互不影响。这个仓库本来就是
`app/android/` + `app/windows/` 共存的，把 macOS 加进来是同一套规则，不是特例。

## 东西放哪

| 类型 | 位置 | 谁能改 |
|---|---|---|
| 共享 Dart（状态、组件、网络、模型） | `app/lib/**` | 任何平台。**改完两端各跑一次 `flutter test`** |
| Windows 运行器 | `app/windows/**` | Windows |
| macOS 运行器 | `app/macos/**` | macOS |
| Android | `app/android/**` | 移动端 |
| 平台适配小文件 | `app/lib/clipboard_image_macos.dart`、`app/lib/server/spawn_posix.dart` | 对应平台；共享文件只留接口 |
| 服务端（Node，跨平台） | `server/src/**` | 任何平台。碰进程/路径/编码的改动，**必须在 Windows 上跑 `node tests/all.mjs`** |
| 打包脚本 | `scripts/pack-windows.ps1`、`scripts/pack-macos.sh` | 各自平台，规则一致：暂存 → 校验 → 换成品 → 失败回滚 |
| 平台文档 | `docs/WINDOWS.md`、`docs/MACOS.md` | 各自平台（构建命令 + 真机验收记录） |

## 共享代码怎么写才不打架

1. **运行时判断，不在构建期分叉**：用 `Platform.isWindows` / `defaultTargetPlatform`，
   不要把平台逻辑写成两份文件再二选一。
2. **路径**：拼接用 `Platform.pathSeparator`；**解析**已有路径要同时认 `/` 和 `\`
   （测试里会喂进来混合分隔符的临时路径）。版本目录名从**最后一段**解析。
3. **进程**：用户填的命令统一走 `server/src/spawn-command.js`（PATHEXT / `.cmd` / 参数转义
   都在里面）；固定 node 的启动在 `app/lib/server/supervisor.dart` 按平台分流。
4. **平台专属能力**（剪贴板、快捷键、通知、窗口）：共享文件留接口 + 平台文件实现，
   不要在共享文件里堆 `if (mac) … else if (win) …`。
5. **枚举/档位**只在服务端定义一次（如 `model-thinking.js`），客户端通过接口取，
   拿不到才回退内置值 —— 两端各写一份枚举迟早漂移。

## 跨平台改动检查单

PR 之前逐条过一遍：

- [ ] 共享 Dart 改动：Windows 和 macOS **各跑一次** `cd app && flutter test` + `flutter analyze`
- [ ] 服务端改动：`cd server && node tests/all.mjs`（Windows 上也要跑一遍，见 CI）
- [ ] 新增路径拼接/解析：`Platform.pathSeparator`、双分隔符兼容
- [ ] 新增子进程：想一遍 `.cmd/.bat`、空格与引号、控制台窗口、怎么杀
- [ ] 用户可见的平台能力：更新对应的 `docs/WINDOWS.md` / `docs/MACOS.md`
- [ ] 打包脚本：保留"先暂存再换成品，失败不动上一版"

## 分支与发布

- 短期特性分支 → PR → `main`；**不再用长期平台分支**。
- 发布产物都从 `main` 构建：Windows zip（`scripts/pack-windows.ps1`）、
  Android apk（`flutter build apk`）、macOS dmg（`scripts/pack-macos.sh`）。
- CI（`.github/workflows/ci.yml`）在 ubuntu / windows / macos 上跑服务端单测，
  并在 Windows + macOS 上跑 `flutter analyze` / `flutter test` —— 就是为了在合并前
  抓"mac 的改动把 Windows 弄红了"这种问题。
