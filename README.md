# pi-bot

手机和电脑上的 **pi agent 团队**。你发一句话，总经理拆活、部门老大接单、成员各自干活，结果回到你手上。

不是套壳聊天——底下是真正的 pi agent：能读写文件、跑命令、开子进程、调 MCP，产出直接落盘并作为附件发回来。

```
┌────────────────── 客户端（Flutter，一套代码两端）──────────────────┐
│  Windows：三栏（会话 / 对话 / 详情）· 无边框窗口 · 八向缩放          │
│  Android：会话列表 · 群聊流式输出 · 图片/文件渲染 · Markdown · 插话   │
└───────────────────────────────┬──────────────────────────────────┘
                                │ WSS + JSON（配对码换 token）
┌───────────────────────────────▼──────────────────────────────────┐
│  pi-bot server（Node 24，纯 ESM，无构建）                          │
│                                                                  │
│   总经理(main bot) ──► 部门(群) ──► 部门老大(lead) ──► 成员(member) │
│        │                  │              │              │        │
│        └── 下达任务 ──────┘              └── @同事派活 ──┘        │
│                                                                  │
│   每 (房间 × bot) 一个 AgentSession：bash / read / write / edit /  │
│   MCP / 子代理 / 附件解析 / 图片生成                              │
└──────────────────────────────────────────────────────────────────┘
```

## 下载

