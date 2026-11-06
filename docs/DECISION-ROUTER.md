# 快速决策路由（Jev / TypeSafe）

> 这层解决什么：产品里有一批"小判断"，走完整 LLM 推理太贵也慢，
> 交给专用决策模型几百毫秒就能拿到结构化答案。
> 但**不是所有判断都适合**，所以做成了逐点声明的注册表，而不是全局替换。

## 一、为什么是注册表

三类判断不能走决策模型：

| 类型 | 例子 | 原因 |
|---|---|---|
| 必须确定性 | 危险命令放行 | 概率模型判错一次就是事故 |
| 高频 | 群里每条消息 | 每次发网络请求，成本和延迟都受不了 |
| 不需要判断 | 按目录取第一个模型 | 没有判断空间，白花钱 |

所以每个决策点自己声明 `weight`：

- `ideal` —— 低频、可校验、判错无所谓，优先接
- `careful` —— 低频但判错有代价，**要求置信度门槛**
- `unsuitable` —— 不接

只有 `ideal` / `careful` 会进 `isJevCandidate`。

## 二、两条线

```
Jev 开着  → 注册过的点走决策模型
没开      → 一切走原有逻辑，行为和没这个功能完全一致
```

默认**关闭**。这是个额外的外部依赖：开着意味着派活这类操作多一次网络往返，
还要用户自己有 key，不想用的人不该被迫承受延迟和费用。

开关只看 `shouldUseJev` 三重条件：全局开着 + 点已注册 + 没被单独关掉 + 有地址和 key。

## 三、一次决策的生命周期

```
调用方给 point 名 + 素材
  → 查注册表：开了吗？支持吗？
  → 组请求 → 调 Jev → 解析 → **跑校验器**
  → 任何一步不成立 → fallback，调用方走原逻辑
```

**校验器不能省。** 决策模型输出的是概率和选项名，它不是"权威"，
只是一个更快的判断者。选项名拼错、分数越界、置信度太低，
都必须落回原逻辑，而不是把瞎猜的结果当真。

## 四、端点与请求格式（实测，不是抄文档）

### 端点

```
https://api.typesafe.ai   ← TypeSafe 官方，key 属于它
https://jev-ai.pro/api    ← Jev AI 的兼容端点，key 不通用
```

同一个 key 实测：官方 200 / 兼容端点 401。**两家不同的服务**，
key 的余额属于哪家就只能用哪家。默认值用官方端点。

### 请求

```json
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <key>

{
  "model": "jev-latest",
  "state": { "document": "要判断的内容" },
  "questions": {
    "名称": { "type": "noul", "instructions": "是/否问题" },
    "名称": {
      "type": "choice",
      "instructions": "说明",
      "criteria": { "选项A": "什么时候选它", "选项B": "什么时候选它" }
    },
    "名称": {
      "type": "score",
      "instructions": "评分说明",
      "criteria": ["档位1描述", "档位2描述"]
    }
  }
}
```

**文档与实际 schema 不一致，以实测为准：**

- `choice` 的选项在 `criteria` **对象**里，值是该选项的适用条件（不是 `options` 数组）
- `score` 也要 `criteria`（列出档位），不是 `min`/`max`
- 问题是**具名对象**，不是数组
- `type` 必须是 `noul` / `choice` / `score` / `box` 之一

### 响应

```json
{
  "model": "jev-1.14.0",
  "answers": {
    "名称": { "type": "noul",   "noul": 0.98 },
    "名称": { "type": "choice", "choice": "billing", "confidence": 1.0, "probabilities": {} },
    "名称": { "type": "score",  "score": 4 }
  },
  "usage": { "input_tokens": 384, "output_tokens": 54 }
}
```

`noul` 返回 **0~1 概率**，不是布尔。`parseAnswers` 按阈值折算成布尔，
同时把概率换算成置信度（离 0.5 越远越有把握）。

### 实测性能

一次调用 220~970ms，输入约 384 token，输出约 54 token。

## 五、已注册的决策点

| 点 | 权重 | 判断什么 |
|---|---|---|
| `assign-model` | ideal | 这个成员要干什么活 → 哪一类 |
| `compact-keep` | ideal | 压缩时哪些内容不能丢 |
| `pick-mcp` | ideal | 这次任务该挂哪些 MCP |
| `should-reply` | careful | 群聊里这条消息值不值得接 |

## 六、模型推荐：只信"性质"，不信模型名

`model-recommend.js` 刻意**不让决策模型直接吐模型名**：
模型目录是用户配的、会变，让决策模型记名字是在制造漂移。

改成两步：
1. Jev 判断"这是重推理 / 写代码 / 查资料 / 写文案 / 简单活"
2. 本地按能力在已启用模型里排序挑一个

### 排序踩过的坑

第一版让"用户会等着看结果"直接加权重，结果三类任务全挑中带 `flash` 的那个 ——
因为这个信号对几乎所有活都成立，没有区分度。

改成：**质量优先的活（推理 / 写代码 / 查资料）忽略"要快"**，
速度只能在不伤质量时当加分项。写代码图快想错一步要返工，反而更慢。

## 七、对照 Grok Bot 的做法

用 REA 拆过 `/Applications/Grok Bot.app` 的 asar，它的 Jev 用法有三处：

### 1. ChatReview —— 判断对话该怎么处理

```
GrokBotMeetingRequestLogChatReview:
  verdict      （结论）
  decidedBy    （'rules' | 'jev' —— 谁做的主）
  durationMs
  jev          （子结构）
  reasons[]
```

**关键设计：`decidedBy` 显式记录"这条结论是规则给的还是模型给的"。**
排查时能直接区分"规则就不对"和"模型这次判歪了"。

我们的 `decide()` 也返回 `source: 'jev' | 'fallback'`，同样的思路。

### 2. JevCall 事件 —— 每次调用都留痕

```
lines[], earlierLineCount, start?, startThreshold,
model, durationMs, error, decision, saved, handoffIndex?
```

注意 `saved` 和 `startThreshold`：它记录的是"这次调用**省下了什么**"
（是否避免了启动一轮完整推理）和"启动阈值是多少"。
这是把决策模型当成**成本优化**来度量，不只是当成判断器。

我们目前没做这个度量 —— 值得后续加：记录每次决策省了多少 token / 多少秒。

### 3. SmartModeClassifier —— 工具调用该不该放行

```
decision: UNSPECIFIED | ALLOW | BLOCK
附带: block_reason, proposed_allow_rule, applied_rules[],
      blocked_effect, irreversible, high_stakes, jev_path
rule effect: UNSPECIFIED | ALLOW | ASK_FIRST
```

这个我们不接，理由见第一节：**危险命令放行必须确定性**。
它的 `proposed_allow_rule` 设计（模型建议一条规则让用户确认后落成规则）
比"每次调用都问模型"更稳，但也更复杂，当前没有真实需求。

## 八、测试覆盖

- `decision-router.mjs`（30 项）：注册表完整性、两条线判定、失败归类、
  答案解析、降级路径、置信度门槛
- `model-recommend.mjs`（12 项）：质量优先不挑轻量模型、长上下文排序、
  Jev 判错/网络失败都落回 fallback
- `decision-settings.mjs`（14 项）：默认关闭、脏数据规范化、
  key 落盘加密、解不开的密文当没配

## 九、已知未做

- 没有决策用量度量（省了多少 token / 时间）
- 没有"模型建议一条规则、用户确认后落成规则"的机制
- `should-reply` 虽已注册，但群聊主流程还没接（为避免高频调用，需要先做批处理/节流）
