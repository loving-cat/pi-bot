// 无边框窗口的八向缩放热区。
//
// 背景：`setAsFrameless()` 之后 Windows 不再给边框做命中测试，四个边、四个角
// 全拖不动（用户报的"窗口不能放大缩小"）。修法是在窗口四周铺透明热区，
// 把拖动转给 windowManager.startResizing —— 八个方向一个都不能少、也不能写错，
// 而写错了只表现为"某个方向拖不动"，肉眼很难一个个试出来。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/widgets/window_title_bar.dart';
import 'package:window_manager/window_manager.dart';

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

  group('resizeBy：拖动后的窗口矩形', () {
    const start = Rect.fromLTWH(100, 100, 800, 600);
    const min = Size(400, 300);

    Rect go(ResizeEdge e, Offset d) =>
        resizeBy(start: start, delta: d, edge: e, minSize: min);

    test('抓右下角：只动右下，左上角不许漂', () {
      final r = go(ResizeEdge.bottomRight, const Offset(50, 30));
      expect(r, const Rect.fromLTWH(100, 100, 850, 630));
    });

    test('抓左上角：只动左上', () {
      final r = go(ResizeEdge.topLeft, const Offset(50, 30));
      expect(r, const Rect.fromLTWH(150, 130, 750, 570));
    });

    test('抓右边：高度一点都不能变', () {
      final r = go(ResizeEdge.right, const Offset(50, 999));
      expect(r.height, 600);
      expect(r.width, 850);
    });

    test('抓下边：宽度一点都不能变', () {
      final r = go(ResizeEdge.bottom, const Offset(999, 30));
      expect(r.width, 800);
      expect(r.height, 630);
    });

    test('顶到最小尺寸：被拖的那条边卡住，另一条边不动', () {
      // 抓右边往左拖过头 → 右边停在 100+400，左边还是 100
      final r = go(ResizeEdge.right, const Offset(-900, 0));
      expect(r.left, 100, reason: '左上角不该跟着跑');
      expect(r.width, 400);
    });

    test('抓左上角顶到最小尺寸：左边跟着走，右边不动', () {
      final r = go(ResizeEdge.topLeft, const Offset(900, 900));
      expect(r.right, 900, reason: '右下角不该跟着跑');
      expect(r.width, 400);
      expect(r.height, 300);
    });

    test('抓右边时 y 方向完全不影响', () {
      expect(go(ResizeEdge.right, const Offset(10, -500)).top, 100);
    });
  });

  group('screenDelta：拖上/左边时窗口会自己移动，位移要补偿', () {
    // ★ 这条钉的是一个 P0：不做补偿的话，拖上边缘会**不断抽搐** ——
    //   因为指针的"视口坐标"被窗口自身的移动抵消了，算出来位移≈0，
    //   窗口弹回原尺寸、下一次又反向，来回抖。
    const start = Rect.fromLTWH(100, 100, 800, 600);

    test('拖下边（窗口没动）→ 视口位移就是屏幕位移', () {
      const last = Rect.fromLTWH(100, 100, 800, 700); // 高度变了，左上角没动
      expect(
        screenDelta(
          viewDelta: const Offset(0, 50),
          startBounds: start,
          lastBounds: last,
        ),
        const Offset(0, 50),
      );
    });

    test('★ 拖上边：窗口上移 30 之后，视口位移被抵消了，必须补回来', () {
      const last = Rect.fromLTWH(100, 70, 800, 630); // 上移 30、变高 30
      // 指针在屏幕上往上挪了 30；但窗口也跟着上移 30 →
      // 它的"视口坐标"几乎没变（这就是抽搐的根源）
      const viewDelta = Offset(0, 0);
      final d = screenDelta(
        viewDelta: viewDelta,
        startBounds: start,
        lastBounds: last,
      );
      expect(d, const Offset(0, -30), reason: '补上窗口自身的位移');
    });

    test('★ 拖左边同理', () {
      const last = Rect.fromLTWH(70, 100, 830, 600);
      final d = screenDelta(
        viewDelta: Offset.zero,
        startBounds: start,
        lastBounds: last,
      );
      expect(d, const Offset(-30, 0));
    });

    test('★ 补偿之后，算出来的始终是"屏幕上的累计位移"', () {
      // 这正是 resizeBy 需要的量（它是以 startBounds 为基准算的）。
      // 不做补偿时，窗口自身移动了多少就少算多少 —— 拖上边时恰好被抵消掉，
      // 于是位移≈0、窗口弹回、下一帧反向 = 抽搐。
      const screenTotal = Offset(0, -30); // 指针在屏幕上累计往上 30
      const windowMove = Offset(0, -30); // 窗口也跟着上移了 30（我们设的）
      final viewDelta = screenTotal - windowMove; // 所以视口内几乎没动
      final d = screenDelta(
        viewDelta: viewDelta,
        startBounds: start,
        lastBounds: start.shift(windowMove),
      );
      expect(d, screenTotal, reason: '补回来之后就是真正的屏幕位移，与窗口是否移动无关');
    });
  });
}
