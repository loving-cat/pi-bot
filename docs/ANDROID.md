# Android（手机端）

一句话：**手机不是宿主，是那个"必须由人来点确认"的终端。**

服务端（node）只跑在 Windows / macOS / Linux 上。手机端是它的远程客户端：
同一个 Wi-Fi 里配对一次，之后看消息、发消息、点批准。

## 为什么手机上非要有这个 App

不是"顺手做个手机壳"。权限层里有几处**只能在这台手机上做**：

| 能力 | 桌面 | 手机 |
|---|---|---|
| 不可撤销操作的最后确认（`/api/confirmations`） | ❌ 服务端回 403 `WEAK_CHANNEL` | ✅ 已配对设备才算数 |
| 后台收机器人消息、锁屏通知 | — | ✅ 前台服务 + 本地通知 |
| 跑服务端、开终端、操作本机 | ✅ | ❌ 根本没有 |

桌面点不了批准是**故意的**：主 Bot 能操作那台电脑，它自己也能点，那就不叫人来确认了。
所以"安卓版能不能用"直接决定权限闭环能不能跑通。

## 构建

```bash
node scripts/pack-android.mjs                  # → dist/pi-bot-android-v<版本>.apk
node scripts/pack-android.mjs --abi arm64      # 只打 arm64（体积约减半）
node scripts/pack-android.mjs --no-build       # 复用已有构建，只重新校验 + 改名
```

前置（三样，缺一样都不给过，脚本会直接说）：

| 需要 | 版本 | 脚本怎么查 |
|---|---|---|
| Flutter SDK | 3.47.7（和 CI 一致） | `flutter --version`，PATH 里必须有 |
| JDK | **17+** | 读 `java -version`，1.8 直接拒 |
| Android SDK | platform 36 + build-tools | `app/android/local.properties` 的 `sdk.dir` 或 `ANDROID_HOME`，用来找 `apksigner` |

脚本不是 `flutter build apk` 的包装皮，它自己判四件事，判不过就不产出包：

1. **版本号一致**（构建前 + 构建后各查一次）：`server/package.json` 是唯一真源，
   `app/pubspec.yaml` 的 `version:` 必须与它相同。只有一处 bump → 直接失败。
2. **JDK 版本**：`JAVA_HOME` 停在 1.8 时，Gradle 只说 `JAVA_HOME is set to an
   invalid directory`，看不出是版本问题（见 [PITFALLS 21](PITFALLS.md)）。
3. **锁文件没有镜像地址**：本机 `PUB_HOSTED_URL` 常指向 pub 镜像，一次 `pub get`
   就把 `pubspec.lock` 里几百行 URL 改了，CI 的 `--enforce-lockfile` 立刻红。
   脚本构建期间强制官方源，并在构建前检查锁文件。
4. **签名证书跟已发布版本一致**：见下一节。这条最贵 —— 错了不是构建失败，
   是**所有人的手机都装不上新版本**。

构建失败/校验失败时，`dist/` 里上一版的包原样保留（先写临时文件再 rename）。

### 签名：不能换证书

现在 release **用的是本机 `~/.android/debug.keystore`**（`CN=Android Debug`），
SHA-256 `03cddcf5c4deea5f1abfe9327b6f552452d707532a66a8e77153af5f031445d6`。
v1.0.3 / v1.0.5 / v1.0.6 与 1.4.1 实测都是它，所以老用户能原地升级。

- **换机器构建**（新机器 = 新的 debug.keystore）→ 指纹变 → 已装用户报
  `INSTALL_FAILED_UPDATE_INCOMPATIBLE`，只能先卸载（聊天记录/配对信息一起没了）。
- 脚本会先 `apksigner verify --print-certs` 比对指纹，不一致就不产出包。
- 真要换成正式 keystore（上应用市场那种），改 `scripts/pack-android.mjs` 里的
  `EXPECTED_SIGNER_SHA256`，并在发布说明里写一句"老用户需先卸载旧版"。

`applicationId` 是 `com.pibot.pi_bot`，同理不能改；`versionCode` 取 `pubspec.yaml`
的 `+N`，**只增不减**（当前 19）。

## 手机怎么找电脑：附近的电脑 → 电脑上点允许

装机之后第一次打开 App，不该让人抄 IP。手机端这一页是**附近有哪些电脑**，
和桌面端那张"地址 + 配对码"的表单不是同一个东西。

