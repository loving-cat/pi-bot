import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../l10n/l10n.dart';
import '../model_display.dart';
import '../models.dart';
import '../scope.dart';
import '../theme.dart';

/// 给 bot 选模型 —— 精简分组辨识展示卡片 + 可展开原始编辑与列表挑选。
///
/// 底层始终保留挂载对应 `controller` 的 [TextField]，以便现有调试/测试定位；
/// 平时展示「[● 组简称]  精简模型名」，悬停或点编辑图标可查看/修改完整 slug。
class ModelPickerField extends StatefulWidget {
  const ModelPickerField({
    super.key,
    required this.controller,
    this.label,
    this.onPicked,
    this.onCommitted,
    this.enabled = true,
    this.helperText,
    this.canCommit,
  });

  final TextEditingController controller;

  /// 输入框标签；为空时用词表里的默认文案。
  final String? label;

  /// 选完/手改后通知调用方重建 —— 思考等级区域要跟着模型变。
  final ValueChanged<String>? onPicked;

  /// 列表确认或手动输入提交时触发，不随每个输入字符保存。
  final ValueChanged<String>? onCommitted;
  final bool enabled;
  final String? helperText;

  /// 对话框返回时确认选择仍属于原调用对象。
  final bool Function()? canCommit;

  @override
  State<ModelPickerField> createState() => _ModelPickerFieldState();
}

class _ModelPickerFieldState extends State<ModelPickerField> {
  final FocusNode _focus = FocusNode();
  bool _editingRaw = false;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onControllerChanged);
    _focus.addListener(_onFocusChanged);
  }

  @override
  void didUpdateWidget(ModelPickerField oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_onControllerChanged);
      widget.controller.addListener(_onControllerChanged);
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onControllerChanged);
    _focus.removeListener(_onFocusChanged);
    _focus.dispose();
    super.dispose();
  }

  void _onControllerChanged() {
    if (mounted) setState(() {});
  }

  void _onFocusChanged() {
    if (!_focus.hasFocus && _editingRaw && mounted) {
      setState(() => _editingRaw = false);
    }
  }

  void _enterRawEdit() {
    if (!widget.enabled) return;
    setState(() => _editingRaw = true);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _focus.requestFocus();
    });
  }

  @override
  Widget build(BuildContext context) {
    final strings = L10n.s(context);
    final groups =
        context.dependOnInheritedWidgetOfExactType<AppScope>()?.notifier?.modelGroups ??
        const <ModelGroup>[];
    final rawText = widget.controller.text.trim();
    final showCard = !_editingRaw && rawText.isNotEmpty;
    final info = compactModelDisplay(rawText, groups);
    final labelText = widget.label ?? strings.t('model.pickerLabel');

    final rawField = TextField(
      controller: widget.controller,
      focusNode: _focus,
      enabled: widget.enabled,
      decoration: InputDecoration(
        labelText: showCard ? null : labelText,
        hintText: 'provider/model-id',
        helperText: showCard ? null : widget.helperText,
        helperMaxLines: 2,
        suffixIcon: showCard
            ? null
            : IconButton(
                tooltip: strings.t('model.pickFromList'),
                icon: const Icon(LucideIcons.list, size: 18),
                onPressed: widget.enabled ? () => _pick(context) : null,
              ),
      ),
      onChanged: widget.onPicked,
      onSubmitted: (value) {
        if (widget.canCommit?.call() != false) {
          widget.onCommitted?.call(value);
        }
        if (mounted) setState(() => _editingRaw = false);
      },
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (showCard) ...[
          _CompactModelCard(
            key: const ValueKey('model-compact-card'),
            label: labelText,
            helperText: widget.helperText,
            info: info,
            enabled: widget.enabled,
            pickTooltip: strings.t('model.pickFromList'),
            editTooltip: strings.t('model.editRaw'),
            onPick: () => _pick(context),
            onEditRaw: _enterRawEdit,
          ),
          // 保持底层 TextField 在位且可被子树查找定位，同时零占位、不抢焦点或点击
          ClipRect(
            child: SizedBox(
              height: 0,
              child: OverflowBox(
                alignment: Alignment.topLeft,
                minHeight: 0,
                maxHeight: 160,
                child: IgnorePointer(
                  child: ExcludeFocus(
                    child: Opacity(opacity: 0, child: rawField),
                  ),
                ),
              ),
            ),
          ),
        ] else
          rawField,
      ],
    );
  }

  Future<void> _pick(BuildContext context) async {
    final strings = L10n.s(context);
    final state = AppScope.read(context);
    final groups = state.modelGroups.where((group) => group.enabled).toList();
    final groupTags = buildDistinctGroupTags(groups);

    final picked = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: PB.bgElevated,
        title: Text(
          strings.t('model.pickTitle'),
          style: const TextStyle(fontSize: PB.fsLg),
        ),
        content: SizedBox(
          width: 460,
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                if (groups.isEmpty)
                  Text(
                    strings.t('model.emptyGroups'),
                    style: TextStyle(
                      fontSize: PB.fsXs,
                      color: PB.textQuaternary,
                      height: 1.7,
                    ),
                  )
                else
                  for (final g in groups) ...[
                    Padding(
                      padding: const EdgeInsets.only(top: 8, bottom: 4),
                      child: Row(
                        children: [
                          Container(
                            width: 7,
                            height: 7,
                            decoration: BoxDecoration(
                              color: PB.colorFor(g.id),
                              shape: BoxShape.circle,
                            ),
                          ),
                          const SizedBox(width: 6),
                          Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 6,
                              vertical: 1.5,
                            ),
                            decoration: BoxDecoration(
                              color: PB.colorFor(g.id).withValues(alpha: 0.14),
                              borderRadius: BorderRadius.circular(PB.rFull),
                            ),
                            child: Text(
                              groupTags[g.id] ?? g.name,
                              style: TextStyle(
                                fontSize: PB.fsXxs,
                                fontWeight: FontWeight.w600,
                                color: PB.colorFor(g.id),
                              ),
                            ),
                          ),
                          if ((groupTags[g.id] ?? g.name) != g.name) ...[
                            const SizedBox(width: 6),
                            Expanded(
                              child: Text(
                                g.name,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  fontSize: PB.fsXxs,
                                  color: PB.textQuaternary,
                                ),
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                    for (final m in g.models)
                      () {
                        final short = shortenModelName(m.id, specName: m.name);
                        final subParts = <String>[
                          if (short != m.id) m.id,
                          if (m.contextWindow > 0)
                            strings.tf('model.contextShort', {
                              'n': (m.contextWindow / 1000).round(),
                            }),
                          if (m.maxTokens > 0)
                            strings.tf('model.maxOutputShort', {
                              'n': m.maxTokens,
                            }),
                        ];
                        return ListTile(
                          dense: true,
                          contentPadding: EdgeInsets.zero,
                          title: Text(
                            short,
                            style: TextStyle(
                              fontSize: PB.fsSm,
                              fontWeight: FontWeight.w500,
                              color: PB.textPrimary,
                            ),
                          ),
                          subtitle: subParts.isEmpty
                              ? null
                              : Text(
                                  subParts.join(' · '),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                    fontSize: PB.fsXxs,
                                    color: PB.textQuaternary,
                                  ),
                                ),
                          onTap: () => Navigator.pop(ctx, g.slugFor(m.id)),
                        );
                      }(),
                  ],
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text(strings.t('common.cancel')),
          ),
        ],
      ),
    );
    if (!context.mounted || widget.canCommit?.call() == false) return;
    if (picked != null && picked.isNotEmpty) {
      widget.controller.text = picked;
      setState(() => _editingRaw = false);
      // 选完要让调用方重建：思考等级区域跟着模型走
      widget.onPicked?.call(picked);
      widget.onCommitted?.call(picked);
    }
  }
}

