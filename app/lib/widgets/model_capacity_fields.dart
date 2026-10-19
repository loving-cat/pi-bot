import 'package:flutter/material.dart';

import '../model_group_capacity.dart';
import '../theme.dart';

/// 每个模型各自的容量表单；输入状态与保存由调用方处理。
class ModelCapacityFields extends StatelessWidget {
  const ModelCapacityFields({
    super.key,
    required this.modelIds,
    required this.inputs,
    required this.retainedInputs,
    required this.onChanged,
  });

  final List<String> modelIds;
  final Map<String, ModelCapacityInput> inputs;
  final Map<String, ModelCapacityInput> retainedInputs;
  final void Function(String id, ModelCapacityInput input) onChanged;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const Text(
        '单位：tokens。已有模型留空保留原值；新模型留空使用服务端默认值。',
        style: TextStyle(
          fontSize: PB.fsXxs,
          color: PB.textQuaternary,
          height: 1.5,
        ),
      ),
      if (modelIds.isEmpty)
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 8),
          child: Text('先在上方填写模型名，再分别设置容量。'),
        ),
      for (final id in modelIds) ...[
        const SizedBox(height: 12),
        Text(
          id,
          style: const TextStyle(fontSize: PB.fsXs, color: PB.textSecondary),
        ),
        const SizedBox(height: 6),
        Row(
          children: [
            Expanded(
              child: TextFormField(
                key: ValueKey('model-context-$id'),
                initialValue: inputs[id]?.contextWindow ?? '',
                keyboardType: TextInputType.number,
                decoration: InputDecoration(
                  isDense: true,
                  labelText: '上下文窗口（tokens）',
                  hintText: (retainedInputs[id]?.contextWindow ?? '').isEmpty
                      ? '服务端默认'
                      : '保留原值',
                ),
                onChanged: (value) => onChanged(
                  id,
                  (inputs[id] ?? const ModelCapacityInput()).copyWith(
                    contextWindow: value,
                  ),
                ),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: TextFormField(
                key: ValueKey('model-output-$id'),
                initialValue: inputs[id]?.maxTokens ?? '',
                keyboardType: TextInputType.number,
                decoration: InputDecoration(
                  isDense: true,
                  labelText: '最大输出（tokens）',
                  hintText: (retainedInputs[id]?.maxTokens ?? '').isEmpty
                      ? '服务端默认'
                      : '保留原值',
                ),
                onChanged: (value) => onChanged(
                  id,
                  (inputs[id] ?? const ModelCapacityInput()).copyWith(
                    maxTokens: value,
                  ),
                ),
              ),
            ),
          ],
        ),
      ],
    ],
  );
}
