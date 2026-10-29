# pi-bot

手机和电脑上的 **pi agent 团队**。你发一句话，总经理拆活、部门老大接单、成员各自干活，结果回到你手上。

不是套壳聊天——底下是真正的 pi agent：能读写文件、跑命令、开子进程、调 MCP，产出直接落盘并作为附件发回来。

```
┌────────────────── 客户端（Flutter，一套代码两端）──────────────────┐
│  Windows/macOS：桌面宿主 · 会话 / 对话 / 详情 · 自启本机服务端     │
│  Android：会话列表 · 群聊流式输出 · 图片/文件渲染 · Markdown · 插话   │
└───────────────────────────────┬──────────────────────────────────┘
                                │ WSS + JSON（配对码换 token）
┌───────────────────────────────▼──────────────────────────────────┐
│  pi-bot server（Node 22+，纯 ESM，无构建）                         │
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
| **Windows** | [Windows 免安装包](https://github.com/loving-cat/pi-bot/releases/latest)（`pi-bot-windows-*.zip`）— 解压双击 `pi_bot.exe`，免安装；从源码打包见 [Windows 构建说明](docs/WINDOWS.md) |
| **Android** | [Android APK](https://github.com/loving-cat/pi-bot/releases/latest)（`pi-bot-android-*.apk`）— 手机浏览器直接下载安装 |
| **macOS** | 从源码运行 `./scripts/pack-macos.sh` 生成 App 与 DMG，见 [macOS 构建说明](docs/MACOS.md) |

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
- **预算**：老大和成员每轮各最多 15 次发言；一条用户消息最多触发 100 次 bot 运行；单轮最多 30 个来回、默认最长 10 分钟。全部可在 App 的「部门预算」里改。

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
- **独立模型卡片**：Windows/macOS 共用，每个模型分别填写 ID、显示名、上下文窗口与最大输出（tokens）
- 实测探活 + **档位矩阵**（模型 × 思考等级，自动避开会静默吐空的组合）
- **空回复恢复**：真正空回复或操作后无结论时催一次，再限于本轮选中模型和默认模型补答；认证失败直接展示脱敏后的 HTTP 状态，不再归为思考档位问题
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

Windows 解压后打开 `pi_bot.exe`；macOS 打包后打开 `dist/pi-bot.app`。
目标机器需安装 Node 22+。桌面端就是宿主，启动时会自动把服务端跑起来：

1. 先探本机 `127.0.0.1:8787`，已有服务端就直接连（不会重复启动）；
2. 没有就定位 `server/src/index.js`（用户设置、`PI_BOT_SERVER`、App Resources、可执行文件同级或上层目录）；
3. 定位 Node（用户设置、`PI_BOT_NODE`、应用目录、PATH；按平台补查常见安装目录）；
4. 首次缺少 `node_modules` 时自动执行 `npm install`；
5. 启动后轮询 `/health`，就绪即进主界面。

服务端与界面解耦：关掉界面服务端仍在，再次打开直接连上；服务端异常退出会按退避间隔自动重启。

需要改端口 / 数据目录 / Node 路径：设置 →「本机服务端」（路径留空即自动探测，保存后自动重启）。
启动失败页也提供同一配置入口。

macOS 首次原生构建需要完整 Xcode 与 Flutter macOS desktop：

```bash
flutter config --enable-macos-desktop
./scripts/pack-macos.sh
```

产物为 `dist/pi-bot.app` 和 `dist/pi-bot-<服务端版本>.dmg`；服务端和生产依赖在 App 内，
Node 仍由目标机器提供。已有 Release App 时，`./scripts/pack-macos.sh --no-build` 可跳过
Xcode 检查与 Flutter 构建，仅重新组装安装包。当前使用 ad-hoc 签名，未做 Developer ID
公证；`--clear-quarantine` 为可选参数，默认关闭。完整步骤与待验项目见 [docs/MACOS.md](docs/MACOS.md)。

数据存放在**用户目录**，与安装位置无关：

| 平台 | 数据目录 |
|---|---|
| Windows | `%LOCALAPPDATA%\pi-bot\data` |
| macOS | `~/Library/Application Support/pi-bot/data` |
| Linux | `$XDG_DATA_HOME/pi-bot/data`（默认 `~/.local/share/pi-bot/data`） |

里面有 `rooms/`（会话消息）、`sessions/`（agent 会话）、`uploads/`（附件）、
`workspace/`（bot 的工作目录）、`state.json`、`secret.key`（加密密钥）。备份就备份这一个目录。

> 从 1.1 之前的版本升级：启动时会把旧的 `server/data` 搬到上面的目录，只搬会话、消息、附件和配置。
> **bot 的工作目录不搬**（里面常有几百 MB 的 `.venv`），继续用旧位置的 `server/data/workspace`，
> 所以旧目录**不要删**。想把工作目录也换地方，用 `PI_BOT_WORKSPACE` 指定。

### 3. 手机端

装 APK → 在配对页填服务端地址（`http://<你电脑的IP>:8787`）+ 配对码 → 连接。

