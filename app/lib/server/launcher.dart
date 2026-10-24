import 'dart:async';
import 'dart:io';

import 'health.dart';
import 'locate.dart';
import 'options.dart';
import 'server_log.dart';
import 'supervisor.dart';

/// 本机服务端启动编排。
///
/// 按顺序执行，每一步失败都返回可读的原因：
///   1. `/health` 有应答 → 直接复用（已有服务端时不再启动新进程）；
///   2. 定位服务端入口：用户设置 → `PI_BOT_SERVER` → exe 同级 → 上层目录；
///   3. 定位 node：用户设置 → `PI_BOT_NODE` → exe 同级 → Program Files → PATH，
///      并校验版本（需 22+）；
///   4. `node_modules` 缺失时执行 `npm install`（并发/重试共享同一个 Future）；
///   5. 启动进程（stdout/stderr 由操作系统重定向到日志文件），轮询 `/health`。
class LocalServerLauncher {
  LocalServerLauncher({
    Directory? stateDir,
    ServerLaunchOptions options = const ServerLaunchOptions(),
  }) : this._(stateDir ?? defaultStateDir(), options);

  LocalServerLauncher._(this.stateDir, ServerLaunchOptions options)
    : _options = options,
      supervisor = ServerSupervisor(stateDir),
      log = ServerLog(
        File('${stateDir.path}${Platform.pathSeparator}server.log'),
      );

  /// 每个平台放"我们自己的小文件"（日志 / pid / 启动脚本）的位置。
  ///
  /// Windows 是 `%LOCALAPPDATA%\pi-bot`，macOS 是
  /// `~/Library/Application Support/pi-bot` —— 不能用临时目录（重启就没了）。
  static Directory defaultStateDir() {
    final sep = Platform.pathSeparator;
    String base;
    if (Platform.isWindows) {
      base = Platform.environment['LOCALAPPDATA'] ?? Directory.systemTemp.path;
    } else if (Platform.isMacOS) {
      final home = Platform.environment['HOME'] ?? '~';
      base = '$home/Library/Application Support';
    } else {
      base =
          Platform.environment['XDG_STATE_HOME'] ??
          '${Platform.environment['HOME'] ?? '~'}/.local/state';
    }
    final dir = Directory('$base${sep}pi-bot');
    try {
      dir.createSync(recursive: true);
    } catch (_) {}
    return dir;
  }

  final Directory stateDir;
  final ServerSupervisor supervisor;
  final ServerLog log;

  /// 用户配置（改了就换路径 / 换数据目录）
  ServerLaunchOptions _options;
  ServerLaunchOptions get options => _options;
  set options(ServerLaunchOptions value) {
    if (_options != value) {
      _entryPath = null;
      _nodePath = null;
      _nodeVersion = null;
      _depsFuture = null;
    }
    _options = value;
  }

  String? _entryPath;
  String? _nodePath;
  String? _nodeVersion;
  String? _lastBaseUrl;
  Process? _serverProcess;
  bool _spawning = false;
  bool _diedDuringStart = false;
  Future<String?>? _depsFuture;

  /// 服务端目录（`.../server`）。界面展示手动启动命令时使用真实路径。
  String? get serverDir {
    final entry = _entryPath;
    if (entry == null) return null;
    return File(entry).parent.parent.path;
  }

  String? get nodePath => _nodePath;
  String get logPath => log.path;
  List<String> get logLines => log.lines;
  bool get diedDuringStart => _diedDuringStart;

  /// 每次 App 启动清一次日志（上一轮留到 .prev）
  void resetLogForNewRun() => log.resetForNewRun();

  Future<void> stop() async {
    final baseUrl = _lastBaseUrl;
    if (supervisor.readPid() == null &&
        baseUrl != null &&
        await serverAlive(baseUrl)) {
      throw StateError('服务端由其它进程启动，无法自动停止；请先手动停止再重启');
    }
    await supervisor.stop();
    _serverProcess = null;
  }

  /// 确保本机服务端在运行；失败返回原因，不抛异常。
  Future<ServerLaunchResult> ensureRunning({
    required String baseUrl,
    Duration waitFor = const Duration(seconds: 30),
    void Function()? onProgress,
  }) async {
    _lastBaseUrl = baseUrl;
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
        if (await _waitHealthy(baseUrl, waitFor, onProgress)) {
          return const ServerLaunchResult(ok: true, alreadyRunning: false);
        }
        _serverProcess = null;
      }

      final exeDir = File(Platform.resolvedExecutable).parent.path;

