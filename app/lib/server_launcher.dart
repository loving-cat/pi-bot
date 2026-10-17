import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';

/// 桌面端 = 宿主。这个文件负责"一键把整套后端跑起来"。
///
/// 以前只有一半：App 认定服务端就在 `127.0.0.1:8787`，直连过去 ——
/// 但**没有任何人去起它**。于是双击 `pi_bot.exe` 得到的是
/// "离线 · 自动重连中"，而且永远连不上（端口上本来就没人在听）。
///
/// 现在启动顺序是：
///   1. 探 `/health` —— 有人在听就直接连（第二次打开不会再拉一个进程）；
///   2. 找服务端入口（exe 旁边 / 上层目录 / `PI_BOT_SERVER`）；
///   3. 找 node（`PI_BOT_NODE` / exe 旁边 / Program Files / PATH），
///      版本不够或找不到会说清要装什么；
///   4. 缺 `node_modules` 就自动 `npm install`（第一次启动会慢一次，之后不再碰）；
///   5. 拉起来（**stdout 直接重定向到日志文件**，不经过我们的管道），
///      然后轮询 /health 直到应答。
///
/// 两个关键设计：
///   · **日志不进管道**。管道会在 App 退出/崩溃时断开，服务端下一次往 stdout
///     写日志就会 EPIPE 直接把进程打死 —— 用户看到的现象就是"关掉界面再打开就
///     连不上了"。重定向到文件之后，App 怎么死都不影响服务端。
///   · **进程不随 App 退出而结束**。它是这台机器的宿主服务；关界面再打开应该
///     立刻连上，而不是重新冷启动一遍。
class ServerLaunchResult {
  const ServerLaunchResult({
    required this.ok,
    required this.alreadyRunning,
    this.error,
  });

  final bool ok;
  final bool alreadyRunning;
  final String? error;
}

/// 服务端进程（一次进程内只拉一个）
Process? _serverProcess;
bool _spawning = false;

/// 启动时攒下来的日志（失败时贴到界面上）
final List<String> _logLines = <String>[];

/// 最近的日志尾部（界面上"为什么起不来"就看这个）
List<String> get serverLogTail => List<String>.unmodifiable(_logLines);

String? _entryPath;
String? _nodePath;
String? _nodeVersion;

/// 这台机器上的**真实位置**（界面上的提示要用它们）。
/// 以前界面上写的是 `cd server` —— 用户把包解到哪个目录都可能，照着敲对不上。
String? get resolvedServerDir {
  final entry = _entryPath;
  if (entry == null) return null;
  return File(entry).parent.parent.path;
}

String? get resolvedNodePath => _nodePath;

String get serverLogPath => _logFile().path;

/// 真起来了吗（GET /health）
Future<bool> serverAlive(
  String baseUrl, {
  Duration timeout = const Duration(seconds: 2),
}) async {
  final client = HttpClient()..connectionTimeout = timeout;
  try {
    final req = await client
        .getUrl(Uri.parse('$baseUrl/health'))
        .timeout(timeout);
    final res = await req.close().timeout(timeout);
    await res.drain<void>();
    return res.statusCode == 200;
  } catch (_) {
    return false;
  } finally {
    client.close(force: true);
  }
}

