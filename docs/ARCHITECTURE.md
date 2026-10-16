# 架构与设计决策

## 一、组织架构与调度机制

部门以共享房间组织成员；桌面界面采用会话列表与对话详情的左右分栏布局。

1. **点名调度**：`@名字` 是发言权转移信号，被点名的成员接着回答或执行任务。只写名字而不带 `@` 不触发调度。
2. **首发成员**：`openingSpeakers(room, opener)` 决定一条消息到达后由谁先发言。有明确点名时选择被点名成员；默认部门模式由负责人先处理。
3. **轮次预算**：成员每轮最多发言 2 次，负责人最多 4 次，限制相互点名形成的循环。
4. **历史游标**：`room.cursors[botId]` 记录每个成员已读取的位置，使其接续任务时可以取得缺席期间的群消息。

| 模块 | 实现 |
|---|---|
| 执行会话 | pi agent（`createAgentSession`） |
| 群消息可见性 | 共享房间记录与每人游标 |
| 派活入口 | `@名字`；主控另有 `dispatch_to_department` |
| 执行能力 | bash、write、edit、MCP 与子 agent |
| 空回复处理 | 三层兜底，失败后明确报告 |

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
