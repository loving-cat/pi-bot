import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/widgets/model_group_editor.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _EditorState extends AppState {
  Map<String, dynamic>? saved;

  @override
  Future<String?> saveModelGroup(Map<String, dynamic> patch) async {
    saved = patch;
    modelGroups = [
      ModelGroup(
        id: patch['id'] as String? ?? 'group-test',
        name: patch['name'] as String,
        baseUrl: patch['baseUrl'] as String,
        api: patch['api'] as String,
        models: (patch['models'] as List)
            .map((model) => ModelSpec.fromJson(model as Map<String, dynamic>))
            .toList(),
      ),
    ];
    notifyListeners();
    return null;
  }
}

void main() {
  late _EditorState state;

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    state = _EditorState();
  });

  tearDown(() => state.dispose());

  ModelGroup mixedGroup() => ModelGroup(
    id: 'group-test',
    name: '测试模型组',
    baseUrl: '',
    models: [
      ModelSpec(id: 'model-a', contextWindow: 12000, maxTokens: 2000),
      ModelSpec(id: 'model-b', contextWindow: 64000, maxTokens: 4000),
    ],
  );

  Future<void> showGroups(WidgetTester tester, {ModelGroup? group}) async {
    if (group != null) state.modelGroups = [group];
    await tester.pumpWidget(
      AppScope(
        state: state,
        child: const MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(child: ModelGroupsSection()),
          ),
        ),
      ),
    );
  }

  Future<void> open(WidgetTester tester, {ModelGroup? group}) async {
    await showGroups(tester, group: group);
    await tester.tap(find.text(group == null ? '添加' : '编辑'));
    await tester.pumpAndSettle();
  }

  Future<void> enter(WidgetTester tester, String key, String value) async {
    final field = find.byKey(ValueKey(key));
    await tester.ensureVisible(field);
    await tester.enterText(field, value);
    await tester.pumpAndSettle();
  }

  Future<void> press(WidgetTester tester, String key) async {
    final button = find.byKey(ValueKey(key));
    await tester.ensureVisible(button);
    await tester.tap(button);
    await tester.pumpAndSettle();
  }

  Future<void> save(WidgetTester tester) async {
    await tester.tap(find.widgetWithText(FilledButton, '保存'));
    await tester.pumpAndSettle();
  }

  testWidgets('设置组列表逐模型显示不同容量，点击模型进入对应卡片', (tester) async {
    await showGroups(tester, group: mixedGroup());
    expect(
      find.text('上下文：12000 tokens · 最大输出：2000 tokens · 思考：不思考'),
      findsOneWidget,
    );
    expect(
      find.text('上下文：64000 tokens · 最大输出：4000 tokens · 思考：不思考'),
      findsOneWidget,
    );
    await press(tester, 'model-summary-group-test-model-b');
    expect(find.text('编辑模型组'), findsOneWidget);
    expect(
      tester
          .widget<TextField>(
            find.descendant(
              of: find.byKey(const ValueKey('model-id-1')),
              matching: find.byType(TextField),
            ),
          )
          .autofocus,
      isTrue,
    );
    expect(find.text('模型名（一行一个）'), findsNothing);
  });

  testWidgets('两个模型分别编辑保存，重新打开仍回显各自容量', (tester) async {
    await open(tester, group: mixedGroup());
    await enter(tester, 'model-context-0', '24000');
    await enter(tester, 'model-output-0', '3000');
    await enter(tester, 'model-context-1', '72000');
    await enter(tester, 'model-output-1', '5000');
    await save(tester);
    expect(state.saved?['models'], [
      {
        'id': 'model-a',
        'name': 'model-a',
        'contextWindow': 24000,
        'maxTokens': 3000,
      },
      {
        'id': 'model-b',
        'name': 'model-b',
        'contextWindow': 72000,
        'maxTokens': 5000,
      },
    ]);
    expect(state.saved?.containsKey('apiKey'), isFalse);
    await tester.tap(find.text('编辑'));
    await tester.pumpAndSettle();
    for (final entry in {
      'model-context-0': '24000',
      'model-output-0': '3000',
      'model-context-1': '72000',
      'model-output-1': '5000',
    }.entries) {
      expect(
        tester
            .widget<TextFormField>(find.byKey(ValueKey(entry.key)))
            .initialValue,
        entry.value,
      );
    }
  });

  testWidgets('新增模型逐卡填写 ID 和容量，可分别添加', (tester) async {
    await open(tester);
    await enter(tester, 'model-id-0', 'model-a');
    await enter(tester, 'model-name-0', '自定义显示名');
    await enter(tester, 'model-context-0', '30000');
    await enter(tester, 'model-output-0', '3000');
    await press(tester, 'add-model');
    await enter(tester, 'model-id-1', 'model-b');
    await enter(tester, 'model-context-1', '70000');
    await enter(tester, 'model-output-1', '6000');
    await save(tester);
    expect(state.saved?['models'], [
      {
        'id': 'model-a',
        'name': '自定义显示名',
        'contextWindow': 30000,
        'maxTokens': 3000,
      },
      {
        'id': 'model-b',
        'name': 'model-b',
        'contextWindow': 70000,
        'maxTokens': 6000,
      },
    ]);
  });

  testWidgets('删除首模型后再添加，新卡片不复用旧容量或覆盖剩余模型', (tester) async {
    await open(tester, group: mixedGroup());
    await enter(tester, 'model-output-1', '5000');
    await press(tester, 'remove-model-0');
    await press(tester, 'add-model');
    await enter(tester, 'model-id-2', 'model-new');
    await save(tester);
    expect(state.saved?['models'], [
      {
        'id': 'model-b',
        'name': 'model-b',
        'contextWindow': 64000,
        'maxTokens': 5000,
      },
      {'id': 'model-new', 'name': 'model-new'},
    ]);
  });

  testWidgets('ID 重命名保持同卡片容量，不窜到另一个模型', (tester) async {
    await open(tester, group: mixedGroup());
    await enter(tester, 'model-id-0', 'model-renamed');
    await save(tester);
    expect(state.saved?['models'], [
      {
        'id': 'model-renamed',
        'name': 'model-renamed',
        'contextWindow': 12000,
        'maxTokens': 2000,
      },
      {
        'id': 'model-b',
        'name': 'model-b',
        'contextWindow': 64000,
        'maxTokens': 4000,
      },
    ]);
  });

  testWidgets('重复模型 ID 拦截，不静默覆盖已有模型', (tester) async {
    await open(tester, group: mixedGroup());
    await enter(tester, 'model-id-0', 'model-b');
    await save(tester);
    expect(state.saved, isNull);
    expect(find.textContaining('模型 ID 重复'), findsOneWidget);
  });

  testWidgets('容量非法值拦截，修正后仍可保存', (tester) async {
    await open(tester, group: mixedGroup());
    await enter(tester, 'model-output-0', '13000');
    await save(tester);
    expect(state.saved, isNull);
    expect(find.textContaining('最大输出不能超过上下文窗口'), findsOneWidget);
    await enter(tester, 'model-output-0', '0');
    await save(tester);
    expect(state.saved, isNull);
    expect(find.textContaining('正整数'), findsOneWidget);
    await enter(tester, 'model-output-0', '3000');
    await save(tester);
    expect(state.saved, isNotNull);
  });
}
