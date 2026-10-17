# Build a self-contained Windows folder (and optionally a zip).
#
#   .\scripts\pack-windows.ps1                 # dist/pi-bot-windows
#   .\scripts\pack-windows.ps1 -Zip            # + dist/pi-bot-windows.zip
#   .\scripts\pack-windows.ps1 -WithNode -Zip  # bundle node.exe (needs no Node on target)
#   .\scripts\pack-windows.ps1 -NoBuild        # reuse the existing Release build
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
# Keep this file ASCII-only: PowerShell 5.1 decodes BOM-less files as ANSI,
# and non-ASCII comments can break the parser.

param(
  [string]$Out = "dist/pi-bot-windows",
  [switch]$WithNode,
  [switch]$SkipDeps,
  [switch]$NoBuild,
  [switch]$Zip
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$release = Join-Path $root "app\build\windows\x64\runner\Release"
$outDir = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $root $Out }

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

if (-not (Test-Path (Join-Path $release "pi_bot.exe"))) {
  throw "no release build at $release (run without -NoBuild first)"
}

Write-Host "== assemble $outDir =="
if (Test-Path $outDir) { Remove-Item -Recurse -Force $outDir }
New-Item -ItemType Directory -Path $outDir | Out-Null
Copy-Item -Path (Join-Path $release "*") -Destination $outDir -Recurse -Force

$serverSrc = Join-Path $root "server"
$serverDst = Join-Path $outDir "server"
New-Item -ItemType Directory -Path $serverDst | Out-Null
foreach ($item in @("src", "tools", "package.json", "package-lock.json", ".env.example")) {
  $from = Join-Path $serverSrc $item
  if (Test-Path $from) { Copy-Item -Path $from -Destination $serverDst -Recurse -Force }
}

# node_modules is NOT copied: the app runs `npm install` on first start when
# it is missing (that keeps the package small and always matches package.json).

# Server dependencies are installed INTO the package by default, so the
# target machine never needs npm (the app can still do it at runtime when
# node_modules is missing, but that requires npm to be present).
if (-not $SkipDeps) {
  Write-Host "== install server deps into package =="
  Push-Location $serverDst
  try {
    & npm install --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install failed ($LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
} else {
  Write-Host "note: -SkipDeps / no node_modules in package (first start will run npm install)"
}

if ($WithNode) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) { throw "-WithNode but node is not on PATH" }
  $nodeExe = (Get-Item $nodeCmd.Source).FullName
  Copy-Item $nodeExe (Join-Path $outDir "node.exe") -Force
  Write-Host "bundled $nodeExe"
} else {
  Write-Host "note: node.exe not bundled - target machine needs Node 22+ on PATH"
}

$zipPath = "$outDir.zip"
if ($Zip) {
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
  Compress-Archive -Path (Join-Path $outDir "*") -DestinationPath $zipPath -CompressionLevel Optimal
  Write-Host "zip: $zipPath"
}

Write-Host "done: $outDir"
