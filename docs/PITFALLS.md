# 踩过的坑

按"会再次咬人"的程度排序。每条都附了修法。

---

## 1. pi SDK：`execute` 的第一个参数是 `toolCallId`，不是 `params`

**症状**：所有自定义工具拿到的参数都是 `undefined`，建出来的 bot 全叫「新 Bot」，模型也全是默认。

**根因**：pi 1.2.0 的签名是
```ts
execute(toolCallId: string, params: Static<TParams>, signal, onUpdate, ctx)
```
写 `execute: async (params) => {...}` 时，`params` 实际拿到的是那个 id 字符串。

**修法**：`execute: async (_toolCallId, params) => {...}`。

---

## 2. pi SDK：工具返回值必须是 `{content:[{type:'text',text}], details}`

**症状**：工具执行了（日志有记录），但模型说"list_models 全程返回空内容，我拿不到可用的 slug"。

**根因**：写成了 `{ text: '...', details: {} }`。`AgentToolResult` 的定义是
```ts
interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];   // ← 模型看到的是这个
  details: T;
  isError?: boolean;
}
```

**修法**：
```js
const ok   = (text, details = {}) => ({ content: [{ type: 'text', text }], details });
const fail = (text, details = {}) => ({ content: [{ type: 'text', text }], details, isError: true });
```

---

## 3. 模型探活：`maxTokens` 给太小会被推理吃光 → 误判"模型挂了"

**症状**：模型明明能用，探活却报"空回复"。

**根因**：探活用 `maxTokens: 24`，推理型模型的思考内容先把额度用完了，剩下的正文是空。另一个坑：有些推理模型不允许关闭思考，传 `reasoning: 'off'` 直接 400。

**修法**：`{ maxTokens: 512, reasoning: 'low' }`。

---

## 4. `xlsx` 的 ESM 导入：`readFile` 只在 default 导出上

**症状**：`XLSX.readFile is not a function`。

**根因**：`import * as XLSX from 'xlsx'` 拿到的命名空间里只有 `read/write/utils/...`，`readFile` 挂在 default 上。

**修法**：`import XLSX from 'xlsx'`。

---

## 5. `mammoth` 把 Word 里的图片内联成 base64 → 正文被挤没

**症状**：解析 docx 只得到一堆 `![](data:image/png;base64,iVBOR...)`，300 字的预算全被一张图吃掉。

**修法**：
```js
mammoth.convertToMarkdown({ path: file }, {
  convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
})
```
再加一层正则兜底清掉残留的 data URI。

---

## 6. `pdf-parse` 新版 API 完全不同

v2 是 `new PDFParse({ data: buffer })` + `await parser.getText()`，没有 `pdf-parse/lib/pdf-parse.js` 这个子路径（`exports` 里没暴露，import 会报 "Package subpath not defined"）。

---

## 7. Flutter 图标 tree-shaking 缓存：新增图标后不清缓存会渲染成空白

**症状**：新加了一个设置齿轮按钮，圆圈里什么都没有。字体只有 6660 字节。

**根因**：release 构建会把 MaterialIcons 从 1.6MB tree-shake 到几 KB。**新增图标后如果没清缓存，Windows 构建会直接复用上一次 tree-shake 出来的字体**，新图标的字形不在里面。

**修法**：`flutter clean` 后重建（字体变成 8288 字节就对了）。**以后加图标记得 clean**。

---

## 8. 图标批量替换脚本：正则要加前置边界

**症状**：`Icons.settings` → `LucideIcons.settings` 之后，`LucideIcons.settings` 里的 `Icons.settings` 又被匹配一次，变成 `LucideLucideIcons.settings`。

**修法**：`new RegExp('(?<![A-Za-z0-9_])' + escaped + '(?![A-Za-z0-9_])')`。

**顺带**：出错时直接用 `git checkout -- app/lib` 回滚重来——这就是先建 git 基线的好处。

---

## 9. MSVC：C++ 源码里有中文注释会报 C4819 并当错误

**症状**：`flutter build windows` 失败，`warning C4819: 该文件包含不能在当前代码页(936)中表示的字符`，然后 `error C2220: 以下警告被视为错误`。

**修法**：`windows/runner/CMakeLists.txt`
```cmake
if (MSVC)
  target_compile_options(${BINARY_NAME} PRIVATE "/utf-8")
endif()
```

---

