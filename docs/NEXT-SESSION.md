# 明天从哪继续（交接便条）

> 写于 2026-11-16 凌晨。HEAD = `946f622`，main 已推送，工作区干净。
> **server 121/121 个测试文件全绿**（`onboarding` 55 项、`onboarding-route` 15 项新增），
> **app 775 项全绿**（`onboarding_model` 23 项、`permission_setup_gate` 12 项新增），
> 七项一致性检查 + 能力清单 + 敏感信息扫描全过。
>
> 这份便条只回答一件事：**下次打开这个仓库，先干什么。**
> 完整账目在 `docs/SPEC-COVERAGE.md`（逐条对着规格核实过）和 `docs/TODO.md`。

---

## 一句话

规格里那个"整节一步都没做"的 P0 —— **§13.2 首次授权流程 —— 现在做到 4/5 步**，
剩下的是**收尾那一半**（跑完自动回收临时授权）。

---

## 建议顺序

| # | 做什么 | 为什么是它 | 大概 |
|---|---|---|---|
| **1** | **§13.2 第⑤步：跑完的自动收割** | `planWrapUp` 已经把"该收哪几条、哪几条能留、哪几条勾了也不能留"都算出来了，但没人调它 —— `cascadeImplemented: false`。缺的是任务终态的钩子（TaskRun 的 `reportTerminal` 附近） | 半天 |
| 2 | §13.2 正文的 **英文文案** | 现在展示的句子由服务端返回整句中文，英文界面下也是中文。要改得让 `onboarding.js` 返回 `id`（或结构化字段），App 侧自己组句 | 半天 |
| 3 | §7.3 worktree 信任域判定 | 登记全了（gitdir/commondir/alternates），就差"必须属于授权域否则拒绝" | 2 小时 |
| 4 | §6.3 剩余回收点 | 解绑工具不回收该工具授权 / 项目变更不重校 / 后台执行靠手动 kill | 2 小时 |
| 5 | macOS 桌面输入 | 空壳 + 481 行文档都就位了，只缺 Mac 实机 | 需实机 |
| 6 | TaskRun 继续补测 | 准入三模式 → 请求回执 → 产出验收，之后才能开 `PI_BOT_TASK_INTAKE` | 1 天+ |

---

## 今晚做完的（供回忆）

**5 个提交**，一条线：把 §13.2 从"一个字都没有"做到"能看、能选、能生效"。

1. `04bb8df` **纯逻辑**：`server/src/onboarding.js`
   - 四类"另需批准"写成死数（选最宽 Git 范围也不减少），测试守着
   - 执行 Bot 的模式**不给选** —— 理由见下面那个坑
   - `perCallConfirm` 把"不受 policy 影响"的两条（改安全配置 / 外部 MCP）单列
   - `retentionRefusal`：对外发送、凭据、非项目资源一律不能"保留"
2. `808a6a7` **接线**：`GET /api/onboarding`。桌面权限**真探**（60 秒缓存），
   `not_platform` 与"系统拒绝"分开报，探针自己炸了算 denied 而不是可用。
3. `0fc8c97` **修一个真有病的**：首次判据原来按"有没有未撤销授权"，
   而服务端每次启动都会补发迁移授权 → 首启页在任何真机器上**永远不会弹**。
   改成只认人类来源（`user` / `saved-rule`）。
4. `e413d62` **真的能建授权**：`POST /api/onboarding/apply`（defense 档 + policy nonce + 审计）。
   动作清单不手写、不含 `cmd.exec`、重新选择会先撤销上一批。
5. `946f622` **界面**：`widgets/permission_setup_gate.dart`，一页四步，
   模型引导之后拦一屏。三条条件全中才弹。

## 三个今晚踩到的东西（值得记住）

1. **"按有没有授权判首次"是错的**。这套系统里授权有六种来源，其中
   `legacy-policy` 是启动时自动补的。判"用户走没走过"只能看人类来源。
   见到"应该弹的东西不弹"，先查**有没有别的东西替它满足了条件**。
2. **别把做不了选择的事做成下拉框**。§13.2-3 是"派活时分配任务级权限"，
   塞进首启页就会把 `host` 摆到执行 Bot 面前（迟早有人选上）；
   而选了 `isolated` 却没真给沙箱，bot 会变成"存在但什么都干不了"。
   所以那一步改成**告知**，界面不提供这个选择。
3. **窄范围授权 + `cmd.exec` = 一张废卡**。命令的目标认不出来，
   网关对"限定了范围却认不出目标"是 fail-closed（`resourceNotCovered`）。
   所以项目授权里不含 `cmd.exec`，跑命令仍由迁移授权覆盖 —— 页面上要这么说，别装作给了。

---

## 一个没解决的产品问题（现在挂着）

首启页建的是**项目范围**的授权，但主 Bot 手上那条 `legacy-policy` 迁移授权
范围是"当时那份规矩允许的一切"，**不会因为新授权存在而自动收窄**。
页面上已经如实说了（"要你自己在授权面板里收"），但没有引导式的一键收窄。

真要做，方向是：`POST /api/onboarding/apply` 里加一个显式参数
（例如 `retireLegacy: true`，默认 false），把那些 bot 的迁移授权按
`revokedBy: 'user'` 撤掉。**不能默认开** —— 那等于静默改变现有行为，
而且撤掉之后 `cmd.exec` 就没人覆盖了（见上面第 3 点），bot 会当场干不了活。

---

## 工作流（第二天不用重新摸索）

```bash
cd server
node tests/all.mjs                     # 必须 121/121
node scripts/check-consistency.mjs     # 必须「七项一致性检查全部通过」
node scripts/check-capability-drift.mjs
cd ../app
flutter test                           # 必须 775 全绿
flutter analyze                        # 必须 No issues
cd .. && node scripts/check-secrets.mjs
```

三条纪律：

1. **commit message 里别写本机绝对路径或他人路径样例** ——
   check-secrets 会扫提交元数据，而且强推之后 `--push` 模式会扫整条历史
2. 用脚本生成 JS 代码时注意 `\r?\n` 这类转义会被再解释一次 → 用 `RegExp` 构造函数
3. 每完成一块立即 commit + push，全绿才算完

## 还有那个已知挡路问题

本机装着 **GameViewer 远程控制**，它持续合成输入 ——
`GetLastInputInfo` 永远报"刚刚有人动"，于是接管检测永远让开，
`desktop_input` 第一次永远发不出去，而文案说的是"用户在动"（用户会以为是自己碰的）。

现在 `desktop_lease status` 会点名说出来。要真正解决得二选一：
关掉 GameViewer，或者你决定"信任这台桌面"（那是产品决策，我没偷偷放宽）。
