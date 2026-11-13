#![cfg_attr(not(windows), allow(dead_code))]
//
// pi-bot 的 Windows 沙箱启动器。
//
// 为什么要有这个 exe：Node 的 `child_process` 无法设置
// `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` —— 那是 CreateProcessW 的
// 扩展属性块，只有原生代码能填。没有它就只能起一个普通进程，
// 拿不到 AppContainer 的文件/网络隔离。
//
// 设计取舍（都是这台机器上实测出来的，见 docs/WINDOWS-SANDBOX.md）：
//
//  · **cwd 落在 AppContainer 自己的 AC 目录**，不落用户工作目录。
//    实测：普通用户（非管理员）无法给 `C:\Users` / `C:\` 加 ACE，
//    而 AppContainer 访问一个目录要每一层祖先都可遍历。落在用户目录下
//    会导致 PowerShell 的 `Get-Location` 卡在 `C:\`、`Set-Location` 一律
//    Access denied、相对路径写到 `C:\` 根、`Get-ChildItem` 报
//    "Cannot find drive ... FileSystem"。改成 AC 目录后这些全部消失。
//
//    代价：进程 cwd ≠ 工作目录。工作目录通过环境变量 `PIBOT_SANDBOX_WORKDIR`
//    交给 PowerShell 引导脚本，由它 New-PSDrive + Set-Location 进去
//    （普通用户对工作目录授 (OI)(CI)(M) 是可行的）。
//
//  · 命令从文件读、经 `-EncodedCommand`（Base64 **UTF-16LE**）传递。
//    传 UTF-8 会得到一堆乱码命令 —— 现场表现是 CommandNotFoundException，
//    看起来像"沙箱把命令弄坏了"。
//
//  · 授 DC（delete child）而非 M：AppContainer 令牌是 Low 完整性，
//    不授 DC 时连自己工作目录里刚建的文件都删不掉。
//    注意：对**用户工作目录**授 F 也不给 DE/DC 之外的东西 —— 实测里
//    用户在普通进程里创建的文件（中完整性）删不掉是**预期**行为，
//    这一点写进文档，不做规避。
//

use std::ffi::OsString;
use std::fs;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

fn wide(s: &str) -> Vec<u16> {
    OsString::from(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(|s| s.as_str()) {
        Some("run") => cmd_run(&args[1..]),
        Some("selfcheck") => cmd_selfcheck(&args[1..]),
        Some("grant") => cmd_grant(&args[1..], true),
        Some("revoke") => cmd_grant(&args[1..], false),
        Some("delete-profile") => cmd_delete_profile(&args[1..]),
        Some("version") | None => {
            println!("pibot-sandbox {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Some(other) => fail("BAD_COMMAND", &format!("未知子命令 {other}")),
    }
}

/// 机读错误码（spec §5）：一行 `PIBOT_SANDBOX_ERR <code> <msg>`。
fn fail(code: &str, msg: &str) -> ! {
    eprintln!("PIBOT_SANDBOX_ERR {code} {msg}");
    std::process::exit(1);
}

fn arg_value<'a>(args: &'a [String], key: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == key)
        .and_then(|i| args.get(i + 1))
        .map(|s| s.as_str())
}

/// `--data-dir` 优先，其次环境变量 `PIBOT_DATA_DIR`。没给返回 None。
fn arg_data_dir(args: &[String]) -> Option<PathBuf> {
    if let Some(v) = arg_value(args, "--data-dir") {
        if !v.is_empty() {
            return Some(PathBuf::from(v));
        }
    }
    if let Ok(v) = std::env::var("PIBOT_DATA_DIR") {
        if !v.is_empty() {
            return Some(PathBuf::from(v));
        }
    }
    None
}

fn required<'a>(args: &'a [String], key: &str) -> &'a str {
    match arg_value(args, key) {
        Some(v) if !v.is_empty() => v,
        _ => fail("BAD_ARGS", &format!("缺少参数 {key}")),
    }
}

#[cfg(windows)]
fn cmd_run(args: &[String]) -> ExitCode {
    imp::run(args)
}

#[cfg(not(windows))]
fn cmd_run(_args: &[String]) -> ExitCode {
    fail(
        "UNSUPPORTED_PLATFORM",
        "这个启动器只在 Windows 上有实现（macOS 用 Seatbelt，Linux 用 bwrap）",
    )
}

#[cfg(windows)]
fn cmd_selfcheck(args: &[String]) -> ExitCode {
    imp::selfcheck(args)
}

#[cfg(not(windows))]
fn cmd_selfcheck(_args: &[String]) -> ExitCode {
    fail("UNSUPPORTED_PLATFORM", "selfcheck 只在 Windows 上有实现")
}

/// 删掉某个实例的 AppContainer profile（bot 删除 / 卸载时调用）。
///
/// spec §6.1：「删实例时 revoke 并删除 profile」。不删会留下
/// `%LOCALAPPDATA%\Packages\<profile>` 目录和注册表条目，越积越多。
#[cfg(windows)]
fn cmd_delete_profile(args: &[String]) -> ExitCode {
    imp::delete_profile(required(args, "--profile"))
}

#[cfg(not(windows))]
fn cmd_delete_profile(_args: &[String]) -> ExitCode {
    fail("UNSUPPORTED_PLATFORM", "delete-profile 只在 Windows 上有实现")
}