```
手机                                             电脑（宿主）
  │  ① 广播 UDP 8788  {"t":"pibot.discover"}  →   │  发现应答器
  │  ←  单播应答 {"t":"pibot.host", name, hostname, urls, approve}
  │
  │  ② 点那台电脑 → POST /api/pair/request      →│  弹窗："我的手机 想连接，允许吗"
  │                                              │  人在电脑前点【允许】
  │  ③ 轮询 GET /api/pair/request/<id>          →│  批准后**只交付一次** token
  │  ←  {status:"approved", token}
  │  ④ 用这个 token 走正常的 WS/HTTP
```

**为什么一定要电脑上点一下**：同一个 Wi-Fi 里谁都能广播探针，光靠"发现"等于
谁先点谁进来。那一下点击就是授权本身 —— 电脑上弹的窗里带来源 IP 和手机名，
看到不认识的手机就点拒绝。

### 协议与端口

| 项 | 值 | 关掉/改掉 |
|---|---|---|
| 发现端口 | UDP 8788（只收 IPv4） | `PI_BOT_DISCOVERY_PORT` |
| 关闭发现 | — | `PI_BOT_DISCOVERY=0`（会议室/公共 Wi-Fi 用；手机仍可手填地址） |
| 连接请求接口 | `POST /api/pair/request` → `{id}` | — |
| 手机轮询 | `GET /api/pair/request/<32位hex>` | — |
| 电脑处理 | `GET /api/pair/requests`、`POST /api/pair/request/<id>` `{approve}` | 需要本机身份 |
| 应答内容 | 名字、机器名、版本、端口、局域网地址、要不要配对码 | 不含配对码、不含 token |

### 安全边界（别改坏）

- 请求 `id` 是 128 位随机数，**它本身就是凭证**（知道 id 才能换到 token）：不进日志、不进任何列表广播，只回给发起的那台手机和电脑端。
- 一个请求只能用一次：批准后 token 只交付一次，再轮询就只有状态、没有 token。
- 没人点 60 秒自动过期（`REQUEST_TTL_MS`）；过期状态会如实回给手机，不会变成"连接成功"。
- 同一 IP 一分钟最多 3 个请求；同时最多 3 个待批（`MAX_PENDING`）—— 免得有人拿弹窗刷屏。
- 手机**不能**自己批准自己：`POST /api/pair/request/<id>` 需要本机身份，未鉴权直接 401（有测试盯着）。
- 配对码那条路（`POST /api/pair`）保留：无图形界面的部署只能用它。

### 找不到电脑时

1. 两台设备是不是**同一个 Wi-Fi**（有些路由器的访客网络互相隔离，AP isolation）。
2. 电脑上 Windows 防火墙第一次会问"是否允许 pi-bot 访问网络" —— 要选**允许**；只放行过 TCP 8787 的话，UDP 8788 可能还是拦着的（发现靠它）。
3. 服务端日志里应该有 `[discovery] 局域网发现已开启：UDP 8788`。没有这行就是端口被占或被 `PI_BOT_DISCOVERY=0` 关了。
4. 实在找不到就点"找不到？手动填地址"，填 `http://<电脑IP>:8787` + 电脑屏幕上那 6 位配对码 —— 这条路一直都能用。

### 换一台电脑

设置 →「连接与设备」→「换一台电脑」（`settings.connect.rescan`）：清掉本机的
地址和 token，回到附近列表重新选。手机上**没有**电脑端那套服务端配置 ——
那些项在手机的设置里是隐藏的（`isHostPlatform` 判断）。

## 加密：现在保护了什么，还差什么

这一节写的是**真实边界**，不是"应该没问题"。看代码时请以这里为准。

### 已经挡住的

| 攻击 | 为什么挡得住 |
|---|---|
| 同一个 Wi-Fi 的人自己点一下就连进来 | 连接必须有人在**这台电脑前**点允许；点错了也还能在设置里撤销设备 |
| 知道请求 id 就想换 token | token 只交给**发起请求的那个 IP**（`PAIR_REQUEST_WRONG_NETWORK`），且只交付一次 |
| 拿广播探针去问"这台机器有 pi-bot 吗" | 只对私有网段/链路本地来源应答（`isLanSource`），公网探针一个字都不回 |
| 用请求接口当弹窗炸弹 | 同 IP 3 次/分钟、同时最多 3 个待批、没人点 60 秒过期 |
| 手机自己批准自己 | `POST /api/pair/request/<id>` 要求本机身份，未鉴权 401 |
| 重放一次请求就再连一遍 | 请求一次性；批准后 id 再查只有状态、没有 token |

