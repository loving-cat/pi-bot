# 架构与设计决策

## 一、组织结构与调度机制

客户端使用会话列表与对话区分栏布局。服务端以房间保存共享消息，以 bot 区分执行会话，
部门负责人负责分配任务和汇总结果。

| 机制 | 判定规则 | 模块 |
|---|---|---|
| 提及调度 | `@名字` 触发成员运行；不带 `@` 只表示提及；`@all` 调用除发言者外的成员 | `server/src/mentions.js` |
| 首发选择 | 点名优先；无点名或部门刚建立时由负责人接单 | `server/src/group-prompt.js` 的 `openingSpeakers()` |
| 轮次预算 | 默认负责人 4 次、普通成员 2 次、每条消息最多触发 10 次运行；设置值由 `store.groupLimits()` 提供 | `server/src/store.js`、`server/src/group-round.js` |
| 消息可见性 | `room.cursors[botId]` 记录已读位置，按条数与字符预算提取成员尚未读取的已完成消息 | `server/src/group-prompt.js`、`server/src/transcript-budget.js` |
| 忙碌调度 | 用户新需求或上级调用可打断；同级调用投递到收件队列，避免互相中断 | `server/src/group-round.js` |
| 执行会话 | 每个房间与 bot 的组合独立创建会话，工具集由角色与策略共同决定 | `server/src/session-factory.js` |
| 跨部门派发 | 主控通过 `dispatch_to_department` 将工作说明交给部门负责人 | `server/src/tools.js` |

## 二、部门轮次引擎（`pi-runner.runRound`）

```
用户发消息
   │
   ├─ 追加到共享房间记录
   │
   ├─ openingSpeakers() 决定首发人
   │     · @点名 → 只叫被点名的
   │     · @all  → 除自己外全员
   │     · 否则  → 部门老大
   │
   └─ 循环：
        取出队列项 → 检查预算与忙碌状态 → 派发可运行成员
           │
           ├─ 同一批可运行成员并发执行，运行任务记入 pending
           ├─ 提示词 = 花名册 + 未读群记录 + 当前任务 + 角色规则
           ├─ 输出为 [PASS] 时删除占位消息
           ├─ 回复中的 @成员进入待调度队列
           └─ 队列为空时等待运行结果，再判断是否继续或进入收尾
```

终止条件由 `shouldStopRound()` 统一判断：用户终止、插话使旧轮失效、队列与运行任务均为空，
或待派发任务达到本轮运行预算。单成员预算耗尽时跳过该成员。

**并发与依赖**：同批任务并发减少等待时间；需要前序结果的任务由后续提及触发。
每次派发读取当时已完成的共享记录，同批成员不会看到彼此尚未完成的输出。
成员结果晚于负责人最近发言时，`planClosing()` 决定是否追加负责人收尾。

## 三、提示词工程（部门场景）

老大和成员用**两套规则**，这是让组织架构真正跑起来的关键：

**老大**：
```
1. 先把要求拆成几件具体的活，判断每一件该交给谁。
2. 用 @同事名字 把活派出去——被 @ 的人会接着发言去干。一次可以分别 @ 不同的人。
3. 自己别闷头把活全干完；只有「确实只有你能干」的那部分才自己做。
4. 大家交完结果后，用几句话给用户一个结论（别再复述他们的原文）。
5. 如果这条消息只是闲聊、确认、或者根本不用动手，就直接回答，不要派活。
```

**成员**：
```
1. 老大或同事 @ 你，就是要你干这件事：把它做完，直接给结果。
2. 需要别人配合，就 @对方名字，把那部分交给它。
3. 不要复述别人的话，不要客套，不要总结全场。
4. 不需要你出手就只输出 [PASS]。
```

第 5 条（"只是闲聊就直接回答"）是实测加上的：早期版本里，用户说"大家报一下各自负责什么"，成员会真的开始动手建文件、跑数据源探测——把"汇报"理解成"开工"。

## 四、可靠性：三层空回复兜底

实测发现「模型静默返回空内容」是**间歇性**的（不是固定的模型×档位组合），而且有两种形态：

| 形态 | 现象 |
|---|---|
| a | 完全没输出，`assistant.content = []`，usage 全 0 |
| b | 工具调了一堆，但最后一条 assistant 是空的 → 用户只看到"操作了但没说结论" |

处理链（`pi-runner.run`）：

1. 空 → **同会话催一次**：`你刚才调用了工具（X、Y）但没有给出结论。请用一两句话说明…`
2. 还空 → **切默认模型兜底**：用 `completeSimple`（不带工具）把原任务 + 已执行的操作清单丢给最稳的模型，让它给个结论
3. 还空 → **明确报错** + 把操作清单渲染出来，而不是显示 "(没有返回文本)"

另外 `model-health.runLevelMatrix()` 会对白名单模型跑「模型 × 思考等级」矩阵，已知会空的组合会被 `safeLevel()` 自动避开。

## 五、性能

一万条消息（20 部门 × 500 条）下的实测（`tests/bench.mjs`）：

| 路径 | 耗时 |
|---|---|
| `roomSummary × 20`（`/api/state` 热点） | 0.011 ms |
| `listMessages(500) × 20` | 0.011 ms |
| `appendMessage × 1000` | 3.3 ms（3.3 µs/条） |
| `saveNow()`（1 个脏房间） | 2.9 ms |
| `parseMentions × 1000` | 5.0 ms |

