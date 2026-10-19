import 'package:flutter/material.dart';

import '../model_group_capacity.dart';
import '../models.dart';
import '../theme.dart';

/// 模型卡片只展示和回传输入；草稿身份、添加移除与保存由调用方处理。
class ModelCardsEditor extends StatelessWidget {
  const ModelCardsEditor({
    super.key,
    required this.rows,
    required this.onChanged,
    required this.onAdd,
    required this.onRemove,
    this.focusedRowId,
    this.enabled = true,
    this.thinkingFormats = const [],
    this.thinkingLevels = const [],
  });

  final List<ModelCardDraft> rows;
  final void Function(int rowId, ModelCardDraft Function(ModelCardDraft) update)
  onChanged;
  final VoidCallback onAdd;
  final void Function(int rowId) onRemove;
  final int? focusedRowId;
  final bool enabled;

  /// 上游思考格式的可选项（由服务端下发，见 /api/model-thinking/options）。
  /// 空列表时不给选，但仍保留模型已存的格式。
  final List<String> thinkingFormats;

  /// 七个思考档位（由服务端下发）
  final List<String> thinkingLevels;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Row(
        children: [
          const Text(
            '模型',
            style: TextStyle(fontSize: PB.fsSm, fontWeight: FontWeight.w600),
          ),
          const Spacer(),
          TextButton(
            key: const ValueKey('add-model'),
            onPressed: enabled ? onAdd : null,
            child: const Text('添加模型'),
          ),
        ],
      ),
      const Text(
        '每个模型独立设置。单位：tokens。已有模型留空保留原值；新模型留空使用服务端默认值。',
        style: TextStyle(
          fontSize: PB.fsXxs,
          color: PB.textQuaternary,
          height: 1.5,
        ),
      ),
      for (var index = 0; index < rows.length; index++)
        _card(context, rows[index], index + 1),
    ],
  );

  Widget _card(
    BuildContext context,
    ModelCardDraft row,
    int number,
  ) => Container(
    key: ValueKey('model-card-${row.rowId}'),
    margin: const EdgeInsets.only(top: 12),
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: PB.bgPane,
      borderRadius: BorderRadius.circular(PB.rLg),
      border: Border.all(
        color: row.rowId == focusedRowId ? PB.accent : PB.borderTertiary,
      ),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text(
              '模型 $number',
              style: const TextStyle(
                fontSize: PB.fsXs,
                color: PB.textSecondary,
              ),
            ),
            const Spacer(),
            TextButton(
              key: ValueKey('remove-model-${row.rowId}'),
              onPressed: enabled ? () => onRemove(row.rowId) : null,
              child: const Text('移除'),
            ),
          ],
        ),
        _field(
          'model-id-${row.rowId}',
          '模型 ID',
          row.id,
          (value) =>
              onChanged(row.rowId, (current) => current.copyWith(id: value)),
          autofocus: row.rowId == focusedRowId,
        ),
        const SizedBox(height: 12),
        _field(
          'model-name-${row.rowId}',
          '显示名（可选）',
          row.name,
          (value) =>
              onChanged(row.rowId, (current) => current.copyWith(name: value)),
          hint: '留空使用模型 ID',
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: _field(
                'model-context-${row.rowId}',
                '上下文窗口（tokens）',
                row.capacity.contextWindow,
                (value) => onChanged(
                  row.rowId,
                  (current) => current.copyWith(
                    capacity: current.capacity.copyWith(contextWindow: value),
                  ),
                ),
                numeric: true,
                hint: row.retainedCapacity.contextWindow.isEmpty
                    ? '服务端默认'
                    : '保留原值',
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: _field(
                'model-output-${row.rowId}',
                '最大输出（tokens）',
                row.capacity.maxTokens,
                (value) => onChanged(
                  row.rowId,
                  (current) => current.copyWith(
                    capacity: current.capacity.copyWith(maxTokens: value),
                  ),
                ),
                numeric: true,
                hint: row.retainedCapacity.maxTokens.isEmpty ? '服务端默认' : '保留原值',
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        const Divider(height: 18),
        _thinking(context, row),
      ],
    ),
  );

  /// 思考强度：开不开启 + 上游格式 + 七个档位映射。
  ///
  /// 这里是**唯一**能决定"这个模型到底思不思考"的地方 —— 填错格式不会报错，
  /// 只会静默不思考，所以每项都要给出"留空 = 用默认"以外的明确含义。
  Widget _thinking(BuildContext context, ModelCardDraft row) {
    final current = row.thinking.isEmpty ? row.retainedThinking : row.thinking;
    final levels = thinkingLevels.isEmpty
        ? const ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
        : thinkingLevels;
    void change(ModelThinkingInput Function(ModelThinkingInput) update) =>
        onChanged(
          row.rowId,
          (draft) => draft.copyWith(
            thinking: update(draft.thinking.isEmpty ? draft.retainedThinking : draft.thinking),
          ),
        );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Text(
              '思考强度',
              style: TextStyle(
                fontSize: PB.fsXs,
                fontWeight: FontWeight.w600,
                color: PB.textSecondary,
              ),
            ),
            const Spacer(),
            Switch(
              key: ValueKey('model-reasoning-${row.rowId}'),
              value: current.reasoning,
              onChanged: enabled
                  ? (value) => change(
                      (input) => input.copyWith(
                        reasoning: value,
                        // 关闭思考就把格式和映射一并清掉，避免残留配置继续生效
                        format: value ? input.format : '',
                        levels: value ? input.levels : const {},
                      ),
                    )
                  : null,
            ),
          ],
        ),
        Text(
          current.reasoning
              ? '这个模型会思考。下面选上游格式；档位留空表示这一档不额外传参数。'
              : '这个模型不思考（或你不需要它的思考过程）。开启后才会下发思考参数。',
          style: const TextStyle(
            fontSize: PB.fsXxs,
            color: PB.textQuaternary,
            height: 1.5,
          ),
        ),
        if (current.reasoning) ...[
          const SizedBox(height: 10),
          Row(
            children: [
              const SizedBox(
                width: 96,
                child: Text(
                  '上游格式',
                  style: TextStyle(fontSize: PB.fsXxs, color: PB.textTertiary),
                ),
              ),
              Expanded(
                child: DropdownButtonFormField<String>(
                  key: ValueKey('model-thinking-format-${row.rowId}'),
                  initialValue: current.format.isEmpty ? '' : current.format,
                  isDense: true,
                  decoration: const InputDecoration(isDense: true),
                  items: [
                    const DropdownMenuItem(value: '', child: Text('用默认（不指定）')),
                    for (final format in {
                      ...thinkingFormats,
                      // 已存的格式即使不在选项里也要能显示，否则会静默丢失
                      if (current.format.isNotEmpty) current.format,
                    })
                      DropdownMenuItem(value: format, child: Text(format)),
                  ],
                  onChanged: enabled
                      ? (value) => change(
                          (input) => input.copyWith(format: value ?? ''),
                        )
                      : null,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          for (final level in levels)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Row(
                children: [
                  SizedBox(
                    width: 96,
                    child: Text(
                      level,
                      style: const TextStyle(
                        fontSize: PB.fsXxs,
                        color: PB.textTertiary,
                      ),
                    ),
                  ),
                  Expanded(
                    child: _field(
                      'model-thinking-${row.rowId}-$level',
                      '',
                      current.levels[level] ?? '',
                      (value) => change(
                        (input) => input.copyWith(
                          levels: {...input.levels, level: value.trim()},
                        ),
                      ),
                      hint: '留空 = 这一档不传',
                    ),
                  ),
                ],
              ),
            ),
        ],
      ],
    );
  }

  Widget _field(
    String key,
    String label,
    String value,
    ValueChanged<String> change, {
    bool numeric = false,
    bool autofocus = false,
    String? hint,
  }) => TextFormField(
    key: ValueKey(key),
    initialValue: value,
    enabled: enabled,
    autofocus: autofocus,
    keyboardType: numeric ? TextInputType.number : TextInputType.text,
    decoration: InputDecoration(
      isDense: true,
      labelText: label,
      hintText: hint,
    ),
    onChanged: change,
  );
}

