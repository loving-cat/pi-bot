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

---

## 33. Windows 上 npx/npm 是 `.cmd` —— 直接 spawn 会说"找不到命令"

**症状**：MCP 里填 `npx -y @modelcontextprotocol/server-filesystem .`，
在 Mac 上好好的，Windows 上点"测试连接"报找不到命令，或者命令起来了但参数被截断。

**根因**：Node 在 Windows 上解析 `npx` 要靠 `PATHEXT`，而 `npx.cmd` 是批处理 shim。
Node 22 起对 `.bat/.cmd` 的 `shell:false` 行为各小版本不一致
（CVE-2024-27980 之后有的版本直接抛 `EINVAL`）。反过来用 `shell:true` 更糟：
参数会被拼进一条命令串，用户填的 `--root "C:\My Files"` 里只要有空格/引号/`&`，
就会被 cmd 重新切分甚至执行别的命令。

**修法**：`server/src/spawn-command.js` 显式按 `PATHEXT` 解析真实文件；
`.cmd/.bat` 用 `cmd.exe /d /s /c` 传一条**逐参数转义**过的命令行
（cross-spawn 同款规则；只有 `node_modules/.bin/*.cmd` 这种 npm shim 才双转义，
它内部会再展开一次 `%*`）。参数里带空格的用例写在 `server/tests/mcp.mjs`。

---

## 34. taskkill 在实时防护下会卡 2.8 秒 —— 别放在服务端热路径

**症状**：偶尔（约一半概率）整个服务端像抽风一样停 2~3 秒，HTTP/WS 全都不响应，
之后自己恢复。日志里什么都没有。

**根因**：`spawn('taskkill', ...)` 的耗时不在 taskkill 本身，而在
`CreateProcessW` —— 装了实时防护的机器上，创建进程会被同步扫描，
实测 **2.8 秒**，而且是同步调用，直接冻住 Node 主线程。

**修法**：需要结束探测进程时，不要调 taskkill：

```js
child.stdin?.end();   // MCP 的 EOF 退出信号，服务会自己退
child.kill();         // 再收掉直接子进程
```

"测试连接"的探测就这样做，实测 3.0s 返回、无残留进程。
真正的会话结束仍交给 pi 自己的 `taskkill /T`（不在服务端热路径上）。

**同一类坑还有第二个入口**：读系统代理要跑 `reg query`，同样是
`CreateProcessW`，同样会被扫 3~6 秒。这次没法不用子进程，所以拆成两步：
`http-client.js` 把读注册表放进 **worker 线程**（卡在 worker 里，主线程不冻），
解析（`parseWindowsProxyValue`）留在主线程做纯函数；
缓存过期时**先返回旧值、后台刷新**，别让搜网页/探站点替探测付等待。
实测：到期那次调用 1ms 返回，后台刷新完成后的下一次调用 0ms。

---

## 35. Windows 上只用 `Program Files\nodejs` 找 node 会漏掉一大半用户

**症状**：用户明明装了 node（`node -v` 能跑），App 说找不到；或者装了两个版本，
挑到的是旧的那个。

**根因**：Windows 的版本管理器不会把 node 放进固定系统目录：
nvm-windows 在 `%APPDATA%\nvm\vX.Y.Z`、fnm 在 `node-versions\<ver>\installation`、
Volta 在 `%LOCALAPPDATA%\Volta\bin`、Scoop 在 `scoop\apps\nodejs\current`。
另外目录名解析不能只看 `/`：`C:\...\node\v22.10.0` 里同时有反斜杠，
按 `/` 切会把 `node\v22.10.0` 当成版本名，解析成 `[0,0,0]`，排序就退化了。

**修法**：`locate.dart` 把这几种目录都纳入候选，并用
`versionDirsDescending()` 统一按主/次/补丁**降序**（正反斜杠都认）。
和 macOS 的 nvm 支持是同一套规则，别在两边各写一份。

---

## 36. 打包脚本别先删成品 —— 那正是要发出去的东西

**症状**：`pack-windows.ps1` 跑到一半 npm install 失败（断网/私有源/磁盘满），
回头发现 `dist/pi-bot-windows` 已经被删了，上一个能发的包没了。