> 手机和电脑要在**同一个局域网**里。没有云端中转，服务端就跑在你自己机器上。

### 4. 配模型

两条路，任选：

- **用你本机已配好的 pi**（`~/.pi/agent`）——启动时会自动导入成「正在用」的模型组。
- **在 App 里自己加一组**：设置 →「模型」→ 新建 → 填 `baseUrl` + `API key` →
  选择接口类型 → 为每个模型添加独立卡片，填写模型 ID；显示名可留空使用 ID。
  每张卡片可分别设置上下文窗口与最大输出，保存后供 Bot 选择。

容量单位为 tokens，填正整数且最大输出不超过上下文窗口；已有模型留空保留原值，
新模型留空使用服务端默认值。容量须按接口实际支持的值填写。编辑已有组时，API key
留空保留原凭据；“测试连接”的模型列表可达不等于推理鉴权已通过。

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
    model-thinking.js 思考强度：会不会思考 / 各档位映射 / 上游思考格式（纯逻辑）
    mcp.js            MCP 服务库：规范化 + 校验 + 转成 pi 的 mcpServers
    mcp-hook.js       按 bot 选择把 MCP 注册进会话（默认一个都不连）
    model-health.js   模型/档位探活
    coding-baseline.js  ★ 开发类 bot 自动挂载的工程铁律
    attachments.js    附件存取
    extract.js        PDF/Excel/Word/HTML 正文提取
    http.js / ws.js   REST + WebSocket
    pairing.js        配对码 + 网卡挑选（自动避开 VPN 的 TUN 地址）
  tools/
    check-model-runtime.mjs   模型自检（真跑一句话）
  tests/
    all.mjs           服务端统一测试入口（无需真实模型）
    unit.mjs          通用单元测试
    room-lock.mjs     群调度回归：并发/终止/打断/投递/竞态
    bench.mjs         性能基准（1 万条消息）
    model-matrix.mjs  模型 × 思考等级 全矩阵
    smoke.mjs / attach.mjs / steer.mjs   真实服务端集成测试
    extract.mjs       自建文件样本解析测试
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
  PLATFORMS.md        ★ 平台边界：一条主干、所有平台目录共存、改动检查单
  WINDOWS.md          Windows 构建 / 平台实现 / 真机验收
  MACOS.md            macOS 构建 / 平台实现 / 真机验收
  PITFALLS.md         ★ 踩过的坑与修法（含 Flutter/Windows/DPI/字体/并发）
```

## 测试

```bash
cd server
node tests/all.mjs           # 统一测试入口，无需起真实服务端或配置模型
node tests/relay.mjs         # 额外中转回归：本机随机端口和假服务端
node tests/relay-limits.mjs  # 额外中转边界与故障回归
node tests/extract.mjs       # 自建样本解析，不设置外部样本环境变量
node tests/bench.mjs         # 本地性能基准

