import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/model_group_capacity.dart';
import 'package:pi_bot/models.dart';

void main() {
  final existing = [
    ModelSpec(id: 'model-a', contextWindow: 12000, maxTokens: 2000),
    ModelSpec(id: 'model-b', contextWindow: 64000, maxTokens: 4000),
  ];

  test('模型名按首次出现顺序去重并忽略空行', () {
    expect(modelIdsFromText(' model-b \n\nmodel-a\nmodel-b\n'), [
      'model-b',
      'model-a',
    ]);
  });

  test('已有不同模型的容量独立保留，按模型 ID 对齐而非列表位置', () {
    final result = buildModelGroupModels(
      modelText: 'model-b\nmodel-a',
      inputs: {},
      existingModels: existing,
    );
    expect(result.error, isNull);
    expect(result.models, [
      {'id': 'model-b', 'contextWindow': 64000, 'maxTokens': 4000},
      {'id': 'model-a', 'contextWindow': 12000, 'maxTokens': 2000},
    ]);
  });

  test('只改一个模型的输出不覆盖另一个模型或未改的窗口', () {
    final result = buildModelGroupModels(
      modelText: 'model-a\nmodel-b',
      inputs: {'model-a': const ModelCapacityInput(maxTokens: '3000')},
      existingModels: existing,
    );
    expect(result.models, [
      {'id': 'model-a', 'contextWindow': 12000, 'maxTokens': 3000},
      {'id': 'model-b', 'contextWindow': 64000, 'maxTokens': 4000},
    ]);
  });

  test('已有模型清空输入保留原值，新模型空白不猜容量', () {
    final result = buildModelGroupModels(
      modelText: 'model-a\nmodel-new',
      inputs: {
        'model-a': const ModelCapacityInput(contextWindow: ' ', maxTokens: ' '),
      },
      existingModels: existing,
    );
    expect(result.models, [
      {'id': 'model-a', 'contextWindow': 12000, 'maxTokens': 2000},
      {'id': 'model-new'},
    ]);
  });

  test('新模型显式容量原样提交且不会影响其他新模型', () {
    final result = buildModelGroupModels(
      modelText: 'model-a\nmodel-b',
      inputs: {
        'model-a': const ModelCapacityInput(
          contextWindow: ' 50000 ',
          maxTokens: '5000',
        ),
        'model-b': const ModelCapacityInput(
          contextWindow: '80000',
          maxTokens: '6000',
        ),
      },
    );
    expect(result.error, isNull);
    expect(result.models, [
      {'id': 'model-a', 'contextWindow': 50000, 'maxTokens': 5000},
      {'id': 'model-b', 'contextWindow': 80000, 'maxTokens': 6000},
    ]);
  });

  test('没有填写的未知容量不作为零值发送', () {
    final result = buildModelGroupModels(
      modelText: 'model-a',
      inputs: {},
      existingModels: [ModelSpec(id: 'model-a')],
    );
    expect(result.models, [
      {'id': 'model-a'},
    ]);
  });

  for (final invalid in ['0', '-1', '1.5', '1e4', 'abc', '9007199254740992']) {
    test('拒绝非法窗口输入 $invalid', () {
      final result = buildModelGroupModels(
        modelText: 'model-a',
        inputs: {'model-a': ModelCapacityInput(contextWindow: invalid)},
      );
      expect(result.error, contains('正整数'));
      expect(result.models, isEmpty);
    });
  }

  test('输出也必须为正整数', () {
    final result = buildModelGroupModels(
      modelText: 'model-a',
      inputs: {'model-a': const ModelCapacityInput(maxTokens: '-2')},
    );
    expect(result.error, contains('最大输出'));
  });

  test('输出不能大于已有窗口，避免只校验两个同时填写的输入', () {
    final result = buildModelGroupModels(
      modelText: 'model-a',
      inputs: {'model-a': const ModelCapacityInput(maxTokens: '13000')},
      existingModels: existing,
    );
    expect(result.error, contains('最大输出不能超过上下文窗口'));
  });

  test('窗口不能小于保留的已有输出', () {
    final result = buildModelGroupModels(
      modelText: 'model-a',
      inputs: {'model-a': const ModelCapacityInput(contextWindow: '1000')},
      existingModels: existing,
    );
    expect(result.error, contains('最大输出不能超过上下文窗口'));
  });

  test('输出等于窗口是有效边界', () {
    final result = buildModelGroupModels(
      modelText: 'model-a',
      inputs: {
        'model-a': const ModelCapacityInput(
          contextWindow: '2000',
          maxTokens: '2000',
        ),
      },
    );
    expect(result.error, isNull);
  });

  test('移除的模型不提交，新 ID 不继承被移除模型的容量', () {
    final result = buildModelGroupModels(
      modelText: 'model-new',
      inputs: modelCapacityInputs(existing),
      existingModels: existing,
    );
    expect(result.models, [
      {'id': 'model-new'},
    ]);
  });

  test('模型名为空时拒绝保存', () {
    expect(
      buildModelGroupModels(modelText: ' \n', inputs: {}).error,
      isNotNull,
    );
  });

  group('独立模型卡片', () {
    test('重命名后本行容量跟随卡片，清空输入也不会取另一个模型的值', () {
      final rows = modelCardDrafts(existing);
      final result = buildModelCardModels([
        rows[0].copyWith(
          id: 'model-renamed',
          capacity: const ModelCapacityInput(),
        ),
        rows[1],
      ]);
      expect(result.models, [
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
      expect(rows[0].id, 'model-a');
    });

    test('删除后新添加的卡片不继承被删除行的容量', () {
      final rows = modelCardDrafts(existing);
      final result = buildModelCardModels([
        rows[1],
        const ModelCardDraft(rowId: 2, id: 'model-new'),
      ]);
      expect(result.models.last, {'id': 'model-new', 'name': 'model-new'});
      expect(result.models.first['contextWindow'], 64000);
    });

    test('重复 ID 拦截，不静默丢掉其中一张卡片', () {
      final rows = modelCardDrafts(existing);
      final result = buildModelCardModels([
        rows[0].copyWith(id: ' model-b '),
        rows[1],
      ]);
      expect(result.error, contains('重复'));
      expect(result.models, isEmpty);
    });

    test('显示名可独立修改，留空使用当前模型 ID', () {
      final result = buildModelCardModels([
        const ModelCardDraft(rowId: 0, id: 'model-a', name: ' 自定义显示名 '),
        const ModelCardDraft(rowId: 1, id: 'model-b'),
      ]);
      expect(result.models[0]['name'], '自定义显示名');
      expect(result.models[1]['name'], 'model-b');
    });

    test('空 ID 和多行 ID 均拦截', () {
      for (final id in ['', 'model-a\nmodel-b', 'model-a\rmodel-b']) {
        expect(
          buildModelCardModels([ModelCardDraft(rowId: 0, id: id)]).error,
          isNotNull,
        );
      }
    });

    test('不能保存没有模型的组', () {
      expect(buildModelCardModels([]).error, contains('至少'));
    });

    group('思考强度', () {
      test('不思考且没填格式时不上报思考字段', () {
        final result = buildModelCardModels([
          const ModelCardDraft(rowId: 0, id: 'model-a'),
        ]);
        expect(result.models[0].containsKey('reasoning'), isFalse);
        expect(result.models[0].containsKey('thinkingFormat'), isFalse);
        expect(result.models[0].containsKey('thinkingLevelMap'), isFalse);
      });

      // ★ 回归：曾经把“用户主动关掉思考”和“没动过”当成一回事，
      //   导致开关点不掉（关了又弹回来）、而且关掉的动作根本不会被提交。
      test('主动关闭思考必须显式提交 reasoning:false', () {
        final result = buildModelCardModels([
          const ModelCardDraft(
            rowId: 0,
            id: 'model-a',
            // 服务端已存的是“开”，用户手动关掉
            retainedThinking: ModelThinkingInput(
              reasoning: true,
              format: 'deepseek',
              levels: {'high': 'high'},
            ),
            thinking: ModelThinkingInput(reasoning: false),
          ),
        ]);
        final model = result.models[0];
        expect(model['reasoning'], isFalse);
        // 关掉之后不该再带格式和映射
        expect(model.containsKey('thinkingFormat'), isFalse);
        expect(model.containsKey('thinkingLevelMap'), isFalse);
      });

      test('touched 能区分「没动过」与「主动关闭」', () {
        const untouched = ModelThinkingInput();
        const off = ModelThinkingInput(reasoning: false);
        const on = ModelThinkingInput(reasoning: true);
        expect(untouched.touched, isFalse);
        expect(off.touched, isTrue);
        expect(on.touched, isTrue);
        expect(untouched.toJson().containsKey('reasoning'), isFalse);
        expect(off.toJson()['reasoning'], isFalse);
      });

      // ★ 开启思考时默认就把档位按同名映射全开，用户不用逐个选下拉框
      test('一键开启：默认按同名映射全开，max→max', () {
        final map = defaultThinkingLevelMap();
        expect(map['max'], 'max');
        expect(map['high'], 'high');
        expect(map['minimal'], 'minimal');
        expect(map['xhigh'], 'xhigh');
        // off 语义是「这一档不额外传参数」，不该被映射成任何上游值
        expect(map.containsKey('off'), isFalse);
      });

      test('一键开启：上游白名单过滤掉不认识的档位', () {
        final map = defaultThinkingLevelMap(
          levels: const ['off', 'low', 'high', 'custom'],
          upstreamValues: const ['low', 'high'],
        );
        expect(map, {'low': 'low', 'high': 'high'});
      });

      test('一键开启：结果能直接提交成 thinkingLevelMap', () {
        final result = buildModelCardModels([
          ModelCardDraft(
            rowId: 0,
            id: 'model-a',
            thinking: ModelThinkingInput(
              reasoning: true,
              format: 'deepseek',
              levels: defaultThinkingLevelMap(),
            ),
          ),
        ]);
        final model = result.models[0];
        expect(model['reasoning'], isTrue);
        final map = model['thinkingLevelMap'] as Map<String, String>;
        expect(map.length, 6); // 七个档位除 off 之外全部映射
        expect(map['max'], 'max');
        expect(map.containsKey('off'), isFalse);
      });

      test('开启思考后上报开关、上游格式与档位映射', () {
        final result = buildModelCardModels([
          const ModelCardDraft(
            rowId: 0,
            id: 'wb-deepseek-v4.1-flash',
            thinking: ModelThinkingInput(
              reasoning: true,
              format: 'deepseek',
              levels: {'high': 'high', 'xhigh': 'max'},
            ),
          ),
        ]);
        final model = result.models[0];
        expect(model['reasoning'], isTrue);
        expect(model['thinkingFormat'], 'deepseek');
        expect(model['thinkingLevelMap'], {'high': 'high', 'xhigh': 'max'});
      });

      test('没动思考设置时回传已存配置，不会把思考能力清掉', () {
        final result = buildModelCardModels([
          const ModelCardDraft(
            rowId: 0,
            id: 'model-a',
            retainedThinking: ModelThinkingInput(
              reasoning: true,
              format: 'zai',
              levels: {'high': 'high'},
            ),
          ),
        ]);
        expect(result.models[0]['reasoning'], isTrue);
        expect(result.models[0]['thinkingFormat'], 'zai');
      });

      test('已存思考配置会原样回显到卡片草稿', () {
        final rows = modelCardDrafts([
          ModelSpec(
            id: 'model-a',
            reasoning: true,
            thinkingFormat: 'deepseek',
            thinkingLevelMap: const {'high': 'high', 'xhigh': 'max'},
          ),
        ]);
        expect(rows.single.thinking.reasoning, isTrue);
        expect(rows.single.thinking.format, 'deepseek');
        expect(rows.single.thinking.levels['xhigh'], 'max');
      });

      test('旧格式 buildModelGroupModels 能用思考参数保留设置', () {
        final result = buildModelGroupModels(
          modelText: 'model-a',
          inputs: {},
          existingModels: [
            ModelSpec(
              id: 'model-a',
              reasoning: true,
              thinkingFormat: 'deepseek',
              thinkingLevelMap: const {'high': 'high'},
            ),
          ],
        );
        expect(result.models[0]['reasoning'], isTrue);
        expect(result.models[0]['thinkingFormat'], 'deepseek');
      });
    });
  });
}