## 10. Android：`file_picker` / `image_picker` 要求 compileSdk ≥ 36

**症状**：`checkReleaseAarMetadata` 失败，`Dependency ':flutter_plugin_android_lifecycle' requires ... version 36 or later`。

**修法**：在 `android/build.gradle.kts` 里**必须在 `evaluationDependsOn(":app")` 之前**注册：
```kotlin
subprojects {
    afterEvaluate {
        val ext = extensions.findByName("android")
        if (ext is com.android.build.gradle.BaseExtension) {
            val cur = ext.compileSdkVersion?.removePrefix("android-")?.toIntOrNull() ?: 0
            if (cur < 36) ext.compileSdkVersion(36)
        }
    }
}
```
用 `plugins.withId` 无效（那时 Flutter 插件还没设置 compileSdk）。

---

## 11. Windows：Kotlin 增量编译缓存会坏

**症状**：`Could not close incremental caches ... class-fq-name-to-source.tab`。

**修法**：`android/gradle.properties` 加 `kotlin.incremental=false`。

---

## 12. `dart format` 和 `curly_braces_in_flow_control_structures` 打架

`dart format` 会把单语句 `if` 收成一行，而 flutter_lints 的这条规则要求加花括号。在 `analysis_options.yaml` 里关掉这条 lint。

**另外**：`dart format` 会改缩进，导致之前基于缩进写的补丁脚本 `oldText` 匹配不上——改完记得重跑脚本前先看格式。

---

## 13. 用 `write` 工具"追加"代码会覆盖整个文件

**症状**：想往 `pi-runner.js` 里加一段，结果整个文件只剩那段。

**修法**：`write` 是全量覆盖，追加要用 `edit` 或 `cat >> file`。**没有 git 的话就完蛋了**（这次有基线，`git checkout` 直接救回来）。

---

## 14. `@` 和名字之间夹 emoji

**症状**：部门老大写了 `**@🎨UI设计师**：出视觉规范`，但成员一个都没被叫到。

**根因**：`parseMentions` 的正则是 `@\s*名字`，中间夹了 emoji 就匹配不上。

**修法**：
```js
new RegExp(`@[\\s\\p{Extended_Pictographic}\\uFE0F\\u200D]*${escapeRe(name)}`, 'gu')
```

---

## 15. 模型会把"汇报"理解成"开工"

**症状**：用户说"大家各自报一下自己负责什么"，成员真的开始建文件、探测数据源（9 个 bash 调用）。

**修法**：群提示词里显式区分：
```
- 用户只是在问情况 / 要分工 / 要计划 / 要确认 / 打招呼 → 就用文字回答，**不要动手**
- 用户明确要你做事（做/改/跑/生成/写代码/查数据/出图）→ 把事做完，直接给结果
```

---

## 16. 12 步上限对写代码的部门太紧

**症状**：后端工程师写了 4 个文件就被收住（`在群里动手步数到上限`）。

**修法**：提到 30 步，并补一个 5 分钟时间预算（`groupTurnMaxMs`）。

---

## 17. `nohup ... &` 前面的 `cd` 在子 shell 里

**症状**：`cd /d/pi-bot/server && node src/index.js &` 之后的命令仍在旧目录，`node tests/x.mjs` 报找不到模块。

**根因**：`A && B &` 把整个 `A && B` 放进后台子 shell。

**修法**：分开写，或用绝对路径。

---

## 18. 每次变更重写全部房间的消息文件

**症状**：20 个部门时每次消息变更要 58ms（每个房间 500 条消息，全部 JSON.stringify + 写盘）。

**修法**：`dirtyRooms` 集合，只写有变更的房间（2.9ms，20 倍提升）。

---

## 19. 流式 delta 触发整棵树重建

**症状**：每 80ms 一次 `msg.delta`，`notifyListeners()` 会把左侧会话列表也重建一遍。

**修法**：加一个独立的 `ValueNotifier<int> streamTick`，delta/steps 只 bump 它；只有消息列表订阅。

---

## 20. 每个 (房间 × bot) 一个 AgentSession，内存一直涨

**修法**：LRU（`config.maxSessions`，默认 40），超出时释放最久没用且不忙的。

---

## 21. `flutter build apk` 报 "Gradle requires JVM 17 or later"

**症状**：`Running Gradle task 'assembleRelease'...` 一秒后失败，日志里是
`Gradle requires JVM 17 or later to run. Your build is currently configured to use JVM 8.`
（`flutter doctor -v` 同时会提示 `X Could not determine java version`）

