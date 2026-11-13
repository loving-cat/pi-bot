# Build and install the Windows sandbox launcher (native/pibot-sandbox).
#
# Why a separate script: pack-windows.ps1 stays pure ASCII, offline, and
# toolchain-free. Compiling Rust needs cargo + MSVC build tools. Keeping the
# two apart means the pack machine does not need Rust -- the launcher can be
# built (and signed) ahead of time and shipped alongside the repo/release.
#
# Usage:
#   .\scripts\build-sandbox-win.ps1                    # build into server/resources/
#   .\scripts\build-sandbox-win.ps1 -Check             # only verify toolchain + artifact
#   .\scripts\build-sandbox-win.ps1 -Out D:\somewhere  # custom output dir

param(
  [string]$Out = "",
  [switch]$Check,
  [switch]$Help
)

$ErrorActionPreference = "Stop"

function Fail([string]$message) {
  Write-Host "ERROR: $message" -ForegroundColor Red
  exit 1
}

if ($Help) {
  Write-Host "build-sandbox-win.ps1 [-Out <dir>] [-Check]"
  Write-Host ""
  Write-Host "  -Out    output directory (default: server/resources)"
  Write-Host "  -Check  verify toolchain and existing artifact only, do not build"
  exit 0
}
if ($args.Count -gt 0) { Fail "unknown parameter" }

$root = Split-Path -Parent $PSScriptRoot
$crate = Join-Path $root "native\pibot-sandbox"
$cargoToml = Join-Path $crate "Cargo.toml"
if (-not (Test-Path -LiteralPath $cargoToml)) { Fail "missing native/pibot-sandbox/Cargo.toml" }

if (-not $Out) { $Out = Join-Path $root "server\resources" }
$exe = Join-Path $Out "pibot-sandbox.exe"
$sha = Join-Path $Out "pibot-sandbox.sha256"

function Get-ExpectedVersion {
  $line = Select-String -LiteralPath $cargoToml -Pattern '^version\s*=\s*"([^"]+)"' | Select-Object -First 1
  if (-not $line) { Fail "cannot read version from Cargo.toml" }
  return $line.Matches[0].Groups[1].Value
}
$version = Get-ExpectedVersion
Write-Host "launcher version: $version"

if ($Check) {
  if (-not (Test-Path -LiteralPath $exe)) { Fail "launcher not built: $exe" }
  $reported = (& $exe version 2>&1) -join " "
  Write-Host "reported: $reported"
  if ($reported -notmatch [regex]::Escape($version)) { Fail "version mismatch" }
  $want = (Get-Content -LiteralPath $sha -Raw -ErrorAction SilentlyContinue)
  if ($want) {
    $got = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLower()
    if ($got -ne $want.Trim().ToLower().Split(" ")[0]) { Fail "sha256 mismatch" }
    Write-Host "sha256 ok"
  }
  Write-Host "OK"
  exit 0
}

$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargo) { Fail "cargo is not on PATH; install Rust (winget install Rustlang.Rustup) and reopen the shell" }

# rustup installs the msvc toolchain, which needs the MSVC linker. Failing
# here is friendlier than failing halfway through with "linker not found".
$linkers = @(
  "C:\Program Files\Microsoft Visual Studio\2022\*\VC\Tools\MSVC\*\bin\Hostx64\x64\link.exe",
  "C:\Program Files (x86)\Microsoft Visual Studio\2022\*\VC\Tools\MSVC\*\bin\Hostx64\x64\link.exe"
)
$hasLinker = $false
foreach ($pattern in $linkers) {
  if (Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue) { $hasLinker = $true; break }
}
if (-not $hasLinker) {
  Fail "MSVC link.exe not found; install Visual Studio 2022 Build Tools with the C++ desktop workload"
}

Push-Location $crate
try {
  Write-Host "== cargo build --release =="
  & cargo build --release
  if ($LASTEXITCODE -ne 0) { throw "cargo build failed ($LASTEXITCODE)" }
  Write-Host "== version self check =="
  $reported = (& (Join-Path $crate "target\release\pibot-sandbox.exe") version 2>&1) -join " "
  if ($reported -notmatch [regex]::Escape($version)) { throw "version mismatch: $reported" }
  # Keep the Node side in sync: it refuses to use a launcher whose version
  # differs from LAUNCHER_VERSION.
  & node (Join-Path $root "server\tools\check-launcher-version.mjs") (Join-Path $crate "target\release\pibot-sandbox.exe")
  if ($LASTEXITCODE -ne 0) { throw "launcher version does not match server/src/sandbox-win.js" }
} finally {
  Pop-Location
}

New-Item -ItemType Directory -Path $Out -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $crate "target\release\pibot-sandbox.exe") -Destination $exe -Force
$hash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLower()
# Manifest format matches `sha256sum`: <hash>  <name>
Set-Content -LiteralPath $sha -Value "$hash  pibot-sandbox.exe" -Encoding ASCII -NoNewline

Write-Host "wrote $exe"
Write-Host "wrote $sha ($hash)"