      final entryProblem = _resolveEntry(exeDir);
      if (entryProblem != null) return entryProblem;

      final nodeProblem = await _resolveNode(exeDir);
      if (nodeProblem != null) return nodeProblem;

      final serverDirectory = serverDir!;
      final depsProblem = await _ensureDependencies(
        serverDirectory,
        onProgress,
      );
      if (depsProblem != null) {
        return ServerLaunchResult(
          ok: false,
          alreadyRunning: false,
          error: depsProblem,
        );
      }

      log.rotateIfHuge();
      _diedDuringStart = false;
      log.markAttemptStart();
      log.note('启动服务端：$_nodePath $_entryPath（node v$_nodeVersion）');
      log.note('日志文件：${log.path}（上一轮的留在 ${log.path}.prev）');
      if (options.data.isNotEmpty) log.note('数据目录（用户指定）：${options.data}');

      final proc = await supervisor.spawn(
        nodePath: _nodePath!,
        entryPath: _entryPath!,
        serverDir: serverDirectory,
        logPath: log.path,
        extraEnv: options.env,
      );
      _serverProcess = proc;
      // 启动器自己的输出很短（就一行 pid），读干净就好
      proc.stdout.listen(
        (b) => log.note(String.fromCharCodes(b).trim()),
        onError: (_) {},
      );
      proc.stderr.listen(
        (b) => log.note(String.fromCharCodes(b).trim()),
        onError: (_) {},
      );
      unawaited(
        proc.exitCode.then((code) {
          if (code != 0) log.note('启动器退出，code=$code（日志：${log.path}）');
          if (identical(_serverProcess, proc)) _serverProcess = null;
        }),
      );
      onProgress?.call();

