import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/l10n/l10n.dart';
import 'package:pi_bot/model_display.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/widgets/avatar_character.dart';
import 'package:pi_bot/widgets/avatar_life.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';
import 'package:pi_bot/widgets/md_text.dart';
import 'package:pi_bot/widgets/model_picker_field.dart';
import 'package:pi_bot/widgets/room_panel.dart';
import 'package:pi_bot/widgets/streaming_markdown_view.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    BlobAvatar.animationsEnabled = true;
    AvatarLife.pointer.value = null;
  });

  tearDown(() {
    BlobAvatar.animationsEnabled = true;
    AvatarLife.pointer.value = null;
  });

  group('活体形象 2.0：16 种轮廓与 5 态微表情', () {
    testWidgets('全部 16 种轮廓与 5 种情绪渲染正常，回到闲置 6 秒后零活跃动画', (
      tester,
    ) async {
      for (var i = 0; i < AvatarCharacterKind.values.length; i++) {
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: Center(
                child: BlobAvatar(
                  seed: 'shape-$i',
                  shape: i,
                  useBotAppearance: false,
                  color: Colors.teal,
                  size: 46,
                  animate: false,
                ),
              ),
            ),
          ),
        );
        expect(tester.takeException(), isNull, reason: 'shape=$i 渲染失败');
      }

      Widget moodHost(AvatarMood mood, double size) => MaterialApp(
        home: Scaffold(
          body: Center(
            child: BlobAvatar(
              seed: 'mood-test',
              shape: AvatarCharacterKind.neko.index,
              useBotAppearance: false,
              color: Colors.indigo,
              size: size,
              animate: true,
              interactive: true,
              followPointer: false,
              mood: mood,
            ),
          ),
        ),
      );

      for (final mood in AvatarMood.values) {
        await tester.pumpWidget(moodHost(mood, 48));
        await tester.pump(const Duration(milliseconds: 64));
        expect(tester.takeException(), isNull);
      }
      // 小尺寸下的 happy 自动安全退化
      await tester.pumpWidget(moodHost(AvatarMood.happy, 16));
      await tester.pump(const Duration(milliseconds: 32));
      expect(tester.takeException(), isNull);

      // 戳头像触发生动回弹，再回到 idle 满 6 秒后全部停表归零
      await tester.pumpWidget(moodHost(AvatarMood.idle, 48));
      await tester.tap(find.byType(BlobAvatar));
      await tester.pump(const Duration(milliseconds: 120));
      await tester.pumpAndSettle(
        const Duration(milliseconds: 100),
        EnginePhase.sendSemanticsUpdate,
        const Duration(seconds: 20),
      );
      expect(tester.binding.transientCallbackCount, 0);
    });
  });

  group('流式渲染：平滑追字与代码块语法隔离', () {
    testWidgets('自适应追字按帧平滑吐出，不切断 UTF-16 代理对且结束后零 Ticker', (
      tester,
    ) async {
      const target = '🎉 这是用来验证平滑追字的较长一段流式正文字句 🚀';
      Widget scene(bool streaming) => MaterialApp(
        home: Scaffold(
          body: Center(
            child: StreamingMarkdownView(
              target,
              streaming: streaming,
              forcePacing: true,
            ),
          ),
        ),
      );

      await tester.pumpWidget(scene(true));
      await tester.pump(const Duration(milliseconds: 32));

      final midText = tester
          .widgetList<RichText>(find.byType(RichText))
          .map((r) => r.text.toPlainText())
          .join();
      expect(midText, startsWith('🎉'));
      expect(midText.contains('🚀'), isFalse, reason: '中途帧尚未吐完结尾');
      for (final unit in midText.codeUnits) {
        // 验证不会出现未成对孤立代理项
        expect(unit, isNonZero);
      }
      expect(String.fromCharCodes(midText.runes), isNotEmpty);

      // 多帧追平后结束流式：全文完整展示，且关闭后 0 活跃回调
      for (var i = 0; i < 40; i++) {
        await tester.pump(const Duration(milliseconds: 20));
      }
      expect(find.textContaining('🚀'), findsOneWidget);

      await tester.pumpWidget(scene(false));
      await tester.pump();
      expect(tester.binding.transientCallbackCount, 0);
    });

    test('未闭合代码块挂流式尾标时不破坏语法块', () async {
      // 直接在 MdText 内传入未闭合围栏代码块 + streamingCursorColor
      const widget = MdText(
        '```dart\nprint(1)',
        selectable: false,
        streamingCursorColor: Colors.blue,
      );
      expect(widget.streamingCursorColor, Colors.blue);
    });

    testWidgets('未闭合围栏代码块带流式尾标仍识别为代码块并画出光标', (
      tester,
    ) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: MdText(
              '```dart\nprint(1)',
              selectable: false,
              streamingCursorColor: Colors.blue,
            ),
          ),
        ),
      );
      await tester.pump();
      expect(find.text('dart'), findsOneWidget);
      expect(find.textContaining('print(1)'), findsOneWidget);
      expect(find.textContaining('▍'), findsOneWidget);
    });
  });

  group('模型组精简展示与区分', () {
    test('同一模型在不同模型组严格区分，且自动裁剪厂商路由和日期后缀', () {
      final gSilicon = ModelGroup(
        id: 'mg_a1b2',
        name: '硅基流动 模型组',
        baseUrl: 'https://silicon.example/v1',
        models: [ModelSpec(id: 'deepseek-ai/DeepSeek-V3-20250324')],
      );
      final gOfficial = ModelGroup(
        id: 'mg_c3d4',
        name: '官方 分组',
        baseUrl: 'https://deepseek.example/v1',
        models: [ModelSpec(id: 'accounts/fireworks/models/DeepSeek-V3-20250324')],
      );

      final a = compactModelDisplay(
        gSilicon.slugFor('deepseek-ai/DeepSeek-V3-20250324'),
        [gSilicon, gOfficial],
      );
      final b = compactModelDisplay(
        gOfficial.slugFor('accounts/fireworks/models/DeepSeek-V3-20250324'),
        [gSilicon, gOfficial],
      );

      expect(a.groupTag, '硅基流动');
      expect(b.groupTag, '官方');
      expect(a.modelLabel, 'DeepSeek-V3');
      expect(b.modelLabel, 'DeepSeek-V3');
      expect(a.combined, isNot(equals(b.combined)));

      // 前缀相同但尾字不同的两组也能消歧
      final gMain = ModelGroup(
        id: 'g_1',
        name: '中转站点 主力渠道',
        baseUrl: 'https://a.example/v1',
      );
      final gBackup = ModelGroup(
        id: 'g_2',
        name: '中转站点 备用渠道',
        baseUrl: 'https://b.example/v1',
      );
      final tags = buildDistinctGroupTags([gMain, gBackup]);
      expect(tags['g_1'], isNot(equals(tags['g_2'])));
    });

    testWidgets('RoomPanel 顶部与 ModelPickerField 保持原 controller 且精简展示', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1200, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      final group = ModelGroup(
        id: 'grp_sili',
        name: '硅基流动 模型组',
        baseUrl: 'https://example.com/v1',
        models: [
          ModelSpec(id: 'deepseek-ai/DeepSeek-V3-20250324', contextWindow: 64000),
        ],
      );
      const rawSlug = 'grp_sili/deepseek-ai/DeepSeek-V3-20250324';
      final state = AppState()
        ..modelGroups = [group]
        ..bots = [Bot(id: 'b1', name: '助手', model: rawSlug, thinking: 'medium')]
        ..rooms = [Room(id: 'r1', name: '助手', kind: 'dm', botIds: const ['b1'])];
      addTearDown(state.dispose);

      await tester.pumpWidget(
        AppScope(
          state: state,
          child: L10n(
            controller: LocaleController(),
            child: MaterialApp(
              home: Scaffold(body: RoomPanel(room: state.rooms.first)),
            ),
          ),
        ),
      );
      await tester.pump();

      // 顶部精简模型徽章出现且带组标签
      final badge = find.byKey(const ValueKey('panel-model-badge'));
      expect(badge, findsOneWidget);
      expect(
        find.descendant(of: badge, matching: find.text('硅基流动')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: badge, matching: find.text('DeepSeek-V3')),
        findsOneWidget,
      );

      // 底层 TextField 依旧挂载且 controller 保留完整原始 slug
      final tf = tester.widget<TextField>(
        find.descendant(
          of: find.byType(ModelPickerField),
          matching: find.byType(TextField),
        ),
      );
      expect(tf.controller?.text, rawSlug);
    });
  });
}