cd ../app
flutter test
flutter analyze
```

`scripts/pack-windows.ps1` 生成可分发目录（exe + server + 依赖）。默认把应用源码复制到
系统临时目录再构建 Release，产物回填到原来的 Release 路径，临时副本用完即删。
`-WithNode` 附带 `node.exe`（目标机器无需安装 Node），`-Zip` 同时打包压缩文件，
`-NoBuild` 复用已有 Release 产物，`-SkipDeps` 不预装服务端依赖。
打包会先暂存再换成品；发行目录里若残留本机绝对路径、`.pdb`、`.pi`、`_inbox`、
`server/.env` 或日志，脚本会失败并保留上一版。完整步骤、平台实现与真机验收记录见
[docs/WINDOWS.md](docs/WINDOWS.md)；macOS 使用 `./scripts/pack-macos.sh`，
详见 [构建与验收清单](docs/MACOS.md)。

## 环境变量

模块职责见 [`docs/MODULE-MAP.md`](docs/MODULE-MAP.md)（找东西先看那张表）。
平台边界与跨平台改动检查单见 [`docs/PLATFORMS.md`](docs/PLATFORMS.md)。

**测试**：`cd server && npm test` 等同 `node tests/all.mjs`，具体测试文件以入口列表为准；
端到端冒烟 `npm run test:integration` 需要先起隔离服务端并配置可用模型，会发送真实模型请求。

**跨网访问**：默认就是局域网直连（手机连电脑的 IP）。想在外网用，可以套现成隧道
（frp / Cloudflare Tunnel / Tailscale），或使用仓库附带的中转模块 —— 接口与用法见
[`docs/RELAY.md`](docs/RELAY.md)。中转是可选的，默认不启动。

**关于 token 的位置**：手机/桌面端把 token 放在 `Authorization` 头里；附件 URL
（`/api/files/:id?token=…`）为了给 `<img>` 直接用，token 在 query 里 —— 局域网自用可以接受，
但如果你把服务端暴露到公网，请换成反向代理注入鉴权，别让 token 进访问日志。

见 `server/.env.example`。常用：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PI_BOT_PORT` | 8787 | 端口 |
| `PI_BOT_MODEL` | 自动 | 默认模型（来自你的模型组） |
| `PI_BOT_TOKEN` | — | 固定 token（设了就跳过配对码）。**设了就是服务器模式**：本机请求也要带 token |
| `PI_BOT_TRUST_LOCAL` | 没设 token 时 `1`，设了时 `0` | 本机（127.0.0.1）请求免不免 token。一般不用改 |
| `PI_BOT_ALLOWED_HOSTS` | — | 额外允许的域名（逗号分隔）。反向代理保留原始 Host 时填你的域名 |
| `PI_BOT_HOME` / `PI_BOT_WORKSPACE` | 用户数据目录（见上表） | 数据目录 / agent 的工作目录 |
| `PI_BOT_GROUP_BUSY_WAIT_MS` | 120000 | 要派的活碰上成员正忙，最多等它多久 |
| `PI_BOT_HEARTBEAT_MS` / `PI_BOT_STALL_MS` | 15000 / 360000 | 心跳间隔 / 多久没动静算断了 |
| `PI_BOT_MAX_SESSIONS` | 40 | 驻留会话上限（LRU） |
| `PI_BOT_RUN_TIMEOUT_MS` | 600000 | 单轮硬超时 |

## 安全

- 远程设备必须配对拿 token；**本机部署时回环地址（127.0.0.1）免 token**——电脑端就是宿主
- bot 有 `bash`/`write`，**不要裸奔到公网**。公网部署请套 nginx + HTTPS，并设 `PI_BOT_TOKEN`：
  - 设了 `PI_BOT_TOKEN` 就是**服务器模式**，本机请求也要带 token。反向代理和服务端在同一台机器上时，
    公网请求经代理转发后在服务端看来就是 127.0.0.1，免 token 等于谁都能进
  - 代理保留了原始 Host（`proxy_set_header Host $host;`）时，把域名加进 `PI_BOT_ALLOWED_HOSTS`，
    否则会被 DNS rebinding 防护拒掉（`403 bad host`）
  - 服务器模式下 `/health` 仍然公开（探活要用），但只给服务名、版本和鉴权方式，不给房间数、模型名
  - 桌面端连服务器模式的本机服务端时，连接页会让你填这个 token
