# Build the Windows installer (setup.exe) from an already packed folder.
#
#   .\scripts\pack-windows-setup.ps1              # dist/pi-bot-windows-v<ver>-setup.exe
#   .\scripts\pack-windows-setup.ps1 -Help        # this text
#
# Input is dist/pi-bot-windows, which scripts/pack-windows.ps1 produces. This
# script never builds Flutter and never installs dependencies: run the folder
# pack first, so the installer wraps exactly the bytes that were scanned there
# (no user paths, no .pdb, no local state).
#
# Inno Setup 6 is required; install it with
#   winget install JRSoftware.InnoSetup
# ISCC.exe is looked up in PATH, then in the usual install locations.
#
# The setup.exe is per-user (no admin prompt) and installs to
# %LOCALAPPDATA%\Programs\pi-bot. User data in %LOCALAPPDATA%\pi-bot is never
# touched, so installing over an older version keeps pairings and history.
#
# Keep this file ASCII-only. PowerShell 5.1 decodes BOM-less scripts as ANSI.

param(
  [string]$Bundle = "dist/pi-bot-windows",
  [string]$OutDir = "dist",
  [string]$Iscc = "",
  [switch]$Help
)

$ErrorActionPreference = "Stop"

function Fail([string]$message) {
  Write-Host "ERROR: $message" -ForegroundColor Red
  exit 1
}

function Get-FullPath([string]$Path) {
  $resolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
  return [System.IO.Path]::GetFullPath($resolved)
}

# ISCC.exe is not always on PATH: the winget package installs per-user.
function Find-Iscc([string]$explicit) {
  if ($explicit) {
    if (-not (Test-Path -LiteralPath $explicit -PathType Leaf)) { return $null }
    return (Get-Item -LiteralPath $explicit).FullName
  }
  $cmd = Get-Command ISCC.exe -CommandType Application -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $guesses = @()
  if ($env:LOCALAPPDATA) { $guesses += (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe") }
  if (${env:ProgramFiles(x86)}) { $guesses += (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe") }
  if ($env:ProgramFiles) { $guesses += (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe") }
  foreach ($guess in $guesses) {
    if (Test-Path -LiteralPath $guess -PathType Leaf) { return $guess }
  }
  return $null
}

if ($Help) {
  Write-Host @"
Build the Windows installer from the packed folder.

  .\scripts\pack-windows-setup.ps1
  .\scripts\pack-windows-setup.ps1 -Bundle dist\pi-bot-windows -OutDir dist
  .\scripts\pack-windows-setup.ps1 -Iscc "C:\path\to\ISCC.exe"

Requires Inno Setup 6 (winget install JRSoftware.InnoSetup).
The bundle must already exist: run .\scripts\pack-windows.ps1 -WithNode -Zip first.
Produces dist/pi-bot-windows-v<version>-setup.exe.
"@
  exit 0
}

$root = Split-Path -Parent $PSScriptRoot
$bundleDir = if ([System.IO.Path]::IsPathRooted($Bundle)) { $Bundle } else { Join-Path $root $Bundle }
$outRoot = if ([System.IO.Path]::IsPathRooted($OutDir)) { $OutDir } else { Join-Path $root $OutDir }

if (-not (Test-Path -LiteralPath (Join-Path $bundleDir "pi_bot.exe"))) {
  Fail "no packed build at $Bundle (run scripts/pack-windows.ps1 first)"
}
if (-not (Test-Path -LiteralPath (Join-Path $bundleDir "server\src\index.js"))) {
  Fail "packed build has no server/src/index.js"
}
if (-not (Test-Path -LiteralPath (Join-Path $bundleDir "node.exe"))) {
  Write-Host "note: bundle has no node.exe - target machine will need Node 22+ on PATH"
}

$isccPath = Find-Iscc $Iscc
if (-not $isccPath) {
  Fail "ISCC.exe not found; install Inno Setup 6 (winget install JRSoftware.InnoSetup) or pass -Iscc"
}

$scriptPath = Join-Path $PSScriptRoot "installer\pi-bot.iss"
$languagePath = Join-Path $PSScriptRoot "installer\ChineseSimplified.isl"
$iconPath = Join-Path $root "app\windows\runner\resources\app_icon.ico"
foreach ($required in @($scriptPath, $languagePath, $iconPath)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { Fail "missing $required" }
}

$version = (& node -e "const p=require(process.argv[1]);process.stdout.write(String(p.version||''))" (Join-Path $root "server\package.json")).Trim()
if (-not $version) { Fail "could not read server version" }
if ($LASTEXITCODE -ne 0) { Fail "reading server version failed ($LASTEXITCODE)" }

$setupName = "pi-bot-windows-v$version-setup.exe"
$setupPath = Join-Path $outRoot $setupName
New-Item -ItemType Directory -Path $outRoot -Force | Out-Null

# Build into a neutral temp dir, then move into place: a failed compile must not
# leave a half-written installer next to the previous good one.
$suffix = [guid]::NewGuid().ToString("N").Substring(0, 8)
$stageOut = Join-Path $outRoot (".setup-" + $suffix)
New-Item -ItemType Directory -Path $stageOut -Force | Out-Null

Write-Host "== compile installer ($version) =="
try {
  # ISCC resolves relative paths in the .iss against the .iss location, so every
  # path handed over here is absolute. Values with spaces are quoted by ISCC.
  & $isccPath `
    "/DAppVersion=$version" `
    "/DStageDir=$bundleDir" `
    "/DOutDir=$stageOut" `
    "/DIconFile=$iconPath" `
    $scriptPath
  if ($LASTEXITCODE -ne 0) { throw "ISCC failed ($LASTEXITCODE)" }

  $built = Join-Path $stageOut $setupName
  if (-not (Test-Path -LiteralPath $built -PathType Leaf)) {
    throw "ISCC reported success but $setupName is missing"
  }
  Move-Item -LiteralPath $built -Destination $setupPath -Force
} catch {
  Fail "$($_.Exception.Message)"
} finally {
  if (Test-Path -LiteralPath $stageOut) {
    Remove-Item -LiteralPath $stageOut -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$size = (Get-Item -LiteralPath $setupPath).Length
$hash = (Get-FileHash -LiteralPath $setupPath -Algorithm SHA256).Hash.ToLower()
Write-Host "setup: $setupPath"
Write-Host ("size: {0} bytes" -f $size)
Write-Host "sha256: $hash"
Write-Host "done"
