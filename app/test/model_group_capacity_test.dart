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
}