**根因**：`JAVA_HOME` 指着一个 JDK 8 —— 很多机器上本来就装着 1.8，或者没装
Android Studio、Flutter 顺着 `JAVA_HOME` 就落到了 1.8 上。
（Flutter 找 JDK 的顺序：Android Studio 自带的 → `JAVA_HOME` → PATH。）

**修法**：让它指向任意一个 JDK 17+。三种写法，按影响范围从小到大：

```bash
# ① 只影响这一次构建（临时）
JAVA_HOME="/path/to/jdk-17+" flutter build apk --release

# ② 一劳永逸，而且**不污染仓库**（推荐）—— 写进用户级 gradle 配置：
#    Linux/macOS: ~/.gradle/gradle.properties
#    Windows:     %USERPROFILE%\.gradle\gradle.properties
org.gradle.java.home=/path/to/jdk-17+

# ③ 或者让 Flutter 自己记住
flutter config --jdk-dir="/path/to/jdk-17+"
```

> ⚠️ **别写进 `android/gradle.properties`** —— 那个文件是要提交的，等于把你的机器路径
> 发给每一个 clone 的人。凡是"跟这台机器有关"的东西（JDK 路径、SDK 路径、本地代理、
> API key）一律放用户级配置或环境变量。

**顺带**：图标全换成 Lucide 后，构建日志里
`MaterialIcons-Regular.otf ... reducing it from 1645184 to 1588 bytes` 是**正常**的 ——
1588 字节说明没有任何 `Icons.xxx` 被引用，字体被削成空壳是应该的。
（对比第 7 条：只要代码里还有 `Icons.xxx`，这 1588 字节就意味着那些图标全是隐形的。）

---

## 22. 菜单每一项文字下面挂着两条绿线 —— Overlay 里没有 Material 祖先

**症状**：右键菜单里每一项文字下面都有两条横杠，颜色还不受控制（截图里像绿色/黄色）。
看着像自己写的样式出了问题，其实是 Flutter 在提醒你别的。

**根因**：Flutter 的 `Text` 找不到 `Material` 祖先时，会**故意**用
`TextDecoration.underline` + `TextDecorationStyle.double` + 黄色来画文字 ——
这是它的提示机制，不是渲染 bug。

而**插进 `Overlay` 的浮层不在 app 的 `Material` 之下**：`Overlay` 挂在 `Navigator` 上，
`MaterialApp` 给的 `DefaultTextStyle` 传不到那里。所以菜单、弹层、Toast
这类浮层全都会中招。

**一行定位**（比截图快得多）：

```dart
debugPrint(DefaultTextStyle.of(tester.element(find.text('置顶'))).style.toString());
// → decoration: TextDecoration.underline, decorationStyle: TextDecorationStyle.double
```

**修法**：浮层卡片外面套一层 `Material(type: MaterialType.transparency)` ——
只借 `DefaultTextStyle`，不画底色，圆角/边框/阴影还是自己那个 `Container` 画。

**回归测试**：断言 `DefaultTextStyle.of(...).style.decorationStyle != TextDecorationStyle.double`。
这种坑肉眼描述起来都费劲，但一行断言能永久钉住。

**同类**：`msg_ref_chip.dart` 的窥视弹层（也是 Overlay），一起修了。

---

## 23. 模型组填了「思考」却根本不思考 —— 格式错了不会报错

**症状**：模型组里明明配了思考强度，界面也能选 high / max，但模型回答明显没在思考；
探活还全是绿的，日志里一条错都没有。

**根因**：`thinkingFormat` 决定 pi 用哪种协议把思考参数发给上游：

| 上游 | 正确格式 | 写错的后果 |
|---|---|---|
| DeepSeek / WorkBuddy（独立 `reasoning_content` 通道） | `deepseek` | 写成 `openai` → 上游不认 `reasoning_effort`，**静默不思考** |
| OpenAI / 兼容中转 | `openai` | 写成 `deepseek` → 把 `reasoning_content` 当协议发，同样无效 |
| 智谱 GLM | `zai` | 走 `openai` 时只有 low/medium/high 生效，xhigh/max 丢失 |

更隐蔽的是 `thinkingLevelMap`：`xhigh` 映射到哪个上游值各家不同（DeepSeek 是 `max`），
映射漏一档就是「界面选了最高、实际用中档」。

