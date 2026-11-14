# TaskRun 协议与模块（批次 06）

一页冻结首次接单准入、客户端任务投影与控制协议。内部字段名、模型路由参数和凭据不出现在用户文案里。

## 首次接单链路

```text
已鉴权请求（WS/HTTP）
  → 请求闸门：requesterId + 稳定 requestId + 原始内容指纹 → 持久回执
      stage: running（并发同键返回 inflight；不同内容冲突；坏回执拒绝）
  → 现有 Mainbot 理解轮（同一轮，不另起模型）
      accept_task 工具：answer / clarification / accept_task proposal
  → 宿主准入：createTaskRun + acceptRequest（首个 Goal/预算/路由意图）
      · 未伪造 initial attempt / root started grant
      · 任务已落盘但回执写失败 → TaskRunStore.findByRequest 恢复，不重跑理解
  → 组织交接：04 同一服务核心 + 准入授权包装（0 次模型调用）
  → 该轮真正结束：关闭请求作用域，回执转 accepted/answered/failed
  → 05 调度负责人真实 attempt（独立事件入口）
```

- 不可变请求信封随 runner.send 进入实际队列；真正取得执行权时激活作用域、该轮真正结束时收尾。WS/HTTP 只交信封，不各自 begin/finally。
- 忙时新的独立请求按信封排队，不 steer 进正在跑的目标，不借身份。
- 残缺 managed 上下文明确拒绝，不降级到准入或 legacy；群聊明确拒绝（REQUEST_GROUP_UNSUPPORTED），不静默走旧路径。
- 预算由宿主给（PI_BOT_TASK_MAX_RUNS，默认 12）；理解轮不计入任务额度。

## 回执读结果原则

只有 ENOENT 才是「不存在」。有效 JSON 但缺 receipt、身份/请求不符、未知版本/阶段、字段损坏 → 一律 corrupt：调用方如实失败，不当新请求，不重跑理解。running 超过租约且无对应 TaskRun → 允许同 requestId 重试；已有 TaskRun 事实 → 重建 accepted。

## 首次准入模式（宿主可信）

- 用户消息模式由宿主请求信封携带；discussion 在准入入口统一生效：不建任务/不建组/不派执行，模型换工具也不能覆盖。
- direct：不建部门，绑定主控为合法执行者，由 05 在用户房间启动；createOnly：复用 04 创建操作建组后收口，不派执行、不 notify 05。
- 只有新部门正常路径会创建部门并派发；三条路都不另造组织协调器。

## 命令应用事实

命令信封（commandId/type/ref/decision/text/原 expectedRevision）先写 pending；副作用成功后把 commandId 与领域变更一起写进 TaskRun.appliedCommands，再写 applied 回执。重放只认应用事实：已应用 → 回放不重复；未应用且任务 sequence 已变化 → 不确定拒绝；从未变动才允许重试。输入/审批先校验任务/版本/ref 门槛与审批归属，再产生任何副作用。

## 请求 outbox

完整不可变请求信封（requestId/房间/文本/原 mode/附件/所属服务身份）发送前落盘；写盘失败不发送。新用户操作新信封，重传只复发原信封；跨服务身份不重发；WS queued/inProgress ACK 不清理，只有可靠受理/明确拒绝才清理。

## 同步完整性

hello 带活跃快照（含完整性与根预算）+ taskRunMeta.activeCount/activeComplete + recent 终态；/api/task-runs?scope=active|history&before=&limit= 返回 complete/nextBefore。客户端按 before 翻页取完整活跃集合，完整快照缺席的旧活跃任务按单任务快照补查终态，不把截断当删除、也不让旧 running 永挂。第三张及以后活跃与历史统一进“任务记录”入口。

## DM 受管执行与仅建组收口

- direct/私聊 TaskRun 不再走 runRound：runtime 按真实房间类型选择，DM 用 PiRunner.run(roomId,botId,prompt,{managedContext,skipUserMessage:true})，复用同一 attempt/根授权/报告/产物/用量；group 保留 runRound。执行前用房间成员事实核对 bot，不靠上下文自证。
- 受管取消句柄在真实取得会话执行权时登记（DM/group 同一 map），finally 只清自己的 task/attempt；abortManagedTask 对 DM 同样生效。
- createOnly：复用 04 创建操作真建组；完成后用可验证的主机建组收据把容器 TaskRun 终结为 completed，写 delivery（source=host_department_receipt），不伪造模型 attempt/报告，也不留 queued 幽灵任务。

