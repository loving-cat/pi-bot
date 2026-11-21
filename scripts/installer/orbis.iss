; Inno Setup script for the Orbis Windows installer.
;
; Not compiled directly: scripts/pack-windows-setup.ps1 passes the defines below
; and calls ISCC on this file.
;
;   /DAppVersion=1.3.11
;   /DAppFileVersion=1.3.11.0
;   /DStageDir=<absolute path to dist/orbis-windows>
;   /DOutDir=<absolute path to dist>
;   /DIconFile=<absolute path to app_icon.ico>
;
; ★ /DAppVersion 可以是预发布版（2.0.0-alpha.1），它只用于展示与产物名；
;   Windows PE 的版本资源（VersionInfoVersion）**只认 A.B.C.D 纯数字**，
;   直接塞 2.0.0-alpha.1 会让 ISCC 报错，所以 pack-windows-setup.ps1
;   另外传一个纯数字的 /DAppFileVersion。
;
; 2026-11-19 品牌统一：安装目录改到 Programs\Orbis（AppId 不变，升级会替换旧安装）。
; 用户数据目录仍是 %LOCALAPPDATA%\pi-bot（服务端优先用 orbis，老目录存在就继续沿用），
; 安装器不碰那里，所以升级后配对与聊天记录都在。
; Install target is per-user (%LOCALAPPDATA%\Programs\Orbis), so it never asks
; for admin rights. Runtime state lives in %LOCALAPPDATA%\pi-bot (legacy) or \orbis, which this
; installer does not touch, so upgrading keeps pairings and the data directory.
;
; This file is UTF-8 with BOM: the [CustomMessages] block below is Chinese.

#define MyAppName "Orbis"
#define MyAppPublisher "Orbis Contributors"
#define MyAppUrl "https://github.com/loving-cat/orbis"
#define MyAppExeName "orbis.exe"

; Stable across versions: the same AppId makes an upgrade replace the previous
; install instead of stacking a second copy under "Apps & features".
#define MyAppId "{{7A31C4E8-5B2D-4C1A-9F6E-2E4D8C1A7B93}"

#ifndef AppVersion
  #error AppVersion define is required
#endif
; Windows 版本资源只能是 A.B.C.D。兼容预发布版：调用方不传时退回全零，
; 绝不要把（可能带 -alpha.1 的）AppVersion 直接塞进 VersionInfo。
#ifndef AppFileVersion
  #define AppFileVersion "0.0.0.0"
#endif
#ifndef StageDir
  #error StageDir define is required
#endif
#ifndef OutDir
  #error OutDir define is required
#endif

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#AppVersion}
AppVerName={#MyAppName} {#AppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppUrl}
AppSupportURL={#MyAppUrl}/issues
AppUpdatesURL={#MyAppUrl}/releases
DefaultDirName={localappdata}\Programs\Orbis
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutDir}
OutputBaseFilename=orbis-windows-v{#AppVersion}-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#MyAppName} {#AppVersion}
UninstallDisplayIcon={app}\{#MyAppExeName}
SetupIconFile={#IconFile}
VersionInfoVersion={#AppFileVersion}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppName} {#AppVersion} Setup
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#AppFileVersion}
; The client holds orbis.exe and the bundled node.exe; both are locked while
; running, and the server child process outlives the window. CloseApplications
; asks the user to close the GUI, and the [Code] hook below stops the server.
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "cn"; MessagesFile: "ChineseSimplified.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
cn.CreateDesktopIcon=创建桌面快捷方式
en.CreateDesktopIcon=Create a desktop shortcut
cn.LaunchApp=立即运行 Orbis
en.LaunchApp=Launch Orbis now
cn.StopServerHint=安装前需要结束正在运行的本机服务端。
en.StopServerHint=The local server must be stopped before installing.

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
; Whole staged package: orbis.exe, Flutter runtime, plugin DLLs, bundled
; node.exe and server/ (with node_modules already installed).
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchApp}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Nothing here belongs to the user's data: that lives in %LOCALAPPDATA%\orbis (or the legacy \pi-bot)
; and is intentionally left behind so a reinstall keeps pairings and history.

[Code]
const
  SERVER_PID_NAMES = 'orbis\server.pid;pi-bot\server.pid';

{ Stop the local server recorded in %LOCALAPPDATA%\pi-bot\server.pid.

  The GUI spawns node through a helper script and does not own the child
  process: quitting orbis.exe leaves node running, and node.exe sits inside
  the install dir, so the [Files] copy would fail on a locked image.

  Only the PID from our own pid file is killed, and only after tasklist
  confirms it is still node.exe - a stale pid file must never take out an
  unrelated process that recycled the number.

  Inno Setup cannot capture a process's stdout, so the check runs from a
  generated batch file instead of redirecting into a temp file. Passing
  "cmd /c <quoted path> <args> > <quoted file>" instead would hit cmd's quote
  stripping (it drops the first and last quote, eating the redirection). }
procedure StopBundledServer();
var
  PidPath: String;
  PidText: AnsiString;
  Pid: Integer;
  ScriptPath: String;
  Script: String;
  ResultCode: Integer;
begin
  { 2026-11-19 品牌统一后新用户的数据目录是 orbis，老用户还在 pi-bot；两个都看。 }
  PidPath := ExpandConstant('{localappdata}') + '\orbis\server.pid';
  if not FileExists(PidPath) then
    PidPath := ExpandConstant('{localappdata}') + '\pi-bot\server.pid';
  if not FileExists(PidPath) then
    exit;
  if not LoadStringFromFile(PidPath, PidText) then
    exit;
  Pid := StrToIntDef(Trim(PidText), 0);
  if Pid <= 0 then
    exit;

  ScriptPath := ExpandConstant('{tmp}\pi-bot-stop-server.bat');
  Script :=
    '@echo off' + #13#10 +
    'tasklist /FI "PID eq ' + IntToStr(Pid) + '" /NH | find /I "node.exe" >nul' + #13#10 +
    'if errorlevel 1 exit /b 0' + #13#10 +
    'taskkill /PID ' + IntToStr(Pid) + ' /T /F >nul 2>&1' + #13#10 +
    'exit /b 0' + #13#10;
  if not SaveStringToFile(ScriptPath, Script, False) then
    exit;
  try
    Exec(ExpandConstant('{cmd}'), '/c "' + ScriptPath + '"', '', SW_HIDE,
         ewWaitUntilTerminated, ResultCode);
  finally
    DeleteFile(ScriptPath);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
    StopBundledServer();
end;
