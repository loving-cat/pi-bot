// 回归：桌面端与服务端必须用同一个默认数据目录。
//
// 这个 bug 只有在**真机**上才看得出来（Windows 上 Local 与 Roaming 是两个
// 不同的目录，但代码里都写成「AppData 下的 pi-bot」），所以测试直接对着
// 服务端的 config.js 比一遍，而不是硬编码期望值。
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 用 node 读服务端的 userDataDir 结果（不硬编码，跟着实现走）。
Future<String?> _serverDefaultDataDir() async {
  final serverDir = Directory('../server').absolute.path;
  if (!File('$serverDir/src/config.js').existsSync()) return null;
  final node = Platform.environment['PI_BOT_TEST_NODE'] ?? 'node';
  try {
    final res = await Process.run(
      node,
      [
        '--input-type=module',
        '-e',
        // 只读 config.dataDir，不启动任何东西
        "const {config} = await import('./src/config.js');process.stdout.write(config.dataDir);",
      ],
      workingDirectory: serverDir,
      environment: {if (Platform.environment['LOCALAPPDATA'] != null) 'LOCALAPPDATA': Platform.environment['LOCALAPPDATA']!},
      runInShell: true,
    );
    if (res.exitCode != 0) return null;
    final out = (res.stdout as String).trim();
    return out.isEmpty ? null : out;
  } catch (_) {
    return null;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('Windows：桌面端默认数据目录 = 服务端 config.dataDir', () async {
    if (!Platform.isWindows) {
      markTestSkipped('只在 Windows 上有 Local/Roaming 之分');
      return;
    }
    SharedPreferences.setMockInitialValues({});
    final state = AppState();
    addTearDown(state.dispose);

    // 私有方法，只有同库可见；这里通过公开行为验证：
    // 把一个 token 写进**服务端**的目录，然后 connectLocal 应当能读到它。
    final serverDir = await _serverDefaultDataDir();
    if (serverDir == null) {
      markTestSkipped('没有 node 或服务端依赖没装（cd server && npm install），跳过');
      return;
    }
    final tokenFile = File('$serverDir/local-token');
    final existed = tokenFile.existsSync();
    final previous = existed ? tokenFile.readAsStringSync() : null;
    final probe = 'desktop-token-probe-${DateTime.now().microsecondsSinceEpoch}';
    Directory(serverDir).createSync(recursive: true);
    tokenFile.writeAsStringSync(probe);
    addTearDown(() {
      try {
        if (previous != null) {
          tokenFile.writeAsStringSync(previous);
        } else if (tokenFile.existsSync()) {
          tokenFile.deleteSync();
        }
      } catch (_) {}
    });

    // connectLocal 会先问 /health（拿不到就当"本机信任模式"），
    // 然后去候选目录里找 token。这里不打网络，直接看它有没有把
    // localToken 填上 —— 用不到服务的接口。
    await state.connectLocal(url: 'http://127.0.0.1:1');
    expect(
      state.localToken,
      probe,
      reason: '桌面端读不到服务端写的 local-token：两边默认数据目录不一致 '
          '（Windows 上是 LOCALAPPDATA vs APPDATA）',
    );
  });
}
