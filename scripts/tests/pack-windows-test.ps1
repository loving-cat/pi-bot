# Branch coverage for scripts/pack-windows.ps1 using a fixture repo and command stubs.
# This does not run flutter build windows and does not prove a real Release package.
# The file is ASCII-only so Windows PowerShell 5.1 can parse it.

$ErrorActionPreference = "Stop"
# pwsh 7 can turn a native non-zero exit into a terminating error. Expected pack
# failures are checked with $LASTEXITCODE instead.
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("pi-bot-pack-win-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
$fixture = Join-Path $testRoot "repo"
$stubs = Join-Path $testRoot "stubs"
$trace = Join-Path $testRoot "trace.txt"
$log = Join-Path $testRoot "run.log"
$nugetDir = Join-Path $testRoot "nuget"
$customRoot = $null
$pass = 0

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Read-Norm([string]$Path) {
  $text = [System.IO.File]::ReadAllText($Path)
  if (-not $text) { return "" }
  return (($text -replace "`r`n", "`n").TrimEnd("`n"))
}

function Read-Trace {
  if (-not (Test-Path -LiteralPath $trace)) { return "" }
  $text = Get-Content -LiteralPath $trace -Raw
  if (-not $text) { return "" }
  return $text
}

function Read-Log {
  if (Test-Path -LiteralPath $log) { return (Get-Content -LiteralPath $log -Raw) }
  return ""
}

function Reset-Trace {
  Set-Content -LiteralPath $trace -Value "" -Encoding Ascii
}

function Assert-RealFailure([object]$Code, [string]$Name) {
  Assert-True (($null -ne $Code) -and ($Code -ne 0)) "$Name did not exit non-zero"
}

function Assert-LogHidesHome([string]$Name) {
  $text = Read-Log
  $homeDir = $script:UserHome
  if (-not $homeDir) { return }
  $variants = @($homeDir)
  if ($homeDir.Contains('\')) {
    $variants += $homeDir.Replace('\', '/')
    $variants += $homeDir.Replace('\', '\\')
  }
  foreach ($variant in $variants) {
    if ($variant -and $text.Contains($variant)) { throw "$Name log included the user directory" }
  }
}

function Assert-ErrorText([object]$Code, [string]$Fragment, [string]$Name) {
  Assert-RealFailure $Code $Name
  Assert-True ((Read-Log).Contains($Fragment)) "$Name missing error text"
  Assert-LogHidesHome $Name
}

$shell = "powershell"
if ($env:OS -ne "Windows_NT") { $shell = "pwsh" }

try {
  New-Item -ItemType Directory -Path $stubs -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $fixture "scripts") -Force | Out-Null
  foreach ($name in @("pack-windows.ps1", "stage-app-build.mjs", "prepare-windows-bundle.mjs", "scan-release-tree.mjs")) {
    Copy-Item -LiteralPath (Join-Path $repo (Join-Path "scripts" $name)) -Destination (Join-Path $fixture "scripts") -Force
  }
  $script = Join-Path $fixture "scripts\pack-windows.ps1"

  $app = Join-Path $fixture "app"
  foreach ($rel in @(
    "pubspec.yaml",
    "pubspec.lock",
    "lib\main.dart",
    "windows\CMakeLists.txt",
    "windows\runner\main.cpp",
    ".dart_tool\marker",
    "build\marker",
    ".vs\marker",
    "windows\flutter\ephemeral\marker",
    "windows\runner\Runner.vcxproj.user"
  )) {
    $dest = $app
    foreach ($part in ($rel -split '\\')) { $dest = Join-Path $dest $part }
    New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null
    if ($rel -eq "pubspec.yaml") { Set-Content -LiteralPath $dest -Value "name: fixture`n" -Encoding Ascii }
    elseif ($rel -eq "lib\main.dart") { Set-Content -LiteralPath $dest -Value "void main() {}`n" -Encoding Ascii }
    elseif ($rel -eq "windows\CMakeLists.txt") { Set-Content -LiteralPath $dest -Value "project(fixture)`n" -Encoding Ascii }
    elseif ($rel -eq ".dart_tool\marker") { Set-Content -LiteralPath $dest -Value "keep-cache`n" -Encoding Ascii }
    else { Set-Content -LiteralPath $dest -Value "fixture`n" -Encoding Ascii }
  }
  $sourceMain = Join-Path $app "lib\main.dart"
  $sourcePubspec = Join-Path $app "pubspec.yaml"
  $sourceLock = Join-Path $app "pubspec.lock"
  $mainBefore = Get-Content -LiteralPath $sourceMain -Raw
  $pubspecBefore = Get-Content -LiteralPath $sourcePubspec -Raw
  $lockBefore = Get-Content -LiteralPath $sourceLock -Raw

  $server = Join-Path $fixture "server"
  New-Item -ItemType Directory -Path (Join-Path $server "src") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $server "tools") -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $server "package.json") -Value '{"name":"fixture","version":"0.1.0","dependencies":{}}' -Encoding Ascii
  Set-Content -LiteralPath (Join-Path $server "package-lock.json") -Value '{"lockfileVersion":3}' -Encoding Ascii
  Set-Content -LiteralPath (Join-Path $server "src\index.js") -Value "fixture server version one`n" -Encoding Ascii
  Set-Content -LiteralPath (Join-Path $server "tools\check.mjs") -Value "fixture tool`n" -Encoding Ascii
  Set-Content -LiteralPath (Join-Path $server ".env.example") -Value "FIXTURE=1`n" -Encoding Ascii
  Set-Content -LiteralPath (Join-Path $server ".env") -Value "TOKEN=fixture`n" -Encoding Ascii
  $packageBefore = Get-Content -LiteralPath (Join-Path $server "package.json") -Raw

  $release = Join-Path $app "build\windows\x64\runner\Release"
  New-Item -ItemType Directory -Path $release -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $release "pi_bot.exe") -Value "old exe`n" -Encoding Ascii
  Set-Content -LiteralPath (Join-Path $release "pi_bot.pdb") -Value "old pdb`n" -Encoding Ascii
  Set-Content -LiteralPath (Join-Path $release "sentinel.txt") -Value "old release`n" -Encoding Ascii

  New-Item -ItemType Directory -Path (Join-Path $fixture "dist") -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $fixture "dist\keep.txt") -Value "preserve this file`n" -Encoding Ascii
  Set-Content -LiteralPath (Join-Path $fixture "dist\pi-bot-windows.zip") -Value "old zip`n" -Encoding Ascii

  @'
