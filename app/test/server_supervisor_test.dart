import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/server/launcher.dart';
import 'package:pi_bot/server/locate.dart';
import 'package:pi_bot/server/options.dart';
import 'package:pi_bot/server/supervisor.dart';

const _fixture = r'''
const http = require('node:http');
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ok: true, serverName: 'pi-bot fixture', version: '1.0.0',
    port: process.env.PI_BOT_PORT,
    data: process.env.PI_BOT_HOME, entry: __filename}));
});
server.listen(Number(process.env.PI_BOT_PORT), '127.0.0.1');
process.on('SIGTERM', () => {
  if (process.env.IGNORE_TERM) return;
  setTimeout(() => server.close(() => process.exit(0)),
    Number(process.env.STOP_DELAY || 0));
});
''';

Future<int> _freePort() async {
  final socket = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
  final port = socket.port;
  await socket.close();
  return port;
}

Future<void> _waitHealthy(String url) async {
  // CI 的 Windows runner 起进程比本机慢不少（wscript → vbs → node），
  // 5 秒会偶发不够；这里给到 20 秒，失败时仍然是“服务端真没起来”。
  final deadline = DateTime.now().add(const Duration(seconds: 20));
  while (DateTime.now().isBefore(deadline)) {
    if (await serverAlive(url)) return;
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
  fail('测试子进程未就绪');
}

Future<Map<String, dynamic>> _health(String url) async {
  final client = HttpClient();
  try {
    final response = await (await client.getUrl(Uri.parse('$url/health')))
        .close();
    return jsonDecode(await utf8.decoder.bind(response).join())
        as Map<String, dynamic>;
  } finally {
    client.close(force: true);
  }
}

/// Windows 上子进程刚被杀时，日志/pid 文件的句柄可能还没释放，
/// 立即递归删临时目录会报“另一个程序正在使用此文件”（errno 32）。
/// 等一会儿重试，别让用例因为收尾而假失败。
Future<void> _deleteWithRetry(Directory dir, {int attempts = 100}) async {
  for (var i = 0; i < attempts; i++) {
    try {
      dir.deleteSync(recursive: true);
      return;
    } on FileSystemException {
      if (i == attempts - 1) rethrow;
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
  }
}

void main() {
  late Directory temp;
  late String node;
  late ServerSupervisor supervisor;

  setUpAll(() async {
    node = (await findNode(Directory.current.path))!;
  });

  setUp(() {
    temp = Directory.systemTemp.createTempSync('pi-bot-supervisor-');
    supervisor = ServerSupervisor(temp);
  });

  tearDown(() async {
    final pid = supervisor.readPid();
    if (pid != null) {
      Process.killPid(pid, ProcessSignal.sigkill);
      await supervisor.stop();
    }
    await _deleteWithRetry(temp);
  });

  Future<String> start({Map<String, String> extra = const {}}) async {
    final port = await _freePort();
    final script = File('${temp.path}/fixture.cjs')
      ..writeAsStringSync(_fixture);
    final process = await supervisor.spawn(
      nodePath: node,
      entryPath: script.path,
      serverDir: temp.path,
      logPath: '${temp.path}/server.log',
      extraEnv: {
        'PI_BOT_PORT': '$port',
        'PI_BOT_HOME': '${temp.path}/data',
        ...extra,
      },
    );
    unawaited(process.stdout.drain<void>());
    unawaited(process.stderr.drain<void>());
    expect(await process.exitCode, 0);
    final url = 'http://127.0.0.1:$port';
    await _waitHealthy(url);
    return url;
  }

  test('独立服务端接收端口与目录，启动器退出后仍可连接', () async {
    final url = await start();
    final health = await _health(url);
    expect(health['port'], '${Uri.parse(url).port}');
    expect(health['data'], '${temp.path}/data');
    expect(supervisor.readPid(), isNotNull);
    await supervisor.stop();
    expect(await serverAlive(url), isFalse);
    expect(supervisor.pidFile.existsSync(), isFalse);
  });

  test('已有服务端没有受管 pid 时明确拒绝自动重启', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((request) {
      request.response.write(
        '{"ok":true,"serverName":"pi-bot","version":"1.0.0"}',
      );
      unawaited(request.response.close());
    });
    final url = 'http://127.0.0.1:${server.port}';
    final launcher = LocalServerLauncher(stateDir: temp);
    expect((await launcher.ensureRunning(baseUrl: url)).alreadyRunning, isTrue);
    await expectLater(launcher.stop(), throwsStateError);
    expect(await serverAlive(url), isTrue);
  });

  test('停止等待 SIGTERM 收尾，返回后原端口已经释放', () async {
    final url = await start(extra: {'STOP_DELAY': '250'});
    final watch = Stopwatch()..start();
    await supervisor.stop();
    expect(watch.elapsedMilliseconds, greaterThanOrEqualTo(200));
    final socket = await ServerSocket.bind('127.0.0.1', Uri.parse(url).port);
    await socket.close();
  }, skip: Platform.isWindows ? 'Windows 使用 taskkill 强制结束' : false);

  test('停止超时明确失败并保留 pid，不误报服务已退出', () async {
    final url = await start(extra: {'IGNORE_TERM': '1'});
    await expectLater(
      supervisor.stop(timeout: const Duration(milliseconds: 120)),
      throwsStateError,
    );
    expect(supervisor.pidFile.existsSync(), isTrue);
    expect(await serverAlive(url), isTrue);
  }, skip: Platform.isWindows ? 'Windows 使用 taskkill 强制结束' : false);

  test('切换启动配置清理定位缓存，再次安装新目录的依赖', () async {
    final first = File('${temp.path}/first/src/index.cjs');
    first.parent.createSync(recursive: true);
    first.writeAsStringSync(_fixture);
    Directory('${first.parent.parent.path}/node_modules').createSync();
    final port = await _freePort();
    final url = 'http://127.0.0.1:$port';
    final launcher = LocalServerLauncher(
      stateDir: temp,
      options: ServerLaunchOptions(
        entryPath: first.path,
        nodePath: node,
        port: port,
      ),
    );
    expect((await launcher.ensureRunning(baseUrl: url)).ok, isTrue);
    expect(launcher.serverDir, first.parent.parent.path);
    await launcher.stop();
    launcher.options = ServerLaunchOptions(port: port);
    expect(launcher.serverDir, isNull);
    expect(launcher.nodePath, isNull);

    final second = File('${temp.path}/second/src/index.cjs');
    second.parent.createSync(recursive: true);
    second.writeAsStringSync(_fixture);
    File('${second.parent.parent.path}/package.json')
        .writeAsStringSync('{"private":true}');
    launcher.options = ServerLaunchOptions(
      entryPath: second.path,
      nodePath: node,
      dataDir: '${temp.path}/new data',
      port: port,
    );
    final result = await launcher.ensureRunning(baseUrl: url);
    expect(result.ok, isTrue, reason: result.error);
    final health = await _health(url);
    // 服务端报回来的是 Node 眼里的 __filename。GitHub 的 Windows runner
    // 用户目录是 8.3 短名（RUNNER~1），和 resolveSymbolicLinks 得到的长名
    // 指向同一个文件 —— 比规范化后的路径，别比字符串。
    expect(
      File('${health['entry']}').resolveSymbolicLinksSync(),
      second.resolveSymbolicLinksSync(),
    );
    expect(health['data'], '${temp.path}/new data');
    expect(
      File('${second.parent.parent.path}/package-lock.json').existsSync(),
      isTrue,
    );
    await launcher.stop();
    // CI 的 Windows runner 上要起两次 node + 跑一次 npm install，
    // 默认 30s 的用例超时会偶发不够，所以放宽到 3 分钟。
  }, timeout: const Timeout(Duration(minutes: 3)));
}
