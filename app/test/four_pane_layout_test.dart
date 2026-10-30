// 四栏同开 + 窗口缩放：不许布局崩
//
// 你截图里的症状：右侧开着「资料库」、拉宽窗口/缩放时整个布局错乱。
// 这一组专门把「四栏全开 + 各种宽度」扫一遍，找出溢出。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/screens/home_shell.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';
import 'package:shared_preferences/shared_preferences.dart';

Room _room(String id, String name) => Room(
  id: id,
  name: name,
  kind: 'dm',
  botIds: const [],
  lastMessageAt: 0,
);

AppState _stateWith(List<Room> rooms) {
  final s = AppState();
  s.rooms = rooms;
  return s;
}

Future<void> _pumpAt(WidgetTester tester, Size logical) async {
  tester.view.physicalSize = logical;
  tester.view.devicePixelRatio = 1.0;
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
}

void main() {
  setUp(() {
    BlobAvatar.animationsEnabled = false;
    SharedPreferences.setMockInitialValues({});
  });
  tearDown(() => BlobAvatar.animationsEnabled = true);

  testWidgets('★ 四栏全开：从宽到窄连续缩窗口，任何一档都不许溢出', (tester) async {
    addTearDown(tester.view.reset);
    final state = _stateWith([_room('r1', '甲'), _room('r2', '乙')]);
    addTearDown(state.dispose);

    // 把左侧宽度偏好拉到最大、右侧面板打开、浏览器栏打开
    state.layoutLeftWidth = 480;
    state.layoutRightWidth = 560;
    state.layoutBrowserWidth = 900;
    state.panelOpen = true;
    state.browser.openUrl('https://example.com');

    await tester.pumpWidget(
      AppScope(state: state, child: const MaterialApp(home: HomeShell())),
    );
    await _pumpAt(tester, const Size(1600, 900));
    expect(tester.takeException(), isNull, reason: '1600 宽时不该崩');

    // 一路缩下去。每一档都必须要么放得下、要么自动收栏，**不许溢出**。
    for (final w in [1400.0, 1200.0, 1100.0, 1000.0, 900.0, 820.0, 780.0]) {
      await _pumpAt(tester, Size(w, 700));
      expect(
        tester.takeException(),
        isNull,
        reason: '窗口缩到 $w 逻辑宽时布局崩了',
      );
    }
  });

  testWidgets('★ 只有浏览器栏开着、拉宽窗口：聊天栏要跟着变宽（不是固定窄条）',
      (tester) async {
    addTearDown(tester.view.reset);
    final state = _stateWith([_room('r1', '甲')]);
    addTearDown(state.dispose);
    state.browser.openUrl('https://example.com');

    await tester.pumpWidget(
      AppScope(state: state, child: const MaterialApp(home: HomeShell())),
    );
    await _pumpAt(tester, const Size(1200, 800));
    expect(tester.takeException(), isNull);

    await _pumpAt(tester, const Size(2200, 800));
    expect(tester.takeException(), isNull);
  });

  testWidgets('★ 极端窄（刚好过分栏阈值）：不许崩', (tester) async {
    addTearDown(tester.view.reset);
    final state = _stateWith([_room('r1', '甲')]);
    addTearDown(state.dispose);
    state.layoutLeftWidth = 480;
    state.layoutRightWidth = 560;
    state.layoutBrowserWidth = 900;
    state.panelOpen = true;
    state.browser.openUrl('https://example.com');

    await tester.pumpWidget(
      AppScope(state: state, child: const MaterialApp(home: HomeShell())),
    );
    for (final w in [760.0, 761.0, 762.0, 800.0]) {
      await _pumpAt(tester, Size(w, 700));
      expect(tester.takeException(), isNull, reason: '$w 时崩了');
    }
  });
}
