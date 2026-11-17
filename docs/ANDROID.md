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
| 4 | 配对 + 连上 | 填 `http://<电脑IP>:8787` + 终端里的配对码 → 进会话列表；服务端日志出现 `📱 <手机名> 已连接` | ✅ 配对请求打通（服务端日志记录到设备名）；长连接稳定性未验，见 #5 |
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
| 打出来的包名/版本号跟预期不符 | `flutter build apk --no-pub` 之前没 `pub get`，或者 pubspec 改了没重编；`scripts/pack-android.mjs` 会通过 Gradle 的 `output-metadata.json` 交叉校验 |