三个关键优化：

1. **脏房间增量落盘**：之前每次变更都把全部房间的消息文件重写一遍（20 房间 ≈ 58ms）。现在只写有变更的（2.9ms）。
2. **`roomSummary` 不再两次 slice**：直接读数组尾部和长度。
3. **App 流式更新走独立 `ValueNotifier`**：`msg.delta` / `msg.steps` 每 80ms 一次，如果走 `notifyListeners()` 会把整棵树（含左侧会话列表）重建。现在只有消息列表订阅这个 tick。

## 六、UI 设计系统

颜色不是猜的。规则先定死：中性面只留 7 个色阶、界面角色按固定索引取；半透明色一律用「墨色按 alpha 叠底」推导。最后逐点校准：

| 层 | 色值 |
|---|---|
| 侧栏 | `#0E0E0E` |
| 聊天区 | `#121212` |
| 气泡 | `#1B1B1B` |
| 圆按钮 | `#1F1F1F` |
| 文字 | `#F2F2F2`（68% / 56% / 40% 三级） |
| 强调 | `#2E8CF6` |

**字体**：Inter（Latin/数字）+ 系统 CJK 回落。字阶统一带 letter-spacing 微调（大标题收紧、正文略放）。

**图标**：Lucide（统一 24 网格 / 2px 描边），不是 Material Icons。

**头像**：`BlobAvatar` —— 每个 bot 由 id 决定三阶谐波轮廓 + 两只眼睛，9 秒一个周期缓慢扭动，2.6~6.8 秒随机眨一次眼。轮廓用二次贝塞尔穿过采样点中点，比直接 `lineTo` 顺得多；加了落影、三段渐变、边缘反光。

## 七、协议

**REST**（除 `/health` `/api/pair` `/pair` `/api/qr.*` `/api/pairing` 外都要 token；**回环地址免 token**）

```
GET    /api/state                    全部会话 + bot 花名册 + 服务器信息
GET    /api/rooms/:id/messages       历史消息
POST   /api/rooms/:id/send           发消息 {text, mode, attachments}
POST   /api/rooms/:id/abort          打断
POST   /api/rooms/:id/reset          开新会话
POST   /api/uploads?name=x.png       上传附件（raw body）
GET    /api/files/:id?token=         取附件（可直接当 <img> src）
GET    /api/pairing                  当前配对码（公开）
GET    /api/qr.png | /api/qr.svg     二维码（公开）
GET    /pair                         网页版配对页
GET    /api/devices                  已配对设备
```

**WebSocket** `/ws?token=`（回环可省）

```
上行  {t:"send", roomId, text, mode, attachments, clientId}
      {t:"abort"|"reset"|"ping", roomId}

下行  hello / msg.new / msg.delta / msg.steps / msg.done / msg.error
      msg.updated / msg.deleted / typing / queue / steer.accepted
      room.created / room.updated / room.deleted
      bot.updated / bot.deleted / device.revoked / pong
```

`msg.delta` 的 `text` 是**当前完整文本**（不是增量），客户端直接覆盖，天然幂等。

## 八、踩过的坑（都记在 `docs/PITFALLS.md`）

---

## 启动层（桌面端宿主）

桌面端即宿主：界面负责把服务端跑起来，并保证它比界面活得久。代码在 `app/lib/server/`：

| 文件 | 职责 |
|---|---|
| `options.dart` | 启动参数（端口外的入口 / node / 数据目录）与结果类型 |
| `locate.dart` | 入口与 node/npm 定位、端口探活。无状态，只依赖传入目录 |
| `server_log.dart` | 日志轮转与读取（服务端 stdout 由操作系统重定向到此文件） |
| `supervisor.dart` | 进程拉起与停止：短命辅助脚本 + `server.pid` |
| `launcher.dart` | 编排：探活 → 定位 → 依赖 → 拉起 → 等待就绪 |

关键约束：

1. **服务端不继承 App 的 stdio 管道**。管道随父进程退出而断开，子进程再写日志会
   因 EPIPE 退出。改为由操作系统把 stdout/stderr 重定向到日志文件。
2. **进程与界面解耦**。关掉界面服务端继续运行；`server.pid` 记录下来供重启使用。
3. **启动失败要快**。服务端在退出时往日志写一行标记，编排层读到即判定失败，
   不必等健康检查超时；连续失败达到上限后暂停自动重试，等待手动触发。
4. **路径可覆盖、默认自动**。用户在「设置 → 本机服务端」里可指定入口 / node /
   数据目录；留空则按固定顺序探测。数据目录与安装位置无关（用户数据目录）。

## 持久化边界

`server/src/store.js` 是唯一的内存态 + 落盘入口，约定：

- `state.json` 存设备 / bot / 房间 / 会话文件映射；`rooms/<id>.json` 存消息；
- 只写 dirty 集合里的房间，空房间不生成文件；
- 删除房间 / 删除 bot 的私聊时，同步 `unlink` 消息文件与会话文件，并从 dirty 摘除；
- 写入逐房间独立兜底：单个房间失败不影响其他房间，失败的留待下次重试。
