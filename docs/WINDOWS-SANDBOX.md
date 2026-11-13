# Windows 沙箱（挂 MCP 的 bot 的 shell 隔离）

对应 spec：`spec-win-sandbox-v0.1.md`。这里记的是**这台机器上实测出来的行为**，
不是设计意图 —— 凡是标「实测」的，都是跑过、曾经踩过、代码里留了注释的。

状态：v0 已实现（PowerShell only），真机验收见文末。

---

## 为什么要有 `pibot-sandbox.exe`

macOS 用系统自带 `sandbox-exec`，Linux 用 `bwrap`，Node 拼个命令行就完事。
Windows 没有等价物：

- AppContainer 的隔离能力只从 `CreateProcessW` 的
  `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` 这个扩展属性块进来；
- 那个块 `child_process.spawn` 填不了（`windowsVerbatimArguments` 也不行，
  它不是命令行参数，是进程创建属性）。

所以仓库里带一个 Rust 启动器：`native/pibot-sandbox/`，产出
`server/resources/pibot-sandbox.exe`。Node 侧只负责找它、校验版本/哈希、
把命令写成文件、拼参数（`server/src/sandbox-win.js`）。

依赖只有 `windows-sys`（MIT OR Apache-2.0），不引入任何第三方运行时。

```
pi-bot server (Node)
  └─ sandbox.js  win32 → probeWindowsSandbox() / wrapWindowsCommand()
        └─ pibot-sandbox.exe run --profile <名> --workdir <目录> --instance <目录>
              --shell powershell --cmd-file <utf8 文件> [--env K=V]...
              ├─ 确保 AppContainer profile（每实例一个，名字由 instanceDir 派生）
              ├─ 给 workdir / instance 加 AppContainer ACE
              ├─ .git/hooks 与 .git/config 去 ACE（只读）
              ├─ 建 Job Object（KILL_ON_JOB_CLOSE + 内存/进程数上限 + UI 限制）
              └─ CreateProcessW(powershell, -EncodedCommand) with SECURITY_CAPABILITIES
```

构建：

```powershell
winget install Rustlang.Rustup          # 一次性
.\scripts\build-sandbox-win.ps1         # 编到 server/resources/ 并写 sha256
.\scripts\build-sandbox-win.ps1 -Check  # 只校验现有产物
```

`pack-windows.ps1` 会把 `server/resources/` 一起打进发行包；缺启动器时它会
打黄字警告（不是失败）—— 因为缺启动器的后果是 **fail-closed 拒绝执行**，
不是崩溃。

---

## 实测结论（Windows 11 22000.2713，普通用户，无 UAC）

### 1. 每层祖先都要可遍历，而普通用户授不了祖先

