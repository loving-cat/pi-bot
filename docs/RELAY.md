# 跨网访问（中转）——接口已留好，默认走局域网

**默认不需要中转**：手机和电脑在同一个 Wi-Fi 下，App 直接连 `http://<电脑IP>:8787` 就行，
配对码换 token，没有中间人。

有些用户会想把 pi-bot 放在云服务器上，让手机在外网也能连到**家里电脑**上的 pi-bot。
这里把我们预留的接缝写清楚 —— 换任何方案都不用改 pi-bot 本体。

---

## 一、三种现成做法（都不改代码）

| 做法 | 怎么做 | 适合 |
|---|---|---|
| **现成隧道** | 用 frp / Cloudflare Tunnel / Tailscale 把电脑的 8787 映射出去，App 里服务器地址填隧道域名 + token | 最省事，推荐先用这个 |
| **本仓库的参考中转** | 云上跑 `npm run relay`，电脑上跑 `npm run relay-agent`；App 地址填 `https://<云主机>/<配对码>` | 想自己掌控中转时 |
| **自己写中转** | 满足下面第二节的"接口约定"即可 | 有现成网关（nginx、APISIX…）时 |

## 二、接口约定（写自己的中转时按这个来）

手机 App 只认两件事：

```
HTTP   https://<你的中转>/<code>/...   →  转发到  电脑 http://127.0.0.1:8787/...
WS     wss://<你的中转>/<code>/ws      →  桥接到  电脑 ws://127.0.0.1:8787/ws
```

必须做的三件事：

1. **把 `/<code>` 前缀去掉**再转给电脑（App 拿 `https://relay/<code>` 当 baseUrl，
   它自己会拼 `/api/state`、`/ws`）。
2. **把 Host 改写成 `127.0.0.1:8787`** —— 我们的服务端会校验 Host（防 DNS rebinding），
   直接透传外网域名会被 403。
3. **保留 `Authorization`**（token 归电脑侧校验，中转不参与鉴权决策）；
   附件 URL 里的 `?token=` 由中转转成 Authorization 头即可。

其余（CORS、压缩、连接复用）中转自己决定；我们不要求任何私有头。

## 三、示例实现：relay + agent

```
手机 ──HTTPS/WSS──▶ 中转（云服务器）  ◀──WSS（电脑主动外连）── pi-bot（家里）
```

电脑主动外连，所以**不需要公网 IP、不需要端口映射**。

### 云服务器

```bash
RELAY_SECRET=换成一串随机字符 RELAY_PORT=8788 npm run relay
# 生产建议套一层 TLS 反代（nginx/caddy），把 https/wss 转到 8788
```

### 家里电脑

```bash
npm run relay-agent -- \
  --relay wss://<你的域名>/agent \
  --code 0123456789ab \        # 不填就随机生成，会打印出来
  --secret <RELAY_SECRET> \
  --local http://127.0.0.1:8787
```

### 手机

服务器地址填 `https://<你的域名>/0123456789ab`，token 用电脑上已配的那个
（设置 → 远程连接里能看到，或服务端终端打印）。

### 协议帧（示例实现用的，别人可以不用）

一条消息一个 JSON 帧；`body` / `data` 是 base64，`z:1` 表示先做了 **deflateRaw 无损压缩**
（图片这类已经压过的数据通常压不动，会自动跳过，不会变大）。

| t | 字段 | 说明 |
|---|---|---|
| `req` | `id, method, path, headers, body?, z?` | 中转 → 电脑 |
| `res` | `id, status, headers, body?, z?` | 电脑 → 中转 |
| `ws-open` | `id, path, headers` | 手机要开 WS |
| `ws-msg` | `id, dir:'c2s'\|'s2c', data, z?` | WS 双向数据 |
| `ws-close` | `id, code?, reason?` | 任一侧关闭 |
| `hello` | `code` | 中转确认接入 |

代码：
`server/src/relay/frames.js`（帧编解码，纯函数）、`server/src/relay/server.js`（中转）、
`server/src/relay/agent.js`（电脑侧）。测试：`npm test`（帧纯单测）+ `npm run test:relay`（端到端 + 边界/故障）。

## 四、安全与限制

- **`RELAY_SECRET` 一定要设**：不设的话任何人都能往你的中转挂 agent。
- **配对码是 12 位十六进制（48 bit）**，由电脑侧生成；换一次就断掉所有已连的手机。
- **中转不存内容、不做鉴权**：真正的鉴权还是电脑侧那台服务端的 token/pairing。
- **必须用 TLS**（https/wss）：不然 token 会在公网明文传输。
- **单帧上限 16MB**（`MAX_FRAME_BYTES`）：超限不截断，一律回明确错误。
  - 电脑侧响应太大 → HTTP 413，body `{"code":"frame_too_large"}`；
  - 手机 ws 消息太大 → 那条桥接以 1013 关闭（超过 ws `maxPayload` 的由 ws 层 1009 关闭）；
  - 手机 POST 太大 → 中转直接 413，提示改用分片上传。
  - 大文件走分片（App 对 >8MB 的文件自动分片，4MB/片），别用单发 `/api/uploads`。
- 中转侧 `maxPayload = MAX_FRAME_BYTES * 2`（base64 膨胀 4/3，留一倍余量），
  超限在 ws 层就被挡掉，进不到业务代码里。
- 两个入口都有 `uncaughtException` / `unhandledRejection` 兜底：记日志、继续服务，
  不会因为一条坏帧把全部连接带走。
- 中转只搬字节，`mcp` 工具、后台进程、审批这些都在电脑上跑，行为与局域网一致。

## 五、不做的事（留给用户）

- 不内置多租户、计费、账号体系；
- 不做内网穿透协议（UDP/TCP 打洞）—— 那是 frp/Tailscale 的活；
- 不在 App 里加"中转专用"的配置项：服务器地址本来就是任意 URL，够用了。
