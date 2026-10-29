import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../app_state.dart';
import '../bot_model_selection.dart';
import '../model_selection_save.dart';
import '../models.dart';
import '../scope.dart';
import '../theme.dart';
import 'toast.dart';
import 'model_picker_field.dart';
import 'thinking_slider.dart';

/// 「运行参数」—— 面板的「详情」页里那一段：这个会话到底用谁、用什么模型、
/// 想多久、上下文给多大。
///
/// 模型、上下文窗口、思考等级都在这里就地改，
/// 不用跑去 bot 花名册里改（离得远，用户也找不到）。
///
/// 为什么放在「详情」而不是「成员」页：详情页是"这个会话怎么跑"的地方，
/// 成员页是"里面都有谁"。参数属于前者。
class BotRunSection extends StatefulWidget {
  const BotRunSection({super.key, required this.bot});

  /// 这个会话"说了算"的那个 bot：私聊就是对方，群聊就是负责人。
  final Bot bot;

  @override
  State<BotRunSection> createState() => _BotRunSectionState();
}

class _BotRunSectionState extends State<BotRunSection> {
  /// pi 的七个档位（顺序即强弱顺序）。具体给哪几档由模型能力决定。
  static const _allLevels = [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ];

  /// 这个 bot 当前模型真正支持的档位（模型组里没声明就退回内置档位，保持兼容）
  List<String> _levelsFor(AppState state) {
    final slug = (widget.bot.model ?? '').trim();
    ModelSpec? spec;
    if (slug.contains('/')) {
      final i = slug.indexOf('/');
      final gid = slug.substring(0, i);
      final mid = slug.substring(i + 1);
      for (final g in state.modelGroups) {
        if (g.id != gid) continue;
        for (final m in g.models) {
          if (m.id == mid) spec = m;
        }
      }
    } else if (slug.isNotEmpty) {
      final hits = [
        for (final g in state.modelGroups)
          for (final m in g.models)
            if (m.id == slug) m,
      ];
      if (hits.length == 1) spec = hits.single;
    }
    if (spec == null) return _allLevels;
    if (!spec.reasoning) return const [];
    final declared = spec.thinkingLevels;
    if (declared.isEmpty) return _allLevels;
    return [
      for (final level in _allLevels)
        if (declared.contains(level)) level,
    ];
  }

