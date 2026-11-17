// 手机端「连接」页：连上之后还能不能换一台电脑。
//
// 这条要求的来历（真实事故）：这块内容原来嵌在宿主端的条件
// `if (isHostPlatform && pairing != null)` 里面，对手机恒为 false，
// 于是设置里从来没见过"换一台电脑"—— 用户连上一次之后就再也换不了电脑。
// 单靠"在真机上点一遍"发现不了，所以这里把它单独 pump 起来守。
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/l10n/l10n.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/screens/pair_screen.dart';
import 'package:pi_bot/theme.dart';
import 'package:pi_bot/widgets/mobile_connect_section.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _State extends AppState {
  _State({String? url, String? token, String fingerprint = ''}) {
    serverUrl = url;
    this.token = token;
    serverFingerprint = fingerprint;

  }
}

Future<void> _pump(WidgetTester tester, AppState state) async {
  await tester.pumpWidget(
    AppScope(
      state: state,
      child: L10n(
        controller: LocaleController(),
        child: MaterialApp(
          theme: PB.theme(),
          home: Scaffold(
            body: SingleChildScrollView(child: MobileConnectSection()),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('★ 连上一台电脑后，"换一台电脑"的入口必须在', (tester) async {
    final state = _State(url: 'https://192.168.1.7:8443', token: 't_abc', fingerprint: 'ab' * 32);
    addTearDown(state.dispose);
    await _pump(tester, state);

    expect(find.text('已连接的服务端'), findsOneWidget);
    expect(find.text('https://192.168.1.7:8443'), findsOneWidget);
    expect(find.text('换一台电脑'), findsOneWidget, reason: '没有它，用户连上一次就再也换不了电脑');
  });

  testWidgets('加密链路要写"已加密"并给出 6 位校验码', (tester) async {
    final state = _State(url: 'https://192.168.1.7:8443', token: 't', fingerprint: 'ab' * 32);
    addTearDown(state.dispose);
    await _pump(tester, state);

    expect(find.textContaining('已加密'), findsOneWidget);
    expect(find.textContaining('ABABAB'), findsOneWidget, reason: '校验码是给人念着对一遍的');
  });

  testWidgets('明文链路要明确警告，不能假装安全', (tester) async {
    final state = _State(url: 'http://192.168.1.7:8787', token: 't');
    addTearDown(state.dispose);
    await _pump(tester, state);

    expect(find.textContaining('未加密'), findsOneWidget);
    expect(find.textContaining('校验码'), findsNothing);
  });

  testWidgets('点"换一台电脑"打开的是配对页（附近列表），不是直接断开', (tester) async {
    final state = _State(url: 'https://192.168.1.7:8443', token: 't', fingerprint: 'ab' * 32);
    addTearDown(state.dispose);
    await _pump(tester, state);

    await tester.tap(find.text('换一台电脑'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.byType(PairScreen), findsOneWidget);
    // 关键：点进去时还没断开（断开是连上新电脑之后的事）
    expect(state.serverUrl, 'https://192.168.1.7:8443');
  });

  // 上面那几个用例是"把 widget 单独 pump 起来"，抓不到**它有没有被接进设置页**。
  // 真正踩过的坑恰恰是接线：这块被嵌在 `if (isHostPlatform && pairing != null)`
  // 里面，widget 本身没错，但手机上永远不渲染。所以这里直接看源码接线。
  group('接线（防止再被嵌进宿主端条件里）', () {
    test('SettingsScreen 里 MobileConnectSection 由 !isHostPlatform 包着', () {
      final source = File('lib/screens/settings_screen.dart').readAsStringSync();
      final index = source.indexOf('MobileConnectSection()');
      expect(index, greaterThan(0), reason: '设置页里必须用它');

      // 往前找最近的 `if (` 行，必须是手机端那个条件
      final before = source.substring(0, index);
      final lastIf = before.lastIndexOf('if (');
      expect(lastIf, greaterThan(0));
      final condition = before.substring(lastIf).split(String.fromCharCode(10)).first;
      expect(
        condition.replaceAll(' ', ''),
        contains('if(!isHostPlatform)'),
        reason: '被 isHostPlatform 之类的条件包住 = 手机上永远不显示（真实事故）',
      );
    });
  });
}
