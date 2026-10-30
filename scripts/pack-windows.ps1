# Build a self-contained Windows folder (and optionally a zip).
#
#   .\scripts\pack-windows.ps1                 # dist/pi-bot-windows
#   .\scripts\pack-windows.ps1 -Zip            # + dist/pi-bot-windows.zip
#   .\scripts\pack-windows.ps1 -WithNode -Zip  # bundle node.exe
#   .\scripts\pack-windows.ps1 -NoBuild        # reuse the existing Release build
#   .\scripts\pack-windows.ps1 -SkipDeps       # do not preinstall server deps
#   .\scripts\pack-windows.ps1 -BuildRoot E:\builds  # pick the neutral build root
#   .\scripts\pack-windows.ps1 -Help           # this text
#
# The build copies app sources into a neutral build root, excluding caches and user
# project state, enforces pubspec.lock, then builds with --no-pub. Output is copied
# back to the Release folder. The build root defaults to .pi-bot-build at the root
# of the checkout's drive; -BuildRoot overrides it. It must be an absolute path
# outside the user profile and outside the checkout. Each run builds in its own
# marked folder, holds a lock on the build root, and removes only that folder.
# The build needs nuget.exe on PATH; this script never downloads it.
# -NoBuild skips Flutter. Packaging does not need Git and does not edit sources.
#
# The staged package is rejected when it still contains local absolute paths,
# .pdb files, or local state (.pi, _inbox, server/.env, logs). Server native
# dependencies are scanned and not rewritten. A failed pack keeps the last dist.
#
# Keep this file ASCII-only. PowerShell 5.1 decodes BOM-less scripts as ANSI.

param(
  [string]$Out = "dist/pi-bot-windows",
  [switch]$WithNode,
  [switch]$SkipDeps,
  [switch]$NoBuild,
  [switch]$Zip,
  [string]$BuildRoot = "",
  [switch]$Help
)

$ErrorActionPreference = "Stop"

function Fail([string]$message) {
  Write-Host "ERROR: $message" -ForegroundColor Red
  exit 1
}

function Join-Under([string]$Base, [string[]]$Child) {
  $result = $Base
  foreach ($part in $Child) {
    $result = Join-Path -Path $result -ChildPath $part
  }
  return $result
}