**根因**：老脚本第一行就 `Remove-Item -Recurse dist/pi-bot-windows`，
然后才开始复制 —— 失败路径没有任何东西可回滚。

**修法**：先在 `dist/.pack-windows-<rand>/` 里把包铺完、依赖装完、布局校验完，
最后才"旧包改名备份 → 新包换进去 → 删备份"。任何一步抛错都把旧包搬回原处。
`pack-macos.sh` 用的是同一套"暂存 + 回滚"结构，改一边别忘了另一边。

---

## 37. `$list.length` 不是长度 —— 整个列表被插进了界面

**症状**：设置 → 技能 →「本机已装」那一行变成

```
本机已装 20 个 · [chinese-lit-persona, code-quality, executing-plans, …].length 个可导入
```

一行扫出一万多像素宽，右边的「全部导入」被挤出屏幕（用户看到的就是按钮消失了）。

**根因**：Dart 的 `$name` 会**吞掉整个标识符**，后面的 `.length` 只是普通字符：

| 写的 | 实际含义 |
|---|---|
| `'$pending.length'` | `${pending}` + 字面量 `.length` → `[a, b, …].length` |
| `'${pending.length}'` | 数字 |

这种错**不会报编译错误**，`unnecessary_brace_in_string_interps` 这类 lint 也抓不到
（它管的是相反方向：多余的括号）。只有在名字列表足够长、或者真的把属性名读到界面上时
才会露出来 —— 短列表时看起来只是“文案有点怪”。

**修法**：

1. 取属性/方法一律写 `${list.length}`、`${obj.title}`，别省括号；
2. 头部这类可能变长的文本，一律 `Expanded`/`Flexible` + `maxLines: 1` + `ellipsis`，
   保证右边的按钮**永远有位置**（按钮先占位，文本再缩）；
3. 回归用例：`app/test/local_capabilities_test.dart` 用 20 个长名字跑，
   断言无 `RenderFlex overflow`、按钮落在可视宽度内，并且界面里不能出现 `[`
   （出现就说明又把 List.toString() 打进界面了）。

---

## 38. 经验库/记忆这类功能，最大的风险不是没数据，是上下文被撑爆

**症状**（还没发生，但一定会）：经验库越攒越多，每条都"有点用"，于是每轮都注入
十几条 —— 提示词被塞满，模型开始挑错重点、忘掉真正的要求，而且**越用越慢越贵**。

**根因**：注入量随库大小线性增长。任何"记住更多"的功能，只要没有硬上限，
最后都会变成上下文污染源。模型不会告诉你"你给的东西太多"，它只会悄悄变笨。

**修法**（`lessons.js` 里已经是硬约束，改之前先想清楚）：

| 闸门 | 取值 | 为什么 |
|---|---|---|
| 只注入 `active` | — | 新写的都是 candidate，只出现在界面，不会自动进提示词 |
| 一次最多几条 | 3 | 15 条"有点用"不如 3 条"确实相关" |
| 一次最多多少字 | 600 | 按渲染后计；塞不下就截断当前条，连 40 字都放不下就整条不要 |
| 只注入什么 | cue + lesson | evidence 留在库里给人审计，不进上下文 |
| 谁读 | 只给主控 | 派活质量决定后面所有轮次；成员层每轮注入一份，收益低、噪音大 |
| 什么时候挑 | 每轮按当前任务挑 | 不写进 appendSystemPrompt —— 会话是复用的，经验会变，固化进去就刷不掉 |
| 能不能启用 | 必须有证据 | 没有证据的"经验"是把错误做法固化下来 |

库本身可以很大（上限 200 条），但**注入量必须是常数** —— 这是这个模块的第一原则。

---

## 39. 让模型"按格式输出"，规则写在系统提示里不够

**症状**：复盘功能上线时，提示词里明明写了"只输出 JSON"，实测模型回了三段：
先是"收到，这条要求我记下了。不过执行前有两点需要跟你对齐……"，后来又换成
`{"entries":[{"type":"preference","scope":…,"confidence":0.9}]}` —— **字段名全是它自己造的**。
解析器拿到的 `lessons` 字段不存在，表现就是"复盘永远没有产出"。