AppContainer 访问 `C:\Users\XL\work` 需要 `C:\`、`C:\Users`、`C:\Users\XL`
每一层都对该 SID 可遍历。实测：

```
icacls C:\ /grant *S-1-15-2-...:(X)   →  C:\: Access is denied.（非管理员）
```

`C:\Users` 上有 `Everyone:(RX)`，但 AppContainer 的令牌是**受限令牌**，
访问检查要过两趟：普通 SID 一趟、restricted SID 一趟，
**`Everyone` 在第二趟里不被算数**。

后果（在没有 workaround 时全部实测复现）：

| 现象 | 说明 |
|---|---|
| `Get-Location` 永远是 `C:\` | PowerShell 建不出 `C:\` 的 FileSystem drive |
| 任何外部命令都报 `Cannot find drive. A drive with the name 'Microsoft.PowerShell.Core\FileSystem' does not exist` | 同上，`& whoami` / `git` / `cmd` 全挂 |
| `Set-Location <工作目录>` → Access denied | 要逐层遍历 |
| 相对路径写到 `C:\` 根（且写不进去） | PS 的 cwd 是 `C:\` |
| `Get-ChildItem .` 报 drive 不存在 | 同上 |

### 2. 解法：cwd 落在 AppContainer 自己的 AC 目录 + PSDrive 引导

- `CreateProcessW` 的 `lpCurrentDirectory` 设成
  `%LOCALAPPDATA%\Packages\<profile>\AC\Temp`（系统给 AppContainer 分的私有区，
  天然带 AC SID 的 `(OI)(CI)(M)` 和 Low 标签）。
- 用户命令前注入一小段引导（`powershell_prologue`）：
  `New-PSDrive -Name pibot -Root $env:PIBOT_SANDBOX_WORKDIR` + `Set-Location pibot:\`。
  新盘符的根就是工作目录，`Set-Location` 不需要走祖先遍历。
- 工作目录靠 `PIBOT_SANDBOX_WORKDIR` 交给引导脚本，不靠进程 cwd。

这样之后：`pwd` 是 `pibot:\`，相对路径落在工作目录，`git` / `cmd` / `bash.exe`
都能起来。**代价**：`[Environment]::CurrentDirectory` 仍是 AC 目录
（.NET 的 process cwd 变不了），有两套 cwd 概念，写进了
`sandboxed-shell.js` 的注释里。

### 3. `-EncodedCommand` 要 Base64(UTF-16LE)

传 UTF-8 字节会得到一串乱码命令，现场表现是 `CommandNotFoundException`
（看起来像"沙箱把命令弄坏了"）。第一版就踩了这个。

### 4. `UpdateProcThreadAttribute` 的 cbSize 是结构体大小

传 `IntPtr.Size`（8）会得到 `ERROR_INVALID_PARAMETER (87)`，看起来像
"AppContainer 不支持"。正确的是 `size_of::<SECURITY_CAPABILITIES>()`（24）。

### 5. Job Object 的 UI 限制里 `SWITCHDESKTOP` 会被拒

逐位实测 `SetInformationJobObject(JobObjectBasicUIRestrictions)`：

| 位 | 值 | 结果 |
|---|---|---|
| HANDLES | 0x1 | 接受 |
| READCLIPBOARD | 0x2 | 接受 |
| WRITECLIPBOARD | 0x4 | 接受 |
| SYSTEMPARAMETERS | 0x8 | 接受 |
| DISPLAYSETTINGS | 0x10 | 接受 |
| GLOBALATOMS | 0x20 | 接受 |
| DESKTOP | 0x40 | 接受 |
| EXITWINDOWS | 0x80 | 接受 |
| SWITCHDESKTOP | 0x100 | **ERROR_INVALID_PARAMETER 87** |

v0 只设前 8 位。（顺带：网上流传的按"位序号"写的常量是错的，
`DESKTOP` 是 0x40 不是 0x01。）

### 6. `deny` ACE 对 AppContainer 无效

AppContainer 的令牌是受限令牌，访问检查第二趟**忽略 deny ACE**。实测：

```
icacls <dir> /deny *S-1-15-2-...:(W)
→ 沙箱里照写不误
```

所以 `.git/hooks` / `.git/config` 的只读保护不能用 deny ACE。做法是
**根本不给 ACE**：`protect_object()` 先 `PROTECTED_DACL_SECURITY_INFORMATION`
断继承（继承来的条目会被固化），然后逐条重建 DACL、跳过该 SID 的
`ACCESS_ALLOWED_ACE`。注意 `SetEntriesInAclW(REVOKE_ACCESS)` **删不掉**
刚固化的继承条目（它们带 `INHERITED_ACE` 标志），必须手工重建。

验收：工作目录里 `Set-Content .git\hooks\pre-commit` → Access denied；
`Add-Content .git\config` → Access denied；`Set-Content normal.txt` → OK。

### 7. **`git` 在 AppContainer 里不可用**（v0 的已知缺口，不是配置问题）

MSYS2 的 git 启动期做 `sanitize_stdfds()`，随后要开 `/dev/null`。实测在
AppContainer 里这个打开**必然失败**，于是每条 git 命令都报：

```
fatal: could not open '/dev/null' for reading and writing: Permission denied
```

已经试过并排除的假设（全部实测）：

| 试法 | 结果 |
|---|---|
| `STARTF_USESTDHANDLES` + `SetHandleInformation(HANDLE_FLAG_INHERIT)` | 无效 |
| stdio 从 `'ignore'` 改成 `'pipe'`（让 fd0 有效） | 无效 |
| `git --no-optional-locks` / `GIT_TRACE=1` / `GIT_CONFIG_NOSYSTEM=1` | 无效 |
| `git.exe`（cmd 目录）、`mingw64/bin/git.exe`、`bash -c 'git --version'` | 全部失败 |
| `CreateFileW("NUL")` | **成功** |
| `[IO.File]::Open("NUL" / "\\\\.\\NUL" / "\\\\.\\GLOBALROOT\\Device\\Null")` | 全部 DENY |
| `NUL` / `CON` 设备节点 | 全部 DENY |

**根因**：Win32 设备命名空间在 AppContainer 里不可达。`CreateFileW` 能拿到
句柄（内核路径），但 MSYS2 走的是 CRT/POSIX 层（`\\\\.\\NUL`），
那层在 AppContainer 的令牌下被拒。给设备授 ACE 需要管理员
（`Get-Acl '\\.\\NUL'` 本身就报"路径不存在"，拿不到 ACL），这条路走不通。

**补充（后来发现的绕法）：bot 自己不需要 git 也能做文件隔离。**
用 `git worktree`：Node 侧（沙箱外，git 正常）建好每个 bot 的独立工作树，
bot 只在沙箱里改文件，提交/合并都由 Node 侧做。实测走通（见
`server/tests/sandbox-win.mjs` 的 worktree 用例 + 下面「worktree 隔离」一节）。
所以 git 不可用这条只影响"bot 自己想敲 git"，不影响隔离方案。

**结论**：Windows 沙箱 v0 **不带 git 能力**。`bash.exe`、`cmd.exe`、
PowerShell 脚本、`node`（若在 PATH）都正常；需要 git 的场景请换
macOS / Linux，或把这个 bot 的 MCP 去掉（那时不走沙箱）。

> 上一版文档在这里写的是"补齐句柄后 git 全部正常" —— 那是**错的**：
> 当时把 `try/catch` 没抛异常误读成了成功，实际每条命令都退化成
> `NativeCommandError`。已用 `stdio='pipe'` + 四种调用路径复测确认不可用。

### 8. Low 完整性标签：工作目录不需要标 Low

token 里是 `Mandatory Label\Low Mandatory Level`（S-1-16-4096）。
但工作目录只要授了 `(OI)(CI)(RX,W,DC)`，写自己的文件正常。
**不给 `DC` 的话**连自己刚建的文件都删不掉（实测：授 M 时 `Remove-Item` 一律
Access denied；补上 `FILE_DELETE_CHILD` 后正常）。

用户在普通进程里创建的**已存在文件**（中完整性）删不掉 —— 这是 Low IL 的
预期行为，不做规避，写进验收备注。

### 9. 网络/剪贴板/注册表/持久化：全部按预期挡住

在沙箱里实测（`tools/win-sandbox-e2e.mjs` 可复跑）：

| 探针 | 结果 |
|---|---|
| 读 dataDir\local-token | Access denied |
| 读 `%USERPROFILE%\.ssh` | Access denied |
| 读另一个实例目录 | Access denied |
| 写 `$PROFILE` / Desktop | Access denied |
| 写 `HKCU\...\Run` / 新建 HKCU 键 | Requested registry access is not allowed |
| 连 `127.0.0.1:8787` | 超时（回环不通） |
| 连 `1.1.1.1:443` | 访问被 socket 权限禁止 |
| `Resolve-DnsName example.com` | 超时 |
| `Get-Clipboard` / `Set-Clipboard` | Requested Clipboard operation did not succeed |
| `schtasks /create` | Access is denied |
| `Win32_Process.Create`（WMI） | 拒绝访问 |
| 命名管道 `openssh-ssh-agent` | 超时 |
| 工作目录写文件 / `$TEMP` 写文件 | OK |
| `cmd /c cd` | 正确指向工作目录 |
| `git --version` / `git init` / `git commit` | ⛔ 失败（见第 7 条：AppContainer 打不开 NUL） |

### 10. 进程收尾

- 启动器被 `Stop-Process`（相当于 `taskkill /F`）→ Job 的
  KILL_ON_JOB_CLOSE 生效，沙箱里的 powershell 在 3 秒内消失（实测）。
- 命令正常退出后，`Start-Job { Start-Sleep 300 }` 起的后台作业也会被
  `TerminateJobObject` 收掉，powershell 进程数回到基线（实测）。
- **顺序**：先 `WaitForSingleObject` 等主进程，再读退出码、关进程句柄，
  最后 `TerminateJobObject` + 关 job 句柄。先关 job 会把退出码丢成 1；
  先 Terminate 会让命令刚起就被杀（只剩 profile 行、没有输出）。

---

## 接入点

| 文件 | 改了什么 |
|---|---|
| `server/src/sandbox.js` | `probeSandbox({instanceDir})` 加 win32 → `appcontainer`；`wrapCommand` 加 win32 分支转 `wrapWindowsCommand` |
| `server/src/sandbox-win.js` | 新增。找启动器、版本/哈希校验、profile 名派生、命令文件、错误码文案、revoke |
| `server/src/sandboxed-shell.js` | Windows 不再造"永远拒绝"工具；powershell 走真沙箱；bash 明确拒绝（spec §18）；spawn 时不传 cwd/env（启动器自己管）；收尾 cleanup |
| `server/src/shells.js` | `run_background` 也走沙箱（原来完全绕过，实测能读到 token）；启动器自己管 cwd/env；cmd 文件收尾清理 |
| `server/src/store.js` | `deleteBot` 调 `teardownWindowsInstance` 删 profile |
| `server/src/mcp-access.js` | `sandboxUnavailableMessage` 支持 Windows 机读错误码 |
| `native/pibot-sandbox/` | 新增 Rust 启动器 |
| `scripts/build-sandbox-win.ps1` | 新增。编译 + 写 sha256 清单 |
| `scripts/pack-windows.ps1` | 拷贝 `server/resources/`，缺失时黄字警告 |
| `server/tests/sandbox-win.mjs` | 新增 21 项单测（跨平台，不需要真沙箱） |
| `server/tools/win-sandbox-e2e.mjs` | 新增。真机冒烟（手工跑，CI 不跑） |

---

## Fail-closed 清单

任一情况 → 不执行，给用户可读原因，**不降级成无沙箱**：

- 启动器不存在（`no_binary`）
- 版本与 `LAUNCHER_VERSION` 不一致（`launcher_version_mismatch`）
- sha256 清单对不上（`launcher_hash_mismatch`）
- `selfcheck` 失败（建 profile / 授 ACE 失败 —— 部分企业策略禁用 AppContainer）
- 工作目录命中拒绝规则：盘符根 / UNC / 映射盘 / `%USERPROFILE%` 本身 /
  `%APPDATA%` / `%LOCALAPPDATA%` / `Program Files` / `Windows` 本身 /
  上述目录的祖先 / dataDir
- Job 创建、限制设置、关联失败
- `CreateProcessW` 失败

注意：**工作目录在 `%USERPROFILE%` 下面**是允许的（`~\pi-bot-work` 就是正常用法）。
只拒「就是保护目录本身」和「是保护目录的祖先」两种 —— 第一版把子目录也拒了，
结果沙箱在任何真实布局下都开不起来。

**但凭据 / 浏览器配置目录连子目录一起拒**（`WORKDIR_IS_SENSITIVE`）：
`%USERPROFILE%\.ssh`、`.gnupg`、`.aws`、`.azure`、`.kube`、`.docker`、
`.config`、`.git-credentials`、`.netrc`、`.npmrc`、`.pypirc`、`.pi`、`.agents`、
`%APPDATA%\Microsoft\Credentials`、`%APPDATA%\Microsoft\Crypto`、
`%LOCALAPPDATA%\Google\Chrome\User Data`、`...\Microsoft\Edge\User Data`、
`...\Mozilla\Firefox`、`...\BraveSoftware`、`...\pi-bot`。

> 这条是 review 时补的：第一版只按"整体路径"判，实测 `workDir=~/.ssh`
> 能通过并成功列出 `config` / `config.bak`。

---

## 验收（spec §11）

Windows 11 22000.2713 真机，`tools/win-sandbox-e2e.mjs` + 手工脚本：

| # | 动作（在 bot a 里跑） | 实测 |
|---|---|---|
| 1 | 读 `dataDir\local-token` | ✅ 失败（Access denied） |
| 2 | 读 `%USERPROFILE%\.ssh` | ✅ 失败 |
| 3 | 写 PowerShell `$PROFILE` 真实路径 | ✅ 失败 |
| 4 | 写 `HKCU\...\Run` | ✅ 拒绝 |
| 5 | 连 `127.0.0.1:<端口>` / 外网 | ✅ 都失败 |
| 6 | 读剪贴板（`Get-Clipboard`） | ✅ 失败 |
| 7 | 读 `instances\b` | ✅ 失败 |
| 8 | 工作目录建文件 / TEMP 写文件 | ✅ 成功 |
| 9 | `git --version` / `git init` / `git commit` | ⛔ 失败（AppContainer 无法打开 NUL，见第 7 条） |
| 9b | `node -v` | ⛔ 未授予（node 在 `D:\NodeJs`，非系统目录） |
| 10 | 工作目录 = 用户主目录 | ✅ 启动器拒绝（`WORKDIR_IS_PROTECTED`） |
| 11 | 杀掉 pi-bot / 启动器 | ✅ 沙箱内子进程全部退出（3 秒内） |
| 12 | 删除 bot → ACE 被撤销 | ✅ `revokeWindowsGrant()`（调启动器 `revoke`） |

`.git` 防持久化（spec §16）：`.git/hooks` 与 `.git/config` 写 → Access denied；
工作目录普通文件写 → OK。

单元测试：`node tests/all.mjs` 95/95 通过（含新增 `sandbox-win` 21 项）。

---

## worktree 隔离（推荐给"多人改同一仓库"的场景）

### 为什么不是"给文件加锁"

实测三种现行机制都不够：

| 机制 | 范围 | 实测结果 |
|---|---|---|
| `withFileMutationQueue`（pi SDK） | 单进程、仅 `write`/`edit` | 两个 bot 并行 `write` 同一文件 → 双方都报成功，先写的被静默覆盖 |
| `edit` 的 oldText 精确匹配 | 天然 CAS | 改同一行时后改的人报错（✅ 不丢数据）；改不同行时都成功（没问题） |
| `bash` | **完全没有锁** | 两个 bot 做 `read-modify-write` → 丢更新且无任何报错 |
| 跨进程 | 无 | 两个独立进程读到同一份旧值 → 后写的覆盖先写的 |

而 `git worktree` 是**物理隔离**：每个 bot 一个目录，谁都不可能覆盖谁。

### 实测流程（`tools/win-sandbox-e2e.mjs` 里有精简版）

```
Node 侧（沙箱外，git 可用）
  1. git init main && commit
  2. git worktree add ../bot-a -b bot/a     ← 每个 bot 一个
     git worktree add ../bot-b -b bot/b
  3. 把 worktree 路径当作该 bot 的工作目录

