# Orbis SDK 与单骨架说明

`Orbis`（包名 `orbis-agent`）不只是配套 App 的服务端，它和底层 `@earendil-works/pi-coding-agent` 一样，是一套可被外部程序直接嵌入或远程调用的**多智能体基座**。

---

## 一、四层单骨架

| 层 | 核心模块 | 职责 |
|---|---|---|
| **1. 实例原语与纯算法** | `brand.js` / `config.js` / `bus.js` / `store.js` / `model-groups.js` / `capabilities.js` / `grants.js` | `createConfig`（优先读取 `ORBIS_*`，兼容 `PI_BOT_*`）、`createBus`、`createStore`、`createModelGroupStore` 按实例隔离数据目录与事件流，仅 `import` 不碰全局磁盘；能力、授权与调度规则保存在单一声明源。 |
| **2. 多智能体编排内核** | `session-factory.js` / `pi-runner.js` / `policy-hook.js` / `mcp-hook.js` | 负责单 Bot 单轮运行、模型熔断与多端点轮转、全双工旁路响应、部门 `@提及` 并发轮次引擎与空回复三层恢复。 |
| **3. 应用服务与 SDK 门面** | `services/*` / `sdk/index.js` / `sdk/client.js` | 把 Bot/部门、模型组、定时任务、技能/MCP 与全局策略收束到唯一的领域服务层（UI、Jarvis 工具、SDK 三端同源）。 |
| **4. 宿主适配外壳** | `server-main.js` / `http.js` / `ws.js` / `tools.js` / `jarvis-tools.js` | HTTP/WS 协议传输、一次性 nonce 鉴权、以及给大模型调用的 Schema 包装，自身不复制业务规则。 |

---

## 二、进程内嵌入（`orbis-agent/sdk`）

适合将 `Orbis` 直接作为 Node 库嵌入脚本、CLI、自动化编排或自定义宿主；同一进程内可以按需启动多套互相隔离的 `runtime`。

```js
import { createOrbisRuntime } from 'orbis-agent/sdk';

const runtime = await createOrbisRuntime({
  dataDir: './.orbis-state',
  workspace: '/path/to/your/project',
  userName: 'Alice',
  modelGroups: [
    {
      name: 'default',
      baseUrl: 'https://api.example.com/v1',
      apiKey: '<YOUR_API_KEY>',
      api: 'openai-completions',
      models: [{ id: 'gpt-4o', contextWindow: 128000, maxTokens: 16384 }],
    },
  ],
  policy: { dangerous: 'allow', requireProof: true },
});

const unsub = runtime.onEvent((ev) => {
  if (ev.t === 'msg.delta') process.stdout.write(ev.text ?? '');
});

// 1. 直接与主控（mainBot / Orbis）对话并等待本轮结果
const mainReply = await runtime.askMain('总结这个仓库最近三次提交的风险点');
console.log(mainReply.replyText);

// 2. 通过领域服务管理多 Bot 部门与系统设置（与 App / Jarvis 工具同一条主干）
const { room } = runtime.rooms.createDepartment({
  name: '代码审查组',
  lead: '审查组长',
  members: [
    { name: '审查组长', role: 'lead', persona: '拆解审查清单并汇总结论' },
    { name: '安全专家', persona: '专注鉴权、注入与敏感信息检查' },
  ],
});
await runtime.send(room.id, '请 @安全专家 重点审计 server/src/http.js');

unsub();
await runtime.dispose(); // 清空会话、停掉定时器与总线监听，事件循环可直接退出
```

> 同时保留 `createPiBotRuntime` / `createPiBotClient` 兼容别名，平滑过渡已有调用。

### `createOrbisRuntime` 主要字段

- `runtime.askMain(text, opts)`：向主控发消息并等待其完成回复，返回 `{ roomId, userMessage, reply, replyText }`。
- `runtime.send(roomId, text, opts)`：向任意私聊或部门群发消息（异步触发编排轮次，结合 `onEvent` 订阅流式输出）。
- `runtime.runBotOnce({ roomId, botId, prompt, timeoutMs, meta })`：在指定会话跑完单次 Bot 回合。
- `runtime.bots` / `runtime.rooms` / `runtime.models` / `runtime.automations` / `runtime.capabilities` / `runtime.policy`：对应 `server/src/services/*` 的领域服务实例。
- `runtime.abort(roomId)` / `runtime.reset(roomId)` / `runtime.dispose()`。

---

## 三、远程调用已运行的 Orbis 服务端（`orbis-agent/client`）

如果桌面端或常驻服务已经在后台运行，可以通过 HTTP + WebSocket 客户端连过去，服务端管理员接口所需的一次性 `nonce` 会自动向 `/api/local-nonce` 申请。

```js
import { createOrbisClient } from 'orbis-agent/client';

const client = createOrbisClient({
  baseUrl: 'http://127.0.0.1:8787',
  dataDir: process.env.ORBIS_HOME || process.env.PI_BOT_HOME, // 自动读取 local-token，也可直接传 token
});

const conn = await client.connectEvents((ev) => {
  if (ev.t === 'msg.done') console.log(ev.msg?.authorName, ev.msg?.text);
});

const rooms = await client.listRooms();
const dm = rooms.find((r) => r.kind === 'dm');
await client.send(dm.id, '帮我列出当前启用的定时任务');

await conn.close();
```

---

## 四、扩展能力（单一事实源）

新增内置工具或高风险能力时：
1. 在 `server/src/capabilities.js` 的 `ACTIONS` 与 `TOOL_SPECS` 中登记动作归属、风险级别、是否可撤销与目标提取规则（`action-catalog`、`role-tools`、`migration-grants` 会自动派生）；
2. 用从 `orbis-agent/sdk` 重导出的 `defineTool` 定义 Schema 与执行逻辑（共享逻辑优先放进 `server/src/services/*`）；
3. 运行 `cd server && node scripts/check-capability-drift.mjs && node scripts/check-consistency.mjs` 守住防漂移不变量。