**根因**：

1. 系统提示在对话里是"背景"，用户消息才是"当前任务"。模型会优先回答用户消息；
2. 记录里有真人说话，模型容易进入"对话模式"，把自己当成被纠正的那个 bot；
3. 小模型对字段名的记忆来自训练里的别的格式（entries / scope / confidence），
   光写"输出 JSON"约束不住。

**修法**（`lesson-reflect-prompt.js` 里已经这么写了）：

- **格式要求写进用户消息的末尾**，并且写成"你的回复必须以 `{"lessons"` 开头"，
  而不是"请输出 JSON"；
- 结构**内联展开**一遍（不要只给一句描述）；
- 明确"你不是对话参与者，不要回答记录里的任何问题"；
- 解析端**容错**：去 ```json 包裹、取第一个 `{` 到最后一个 `}`；调不对就返回空，
  绝不要把半截文本当经验；
- **证据要校验**：msgId 必须在输入里真实存在，quote 必须在对应消息原文里找得到
  （忽略空白）。模型编一个 msgId 或者改一句原话，是最常见的"看起来有证据"。

一句话：**提示词约束格式，解析器兜底；两处都别赌模型会守约定。**

---

## 40. 进程被杀，任务会永远停在「进行中」

**症状**：任务板一直显示「进行中」，但服务端早就没有那些会话了；重启也不消失。
用户原话："这个进行中一直不是很准"。

**根因**：任务的收尾在 `finishTask()` 里，而它挂在"这一轮跑完"之后。进程被 kill /
崩溃 / 重启时那一轮根本不会跑完 —— `status: 'doing'` 被原样写进 state.json，
下次启动没人再碰它。

**修法**：启动时调一次 `store.reconcileTasks()`，把**所有**遗留的 `doing`
放回待办，并在 detail 里留一句"上次运行被中断"（新进程里不可能还有在跑的任务）。
不要试图猜它是成功还是失败 —— 猜错比诚实地说"被打断了"更糟。

顺带两个同源的问题一起修了：

- **同一句话派给多个人**会在板上刷出 N 行一模一样的内容（fan-out 每人一条任务，
  这本身没错，但看着像重复 bug）。界面按标题合并成一行、副标题写「N 人：谁、谁」，
  勾一次 = 这 N 条一起完成。
- **产物没有回传**：以前只自动带图片。现在 `artifact-watch.js` 把这一轮新增/改过的
  交付物（pdf/docx/xlsx/csv/md/zip…，源码不算）也挂到消息上，单文件 ≤10MB、
  最多 5 个、合计 ≤25MB。只认快照差异，不把整个工作目录端进群。

---

## 41. `max` / `xhigh` 不是"有就传"——pi 要看到显式映射才认

**症状**：给模型选了「max」，跑出来和 high 没区别；问"为什么开不到 max"。
看起来是界面没生效，实际上是 pi 在创建会话时把它**静默 clamp** 成了 high。

**根因**（`@earendil-works/pi-ai` 的 `getSupportedThinkingLevels`）：

```js
if (level === "xhigh" || level === "max") return mapped !== undefined;
```

七个档位里，**只有 `xhigh` 和 `max` 要求 `thinkingLevelMap` 里显式写出映射**，
其余五档默认都支持。没有 map（或 map 里没这两档）时：

- 可选档位里根本不会出现 max；
- 就算选了 max，`clampThinkingLevel` 也会往下找到 high。

所以"模型支持推理（`reasoning: true`）"**不等于**"支持 max"。

**修法**（以 ctyun 为例，写在 `~/.pi/agent/models.json` 的模型上）：

```json
"thinkingLevelMap": {
  "minimal": "minimal", "low": "low", "medium": "medium",
  "high": "high", "xhigh": "max", "max": "max"
}
```

两个坑：

1. **不要写 `off: null`**。pi 把 `null` 当成"不支持这一档"，off 会从可选档位里消失，
   用户选 off 时会被 clamp 成 minimal。想表达"不传参"就别写 off（不在 map 里 = 不下发）。
2. **上游不一定吃 `max`**。ctyun 的 qwen 系列对 `reasoning_effort: "max"` 直接 500，
   但接受 `xhigh` —— 这种模型要把 max 映射成 `xhigh`，别照抄别的模型。

**验证**（不要只看界面）：

```bash
# 1) 这个模型现在支持哪些档位、max 会被 clamp 成什么
node -e "import('@earendil-works/pi-ai').then(async m=>{...})"