fn cmd_grant(args: &[String], grant: bool) -> ExitCode {
    #[cfg(windows)]
    {
        let profile = required(args, "--profile");
        let path = PathBuf::from(required(args, "--path"));
        let mode = arg_value(args, "--mode").unwrap_or("rw");
        let data_dir = arg_data_dir(args);
        match imp::grant(profile, &path, mode, grant, data_dir.as_deref()) {
            Ok(()) => {
                println!("PIBOT_SANDBOX_OK {} {}", if grant { "grant" } else { "revoke" }, path.display());
                ExitCode::SUCCESS
            }
            Err((code, msg)) => {
                fail(&code, &msg);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (args, grant);
        fail("UNSUPPORTED_PLATFORM", "grant/revoke 只在 Windows 上有实现");
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::collections::BTreeMap;

    use windows_sys::Win32::Foundation::{
        LocalFree, CloseHandle, ERROR_SUCCESS, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::Security::Authorization::{
        GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W,
        ACCESS_MODE, SE_FILE_OBJECT, SET_ACCESS, REVOKE_ACCESS, TRUSTEE_W,
        TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN,
    };
    use windows_sys::Win32::Security::{
        ACL, DACL_SECURITY_INFORMATION, PSID, SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES,
    };
    use windows_sys::Win32::Security::Isolation::{
        CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
    };
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        JobObjectBasicUIRestrictions, SetInformationJobObject,
        JOBOBJECT_BASIC_UI_RESTRICTIONS, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
        InitializeProcThreadAttributeList, ResumeThread, UpdateProcThreadAttribute,
        WaitForSingleObject, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
        EXTENDED_STARTUPINFO_PRESENT, PROCESS_INFORMATION, STARTUPINFOEXW,
    };
    use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE};

    /// `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` 的常量值。
    /// windows-sys 没导出它（它由 `ProcThreadAttributeValue(22, FALSE, TRUE, FALSE)`
    /// 宏算出来），这里写死并加注释，避免有人以为是随手编的魔数。
    const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES: usize = 0x0002_0009;

    /// 访问掩码常量（winnt.h）。
    const FILE_GENERIC_READ: u32 = 0x0012_0089;
    const FILE_GENERIC_WRITE: u32 = 0x0012_0116;
    const FILE_GENERIC_EXECUTE: u32 = 0x0012_00A0;
    const FILE_DELETE_CHILD: u32 = 0x0040;
    const DELETE: u32 = 0x0001_0000;
    const WRITE_DAC: u32 = 0x0004_0000;

    /// Job 限制（spec §6.3）。
    ///
    /// ★ 光给字段赋值没用：每个上限都要在 `LimitFlags` 里置对应的位，
    ///   否则内核直接忽略那个字段（实测：置位前开 45 个进程也不报错）。
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION: u32 = 0x0400;
    const JOB_OBJECT_LIMIT_ACTIVE_PROCESS: u32 = 0x0008;
    const JOB_OBJECT_LIMIT_PROCESS_MEMORY: u32 = 0x0100;
    const JOB_OBJECT_LIMIT_JOB_MEMORY: u32 = 0x0200;

    fn get_sid(profile: &str) -> Result<PSID, (String, String)> {
        let name = wide(profile);
        let mut sid: PSID = std::ptr::null_mut();
        // 先试创建（已存在会返回 HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)）
        let hr = unsafe {
            CreateAppContainerProfile(
                name.as_ptr(),
                name.as_ptr(),
                wide("pi-bot sandbox instance").as_ptr(),
                std::ptr::null(),
                0,
                &mut sid,
            )
        };
        if hr >= 0 {
            return Ok(sid);
        }
        let hr2 = unsafe { DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid) };
        if hr2 >= 0 {
            return Ok(sid);
        }
        Err((
            "PROFILE_FAILED".into(),
            format!("创建/派生 AppContainer profile 失败（hr=0x{hr2:08X}）"),
        ))
    }

    fn sid_string(sid: PSID) -> Result<String, (String, String)> {
        let mut out: *mut u16 = std::ptr::null_mut();
        let ok = unsafe { ConvertSidToStringSidW(sid, &mut out) };
        if ok == 0 || out.is_null() {
            return Err(("SID_FAILED".into(), "SID 转字符串失败".into()));
        }
        let s = unsafe { pcwstr_to_string(out) };
        unsafe { LocalFree(out as *mut _) };
        Ok(s)
    }

    unsafe fn pcwstr_to_string(p: *const u16) -> String {
        let mut len = 0usize;
        while *p.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
    }

    /// 给 `path` 加/删一条给 AppContainer SID 的 ACE。
    ///
    /// 只动 DACL（DACL_SECURITY_INFORMATION），不碰 owner / SACL ——
    /// 普通用户没 SeSecurityPrivilege，碰 SACL 会直接 ERROR_PRIVILEGE_NOT_HELD。
    fn set_ace(path: &Path, sid: PSID, mask: u32, inherit: bool, grant: bool) -> Result<(), (String, String)> {
        set_ace_mode(path, sid, mask, inherit, if grant { SET_ACCESS } else { REVOKE_ACCESS })
    }

    /// `mode` 是 EXPLICIT_ACCESS_W.grfAccessMode：SET_ACCESS / DENY_ACCESS / REVOKE_ACCESS。
    fn set_ace_mode(path: &Path, sid: PSID, mask: u32, inherit: bool, mode: ACCESS_MODE) -> Result<(), (String, String)> {
        let wpath = wide(&path.to_string_lossy());
        let mut old_dacl: *mut ACL = std::ptr::null_mut();
        let mut sd: PSID = std::ptr::null_mut();
        let rc = unsafe {
            GetNamedSecurityInfoW(
                wpath.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut old_dacl,
                std::ptr::null_mut(),
                &mut sd,
            )
        };
        if rc != ERROR_SUCCESS {
            return Err((
                "ACE_READ_FAILED".into(),
                format!("读 ACL 失败（{}）: win32={rc}", path.display()),
            ));
        }

        let trustee = TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: 0,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: sid as *mut u16,
        };
        // SUB_CONTAINERS_AND_OBJECTS_INHERIT = 0x3；只对目录用
        let inheritance: u32 = if inherit { 0x3 } else { 0x0 };
        let ea = EXPLICIT_ACCESS_W {
            grfAccessPermissions: mask,
            grfAccessMode: mode,
            grfInheritance: inheritance,
            Trustee: trustee,
        };

        let mut new_dacl: *mut ACL = std::ptr::null_mut();
        let rc = unsafe { SetEntriesInAclW(1, &ea, old_dacl, &mut new_dacl) };
        if rc != ERROR_SUCCESS {
            unsafe { LocalFree(sd as *mut _) };
            return Err((
                "ACE_BUILD_FAILED".into(),
                format!("构造 ACL 失败（{}）: win32={rc}", path.display()),
            ));
        }
        let rc = unsafe {
            SetNamedSecurityInfoW(
                wpath.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                new_dacl,
                std::ptr::null_mut(),
            )
        };
        unsafe {
            LocalFree(new_dacl as *mut _);
            LocalFree(sd as *mut _);
        }
        if rc != ERROR_SUCCESS {
            return Err((
                "ACE_WRITE_FAILED".into(),
                format!("写 ACL 失败（{}）: win32={rc}", path.display()),
            ));
        }
        Ok(())
    }

    /// 把某个对象的 DACL 标成「不再继承父级」（PROTECTED_DACL_SECURITY_INFORMATION），
    /// 然后把它自己 DACL 里给 AppContainer 的显式条目删掉。
    ///
    /// ★ 为什么不能用 deny ACE：AppContainer 的令牌是**受限令牌**，
    ///   访问检查的第二趟只比对 restricted SIDs 并且**忽略 deny ACE**。
    ///   实测：`icacls /deny` 对一个 AppContainer SID 加 DENY(W)，
    ///   沙箱进程照样写得进去。唯一可靠的做法是「根本不给 ACE」。
    fn protect_object(path: &Path, sid: PSID) -> Result<(), (String, String)> {
        use windows_sys::Win32::Security::{
            AclSizeInformation, GetAclInformation, GetAce, InitializeAcl, AddAce,
            ACL_SIZE_INFORMATION, ACL_REVISION_DS, PROTECTED_DACL_SECURITY_INFORMATION,
        };
        use windows_sys::Win32::Security::ACCESS_ALLOWED_ACE;

        let wpath = wide(&path.to_string_lossy());

        // 第一步：断继承。传当前 DACL + PROTECTED：继承来的条目会被
        // 固化成显式条目，之后才能逐条挑掉。
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut sd: PSID = std::ptr::null_mut();
        let rc = unsafe {
            GetNamedSecurityInfoW(
                wpath.as_ptr(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(), std::ptr::null_mut(), &mut dacl,
                std::ptr::null_mut(), &mut sd,
            )
        };
        if rc != ERROR_SUCCESS {
            return Err(("ACE_READ_FAILED".into(), format!("读 ACL 失败（{}）: win32={rc}", path.display())));
        }
        let rc = unsafe {
            SetNamedSecurityInfoW(
                wpath.as_ptr(), SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(), std::ptr::null_mut(), dacl, std::ptr::null_mut(),
            )
        };
        unsafe { LocalFree(sd as *mut _) };
        if rc != ERROR_SUCCESS {
            return Err(("ACE_PROTECT_FAILED".into(), format!("断继承失败（{}）: win32={rc}", path.display())));
        }

        // 第二步：重新读一遍（断继承之后版本），逐条复制，跳过给 AC SID 的。
        //
        // ★ 为什么手工重建而不是用 SetEntriesInAclW(REVOKE_ACCESS)：
        //   REVOKE 只删「显式」条目，而刚固化的继承条目仍带
        //   INHERITED_ACE 标志 —— 实测删不掉，appcontainer 照样可写。
        let mut dacl2: *mut ACL = std::ptr::null_mut();
        let mut sd2: PSID = std::ptr::null_mut();
        let rc = unsafe {
            GetNamedSecurityInfoW(
                wpath.as_ptr(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(), std::ptr::null_mut(), &mut dacl2,
                std::ptr::null_mut(), &mut sd2,
            )
        };
        if rc != ERROR_SUCCESS {
            return Err(("ACE_READ_FAILED".into(), format!("重读 ACL 失败（{}）: win32={rc}", path.display())));
        }

        let mut info: ACL_SIZE_INFORMATION = unsafe { std::mem::zeroed() };
        let ok = unsafe {
            GetAclInformation(
                dacl2, &mut info as *mut _ as *mut _,
                std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32, AclSizeInformation,
            )
        };
        if ok == 0 {
            unsafe { LocalFree(sd2 as *mut _) };
            return Err(("ACE_READ_FAILED".into(), format!("读 ACL 信息失败（{}）", path.display())));
        }

        // 重新分配一个足够大的 ACL（原大小 + 对齐余量）
        let new_size = std::mem::size_of::<ACL>() + info.AclBytesInUse as usize + 64;
        let mut new_acl_buf = vec![0u8; new_size];
        let new_acl = new_acl_buf.as_mut_ptr() as *mut ACL;
        let ok = unsafe { InitializeAcl(new_acl, new_size as u32, ACL_REVISION_DS) };
        if ok == 0 {
            unsafe { LocalFree(sd2 as *mut _) };
            return Err(("ACE_BUILD_FAILED".into(), format!("初始化 ACL 失败（{}）", path.display())));
        }

        for i in 0..info.AceCount {
            let mut ace: *mut std::ffi::c_void = std::ptr::null_mut();
            if unsafe { GetAce(dacl2, i, &mut ace) } == 0 || ace.is_null() {
                continue;
            }
            // 只处理 ACCESS_ALLOWED_ACE（deny / audit 条目与我们无关，原样保留）
            let hdr = ace as *const windows_sys::Win32::Security::ACE_HEADER;
            let ace_type = unsafe { (*hdr).AceType };
            // ACCESS_ALLOWED_ACE_TYPE = 0（windows-sys 没导出这个常量名）
            if ace_type == 0 {
                let aaa = ace as *const ACCESS_ALLOWED_ACE;
                // SID 在结构体里紧跟在 Mask 之后
                let sid_ptr = unsafe { std::ptr::addr_of!((*aaa).SidStart) as PSID };
                if unsafe { windows_sys::Win32::Security::EqualSid(sid_ptr, sid) } != 0 {
                    continue; // 跳过 AppContainer 的那条
                }
            }
            let ace_size = unsafe { (*hdr).AceSize } as u32;
            let ok = unsafe { AddAce(new_acl, ACL_REVISION_DS, u32::MAX, ace, ace_size) };
            if ok == 0 {
                unsafe { LocalFree(sd2 as *mut _) };
                return Err(("ACE_BUILD_FAILED".into(), format!("复制 ACE 失败（{}）", path.display())));
            }
        }

        let rc = unsafe {
            SetNamedSecurityInfoW(
                wpath.as_ptr(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(), std::ptr::null_mut(), new_acl, std::ptr::null_mut(),
            )
        };
        unsafe { LocalFree(sd2 as *mut _) };
        if rc != ERROR_SUCCESS {
            return Err(("ACE_WRITE_FAILED".into(), format!("写 ACL 失败（{}）: win32={rc}", path.display())));
        }
        Ok(())
    }

    /// 把对象改成「AppContainer 可读、不可写」。
    ///
    /// 与 `protect_object` 的区别：那个会把这个 SID 的条目整个删掉（连读也不行）；
    /// 这个先断继承（去掉从父目录继承来的写权），再显式授一条只读。
    ///
    /// 用于 worktree 的 `.git` 指针文件：bot 必须能读出 `gitdir: ...` 才能干活，
    /// 但绝不能改它（改它 = 把工作目录劫持到主仓别处）。
    fn make_readonly(path: &Path, sid: PSID) -> Result<(), (String, String)> {
        use windows_sys::Win32::Security::PROTECTED_DACL_SECURITY_INFORMATION;
        let wpath = wide(&path.to_string_lossy());

        // 1. 断继承（保留当前条目）
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut sd: PSID = std::ptr::null_mut();
        let rc = unsafe {
            GetNamedSecurityInfoW(
                wpath.as_ptr(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(), std::ptr::null_mut(), &mut dacl,
                std::ptr::null_mut(), &mut sd,
            )
        };
        if rc != ERROR_SUCCESS {
            return Err(("ACE_READ_FAILED".into(), format!("读 ACL 失败（{}）: win32={rc}", path.display())));
        }
        let rc = unsafe {
            SetNamedSecurityInfoW(
                wpath.as_ptr(), SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(), std::ptr::null_mut(), dacl, std::ptr::null_mut(),
            )
        };
        unsafe { LocalFree(sd as *mut _) };
        if rc != ERROR_SUCCESS {
            return Err(("ACE_PROTECT_FAILED".into(), format!("断继承失败（{}）: win32={rc}", path.display())));
        }

        // 2. 显式授只读（断继承可能把原本能读的也断了）
        set_ace(path, sid, FILE_GENERIC_READ, false, true)?;
        Ok(())
    }

    fn mode_mask(mode: &str) -> u32 {
        match mode {
            "rx" => FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
            // rw：读写执行 + 删子项。**不给** DELETE（对目录是删自己）以外的语义，
            // 但必须给 FILE_DELETE_CHILD，否则 AppContainer 里连自己刚建的
            // 文件都删不掉（实测：授 M 时 Remove-Item 一律 Access denied）。
            _ => FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | FILE_DELETE_CHILD,
        }
    }

    pub fn grant(
        profile: &str,
        path: &Path,
        mode: &str,
        grant: bool,
        data_dir: Option<&Path>,
    ) -> Result<(), (String, String)> {
        let sid = get_sid(profile)?;
        if !path.exists() {
            return Err((
                "PATH_MISSING".into(),
                format!("路径不存在：{}", path.display()),
            ));
        }
        // 拒绝规则（spec §15）：盘符根、用户主目录及其祖先、%APPDATA%/%LOCALAPPDATA%
        let canon = fs::canonicalize(path)
            .map_err(|e| ("PATH_INVALID".into(), format!("路径无法规范化: {e}")))?;
        reject_unsafe(&canon, data_dir)?;
        let mask = mode_mask(mode);
        set_ace(path, sid, mask, true, grant)?;
        if grant {
            protect_git_metadata(path, sid)?;
        }
        Ok(())
    }

    /// spec §15 的拒绝清单。返回 Err 时调用方 fail-closed。
    ///
    /// ★ 只拒「就是保护目录」或「是保护目录的祖先」两种。
    ///   保护目录的**子目录**是正常用法（`~\pi-bot-work` 就在 %USERPROFILE% 下），
    ///   一律拒掉会让沙箱在任何真实布局下都开不起来。
    fn reject_unsafe(path: &Path, data_dir: Option<&Path>) -> Result<(), (String, String)> {
        let norm = |s: &str| {
            let lower = s.to_lowercase();
            // fs::canonicalize 在 Windows 上返回 `\\?\C:\...` verbatim 形式，
            // 不去掉前缀会被下面的 UNC 规则误杀。
            let stripped = lower.strip_prefix("\\\\?\\").unwrap_or(&lower).to_string();
            // ★ 分隔符要统一。canonicalize 给的是全反斜杠，而工作目录 / dataDir
            //   可能是 `C:\Users\XL\AppData\Local/pi-bot/data` 这种混写（环境变量、
            //   脚本传参都会这样）。不归一化的话比较永远不相等，
            //   dataDir 保护被静默绕过（实测：混写路径能拿到 grant）。
            let unified = stripped.replace('/', "\\");
            unified.trim_end_matches('\\').to_string()
        };
        let p = norm(&path.to_string_lossy());
        if p.len() == 2 && p.ends_with(':') {
            return Err(("WORKDIR_IS_DRIVE_ROOT".into(), format!("拒绝盘符根：{}", path.display())));
        }
        if p.starts_with("\\\\") {
            return Err(("WORKDIR_IS_UNC".into(), format!("拒绝 UNC 路径：{}", path.display())));
        }

        let mut guarded: Vec<(String, String)> = Vec::new();
        for key in [
            "USERPROFILE", "APPDATA", "LOCALAPPDATA",
            "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
            "SYSTEMROOT", "WINDIR", "PUBLIC",
        ] {
            if let Ok(v) = std::env::var(key) {
                if !v.is_empty() {
                    guarded.push((key.to_string(), norm(&v)));
                }
            }
        }
        if let Some(d) = data_dir {
            guarded.push(("dataDir".into(), norm(&d.to_string_lossy())));
        }
        for (label, g) in &guarded {
            if g.is_empty() {
                continue;
            }
            if &p == g {
                return Err((
                    "WORKDIR_IS_PROTECTED".into(),
                    format!("拒绝把 {label} 本身当工作目录：{}", path.display()),
                ));
            }
            if g.starts_with(&format!("{p}\\")) {
                return Err((
                    "WORKDIR_CONTAINS_PROTECTED".into(),
                    format!("拒绝把 {label} 的祖先目录当工作目录：{}", path.display()),
                ));
            }
        }

        // ★ 凭据 / 浏览器配置 / 其它实例的敏感子目录：**包括其子目录**都要拒。
        //
        //   上面那圈只拒“就是 X”和“是 X 的祖先”，允许 X 的子目录当工作目录
        //   （`~\pi-bot-work` 这种正常用法必须放行）。但那让 `~/.ssh`、
        //   `%APPDATA%\Microsoft\Credentials` 这种“敏感目录本身”也能过 ——
        //   实测：`workDir=~/.ssh` 时 wrap 返回 ok，沙箱里能直接列出
        //   `config` / `config.bak`。所以凭据类目录要整棵子树都拒。
        let mut sensitive: Vec<(String, String)> = Vec::new();
        if let Ok(up) = std::env::var("USERPROFILE") {
            let up = norm(&up);
            if !up.is_empty() {
                for name in [
                    ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker",
                    ".config", ".git-credentials", ".netrc", ".npmrc", ".pypirc",
                    ".pi", ".agents",
                ] {
                    sensitive.push((format!("%USERPROFILE%\\{name}"), format!("{up}\\{}", name.to_lowercase())));
                }
            }
        }
        for key in ["APPDATA", "LOCALAPPDATA"] {
            if let Ok(v) = std::env::var(key) {
                let base = norm(&v);
                if !base.is_empty() {
                    // 浏览器配置 / 凭据库目录（子目录整棵拒）
                    //
                    // ★ 不列 `{key}\pi-bot`：那正是 pi-bot 自己的数据目录的
                    //   上级，而默认工作目录就是 `<dataDir>\workspace`
                    //   （见 server/src/config.js）。把它列成敏感目录会让
                    //   每一个默认配置的 bot 都报 WORKDIR_IS_SENSITIVE ——
                    //   本地打开发行包当场复现。dataDir 本身已由
                    //   WORKDIR_IS_PROTECTED / WORKDIR_CONTAINS_PROTECTED 拦住。
                    for name in [
                        "Microsoft\\Credentials",
                        "Microsoft\\Crypto",
                        "Google\\Chrome\\User Data",
                        "Microsoft\\Edge\\User Data",
                        "Mozilla\\Firefox",
                        "BraveSoftware",
                    ] {
                        sensitive.push((
                            format!("{key}\\{name}"),
                            format!("{base}\\{}", name.to_lowercase()),
                        ));
                    }
                }
            }
        }
        for (label, s) in sensitive {
            if s.is_empty() {
                continue;
            }
            if p == s || p.starts_with(&format!("{s}\\")) {
                return Err((
                    "WORKDIR_IS_SENSITIVE".into(),
                    format!("拒绝把凭据 / 浏览器配置目录（{label} 及其子目录）当工作目录：{}", path.display()),
                ));
            }
        }
        Ok(())
    }

    /// spec §16 P1：`.git/hooks` 与 `.git/config` 对沙箱只读。
    ///
    /// 为什么只锁这两个而不是整个 `.git`：bot 正常干活要写 objects / index，
    /// 锁整个 `.git` 等于禁掉 git。hooks 是持久化后门（下次 commit 就跑），
    /// config 里能塞 `core.hooksPath` / `core.pager` / `alias.*=!cmd`，
    /// 这两处锁上就断掉了跨会话的执行路径。
    ///
    /// 残留（写进文档，不在 v0 解决）：如果 `.git/hooks` 不存在，这里会建一个
    /// 空目录再锁；用户如果删掉整个 `.git` 重建，下一次 run 会重新锁。
    fn protect_git_metadata(workdir: &Path, sid: PSID) -> Result<(), (String, String)> {
        let git = workdir.join(".git");
        if !git.exists() {
            // 工作目录还不是 git 仓库：没什么可锁的。等它变成仓库后，
            // 下一次 run 会自动补上。
            return Ok(());
        }

        // ★ worktree 里的 `.git` 是**文件**（内容是 `gitdir: <主仓路径>`），
        //   不是目录。实测：把它当目录用会在 `.git/hooks` 上建目录失败，
        //   整个 run 直接 fail-closed —— 而 worktree 正是我们给 bot 做
        //   文件隔离要用的机制，所以这条路必须通。
        //
        //   worktree 场景下 hooks / config 都在**主仓**里（共享），
        //   不在这个工作目录下，也就不在这个 AppContainer 的授权范围里。
        //   我们只需要锁住 `.git` 这个指针文件本身：改它等于把 bot 的
        //   工作目录劫持到主仓别处（持久化向量）。
        if git.is_file() {
            // ★ 只把继承去掉、**保留读**。
            //
            //   protect_object 会把这个对象的 AC SID 条目整个删掉 ——
            //   对 `.git` 目录是正确的，但对 worktree 的 `.git` **指针文件**
            //   会导致 bot 连 "gitdir: ..." 都读不到，node / isomorphic-git
            //   全都启动失败（实测：读 `.git` 直接 EXIT=1）。
            //
            //   要的效果是「可读、不可改」：断继承（防止父目录继承来的写权）
            //   + 保留只读。
            make_readonly(&git, sid)?;
            return Ok(());
        }

        let hooks = git.join("hooks");
        if !hooks.exists() {
            if let Err(e) = fs::create_dir(&hooks) {
                return Err((
                    "GIT_HOOKS_MKDIR_FAILED".into(),
                    format!("git 仓库存在但建不出 hooks 目录: {e}"),
                ));
            }
        }
        protect_object(&hooks, sid)?;
        // ★ config 也只用「只读保护」，不能把读权也删掉。
        //   实测：`protect_object` 会连同读权一起收回 AC SID 的条目，
        //   于是 isomorphic-git 一 open('.git/config') 就 EPERM，
        //   整个提交失败。config 需要「可读、不可改」。
        let config = git.join("config");
        if config.exists() {
            make_readonly(&config, sid)?;
        }
        Ok(())
    }

    pub fn run(args: &[String]) -> ExitCode {
        let profile = required(args, "--profile").to_string();
        let workdir = PathBuf::from(required(args, "--workdir"));
        let instance = PathBuf::from(required(args, "--instance"));
        let shell = arg_value(args, "--shell").unwrap_or("powershell").to_string();
        let cmd_file = PathBuf::from(required(args, "--cmd-file"));

        let sid = match get_sid(&profile) {
            Ok(v) => v,
            Err((c, m)) => fail(&c, &m),
        };
        let sid_str = match sid_string(sid) {
            Ok(v) => v,
            Err((c, m)) => fail(&c, &m),
        };
        eprintln!("PIBOT_SANDBOX_PROFILE {profile} sid={sid_str}");

        // 工作目录与实例目录都要有 ACE（实例目录放 HOME/TEMP）
        for (dir, mode) in [(&workdir, "rw"), (&instance, "rw")] {
            if let Err(e) = fs::create_dir_all(dir) {
                fail("INSTANCE_MKDIR_FAILED", &format!("建目录失败 {}: {e}", dir.display()));
            }
            if let Ok(canon) = fs::canonicalize(dir) {
                let data_dir = arg_data_dir(args);
                if let Err((c, m)) = reject_unsafe(&canon, data_dir.as_deref()) {
                    fail(&c, &m);
                }
            }
            let mask = mode_mask(mode);
            if let Err((c, m)) = set_ace(dir, sid, mask, true, true) {
                fail(&c, &m);
            }
        }
        if let Err((c, m)) = protect_git_metadata(&workdir, sid) {
            fail(&c, &m);
        }

        // ---- Job Object ----
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            fail("JOB_FAILED", "CreateJobObject 失败");
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            | JOB_OBJECT_LIMIT_PROCESS_MEMORY
            | JOB_OBJECT_LIMIT_JOB_MEMORY;
        limits.BasicLimitInformation.ActiveProcessLimit = 32;
        limits.ProcessMemoryLimit = 2 * 1024 * 1024 * 1024;
        limits.JobMemoryLimit = 4 * 1024 * 1024 * 1024;
        let ok = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            fail("JOB_LIMIT_FAILED", "SetInformationJobObject(Extended) 失败");
        }
        // 只设实测被接受的 UI 位（SWITCHDESKTOP 会 ERROR_INVALID_PARAMETER 87）
        let mut ui: JOBOBJECT_BASIC_UI_RESTRICTIONS = unsafe { std::mem::zeroed() };
        ui.UIRestrictionsClass = 0x0001 | 0x0002 | 0x0004 | 0x0008 | 0x0010 | 0x0020 | 0x0040 | 0x0080;
        let ok = unsafe {
            SetInformationJobObject(
                job,
                JobObjectBasicUIRestrictions,
                &ui as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_BASIC_UI_RESTRICTIONS>() as u32,
            )
        };
        if ok == 0 {
            fail("JOB_LIMIT_FAILED", "SetInformationJobObject(UI) 失败");
        }

        // ---- 读命令文件（读完删除，见 spec §16）----
        let script = match fs::read(&cmd_file) {
            Ok(b) => String::from_utf8_lossy(&b).to_string(),
            Err(e) => fail("CMD_FILE_FAILED", &format!("读命令文件失败: {e}")),
        };
        let _ = fs::remove_file(&cmd_file);

        let full_script = format!("{}{}", powershell_prologue(), script);
        let (exe, argv) = match shell.as_str() {
            "powershell" => build_powershell(&full_script),
            other => fail("BAD_SHELL", &format!("不支持的 shell: {other}（v0 只交付 powershell）")),
        };

        // ---- 环境变量白名单 ----
        let mut env = build_env(&instance);
        // --env KEY=VALUE：调用方显式要求的额外变量（白名单之外）。
        // 只给调用方明确写的键，不做前缀放行 —— 服务端凭据靠 Node 侧
        // buildChildEnv 再挡一次，启动器这层不做名字猜测。
        let mut i = 0;
        while i < args.len() {
            if args[i] == "--env" {
                if let Some(kv) = args.get(i + 1) {
                    if let Some((k, val)) = kv.split_once('=') {
                        // ★ 键值里不能有 NUL：环境块是 NUL 分隔的，
                        //   中间冒一个 NUL 会把后面的键整段截掉（等于静默丢
                        //   白名单里的其它变量，很难查）。
                        if k.is_empty() || k.contains('\u{0}') || val.contains('\u{0}') || k.contains('=') {
                            fail("BAD_ENV", &format!("--env 参数非法: {k}"));
                        }
                        env.insert(k.to_string(), val.to_string());
                    }
                }
                i += 2;
                continue;
            }
            i += 1;
        }
        // 工作目录通过环境变量交给引导脚本：进程 cwd 在 AC 目录，
        // 用户命令的相对路径要落在真正的工作目录上。
        env.insert("PIBOT_SANDBOX_WORKDIR".into(), workdir.to_string_lossy().into());
        env.insert("PIBOT_SANDBOX_INSTANCE".into(), instance.to_string_lossy().into());
        let mut env_block = Vec::<u16>::new();
        for (k, v) in &env {
            env_block.extend(wide(&format!("{k}={v}")));
            env_block.pop(); // 去掉 wide 的结尾 NUL，稍后统一补
            env_block.push(0);
        }
        env_block.push(0);

        // ---- 启动 ----
        let mut attr_size: usize = 0;
        unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut attr_size) };
        let mut attr_buf = vec![0u8; attr_size];
        let attr_list = attr_buf.as_mut_ptr() as *mut _;
        if unsafe { InitializeProcThreadAttributeList(attr_list, 1, 0, &mut attr_size) } == 0 {
            fail("ATTR_FAILED", "InitializeProcThreadAttributeList 失败");
        }
        let mut caps = SECURITY_CAPABILITIES {
            AppContainerSid: sid,
            Capabilities: std::ptr::null_mut(),
            CapabilityCount: 0,
            Reserved: 0,
        };
        let ok = unsafe {
            UpdateProcThreadAttribute(
                attr_list,
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                &mut caps as *mut _ as *const _,
                std::mem::size_of::<SECURITY_CAPABILITIES>(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        if ok == 0 {
            fail("ATTR_FAILED", "UpdateProcThreadAttribute(SECURITY_CAPABILITIES) 失败");
        }

        // cwd 一定落到 AppContainer 自己的 AC 目录（理由见文件头）
        let ac_temp = ac_temp_dir(&profile);
        let _ = fs::create_dir_all(&ac_temp);
        if let Err((c, m)) = set_ace(&ac_temp, sid, mode_mask("rw"), true, true) {
            // 系统通常已经给了，授失败不阻断，只是记一条
            eprintln!("PIBOT_SANDBOX_WARN ACE_AC_TEMP {c} {m}");
        }

        let mut si: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
        si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        si.lpAttributeList = attr_list;
        // 把宿主的标准句柄传下去 —— 子进程拿不到有效 0/1/2 时，
        // git 之类 program 的 sanitize_stdfds() 会去开 /dev/null，
        // 在 AppContainer 里被拒，于是每条命令都报 could not open '/dev/null'。
        // ★ 句柄必须显式标成可继承。
        //   GetStdHandle 拿到的管道句柄默认**不带** HANDLE_FLAG_INHERIT，
        //   即使 CreateProcess 传了 bInheritHandles=TRUE，子进程的 0/1/2
        //   仍然是无效句柄 —— 这时 MSYS2 的 git 在启动期 sanitize_stdfds()
        //   会去开 /dev/null 补上，而 AppContainer 里打开 NUL 被拒，
        //   于是每条 git 命令都死在 "could not open '/dev/null'"。
        //   （实测：只设 STARTF_USESTDHANDLES 不够，必须配 SetHandleInformation。）
        si.StartupInfo.dwFlags = windows_sys::Win32::System::Threading::STARTF_USESTDHANDLES;
        let mut std_invalid = false;
        for (id, slot) in [
            (STD_INPUT_HANDLE, &mut si.StartupInfo.hStdInput),
            (STD_OUTPUT_HANDLE, &mut si.StartupInfo.hStdOutput),
            (STD_ERROR_HANDLE, &mut si.StartupInfo.hStdError),
        ] {
            let h = unsafe { GetStdHandle(id) };
            if h.is_null() || h == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
                std_invalid = true;
                *slot = std::ptr::null_mut();
                continue;
            }
            unsafe {
                windows_sys::Win32::Foundation::SetHandleInformation(
                    h,
                    windows_sys::Win32::Foundation::HANDLE_FLAG_INHERIT,
                    windows_sys::Win32::Foundation::HANDLE_FLAG_INHERIT,
                );
            }
            *slot = h;
        }
        if std_invalid {
            // 宿主自己就没标准句柄（很少见，双击启动之类）：退回"不传句柄"，
            // 让子进程自己找控制台。至少不因为 -1 句柄让 CreateProcess 失败。
            eprintln!("PIBOT_SANDBOX_WARN NO_STD_HANDLES");
            si.StartupInfo.dwFlags = 0;
            si.StartupInfo.hStdInput = std::ptr::null_mut();
            si.StartupInfo.hStdOutput = std::ptr::null_mut();
            si.StartupInfo.hStdError = std::ptr::null_mut();
        }

        let mut cmdline = wide(&format!("\"{}\" {}", exe, argv.join(" ")));
        let cwd_w = wide(&ac_temp.to_string_lossy());
        let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        let ok = unsafe {
            CreateProcessW(
                std::ptr::null(),
                cmdline.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1, // bInheritHandles：要传标准句柄
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                env_block.as_ptr() as *const _,
                cwd_w.as_ptr(),
                &si as *const _ as *const _,
                &mut pi,
            )
        };
        unsafe {
            DeleteProcThreadAttributeList(attr_list);
        }
        if ok == 0 {
            let e = unsafe { windows_sys::Win32::Foundation::GetLastError() };
            fail("CREATE_FAILED", &format!("CreateProcess 失败: win32={e}"));
        }

        let assigned = unsafe { AssignProcessToJobObject(job, pi.hProcess) };
        if assigned == 0 {
            let e = unsafe { windows_sys::Win32::Foundation::GetLastError() };
            unsafe {
                let _ = windows_sys::Win32::System::Threading::TerminateProcess(pi.hProcess, 1);
            }
            fail("JOB_ASSIGN_FAILED", &format!("AssignProcessToJobObject 失败: win32={e}"));
        }
        unsafe {
            ResumeThread(pi.hThread);
            CloseHandle(pi.hThread);
        }

        // ★ 顺序很重要：先等主进程跑完，再收句柄，最后才关 job。
        //
        //   · 先关 job → 子进程在我们还在读退出码时就死了，退出码丢成 1。
        //   · 先 TerminateJobObject → 命令刚起就被杀，什么输出都没有。
        //     （这两条都是实测踩出来的：前者表现为"命令跑完但报错退出"，
        //     后者表现为"只有 profile 行、没有命令输出"。）
        let wait = unsafe { WaitForSingleObject(pi.hProcess, 0xFFFF_FFFF) };
        let mut code: u32 = 1;
        unsafe { GetExitCodeProcess(pi.hProcess, &mut code); }
        unsafe { CloseHandle(pi.hProcess); }
        if wait != WAIT_OBJECT_0 {
            // 等不到主进程（极少见）：至少把整组杀掉，别留孤儿
            unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(job, 1) };
            unsafe { CloseHandle(job); }
            fail("WAIT_FAILED", "等待子进程失败");
        }
        // 主进程已退出。shell 里可能还有后台进程（`Start-Job` /
        // `npm run dev`）—— KILL_ON_JOB_CLOSE 要等最后一个 job 句柄关掉
        // 才生效，这里显式 terminate 一次，再关上句柄。
        // 实测：`Start-Job { Start-Sleep 300 }` 之后启动器退出，
        // 再查 powershell 进程数回到基线（没有孤儿）。
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(job, 0);
            CloseHandle(job);
        }
        ExitCode::from((code & 0xFF) as u8)
    }

    pub fn delete_profile(profile: &str) -> ExitCode {
        use windows_sys::Win32::Security::Isolation::DeleteAppContainerProfile;
        let name = wide(profile);
        let hr = unsafe { DeleteAppContainerProfile(name.as_ptr()) };
        // 已经不存在也算成功（幂等）：卸载脚本不该因为重复调用而报错。
        if hr >= 0 {
            println!("PIBOT_SANDBOX_OK delete-profile {profile}");
            return ExitCode::SUCCESS;
        }
        // ERROR_FILE_NOT_FOUND = 0x80070002
        if (hr as u32 & 0xFFFF) == 2 {
            println!("PIBOT_SANDBOX_OK delete-profile {profile} (already gone)");
            return ExitCode::SUCCESS;
        }
        fail("PROFILE_DELETE_FAILED", &format!("删除 AppContainer profile 失败（hr=0x{hr:08X}）"));
    }

    pub fn selfcheck(args: &[String]) -> ExitCode {
        let profile = required(args, "--profile");
        let instance = PathBuf::from(required(args, "--instance"));
        let sid = match get_sid(profile) {
            Ok(v) => v,
            Err((c, m)) => fail(&c, &m),
        };
        let sid_str = match sid_string(sid) {
            Ok(v) => v,
            Err((c, m)) => fail(&c, &m),
        };
        if let Err(e) = fs::create_dir_all(&instance) {
            fail("INSTANCE_MKDIR_FAILED", &format!("建实例目录失败: {e}"));
        }
        if let Err((c, m)) = set_ace(&instance, sid, mode_mask("rw"), true, true) {
            fail(&c, &m);
        }
        // 只检查 profile / SID / ACE 三件事；真正能否跑 PowerShell
        // 由 run 的第一条命令暴露（fail-closed 由 Node 侧根据退出码判定）。
        println!("PIBOT_SANDBOX_OK selfcheck profile={profile} sid={sid_str}");
        ExitCode::SUCCESS
    }

    fn ac_temp_dir(profile: &str) -> PathBuf {
        // %LOCALAPPDATA%\Packages\<profile>\AC\Temp —— 系统给 AppContainer
        // 分配的私有区，天然带 AC SID 的 (OI)(CI)(M) 和 Low 标签。
        let local = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| {
            let up = std::env::var("USERPROFILE").unwrap_or_default();
            format!("{up}\\AppData\\Local")
        });
        PathBuf::from(local)
            .join("Packages")
            .join(profile)
            .join("AC")
            .join("Temp")
    }

    /// 进入沙箱后、用户命令之前跑的一小段引导。
    ///
    /// ★ 为什么必须这么做：普通用户（非管理员）无法给 `C:\` / `%USERPROFILE%`
    ///   加 ACE，而 AppContainer 进一个目录要求每一层祖先都可遍历。于是
    ///
    ///   - `Get-Location` 一开始是 `C:\`，
    ///   - `Set-Location <工作目录>` 一律 Access denied，
    ///   - 相对路径全部落到 `C:\` 根上（且写不进去）。
    ///
    ///   用 `New-PSDrive` 把工作目录挂成一个新盘，`Set-Location` 到那个盘符
    ///   不需要走祖先遍历，之后相对路径就正常了（实测可行）。
    ///
    ///   注意：`Set-Location` 到盘符根本身仍然是 Access denied，
    ///   所以这里只到 `X:\` 就是工作目录的根。
    fn powershell_prologue() -> String {
        r#"$ErrorActionPreference = 'Continue'
$__pibotWork = $env:PIBOT_SANDBOX_WORKDIR
if ($__pibotWork) {
  try {
    if (-not (Get-PSDrive -Name 'pibot' -ErrorAction SilentlyContinue)) {
      New-PSDrive -Name 'pibot' -PSProvider FileSystem -Root $__pibotWork -Scope Global -ErrorAction Stop | Out-Null
    }
    Set-Location 'pibot:' -ErrorAction Stop
  } catch {
    [Console]::Error.WriteLine('PIBOT_SANDBOX_ERR WORKDIR_CD_FAILED ' + $_.Exception.Message)
  }
} else {
  [Console]::Error.WriteLine('PIBOT_SANDBOX_ERR WORKDIR_ENV_MISSING')
}
"#
        .to_string()
    }

    fn build_powershell(script: &str) -> (String, Vec<String>) {
        let win = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let exe = format!("{win}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
        // ★ -EncodedCommand 要 Base64(UTF-16LE)
        let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        let b64 = base64(&utf16);
        let argv = vec![
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-OutputFormat".to_string(),
            "Text".to_string(),
            "-EncodedCommand".to_string(),
            b64,
        ];
        (exe, argv)
    }

    /// 最小 base64（避免为一个函数引入依赖）。
    fn base64(input: &[u8]) -> String {
        const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
        for chunk in input.chunks(3) {
            let b0 = chunk[0] as u32;
            let b1 = *chunk.get(1).unwrap_or(&0) as u32;
            let b2 = *chunk.get(2).unwrap_or(&0) as u32;
            let n = (b0 << 16) | (b1 << 8) | b2;
            out.push(T[(n >> 18) as usize & 63] as char);
            out.push(T[(n >> 12) as usize & 63] as char);
            out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
            out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
        }
        out
    }

    fn build_env(instance: &Path) -> BTreeMap<String, String> {
        let win = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let home = instance.join("home");
        let tmp = instance.join("tmp");
        let _ = fs::create_dir_all(home.join("AppData").join("Roaming"));
        let _ = fs::create_dir_all(home.join("AppData").join("Local"));
        let _ = fs::create_dir_all(&tmp);
        let mut env = BTreeMap::new();
        env.insert("SystemRoot".into(), win.clone());
        env.insert("windir".into(), win.clone());
        env.insert("SystemDrive".into(), "C:".into());
        env.insert("ComSpec".into(), format!("{win}\\System32\\cmd.exe"));
        env.insert("PATHEXT".into(), ".COM;.EXE;.BAT;.CMD".into());
        // spec §7：PATH 用「实际探测到的」路径。Git for Windows 装在
        // Program Files 下时对 ALL APPLICATION PACKAGES 已开放 RX（实测），
        // 所以只需要放进 PATH，不必额外授 ACE；按用户安装的 Git 藏在
        // %LOCALAPPDATA% 下（沙箱不可达），不探测它。
        let mut path_parts = vec![
            format!("{win}\\System32"),
            format!("{win}\\System32\\WindowsPowerShell\\v1.0"),
            format!("{win}\\System32\\Wbem"),
        ];
        for candidate in [
            "C:\\Program Files\\Git\\cmd",
            "C:\\Program Files (x86)\\Git\\cmd",
        ] {
            if Path::new(candidate).is_dir() {
                path_parts.push(candidate.to_string());
            }
        }
        env.insert("PATH".into(), path_parts.join(";"));
        env.insert("PSModulePath".into(), format!("{win}\\System32\\WindowsPowerShell\\v1.0\\Modules"));
        env.insert("TEMP".into(), tmp.to_string_lossy().into());
        env.insert("TMP".into(), tmp.to_string_lossy().into());
        env.insert("USERPROFILE".into(), home.to_string_lossy().into());
        env.insert("HOME".into(), home.to_string_lossy().into());
        env.insert("APPDATA".into(), home.join("AppData").join("Roaming").to_string_lossy().into());
        env.insert("LOCALAPPDATA".into(), home.join("AppData").join("Local").to_string_lossy().into());
        env.insert("LANG".into(), "zh_CN.UTF-8".into());
        env
    }

    // 未使用但保留：spec §6.4 的注册表说明需要这些常量做后续阶段
    #[allow(dead_code)]
    const _UNUSED: (u32, u32) = (DELETE, WRITE_DAC);
    #[allow(dead_code)]
    fn _std(_h: HANDLE) {}
    #[allow(dead_code)]
    const _INVALID: HANDLE = INVALID_HANDLE_VALUE;
    #[allow(dead_code)]
    const _SA: SECURITY_ATTRIBUTES = SECURITY_ATTRIBUTES { nLength: 0, lpSecurityDescriptor: std::ptr::null_mut(), bInheritHandle: 0 };
}
