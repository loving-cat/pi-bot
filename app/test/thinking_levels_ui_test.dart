// 思考档位的一键开启：UI 行为验证
//
// 这一组只盯用户实际看到 / 点到的东西：
//   · 点开思考开关 → 档位自动全开（不再需要逐个选下拉框）
//   · 摘要用胶囊展示，而不是七个下拉框
//   · 微调默认收起，展开后才出现逐档下拉框
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/model_group_capacity.dart';
import 'package:pi_bot/widgets/model_capacity_fields.dart';

const _formats = ['deepseek', 'openai', 'zai'];

Widget _host(Widget child) => MaterialApp(
  home: Scaffold(body: SingleChildScrollView(child: child)),
);

ModelCardDraft _draft({ModelThinkingInput? thinking}) => ModelCardDraft(
  rowId: 0,
  id: 'model-a',
  thinking: thinking ?? const ModelThinkingInput(),
);

void main() {
  testWidgets('★ 点开思考开关后，档位自动全开，不需要逐个选', (tester) async {
    var draft = _draft();
    await tester.pumpWidget(
      _host(
        StatefulBuilder(
          builder: (context, setState) => ModelCardsEditor(
            rows: [draft],
            onChanged: (rowId, update) =>
                setState(() => draft = update(draft)),
            thinkingFormats: _formats,
            thinkingLevels: kThinkingLevels,
            thinkingUpstreamValues: kThinkingUpstreamValues,
            onRemove: (_) {},
            onAdd: () {},
          ),
        ),
      ),
    );

    // 开之前：没有档位摘要
    expect(find.byKey(const ValueKey('model-thinking-chip-0-max')), findsNothing);

    await tester.tap(find.byKey(const ValueKey('model-reasoning-toggle-0')));
    await tester.pumpAndSettle();

    // 开之后：档位已经全部映射好，max 档是亮的
    expect(draft.thinking.reasoning, isTrue);
    expect(draft.thinking.levels['max'], 'max');
    expect(draft.thinking.levels['high'], 'high');
    expect(draft.thinking.levels.containsKey('off'), isFalse);
    expect(find.byKey(const ValueKey('model-thinking-chip-0-max')), findsOneWidget);
    expect(find.text('档位映射'), findsOneWidget);
  });

  testWidgets('★ 摘要用胶囊展示，七个下拉框默认不出现', (tester) async {
    final draft = _draft(
      thinking: ModelThinkingInput(
        reasoning: true,
        format: 'deepseek',
        levels: defaultThinkingLevelMap(),
      ),
    );
    await tester.pumpWidget(
      _host(
        ModelCardsEditor(
          rows: [draft],
          onChanged: (_, __) {},
          thinkingFormats: _formats,
          thinkingLevels: kThinkingLevels,
          thinkingUpstreamValues: kThinkingUpstreamValues,
          onRemove: (_) {},
          onAdd: () {},
        ),
      ),
    );
    await tester.pumpAndSettle();

    // 七个胶囊都在（off 也画一个淡的，表示这一档没映射）
    for (final level in kThinkingLevels) {
      expect(
        find.byKey(ValueKey('model-thinking-chip-0-$level')),
        findsOneWidget,
        reason: '缺少档位胶囊：$level',
      );
    }
    // 逐档下拉框默认收起 —— 这就是「不要再让用户一个个选」的落点
    for (final level in kThinkingLevels) {
      expect(
        find.byKey(ValueKey('model-thinking-0-$level')),
        findsNothing,
        reason: '$level 的下拉框不该默认出现',
      );
    }
    expect(find.text('微调单个档位'), findsOneWidget);
  });

  testWidgets('展开微调后才出现逐档下拉框', (tester) async {
    final draft = _draft(
      thinking: ModelThinkingInput(
        reasoning: true,
        format: 'deepseek',
        levels: defaultThinkingLevelMap(),
      ),
    );
    await tester.pumpWidget(
      _host(
        ModelCardsEditor(
          rows: [draft],
          onChanged: (_, __) {},
          thinkingFormats: _formats,
          thinkingLevels: kThinkingLevels,
          thinkingUpstreamValues: kThinkingUpstreamValues,
          onRemove: (_) {},
          onAdd: () {},
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('model-thinking-tune-0')));
    await tester.pumpAndSettle();

    expect(find.text('收起微调'), findsOneWidget);
    expect(find.byKey(const ValueKey('model-thinking-0-max')), findsOneWidget);
  });

  testWidgets('关掉开关会清空映射，不留残档', (tester) async {
    var draft = _draft(
      thinking: ModelThinkingInput(
        reasoning: true,
        format: 'deepseek',
        levels: defaultThinkingLevelMap(),
      ),
    );
    await tester.pumpWidget(
      _host(
        StatefulBuilder(
          builder: (context, setState) => ModelCardsEditor(
            rows: [draft],
            onChanged: (rowId, update) =>
                setState(() => draft = update(draft)),
            thinkingFormats: _formats,
            thinkingLevels: kThinkingLevels,
            thinkingUpstreamValues: kThinkingUpstreamValues,
            onRemove: (_) {},
            onAdd: () {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('model-reasoning-toggle-0')));
    await tester.pumpAndSettle();

    expect(draft.thinking.reasoning, isFalse);
    expect(draft.thinking.levels, isEmpty);
    expect(find.byKey(const ValueKey('model-thinking-chip-0-max')), findsNothing);
  });
}