const fs = require("fs");
const path = require("path");
const trace = process.env.TRACE;
fs.appendFileSync(trace, process.cwd() + "\n" + process.argv.slice(2).join(" ") + "\n---\n");
const fail = process.env.PACK_FAIL || "";
if (process.cwd() === process.env.FIXTURE_APP) process.exit(3);
if (process.env.PUB_HOSTED_URL !== "https://pub.dev" || !fs.existsSync("pubspec.lock")) process.exit(7);
if (process.argv[2] === "pub") {
  if (process.argv.slice(2).join(" ") !== "pub get --enforce-lockfile --no-example") process.exit(8);
  for (const cache of [".dart_tool", "build", ".vs", "windows/flutter/ephemeral", "windows/runner/Runner.vcxproj.user"]) {
    if (fs.existsSync(cache)) process.exit(4);
  }
  fs.mkdirSync(".dart_tool");
  fs.writeFileSync(".dart_tool/lock-ready", "locked\n");
  process.exit(0);
}
if (fail === "build") process.exit(39);
if (process.argv[2] !== "build" || process.argv[3] !== "windows" || !process.argv.includes("--no-pub")) process.exit(2);
if (!fs.existsSync(".dart_tool/lock-ready")) process.exit(9);
if (!fs.existsSync("lib/main.dart") || !fs.existsSync("windows/CMakeLists.txt") || !fs.existsSync("pubspec.yaml")) process.exit(5);
fs.appendFileSync("pubspec.yaml", "# stub\n");
let debug = "";
for (const arg of process.argv) {
  if (arg.startsWith("--split-debug-info=")) debug = arg.slice("--split-debug-info=".length);
}
if (!debug || !debug.startsWith(path.dirname(process.cwd()))) process.exit(6);
if (fail === "no-exe") process.exit(0);
const release = path.join("build", "windows", "x64", "runner", "Release");
fs.mkdirSync(path.join(release, "data"), { recursive: true });
fs.writeFileSync(path.join(release, "pi_bot.exe"), "fixture exe\n");
fs.writeFileSync(path.join(release, "pi_bot.pdb"), "fixture pdb\n");
fs.writeFileSync(path.join(release, "data", "ok.txt"), "ok\n");
if (fail === "no-debug") process.exit(0);
fs.mkdirSync(debug, { recursive: true });
fs.writeFileSync(path.join(debug, "app.symbols"), "fixture symbols\n");
'@ | Set-Content -LiteralPath (Join-Path $stubs "flutter-stub.cjs") -Encoding Ascii

  @'
