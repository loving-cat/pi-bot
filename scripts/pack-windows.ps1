# Build a self-contained Windows folder (and optionally a zip).
#
#   .\scripts\pack-windows.ps1                 # dist/pi-bot-windows
#   .\scripts\pack-windows.ps1 -Zip            # + dist/pi-bot-windows.zip
#   .\scripts\pack-windows.ps1 -WithNode -Zip  # bundle node.exe (needs no Node on target)
#   .\scripts\pack-windows.ps1 -NoBuild        # reuse the existing Release build
#   .\scripts\pack-windows.ps1 -Help           # this text
#
# The desktop app starts the server by itself. It looks for
# `server/src/index.js` next to pi_bot.exe, and for `node.exe` next to it
# (or on PATH). So this package layout is:
#
#   pi-bot-windows/
#     pi_bot.exe
#     <flutter runtime dlls, data/>
#     node.exe                (only with -WithNode)
#     server/                 (src, package.json, tools)
#
# Packaging is staged: everything is assembled in a temporary folder first and
# only swapped into place after npm install + layout checks succeed. If anything
# fails, the previous dist package stays exactly as it was (same rule as
# pack-macos.sh -- a failed pack must never destroy the last good build).
#
# Keep this file ASCII-only: PowerShell 5.1 decodes BOM-less files as ANSI,
# and non-ASCII comments can break the parser.

param(
  [string]$Out = "dist/pi-bot-windows",
  [switch]$WithNode,
  [switch]$SkipDeps,
  [switch]$NoBuild,
  [switch]$Zip,
  [switch]$Help
)

$ErrorActionPreference = "Stop"

function Fail([string]$message) {
  Write-Host "ERROR: $message" -ForegroundColor Red
  exit 1
}

if ($Help) {
  Get-Content -Path $PSCommandPath | Select-Object -First 20
  exit 0
}

$root = Split-Path -Parent $PSScriptRoot
$release = Join-Path $root "app\build\windows\x64\runner\Release"
$outDir = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $root $Out }
$outParent = Split-Path -Parent $outDir
$outName = Split-Path -Leaf $outDir
$zipPath = "$outDir.zip"

# ---- preflight ------------------------------------------------------------

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Fail "node is not on PATH (Node 22+ is required to pack)" }
$nodeVersion = (& node --version).Trim()
$nodeMajor = 0
if ($nodeVersion -match '^v(\d+)') { $nodeMajor = [int]$Matches[1] }
if ($nodeMajor -lt 22) { Fail "Node 22+ is required, found $nodeVersion" }

$serverSrc = Join-Path $root "server"
foreach ($item in @("src", "tools", "package.json", ".env.example")) {
  if (-not (Test-Path (Join-Path $serverSrc $item))) {
    Fail "missing server file: server/$item"
  }
}
if (-not (Test-Path (Join-Path $serverSrc "src\index.js"))) {
  Fail "missing server entry: server/src/index.js"
}

$version = (& node -e "const p=require(process.argv[1]);process.stdout.write(String(p.version||''))" (Join-Path $serverSrc "package.json")).Trim()
if (-not $version) { Fail "cannot read version from server/package.json" }
Write-Host "server version: $version (node $nodeVersion)"

# ---- build ----------------------------------------------------------------