**修法**：模型组里每个模型单独存 `reasoning` / `thinkingFormat` / `thinkingLevelMap`，
服务端 `model-thinking.js` 按格式套预设，`toProviderConfig()` 必须落在**模型级 compat** 上
（provider 级写了不生效，见下一条）。关掉思考时要把格式和映射一起清空，
否则残留配置会继续下发。

**回归测试**：`server/tests/model-thinking.mjs` 断言预设映射、格式切换重套预设、
关思考清空、以及 provider 输出的 `compat.thinkingFormat`。

---

## 24. `authHeader` / `thinkingFormat` 写在 provider 级不生效

**症状**：provider 上明明写了 `authHeader: true`，一到真跑就 `No API key found for <组名>.`；
或者 provider 级写了 `thinkingFormat`，思考参数就是不出现。

**根因**：pi 的 `getApiKeyAndHeaders` 是**按模型**读 `authHeader` / `thinkingFormat` /
`supportsReasoningEffort` 的。provider 级那份只是兜底，模型对象上没有就按默认走。

**修法**：`ModelGroup.toProviderConfig()` 里每个 model 都带一份完整的
`compat: { supportsDeveloperRole, supportsReasoningEffort, thinkingFormat }`。
这也是「模型组加了能用、但跑起来说找不到 key」的经典成因。

---

## 25. 模型组 key 对、baseUrl 端口错 —— 401 长得像 key 失效

**症状**：模型组填的 key 明明和别处一样，探活却一直 `401 unauthorized`。

**根因**：同一台机器上常同时跑中转站和各类 relay，端口不同、**前门鉴权用的也是不同的 key**。
例如 `:8898` 是 relay（认 relay 自己的 local key），`:3000` 才是 new-api（认 new-api token）。
两者长得像，改配置时最容易只改一半。

**修法**：改动 baseUrl 后先用 `curl <baseUrl>/models -H "Authorization: Bearer <key>"`
确认 `200`，再回设置页点测试。注意部分中转站的 `/models` **不校验 key**，
所以「通过了」只说明地址通，不等于 key 有效 —— 再发一次最小 chat 请求才算数。

**另一个坑**：探活结果缓存 24 小时（`model-health.json`）。改了 baseUrl/key 之后
旧的 401 还在缓存里，界面会继续显示失败。要么在设置页重新测一次，要么删掉该模型的缓存条目。

---

## 26. 一套模型组配置要同时在 Windows 和 Mac 生效

**症状**：Windows 端加了思考强度，Mac 端打开设置看不到；或者两端默认值不一致。

**根因**：枚举值（档位、上游格式）如果写死在各自的 UI 里，两端迟早漂移。

**修法**：枚举只在服务端定义一次（`model-thinking.js` 的 `THINKING_LEVELS` /
`THINKING_FORMATS` / `THINKING_PRESETS`），通过 `GET /api/model-thinking/options` 下发；
客户端拿不到时回退内置七档，但不新增服务端没有的取值。
新增一种上游格式 = 只改服务端一处，两端同时生效。

---

## 27. MCP 默认一个都不连 —— 但"配了"不等于"生效"

**症状**：在设置里加好了 MCP 服务、开关也打开了，bot 却用不上那些工具。

**根因**：MCP 有**两道门**，只过一道都不行：

| 门 | 位置 | 作用 |
|---|---|---|
| ① 服务自己启用 | 设置 → MCP → 那条的开关 | 关闭时连配置都不会进会话 |
| ② bot 选中它 | bot 编辑页 → MCP 能力 | 没选中的 bot 不会挂载任何 MCP |

之所以设计成两道门：MCP **真的会起子进程**（一个 `npx` 服务几百 MB）。
pi-bot 里可能同时开几十个 bot 会话，每个都挂一份会直接把机器拖死。

**为什么不用 session option**：pi 的 MCP 不是 `createAgentSession` 的参数，
而是**扩展注册**（`pi.registerMcpServer(name, config)`）。所以走 `mcp-hook.js`
这个内联扩展，在建会话时按 `store.mcpServersFor(botId)` 逐个注册。
改配置无法热替换（工具 schema 在连接时就定了），只能作废重建会话。

**回归测试**：`server/tests/mcp.mjs` 断言"停用不进配置""bot 没选返回空"。

---

## 28. MCP 的 name 会被拼进工具名，中文/空格会让工具彻底调不到