## 命令应用事实的身份

appliedCommands 与命令回执同键：requesterId + commandId + fingerprint 三者全匹配才认作本命令的应用事实；缺身份或不匹配一律不能用别的操作成功事实回放，返回不确定/冲突。事实写在领域变更之后是第二次 mutate（非原子）；失败保持 pending，重放按 sequence 变化判不确定，不重复。

## 输入提交校验

输入在 taskRuns.mutate 的当前记录内校验 revision 与 input 门槛后再追加；入口预检只做早拒绝。被拒文本不进入 inputs、不进入后续 prompt；审计信息与已接受上下文分离。

## 发送 outbox 交错

首发开始即捕获服务身份与不可变信封；写盘成功后校验同一代次，切服期间不把 A 文本发给 B。写盘失败恢复原 pending entry，不能先覆盖再删除。

## 稳定分页游标

排序固定为 updatedAt desc + id asc；cursor 为 {updatedAt,id} 的不透明编码，服务端过滤与客户端传参同一契约，返回 complete/nextCursor。同毫秒任务不会因仅时间戳分页被跳过。
## R4 提交一致性补充

- RequestOutbox 使用单事务队列串行化「读最新快照 → 构造候选 → 写盘 → 提交内存」；remember/clear/persist/load 共用同一条队列。失败恢复原记录，队列吞掉异常后仍可继续；并发两条待确认请求都能持久化并在重启恢复。
- 准入完成提交在最终 mutate 的当前记录上复用 admissionAuthorize，并核对冻结 admission.revision、operationId、createOnly 模式与主机收据 operationId；不匹配返回 admission_stale，保留新目标与进度，旧操作已建资源保留，不把旧收据标成新版本完成。
- 完成 mutate 结果逐项检查；失败不得包装成 accepted/completed。
## 请求终态确认（R5）

- 收件 ACK/queued/inflight 只表示已收到，不是受理终态；客户端不得用缺省字段推断完成，outbox 保留完整信封直至可靠终态。
- 终态由持久 receipts/TaskRun 事实投影：accepted（宿主已接管，TaskRun 已落盘）、answer、clarification、discussion、failed（无 TaskRun 时可重试）。`projectRequestResult` 是唯一投影，WS `request.result` 与 HTTP `GET /api/request-results/:requestId` 共用。
- 终态事件携带原 requestId、status、accepted、kind、taskRunId、retryable；`request.result` 只在 receipt 写入成功后发送（lifecycle close 回调），不把模型文本/msg.done 当受理确认。
- AppState 收到可靠终态才清理 outbox；丢最终帧时按原服务身份与 requestId 查询回执对账（重连 hello 后逐条对账、HTTP fallback 轮询），不重新调用模型；旧服务确认不能清新服务待发项。
## 权威结果读取（R6）

- `createRequestResultService` 是唯一读取：认证 requesterId+requestId 对应的 TaskRun 已存在即 accepted（taskRunId 真实），回执缺失/滞后/写失败不得降级为 pending/failed；无 TaskRun 才看校验过的回执；读取不确定明确失败。
- `closeRequest` 与 query、WS publisher 共用该服务；accepted 回执修复写入失败与 Goal 已接管分开，不把已接管任务反写成 failed/NO_INTAKE_VERDICT。
- 无 TaskRun 的终态写失败不发布成功；坏回执/任务读取不确定发布明确失败；未知请求保持 pending。

## 统一请求身份（R6）

- 规范键为认证 requesterId + requestId（`requestIdentityKey`），贯穿回执、忙时队列去重、requestDecisions、结果投递与客户端确认匹配；持久回执键格式保持兼容。
- 队列/决议不再用裸 requestId；A/B 同 ID 是两条独立请求，可各自排队执行；同一来源同 ID 同内容仍去重，改内容仍冲突。
- `request.result` 按原请求来源设备定向投递（同一人的其他配对设备仍可控制同一 TaskRun，不做租户墙）；客户端用 hello 下发的当前认证 device id 核对来源，不从正文猜匹配。
## R7 确认边界