  late final TextEditingController _model = TextEditingController(
    text: widget.bot.model ?? '',
  );
  late final TextEditingController _reserve = TextEditingController(
    text: widget.bot.reserveTokens?.toString() ?? '',
  );
  late final TextEditingController _keep = TextEditingController(
    text: widget.bot.keepRecentTokens?.toString() ?? '',
  );
  bool _saving = false;
  ModelSelectionSave? _modelSave;
  AppState? _modelState;
  Object? _modelApi;
  String? _modelBotId;
  bool _modelDraft = false;
  bool _bindingModel = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _bindModelSave(AppScope.of(context));
  }

  void _bindModelSave(AppState state) {
    final api = state.api;
    final id = widget.bot.id;
    if (identical(state, _modelState) &&
        identical(api, _modelApi) &&
        id == _modelBotId) {
      _modelSave?.synchronize(widget.bot.model ?? '');
      if (_modelSave?.saving != true &&
          !_modelDraft &&
          _modelSave?.failed != true) {
        final value = widget.bot.model ?? '';
        if (_model.text != value) _model.text = value;
      }
      return;
    }
    _bindingModel = true;
    _modelSave?.removeListener(_onModelSave);
    _modelState = state;
    _modelApi = api;
    _modelBotId = id;
    _modelDraft = false;
    _model.text = widget.bot.model ?? '';
    _modelSave = botModelSelection(state, widget.bot)
      ..addListener(_onModelSave);
    if (_modelSave!.saving || _modelSave!.failed) {
      _model.text = _modelSave!.selectedValue;
      _modelDraft = true;
    }
    _bindingModel = false;
  }

  void _onModelSave() {
    if (!mounted || _bindingModel) return;
    final save = _modelSave!;
    if (!save.saving &&
        !save.failed &&
        (_model.text.trim() == save.selectedValue ||
            _model.text.trim() == save.lastSavedInput)) {
      _modelDraft = false;
      if (_model.text != save.selectedValue) _model.text = save.selectedValue;
    }
    setState(() {});
  }

  void _selectModel(String value) {
    _modelDraft = true;
    unawaited(_modelSave!.select(value));
  }

  @override
  void didUpdateWidget(BotRunSection old) {
    super.didUpdateWidget(old);
    // 换会话/换 bot 了：把输入框同步成新的值
    if (old.bot.id != widget.bot.id) {
      _model.text = widget.bot.model ?? '';
      _reserve.text = widget.bot.reserveTokens?.toString() ?? '';
      _keep.text = widget.bot.keepRecentTokens?.toString() ?? '';
    }
    _bindModelSave(AppScope.read(context));
  }

  @override
  void dispose() {
    _modelSave?.removeListener(_onModelSave);
    _model.dispose();
    _reserve.dispose();
    _keep.dispose();
    super.dispose();
  }

  Future<void> _patch(Map<String, dynamic> patch, {String? msg}) async {
    final state = AppScope.read(context);
    setState(() => _saving = true);
    try {
      await state.updateBot(widget.bot.id, patch);
      if (!mounted) return;
      // ★ 参数别叫 toast —— 会把这个文件里的 toast() 函数遮蔽掉
      if (msg != null) {
        toast(context, msg);
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _saveBudget() async {
    int? num(TextEditingController c) {
      final t = c.text.trim();
      if (t.isEmpty) return null;
      return int.tryParse(t);
    }

    final r = num(_reserve);
    final k = num(_keep);
    if (r == null && _reserve.text.trim().isNotEmpty) {
      _toast('预留值要填数字（或者留空用默认）');
      return;
    }
    if (k == null && _keep.text.trim().isNotEmpty) {
      _toast('保留最近要填数字（或者留空用默认）');
      return;
    }
    await _patch({
      'reserveTokens': r,
      'keepRecentTokens': k,
    }, msg: '上下文预算已保存，下一轮生效');
  }

  void _toast(String text) => toast(context, text);

  @override
  Widget build(BuildContext context) {
    final bot = widget.bot;
    final thinking = bot.thinking ?? '';
    final modelSave = _modelSave!;
    final saving = _saving || modelSave.saving;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 6),
        Row(
          children: [
            const Icon(
              LucideIcons.slidersHorizontal,
              size: 14,
              color: PB.textTertiary,
            ),
            const SizedBox(width: 6),
            const Text(
              '运行参数',
              style: TextStyle(
                fontSize: PB.fsXs,
                fontWeight: FontWeight.w600,
                color: PB.textSecondary,
              ),
            ),
            const Spacer(),
            Text(
              bot.isMain ? '主控' : bot.name,
              style: const TextStyle(
                fontSize: PB.fsXs,
                color: PB.textQuaternary,
              ),
            ),
            if (saving) ...[
              const SizedBox(width: 8),
              const SizedBox(
                width: 11,
                height: 11,
                child: CircularProgressIndicator(
                  strokeWidth: 1.8,
                  color: PB.accent,
                ),
              ),
            ],
          ],
        ),
        const SizedBox(height: 10),

        // 模型
        ModelPickerField(
          controller: _model,
          label: '模型（留空用默认）',
          helperText: '选择即应用；手动输入后按回车应用',
          enabled: !_saving,
          canCommit: () => mounted && identical(_modelSave, modelSave),
          onPicked: (_) => _modelDraft = true,
          onCommitted: _selectModel,
        ),
        const SizedBox(height: 4),
        if (modelSave.saving)
          const Text(
            '正在切换模型…',
            style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
          ),
        if (modelSave.failed)
          Row(
            children: [
              const Expanded(
                child: Text(
                  '未能确认模型切换，请重试。',
                  style: TextStyle(fontSize: PB.fsXs, color: PB.danger),
                ),
              ),
              TextButton(
                onPressed: () => unawaited(modelSave.retry()),
                child: const Text('重试'),
              ),
            ],
          ),
        if (!modelSave.saving &&
            !modelSave.failed &&
            modelSave.hasSaved &&
            !_modelDraft)
          const Text(
            '模型已切换，下一轮使用',
            style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
          ),

        // 思考等级：滑条（从关到 max 一档一档拖过去）
        //
        // 为什么不做成一排 chip：七个档位横排会挤成一团，看不出"现在到哪、还能往哪走"。
        // 滑条更贴合"思考强度是一根刻度尺"的心理模型；顶格（max）时小球会呼吸发光。
        ThinkingLevelField(
          levels: _levelsFor(AppScope.of(context)),
          value: thinking.isEmpty ? null : thinking,
          enabled: !saving,
          onChanged: (level) {
            // 停到某一档就立刻生效，不弹提示（滑块本身已经给出反馈）
            _patch({'thinking': level});
          },
        ),
        const SizedBox(height: 12),

        // 上下文预算
        const Text(
          '上下文预算',
          style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
        ),
        const SizedBox(height: 4),
        const Text(
          '留空就用全局默认。改大 = 记得更多但更贵；改小 = 便宜但更容易忘事。',
          style: TextStyle(
            fontSize: PB.fsXxs,
            color: PB.textQuaternary,
            height: 1.5,
          ),
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(
              child: TextField(
                controller: _reserve,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(
                  isDense: true,
                  labelText: '预留（给回复）',
                  hintText: '默认',
                ),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: TextField(
                controller: _keep,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(
                  isDense: true,
                  labelText: '保留最近',
                  hintText: '默认',
                ),
              ),
            ),
          ],
        ),
        Align(
          alignment: Alignment.centerRight,
          child: TextButton.icon(
            onPressed: saving ? null : _saveBudget,
            icon: const Icon(LucideIcons.check, size: 14),
            label: const Text('保存预算', style: TextStyle(fontSize: PB.fsXs)),
          ),
        ),
      ],
    );
  }
}