| 平台 | 文件 |
|---|---|
| **Windows** | [pi-bot-windows-v1.0.5.zip](https://github.com/loving-cat/pi-bot/releases/latest) — 解压双击 `pi_bot.exe`，免安装 |
| **Android** | [pi-bot-android-v1.0.5.apk](https://github.com/loving-cat/pi-bot/releases/latest) — 手机浏览器直接下载安装 |

**包里不含任何地址和密钥**——服务端地址、配对码、模型 baseUrl/API key 全部由你自己填（见下面「快速开始」）。

## 组织架构

| 角色 | 是什么 | 干什么 |
|---|---|---|
| **总经理**（`role: main`） | 主控 bot，唯一和你直接对话 | 听懂需求 → 决定交给哪个部门/谁 → 盯结果 → 给你交代。**只有只读文件工具**，负责指挥不负责动手 |
| **部门**（群） | 一群专才 | 有独立的 `leadBotId`（部门老大） |
| **部门老大** | 部门负责人 | 你在部门里发指令时**由它先接**：拆活 → `@同事` 派下去 → 汇总结果 |
| **成员** | 部门员工 | 只做被派到的事，能 `@同事` 协作，做完直接给结果 |

### 部门里的调度规则

- **`@名字` 就是调度信号**：写 `@后端工程师` 就是把活交给它，它会接着说话、去干。只写名字不带 `@` 只是提到，不触发发言。`@all` 叫全员。
- **全员并发**：一次被叫到的人**同时开干**，有几个成员就几个并发；**先后顺序由老大决定**（它 `@` 的顺序）。谁先干完谁先发言。
- **上级可以打断**：老大 / 主控 / 用户 `@` 一个正在忙的成员时，它会**先停下来汇报进度**、再按新要求继续；同级同事 `@` 它则进它的待办（不打断，也不丢）。
- **不静默丢弃**：派不出去、被跳过、被时间上限打断，都会在日志和群里留痕。
- **心跳看门狗**：谁卡死超过一段时间没动静 → 收尾这一轮，并把「这单断了」报给组长/主控。
- **预算**：老大每轮最多 4 次发言、成员 2 次；一条用户消息最多触发 10 次 bot 运行；单轮最多 30 个来回、最长 10 分钟。全部可在 App 的「部门预算」里改。

## 功能

**对话**
- 流式输出、Markdown 渲染（标题/列表/表格/引用/代码块+复制/链接）
- **中途插话**：它正在干活时你发的消息会被插进去改变它的做法（`steer`），不用等
- **消息来自 X**：转进这个会话的消息会标出来源，点开是**只读**的对话记录，链路可见
- **询问卡片**：拿不定主意时它摆几条路给你点，不用打一长串
- 长按消息复制；回车发送、Shift+回车换行；代码块一键复制

**多模态**
- 发图给它看（视觉模型直接读图）
- **拖拽 / 粘贴附件**（桌面端）：把图片、PDF、Word 直接拖进聊天框；在资源管理器里复制文件再粘进来也会自动变成附件
- 它画的图/导出的表格**自动作为附件发回来**
- 解析 PDF / Excel / Word / HTML / CSV / MD / JSON —— 正文自动抽出来喂给模型，同时落进 `_inbox/` 供它按需重读

**组织**
- 一句话建部门：`建一个 A股数据看板 部门，5 个人，产品经理当老大`
- 总经理可以随时往任何部门下达任务，也可以私信某个 bot 直接派活
- 部门里所有 bot 互相知道对方存在（花名册 / 部门列表 / 读部门聊天记录）
- **成员面板能自己加 bot**：不用再跟主控说

**运维**
- **模型菜单完全来自你自己配的模型组**（任何 OpenAI 兼容接口：baseUrl + key + 模型名）
- 实测探活 + **档位矩阵**（模型 × 思考等级，自动避开会静默吐空的组合）
- **空回复自动兜底**：模型静默吐空 或 调完工具不给结论 → 自动催一次 → 再切最稳模型补一段 → 都不行才报错，绝不给你一片空白
- **工程基线**：造开发类 bot 时自动挂上一份通用工程铁律（先读再改、破坏性操作先问、跑通测试才算完、不许静默丢活…）
- 上下文占用可见 + 自动压缩（对话里留一条小横条，不让你以为消息丢了）
- 会话 LRU、脏房间增量落盘、流式更新细粒度通知

## 快速开始

### 1. 起服务端

```bash
cd server
npm install
node src/index.js
```

终端会直接打印**地址和配对码**：

```
  ┌─ 手机连接 ────────────────────────────────────┐
  │  在 pi-bot App 的配对页填下面这两项             │
  └───────────────────────────────────────────────┘
  有效地址   http://192.168.1.100:8787
             http://192.168.1.100:8787      (以太网)
  配对码     821402   （10 分钟轮换）
  网页版     http://192.168.1.100:8787/pair     ← 手机上不想手输地址就开这个
```

> 地址会**自动挑手机连得上的那张网卡**——开着 VPN 时机器上会多出 TUN 网卡
> （如 `198.18.x`），那种地址手机连不上，程序会把它排在真局域网后面。

### 2. 电脑端（宿主）

解压 Windows 包，双击 `pi_bot.exe`。桌面端就是宿主，启动时会自动把服务端跑起来：

1. 先探本机 `127.0.0.1:8787`，已有服务端就直接连（不会重复启动）；
2. 没有就定位 `server/src/index.js`（exe 同级 → 上层目录 → `PI_BOT_SERVER`）；
3. 定位 node（exe 同级 → Program Files → PATH → `PI_BOT_NODE`），要求 22+；
4. 首次缺少 `node_modules` 时自动执行 `npm install`；
5. 启动后轮询 `/health`，就绪即进主界面。

服务端与界面解耦：关掉界面服务端仍在，再次打开直接连上；服务端异常退出会按退避间隔自动重启。

需要改端口 / 数据目录 / node 路径：设置 →「本机服务端」（留空即自动探测，保存后自动重启）。

数据存放在**用户目录**，与安装位置无关：

| 平台 | 数据目录 |
|---|---|
| Windows | `%LOCALAPPDATA%\pi-bot\data` |
| macOS | `~/Library/Application Support/pi-bot/data` |
| Linux | `$XDG_DATA_HOME/pi-bot/data`（默认 `~/.local/share/pi-bot/data`） |

里面有 `rooms/`（会话消息）、`sessions/`（agent 会话）、`uploads/`（附件）、
`workspace/`（bot 的工作目录）、`state.json`。备份就备份这一个目录。

### 3. 手机端

装 APK → 在配对页填服务端地址（`http://<你电脑的IP>:8787`）+ 配对码 → 连接。

> 手机和电脑要在**同一个局域网**里。没有云端中转，服务端就跑在你自己机器上。

### 4. 配模型

两条路，任选：

- **用你本机已配好的 pi**（`~/.pi/agent`）——启动时会自动导入成「正在用」的模型组。
- **在 App 里自己加一组**：设置 →「模型」→ 新建 → 填 `baseUrl` + `API key` →
  点「测试连接」拉出模型列表 → 勾上你要用的。任何 OpenAI 兼容接口都行。

> 自检：`node server/tools/check-model-runtime.mjs`
> 它会照 App 的方式新建一个模型组、造个临时 bot 真跑一句话，然后自己清理干净。
> 模型菜单"绿不绿"证明不了能不能真跑——这个脚本才是真的发一句话。

## 目录

```
server/
  src/
    index.js          启动 + 终端打印地址与配对码
    pi-runner.js      ★ 核心：会话管理、单轮运行、部门轮次引擎（并发/打断/心跳）
    tools.js          工具集（通用 + 总经理专属）
    store.js          状态与持久化（bot/部门/消息/游标/轮次预算）
    mentions.js       ★ @提及解析（调度信号）
    model-menu.js     模型菜单（来自用户自己配的模型组）
    model-groups.js   模型组：CRUD + 连通性测试 + 转成 pi 的 provider
    model-health.js   模型/档位探活
    coding-baseline.js  ★ 开发类 bot 自动挂载的工程铁律
    attachments.js    附件存取
    extract.js        PDF/Excel/Word/HTML 正文提取
    http.js / ws.js   REST + WebSocket
    pairing.js        配对码 + 网卡挑选（自动避开 VPN 的 TUN 地址）
  tools/
    check-model-runtime.mjs   模型自检（真跑一句话）
  tests/
    unit.mjs          104 项单元测试（不需要网络/模型）
    room-lock.mjs     群调度回归：并发/终止/打断/投递/竞态
    bench.mjs         性能基准（1 万条消息）
    model-matrix.mjs  模型 × 思考等级 全矩阵
    smoke.mjs / attach.mjs / steer.mjs / extract.mjs   端到端
app/
  lib/
    theme.dart        ★ 设计系统（颜色/字阶/圆角，逐点校准）
    app_state.dart    全局状态 + WebSocket
    widgets/
      blob_avatar.dart     会呼吸的彩色 blob 头像（眼睛跟着鼠标看）
      md_text.dart         Markdown 渲染器（零依赖）
      room_panel.dart      右侧面板：详情 / 资料库 / 成员
      bot_run_section.dart 面板里就地改模型 / 思考等级 / 上下文预算
      ask_card.dart        询问卡片
      msg_ref_chip.dart    「消息来自 X」+ 只读窥视
    screens/
      home_shell.dart      宽屏左右分栏 / 窄屏单页
      rooms_screen.dart    会话列表
      chat_screen.dart     对话
      bots_screen.dart     花名册
      settings_screen.dart 设置（远程连接 / 模型组 / 部门预算）
      pair_screen.dart     配对（地址 + 配对码）
  tools/
    icons.cjs         图标生成
docs/
  PITFALLS.md         ★ 踩过的坑与修法（含 Flutter/Windows/DPI/字体/并发）
```

## 测试

```bash
cd server
node tests/unit.mjs          # 104 项单测，不需要网络/模型
node tests/room-lock.mjs     # 群调度回归（并发 / 终止 / 打断 / 竞态）
node tests/bench.mjs         # 性能基准（1 万条消息）

cd ../app
flutter test                 # 124 项测试（含启动层：入口定位 / node·npm 定位 / 探活）
flutter analyze
```

`scripts/pack-windows.ps1` 生成可分发目录（exe + server + 依赖）：
`-WithNode` 附带 `node.exe`（目标机器无需安装 Node），`-Zip` 同时打包压缩文件。

## 环境变量

见 `server/.env.example`。常用：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PI_BOT_PORT` | 8787 | 端口 |
| `PI_BOT_MODEL` | 自动 | 默认模型（来自你的模型组） |
| `PI_BOT_TOKEN` | — | 固定 token（设了就跳过配对码） |
| `PI_BOT_HOME` / `PI_BOT_WORKSPACE` | 用户数据目录（见上表） | 数据目录 / agent 的工作目录 |
| `PI_BOT_GROUP_MAX_STEPS` | 30 | 部门里单轮最多几个来回（**对话轮次**，不是工具调用次数） |
| `PI_BOT_GROUP_TURN_MAX_MS` | 600000 | 部门里单轮最长跑多久 |
| `PI_BOT_GROUP_BUSY_WAIT_MS` | 120000 | 要派的活碰上成员正忙，最多等它多久 |
| `PI_BOT_HEARTBEAT_MS` / `PI_BOT_STALL_MS` | 15000 / 360000 | 心跳间隔 / 多久没动静算断了 |
| `PI_BOT_MAX_SESSIONS` | 40 | 驻留会话上限（LRU） |
| `PI_BOT_RUN_TIMEOUT_MS` | 600000 | 单轮硬超时 |

## 安全

- 远程设备必须配对拿 token；**回环地址（127.0.0.1）免 token**——电脑端就是宿主
- bot 有 `bash`/`write`，**不要裸奔到公网**。公网部署请套 nginx + HTTPS，并只给固定 token
- 所有工具的文件操作都被限制在 `data/workspace` 内
- 仓库本身**不含任何密钥、本机路径、内网地址**——全部走用户级配置或环境变量

## 灵感与致谢

这个项目在设计和机制上参考了开源项目，**只学做法，没有抄代码、命名和标志性动效**：

- **[DeepSeek-Bot](https://github.com/Fei2411/DeepSeek-Bot)**（Apache-2.0）
  学的是：`@名字` 作为调度信号、部门/花名册的组织方式、群里"谁在说话"的轮次与并发模型
  （它的 `round.slots` 与 *"Work does not hold a round up"* 直接影响了我们的群调度设计：
  顺序由组长定、执行全员并行、忙的人不阻塞这一轮）、以及"投递进对方 inbox"而不是死等。
- **一个商业桌面 agent 客户端**
  学的是：左侧会话列表 + 右侧详情的两栏骨架、胶囊式的会话头部、消息归属提示
  （「消息来自 X」）这类信息层级的处理方式。

同时刻意**不抄**：命名体系、头像形体名、特征性动效参数。配色可以对齐，因为那是审美取向，不是实现。

如果你觉得某个机制值得再看，欢迎提 issue。

## License

见 [LICENSE](LICENSE)。
