# pi-bot

手机上的 **pi agent 团队**。你在群里发一句话，总经理拆活、部门老大接单、成员各自干活，结果回到你手机上。

不是套壳聊天——底下是真正的 pi agent，能读写文件、跑命令、开子进程、调 MCP，产出直接落盘并作为附件发回来。

```
┌───────────────────────── 手机 App（Flutter / 真 APK）─────────────────────────┐
│  扫码配对 · 会话列表 · 群聊流式输出 · 图片/文件渲染 · Markdown · 插话引导      │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │ WSS + JSON（token 鉴权）
┌──────────────────────────────────▼───────────────────────────────────────────┐
│  pi-bot server（Node 24，纯 ESM，无构建）                                      │
│                                                                              │
│   总经理(main bot) ──► 部门(群) ──► 部门老大(lead) ──► 成员(member)            │
│        │                  │              │                  │                │
│        └── 下达任务 ──────┘              └── @同事派活 ─────┘                │
│                                                                              │
│   每 (房间 × bot) 一个 AgentSession：bash / read / write / edit / MCP /       │
│   subagent / 附件解析 / 图片生成                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 组织架构

| 角色 | 是什么 | 干什么 |
|---|---|---|
| **总经理**（`role: main`） | 主控 bot，唯一和你直接对话 | 听懂需求 → 决定交给哪个部门/谁 → 盯结果 → 给你交代。**只有只读文件工具**，负责指挥不负责动手 |
| **部门**（群） | 一群专才 | 有独立的 `leadBotId`（部门老大） |
| **部门老大** | 部门负责人 | 你在部门里发指令时**由它先接**：拆活 → `@同事` 派下去 → 汇总结果 |
| **成员** | 部门员工 | 只做被派到的事，能 `@同事` 协作，做完直接给结果 |

**`@名字` 就是调度信号**：写 `@后端工程师` 就是把发言权交给它，它会接着说话、去干你派的活。只写名字不带 `@` 就只是提到，不触发发言。`@all` 叫全员。

轮次预算：老大每轮最多 4 次发言，成员 2 次，一条用户消息最多触发 10 次 bot 运行——防止部门内部无限互吹。

## 快速开始

### 1. 起服务端

```bash
cd server
npm install
node src/index.js
```

终端会直接打印一个**二维码**：

```
  ┌─ 手机配对 ────────────────────────────────────┐
  │  用 pi-bot App 里的「扫码配对」扫下面这个码     │
  └───────────────────────────────────────────────┘
  ▄▄▄▄▄▄▄ ▄▄ ▄▄▄▄  ▄ ▄▄▄   ▄  ▄ ▄▄▄▄▄▄▄
  █ ▄▄▄ █ █ ▄▀▀ ▀▄ ███   ▄██  ▄ █ ▄▄▄ █
  ...
  配对码     821402   （10 分钟轮换）
  有效地址   http://192.168.1.100:8787
  网页版     http://192.168.1.100:8787/pair
```

### 2. 电脑端（宿主）

```bash
cd app && flutter build windows --release
build/windows/x64/runner/windows/Release/pi_bot.exe
```

**电脑端不需要配对** —— 服务端就跑在这台机器上，回环请求直接信任，启动即进首页。

### 3. 手机端

```bash
cd app && flutter build apk --release
# 产物：app/build/app/outputs/flutter-apk/app-release.apk
```

装上 → 点「扫码配对」→ 扫电脑终端里那个码（或电脑端 **设置 → 远程连接** 里的大二维码）→ 自动填地址和配对码并连上。

## 功能

**对话**
- 流式输出、Markdown 渲染（标题/列表/表格/引用/代码块+复制/链接）
- **中途插话**：它正在干活时你发的消息会被插进去改变它的做法（`steer`），不用等
- 长按消息复制；回车发送、Shift+回车换行；代码块一键复制

**多模态**
- 发图给它看（视觉模型直接读图）
- 它画的图/导出的表格**自动作为附件发回来**
- 解析 PDF / Excel / Word / HTML / CSV / MD / JSON —— 正文自动抽出来喂给模型，同时落进 `_inbox/` 供它按需重读

**组织**
- 一句话建部门：`建一个 A股数据看板 部门，5 个人，产品经理当老大`
- 总经理可以随时往任何部门下达任务，也可以私信某个 bot 直接派活
- 部门里所有 bot 互相知道对方存在（花名册 / 部门列表 / 读部门聊天记录）

**运维**
- 模型白名单（只准你自己列的那几个），实测探活
- **空回复自动兜底**：模型静默吐空 或 调完工具不给结论 → 自动催一次 → 再切最稳模型补一段 → 都不行才报错，绝不给你一片空白
- 会话 LRU、脏房间增量落盘、流式更新细粒度通知

## 目录

```
server/
  src/
    index.js         启动 + 终端二维码
    pi-runner.js     ★ 核心：会话管理、单轮运行、部门轮次引擎
    tools.js         工具集（通用 + 总经理专属）
    store.js         状态与持久化（bot/部门/消息/游标）
    mentions.js      ★ @提及解析（调度信号）
    model-menu.js    模型白名单
    model-health.js  模型/档位探活
    attachments.js   附件存取
    extract.js       PDF/Excel/Word/HTML 正文提取
    http.js / ws.js  REST + WebSocket
    pairing.js       配对码 + 二维码
  tests/
    unit.mjs         33 项单元测试
    bench.mjs        性能基准
    model-matrix.mjs 模型 × 思考等级 全矩阵
    smoke.mjs / attach.mjs / steer.mjs / extract.mjs   端到端
app/
  lib/
    theme.dart       ★ 设计系统（颜色/字阶/圆角，逐点校准）
    app_state.dart   全局状态 + WebSocket
    widgets/
      blob_avatar.dart  会呼吸的彩色 blob 头像
      md_text.dart      Markdown 渲染器（零依赖）
      attachment_view.dart
    screens/
      home_shell.dart    宽屏左右分栏 / 窄屏单页
      rooms_screen.dart  会话列表
      chat_screen.dart   对话
      bots_screen.dart   花名册
      settings_screen.dart 设置（含远程连接二维码）
      pair_screen.dart / scan_screen.dart
```

## 测试

```bash
cd server
node tests/unit.mjs          # 33 项单测，不需要网络/模型
node tests/bench.mjs         # 性能基准（1 万条消息）
node tests/model-matrix.mjs  # 模型 × 思考等级 矩阵（需要模型额度）
node tests/smoke.mjs http://127.0.0.1:8787 "" "消息"   # 端到端
```

## 环境变量

见 `server/.env.example`。常用：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PI_BOT_PORT` | 8787 | 端口 |
| `PI_BOT_MODEL` | 自动 | 默认模型（白名单内） |
| `PI_BOT_TOKEN` | — | 固定 token（设了就跳过配对码） |
| `PI_BOT_GROUP_MAX_STEPS` | 30 | 部门里单轮最多动手几步 |
| `PI_BOT_GROUP_TURN_MAX_MS` | 300000 | 部门里单轮最长跑多久 |
| `PI_BOT_MAX_SESSIONS` | 40 | 驻留会话上限（LRU） |

## 安全

- 远程设备必须配对拿 token；**回环地址（127.0.0.1）免 token**——电脑端就是宿主
- bot 有 `bash`/`write`，**不要裸奔到公网**。公网部署请套 nginx + HTTPS，并只给固定 token
- 所有工具的文件操作都被限制在 `data/workspace` 内