const fs = require("fs");
if (process.env.PACK_FAIL === "npm") process.exit(31);
if (process.argv.slice(2).join(" ") !== "install --omit=dev --no-audit --no-fund") process.exit(2);
fs.mkdirSync("node_modules", { recursive: true });
fs.writeFileSync("node_modules/installed.txt", "1\n");
if (process.env.PACK_PLANT === "dotenv") fs.writeFileSync(".env", "TOKEN=fixture\n");
'@ | Set-Content -LiteralPath (Join-Path $stubs "npm-stub.cjs") -Encoding Ascii

  if ($env:OS -eq "Windows_NT") {
    "@echo off`r`nnode `"%~dp0flutter-stub.cjs`" %*`r`n" | Set-Content -LiteralPath (Join-Path $stubs "flutter.cmd") -Encoding Ascii
    "@echo off`r`nnode `"%~dp0npm-stub.cjs`" %*`r`n" | Set-Content -LiteralPath (Join-Path $stubs "npm.cmd") -Encoding Ascii
  } else {
    $flutterSh = Join-Path $stubs "flutter"
    $npmSh = Join-Path $stubs "npm"
    "#!/bin/sh`nexec node `"$(Join-Path $stubs "flutter-stub.cjs")`" `"`$@`"`n" | Set-Content -LiteralPath $flutterSh -Encoding Ascii
    "#!/bin/sh`nexec node `"$(Join-Path $stubs "npm-stub.cjs")`" `"`$@`"`n" | Set-Content -LiteralPath $npmSh -Encoding Ascii
    & chmod +x $flutterSh $npmSh
  }

  # Fake NuGet CLI: the pack only checks that it resolves on PATH and never runs it.
  New-Item -ItemType Directory -Path $nugetDir -Force | Out-Null
  if ($env:OS -eq "Windows_NT") {
    Set-Content -LiteralPath (Join-Path $nugetDir "nuget.exe") -Value "fixture nuget" -Encoding Ascii
  } else {
    $nugetSh = Join-Path $nugetDir "nuget"
    "#!/bin/sh`nexit 0`n" | Set-Content -LiteralPath $nugetSh -Encoding Ascii
    & chmod +x $nugetSh
  }

  $env:TRACE = $trace
  $env:FIXTURE_APP = $app
  $previousPath = $env:PATH
  $sep = [System.IO.Path]::PathSeparator
  $env:PATH = "$stubs$sep$nugetDir$sep$previousPath"
  $dist = Join-Path $fixture "dist\pi-bot-windows"
  $debugInfo = Join-Path $app "build\debug-info\windows"

  function Invoke-Pack {
    param([string[]]$ArgList = @(), [string]$Fail = "")
    Reset-Trace
    if ($Fail) { $env:PACK_FAIL = $Fail } else { Remove-Item Env:PACK_FAIL -ErrorAction SilentlyContinue }
    # Windows PowerShell turns a native stderr line into a terminating error when
    # ErrorAction is Stop and stderr is merged. Expected pack failures write to stderr.
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
      $PSNativeCommandUseErrorActionPreference = $false
    }
    $code = $null
    try {
      & $shell -NoProfile -ExecutionPolicy Bypass -File $script @ArgList > $log 2>&1
      $code = $LASTEXITCODE
    } catch {
      # Redirected stderr can surface as an ErrorRecord. Keep the real exit code.
      $code = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousPreference
    }
    return $code
  }

  function Assert-Clean {
    $stages = @(Get-ChildItem -LiteralPath (Join-Path $fixture "dist") -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like ".pack-windows-*" })
    Assert-True ($stages.Count -eq 0) "stage directory was left behind"
    $builds = @(Get-ChildItem -LiteralPath (Join-Path $app "build\windows\x64\runner") -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like ".pack-build-*" })
    Assert-True ($builds.Count -eq 0) "release swap directory was left behind"
    Assert-True ((Get-Content -LiteralPath $sourceMain -Raw) -eq $mainBefore) "app source changed"
    Assert-True ((Get-Content -LiteralPath $sourcePubspec -Raw) -eq $pubspecBefore) "pubspec changed"
    Assert-True ((Get-Content -LiteralPath $sourceLock -Raw) -eq $lockBefore) "pubspec.lock changed"
    Assert-True ((Read-Norm (Join-Path $app ".dart_tool\marker")) -eq "keep-cache") "cache marker changed"
    if (Test-Path -LiteralPath $trace) {
      foreach ($line in (Get-Content -LiteralPath $trace)) {
        if ($line -and (Test-Path -LiteralPath $line) -and $line.Contains("pi-bot-windows-build-")) {
          throw "temp build directory was left behind"
        }
      }
    }
  }

  Write-Host "Command-stub tests do not prove a real Windows Flutter build."

  Assert-True ((Invoke-Pack -ArgList @("-Help")) -eq 0) "help should succeed"
  Assert-True ((Read-Log).Contains("-NoBuild")) "help text missing"
  Assert-True ((Read-Log).Contains("-BuildRoot")) "help text missing -BuildRoot"
  Assert-True ((Read-Log).Contains("nuget.exe")) "help text missing nuget note"
  Assert-True ((Read-Trace).Trim().Length -eq 0) "help invoked flutter"
  $pass++
  Write-Host "PASS: help does not build"

  $script:UserHome = (& node -e "process.stdout.write(require('os').homedir())")
  Assert-ErrorText (Invoke-Pack -ArgList @("-NotASwitch")) "unknown parameter" "unknown switch"
  Assert-Clean
  $pass++
  Write-Host "PASS: unknown switch is rejected"

  $nodeStub = Join-Path $testRoot "old-node"
  New-Item -ItemType Directory -Path $nodeStub -Force | Out-Null
  if ($env:OS -eq "Windows_NT") {
    "@echo off`r`necho v20.0.0`r`nexit /b 0`r`n" | Set-Content -LiteralPath (Join-Path $nodeStub "node.cmd") -Encoding Ascii
  } else {
    $nodeSh = Join-Path $nodeStub "node"
    "#!/bin/sh`necho v20.0.0`nexit 0`n" | Set-Content -LiteralPath $nodeSh -Encoding Ascii
    & chmod +x $nodeSh
  }
  $savedPath = $env:PATH
  $env:PATH = "$nodeStub$([System.IO.Path]::PathSeparator)$savedPath"
  Assert-ErrorText (Invoke-Pack -ArgList @("-NoBuild")) "Node 22+ is required" "old node"
  $env:PATH = $savedPath
  Assert-True (-not (Test-Path -LiteralPath $dist)) "old node created a package"
  Assert-Clean
  $pass++
  Write-Host "PASS: Node below 22 is rejected"

  Remove-Item -LiteralPath $release -Recurse -Force
  Assert-ErrorText (Invoke-Pack -ArgList @("-NoBuild")) "no release build" "missing release"
  Assert-True (-not (Test-Path -LiteralPath $dist)) "missing release created a package"
  Assert-True ((Read-Norm (Join-Path $fixture "dist\keep.txt")) -eq "preserve this file") "keep file changed"
  Assert-Clean
  New-Item -ItemType Directory -Path $release -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $release "pi_bot.exe") -Value "old exe`n" -Encoding Ascii
  Set-Content -LiteralPath (Join-Path $release "pi_bot.pdb") -Value "old pdb`n" -Encoding Ascii
  Set-Content -LiteralPath (Join-Path $release "sentinel.txt") -Value "old release`n" -Encoding Ascii
  $pass++
  Write-Host "PASS: -NoBuild without a Release build fails"

  Assert-True ((Invoke-Pack -ArgList @("-NoBuild")) -eq 0) "-NoBuild should succeed: $(Read-Log)"
  Assert-True ((Read-Trace).Trim().Length -eq 0) "-NoBuild invoked flutter"
  Assert-True ((Read-Norm (Join-Path $dist "pi_bot.exe")) -eq "old exe") "exe was not packed"
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $dist "pi_bot.pdb"))) "pdb was shipped"
  Assert-True ((Read-Norm (Join-Path $release "pi_bot.pdb")) -eq "old pdb") "local pdb was removed"
  Assert-True ((Read-Norm (Join-Path $dist "server\src\index.js")) -eq "fixture server version one") "server entry missing"
  Assert-True (Test-Path -LiteralPath (Join-Path $dist "server\node_modules\installed.txt")) "deps were not installed"
  Assert-True (Test-Path -LiteralPath (Join-Path $dist "server\.env.example")) "env example missing"
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $dist "server\.env"))) "server .env was shipped"
  Assert-True ((Get-Content -LiteralPath (Join-Path $dist "server\package-lock.json") -Raw).Contains("lockfileVersion")) "lockfile missing"
  Assert-True ((Read-Norm (Join-Path $fixture "dist\keep.txt")) -eq "preserve this file") "keep file changed"
  Assert-Clean
  $pass++
  Write-Host "PASS: -NoBuild packs, strips pdb from dist, keeps local pdb and other dist files"

  Set-Content -LiteralPath (Join-Path $server "src\index.js") -Value "fixture server version two`n" -Encoding Ascii
  Assert-True ((Invoke-Pack -ArgList @("-NoBuild")) -eq 0) "repack should succeed: $(Read-Log)"
  Assert-True ((Read-Norm (Join-Path $dist "server\src\index.js")) -eq "fixture server version two") "repack did not publish new server"
  Assert-True ((Read-Norm (Join-Path $fixture "dist\keep.txt")) -eq "preserve this file") "keep file changed on repack"
  Assert-Clean
  $pass++
  Write-Host "PASS: repack replaces the package and keeps unrelated dist files"

  Assert-ErrorText (Invoke-Pack -ArgList @("-NoBuild", "-Zip") -Fail "npm") "npm install failed" "npm failure"
  Assert-True ((Read-Norm (Join-Path $dist "server\src\index.js")) -eq "fixture server version two") "npm failure destroyed the package"
  Assert-True ((Read-Norm (Join-Path $fixture "dist\pi-bot-windows.zip")) -eq "old zip") "npm failure destroyed the zip"
  Assert-True ((Read-Norm (Join-Path $fixture "dist\keep.txt")) -eq "preserve this file") "keep file changed"
  Assert-Clean
  $pass++
  Write-Host "PASS: npm failure keeps the previous package and zip"

  function Add-ServerBytes([string]$Relative, [byte[]]$Bytes) {
    $dest = Join-Path $server "src"
    foreach ($part in ($Relative -split '[\\/]')) {
      if ($part) { $dest = Join-Path $dest $part }
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null
    [System.IO.File]::WriteAllBytes($dest, $Bytes)
    return $dest
  }
  function Assert-ScanKept([object]$Code, [string]$Fragment, [string]$Name) {
    Assert-ErrorText $Code $Fragment $Name
    Assert-True ((Read-Norm (Join-Path $dist "server\src\index.js")) -eq "fixture server version two") "$Name destroyed the package"
    Assert-Clean
  }
  $utf8 = Add-ServerBytes "utf8.txt" ([System.Text.Encoding]::UTF8.GetBytes($script:UserHome))
  Assert-ScanKept (Invoke-Pack -ArgList @("-NoBuild")) "utf8.txt" "utf8 user directory"
  Remove-Item -LiteralPath $utf8 -Force
  $pass++
  Write-Host "PASS: utf8 user directory fails and keeps the previous package"

  $utf16 = Add-ServerBytes "utf16.bin" ([System.Text.Encoding]::Unicode.GetBytes($script:UserHome))
  Assert-ScanKept (Invoke-Pack -ArgList @("-NoBuild")) "utf16.bin" "utf16 user directory"
  Remove-Item -LiteralPath $utf16 -Force
  $pass++
  Write-Host "PASS: utf16 user directory fails and keeps the previous package"

  $pdb = Add-ServerBytes "symbols.pdb" ([System.Text.Encoding]::ASCII.GetBytes("symbols"))
  Assert-ScanKept (Invoke-Pack -ArgList @("-NoBuild")) ".pdb" "pdb"
  Remove-Item -LiteralPath $pdb -Force
  $pass++
  Write-Host "PASS: pdb fails and keeps the previous package"

  $piFile = Add-ServerBytes ".pi/config.json" ([System.Text.Encoding]::ASCII.GetBytes("{}"))
  Assert-ScanKept (Invoke-Pack -ArgList @("-NoBuild")) ".pi" "pi state"
  Remove-Item -LiteralPath (Split-Path -Parent $piFile) -Recurse -Force
  $pass++
  Write-Host "PASS: .pi fails and keeps the previous package"

  $inbox = Add-ServerBytes "_inbox/note.txt" ([System.Text.Encoding]::ASCII.GetBytes("x"))
  Assert-ScanKept (Invoke-Pack -ArgList @("-NoBuild")) "_inbox" "inbox"
  Remove-Item -LiteralPath (Split-Path -Parent $inbox) -Recurse -Force
  $pass++
  Write-Host "PASS: _inbox fails and keeps the previous package"

  $env:PACK_PLANT = "dotenv"
  Assert-ScanKept (Invoke-Pack -ArgList @("-NoBuild")) ".env" "server env"
  Remove-Item Env:PACK_PLANT -ErrorAction SilentlyContinue
  $pass++
  Write-Host "PASS: server .env fails and keeps the previous package"

  $logFile = Add-ServerBytes "app.log" ([System.Text.Encoding]::ASCII.GetBytes("log"))
  Assert-ScanKept (Invoke-Pack -ArgList @("-NoBuild")) "log" "log file"
  Remove-Item -LiteralPath $logFile -Force
  $pass++
  Write-Host "PASS: log fails and keeps the previous package"

  $manifestDir = Join-Path $release "data\flutter_assets"
  New-Item -ItemType Directory -Path $manifestDir -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $manifestDir "NativeAssetsManifest.json") -Value '{"format-version":[1,0,0],"native-assets":{"windows_x64":{"fixture:library":["absolute","plugin/missing.dll"]}}}' -Encoding Ascii
  Assert-ScanKept (Invoke-Pack -ArgList @("-NoBuild")) "NativeAssets" "missing dll"
  Remove-Item -LiteralPath (Join-Path $release "data") -Recurse -Force
  $pass++
  Write-Host "PASS: missing dll fails and keeps the previous package"

  $native = Join-Path $server "src\vendor.node"
  $nativeBytes = [System.Text.Encoding]::UTF8.GetBytes($script:UserHome)
  [System.IO.File]::WriteAllBytes($native, $nativeBytes)
  Assert-ScanKept (Invoke-Pack -ArgList @("-NoBuild")) "vendor.node" "server native"
  Assert-True ([System.Linq.Enumerable]::SequenceEqual([System.IO.File]::ReadAllBytes($native), $nativeBytes)) "server native file was rewritten"
  Remove-Item -LiteralPath $native -Force
  $pass++
  Write-Host "PASS: server native files are not rewritten and still fail the scan"

  Set-Content -LiteralPath (Join-Path $server "package.json") -Value '{"name":"fixture","version":"0.1.0","dependencies":{"fixture-missing-package":"1.0.0"}}' -Encoding Ascii
  Assert-ErrorText (Invoke-Pack -ArgList @("-NoBuild")) "release scan failed" "missing dependency"
  Assert-True ((Read-Norm (Join-Path $dist "server\src\index.js")) -eq "fixture server version two") "dependency failure destroyed the package"
  Assert-Clean
  Set-Content -LiteralPath (Join-Path $server "package.json") -Value $packageBefore.Trim() -Encoding Ascii
  $pass++
  Write-Host "PASS: missing declared dependency fails and keeps the previous package"

  Assert-True ((Invoke-Pack -ArgList @("-NoBuild", "-SkipDeps")) -eq 0) "-SkipDeps should succeed: $(Read-Log)"
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $dist "server\node_modules"))) "-SkipDeps installed node_modules"
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $dist "pi_bot.pdb"))) "-SkipDeps shipped a pdb"
  Assert-Clean
  $pass++
  Write-Host "PASS: -SkipDeps still scans and does not install dependencies"

  Assert-True ((Invoke-Pack -ArgList @("-NoBuild", "-Zip")) -eq 0) "zip should succeed: $(Read-Log)"
  $zipPath = Join-Path $fixture "dist\pi-bot-windows.zip"
  $zipBytes = [System.IO.File]::ReadAllBytes($zipPath)
  Assert-True ($zipBytes.Length -gt 2 -and $zipBytes[0] -eq 0x50 -and $zipBytes[1] -eq 0x4b) "zip was not replaced"
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $names = @($archive.Entries | ForEach-Object { $_.FullName })
  } finally {
    $archive.Dispose()
  }
  Assert-True (($names | Where-Object { $_ -match 'pi_bot\.exe$' }).Count -ge 1) "zip missing exe"
  Assert-True (($names | Where-Object { $_ -match '\.pdb$' }).Count -eq 0) "zip contains pdb"
  Assert-True (($names | Where-Object { $_ -match 'index\.js$' }).Count -ge 1) "zip missing server entry"
  Assert-Clean
  $pass++
  Write-Host "PASS: zip is published without pdb files"

  Assert-True ((Invoke-Pack) -eq 0) "clean build should succeed: $(Read-Log)"
  Assert-True ((Read-Norm (Join-Path $release "pi_bot.exe")) -eq "fixture exe") "neutral build was not copied back"
  Assert-True ((Read-Norm (Join-Path $release "pi_bot.pdb")) -eq "fixture pdb") "local pdb was not kept"
  Assert-True ((Read-Norm (Join-Path $dist "pi_bot.exe")) -eq "fixture exe") "dist exe mismatch"
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $dist "pi_bot.pdb"))) "dist shipped pdb"
  Assert-True ((Read-Norm (Join-Path $debugInfo "app.symbols")) -eq "fixture symbols") "debug info was not saved"
  Assert-True (Test-Path -LiteralPath (Join-Path $debugInfo "pdb\pi_bot.pdb")) "pdb was not saved beside debug info"
  Assert-True ((Read-Norm (Join-Path $dist "server\src\index.js")) -eq "fixture server version two") "build pack dropped server changes"
  Assert-True ((Read-Trace).Contains("--split-debug-info=")) "build did not split debug info"
  Assert-True ((Read-Trace).Contains("build windows --release")) "flutter release args missing"
  Assert-True ((Read-Trace).Contains("pub get --enforce-lockfile --no-example")) "locked dependency resolution missing"
  Assert-True ((Read-Trace).Contains("build windows --release --no-pub")) "build can resolve dependencies again"
  if ($env:OS -eq "Windows_NT") {
    $defaultBase = (Split-Path -Qualifier $fixture) + "\.pi-bot-build\pi-bot-windows-build-"
    Assert-True ((Read-Trace).Contains($defaultBase)) "default build root is not on the checkout drive"
  }
  Assert-Clean
  $pass++
  Write-Host "PASS: clean temp build restores Release, saves debug info, and strips dist pdb"

  Assert-ErrorText (Invoke-Pack -ArgList @("-BuildRoot", "relative\build")) "must be an absolute path" "relative build root"
  Assert-True ((Read-Trace).Trim().Length -eq 0) "relative build root invoked flutter"
  Assert-Clean
  $pass++
  Write-Host "PASS: relative -BuildRoot is rejected"

  $profileRoot = Join-Path $script:UserHome ("pi-bot-build-test-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
  Assert-ErrorText (Invoke-Pack -ArgList @("-BuildRoot", $profileRoot)) "outside the user profile" "profile build root"
  Assert-True ((Read-Trace).Trim().Length -eq 0) "profile build root invoked flutter"
  Assert-True (-not (Test-Path -LiteralPath $profileRoot)) "profile build root was created"
  Assert-Clean
  $pass++
  Write-Host "PASS: -BuildRoot inside the user profile is rejected without printing it"

  $savedPath = $env:PATH
  $nodeDir = Split-Path -Parent (Get-Command node -CommandType Application | Select-Object -First 1).Source
  $bareParts = @($stubs, $nodeDir, $PSHOME)
  if ($env:OS -eq "Windows_NT") { $bareParts += (Join-Path $env:SystemRoot "System32") } else { $bareParts += @("/usr/bin", "/bin") }
  $env:PATH = ($bareParts -join [System.IO.Path]::PathSeparator)
  $nugetName = "nuget"
  if ($env:OS -eq "Windows_NT") { $nugetName = "nuget.exe" }
  if (Get-Command $nugetName -CommandType Application -ErrorAction SilentlyContinue) {
    $env:PATH = $savedPath
    Write-Host "SKIP: a NuGet CLI sits beside node or the system tools; cannot hide it"
  } else {
    $code = Invoke-Pack
    $env:PATH = $savedPath
    Assert-ErrorText $code "nuget.exe is not on PATH" "missing nuget"
    Assert-True ((Read-Trace).Trim().Length -eq 0) "missing nuget still invoked flutter"
    Assert-Clean
    $pass++
    Write-Host "PASS: missing nuget stops before Flutter and does not download it"
  }

  $customName = ".pi-bot-build-test-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
  if ($env:OS -eq "Windows_NT") {
    $customRoot = (Split-Path -Qualifier $testRoot) + "\" + $customName
  } else {
    $customRoot = Join-Path ([System.IO.Path]::GetTempPath()) $customName
  }
  $foreign = Join-Path $customRoot "pi-bot-windows-build-foreign"
  New-Item -ItemType Directory -Path $foreign -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $foreign "keep.txt") -Value "not ours`n" -Encoding Ascii
  Assert-True ((Invoke-Pack -ArgList @("-BuildRoot", $customRoot)) -eq 0) "custom build root should succeed: $(Read-Log)"
  Assert-True ((Read-Trace).Contains((Join-Path $customRoot "pi-bot-windows-build-"))) "custom build root was not used"
  Assert-True ((Read-Norm (Join-Path $foreign "keep.txt")) -eq "not ours") "another folder in the build root was touched"
  $runs = @(Get-ChildItem -LiteralPath $customRoot -Force | Where-Object { $_.Name -ne "pi-bot-windows-build-foreign" })
  Assert-True ($runs.Count -eq 0) "build run folder or lock was left in the build root"
  Assert-Clean
  $pass++
  Write-Host "PASS: -BuildRoot builds in its own marked folder and leaves other folders alone"

  $lockFile = Join-Path $customRoot ".pack-windows.lock"
  $held = [System.IO.File]::Open($lockFile, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  try {
    $code = Invoke-Pack -ArgList @("-BuildRoot", $customRoot)
  } finally {
    $held.Dispose()
  }
  Assert-ErrorText $code "build root is busy" "held lock"
  Assert-True ((Read-Trace).Trim().Length -eq 0) "busy build root still invoked flutter"
  Assert-True ((Read-Norm (Join-Path $foreign "keep.txt")) -eq "not ours") "busy run touched another folder"
  Assert-True (Test-Path -LiteralPath $lockFile) "busy run removed the lock held by another pack"
  Remove-Item -LiteralPath $lockFile -Force
  Assert-Clean
  $pass++
  Write-Host "PASS: a held build root lock stops a second pack"

  Set-Content -LiteralPath (Join-Path $release "pi_bot.exe") -Value "previous exe`n" -Encoding Ascii
  Set-Content -LiteralPath (Join-Path $release "sentinel.txt") -Value "previous release`n" -Encoding Ascii
  Assert-ErrorText (Invoke-Pack -Fail "build") "flutter build failed" "flutter failure"
  Assert-True ((Read-Norm (Join-Path $release "pi_bot.exe")) -eq "previous exe") "flutter failure replaced Release"
  Assert-True ((Read-Norm (Join-Path $release "sentinel.txt")) -eq "previous release") "flutter failure dropped sentinel"
  Assert-True ((Read-Norm (Join-Path $dist "server\src\index.js")) -eq "fixture server version two") "flutter failure destroyed dist"
  Assert-Clean
  $pass++
  Write-Host "PASS: flutter failure keeps Release and dist"

  Assert-ErrorText (Invoke-Pack -Fail "no-exe") "did not produce" "missing exe"
  Assert-True ((Read-Norm (Join-Path $release "sentinel.txt")) -eq "previous release") "invalid output replaced Release"
  Assert-ErrorText (Invoke-Pack -Fail "no-debug") "split debug info" "missing debug info"
  Assert-True ((Read-Norm (Join-Path $release "pi_bot.exe")) -eq "previous exe") "missing debug info replaced Release"
  Assert-Clean
  $pass++
  Write-Host "PASS: incomplete neutral build does not replace Release"

  Write-Host "$pass command-stub checks passed (a real Windows Flutter build still needs a Windows machine)."
} catch {
  Write-Host "FAIL: $($_.Exception.Message)"
  if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log | Write-Host }
  exit 1
} finally {
  if ($previousPath) { $env:PATH = $previousPath }
  Remove-Item Env:PACK_FAIL -ErrorAction SilentlyContinue
  Remove-Item Env:PACK_PLANT -ErrorAction SilentlyContinue
  Remove-Item Env:TRACE -ErrorAction SilentlyContinue
  Remove-Item Env:FIXTURE_APP -ErrorAction SilentlyContinue
  if ($customRoot -and (Test-Path -LiteralPath $customRoot)) {
    Remove-Item -LiteralPath $customRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $testRoot) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