if (-not $NoBuild) {
  Write-Host "== flutter build windows --release =="
  Push-Location (Join-Path $root "app")
  try {
    & flutter build windows --release
    if ($LASTEXITCODE -ne 0) { throw "flutter build failed ($LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
}

$exePath = Join-Path $release "pi_bot.exe"
if (-not (Test-Path $exePath)) {
  Fail "no release build at $release (run without -NoBuild first)"
}

# ---- stage ----------------------------------------------------------------

New-Item -ItemType Directory -Path $outParent -Force | Out-Null
$suffix = [guid]::NewGuid().ToString("N").Substring(0, 8)
$stageDir = Join-Path $outParent ".pack-windows-$suffix"
$stageOut = Join-Path $stageDir $outName
$backupDir = Join-Path $outParent ".pack-windows-old-$suffix"
$previousMoved = $false
$stageReady = $false

try {
  Write-Host "== stage $stageOut =="
  New-Item -ItemType Directory -Path $stageOut -Force | Out-Null
  Copy-Item -Path (Join-Path $release "*") -Destination $stageOut -Recurse -Force

  $stageServer = Join-Path $stageOut "server"
  New-Item -ItemType Directory -Path $stageServer -Force | Out-Null
  foreach ($item in @("src", "tools", "package.json", "package-lock.json", ".env.example")) {
    $from = Join-Path $serverSrc $item
    if (Test-Path $from) {
      Copy-Item -Path $from -Destination $stageServer -Recurse -Force
    }
  }

  # node_modules is NOT copied from the dev tree: it may contain dev-only
  # packages and absolute build paths. It is installed fresh into the package
  # below (or left out with -SkipDeps, in which case the app runs npm install
  # on first start -- that needs npm on the target machine).
  if (-not $SkipDeps) {
    Write-Host "== install server deps into stage =="
    Push-Location $stageServer
    try {
      & npm install --omit=dev --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) { throw "npm install failed ($LASTEXITCODE)" }
    } finally {
      Pop-Location
    }
    if (-not (Test-Path (Join-Path $stageServer "node_modules"))) {
      throw "npm install reported success but node_modules is missing"
    }
  } else {
    Write-Host "note: -SkipDeps / no node_modules in package (first start will run npm install)"
  }

  if ($WithNode) {
    $nodeExe = (Get-Item $nodeCmd.Source).FullName
    Copy-Item $nodeExe (Join-Path $stageOut "node.exe") -Force
    Write-Host "bundled $nodeExe"
  } else {
    Write-Host "note: node.exe not bundled - target machine needs Node 22+ on PATH"
  }

  # layout checks: do not swap in a package we already know is broken
  foreach ($required in @("pi_bot.exe", "server\src\index.js", "server\package.json")) {
    if (-not (Test-Path (Join-Path $stageOut $required))) {
      throw "staged package is missing $required"
    }
  }

  if ($Zip) {
    $stageZip = Join-Path $stageDir "$outName.zip"
    Write-Host "== zip $stageZip =="
    Compress-Archive -Path (Join-Path $stageOut "*") -DestinationPath $stageZip -CompressionLevel Optimal
    if (-not (Test-Path $stageZip)) { throw "zip was not created" }
  }

  # ---- swap (old package is only touched after everything succeeded) ----

  if (Test-Path $outDir) {
    Move-Item -Path $outDir -Destination $backupDir -Force
    $previousMoved = $true
  }
  Move-Item -Path $stageOut -Destination $outDir -Force
  $stageReady = $true

  if ($Zip) {
    $stageZip = Join-Path $stageDir "$outName.zip"
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    Move-Item -Path $stageZip -Destination $zipPath -Force
  }

  if ($previousMoved) {
    Remove-Item -Path $backupDir -Recurse -Force -ErrorAction SilentlyContinue
  }
} catch {
  $message = $_.Exception.Message
  Write-Host "ERROR: $message" -ForegroundColor Red
  # roll back: put the previous package back exactly where it was
  try {
    if (-not $stageReady -and $previousMoved -and (Test-Path $backupDir)) {
      if (Test-Path $outDir) { Remove-Item -Path $outDir -Recurse -Force -ErrorAction SilentlyContinue }
      Move-Item -Path $backupDir -Destination $outDir -Force
      $previousMoved = $false
      Write-Host "previous package restored: $outDir"
    }
  } catch {
    Write-Host "WARNING: rollback failed; backup kept at $backupDir" -ForegroundColor Yellow
  }
  exit 1
} finally {
  if (Test-Path $stageDir) {
    Remove-Item -Path $stageDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($previousMoved -and (Test-Path $backupDir)) {
    Write-Host "note: previous package kept at $backupDir" -ForegroundColor Yellow
  }
}

if ($Zip) {
  Write-Host "zip: $zipPath"
}
Write-Host "done: $outDir"
