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
    this.thinkingUpstreamValues = const [],
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

  /// 档位可映射到的上游值白名单（由服务端下发）
  final List<String> thinkingUpstreamValues;

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
    // ★ 必须用 touched 而不是"是否为空"：用户主动关掉思考时
    //   reasoning=false、format/levels 都为空，旧逻辑会把它当成"没动过"
    //   又回退到已存的开状态，于是开关点了没反应、关了又弹回来。
    final current = row.thinking.touched ? row.thinking : row.retainedThinking;
    final isOn = current.reasoning == true;
    final levels = thinkingLevels.isEmpty ? kThinkingLevels : thinkingLevels;
    // 上游值只能从白名单里选：手打一个上游不认识的词不会报错，
    // 只会让这一档静默失效（比如给 off 填 on）。
    final upstream = thinkingUpstreamValues.isEmpty
        ? kThinkingUpstreamValues
        : thinkingUpstreamValues;
    void change(ModelThinkingInput Function(ModelThinkingInput) update) =>
        onChanged(
          row.rowId,
          (draft) => draft.copyWith(
            thinking: update(
              draft.thinking.touched ? draft.thinking : draft.retainedThinking,
            ),
          ),
        );

    // 已映射的档位（按界面顺序），用来画一行紧凑的摘要
    final mapped = [
      for (final level in levels)
        if ((current.levels[level] ?? '').isNotEmpty) level,
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // 开关：绿色 = 开，灰色 = 关。不靠文字猜状态。
        // 开启时直接把七个档位按同名全部映射好（max → max），
        // 用户不用逐个选；要改个别档位再展开下面的「微调」。
        InkWell(
          key: ValueKey('model-reasoning-toggle-${row.rowId}'),
          onTap: enabled
              ? () => change(
                  (input) => input.copyWith(
                    reasoning: !isOn,
                    format: isOn ? '' : input.format,
                    levels: isOn
                        ? const {}
                        : (input.levels.isEmpty
                            ? defaultThinkingLevelMap(
                                levels: levels,
                                upstreamValues: upstream,
                              )
                            : input.levels),
                  ),
                )
              : null,
          borderRadius: BorderRadius.circular(PB.rLg),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Row(
              children: [
                Container(
                  width: 30,
                  height: 18,
                  decoration: BoxDecoration(
                    color: isOn
                        ? PB.success
                        : PB.borderTertiary,
                    borderRadius: BorderRadius.circular(9),
                  ),
                  child: AnimatedAlign(
                    duration: const Duration(milliseconds: 140),
                    alignment: isOn
                        ? Alignment.centerRight
                        : Alignment.centerLeft,
                    child: Container(
                      width: 14,
                      height: 14,
                      margin: const EdgeInsets.symmetric(horizontal: 2),
                      decoration: const BoxDecoration(
                        color: Colors.white,
                        shape: BoxShape.circle,
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  isOn ? '思考已开启' : '思考已关闭',
                  style: TextStyle(
                    fontSize: PB.fsXs,
                    fontWeight: FontWeight.w600,
                    color: isOn ? PB.success : PB.textQuaternary,
                  ),
                ),
                const Spacer(),
                Text(
                  isOn ? 'on' : 'off',
                  style: const TextStyle(
                    fontSize: PB.fsXxs,
                    color: PB.textQuaternary,
                    fontFamily: PB.monoFamily,
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 2),
        Text(
          isOn
              ? '前台会给这个模型的 bot 展示思考档位；关掉后前台不再展示。'
              : '这个模型不思考，前台也不会展示思考档位。',
          style: const TextStyle(
            fontSize: PB.fsXxs,
            color: PB.textQuaternary,
            height: 1.5,
          ),
        ),
        if (isOn) ...[
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
          const SizedBox(height: 10),
          // ★ 档位不再摆七个下拉框：开启时已经按同名映射全开好了，
          //   这里只给一行结果，要改个别档位再点「微调」。
          _LevelSummary(
            rowId: row.rowId,
            levels: levels,
            current: current,
            enabled: enabled,
            onReset: () => change(
              (input) => input.copyWith(
                levels: defaultThinkingLevelMap(
                  levels: levels,
                  upstreamValues: upstream,
                ),
              ),
            ),
          ),
          const SizedBox(height: 6),
          _LevelTuner(
            rowId: row.rowId,
            levels: levels,
            upstream: upstream,
            current: current,
            enabled: enabled,
            change: change,
          ),
          const SizedBox(height: 6),
          Text(
            mapped.isEmpty
                ? '当前没有任何档位映射，前台不会展示思考档位。'
                : '前台只会展示映射过的 ${mapped.length} 个档位；要增减就展开微调。',
            style: const TextStyle(
              fontSize: PB.fsXxs,
              color: PB.textQuaternary,
              height: 1.5,
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

/// 思考档位的一行摘要：把全部档位的映射结果压成一行，
/// 让用户一眼看出「开到了哪」、哪档没映射，而不是对着七个下拉框发楞。
class _LevelSummary extends StatelessWidget {
  const _LevelSummary({
    required this.rowId,
    required this.levels,
    required this.current,
    required this.enabled,
    required this.onReset,
  });

  final int rowId;
  final List<String> levels;
  final ModelThinkingInput current;
  final bool enabled;
  final VoidCallback onReset;

  @override
  Widget build(BuildContext context) =>
      Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const SizedBox(
            width: 96,
            child: Text(
              '档位映射',
              style: TextStyle(fontSize: PB.fsXxs, color: PB.textTertiary),
            ),
          ),
          Expanded(
            child: Wrap(
              spacing: 6,
              runSpacing: 6,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                for (final level in levels)
                  _LevelChip(
                    key: ValueKey('model-thinking-chip-$rowId-$level'),
                    level: level,
                    value: current.levels[level] ?? '',
                  ),
                // 一键回到同名映射：用户改乱了能一步还原
                InkWell(
                  key: ValueKey('model-thinking-reset-$rowId'),
                  onTap: enabled ? onReset : null,
                  borderRadius: BorderRadius.circular(PB.rSm),
                  child: const Padding(
                    padding: EdgeInsets.symmetric(horizontal: 6, vertical: 3),
                    child: Text(
                      '恢复同名',
                      style: TextStyle(
                        fontSize: PB.fsXxs,
                        color: PB.textTertiary,
                        decoration: TextDecoration.underline,
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      );
}

/// 单个档位的紧凑胶囊：映射了就高亮，没映射就是淡的「未启用」。
class _LevelChip extends StatelessWidget {
  const _LevelChip({super.key, required this.level, required this.value});

  final String level;
  final String value;

  @override
  Widget build(BuildContext context) {
    final on = value.isNotEmpty;
    // 同名映射（max → max）不必重复写两遍，只显档位名就好
    final same = on && value == level;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: on ? PB.success.withValues(alpha: 0.12) : Colors.transparent,
        borderRadius: BorderRadius.circular(PB.rSm),
        border: Border.all(
          color: on ? PB.success.withValues(alpha: 0.35) : PB.borderTertiary,
        ),
      ),
      child: Text(
        on && !same ? '$level→$value' : level,
        style: TextStyle(
          fontSize: PB.fsXxs,
          fontFamily: PB.monoFamily,
          fontWeight: on ? FontWeight.w600 : FontWeight.w400,
          color: on ? PB.success : PB.textQuaternary,
        ),
      ),
    );
  }
}

/// 逐档微调：默认收起。绝大多数人不需要碰，展开再给七个下拉框。
class _LevelTuner extends StatefulWidget {
  const _LevelTuner({
    required this.rowId,
    required this.levels,
    required this.upstream,
    required this.current,
    required this.enabled,
    required this.change,
  });

  final int rowId;
  final List<String> levels;
  final List<String> upstream;
  final ModelThinkingInput current;
  final bool enabled;
  final void Function(ModelThinkingInput Function(ModelThinkingInput)) change;

  @override
  State<_LevelTuner> createState() => _LevelTunerState();
}

class _LevelTunerState extends State<_LevelTuner> {
  bool _open = false;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      InkWell(
        key: ValueKey('model-thinking-tune-${widget.rowId}'),
        onTap: () => setState(() => _open = !_open),
        borderRadius: BorderRadius.circular(PB.rSm),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                _open ? Icons.expand_less : Icons.expand_more,
                size: 14,
                color: PB.textTertiary,
              ),
              const SizedBox(width: 4),
              Text(
                _open ? '收起微调' : '微调单个档位',
                style: const TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textTertiary,
                ),
              ),
            ],
          ),
        ),
      ),
      if (_open)
        for (final level in widget.levels)
          Padding(
            padding: const EdgeInsets.only(bottom: 6, left: 18),
            child: Row(
              children: [
                SizedBox(
                  width: 78,
                  child: Text(
                    level,
                    style: const TextStyle(
                      fontSize: PB.fsXxs,
                      fontFamily: PB.monoFamily,
                      color: PB.textTertiary,
                    ),
                  ),
                ),
                Expanded(
                  child: DropdownButtonFormField<String>(
                    key: ValueKey('model-thinking-${widget.rowId}-$level'),
                    initialValue: widget.current.levels[level] ?? '',
                    isDense: true,
                    decoration: const InputDecoration(isDense: true),
                    items: [
                      const DropdownMenuItem(
                        value: '',
                        child: Text('不传（这一档不生效）'),
                      ),
                      for (final value in {
                        ...widget.upstream,
                        // 已存的值即使不在白名单也要能显示，避免静默丢失
                        if ((widget.current.levels[level] ?? '').isNotEmpty)
                          widget.current.levels[level]!,
                      })
                        DropdownMenuItem(value: value, child: Text(value)),
                    ],
                    onChanged: widget.enabled
                        ? (value) => widget.change(
                            (input) => input.copyWith(
                              levels: {...input.levels, level: value ?? ''},
                            ),
                          )
                        : null,
                  ),
                ),
              ],
            ),
          ),
    ],
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
