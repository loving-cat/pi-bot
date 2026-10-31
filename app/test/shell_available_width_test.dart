// 窗口缩放后"内容超出"的真实成因候选：**布局预算用的宽度 ≠ 实际可用宽度**。
//
// HomeShell 用 MediaQuery.sizeOf(context).width 当总宽做分配。
// 但它在树里并不是占满那个宽度的那一层 —— 外面还套着
//   Column([WindowTitleBar, Expanded(HomeShell)])
// 以及 Root/Scaffold。只要两者差哪怕几像素，按 MediaQuery 算出来的
// "刚好放得下"在实际排版时就是"放不下"，表现为内容被切 / 溢出。
//
// 这里不同 dpr、不同宽度下量：
//   HomeShell 拿到的约束宽度 vs MediaQuery 报的宽度，两者必须相等。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/screens/home_shell.dart';
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

Future<void> _pumpLogical(
  WidgetTester tester,
  Size logical, {
  required double dpr,
}) async {
  tester.view.devicePixelRatio = dpr;
  tester.view.physicalSize = Size(logical.width * dpr, logical.height * dpr);
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
}

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  for (final dpr in [1.0, 1.25, 1.5]) {
    testWidgets('★★ dpr=$dpr：HomeShell 的可用宽度必须等于它拿来算的宽度', (tester) async {
      addTearDown(tester.view.reset);
      final state = _stateWith([_room('r1', '甲')]);
      addTearDown(state.dispose);
      state.layoutLeftWidth = 480;
      state.layoutRightWidth = 560;
      state.panelOpen = true;

      await tester.pumpWidget(
        AppScope(state: state, child: const MaterialApp(home: HomeShell())),
      );

      for (final w in [1400.0, 1100.0, 900.0, 800.0]) {
        await _pumpLogical(tester, Size(w, 800), dpr: dpr);

        final shellFinder = find.byType(HomeShell);
        if (shellFinder.evaluate().isEmpty) continue;

        final shellBox = tester.renderObject<RenderBox>(shellFinder.first);
        // HomeShell 实际可用的宽（由父级约束决定）
        final actual = shellBox.size.width;

        // 它内部拿来算预算的那个值
        final ctx = tester.element(shellFinder.first);
        final mediaWidth = MediaQuery.sizeOf(ctx).width;

        expect(
          (actual - mediaWidth).abs(),
          lessThan(1.0),
          reason:
              'dpr=$dpr 窗口宽 $w：HomeShell 实际只有 $actual，'
              '但按 MediaQuery 的 $mediaWidth 分配宽度 —— '
              '差出来的这部分会让内容溢出/被切',
        );
      }
    });
  }
}