### 还没做到的：**链路加密**

手机和电脑之间现在是**明文 HTTP / 明文 WebSocket**（`http://<ip>:8787`、`ws://…/ws`）。
这意味着同一个 Wi-Fi 上能抓包的人可以：

- 从 `Authorization: Bearer …` 或 WS 的 `?token=` 里**抄走设备 token**，之后冒充这台手机；
- 读到聊天内容、附件内容（明文 JSON / 二进制）；
- 看到配对时的请求与批准。

挡不住这些，是因为我们没有传输层加密。**这不是"配个 HTTPS"就完事**：

1. 局域网里没有可信 CA，只能自签证书 —— 自签就得让手机**固定指纹**（TOFU），
   而指纹第一次是怎么到手机上的？明文广播里说的，中间人也能改。
2. 所以还差一次**短校验码比对**（SAS）：电脑上的弹窗显示 6 位码，手机上显示同样的
   6 位码，人眼对一次 —— 对上了，之后固定这个指纹，中间人再插入就对不上了。
3. 服务端要能**自己生成证书**（用户机器上不一定有 openssl），HTTP 和 WSS 两条链路、
   桌面端的本机连接、打包脚本、更新检查全都要跟着改一遍。

工作量是独立一轮，改的是"谁能连上我"的根，不该边聊边改。**在那之前：**

- 只在**自己信任的 Wi-Fi**（家里 / 自己的热点）上配对和使用；
- 要跨不可信网络（咖啡厅、公司访客网、公网），用 **Tailscale / WireGuard** 之类把
  两端放进同一个隧道 —— 隧道本身是加密的，比现在这套明文强得多；
- 别把 8787 直接映射到公网（真需要就只走隧道）。

## 装机验收

模拟器只能验到"能不能起来 + 配对页排版"，其余必须真机：

```bash
adb install -r dist/pi-bot-android-v1.4.1.apk
adb shell am start -n com.pibot.pi_bot/.MainActivity
```

| # | 项 | 怎么算过 | 状态 |
|---|---|---|---|
| 1 | 安装 | `adb install` 报 Success；手机上没有"应用未安装" | ✅ 2026-11-17 Android 14 模拟器 |
| 2 | 首屏 = 配对页 | 能看到"配对码 / 固定 token"两页签、服务器地址、6 位配对码、手机名 | ✅ 同上（截图比对过） |
| 3 | 通知权限弹窗 | 首次启动就弹"允许通知"，选允许 | ✅ 同上 |
| 4 | 附近的电脑能出现 | 打开 App 就看到电脑的机器名（不是空白列表）；电脑端日志有 `[discovery] 局域网发现已开启` | ✅ 服务端应答器实测（单播探针拿到 name/hostname/urls）；Windows 上 255.255.255.255 广播没回来，需要真机+防火墙确认 |
| 4b | 点电脑 → 电脑上弹窗 | 手机点那台电脑 → 电脑的 pi-bot 弹「一台手机想连接」，点允许后手机进会话列表 | ✅ 接口链路实测（create → 待批列表 → approve → 手机拿到一次性 token）；弹窗 UI 由 widget 测试覆盖 |
| 4c | 拒绝/超时 | 电脑上点拒绝 → 手机明确提示"被拒绝"；不理它 60 秒 → 手机提示过期，重新点即可 | ✅ 服务端与客户端规则都有测试 |
| 4d | 配对码兜底 | 手动填地址 + 6 位码仍然能连（老服务端/无界面部署） | ⬜ 待真机 |
| 5 | 长连接稳定性 | 挂 10 分钟不掉线、切前后台不断 | ⬜ 待真机 |
| 6 | 群聊流式输出 | 发一句 → 多个 bot 依次流式回；手机竖屏不横向滚动 | ⬜ 待真机 |
| 7 | 锁屏通知 | 后台/锁屏时 bot 干完活能收到通知，点通知进对应会话 | ⬜ 待真机 |
| 8 | 电池白名单 | 国产 ROM（MIUI/EMUI/ColorOS）加白名单后不被杀；设置页能一键跳"忽略电池优化" | ⬜ 待真机 |
| 9 | 批准不可撤销操作 | 卡片上的批准按钮能点、点了有结果；桌面上点会被拒 | ⬜ 待真机 |
| 10 | 窄屏排版 | 320/360/412 宽都不出现黄黑条溢出；横过来能用 | ✅ 由 `app/test/phone_layout_test.dart` 覆盖（含负向验证） |
| 11 | 附件 | 图片能预览、文件能存到 SAF 选择的位置 | ⬜ 待真机 |
| 12 | 返回键 | 会话页返回回到列表；不直接退出 App | ⬜ 待真机 |

