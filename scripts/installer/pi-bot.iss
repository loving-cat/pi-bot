; Inno Setup script for the pi-bot Windows installer.
;
; Not compiled directly: scripts/pack-windows-setup.ps1 passes the defines below
; and calls ISCC on this file.
;
;   /DAppVersion=1.3.11
;   /DStageDir=<absolute path to dist/pi-bot-windows>
;   /DOutDir=<absolute path to dist>
;   /DIconFile=<absolute path to app_icon.ico>
;
; Install target is per-user (%LOCALAPPDATA%\Programs\pi-bot), so it never asks
; for admin rights. Runtime state lives in %LOCALAPPDATA%\pi-bot, which this
; installer does not touch, so upgrading keeps pairings and the data directory.
;
; This file is UTF-8 with BOM: the [CustomMessages] block below is Chinese.

#define MyAppName "pi-bot"
#define MyAppPublisher "loving-cat"
#define MyAppUrl "https://github.com/loving-cat/pi-bot"
#define MyAppExeName "pi_bot.exe"

; Stable across versions: the same AppId makes an upgrade replace the previous
; install instead of stacking a second copy under "Apps & features".
#define MyAppId "{{7A31C4E8-5B2D-4C1A-9F6E-2E4D8C1A7B93}"

#ifndef AppVersion
  #error AppVersion define is required
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
DefaultDirName={localappdata}\Programs\pi-bot
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutDir}
OutputBaseFilename=pi-bot-windows-v{#AppVersion}-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#MyAppName} {#AppVersion}
UninstallDisplayIcon={app}\{#MyAppExeName}
SetupIconFile={#IconFile}
VersionInfoVersion={#AppVersion}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppName} {#AppVersion} Setup
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#AppVersion}
; The client holds pi_bot.exe and the bundled node.exe; both are locked while
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
cn.LaunchApp=立即运行 pi-bot
en.LaunchApp=Launch pi-bot now
cn.StopServerHint=安装前需要结束正在运行的本机服务端。
en.StopServerHint=The local server must be stopped before installing.

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
; Whole staged package: pi_bot.exe, Flutter runtime, plugin DLLs, bundled
; node.exe and server/ (with node_modules already installed).
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchApp}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Nothing here belongs to the user's data: that lives in %LOCALAPPDATA%\pi-bot
; and is intentionally left behind so a reinstall keeps pairings and history.

[Code]
const
  SERVER_PID_SUBDIR = '\pi-bot\server.pid';

{ Stop the local server recorded in %LOCALAPPDATA%\pi-bot\server.pid.

  The GUI spawns node through a helper script and does not own the child
  process: quitting pi_bot.exe leaves node running, and node.exe sits inside
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
  PidPath := ExpandConstant('{localappdata}') + SERVER_PID_SUBDIR;
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
