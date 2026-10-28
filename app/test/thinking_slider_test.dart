import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/screens/bots_screen.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';
import 'package:pi_bot/widgets/thinking_slider.dart';

const _levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

Future<void> _pump(
  WidgetTester tester, {
  String? value,
  ValueChanged<String>? onChanged,
}) async {
  tester.view.physicalSize = const Size(600, 300);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Padding(
          padding: const EdgeInsets.all(20),
          child: ThinkingSlider(
            levels: _levels,
            value: value,
            onChanged: onChanged ?? (_) {},
          ),
        ),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  setUp(() => BlobAvatar.animationsEnabled = false);
  tearDown(() => BlobAvatar.animationsEnabled = true);

  for (final level in ['xhigh', 'minimal', 'future-level']) {
    testWidgets('打开 Bot 编辑器后不改保存保留 $level', (tester) async {
      tester.view.physicalSize = const Size(1000, 1200);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final state = _CaptureState()
        ..bots = [Bot(id: 'fixture-bot', name: 'fixture bot', thinking: level)];
      addTearDown(state.dispose);
      await tester.pumpWidget(
        AppScope(
          state: state,
          child: const MaterialApp(home: BotsScreen()),
        ),
      );
      await tester.tap(find.text('fixture bot'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('保存'));
      await tester.tap(find.text('保存'));
      await tester.pumpAndSettle();
      expect(state.saved?['thinking'], level);
    });
  }

  testWidgets('模型声明 xhigh 时编辑器展示并原样保存', (tester) async {
    tester.view.physicalSize = const Size(1000, 1200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final state = _CaptureState()
      ..bots = [
        Bot(
          id: 'fixture-bot',
          name: 'fixture bot',
          model: 'fixture/model',
          thinking: 'xhigh',
        ),
      ]
      ..modelGroups = [
        ModelGroup(
          id: 'fixture',
          name: 'fixture',
          baseUrl: 'https://example.invalid',
          models: [
            ModelSpec(
              id: 'model',
              reasoning: true,
              thinkingLevels: const ['off', 'high', 'xhigh', 'max'],
            ),
          ],
        ),
      ];
    addTearDown(state.dispose);
    await tester.pumpWidget(
      AppScope(
        state: state,
        child: const MaterialApp(home: BotsScreen()),
      ),
    );
    await tester.tap(find.text('fixture bot'));
    await tester.pumpAndSettle();
    final slider = tester.widget<ThinkingSlider>(find.byType(ThinkingSlider));
    expect(slider.levels, ['off', 'high', 'xhigh', 'max']);
    expect(slider.value, 'xhigh');
    await tester.ensureVisible(find.text('保存'));
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();
    expect(state.saved?['thinking'], 'xhigh');
  });

  testWidgets('按下后直接取消不会留下未保存的预览', (tester) async {
    final picked = <String>[];
    await _pump(tester, value: 'low', onChanged: picked.add);
    final before = _painter(tester);
    final rect = tester.getRect(find.byType(ThinkingSlider));
    final gesture = await tester.startGesture(
      Offset(rect.right - 3, rect.center.dy),
    );
    await tester.pump(const Duration(milliseconds: 150));
    expect(_painter(tester).shouldRepaint(before), isTrue);
    await gesture.cancel();
    await tester.pump();
    expect(picked, isEmpty);
    expect(_painter(tester).shouldRepaint(before), isFalse);
  });

  testWidgets('取消拖动恢复已保存位置且不提交', (tester) async {
    final picked = <String>[];
    await _pump(tester, value: 'low', onChanged: picked.add);
    final before = _painter(tester);
    final rect = tester.getRect(find.byType(ThinkingSlider));
    final gesture = await tester.startGesture(
      Offset(rect.left + 3, rect.center.dy),
    );
    await gesture.moveBy(Offset(rect.width * .8, 0));
    await tester.pump();
    expect(_painter(tester).shouldRepaint(before), isTrue);
    await gesture.cancel();
    await tester.pump();
    expect(picked, isEmpty);
    expect(_painter(tester).shouldRepaint(before), isFalse);
  });

  testWidgets('纵向滚动赢得手势后恢复已保存位置', (tester) async {
    final picked = <String>[];
    tester.view.physicalSize = const Size(600, 300);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                children: [
                  ThinkingSlider(
                    levels: _levels,
                    value: 'low',
                    onChanged: picked.add,
                  ),
                  const SizedBox(height: 1000),
                ],
              ),
            ),
          ),
        ),
      ),
    );
    final before = _painter(tester);
    final rect = tester.getRect(find.byType(ThinkingSlider));
    final gesture = await tester.startGesture(
      Offset(rect.right - 3, rect.center.dy),
    );
    await tester.pump(const Duration(milliseconds: 150));
    expect(_painter(tester).shouldRepaint(before), isTrue);
    await gesture.moveBy(const Offset(0, -65));
    await gesture.up();
    await tester.pump();
    expect(picked, isEmpty);
    expect(_painter(tester).shouldRepaint(before), isFalse);
  });

  for (final change in ['disabled', 'levels', 'in_place_levels', 'value']) {
    testWidgets('拖动中 $change 改变会取消本次提交', (tester) async {
      final picked = <String>[];
      var enabled = true;
      var levels = List.of(_levels);
      var value = 'low';
      late StateSetter rebuild;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: StatefulBuilder(
              builder: (context, setState) {
                rebuild = setState;
                return SizedBox(
                  width: 500,
                  child: ThinkingSlider(
                    levels: levels,
                    value: value,
                    enabled: enabled,
                    onChanged: picked.add,
                  ),
                );
              },
            ),
          ),
        ),
      );
      final rect = tester.getRect(find.byType(ThinkingSlider));
      final gesture = await tester.startGesture(
        Offset(rect.left + 3, rect.center.dy),
      );
      await gesture.moveBy(Offset(rect.width * .75, 0));
      await tester.pump();
      rebuild(() {
        if (change == 'disabled') enabled = false;
        if (change == 'levels') levels = const ['off', 'low'];
        if (change == 'in_place_levels') levels.removeLast();
        if (change == 'value') value = 'high';
      });
      await tester.pump();
      await gesture.moveBy(const Offset(15, 0));
      await gesture.up();
      await tester.pump();
      expect(picked, isEmpty);
    });
  }

  testWidgets('点最右边 → 停到 max', (tester) async {
    final picked = <String>[];
    await _pump(tester, value: 'low', onChanged: picked.add);
    final rect = tester.getRect(find.byType(ThinkingSlider).first);
    await tester.tapAt(Offset(rect.right - 2, rect.center.dy));
    await tester.pumpAndSettle();
    expect(picked, ['max']);
  });

  testWidgets('点最左边 → 停到 off', (tester) async {
    String? picked;
    await _pump(tester, value: 'high', onChanged: (v) => picked = v);
    final rect = tester.getRect(find.byType(ThinkingSlider).first);
    await tester.tapAt(Offset(rect.left + 2, rect.center.dy));
    await tester.pumpAndSettle();
    expect(picked, 'off');
  });

  testWidgets('拖动会吸附到最近的档位（不会返回中间值）', (tester) async {
    final picked = <String>[];
    await _pump(tester, value: 'off', onChanged: picked.add);
    final rect = tester.getRect(find.byType(ThinkingSlider).first);
    // 拖到大约 50% 位置 → 7 档里的第 4 档（index 3 = medium）
    await tester.dragFrom(
      Offset(rect.left + 2, rect.center.dy),
      Offset(rect.width * 0.5, 0),
    );
    await tester.pumpAndSettle();
    expect(picked, ['medium']);
  });

  testWidgets('选中档位的标签会高亮', (tester) async {
    await _pump(tester, value: 'max');
    // 每一档都有标签；高亮的是当前档
    for (final l in ['关', '极低', '低', '中', '高', '很高', '最高']) {
      expect(find.text(l), findsOneWidget);
    }
  });

  testWidgets('单档位时退化成一行文案，不画滑条', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: ThinkingSlider(levels: ['max'], value: 'max', onChanged: _noop),
        ),
      ),
    );
    await tester.pump();
    expect(find.text('思考等级：最高'), findsOneWidget);
  });
}

void _noop(String _) {}

CustomPainter _painter(WidgetTester tester) => tester
    .widget<CustomPaint>(
      find.descendant(
        of: find.byType(ThinkingSlider),
        matching: find.byType(CustomPaint),
      ),
    )
    .painter!;

class _CaptureState extends AppState {
  Map<String, dynamic>? saved;

  @override
  Future<void> updateBot(String botId, Map<String, dynamic> patch) async {
    saved = Map.of(patch);
  }
}
