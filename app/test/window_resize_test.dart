// 无边框窗口的八向缩放热区。
//
// 背景：`setAsFrameless()` 之后 Windows 不再给边框做命中测试，四个边、四个角
// 全拖不动（用户报的"窗口不能放大缩小"）。修法是在窗口四周铺透明热区，
// 把拖动转给 windowManager.startResizing —— 八个方向一个都不能少、也不能写错，
// 而写错了只表现为"某个方向拖不动"，肉眼很难一个个试出来。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/widgets/window_title_bar.dart';

void main() {
  testWidgets('八个缩放热区都在，且方向光标各不相同', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: WindowResizeOverlay())),
    );
    await tester.pump();

    final cursors = tester
        .widgetList<MouseRegion>(
          find.descendant(
            of: find.byType(WindowResizeOverlay),
            matching: find.byType(MouseRegion),
          ),
        )
        .map((m) => m.cursor)
        .toSet();

    expect(cursors.length, 8, reason: '四角 + 四边，一个都不能少');
    expect(cursors, {
      SystemMouseCursors.resizeUpLeft,
      SystemMouseCursors.resizeUp,
      SystemMouseCursors.resizeUpRight,
      SystemMouseCursors.resizeRight,
      SystemMouseCursors.resizeDownRight,
      SystemMouseCursors.resizeDown,
      SystemMouseCursors.resizeDownLeft,
      SystemMouseCursors.resizeLeft,
    });
  });

  testWidgets('热区只贴在边上，中间不挡点击', (tester) async {
    var tapped = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Stack(
            children: [
              Positioned.fill(
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () => tapped++,
                  child: const ColoredBox(color: Colors.black),
                ),
              ),
              const Positioned.fill(child: WindowResizeOverlay()),
            ],
          ),
        ),
      ),
    );
    await tester.pump();

    // 正中间：应该穿到下面的内容上
    await tester.tapAt(tester.getCenter(find.byType(WindowResizeOverlay)));
    expect(tapped, 1, reason: '热区不能挡住窗口中间的操作');
  });
}