      if (await _waitHealthy(baseUrl, waitFor, onProgress, watchLog: true)) {
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
              '关掉那个程序，或者在「设置 → 本机服务端」里换个端口。',
        );
      }

      final tail = log.lines.isEmpty
          ? ''
          : '\n日志尾部：\n${log.lines.take(12).join('\n')}';
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

  // ---------------------------------------------------------------- 分步

  /// 用户指定的入口优先；指定但不存在时返回明确的错误。
  ServerLaunchResult? _resolveEntry(String exeDir) {
    final wanted = options.entry;
    if (wanted.isNotEmpty) {
      final file = File(wanted);
      if (!file.existsSync()) {
        return ServerLaunchResult(
          ok: false,
          alreadyRunning: false,
          error:
              '设置里指定的服务端程序不存在：\n  $wanted\n'
              '要么改回自动探测（留空），要么改成实际的 server/src/index.js。',
        );
      }
      _entryPath = file.absolute.path;
      return null;
    }

    _entryPath ??= findServerEntry(exeDir);
    if (_entryPath == null) {
      final tried = serverEntryCandidates(exeDir).take(6).join('\n  ');
      return ServerLaunchResult(
        ok: false,
        alreadyRunning: false,
        error:
            '找不到服务端程序（server/src/index.js）。找过这些位置：\n  $tried\n'
            '发行包应该包含 server 目录（macOS 位于应用的 Contents/Resources）；'
            '也可以在「设置 → 本机服务端」里自己指定。',
      );
    }
    return null;
  }

  Future<ServerLaunchResult?> _resolveNode(String exeDir) async {
    final wanted = options.node;
    if (wanted.isNotEmpty) {
      if (!File(wanted).existsSync()) {
        return ServerLaunchResult(
          ok: false,
          alreadyRunning: false,
          error: '设置里指定的 node 不存在：\n  $wanted',
        );
      }
      if (_nodePath != wanted) {
        _nodePath = wanted;
        _nodeVersion = null;
      }
    } else {
      _nodePath ??= await findNode(exeDir);
    }

    if (_nodePath == null) {
      return const ServerLaunchResult(
        ok: false,
        alreadyRunning: false,
        error:
            '找不到 node —— 服务端要用它跑。\n'
            '· 装一个 Node 22 或更新：https://nodejs.org\n'
            '· 或者把 node 放到应用可执行文件旁边或 macOS 的 Contents/Resources\n'
            '· 或者在「设置 → 本机服务端」里自己指定 node 路径',
      );
    }

    _nodeVersion ??= await nodeVersion(_nodePath!);
    if (_nodeVersion == null) {
      return ServerLaunchResult(
        ok: false,
        alreadyRunning: false,
        error: '找到了 node（${_nodePath!}）但跑不起来，可能是装坏了。重装一个 Node 22+ 试试。',
      );
    }
    if (!versionAtLeast(_nodeVersion!, 22)) {
      return ServerLaunchResult(
        ok: false,
        alreadyRunning: false,
        error: 'node 版本太旧（v$_nodeVersion），服务端要 22 或更新。装新的之后这里会自动用上。',
      );
    }
    return null;
  }

  /// 依赖只安装一次：并发或重试的调用共享同一个 Future，
  /// 避免同时启动多个 npm install。
  Future<String?> _ensureDependencies(
    String serverDirectory,
    void Function()? onProgress,
  ) {
    return _depsFuture ??= _installDependencies(serverDirectory, onProgress);
  }

  Future<String?> _installDependencies(
    String serverDirectory,
    void Function()? onProgress,
  ) async {
    final exists = Directory(
      '$serverDirectory${Platform.pathSeparator}node_modules',
    ).existsSync();
    if (exists) return null;

    final npm = npmCommand(_nodePath!);
    if (npm.isEmpty) {
      return '服务端缺依赖（$serverDirectory${Platform.pathSeparator}node_modules 不存在），也没找到 npm。\n'
          '· 装上带 npm 的 Node 22+；\n'
          '· 或者在下面这个目录里手动跑一次 npm install：\n  $serverDirectory';
    }

    log.note('第一次启动：正在安装服务端依赖（npm install，可能要一两分钟）…');
    log.note('  ${npm.join(' ')}');
    onProgress?.call();
    try {
      final r = await Process.run(
        npm.first,
        [...npm.skip(1), 'install', '--omit=dev', '--no-audit', '--no-fund'],
        workingDirectory: serverDirectory,
        runInShell: Platform.isWindows && npm.length == 1,
        environment: {
          'PATH':
              '${File(_nodePath!).parent.path}'
              '${Platform.isWindows ? ';' : ':'}${Platform.environment['PATH'] ?? ''}',
        },
      );
      if (r.exitCode != 0) {
        _depsFuture = null; // 失败允许下次重试
        final out = '${r.stderr}${r.stdout}'.trim();
        return '安装服务端依赖失败（npm install 退出码 ${r.exitCode}）。\n'
            '${out.length > 600 ? out.substring(out.length - 600) : out}';
      }
      log.note('依赖装好了。');
      return null;
    } catch (err) {
      _depsFuture = null;
      return '安装服务端依赖失败：$err';
    }
  }

  /// 轮询 `/health`。`watchLog` 为 true 时同时读日志：
  /// 日志里出现进程退出或未捕获异常则立即返回失败，不等超时。
  Future<bool> _waitHealthy(
    String baseUrl,
    Duration waitFor,
    void Function()? onProgress, {
    bool watchLog = false,
  }) async {
    final deadline = DateTime.now().add(waitFor);
    var ticks = 0;
    while (DateTime.now().isBefore(deadline)) {
      if (await serverAlive(
        baseUrl,
        timeout: const Duration(milliseconds: 800),
      )) {
        return true;
      }
      if (watchLog) {
        log.sync();
        if (log.lines.any(
          (l) => l.contains('服务端进程退出') || l.contains('未捕获异常'),
        )) {
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
}

/// `GET /health`：HTTP 成功且响应符合本机服务端身份与就绪规则。
Future<bool> serverAlive(
  String baseUrl, {
  Duration timeout = const Duration(seconds: 2),
}) async {
  final body = await _healthBody(baseUrl, timeout);
  return body != null && isPiBotHealthResponse(body);
}

/// 本机服务端是否开了服务器模式（本机请求也要带 token）。连不上或旧版服务端都算「不要」。
Future<bool> localServerRequiresToken(
  String baseUrl, {
  Duration timeout = const Duration(seconds: 2),
}) async {
  final body = await _healthBody(baseUrl, timeout);
  return body != null &&
      isPiBotHealthResponse(body) &&
      healthRequiresToken(body);
}

/// 读 `/health` 正文（带大小上限和超时）；任何失败都返回 null。
Future<String?> _healthBody(String baseUrl, Duration timeout) async {
  final client = HttpClient()..connectionTimeout = timeout;
  try {
    final req = await client
        .getUrl(Uri.parse('$baseUrl/health'))
        .timeout(timeout);
    final res = await req.close().timeout(timeout);
    if (res.statusCode != 200 || res.contentLength > maxHealthResponseBytes) {
      return null;
    }
    return await readHealthResponseBody(res).timeout(timeout);
  } catch (_) {
    return null;
  } finally {
    client.close(force: true);
  }
}
