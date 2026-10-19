import 'models.dart';

/// 模型容量输入；空白保留已有值，新模型空白交由服务端采用默认值。
class ModelCapacityInput {
  const ModelCapacityInput({this.contextWindow = '', this.maxTokens = ''});

  final String contextWindow;
  final String maxTokens;

  ModelCapacityInput copyWith({String? contextWindow, String? maxTokens}) =>
      ModelCapacityInput(
        contextWindow: contextWindow ?? this.contextWindow,
        maxTokens: maxTokens ?? this.maxTokens,
      );
}

/// 多行模型名按首次出现的顺序去重。
List<String> modelIdsFromText(String text) => text
    .split('\n')
    .map((line) => line.trim())
    .where((id) => id.isNotEmpty)
    .toSet()
    .toList();

/// 已有模型的容量输入按模型 ID 保存，调整列表顺序不会串值。
Map<String, ModelCapacityInput> modelCapacityInputs(
  Iterable<ModelSpec> models,
) => {
  for (final model in models)
    model.id: ModelCapacityInput(
      contextWindow: model.contextWindow > 0 ? '${model.contextWindow}' : '',
      maxTokens: model.maxTokens > 0 ? '${model.maxTokens}' : '',
    ),
};

class ModelGroupModelsPayload {
  const ModelGroupModelsPayload.success(this.models) : error = null;
  const ModelGroupModelsPayload.failure(this.error) : models = const [];

  final List<Map<String, dynamic>> models;
  final String? error;
}

/// 构造模型对象数组；显式值须为 JSON 可精确表示的正整数，输出不能超过已知窗口。
ModelGroupModelsPayload buildModelGroupModels({
  required String modelText,
  required Map<String, ModelCapacityInput> inputs,
  Iterable<ModelSpec> existingModels = const [],
}) {
  final ids = modelIdsFromText(modelText);
  if (ids.isEmpty) {
    return const ModelGroupModelsPayload.failure('至少要填一个模型名（一行一个）');
  }
  final existing = {for (final model in existingModels) model.id: model};
  final models = <Map<String, dynamic>>[];
  for (final id in ids) {
    final input = inputs[id] ?? const ModelCapacityInput();
    final old = existing[id];
    int? value(String raw, int? previous, String label) {
      final text = raw.trim();
      if (text.isEmpty) return (previous ?? 0) > 0 ? previous : null;
      final parsed = RegExp(r'^\d+$').hasMatch(text)
          ? int.tryParse(text)
          : null;
      if (parsed == null || parsed <= 0 || parsed > 9007199254740991) {
        throw FormatException('模型 $id 的$label要填正整数 tokens，或留空');
      }
      return parsed;
    }

    try {
      final window = value(input.contextWindow, old?.contextWindow, '上下文窗口');
      final output = value(input.maxTokens, old?.maxTokens, '最大输出');
      if (window != null && output != null && output > window) {
        return ModelGroupModelsPayload.failure('模型 $id 的最大输出不能超过上下文窗口');
      }
      models.add({
        'id': id,
        if (window != null) 'contextWindow': window,
        if (output != null) 'maxTokens': output,
      });
    } on FormatException catch (error) {
      return ModelGroupModelsPayload.failure(error.message);
    }
  }
  return ModelGroupModelsPayload.success(models);
}
