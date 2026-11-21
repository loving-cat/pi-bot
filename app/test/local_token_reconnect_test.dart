import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/server/local_token.dart';
import 'package:pi_bot/server/options.dart';

/// 本机 token 的生命周期（回归：服务端重启后桌面端一直 401 转圈）。
///
/// 服务端**每次启动**都换一个 local-token（`server/src/local-token.js`）。
/// 桌面端如果只在 connectLocal 里读一次文件，服务端一重启手里的 token 就作废：
/// 之后每次重连都是 401，界面「离线 · 自动重连中」无限转圈，
/// 服务端日志里连「已连接」都没有（握手就拒了）—— 看起来像"服务端没开"。
void main() {
  late Directory dir;

  setUp(() {
    dir = Directory.systemTemp.createTempSync('orbis-token-');
  });

  tearDown(() {
    try {
      dir.deleteSync(recursive: true);
    } catch (_) {}
  });

  File tokenFile() => File('${dir.path}/local-token');

  group('同步读取（重连路径用）', () {
    test('读到就去掉尾部换行', () {
      tokenFile().writeAsStringSync('abc123\n');
      expect(readLocalTokenFileSync(dir.path), 'abc123');
    });

    test('文件不存在 / 空文件 / 目录为空 → null（不抛）', () {
      expect(readLocalTokenFileSync(dir.path), isNull);
      tokenFile().writeAsStringSync('   \n');
      expect(readLocalTokenFileSync(dir.path), isNull);
      expect(readLocalTokenFileSync(null), isNull);
      expect(readLocalTokenFileSync(''), isNull);
    });

    test('候选目录按顺序取第一个命中的', () {
      final second = Directory.systemTemp.createTempSync('orbis-token2-');
      addTearDown(() => second.deleteSync(recursive: true));
      File('${second.path}/local-token').writeAsStringSync('second');
      expect(
        readLocalTokenFromCandidatesSync([
          '${dir.path}/nope',
          second.path,
        ]),
        'second',
      );
    });
  });

  group('AppState.refreshLocalTokenFromDisk', () {
    AppState mkState() {
      final state = AppState();
      state.localMode = true;
      state.serverUrl = 'http://127.0.0.1:8787';
      state.serverLauncher.options = ServerLaunchOptions(dataDir: dir.path);
      // 钉死候选目录：否则会读到跑测试这台机器上真实的 local-token
      state.localTokenDirsOverride = [dir.path];
      return state;
    }

    test('服务端重启换了 token → 重连前跟上新值', () {
      tokenFile().writeAsStringSync('tok-old\n');
      final state = mkState();

      // 首次：手里没有 → 采纳文件里的
      expect(state.refreshLocalTokenFromDisk(), isTrue);
      expect(state.token, 'tok-old');
      // 没变 → 不动
      expect(state.refreshLocalTokenFromDisk(), isFalse);

      // 服务端重启：文件里是新 token（手里的那份是文件给的，可以覆盖）
      tokenFile().writeAsStringSync('tok-new\n');
      expect(state.refreshLocalTokenFromDisk(), isTrue);
      expect(state.localToken, 'tok-new');
      expect(state.token, 'tok-new');
      // 幂等：同一份文件再读一次不该重复重建
      expect(state.refreshLocalTokenFromDisk(), isFalse);
    });

    test('用户/调用方显式设的 token 不会被磁盘文件抢走', () {
      tokenFile().writeAsStringSync('from-file\n');
      final state = mkState()
        ..localToken = 'injected'
        ..token = 'injected';
      expect(state.refreshLocalTokenFromDisk(), isFalse);
      expect(state.token, 'injected');
    });

    test('读不到文件就保留手里的（服务端还没写好时不能把 token 抹了）', () {
      final state = mkState()
        ..localToken = 'tok-old'
        ..token = 'tok-old';
      expect(state.refreshLocalTokenFromDisk(), isFalse);
      expect(state.token, 'tok-old');
    });

    test('服务器模式（用户填了 ORBIS_TOKEN）不许被 local-token 覆盖', () {
      tokenFile().writeAsStringSync('from-file\n');
      final state = mkState()
        ..localNeedsToken = true
        ..localToken = 'user-typed'
        ..token = 'user-typed';
      expect(state.refreshLocalTokenFromDisk(), isFalse);
      expect(state.localToken, 'user-typed');
      expect(state.token, 'user-typed');
    });
  });
}