**症状**：MCP 服务看起来连上了（日志显示已挂载），但模型从来不用它的工具。

**根因**：pi 把 MCP 工具命名成 `mcp__<server>__<tool>`。名字里只要有空格、中文、
斜杠，拼出来的工具名就不是合法标识符 —— 模型能看到列表却调不动。

**修法**：`mcp.js` 的 `mcpNameError()` 只允许 `[a-zA-Z0-9][a-zA-Z0-9_-]*`，
入库时就拒，而不是等连上了才发现工具用不了。bot 的 `mcpServers` 字段也走同一套校验，
非法名字直接丢掉。

**同类坑**：把 URL 填进 stdio 的 command 里（会起不来）、
远端用明文 http（key 会裸奔）。这两个都在 `mcpRejectReason()` 里点名报错。

---

## 29. 前端选的 MCP 名字，服务端删了同名服务就静默失联

**设计取舍**：`bot.mcpServers` 存的是**名字**而不是 id。

好处：用户删掉一条再建同名的，原来选上它的 bot 仍然能接上 —— 存 id 的话
每重建一次就得把每个 bot 重新选一遍。

代价：名字对不上时会静默失效。所以 `store.mcpServersFor()` 里查不到就跳过，
不报错（否则删一个服务会让整个会话建不起来）；`update_bot` 工具则会**显式校验**
名字存不存在、是否已启用，避免模型以为配好了其实没生效。

---

## 30. 别让用户把已经装好的东西再手抄一遍

**症状**：用户终端里的 pi 早就装了一堆 skill（`~/.pi/agent/skills/*/SKILL.md`）
和 MCP（`~/.pi/agent/mcp.json`），但在 pi-bot 里是一张白纸，得重新手填。

**根因**：pi-bot 是独立进程，`resourceSwitches()` 默认不加载这些
（它们会给每个 bot 会话拉子进程，几十个 bot 并存会拖死机器）。
不加载是对的，但**不扫描是错的** —— 加载和发现是两件事。

**修法**：`local-capabilities.js` 只读扫描，扫描结果里每条标出 `imported`
（库里是否已有同名）。导入是"复制一份过来"而不是引用：两边独立，
用户在终端里改了自己那份不会影响 pi-bot，反之亦然。

**踩到的具体坑**：
- SKILL.md 的 frontmatter 支持 YAML 块标量（`description: >`）。
  只按 `key: value` 一行行读，摘要会变成字符串 `">"`。
  `parseFrontmatter()` 现在支持 `>`（折叠）和 `|`（保留换行）两种。
- 有些 skill 目录里没有 `SKILL.md`（自带一堆文档的），退回取最大的 `.md`。
- `mcp.json` 的名字会拼进工具名，非法名字（空格/中文）直接跳过，
  而不是导进来之后发现工具调不到。

---

## 31. 主控接入外部系统：必须先确认再落盘

**为什么要分两步**：自动探测会猜错（登录路径、字段名、哪些接口算"模块"）。
猜错了直接建出一个连不上的系统，用户还得去设置里删 —— 比先确认一遍更烦。

流程（`site-draft.js`）：

```
stage_site   抓到的模块写进草稿（可分批，按 path 去重合并）
   ↓
confirm_site 把草稿摊成一张卡片让用户拍板
   ↓
commit_site  用户确认后才 addSite + createDepartment
```

**两个设计细节**：

1. **换系统时清空旧模块**。否则用户说"改成另一个站点"，
   A 系统的 `/api/...` 会残在清单里，建出来的团队拿着 A 的路径去查 B，一直 404。
2. **草稿只存内存**。它是待确认的中间态，进程重启就没了才是对的 ——
   留着一堆半成品草稿，用户会不知道哪个是有效的。

**口令绝不出现在确认文本里**：那段文字会发到聊天里、进模型上下文和聊天记录。
`describeDraftForConfirm()` 只写"口令已收到"。

---

## 32. 主控是唯一能发卡片的例外 —— 但只在接入系统这一步

主控（mainbot）默认没有 `ask_user`：它本来就在跟用户直接对话，
弹卡片等于把一句话拆成"卡片 + 一次点击"，而且会卡住整轮推进。

**唯一例外**是 `confirm_site`：接入一个外部系统是长期契约，
需要用户明确点头并留下记录，所以它自己写一条 `kind: 'ask'` 卡片。
这是刻意留的口子 —— 别在别处学它。