# 2) 建一个会话，看 effective thinkingLevel
#    以前 requested=max -> effective=high；加了映射后 requested=max -> effective=max
```

**pi-bot 这一侧也补了两处**：

- `availableThinkingLevels()` 现在把 off 永远算可选，并且只有 map 里显式写了
  `max` / `xhigh` 才把它们给前台（避免让用户选一个后台根本不会传的档位）；
- `/api/models` 对 **pi 级模型**（models.json 里的，不在模型组里）也返回真实的
  `thinkingLevels`，以前只有模型组里的模型才带这个字段，前台只能瞎猜。

---

## 42. `server.listen` 的 EADDRINUSE 被 ws 库吞掉 —— 端口被占变成僵尸进程

**症状**：端口被占用时，pi-bot 进程**活着但不监听**。桌面端一直转圈，
日志里只有一句「未捕获异常（进程继续跑）：listen EADDRINUSE」，
没有 banner、没有配对码、也没有退出。

**根因有两层**：

1. 进程级有个 `uncaughtException` 兜底，本意是"长跑进程别因为一处异常整个挂掉"。
   它把 `EADDRINUSE` 也接住了 —— 于是进程继续跑，但端口从没监听成功。

2. 更隐蔽的一层：`new WebSocketServer({ server })` 会给 http server
   **挂一个自己的 error 监听器**（native 实现，只做内部清理）。
   用 `server.on('error')` 注册在后面时，那个 handler 先跑、把错误"消费"掉，
   我们的分支**永远不执行**。

**修法**：用 `server.prependListener('error', ...)`（排在 ws 的 handler 之前），
里面判断 `EADDRINUSE` / `EACCES`，打印人话（含 `lsof` 自查命令）并 `process.exit(1)`。

**回归测试**：`server/tests/boot-failure.mjs` —— 真起两个进程抢同一端口，
断言退出码 1 + 输出里有「已被占用」和 `lsof`。

---

## 43. 中转空口令只告警 = 把接管权限直接送人

**症状**：`node src/relay-server.js` 在公网服务器上跑，没设 `RELAY_SECRET`，
只打印一行「⚠️ 任何人都能往这台中转挂 agent」然后**照常启动**（默认监听 `0.0.0.0`）。

**为什么危险**：中转的作用就是把手机和电脑接起来。没有口令，任何知道端口的人
都能挂一个假的 agent 上来，手机连过去就是对方的机器 —— 聊天记录、配对 token 全给出去。
而中转通常丢在云服务器上、没人盯启动日志，这行警告等于没写。

**修法**（`relay-server.js`）：
- 空 secret + 非 loopback 监听 → **拒绝启动并退出**
- 空 secret + 只听 `127.0.0.1` → 放行（本地调试的正常用法）
- 确实要在内网裸跑 → 显式 `RELAY_ALLOW_OPEN=1`（把风险变成"想清楚了才做"的决定）

---

## 44. 同 code 重连会静默顶掉正在用的那台电脑

**症状**：拿到泄露 code 的人先连上中转，原主人的连接被 `close(4409, 'replaced')`
踢掉，主人侧只看到一条「被替换」日志 —— 不会意识到自己被顶了。

**修法**（`relay/server.js` 的 `onAgent`）：
- 新连接带了**正确 secret** → 视为同一台电脑重连（进程重启/网络抖动），
  替换旧的（正常运维，不能让老连接占着位置）
- 没 secret / secret 不对 → **拒绝新连接（4404）**，旧连接原封不动

**回归测试**：`server/tests/relay-safety.mjs` —— 真起 relay + 两个 WebSocket，
断言"没 secret 的第二台被拒、第一台仍 OPEN"和"带对 secret 可以替换"。