class _CompactModelCard extends StatelessWidget {
  const _CompactModelCard({
    super.key,
    required this.label,
    required this.info,
    required this.enabled,
    required this.pickTooltip,
    required this.editTooltip,
    required this.onPick,
    required this.onEditRaw,
    this.helperText,
  });

  final String label;
  final String? helperText;
  final CompactModelInfo info;
  final bool enabled;
  final String pickTooltip;
  final String editTooltip;
  final VoidCallback onPick;
  final VoidCallback onEditRaw;

  @override
  Widget build(BuildContext context) {
    final groupColor = info.groupId.isNotEmpty
        ? PB.colorFor(info.groupId)
        : PB.textTertiary;
    final fullTip = info.groupName.isNotEmpty && info.groupName != info.groupTag
        ? '${info.groupName} / ${info.modelId}'
        : info.fullSlug;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Padding(
          padding: const EdgeInsets.only(left: 2, bottom: 5),
          child: Text(
            label,
            style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
          ),
        ),
        Tooltip(
          message: fullTip,
          child: Material(
            color: PB.bgInput,
            borderRadius: BorderRadius.circular(PB.rXl),
            child: InkWell(
              onTap: enabled ? onPick : null,
              borderRadius: BorderRadius.circular(PB.rXl),
              child: Container(
                padding: const EdgeInsets.fromLTRB(12, 8, 4, 8),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(PB.rXl),
                  border: Border.all(color: PB.borderSecondary),
                ),
                child: Row(
                  children: [
                    if (info.hasGroup) ...[
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 7,
                          vertical: 2.5,
                        ),
                        decoration: BoxDecoration(
                          color: groupColor.withValues(alpha: 0.14),
                          borderRadius: BorderRadius.circular(PB.rFull),
                          border: Border.all(
                            color: groupColor.withValues(alpha: 0.30),
                          ),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Container(
                              width: 6,
                              height: 6,
                              decoration: BoxDecoration(
                                color: groupColor,
                                shape: BoxShape.circle,
                              ),
                            ),
                            const SizedBox(width: 5),
                            Text(
                              info.groupTag,
                              style: TextStyle(
                                fontSize: PB.fsXxs,
                                fontWeight: FontWeight.w600,
                                color: groupColor,
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 8),
                    ],
                    Expanded(
                      child: Text(
                        info.modelLabel,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: PB.fsSm,
                          fontWeight: FontWeight.w500,
                          color: PB.textPrimary,
                        ),
                      ),
                    ),
                    IconButton(
                      tooltip: editTooltip,
                      icon: Icon(
                        LucideIcons.pencil,
                        size: 14,
                        color: PB.textQuaternary,
                      ),
                      visualDensity: VisualDensity.compact,
                      constraints: const BoxConstraints(
                        minWidth: 30,
                        minHeight: 30,
                      ),
                      padding: EdgeInsets.zero,
                      onPressed: enabled ? onEditRaw : null,
                    ),
                    IconButton(
                      tooltip: pickTooltip,
                      icon: Icon(
                        LucideIcons.list,
                        size: 17,
                        color: PB.textTertiary,
                      ),
                      visualDensity: VisualDensity.compact,
                      constraints: const BoxConstraints(
                        minWidth: 32,
                        minHeight: 30,
                      ),
                      padding: EdgeInsets.zero,
                      onPressed: enabled ? onPick : null,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
        if (helperText != null && helperText!.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 6, 4, 0),
            child: Text(
              helperText!,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
            ),
          ),
      ],
    );
  }
}
