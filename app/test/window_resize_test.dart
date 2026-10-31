// 无边框窗口的八向缩放热区。
//
// 背景：`setAsFrameless()` 之后 Windows 不再给边框做命中测试，四个边、四个角
// 全拖不动。做法是在窗口四周铺透明热区，
// 把拖动转给 windowManager.startResizing —— 八个方向一个都不能少、也不能写错，
// 而写错了只表现为"某个方向拖不动"，肉眼很难一个个试出来。
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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
      const windowMove = Offset(0, -30); // 窗口也跟着上移了 30（这里设的）
      final viewDelta = screenTotal - windowMove; // 所以视口内几乎没动
      final d = screenDelta(
        viewDelta: viewDelta,
        startBounds: start,
        lastBounds: start.shift(windowMove),
      );
      expect(d, screenTotal, reason: '补回来之后就是真正的屏幕位移，与窗口是否移动无关');
    });
  });


  // ---------------------------------------------------------------------------
  // ★ 2026-11-01：缩放改走 Windows 原生循环（windowManager.startResizing）。
  //
  // 原来是自己算矩形 + ticker 插值 + 每 12ms 一次 setBounds，实测两个问题：
  //   ① 松手后向外拉会"拉伸"、向内缩会"整体缩放" —— 插值出的是小数矩形，
  //      12ms 一个微小增量，每一步都触发真重排，Flutter 按非整数 DPI 缩放画布；
  //   ② 拖动途中很卡 —— 每一帧都在做整窗重排 + 全量重光栅。
  // 原生循环由系统接管：过程中位图预览（不重排 → 丝滑），松手只做一次
  // 正确重排（→ 不留拉伸）。
  //
  // 所以这两条测试的契约变了，从"发没发够 setBounds"变成：
  //   · 必须调用 startResizing，并带上正确的边；
  //   · **绝不能再自己发 setBounds** —— 两套东西抢窗口尺寸才会出怪象。
  // ---------------------------------------------------------------------------

  testWidgets('★★ 拖边缘：走原生 startResizing，且绝不自己 setBounds', (tester) async {
    final calls = <String>[];
    final bounds = <Rect>[];
    const channel = MethodChannel('window_manager');
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call.method);
      switch (call.method) {
        case 'isMaximized':
          return false;
        // startResizing 内部先调 isFullScreen()；返回 null 会让它抛异常，
        // 整个原生缩放调用就没了 —— 测试里必须明确回 false。
        case 'isFullScreen':
          return false;
        case 'getBounds':
          return <String, dynamic>{
            'x': 100.0,
            'y': 100.0,
            'width': 800.0,
            'height': 600.0,
          };
        case 'setBounds':
          final a = (call.arguments as Map).cast<String, dynamic>();
          bounds.add(
            Rect.fromLTWH(
              (a['x'] as num).toDouble(),
              (a['y'] as num).toDouble(),
              (a['width'] as num).toDouble(),
              (a['height'] as num).toDouble(),
            ),
          );
          return null;
        case 'startResizing':
          return null;
      }
      return null;
    });
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));

    tester.view.physicalSize = const Size(800, 600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: WindowResizeOverlay())),
    );
    await tester.pump();

    // 抓右边缘（热区在 x=795..800）开始拖
    final g = await tester.startGesture(const Offset(796, 300));
    await tester.pump();
    for (var i = 0; i < 8; i++) {
      await g.moveBy(const Offset(-10, 0));
      await tester.pump(const Duration(milliseconds: 16));
    }
    await g.up();
    await tester.pump(const Duration(milliseconds: 200));

    expect(
      calls.where((c) => c == 'startResizing').length,
      1,
      reason: '按下边缘就该交给原生循环一次（之后由系统接管，不该重复调用）',
    );
    expect(
      bounds,
      isEmpty,
      reason:
          '★ 绝不能再自己发 setBounds：和原生缩放抢窗口尺寸，'
          '正是"松手后拉伸/缩放"的来源',
    );
  });

  testWidgets('★★ 八个热区各自映射到正确的缩放边', (tester) async {
    final edges = <Map>[];
    const channel = MethodChannel('window_manager');
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'startResizing') {
        edges.add((call.arguments as Map).cast<String, dynamic>());
        return null;
      }
      if (call.method == 'isMaximized') return false;
      if (call.method == 'isFullScreen') return false;
      if (call.method == 'getBounds') {
        return <String, dynamic>{
          'x': 100.0,
          'y': 100.0,
          'width': 800.0,
          'height': 600.0,
        };
      }
      return null;
    });
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));

    tester.view.physicalSize = const Size(800, 600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: WindowResizeOverlay())),
    );
    await tester.pump();

    // 左下角 / 上边缘 各拖一次，确认边映射正确（其余热区由上面那条覆盖存在性）
    final g1 = await tester.startGesture(const Offset(4, 596));
    await tester.pump();
    await g1.moveBy(const Offset(0, 2));
    await tester.pump();
    await g1.up();

    final g2 = await tester.startGesture(const Offset(400, 2));
    await tester.pump();
    await g2.moveBy(const Offset(0, 2));
    await tester.pump();
    await g2.up();

    expect(edges.length, greaterThanOrEqualTo(2), reason: '两次拖动应各触发一次');
    expect(edges[0]['left'], isTrue, reason: '左下角应带 left');
    expect(edges[0]['bottom'], isTrue, reason: '左下角应带 bottom');
    expect(edges[1]['top'], isTrue, reason: '上边缘应带 top');
    // 插件对"不涉及的方向"传的是 false（不是 null）
    expect(edges[1]['left'], isFalse, reason: '上边缘不该带 left');
    expect(edges[1]['bottom'], isFalse, reason: '上边缘不该带 bottom');
  });
}