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

/// 思考强度输入。
///
/// 这里有**三种**状态，不能塞进一个 `isEmpty` 里 —— 否则"用户主动关掉思考"
/// 和"用户没动过思考设置"长得一模一样，开关点不掉、关了又弹回来：
///
/// | 状态 | reasoning | 是否提交 | 含义 |
/// |---|---|---|---|
/// | 未动过 | null | 不提交 | 保留服务端原有配置 |
/// | 主动关闭 | false | `reasoning:false` | 真的不要思考 |
/// | 开启 | true | 全量提交 | 开启并下发档位 |
class ModelThinkingInput {
  const ModelThinkingInput({
    this.reasoning,
    this.format = '',
    this.levels = const {},
  });

  /// null = 用户没动过（继承服务端配置）；true/false = 用户明确设过
  final bool? reasoning;

  /// 上游思考格式；空 = 用 pi 默认
  final String format;

  /// 档位 → 上游值；空串表示这一档不传
  final Map<String, String> levels;

  ModelThinkingInput copyWith({
    bool? reasoning,
    String? format,
    Map<String, String>? levels,
  }) => ModelThinkingInput(
    reasoning: reasoning ?? this.reasoning,
    format: format ?? this.format,
    levels: levels ?? this.levels,
  );

  /// 用户是否动过这个模型条目的思考设置
  bool get touched => reasoning != null || format.isNotEmpty || levels.isNotEmpty;

  /// 开启思考且带了配置
  bool get enabled => reasoning == true;

  /// 转成提交给服务端的字段。
  ///
  /// 未动过（`touched == false`）时不提交，保留服务端原有配置；
  /// 主动关闭时必须显式提 `reasoning:false`，否则服务端会当成“没改”而保留旧值。
  Map<String, dynamic> toJson() => {
    if (touched) 'reasoning': enabled,
    if (enabled && format.isNotEmpty) 'thinkingFormat': format,
    if (enabled && levels.isNotEmpty) 'thinkingLevelMap': levels,
  };
}

/// 单张模型卡片的草稿。rowId 仅供界面保持身份，修改模型 ID 不会改变本行容量。
class ModelCardDraft {
  const ModelCardDraft({
    required this.rowId,
    this.id = '',
    this.name = '',
    this.capacity = const ModelCapacityInput(),
    this.retainedCapacity = const ModelCapacityInput(),
    this.thinking = const ModelThinkingInput(),
    this.retainedThinking = const ModelThinkingInput(),
  });

  final int rowId;
  final String id;
  final String name;
  final ModelCapacityInput capacity;
  final ModelCapacityInput retainedCapacity;
  final ModelThinkingInput thinking;

  /// 服务端已存的那份：界面清空时回退到这里，不能清成"不思考"
  final ModelThinkingInput retainedThinking;

  ModelCardDraft copyWith({
    String? id,
    String? name,
    ModelCapacityInput? capacity,
    ModelThinkingInput? thinking,
  }) => ModelCardDraft(
    rowId: rowId,
    id: id ?? this.id,
    name: name ?? this.name,
    capacity: capacity ?? this.capacity,
    retainedCapacity: retainedCapacity,
    thinking: thinking ?? this.thinking,
    retainedThinking: retainedThinking,
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
    final thinking = ModelThinkingInput(
      // 已存配置里 reasoning 是明确的 true/false，视为“用户已设过”
      reasoning: (model.reasoning ||
              model.thinkingFormat.isNotEmpty ||
              model.thinkingLevelMap.isNotEmpty)
          ? model.reasoning
          : null,
      format: model.thinkingFormat,
      levels: {
        for (final entry in model.thinkingLevelMap.entries)
          if (entry.value != null) entry.key: entry.value!,
      },
    );
    rows.add(
      ModelCardDraft(
        rowId: rows.length,
        id: model.id,
        name: model.name == model.id ? '' : model.name,
        capacity: retained,
        retainedCapacity: retained,
        thinking: thinking,
        retainedThinking: thinking,
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
  ModelThinkingInput thinking = const ModelThinkingInput(),
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
    // 思考强度：未设置时不提交，交给服务端保留原值
    ...thinking.toJson(),
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
        // 用户没动思考设置时回传已存那份；动过就提交用户的选择
        thinking: row.thinking.touched ? row.thinking : row.retainedThinking,
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
  Map<String, ModelThinkingInput> thinking = const {},
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
    // 没显式改思考设置时，沿用它原来那份（模型名没变才成立）
    final retainedThinking = old == null
        ? const ModelThinkingInput()
        : ModelThinkingInput(
            // ★ 只有模型真的声明过 thinking 字段才算“已设过”；
            //   旧配置只有容量时不能当成“用户明确关掉了思考”，
            //   否则保存容量会把 reasoning:false 塞回给服务端。
            reasoning: (old.reasoning ||
                    old.thinkingFormat.isNotEmpty ||
                    old.thinkingLevelMap.isNotEmpty)
                ? old.reasoning
                : null,
            format: old.thinkingFormat,
            levels: {
              for (final entry in old.thinkingLevelMap.entries)
                if (entry.value != null) entry.key: entry.value!,
            },
          );
    final explicit = thinking[id];
    try {
      models.add(
        _modelWithCapacity(
          id,
          input,
          previousWindow: old?.contextWindow,
          previousOutput: old?.maxTokens,
          thinking: explicit == null || !explicit.touched
              ? retainedThinking
              : explicit,
        ),
      );
    } on FormatException catch (error) {
      return ModelGroupModelsPayload.failure(error.message);
    }
  }
  return ModelGroupModelsPayload.success(models);
}