- 读取不确定（坏回执/TaskRun 读取 EIO）不是可靠拒绝：publisher 只发非终态 `status:unknown`（source:uncertain），客户端一律保留原信封并继续保留确认依据；`retryable` 只描述能否重发，不用于删除确认。修复数据后仍按原 requestId 查询事实，不重跑模型。真实 answer/clarification/discussion/failed 与 accepted 语义不变。
- 客户端设备身份绑定当前 API/凭据/服务代次：api setter 变化即清除旧 hello 设备绑定；当前已认证 HTTP 回执无需新 WS hello 即可消费；旧服务回包仍按服务身份拒绝；轮询只有真正消费了可靠终态才停止，身份拒绝不算收口。
## 生产启动与受控启用（批次 07）

- 真实入口 `src/index.js → server-main.js` 在 PiRunner 初始化后装配唯一 `TaskRuntime`（bootstrap/task-host.js），默认机械验收 access 只按附件 id 读写真实产物；HTTP/WS 就绪后执行一次 `recover()`；SIGINT/SIGTERM 时 dispose 任务调度并保存 store。测试不再在外部手装 runtime 或手动 notify。
- 开关 `PI_BOT_TASK_INTAKE` 默认关闭。关闭态：新 App 携带合法 requestId 的私聊/群聊按普通聊天处理，不要求 accept_task、不建 TaskRun，本轮结束记 answered 并发布终态确认；无 requestId 旧协议保持；显式非法 requestId 明确 400/error，不静默回落 legacy。
- 开启态：自然消息→主控既有理解轮→真实 accept_task→组织/直派→负责人/成员→默认验收→completed；createOnly/direct/discussion 沿用 04/06 语义。
- 任务咨询/修订工具 `task_status` / `task_revise` 只在受控启用时注册给主控；查询只读，修订以“认证来源+requestId”派生稳定命令身份，冻结原 taskRunId、expectedRevision 与完整修改方案，重放先查原命令应用事实；不覆盖 TaskRun.request 原接单身份，不按最新 updatedAt 猜目标，同一次修改重试不重复升版。
- 改版事件在归约当前记录上核对 expectedRevision，入口与执行之间被并发改版时拒绝旧提交。

## 迁移与回退（07）

- 新增数据均为可选文件：TaskRun、请求回执、命令回执；旧会话/消息/任务板无需迁移。旧版本可忽略新任务文件，但**不能**继续执行/完成新协议 TaskRun。
- 回退顺序：先暂停新执行任务并保存进展（关闭开关或停止调度），保留 TaskRun/回执用于查证；不得清空或重放未知副作用。旧版本不识别新任务时仅继续旧聊天/旧任务板。
- 开关关闭不删除已有 TaskRun，后续可重新受控启用查看/继续；迁移/回退不新增数据库或云服务。

## 用户群预算与任务根预算（07）

- 旧 `groupLimits.maxRuns` 是“一条用户消息最多触发几次 bot 运行”的用户上限。新受管链保留每次 groupTurn 的单段限制（turnMaxMs/maxSteps），但根预算取 `min(任务链默认值, 用户 groupLimits.maxRuns)`：只收紧、不放大；用户调低上限会真实限制自然接单后的根/父子累计执行，重启不重置。
- `maxSteps/turnMaxMs` 仍是单段执行限制，不是 Goal 总步数；模型字段不能当作用户追加预算。共享子任务的预算展示读取根事实。

## 改版命令的不变信封（07）

- 同一认证请求（requesterId+requestId）派生稳定 commandId；首次调用冻结目标任务、原 expectedRevision 与完整修改 goal，并交给命令服务持久 pending envelope。
- 同请求重试先读原命令信封/应用事实：已应用则回放、不再次升版；不按当前版本/当前 Goal 重新解释。改版归约在当前记录上核对 expectedRevision，入口与执行之间被并发改版时拒绝旧提交。TaskRun.request 的最初接单身份保持不变。

## 成果证据来源与专业验收（07 修正）

