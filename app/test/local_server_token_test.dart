// 桌面端遇到「服务器模式」的本机服务端：不再拿空 token 一直重连。
// 用真实的服务端（子进程）+ 真实的 AppState，不打桩网络。
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/server/locate.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 起一个带 HTTP + WS 的服务端子进程；返回端口和关闭函数。
/// 找不到 node 或服务端依赖没装（server/node_modules 不存在）时返回 null，用例跳过。
///
/// 脚本写成临时 .mjs 文件再跑：多行脚本经 `node -e` 传参在 Windows 上的引号处理不可靠。
Future<({int port, Future<void> Function() stop})?> _startServer(
  Map<String, String> env,
) async {
  final serverDir = Directory('../server').absolute.path;
  if (!File('$serverDir/src/http.js').existsSync()) return null;
  if (!Directory('$serverDir/node_modules').existsSync()) return null;
  final node = await findNode(Directory.current.path);
  if (node == null) return null;
  final home = Directory.systemTemp.createTempSync('pi-bot-app-server-mode-');
  final script = File('$serverDir/.local-token-test-${home.path.hashCode}.mjs');
  script.writeAsStringSync('''
const { createHttpServer } = await import('./src/http.js');
const { attachWs } = await import('./src/ws.js');
const { Pairing } = await import('./src/pairing.js');
const runner = { availableModels: [], modelLabel: () => null, initNote: null, contextUsage: () => ({}) };
const server = createHttpServer({ runner, pairing: new Pairing() });
attachWs(server, { runner });
server.listen(0, '127.0.0.1', () => process.stdout.write('PORT ' + server.address().port + '\\n'));
''');
  final proc = await Process.start(
    node,
    [script.path],
    workingDirectory: serverDir,
    environment: {...env, 'PI_BOT_HOME': home.path},
  );
  final port = Completer<int>();
  final err = StringBuffer();
  proc.stdout.transform(utf8.decoder).listen((s) {
    final m = RegExp(r'PORT (\d+)').firstMatch(s);
    if (m != null && !port.isCompleted) port.complete(int.parse(m.group(1)!));
  });
  proc.stderr.transform(utf8.decoder).listen(err.write);
  unawaited(
    proc.exitCode.then((code) {
      if (!port.isCompleted) {
        port.completeError(StateError('服务端退出 code=$code：$err'));
      }
    }),
  );
  final p = await port.future.timeout(const Duration(seconds: 20));
  return (
    port: p,
    stop: () async {
      proc.kill();
      await proc.exitCode.timeout(
        const Duration(seconds: 5),
        onTimeout: () => -1,
      );
      for (final f in [script, home]) {
        try {
          f.deleteSync(recursive: true);
        } catch (_) {}
      }
    },
  );
}

Future<void> _waitFor(bool Function() ok, String what) async {
  final deadline = DateTime.now().add(const Duration(seconds: 15));
  while (DateTime.now().isBefore(deadline)) {
    if (ok()) return;
    await Future<void>.delayed(const Duration(milliseconds: 100));
  }
  fail('等待超时：$what');
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  // 这里要连真实的本机服务端
  setUpAll(() => HttpOverrides.global = null);

  test('服务器模式：没填 token 时停在「需要 token」，不发请求、不重连', () async {
    final server = await _startServer({'PI_BOT_TOKEN': 'app-test-token'});
    if (server == null) {
      markTestSkipped('没有 node 或服务端依赖没装（cd server && npm install），跳过');
      return;
    }
    addTearDown(server.stop);
    SharedPreferences.setMockInitialValues({});
    final state = AppState();
    addTearDown(state.dispose);

    await state.connectLocal(url: 'http://127.0.0.1:${server.port}');
    expect(state.localNeedsToken, isTrue);
    expect(state.link, LinkState.offline);
    expect(state.serverProblem, AppState.localTokenHint);
  });

  test('服务器模式：填对 token 后连上；token 存下来，下次直接用', () async {
    final server = await _startServer({'PI_BOT_TOKEN': 'app-test-token'});
    if (server == null) {
      markTestSkipped('没有 node 或服务端依赖没装（cd server && npm install），跳过');
      return;
    }
    addTearDown(server.stop);
    SharedPreferences.setMockInitialValues({});
    final state = AppState();
    addTearDown(state.dispose);

    await state.connectLocal(url: 'http://127.0.0.1:${server.port}');
    // setLocalToken 会按默认地址重连；测试里把地址固定成子进程的端口
    state.serverPort = server.port;
    await state.setLocalToken('app-test-token');
    await _waitFor(() => state.link == LinkState.online, 'WS 连上');
    expect(state.serverProblem, isNull);

    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString('local_server_token'), 'app-test-token');
  });

  test('服务器模式：token 填错→说清楚「token 不对」，清掉存的，不重连', () async {
    final server = await _startServer({'PI_BOT_TOKEN': 'app-test-token'});
    if (server == null) {
      markTestSkipped('没有 node 或服务端依赖没装（cd server && npm install），跳过');
      return;
    }
    addTearDown(server.stop);
    SharedPreferences.setMockInitialValues({});
    final state = AppState();
    addTearDown(state.dispose);

    state.serverPort = server.port;
    await state.connectLocal(url: 'http://127.0.0.1:${server.port}');
    await state.setLocalToken('wrong-token');
    expect(state.serverProblem, AppState.localTokenRejected);
    expect(state.localToken, isEmpty, reason: '错的 token 不该留着');
    expect(state.link, LinkState.offline);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString('local_server_token'), isNull);
  });

  test('本机部署：照旧不带 token 直连', () async {
    final server = await _startServer({});
    if (server == null) {
      markTestSkipped('没有 node 或服务端依赖没装（cd server && npm install），跳过');
      return;
    }
    addTearDown(server.stop);
    SharedPreferences.setMockInitialValues({});
    final state = AppState();
    addTearDown(state.dispose);

    await state.connectLocal(url: 'http://127.0.0.1:${server.port}');
    expect(state.localNeedsToken, isFalse);
    await _waitFor(() => state.link == LinkState.online, 'WS 连上');
  });
}
