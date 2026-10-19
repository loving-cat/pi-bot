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

  Future<void> open(WidgetTester tester, {ModelGroup? group}) async {
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
    await tester.tap(find.text(group == null ? '添加' : '编辑'));
    await tester.pumpAndSettle();
  }

  Future<void> expand(WidgetTester tester) async {
    await tester.ensureVisible(find.text('模型容量'));
    await tester.tap(find.text('模型容量'));
    await tester.pumpAndSettle();
  }

  Future<void> enter(WidgetTester tester, String key, String value) async {
    final field = find.byKey(ValueKey(key));
    await tester.ensureVisible(field);
    await tester.enterText(field, value);
    await tester.pumpAndSettle();
  }

  Future<void> save(WidgetTester tester) async {
    await tester.tap(find.widgetWithText(FilledButton, '保存'));
    await tester.pumpAndSettle();
  }

  testWidgets('编辑模型组不展开容量也保留已有各模型的不同值', (tester) async {
    await open(tester, group: mixedGroup());
    await tester.enterText(find.byType(TextField).first, '已编辑的测试模型组');
    await save(tester);
    expect(state.saved?['models'], [
      {'id': 'model-a', 'contextWindow': 12000, 'maxTokens': 2000},
      {'id': 'model-b', 'contextWindow': 64000, 'maxTokens': 4000},
    ]);
    expect(state.saved?.containsKey('apiKey'), isFalse);
  });

  testWidgets('展开容量可分别编辑一个模型，不统一覆盖其他模型', (tester) async {
    await open(tester, group: mixedGroup());
    await expand(tester);
    await enter(tester, 'model-context-model-a', '24000');
    await enter(tester, 'model-output-model-a', '3000');
    await save(tester);
    expect(state.saved?['models'], [
      {'id': 'model-a', 'contextWindow': 24000, 'maxTokens': 3000},
      {'id': 'model-b', 'contextWindow': 64000, 'maxTokens': 4000},
    ]);
  });

  testWidgets('新增多行模型可填各自容量，列表重排后仍按 ID 保存', (tester) async {
    await open(tester);
    await tester.enterText(find.byType(TextField).at(3), 'model-a\nmodel-b');
    await expand(tester);
    await enter(tester, 'model-context-model-a', '30000');
    await enter(tester, 'model-output-model-a', '3000');
    await enter(tester, 'model-context-model-b', '70000');
    await enter(tester, 'model-output-model-b', '6000');
    final models = find.byWidgetPredicate(
      (widget) =>
          widget is TextField && widget.controller?.text == 'model-a\nmodel-b',
    );
    await tester.ensureVisible(models);
    await tester.enterText(models, 'model-b\nmodel-a');
    await tester.pumpAndSettle();
    await save(tester);
    expect(state.saved?['models'], [
      {'id': 'model-b', 'contextWindow': 70000, 'maxTokens': 6000},
      {'id': 'model-a', 'contextWindow': 30000, 'maxTokens': 3000},
    ]);
  });

  testWidgets('容量校验失败显示原因并阻止保存请求', (tester) async {
    await open(tester, group: mixedGroup());
    await expand(tester);
    await enter(tester, 'model-output-model-a', '13000');
    await save(tester);
    expect(state.saved, isNull);
    expect(find.textContaining('最大输出不能超过上下文窗口'), findsOneWidget);
    expect(find.text('编辑模型组'), findsOneWidget);
  });
}