/// 端口上有没有人在听（用来区分"服务端没起来"和"端口被别的程序占着"）
Future<bool> portOpen(
  String host,
  int port, {
  Duration timeout = const Duration(milliseconds: 600),
}) async {
  try {
    final socket = await Socket.connect(host, port, timeout: timeout);
    socket.destroy();
    return true;
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------- 找东西

/// 从可执行文件所在目录往上找 `server/src/index.js`。
///
/// 为什么往上找：开发时 exe 在 `app/build/windows/x64/runner/Release/`，
/// 仓库根在 6 层之上；发行包里则应该把 `server/` 放在 exe 旁边。
List<String> _entryCandidates(String exeDir) {
  final sep = Platform.pathSeparator;
  String at(String base, List<String> parts) => [base, ...parts].join(sep);
  final entry = ['server', 'src', 'index.js'];
  final out = <String>[];
  final env = Platform.environment['PI_BOT_SERVER']?.trim();
  if (env != null && env.isNotEmpty) out.add(env);

  out.add(at(exeDir, entry));
  out.add(at(at(exeDir, ['..']), entry));

  var dir = Directory(exeDir);
  for (var i = 0; i < 8; i++) {
    out.add(at(dir.path, entry));
    final parent = dir.parent;
    if (parent.path == dir.path) break;
    dir = parent;
  }
  out.add(at(Directory.current.path, entry));
  return out;
}

String? _findEntry(String exeDir) {
  for (final path in _entryCandidates(exeDir)) {
    if (File(path).existsSync()) return File(path).absolute.path;
  }
  return null;
}

/// 找 node：先看显式配置，再看 exe 旁边（发行包可以自带），最后看 PATH。
Future<String?> _findNode(String exeDir) async {
  final sep = Platform.pathSeparator;
  final explicit = Platform.environment['PI_BOT_NODE']?.trim();
  if (explicit != null && explicit.isNotEmpty && File(explicit).existsSync())
    return explicit;

  for (final name in ['node.exe', 'node']) {
    final beside = File('$exeDir$sep$name');
    if (beside.existsSync()) return beside.path;
    final inDir = File('$exeDir${sep}node$sep$name');
    if (inDir.existsSync()) return inDir.path;
  }

  if (Platform.isWindows) {
    final programFiles =
        Platform.environment['ProgramFiles'] ?? r'C:\Program Files';
    final guess = '$programFiles\\nodejs\\node.exe';
    if (File(guess).existsSync()) return guess;
  }

  try {
    final probe = Platform.isWindows
        ? await Process.run('where', ['node'])
        : await Process.run('which', ['node']);
    if (probe.exitCode == 0) {
      final lines = '${probe.stdout}'.split(RegExp(r'\r?\n'));
      for (final line in lines) {
        final path = line.trim();
        if (path.isEmpty) continue;
        if (File(path).existsSync()) return path;
      }
    }
  } catch (_) {}
  return null;
}

/// node 版本要 >= 22（server/package.json 里写着 engines）
Future<String?> _versionOf(String nodePath) async {
  try {
    final r = await Process.run(nodePath, ['-v']);
    if (r.exitCode != 0) return null;
    return '${r.stdout}'.trim().replaceAll(RegExp(r'^v'), '');
  } catch (_) {
    return null;
  }
}

bool _versionAtLeast(String version, int major) {
  final parts = version.split('.');
  final first = int.tryParse(parts.isNotEmpty ? parts.first : '') ?? 0;
  return first >= major;
}

/// 找 npm。
///
/// 三种情况都要兼容：
///   · 普通安装：`<node>\npm.cmd`；
///   · 发行包里只带了 node.exe（没有 npm.cmd）—— 但 npm 本体在
///     `node_modules/npm/bin/npm-cli.js`，用 `node npm-cli.js` 一样能跑；
///   · 都不在旁边的，去 PATH 上找。
///
/// 以前只查了第一种，于是打包后（只带 node.exe）永远"找不到 npm"，
/// 界面就一直在"正在启动"和错误之间循环。
List<String> _npmCommand(String nodePath) {
  final sep = Platform.pathSeparator;
  final dir = File(nodePath).parent.path;

  for (final name in ['npm.cmd', 'npm']) {
    final p = '$dir$sep$name';
    if (File(p).existsSync()) return [p];
  }

  // 只带了 node.exe 的包：用 node 跑 npm-cli.js
  final cli = [
    [dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'].join(sep),
    [dir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'].join(sep),
  ].firstWhere((p) => File(p).existsSync(), orElse: () => '');
  if (cli.isNotEmpty) return [nodePath, File(cli).absolute.path];

  return const [];
}

/// 依赖只装一次：并发/重试的多次调用都等同一个 Future，
/// 否则启动失败重试时会同时跑好几个 npm install（把机器拖死）。
Future<String?>? _depsFuture;

// ---------------------------------------------------------------- 日志

/// 本次尝试中服务端进程是不是启动后自己退出了（用来把错误说清楚）
bool _diedDuringStart = false;

File _logFile() {
  return File('${_stateDir().path}${Platform.pathSeparator}server.log');
}

/// 日志太大就滚一份（不然跑几个月能到几百兆）
int _logFrom = 0;
void _rotateIfHuge(File file) {
  try {
    if (!file.existsSync()) return;
    if (file.lengthSync() < 2 * 1024 * 1024) return;
    final backup = File('${file.path}.1');
    if (backup.existsSync()) backup.deleteSync();
    file.renameSync(backup.path);
  } catch (_) {}
}

/// 每次 App 启动先清空日志（上一轮留到 `server.log.prev`）。
///
/// 为什么：日志是共用的一个文件，如果不清，界面会拿上一次运行的输出当成
/// 这一次的“启动日志”贴出来（用户看到的是完全无关的旧内容）。
void resetServerLogForNewRun() {
  final file = _logFile();
  try {
    if (file.existsSync() && file.lengthSync() > 0) {
      final prev = File('${file.path}.prev');
      if (prev.existsSync()) prev.deleteSync();
      file.renameSync(prev.path);
    }
  } catch (_) {}
  _logLines.clear();
}

/// 读日志尾部（我们不再从管道拿输出，改成轮询这个文件）。
///
/// 只看**本次尝试**写入的部分（`_logFrom` 是拉起前记下的偏移）：
/// 不然上一次启动留下的"进程退出"会被当成这一次的，白白报错。
void _syncLogFromFile(File file) {
  try {
    if (!file.existsSync()) return;
    final length = file.lengthSync();
    if (length <= _logFrom) return;
    final windowStart = length > 8192 ? length - 8192 : 0;
    final start = _logFrom > windowStart ? _logFrom : windowStart;
    final raf = file.openSync();
    try {
      raf.setPositionSync(start);
      final bytes = raf.readSync(length - start);
      final text = const Utf8Decoder(allowMalformed: true).convert(bytes);
      final lines = text.split(RegExp(r'\r?\n'));
      _logLines
        ..clear()
        ..addAll(lines.where((l) => l.trim().isNotEmpty).toList());
      while (_logLines.length > 80) {
        _logLines.removeAt(0);
      }
    } finally {
      raf.closeSync();
    }
  } catch (_) {}
}

void _note(String line) {
  _logLines.add(line);
  while (_logLines.length > 80) {
    _logLines.removeAt(0);
  }
  if (kDebugMode) debugPrint('[server] $line');
}

// ---------------------------------------------------------------- 启动

/// 确保 `server/node_modules` 在。第一次启动会慢一次（npm install），之后秒过。
Future<String?> _ensureDependencies(
  String nodePath,
  String serverDir,
  void Function()? onProgress,
) {
  return _depsFuture ??= _installDependencies(nodePath, serverDir, onProgress);
}

Future<String?> _installDependencies(
  String nodePath,
  String serverDir,
  void Function()? onProgress,
) async {
  final sep = Platform.pathSeparator;
  if (Directory('$serverDir${sep}node_modules').existsSync()) return null;

  final npm = _npmCommand(nodePath);
  if (npm.isEmpty) {
    return '服务端缺依赖（$serverDir${sep}node_modules 不存在），也没找到 npm。\n'
        '· 装上带 npm 的 Node 22+（npm.cmd 就会自己出现）；\n'
        '· 或者在下面这个目录里手动跑一次 npm install：\n  $serverDir';
  }

  _note('第一次启动：正在安装服务端依赖（npm install，可能要一两分钟）…');
  _note('  ${npm.join(' ')}');
  onProgress?.call();
  try {
    final r = await Process.run(
      npm.first,
      [...npm.skip(1), 'install', '--omit=dev', '--no-audit', '--no-fund'],
      workingDirectory: serverDir,
      runInShell: Platform.isWindows && npm.length == 1,
    );
    if (r.exitCode != 0) {
      _depsFuture = null; // 失败允许下次重试
      final out = '${r.stderr}${r.stdout}'.trim();
      return '安装服务端依赖失败（npm install 退出码 ${r.exitCode}）。\n'
          '${out.length > 600 ? out.substring(out.length - 600) : out}';
    }
    _note('依赖装好了。');
    return null;
  } catch (err) {
    _depsFuture = null;
    return '安装服务端依赖失败：$err';
  }
}

/// 把服务端拉起来，并且**让它的 stdout/stderr 直接落在日志文件上**。
///
/// 为什么绕一层：
/// · Dart 的 stdout 管道会在 App 退出/崩溃时断开，服务端下次写日志就 EPIPE
///   直接被打死 —— 用户看到的就是"关掉界面再打开就连不上"；
/// · `ProcessStartMode.detached` 在 Windows 上会让 node 起不来（没有 stdio 句柄）；
/// · 用 `cmd /c "... >> log"` 也不行 —— Dart 会把内嵌引号转义成 `\"`，
///   而 cmd 不认识反斜杠转义，整条命令变成乱码。
///
/// 所以：先拉一个只活几十毫秒的 node 小脚本，由它 spawn 真正的服务端并把
/// stdio 换成日志文件的 fd，然后自己退出。文件句柄与 App 无关 —— App 怎么死都不影响服务端。
Future<Process> _spawnRedirected(
  String nodePath,
  String entryPath,
  String serverDir,
  File logFile,
) async {
  final supervisor = File(
    '${_stateDir().path}${Platform.pathSeparator}spawn-server.mjs',
  );
  supervisor.writeAsStringSync(_supervisorSource, flush: true);
  return Process.start(nodePath, [
    supervisor.path,
    nodePath,
    entryPath,
    serverDir,
    logFile.path,
  ], workingDirectory: serverDir);
}

/// 只活几十毫秒的启动器：spawn 真服务端（stdio 接到日志文件）后立刻退出
const String _supervisorSource = '''
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [node, entry, cwd, logPath] = process.argv.slice(2);
const fd = fs.openSync(logPath, 'a');
const header = `\n---- \${new Date().toISOString()} 启动: \${entry} (node \${process.version}) ----\\n`;
fs.writeSync(fd, header);
const child = spawn(node, [entry], {
  cwd,
  stdio: ['ignore', fd, fd],
  detached: true,
  windowsHide: true,
});
child.unref();
fs.closeSync(fd);
console.log(`server pid=\${child.pid}`);
''';

Directory _stateDir() {
  final base = Platform.environment['LOCALAPPDATA'];
  final dir = (base != null && base.isNotEmpty)
      ? Directory('$base${Platform.pathSeparator}pi-bot')
      : Directory(
          '${Directory.systemTemp.path}${Platform.pathSeparator}pi-bot',
        );
  try {
    dir.createSync(recursive: true);
  } catch (_) {}
  return dir;
}

/// 确保本机服务端在跑。不抛异常 —— 失败也要给界面一句人话。
Future<ServerLaunchResult> ensureLocalServer({
  String baseUrl = 'http://127.0.0.1:8787',
  Duration waitFor = const Duration(seconds: 30),
  void Function()? onProgress,
}) async {
  if (await serverAlive(baseUrl)) {
    return const ServerLaunchResult(ok: true, alreadyRunning: true);
  }

  if (_spawning) {
    // 另一个启动流程正在拉，等它出结果
    final deadline = DateTime.now().add(waitFor);
    while (DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 300));
      if (await serverAlive(baseUrl)) {
        return const ServerLaunchResult(ok: true, alreadyRunning: false);
      }
      if (!_spawning) break;
    }
    return const ServerLaunchResult(
      ok: false,
      alreadyRunning: false,
      error: '上一次启动还在进行中',
    );
  }

  _spawning = true;
  try {
    // 进程还在跑但端口还没通（正在初始化 / 装依赖）→ 别重复拉
    if (_serverProcess != null) {
      if (await _waitHealthy(
        baseUrl,
        waitFor: waitFor,
        onProgress: onProgress,
      )) {
        return const ServerLaunchResult(ok: true, alreadyRunning: false);
      }
      _serverProcess = null;
    }

    final exeDir = File(Platform.resolvedExecutable).parent.path;
    _entryPath ??= _findEntry(exeDir);
    if (_entryPath == null) {
      final tried = _entryCandidates(exeDir).take(6).join('\n  ');
      return ServerLaunchResult(
        ok: false,
        alreadyRunning: false,
        error:
            '找不到服务端程序（server/src/index.js）。找过这些位置：\n  $tried\n'
            '发行包应该把 server 目录放在 pi_bot.exe 旁边；也可以用环境变量 PI_BOT_SERVER 指过去。',
      );
    }

    _nodePath ??= await _findNode(exeDir);
    if (_nodePath == null) {
      return const ServerLaunchResult(
        ok: false,
        alreadyRunning: false,
        error:
            '找不到 node —— 服务端要用它跑。\n'
            '· 装一个 Node 22 或更新：https://nodejs.org\n'
            '· 或者把 node.exe 放到 pi_bot.exe 旁边\n'
            '· 或者用环境变量 PI_BOT_NODE 指定 node.exe 的路径',
      );
    }

    _nodeVersion ??= await _versionOf(_nodePath!);
    if (_nodeVersion == null) {
      return ServerLaunchResult(
        ok: false,
        alreadyRunning: false,
        error: '找到了 node（${_nodePath!}）但跑不起来，可能是装坏了。重装一个 Node 22+ 试试。',
      );
    }
    if (!_versionAtLeast(_nodeVersion!, 22)) {
      return ServerLaunchResult(
        ok: false,
        alreadyRunning: false,
        error: 'node 版本太旧（v$_nodeVersion），服务端要 22 或更新。装新的之后这里会自动用上。',
      );
    }

    final serverDir = File(_entryPath!).parent.parent.path;
    final depsProblem = await _ensureDependencies(
      _nodePath!,
      serverDir,
      onProgress,
    );
    if (depsProblem != null) {
      return ServerLaunchResult(
        ok: false,
        alreadyRunning: false,
        error: depsProblem,
      );
    }

    final logFile = _logFile();
    _rotateIfHuge(logFile);
    _diedDuringStart = false;
    _logFrom = logFile.existsSync() ? logFile.lengthSync() : 0;
    _logLines.clear();
    _note('启动服务端：$_nodePath $_entryPath（node v$_nodeVersion）');
    _note('日志文件：${logFile.path}（上一轮的留在 ${logFile.path}.prev）');

    final proc = await _spawnRedirected(
      _nodePath!,
      _entryPath!,
      serverDir,
      logFile,
    );
    _serverProcess = proc;
    // 启动器自己的输出很短（就一行 pid），读干净就好
    const Utf8Decoder()
        .bind(proc.stdout)
        .listen((s) => _note(s.trim()), onError: (_) {});
    const Utf8Decoder()
        .bind(proc.stderr)
        .listen((s) => _note(s.trim()), onError: (_) {});
    unawaited(
      proc.exitCode.then((code) {
        if (code != 0) _note('启动器退出，code=$code（日志：${logFile.path}）');
        if (identical(_serverProcess, proc)) _serverProcess = null;
      }),
    );
    onProgress?.call();

    if (await _waitHealthy(
      baseUrl,
      waitFor: waitFor,
      onProgress: onProgress,
      logFile: logFile,
    )) {
      return const ServerLaunchResult(ok: true, alreadyRunning: false);
    }

    // 端口上有人在听但 /health 不是我们的 → 被别的程序占着了
    final uri = Uri.parse(baseUrl);
    if (await portOpen(uri.host, uri.port)) {
      return ServerLaunchResult(
        ok: false,
        alreadyRunning: false,
        error:
            '端口 ${uri.port} 被别的程序占着（连得上，但它不是 pi-bot）。'
            '关掉那个程序，或者用 PI_BOT_PORT 换个端口。',
      );
    }

    final tail = _logLines.isEmpty
        ? ''
        : '\n日志尾部：\n${_logLines.take(12).join('\n')}';
    final why = _diedDuringStart
        ? '服务端启动后马上退出了（原因见下面的日志尾部）。'
        : '服务端没能在 ${waitFor.inSeconds}s 内应答。';
    return ServerLaunchResult(
      ok: false,
      alreadyRunning: false,
      error: '$why$tail',
    );
  } catch (err) {
    return ServerLaunchResult(
      ok: false,
      alreadyRunning: false,
      error: '启动服务端失败：$err',
    );
  } finally {
    _spawning = false;
  }
}

Future<bool> _waitHealthy(
  String baseUrl, {
  required Duration waitFor,
  void Function()? onProgress,
  File? logFile,
}) async {
  final deadline = DateTime.now().add(waitFor);
  var ticks = 0;
  while (DateTime.now().isBefore(deadline)) {
    if (await serverAlive(baseUrl, timeout: const Duration(milliseconds: 800)))
      return true;
    if (logFile != null) {
      _syncLogFromFile(logFile);
      // ★ 进程已经退出（日志里有退出行 / 未捕获异常）→ 立刻把原因报上去，
      //   不要干等到超时。这是把"报错反复跳 30 秒"压成"1 秒内报一次"的关键。
      if (_logLines.any((l) => l.contains('服务端进程退出') || l.contains('未捕获异常'))) {
        _diedDuringStart = true;
        return false;
      }
    }
    if (ticks % 2 == 0) onProgress?.call();
    ticks++;
    await Future<void>.delayed(const Duration(milliseconds: 300));
  }
  return false;
}

/// 关掉我们拉起来的那个进程（只在调试/重启用）
Future<void> stopLocalServer() async {
  final proc = _serverProcess;
  _serverProcess = null;
  if (proc == null) return;
  proc.kill();
}
