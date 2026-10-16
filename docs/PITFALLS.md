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