- 只读 / 需要批准 / 命令黑白名单管的是 bot 的**工具调用**，不是沙箱。本机部署时 bot 能执行命令，就能用 `curl`
  调本机接口改掉这些设置。要真的限制 bot，就把危险动作设成「只读」，它就拿不到 shell
- 所有工具的文件操作都被限制在 `data/workspace` 内
- 命令黑名单 / 白名单默认都是空的。**一条都没配时，行为和改动前完全一致**，`npm` / `git` / `node` 以及 `sh -c 'git status'` 不会被拦
- **配了任一规则之后**，`sh -c` / `bash -c`、`xargs <命令>`、解释器调用会拒绝，只放行 `--version` / `-V` / `--help`。白名单只有 `git status` 时，`sh -c 'git status'` 也会被拒，直接写 `git status` 可以。`rm -rf` 这类规则会拆开短选项，并把 `rm` 的 `--recursive` / `--force` 当成 `-r` / `-f`
- 黑名单看不到脚本文件、Makefile、`npm` scripts 里面的命令。字符串规则盖不住这些入口，长期方案是沙箱，另行立项。`awk` 的 `system`、`vim -c`、`npx`、`make` 等间接执行也没有列全；要严格限制，请用白名单模式，或把危险操作设为“需要批准”。详见 [docs/AGENT-MODEL.md](docs/AGENT-MODEL.md)
- 子进程（bash / powershell、后台命令、MCP 本地服务）只继承白名单：`PATH`、`HOME`、`USER` / `USERNAME` / `LOGNAME`、`SHELL`、`TERM`、`LANG`、`LC_*`、`TMPDIR` / `TEMP` / `TMP`、`PI_CODING_AGENT_DIR`、`XDG_*`、`SSH_AUTH_SOCK`、`GIT_SSH*`、`NODE_EXTRA_CA_CERTS`、`SSL_CERT_*`、`DISPLAY`，以及名字以 `_PROXY` 结尾的代理变量。`PI_BOT_*` 也会继承，但 `PI_BOT_TOKEN` 和 `PI_BOT_SECRET_KEY` 除外。Windows 启动还要这些（比较时不分大小写）：`SystemRoot`、`windir`、`SystemDrive`、`ComSpec`、`PATHEXT`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`HOMEDRIVE`、`HOMEPATH`、`ProgramFiles`、`ProgramFiles(x86)`、`ProgramData`、`PSModulePath`、`NUMBER_OF_PROCESSORS`、`PROCESSOR_ARCHITECTURE`、`OS`、`PUBLIC`。`*_API_KEY`、`*_TOKEN`、`*_SECRET` 不会因为父进程里有就传下去
- AWS、gcloud 等云凭证仍然不传给子进程。pi 子 agent 是例外：只有 `runPiCli` 拉起它时，按当前模型把对应 provider 的 key 显式放进环境。派子 agent 时如果先起的是本程序自己的入口脚本，这一跳也会带上这把 key；别的 `index.js` 不会。bash、后台命令和 MCP 默认拿不到。某个 MCP 服务自己要用的变量，写在这个服务配置的显式 `env` 里，例如 `OPENAI_API_KEY=test-key-a`
- 站点口令和模型组 API key 用 AES-256-GCM 落在数据目录里，不写明文。密钥默认是 `<数据目录>/secret.key`（权限 0600）。设置了 `PI_BOT_SECRET_KEY`（32 字节的 hex 或 base64）就用环境变量，此时不读、不写 `secret.key`。密钥丢失或换错后，已经加密的口令和 key 无法还原：操作会报错，不会把密文写成空
- 仓库本身**不含任何密钥、本机路径、内网地址**——全部走用户级配置或环境变量

## 参考与许可

- [DeepSeek-Bot](https://github.com/Fei2411/DeepSeek-Bot)（Apache-2.0）。

## License

见 [LICENSE](LICENSE)。