> 表格里每验一项就把 ✅/日期/机型补上。**模拟器不算真机验收** ——
> 厂商 ROM 的后台策略、通知权限、SAF 全都得真机。已知本机 emulator（Android 14,
> `-no-window -gpu swiftshader_indirect`）在设备连上服务端约 1 秒后进程退出，
> 属于无头模拟器的稳定性问题，不再拿它当验收依据。

## 手机尺寸的排版守门

`app/test/phone_layout_test.dart` 在 320×640 / 360×800 / 412×915 与横屏 800×360
下挂 RoomsScreen / ChatScreen / HomeShell，断言不抛异常（溢出会以异常形式炸出来）、
输入框与会话项仍在；文件末尾还有一个**负向用例**：故意塞两个 500dp 的盒子，
必须抛异常 —— 否则说明这套夹具根本抓不到溢出。

改共享 Dart 时顺手跑：

```bash
cd app && flutter test test/phone_layout_test.dart
```

## 手机上有、桌面上没有的东西

| 能力 | 实现 | 文件 |
|---|---|---|
| 常驻前台服务（`dataSync`） | `BotService` + `pibot/native` 通道 | `app/android/.../BotService.kt`、`app/lib/native.dart` |
| 本地通知 | `flutter_local_notifications`，不走 FCM | `app/lib/notify.dart` |
| 忽略电池优化 | 系统白名单 Intent | `app/lib/native.dart` |
| 扫码配对 | `mobile_scanner` + 相机权限 | `app/lib/screens/scan_screen.dart` |
| 附件保存 | SAF（`file_picker.saveFile` 自己落盘） | `app/lib/save_file.dart` |
| 明文 http（局域网） | `usesCleartextTraffic` + `network_security_config` | `app/android/app/src/main/AndroidManifest.xml` |

## 手机上有、桌面上**没有**的降级

- 没有"用系统程序打开附件"（`open_file.dart` 在移动端直接提示不支持）——
  手机上要的是"存下来"，不是"甩给别的 App"。
- 没有"在文件管理器里显示"（`revealInFileManager` 在 Android 上是空实现）。
- 设置页里跟宿主有关的东西（启动服务端、端口、工作目录、配对二维码）在手机上不出现，
  见 `settings_screen.dart` 里的 `isHostPlatform` 判断。

## 排障

| 症状 | 原因 / 修法 |
|---|---|
| `JAVA_HOME is set to an invalid directory` | `JAVA_HOME` 指着 JDK 8。见 [PITFALLS 21](PITFALLS.md) |
| `checkReleaseAarMetadata` 说某个插件要 compileSdk 36 | 见 [PITFALLS 10](PITFALLS.md) |
| 手机报"应用未安装"/`INSTALL_FAILED_UPDATE_INCOMPATIBLE` | 签名证书和已装版本不同 —— 换个 key 打的包，或换了机器（见上文签名一节） |
| 配对时 App 提示 `bad host` | 服务端防 DNS rebinding：`Host` 头必须是本机名/IP。走反向代理要设 `PI_BOT_ALLOWED_HOSTS`；模拟器里访问 `10.0.2.2` 也算"外部 Host"，需要显式加进去 |
| 后台收不到消息 | 关掉电池优化（设置页有入口）；国产 ROM 还要在系统设置里允许"自启动/后台活动" |
| 跑完脚本后 `app/windows/flutter/generated_plugins.cmake` 变成已修改 | `flutter pub get` 顺手重生成 Windows 的插件清单（少一行 `jni`）。**不要把它混进安卓的提交**；要提交就单独确认 Windows 编得过（CI 每次都会重生成，仓库里那份不是权威） |
| 打出来的包名/版本号跟预期不符 | `flutter build apk --no-pub` 之前没 `pub get`，或者 pubspec 改了没重编；`scripts/pack-android.mjs` 会通过 Gradle 的 `output-metadata.json` 交叉校验 |