function Remove-Tree([string]$Path) {
  if ($Path -and (Test-Path -LiteralPath $Path)) {
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Get-FullPath([string]$Path) {
  $resolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
  return [System.IO.Path]::GetFullPath($resolved)
}

function Test-PathUnder([string]$Child, [string]$Parent) {
  if (-not $Child -or -not $Parent) { return $false }
  $sep = [string][System.IO.Path]::DirectorySeparatorChar
  $c = $Child.TrimEnd('\', '/') + $sep
  $p = $Parent.TrimEnd('\', '/') + $sep
  $mode = [System.StringComparison]::Ordinal
  if ($env:OS -eq "Windows_NT") { $mode = [System.StringComparison]::OrdinalIgnoreCase }
  return $c.StartsWith($p, $mode)
}

$BuildMarkerName = ".pi-bot-build-run"

# Delete a build folder only when it carries this run's marker.
function Remove-BuildRun([string]$Path, [string]$RunId) {
  if (-not $Path -or -not $RunId -or -not (Test-Path -LiteralPath $Path)) { return }
  $marker = Join-Path $Path $BuildMarkerName
  $owned = $false
  if (Test-Path -LiteralPath $marker -PathType Leaf) {
    $owned = (([System.IO.File]::ReadAllText($marker)).Trim() -eq $RunId)
  }
  if (-not $owned) {
    Write-Host "WARNING: build folder has no matching marker; it was kept" -ForegroundColor Yellow
    return
  }
  Remove-Tree $Path
}

function Publish-DebugInfo([string]$DebugDir, [string]$Built, [string]$Destination) {
  $parent = Split-Path -Parent $Destination
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  $suffix = [guid]::NewGuid().ToString("N").Substring(0, 8)
  $staging = Join-Path $parent (".debug-info-new-" + $suffix)
  $backup = Join-Path $parent (".debug-info-old-" + $suffix)
  Copy-Item -LiteralPath $DebugDir -Destination $staging -Recurse -Force
  $prefix = $Built.TrimEnd('\', '/')
  $pdbs = @(Get-ChildItem -LiteralPath $Built -Recurse -Filter *.pdb -File -ErrorAction SilentlyContinue)
  foreach ($pdb in $pdbs) {
    $rel = $pdb.Name
    if ($pdb.FullName.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      $rel = $pdb.FullName.Substring($prefix.Length).TrimStart('\', '/')
    }
    $dest = Join-Path $staging "pdb"
    foreach ($part in ($rel -split '[\\/]')) {
      if ($part) { $dest = Join-Path $dest $part }
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null
    Copy-Item -LiteralPath $pdb.FullName -Destination $dest -Force
  }
  $moved = $false
  try {
    if (Test-Path -LiteralPath $Destination) {
      Move-Item -LiteralPath $Destination -Destination $backup -Force
      $moved = $true
    }
    Move-Item -LiteralPath $staging -Destination $Destination -Force
  } catch {
    if ($moved -and -not (Test-Path -LiteralPath $Destination) -and (Test-Path -LiteralPath $backup)) {
      Move-Item -LiteralPath $backup -Destination $Destination -Force
      $moved = $false
    }
    throw
  } finally {
    if ($moved) { Remove-Tree $backup }
    Remove-Tree $staging
  }
}

function Publish-ReleaseTree([string]$Built, [string]$Destination) {
  $parent = Split-Path -Parent $Destination
  if (-not $parent) { throw "release path has no parent" }
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  $swap = Join-Path $parent (".pack-build-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
  $next = Join-Path $swap "next"
  $previous = Join-Path $swap "previous"
  New-Item -ItemType Directory -Path $next -Force | Out-Null
  Copy-Item -Path (Join-Path $Built "*") -Destination $next -Recurse -Force
  if (-not (Test-Path -LiteralPath (Join-Path $next "pi_bot.exe"))) {
    Remove-Tree $swap
    throw "copied release is missing pi_bot.exe"
  }
  $moved = $false
  $published = $false
  $keep = $false
  try {
    if (Test-Path -LiteralPath $Destination) {
      Move-Item -LiteralPath $Destination -Destination $previous -Force
      $moved = $true
    }
    Move-Item -LiteralPath $next -Destination $Destination -Force
    $published = $true
  } catch {
    try {
      if (-not $published -and $moved) {
        if (Test-Path -LiteralPath $Destination) {
          Remove-Item -LiteralPath $Destination -Recurse -Force -ErrorAction SilentlyContinue
        }
        if ((Test-Path -LiteralPath $previous) -and -not (Test-Path -LiteralPath $Destination)) {
          Move-Item -LiteralPath $previous -Destination $Destination -Force
          $moved = $false
        }
      }
    } catch {
      $keep = $true
      Write-Host "WARNING: release rollback failed; backup kept" -ForegroundColor Yellow
    }
    throw
  } finally {
    if (-not $keep) { Remove-Tree $swap }
  }
}

if ($args.Count -gt 0) { Fail "unknown parameter" }

if ($Help) {
  foreach ($line in (Get-Content -Path $PSCommandPath)) {
    if (-not $line.StartsWith("#")) { break }
    Write-Output $line
  }
  exit 0
}

$root = Split-Path -Parent $PSScriptRoot
$release = Join-Under $root @("app", "build", "windows", "x64", "runner", "Release")
$outDir = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $root $Out }
$outParent = Split-Path -Parent $outDir
$outName = Split-Path -Leaf $outDir
$zipPath = "$outDir.zip"
$stageScript = Join-Path $PSScriptRoot "stage-app-build.mjs"
$buildBase = $null
if (-not $NoBuild) {
  if ($BuildRoot) {
    $absolute = $false
    if ($env:OS -eq "Windows_NT") { $absolute = ($BuildRoot -match '^[A-Za-z]:[\\/]' -or $BuildRoot -match '^[\\/]{2}[^\\/]') }
    else { $absolute = $BuildRoot.StartsWith("/") }
    if (-not $absolute) { Fail "-BuildRoot must be an absolute path" }
    $buildBase = Get-FullPath $BuildRoot
  } else {
    $qualifier = ""
    try { $qualifier = Split-Path -Qualifier $root -ErrorAction Stop } catch { $qualifier = "" }
    if ($qualifier) {
      $buildBase = $qualifier + [System.IO.Path]::DirectorySeparatorChar + ".pi-bot-build"
    } else {
      $buildBase = Join-Path ([System.IO.Path]::GetTempPath()) ".pi-bot-build"
    }
  }
  $profileDir = $env:USERPROFILE
  if (-not $profileDir) { $profileDir = $HOME }
  if ($profileDir -and (Test-PathUnder $buildBase (Get-FullPath $profileDir))) {
    Fail "build root must be outside the user profile (pass -BuildRoot)"
  }
  if (Test-PathUnder $buildBase (Get-FullPath $root)) {
    Fail "build root must be outside the source checkout (pass -BuildRoot)"
  }
}
$prepareScript = Join-Path $PSScriptRoot "prepare-windows-bundle.mjs"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Fail "node is not on PATH (Node 22+ is required to pack)" }
$nodeVersion = (& node --version).Trim()
$nodeMajor = 0
if ($nodeVersion -match '^v(\d+)') { $nodeMajor = [int]$Matches[1] }
if ($nodeMajor -lt 22) { Fail "Node 22+ is required, found $nodeVersion" }

$serverSrc = Join-Path $root "server"
foreach ($item in @("src", "tools", "package.json", ".env.example")) {
  if (-not (Test-Path -LiteralPath (Join-Path $serverSrc $item))) {
    Fail "missing server file: server/$item"
  }
}
if (-not (Test-Path -LiteralPath (Join-Under $serverSrc @("src", "index.js")))) {
  Fail "missing server entry: server/src/index.js"
}

$version = (& node -e "const p=require(process.argv[1]);process.stdout.write(String(p.version||''))" (Join-Path $serverSrc "package.json")).Trim()
if (-not $version) { Fail "cannot read version from server/package.json" }
Write-Host "server version: $version (node $nodeVersion)"

$buildWork = $null
$runId = $null
$buildLock = $null
$lockPath = $null
$createdBase = $false
$stageDir = $null
$backupDir = $null
$backupZip = $null
$previousMoved = $false
$zipMoved = $false
$stageReady = $false

try {
  if (-not $NoBuild) {
    if (-not (Get-Command flutter -ErrorAction SilentlyContinue)) { throw "flutter is not on PATH" }
    # Some Windows plugins fetch nuget.exe from the network when it is missing.
    # Require a preinstalled copy instead of letting the build download one.
    $nugetName = "nuget"
    if ($env:OS -eq "Windows_NT") { $nugetName = "nuget.exe" }
    if (-not (Get-Command $nugetName -CommandType Application -ErrorAction SilentlyContinue)) {
      throw "nuget.exe is not on PATH; install the NuGet CLI yourself (see docs/WINDOWS.md). This script never downloads it"
    }
    try {
      if (-not (Test-Path -LiteralPath $buildBase)) {
        New-Item -ItemType Directory -Path $buildBase -Force | Out-Null
        $createdBase = $true
      }
      $lockPath = Join-Path $buildBase ".pack-windows.lock"
      try {
        $buildLock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
      } catch {
        throw "build root is busy: another pack holds its lock"
      }
      $newId = [guid]::NewGuid().ToString("N")
      $runDir = Join-Path $buildBase ("pi-bot-windows-build-" + $newId.Substring(0, 8))
      if (Test-Path -LiteralPath $runDir) { throw "build folder name collision; retry" }
      New-Item -ItemType Directory -Path $runDir | Out-Null
      $buildWork = $runDir
      $runId = $newId
      [System.IO.File]::WriteAllText((Join-Path $buildWork $BuildMarkerName), $runId)
      $appSource = Join-Under $root @("app")
      $appCopy = Join-Under $buildWork @("app")
      $sourceLock = Join-Path $appSource "pubspec.lock"
      if (-not (Test-Path -LiteralPath $sourceLock -PathType Leaf)) { throw "missing app/pubspec.lock" }
      $lockHash = (Get-FileHash -LiteralPath $sourceLock -Algorithm SHA256).Hash
      Write-Host "== stage app source outside the checkout =="
      & node $stageScript $appSource $appCopy --require pubspec.yaml --require pubspec.lock --require lib/main.dart --require windows/CMakeLists.txt
      if ($LASTEXITCODE -ne 0) { throw "staging app source failed ($LASTEXITCODE)" }

      $debugDir = Join-Under $buildWork @("debug-info")
      $copyLock = Join-Path $appCopy "pubspec.lock"
      $previousPubHostedUrl = $env:PUB_HOSTED_URL
      Push-Location $appCopy
      try {
        $env:PUB_HOSTED_URL = "https://pub.dev"
        Write-Host "== flutter pub get --enforce-lockfile =="
        & flutter pub get --enforce-lockfile --no-example
        if ($LASTEXITCODE -ne 0) { throw "locked dependency resolution failed ($LASTEXITCODE)" }
        if ((Get-FileHash -LiteralPath $copyLock -Algorithm SHA256).Hash -ne $lockHash) { throw "dependency resolution changed pubspec.lock" }
        Write-Host "== flutter build windows --release =="
        & flutter build windows --release --no-pub "--split-debug-info=$debugDir"
        if ($LASTEXITCODE -ne 0) { throw "flutter build failed ($LASTEXITCODE)" }
        if ((Get-FileHash -LiteralPath $copyLock -Algorithm SHA256).Hash -ne $lockHash) { throw "build changed pubspec.lock" }
      } finally {
        $env:PUB_HOSTED_URL = $previousPubHostedUrl
        Pop-Location
      }

      $built = Join-Under $buildWork @("app", "build", "windows", "x64", "runner", "Release")
      if (-not (Test-Path -LiteralPath (Join-Path $built "pi_bot.exe"))) {
        throw "neutral build did not produce pi_bot.exe"
      }
      if (-not (Test-Path -LiteralPath $debugDir)) { throw "flutter did not write split debug info" }
      Publish-DebugInfo $debugDir $built (Join-Under $root @("app", "build", "debug-info", "windows"))
      Publish-ReleaseTree $built $release
    } finally {
      Remove-BuildRun $buildWork $runId
      if ($buildLock) {
        $buildLock.Dispose()
        $buildLock = $null
        Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
      }
      if ($createdBase -and (Test-Path -LiteralPath $buildBase)) {
        if (@(Get-ChildItem -LiteralPath $buildBase -Force).Count -eq 0) {
          Remove-Item -LiteralPath $buildBase -Force -ErrorAction SilentlyContinue
        }
      }
    }
  }

  $exePath = Join-Path $release "pi_bot.exe"
  if (-not (Test-Path -LiteralPath $exePath)) {
    throw "no release build (run without -NoBuild first)"
  }

  New-Item -ItemType Directory -Path $outParent -Force | Out-Null
  $suffix = [guid]::NewGuid().ToString("N").Substring(0, 8)
  $stageDir = Join-Path $outParent (".pack-windows-" + $suffix)
  $stageOut = Join-Path $stageDir $outName
  $backupDir = Join-Path $outParent (".pack-windows-old-" + $suffix)
  $backupZip = Join-Path $outParent (".pack-windows-old-" + $suffix + ".zip")

  Write-Host "== stage package =="
  New-Item -ItemType Directory -Path $stageOut -Force | Out-Null
  Copy-Item -Path (Join-Path $release "*") -Destination $stageOut -Recurse -Force

  foreach ($junk in @(".pi", "_inbox", "server", "logs")) {
    Remove-Tree (Join-Path $stageOut $junk)
  }
  Get-ChildItem -LiteralPath $stageOut -Filter "*.log" -File -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue

  $stageServer = Join-Path $stageOut "server"
  New-Item -ItemType Directory -Path $stageServer -Force | Out-Null
  foreach ($item in @("src", "tools", "package.json", "package-lock.json", ".env.example")) {
    $from = Join-Path $serverSrc $item
    if (Test-Path -LiteralPath $from) {
      Copy-Item -LiteralPath $from -Destination $stageServer -Recurse -Force
    }
  }

  if (-not $SkipDeps) {
    Write-Host "== install server deps into stage =="
    Push-Location $stageServer
    try {
      & npm install --omit=dev --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) { throw "npm install failed ($LASTEXITCODE)" }
    } finally {
      Pop-Location
    }
    if (-not (Test-Path -LiteralPath (Join-Path $stageServer "node_modules"))) {
      throw "npm install reported success but node_modules is missing"
    }
  } else {
    Write-Host "note: -SkipDeps / no node_modules in package (first start will run npm install)"
  }

  if ($WithNode) {
    $nodeExe = (Get-Item $nodeCmd.Source).FullName
    Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $stageOut "node.exe") -Force
    Write-Host "bundled node.exe"
  } else {
    Write-Host "note: node.exe not bundled - target machine needs Node 22+ on PATH"
  }

  $requiredSets = @(
    , @("pi_bot.exe")
    , @("server", "src", "index.js")
    , @("server", "package.json")
  )
  foreach ($required in $requiredSets) {
    $requiredPath = $stageOut
    foreach ($part in $required) { $requiredPath = Join-Path $requiredPath $part }
    if (-not (Test-Path -LiteralPath $requiredPath)) {
      throw "staged package is missing $($required -join '/')"
    }
  }

  Write-Host "== scan staged package =="
  $prepareArgs = @($prepareScript)
  if ($SkipDeps) { $prepareArgs += "--skip-deps" }
  $prepareArgs += $stageOut
  foreach ($marker in @($root, (Join-Under $root @("app")), $release, $buildWork)) {
    if ($marker) { $prepareArgs += @("--marker", $marker) }
  }
  & node @prepareArgs
  if ($LASTEXITCODE -ne 0) { throw "release scan failed ($LASTEXITCODE)" }

  if ($Zip) {
    $stageZip = Join-Path $stageDir ($outName + ".zip")
    Write-Host "== zip package =="
    Compress-Archive -Path (Join-Path $stageOut "*") -DestinationPath $stageZip -CompressionLevel Optimal
    if (-not (Test-Path -LiteralPath $stageZip)) { throw "zip was not created" }
  }

  if (Test-Path -LiteralPath $outDir) {
    Move-Item -LiteralPath $outDir -Destination $backupDir -Force
    $previousMoved = $true
  }
  if ($Zip -and (Test-Path -LiteralPath $zipPath)) {
    Move-Item -LiteralPath $zipPath -Destination $backupZip -Force
    $zipMoved = $true
  }
  Move-Item -LiteralPath $stageOut -Destination $outDir -Force
  if ($Zip) {
    Move-Item -LiteralPath (Join-Path $stageDir ($outName + ".zip")) -Destination $zipPath -Force
  }
  $stageReady = $true

  if ($previousMoved) { Remove-Tree $backupDir; $previousMoved = $false }
  if ($zipMoved) { Remove-Tree $backupZip; $zipMoved = $false }
} catch {
  $message = $_.Exception.Message
  if (-not $message) { $message = "$_" }
  Write-Host "ERROR: $message" -ForegroundColor Red
  try {
    if (-not $stageReady) {
      if ($previousMoved -and (Test-Path -LiteralPath $backupDir)) {
        if (Test-Path -LiteralPath $outDir) { Remove-Item -LiteralPath $outDir -Recurse -Force -ErrorAction SilentlyContinue }
        if (-not (Test-Path -LiteralPath $outDir)) {
          Move-Item -LiteralPath $backupDir -Destination $outDir -Force
          $previousMoved = $false
          Write-Host "previous package restored"
        }
      }
      if ($zipMoved -and (Test-Path -LiteralPath $backupZip)) {
        if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue }
        if (-not (Test-Path -LiteralPath $zipPath)) {
          Move-Item -LiteralPath $backupZip -Destination $zipPath -Force
          $zipMoved = $false
          Write-Host "previous zip restored"
        }
      }
    }
  } catch {
    Write-Host "WARNING: rollback failed; backup kept" -ForegroundColor Yellow
  }
  exit 1
} finally {
  Remove-BuildRun $buildWork $runId
  if ($buildLock) { $buildLock.Dispose() }
  Remove-Tree $stageDir
  if ($previousMoved -and $backupDir -and (Test-Path -LiteralPath $backupDir)) {
    Write-Host "note: previous package kept" -ForegroundColor Yellow
  }
  if ($zipMoved -and $backupZip -and (Test-Path -LiteralPath $backupZip)) {
    Write-Host "note: previous zip kept" -ForegroundColor Yellow
  }
}

if ($Zip) { Write-Host "zip: ready" }
Write-Host "done"
