# pi-bot Windows 沙箱启动器

`pibot-sandbox.exe`：让**挂了 MCP 的 bot** 的 shell 命令跑在 AppContainer 里
（文件 / 网络 / 注册表 / 剪贴板全部隔离），外面再套一层 Job Object 管进程收尾。

## 为什么需要原生程序

AppContainer 的隔离能力只从 `CreateProcessW` 的
`PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` 扩展属性块进来。那不是命令行
参数，Node 的 `child_process` 填不了。所以隔离逻辑必须在这里。

## 构建

```powershell
winget install Rustlang.Rustup     # 一次性；需要 MSVC build tools 做链接
cargo build --release              # 目标：target\release\pibot-sandbox.exe
```

或者用仓库脚本（会顺带写 sha256 清单并校验 Node 侧版本常量）：

```powershell
.\scripts\build-sandbox-win.ps1
.\scripts\build-sandbox-win.ps1 -Check   # 只校验
```

产物装到 `server/resources/pibot-sandbox.exe`。**不进仓库**（`.gitignore`），
随发版编译；`pack-windows.ps1` 会把它拷进发行包，缺失时打黄字警告
（后果是 fail-closed：挂了 MCP 的 bot 拒绝执行 shell，不是崩溃）。

## 子命令

```
pibot-sandbox.exe version
pibot-sandbox.exe run --profile <名> --workdir <目录> --instance <目录>
                       --shell powershell --cmd-file <utf8 文件> [--env K=V]...
pibot-sandbox.exe selfcheck --profile <名> --instance <目录>
pibot-sandbox.exe grant  --profile <名> --path <目录> --mode rw|rx [--data-dir <目录>]
pibot-sandbox.exe revoke --profile <名> --path <目录> --mode rw|rx
pibot-sandbox.exe delete-profile --profile <名>
```

错误一律一行机读码：`PIBOT_SANDBOX_ERR <CODE> <msg>`，
Node 侧 `server/src/sandbox-win.js` 把它翻成用户能看懂的话。

## 依赖

只有 `windows-sys`（MIT OR Apache-2.0，与 `windows` 同仓库同许可）。
按 spec 约束不引入任何其它第三方运行时。

## 实测出来的坑

`docs/WINDOWS-SANDBOX.md` 里有完整清单，最要命的四条：

1. **cwd 不能落在用户目录** —— 普通用户没法给 `C:\` / `%USERPROFILE%` 加 ACE，
   而 AppContainer 要求每层祖先可遍历。落用户目录会让 PowerShell 的
   `Get-Location` 卡在 `C:\`、所有外部命令报
   `Cannot find drive ... FileSystem`。解法：cwd 用 AppContainer 自己的
   `AC\Temp`，再用 PSDrive 把工作目录挂成 `pibot:` 盘。
2. **`-EncodedCommand` 要 Base64(UTF-16LE)**，传 UTF-8 会得到乱码命令。
3. **`git` 需要有效的标准句柄** —— 否则 MSYS2 的 `sanitize_stdfds()` 去开
   `/dev/null`（= NUL），AppContainer 里打不开，于是每条 git 命令都死。
4. **deny ACE 对 AppContainer 无效**（受限令牌的第二趟访问检查忽略 deny），
   `.git/hooks` / `.git/config` 的只读必须靠"根本不给 ACE" +
   `PROTECTED_DACL` 断继承。
