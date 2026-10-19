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

/// 单张模型卡片的草稿。rowId 仅供界面保持身份，修改模型 ID 不会改变本行容量。
class ModelCardDraft {
  const ModelCardDraft({
    required this.rowId,
    this.id = '',
    this.name = '',
    this.capacity = const ModelCapacityInput(),
    this.retainedCapacity = const ModelCapacityInput(),
  });

  final int rowId;
  final String id;
  final String name;
  final ModelCapacityInput capacity;
  final ModelCapacityInput retainedCapacity;

  ModelCardDraft copyWith({
    String? id,
    String? name,
    ModelCapacityInput? capacity,
  }) => ModelCardDraft(
    rowId: rowId,
    id: id ?? this.id,
    name: name ?? this.name,
    capacity: capacity ?? this.capacity,
    retainedCapacity: retainedCapacity,
  );
}

/// 已有模型逐个回显，容量快照跟随卡片而非可编辑的模型 ID。
List<ModelCardDraft> modelCardDrafts(Iterable<ModelSpec> models) {
  final rows = <ModelCardDraft>[];
  for (final model in models) {
    final retained = ModelCapacityInput(
      contextWindow: model.contextWindow > 0 ? '${model.contextWindow}' : '',
      maxTokens: model.maxTokens > 0 ? '${model.maxTokens}' : '',
    );
    rows.add(
      ModelCardDraft(
        rowId: rows.length,
        id: model.id,
        name: model.name == model.id ? '' : model.name,
        capacity: retained,
        retainedCapacity: retained,
      ),
    );
  }
  return rows;
}

int? _capacityValue(String raw, int? previous, String id, String label) {
  final text = raw.trim();
  if (text.isEmpty) return (previous ?? 0) > 0 ? previous : null;
  final parsed = RegExp(r'^\d+$').hasMatch(text) ? int.tryParse(text) : null;
  if (parsed == null || parsed <= 0 || parsed > 9007199254740991) {
    throw FormatException('模型 $id 的$label要填正整数 tokens，或留空');
  }
  return parsed;
}

Map<String, dynamic> _modelWithCapacity(
  String id,
  ModelCapacityInput input, {
  int? previousWindow,
  int? previousOutput,
}) {
  final window = _capacityValue(
    input.contextWindow,
    previousWindow,
    id,
    '上下文窗口',
  );
  final output = _capacityValue(input.maxTokens, previousOutput, id, '最大输出');
  if (window != null && output != null && output > window) {
    throw FormatException('模型 $id 的最大输出不能超过上下文窗口');
  }
  return {
    'id': id,
    if (window != null) 'contextWindow': window,
    if (output != null) 'maxTokens': output,
  };
}

/// 卡片保存协议：模型 ID 非空且唯一，名称留空使用 ID，每行单独解析并校验容量。
ModelGroupModelsPayload buildModelCardModels(Iterable<ModelCardDraft> rows) {
  final models = <Map<String, dynamic>>[];
  final seen = <String>{};
  for (final row in rows) {
    final id = row.id.trim();
    if (id.isEmpty) {
      return ModelGroupModelsPayload.failure(
        '第 ${models.length + 1} 个模型需要填写模型 ID',
      );
    }
    if (id.contains('\n') || id.contains('\r')) {
      return const ModelGroupModelsPayload.failure('每张卡片只能填写一个模型 ID');
    }
    if (!seen.add(id)) {
      return ModelGroupModelsPayload.failure('模型 ID 重复：$id');
    }
    try {
      final model = _modelWithCapacity(
        id,
        row.capacity,
        previousWindow: int.tryParse(row.retainedCapacity.contextWindow),
        previousOutput: int.tryParse(row.retainedCapacity.maxTokens),
      );
      model['name'] = row.name.trim().isEmpty ? id : row.name.trim();
      models.add(model);
    } on FormatException catch (error) {
      return ModelGroupModelsPayload.failure(error.message);
    }
  }
  return models.isEmpty
      ? const ModelGroupModelsPayload.failure('至少要添加一个模型')
      : ModelGroupModelsPayload.success(models);
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
    try {
      models.add(
        _modelWithCapacity(
          id,
          input,
          previousWindow: old?.contextWindow,
          previousOutput: old?.maxTokens,
        ),
      );
    } on FormatException catch (error) {
      return ModelGroupModelsPayload.failure(error.message);
    }
  }
  return ModelGroupModelsPayload.success(models);
}
