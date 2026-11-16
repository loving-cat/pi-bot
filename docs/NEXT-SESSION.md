---

## 一句话

**v1.4.0 已发布**（Windows setup.exe + 免安装 zip）。这一轮收束了交互侧的权限流程：
岛（T1 独立桌面）、权限申请与转呈、Git G2/G3、信任域与写锁、授权对账。

---

## 建议顺序

| # | 做什么 | 为什么是它 | 大概 |
|---|---|---|---|
| **1** | **TaskRun 那 36 个测试** | 一万四千行只有 23% 被测试碰过；不补就不能开任务系统，看板也是空的 | 1 天 |
| 2 | 打包清单核对（安装器里实际带了哪些） | 许可证清单有了（200 个组件），"实际随包发出去的是哪些"还没有 | 2h |
| 3 | §13.2 引导页正文英文 | 英文界面里那页还是中文（唯一一处） | 半天 |
| 4 | 任务交接单补字段（执行模式 / 脱敏 / 接收方核对范围） | 派活时这些信息现在传不过去 | 半天 |
| 5 | 锁屏 / 多屏实机验证 | 静态实现有，缺实机数据（`docs/WINDOWS.md` 那张表） | 你 10 分钟 |
| 6 | macOS 桌面输入 | 空壳 + 481 行文档就位，缺实机 | 需 Mac |

## 发版之后的两个已知状态

- **Android APK / macOS dmg 这一版没构建**：只有 Windows 两个资产。那两端客户端会退到
  "打开发布页"（`UpdateInfo.canDownload == false`），不会崩、也不会装错包。
- 本机 `PUB_HOSTED_URL` 指向国内镜像，直接跑 `scripts/pack-windows.ps1` 会因
  `--enforce-lockfile` 失败；打包时用
  `PUB_HOSTED_URL=https://pub.dev FLUTTER_STORAGE_BASE_URL=https://storage.googleapis.com`
  覆盖。**不要把镜像版的 `pubspec.lock` 提交上去**（会把所有人指到镜像）。

## 工作流（第二天不用重新摸索）

```bash
cd server
node tests/all.mjs                     # 必须 124/124（Windows 上含真起岛的 17 项）
node scripts/check-consistency.mjs     # 必须「七项一致性检查全部通过」
node scripts/check-capability-drift.mjs
cd ../app
flutter test                           # 必须 776 全绿
flutter analyze                        # 必须 No issues
cd .. && node scripts/check-secrets.mjs
```

三条纪律：

1. **commit 作者/邮箱用仓库配置的那个 noreply**（别用 `-c user.email=` 覆盖）——
   `secret scan` 的 `--push` 模式会扫提交元数据；强推会让它改扫整条历史。
2. 用脚本生成 JS 代码时注意 `\r?\n` 这类转义会被再解释一次 → 用 `RegExp` 构造函数
3. 每完成一块立即 commit + push，全绿才算完

## 还有那个已知挡路问题

本机装着 **GameViewer 远程控制**，它持续合成输入 → `GetLastInputInfo` 永远报
"刚刚有人动"，于是接管检测永远让开，`desktop_input` 第一次永远发不出去。

现在有两条出路：
1. **岛**（T1）根本不用系统输入，不受影响 —— 这也是默认路径；
2. 设置 → 系统页打开「**信任合成输入**」（默认关）：它会认出"光标没动=不是人在用"
   并继续干；你真动鼠标时照样让开。开关要 nonce、记审计。
