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
  });

  final List<ModelCardDraft> rows;
  final void Function(int rowId, ModelCardDraft Function(ModelCardDraft) update)
  onChanged;
  final VoidCallback onAdd;
  final void Function(int rowId) onRemove;
  final int? focusedRowId;
  final bool enabled;

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
      ],
    ),
  );

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
                '上下文：${_tokens(model.contextWindow)} · 最大输出：${_tokens(model.maxTokens)}',
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