- 默认验收的白名单不再只取本任务当前 attempt：共用可信解析会读取本任务当前/历史已登记产物，以及**通过持久 parentTaskId/parentRevision 真实关联且已完成**的子任务账本。每条候选保留 sourceTaskId/sourceRevision/attemptId 来源，仍按当前版本目标条件重新 stat/read；旧版本或子任务产物不会复制成父 attempt，也不会直接改写 evidence.revision。
- 读不到文件必须走失败/阻塞通道：生产 createTaskAccess.readText 对缺失文件抛错；markdown/text 格式读取失败是 blocked，不会把“文件不存在”当正文通过。
- expert 条件是专业判断而非机械证明：负责人受管验收回合可用 task_expert_review 记录 conditionId/任务/版本/判断/依据/来源；机械验收消费同任务、同版本、同条件的记录，没有记录仍是 needsReview，普通完成文本不能放行。runTest/listReceipts 未配置时对应条件保持 blocked。
- 改版命令冻结信封包含 deferNotify；自然 task_revise 先入本轮请求队列，等当前主控理解轮释放后再启动新尝试，不抢会话、不白扣失败尝试。命令应用事实保留原 envelope，同一请求重试可回放。

## 初次交接恢复（07 修正）

- 真实启动 recover 先扫描 admission.status 为 pending_handoff / handoff_failed 的 TaskRun，按已持久化 routeSpec/operationId/请求身份恢复建部门与 owner，不依赖用户重发、不重放未知副作用；随后再做普通任务恢复扫描。已完成任务重启不重做、运行中未知仍按既有保守核验处理，三者分别取证。

## 远程帧与日志（07 修正）

- App 共享 WS 帧解码同时接受文本帧和合法 UTF-8 二进制 JSON（relay 实际转发 Buffer），坏帧忽略；兼容直连/现有 relay，Mac/Win 共用同一逻辑。
- relay/agent 诊断日志对 WS path 的 query 统一脱敏为 ?<redacted>，不改变实际转发；正常连接诊断保留 pathname。

## 07 支持边界（如实）

- 默认 access 只提供 stat/readText；runTest、listReceipts 未配置时，test/receipt 条件按既有规则 blocked，不会假装通过；需要时由宿主显式注入对应入口。
- 专业验收由负责人受管验收回合的 task_expert_review 记录驱动；机械条件与专业判断分开，普通完成文本不能替代专业判断。未记录的 expert 条件保持 needsReview。
- 可信候选的旧版本/子交付只在当前目标条件重新 stat/read 通过后使用；不把旧 evidence.revision 改写为新版本，不伪造父 attempt，不因改版自动放宽负责人写权限或恒真 verify。
- 真实公网 relay/TLS、真实手机现场、原生安装包/窗口关闭仍未测；relay 结论只覆盖现有代码的合成 loopback 与 Flutter 帧解码组合。

## 07 R2 修复边界

- **初次执行恢复**：交接 admission 写 done 后，next.action=dispatch + owner + admission.done + 0 attempt + queued 是持久首派意图；supervisor 恢复阶段显式识别并唤醒既有执行路径。createOnly、暂停、取消、open gate、已有 attempt/未知占位不满足首派条件，不复活；pending_handoff/handoff_failed 仍先由交接恢复补建唯一部门/owner。
- **证据选择**：候选池保留当前版本、真实子交付、最近历史交付的来源全集；本次选定交付取当前版本最近一次真实登记产物，数量不足才按“同版本更早 attempt → 当前子交付 → 最近历史交付”补足；count/format 对同一选定集合逐条核验，不允许好文件掩盖同集合坏文件，也不改写历史 revision。显式 attemptId 只取该已结算 attempt；不存在/无产物不借历史。
- **完成申请的选择集合**：正式 task_report 的完成选择在 attempt 结算时归一化为 AttemptResult 结果字段（completionSelection）并随账本持久；验收只读该持久事实，从可信候选池中选择本次核验集合，claim 本身不是证明。旧账本无该字段时按默认规则兼容；新的空选择不继承更早选择。选择未知/坏 ref 直接拒绝并失败，不加入 allowedRefs、不交给 stat/read、不静默换成旁边好文件；没有明确 claimedEvidence 选择时才用默认“最近登记交付 + 数量不足按同版本→子交付→最近历史补足”的保守规则。候选收集、选择、验证是三个职责，count/format 使用同一选定集合。显式 attempt 的总入口统一校验存在/归属/版本/结算状态，expert 判断也只消费该 attempt 范围；默认任务级合法汇总保持不变。
- **专业验收**：审查历史 append；同一受管 attempt 重复调用是操作重放（同载荷复用、不同载荷拒绝），新的合法 attempt 可更新当前结论，消费者取最后一条有效判断。验收能力与派工能力分开：真实部门负责人（含单成员部门）可验收；DM direct 的 expert 条件在接单阶段明确拒绝 expert_route_unsupported，不空转烧预算。