bot 侧（沙箱内，git 不可用也没关系）
  4. 只做文件读写：Set-Content app.js ...
     ↑ 沙箱给它自己的 worktree 授 (OI)(CI)(RX,W,DC)，别的 worktree 摸不到

Node 侧（沙箱外）
  5. git add -A && commit（在各 worktree 里）
  6. git merge bot/b; git merge bot/a       ← 冲突变成标准 git 冲突
  7. git worktree remove --force
```

实测输出：

```
[2a] 沙箱 A 写入: OK
[2b] 沙箱 B 写入: OK
[3a] A 的 app.js   : const PORT = 9000;
[3b] A 的 config.js: export const HOST = "0.0.0.0";   ← B 没影响它
[3c] B 的 config.js: export const HOST = "127.0.0.1";
[3d] B 的 app.js   : const PORT = 8787;               ← A 没影响它
[5c] 主干 app.js   : const PORT = 9000;
[5d] 主干 config.js: export const HOST = "127.0.0.1";
[5e] 主干历史: Merge branch 'bot/a' / botB: edit / botA: edit / init
```

两边改不同文件 → 自动合并，无冲突。改同一行 → 标准 `CONFLICT (content)`，
由人（或组长 bot）决定。

### worktree 的坑：`.git` 是**文件**不是目录

```
bot-a/.git   →  内容是  gitdir: D:/repo/main/.git/worktrees/bot-a
main/.git/worktrees/bot-a/{commondir,gitdir,HEAD,index}
```

沙箱启动器原来把 `.git` 当目录（要锁 `.git/hooks`），遇到 worktree 直接
`GIT_HOOKS_MKDIR_FAILED` 并 fail-closed。已修：

- `.git` 是文件 → 只锁这个指针文件本身（改它 = 把工作目录劫持到别处，同样是持久化向量）
- `.git` 是目录 → 照旧锁 `hooks` / `config`

worktree 场景下 hooks / config 都在**主仓**里，不在 bot 的工作目录里，
本来就不在 AppContainer 的授权范围内。

### 还没做的部分

- 派活时按文件集合互斥（同一文件的活排队，而不是各开 worktree）
- worktree 的自动创建 / 回收（现在要 Node 侧显式调 git）
- 合并冲突的自动处理策略（现在冲突就停下等人）

## 已知限制（v0 明确不做）

0. **`git` 不可用**（见第 7 条）：AppContainer 打不开 NUL 设备节点，
   MSYS2 的 git 启动即失败。这是 v0 的硬缺口，不是配置能补的。
1. **只交付 PowerShell**。bash 工具在 Windows + 挂 MCP 时明确拒绝
   （`refusingTool`）。Git Bash 在沙箱里能起（`bash -c 'pwd'` 有输出），
   但 `/tmp` 映射、`/etc/passwd` 生成、`node` 在 bash 里的可用性都没验证，
   半坏状态比明确拒绝更难排查。
2. **`node` 不可用**（除非用户把 node 目录加进白名单，spec §14 待定项）。
3. **独立桌面（`CreateDesktop`）没做**。实测能创建，但把进程放上去会
   `0xC0000142`（DLL 初始化失败）—— AppContainer + 非默认 desktop 的组合
   需要更多调试。目前靠 Job 的 `DESKTOP` UI 限制兜底（能挡住
   窗口操作，挡不住 `CopyFromScreen` 截屏；实测截屏仍能拿到像素）。
4. **`.git/hooks` 若不存在会被创建**（用于锁）。删掉整个 `.git` 重建后，
   下一次 run 会重新锁。
5. **ACE 会留在用户的工作目录上**。`revokeWindowsGrant()` 可撤，
   删 bot 时 `store.deleteBot` 会调 `teardownWindowsInstance` 删掉 profile
   （但如果工作目录是全局共享的 `config.workspace`，那里**不** revoke ——
   别的 bot 还在用）。UI 还没做"告知用户工作目录被加了 ACE"这一步。
6. **启动器未签名**。SmartScreen / 杀软可能拦（spec §12 风险项）。
7. **每个实例一个 AppContainer profile**，但 profile 的
   `%LOCALAPPDATA%\Packages\<profile>` 目录只在删 bot 时清理。
   开发期反复跑 e2e 会攒下若干 profile（本机实测见过 20 多个），
   可用 `pibot-sandbox.exe delete-profile --profile <名>` 手工清。