/// 设置页逐模型展示容量，点击该模型进入对应编辑卡片。
class ModelGroupModelSummary extends StatelessWidget {
  const ModelGroupModelSummary({
    super.key,
    required this.group,
    required this.onEdit,
  });

  final ModelGroup group;
  final ValueChanged<ModelSpec> onEdit;

  String _tokens(int value) => value > 0 ? '$value tokens' : '服务端默认';

  /// 摘要里的思考状态：不思考 / 格式 + 已映射档位数
  String _thinking(ModelSpec model) {
    if (!model.reasoning) return '不思考';
    final format = model.thinkingFormat.isEmpty ? '默认格式' : model.thinkingFormat;
    final mapped = model.thinkingLevelMap.values.where((v) => v != null).length;
    return mapped > 0 ? '$format · $mapped 档' : format;
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      for (final model in group.models)
        TextButton(
          key: ValueKey('model-summary-${group.id}-${model.id}'),
          onPressed: () => onEdit(model),
          style: TextButton.styleFrom(alignment: Alignment.centerLeft),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                model.name.isEmpty || model.name == model.id
                    ? model.id
                    : '${model.name}（${model.id}）',
                style: const TextStyle(
                  fontSize: PB.fsXs,
                  color: PB.textSecondary,
                ),
              ),
              Text(
                '上下文：${_tokens(model.contextWindow)} · 最大输出：${_tokens(model.maxTokens)}'
                ' · 思考：${_thinking(model)}',
                style: const TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textQuaternary,
                ),
              ),
            ],
          ),
        ),
    ],
  );
}
