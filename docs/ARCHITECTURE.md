# 架构与设计决策

## 一、组织架构为什么这么设计

交互范式上参考了两处：**ds-bot**（DeepSeek Harness 的 bot 插件），以及"会话列表 + 对话"那种左右分栏的桌面客户端形态。

从 ds-bot 抄的核心机制（`src/host/groups.js`）：

1. **`ROOM_CALLS`**：`'Writing "@Name" calls that member next, to answer or to do what you ask; when it finishes work you gave it, you answer its result. To only mention a member, write its name without "@".'`
   → 我们把 `@名字` 定义成**发言权转移信号**。这是整个多 agent 协作的地基：不需要任何额外的"派活 API"，模型只要正常写 `@谁` 就能调度。

2. **`openingSpeakers(room, opener)`**：一条消息进来时决定谁先开口。
   ds-bot 的规则是：`@点名` → 被点名的；否则 admin 模式下**只有 admin**；否则 admin + 全员。
   → 我们照搬，但把 admin 叫成「部门老大」，admin 模式作为部门的默认模式。

3. **轮次预算**：`ROOM_TURNS_EACH = 2` / `ROOM_ADMIN_TURNS_EACH = 4`。
   → 每人在一轮里能说几次是有上限的，否则两个 agent 会互相 @ 到天荒地老。

4. **`report_back` / `waiting`**：一个 bot 接了长活，它做完时由"当初派活给它的那个人"接住。
   → 我们用 `room.cursors[botId]` 游标实现了等价物：每个 bot 有自己的"我看到哪了"，所以它能拿到自己缺席期间群里发生的事。

### 与 ds-bot 的关键差异

| | ds-bot | pi-bot |
|---|---|---|
| 底层 | DSH 的会话 | pi agent（`createAgentSession`） |
| 群消息可见性 | 成员各自 Session，靠 relay 转发 | **共享房间记录 + 每人游标**，每个人都能看到全场 |
| 派活 | `post_to_group` / `message_bot` | `@名字`（同）+ `dispatch_to_department`（总经理专用） |
| 动手能力 | 受限于 DSH 工具 | 完整 bash/write/edit/MCP/subagent |
| 空回复 | 可能静默 | **三层兜底**，绝不给你空白 |

## 二、部门轮次引擎（`pi-runner.runRound`）

```
用户发消息
   │
   ├─ 追加到房间记录（所有人共享的真相）
   │
   ├─ openingSpeakers() 决定首发人
   │     · @点名 → 只叫被点名的
   │     · @all  → 除自己外全员
   │     · 否则  → 部门老大
   │
   └─ 循环：
        pop 队列头 → 检查轮次预算 → 跑一轮
           │
           ├─ 提示词 = 部门花名册 + 它没看过的群记录 + "现在轮到你" + 老大/成员规则
           │
           ├─ 输出 = [PASS] ? 删掉占位消息，结束这条线
           │
           └─ 输出里 @了谁 → 谁排到队尾（去重）
```

终止条件：队列空 / 总运行次数到 `groupMaxRuns` / 每人的 `groupTurns*` 用完。

**为什么顺序跑而不是并行**：每个 bot 的提示词里要包含前面发言者刚说的话。并行跑的话它们互相看不见，就退化成"各说各的"，而不是协作。

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
