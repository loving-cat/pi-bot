# docs 索引

**这里放"关于系统本身"的说明。** 不放交接便条、待办台账、某天体检报告、某版本评审 ——
那些是一次性产物，过期就成了误导。待办在 GitHub Issues。

## 上手

| 文件 | 讲什么 |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 整体结构：房间 / bot / 会话 / 工具 / 权限 |
| [`MODULE-MAP.md`](MODULE-MAP.md) | 每个源文件干什么（改代码前先看这里） |
| [`PLATFORMS.md`](PLATFORMS.md) | 平台边界与共享规则（为什么平台差异不进版本号） |
| [`PITFALLS.md`](PITFALLS.md) | 踩过的坑，按主题汇总 —— 血泪史，别踩第二遍 |

## 安装与发布

| 文件 | 讲什么 |
|---|---|
| [`WINDOWS.md`](WINDOWS.md) | Windows 安装、验收记录 |
| [`MACOS.md`](MACOS.md) | macOS 安装 |
| [`ANDROID.md`](ANDROID.md) | 安卓包怎么打、签名为什么不能换、手机上什么变了 |
| [`RELEASE.md`](RELEASE.md) | **发版硬规则**：tag 纯 semver、资产命名、提交身份 |
| [`LICENSES.md`](LICENSES.md) | 内置组件许可证（`scripts/check-licenses.mjs` 生成） |

## 权限与安全

| 文件 | 讲什么 |
|---|---|
| [`spec-permissions-v1.0.1.md`](spec-permissions-v1.0.1.md) | 权限规格原文（授权、网关、撤销、审计） |
| [`PERMISSIONS-INVENTORY.md`](PERMISSIONS-INVENTORY.md) | 权限清单：每个动作属于哪一档 |
| [`spec-intent-and-habits-v1.md`](spec-intent-and-habits-v1.md) | 意图分档（用户要不要看）+ 用户习惯 |
| [`spec-convergence-v1.md`](spec-convergence-v1.md) | 权限层收束计划 |
| [`acceptance-matrix.md`](acceptance-matrix.md) | 验收矩阵（逐行挂证据） |

## 桌面控制

| 文件 | 讲什么 |
|---|---|
| [`WINDOWS-HIDDEN-DESKTOP.md`](WINDOWS-HIDDEN-DESKTOP.md) | 岛（独立桌面）机制：为什么、怎么验证 |
| [`WINDOWS-SANDBOX.md`](WINDOWS-SANDBOX.md) | 沙箱与隔离边界 |
| [`MACOS-DESKTOP-INPUT.md`](MACOS-DESKTOP-INPUT.md) | macOS 桌面输入（实现槽位 + 待验清单） |
| [`KEY-INSTABILITY.md`](KEY-INSTABILITY.md) | 键盘事件的坑（为什么不能靠扫按键猜意图） |

## 会话与能力

| 文件 | 讲什么 |
|---|---|
| [`COMPACTION-AND-BUDGET.md`](COMPACTION-AND-BUDGET.md) | 上下文压缩与预算 |
| [`AGENT-MODEL.md`](AGENT-MODEL.md) | 模型角色与分工 |
| [`AGENT-PATTERNS.md`](AGENT-PATTERNS.md) | 派活 / 协作的既有模式 |
| [`DECISION-ROUTER.md`](DECISION-ROUTER.md) | 谁来响应某条消息（含对等会话） |
| [`spec-peer-dialog.md`](spec-peer-dialog.md) | bot 之间对话的规格 |
| [`TASK-RUN-PROTOCOL.md`](TASK-RUN-PROTOCOL.md) | TaskRun 引擎协议 |
| [`taskrun-gaps.md`](taskrun-gaps.md) | TaskRun 还差什么（开启前的门） |

## 功能说明

| 文件 | 讲什么 |
|---|---|
| [`RELAY.md`](RELAY.md) | 中继（跨机、跨网） |
| [`APP-CONNECTIONS.md`](APP-CONNECTIONS.md) | App 怎么连服务端（局域网 / 中继 / 本机） |
| [`SITE-INTEGRATION.md`](SITE-INTEGRATION.md) | 网站侧接入 |
| [`HTML-PREVIEW.md`](HTML-PREVIEW.md) | HTML 预览面板 |
| [`AVATAR.md`](AVATAR.md) | 头像绘制与动画约束 |

## 写作约定

1. **写系统，不写过程。** "为什么这样设计"能写；"这次我做了什么 / 下一步做啥"不写。
2. **不留日期快照。** 没有"某天体检""某版本评审"这种文件 —— 结论要么进对应的设计文档，
   要么进 Issues。
3. **改代码顺手改文档。** 文档里写的路径、函数名、开关名必须能在仓库里找到
   （`server/scripts/check-consistency.mjs` 会盯其中几项）。