## 客户端协议

| 项 | 规则 |
|---|---|
| 快照 | hello.taskRuns（权威）；GET /api/task-runs 列表；GET /api/task-runs/:id 带 authoritative/cursor/gap |
| 增量 | WS taskRun.updated（服务端投影）；客户端按每任务 storeVersion 合并，旧值/同版本重复拒绝，跨度>1 触发补拉 |
| 版本 | revision 目标版本、sequence 领域事件序号、storeVersion 持久变化版本；预算/nextAction 变化也走 storeVersion |
| 控制 | POST /api/task-runs/:id/control：type, commandId, expectedRevision, ref?, text?, decision? |
| 幂等 | 命令回执按认证身份+commandId 持久；重发返回 replayed；同 ID 不同内容 409；旧 revision 409 |
| 身份 | 只来自现有鉴权；不按来源设备隔离可见性（同一用户已配对设备互控）；不新增云端/DB |
| 结果 | result.prepared（服务端已验收）≠ delivered（设备已收到）；离线补送不重做任务 |
| 旧语义 | 手工 TaskItem/500 条/勾完成保持；TaskRun 独立存储，通用勾选不能绕过验收 |

入口：TaskRunStrip（输入框上方状态卡）→ showTaskRunSheet（详情/暂停/继续/取消/补输入/审批）。新增图标沿用 lucide_icons_flutter 既有字形。

## 文件占用（fileClaims）

同一波派出去的成员是并行跑的，调度器只按执行者去重、不看文件。两个人各改同一个文件时，
读-改-写之间没有任何锁（bash 工具更不经过任何队列），后写的静默覆盖先写的。

| 项 | 约定 |
|---|---|
| 声明 | `assign_member_task` 的 `files`、`task_plan` 每步的 `files`；正文里 `@甲 改 app/lib/a.js` 那一句会自动挑出路径 |
| 规范化 | 反斜杠统一成 `/`，去 `./` 与结尾斜杠，`/*`、`/**` 视作目录本身；Windows/macOS 折叠大小写，Linux 不折叠 |
| 覆盖 | 声明目录即覆盖其下所有文件（`src/auth` 与 `src/auth/login.js` 冲突） |
| 互斥 | 另一份活正占着同一批文件时，这一份排到 5 秒后重试：**不登记尝试、不扣额度**，日志写清被谁占着 |
| 不算冲突 | 祖先与子孙（否则父等子、子等父自锁）；排队/受阻/暂停中的活（它们此刻不会写） |
| 审核 | 文件清单**不进**派工指纹：同一份活重派时补一句文件只是合并，不新建任务；诊断投影里能看到实际占用 |

## 模块

服务端：coordination/task-admission.js（首次准入）、coordination/task-request-gate.js（预约/生命周期）、tasks/task-request-receipts.js（持久回执与恢复）、tasks/task-projection.js（用户投影）、task-routes.js（HTTP 任务路由）。
客户端：task_run_models.dart、task_run_merge.dart、task_run_api.dart、task_run_controller.dart、widgets/task_run_card.dart、widgets/task_run_sheet.dart；app_state.dart/chat_screen.dart 只接线。

## 启用边界

PI_BOT_TASK_INTAKE 默认关闭；批次 07 已在真实 server-main 装配一个 TaskRuntime 并执行 recover；关闭态按下方“生产启动与受控启用”处理。
