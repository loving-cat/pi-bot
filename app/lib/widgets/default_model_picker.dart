import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../l10n/l10n.dart';
import '../scope.dart';
import '../theme.dart';

/// 配好模型组之后让用户挑一个默认模型。
///
/// 为什么要这一步：模型组里可能有好几个模型，但总得有一个是「不说用哪个时用哪个」。
/// 不选的话主控没法回话，用户配完还是静默失败。
///
/// 返回选中的 slug（`组ID/模型ID`）；用户取消返回 null。
Future<String?> showDefaultModelPicker(BuildContext context) {
  return showDialog<String>(
    context: context,
    builder: (_) => const _DefaultModelPicker(),
  );
}

class _DefaultModelPicker extends StatefulWidget {
  const _DefaultModelPicker();

  @override
  State<_DefaultModelPicker> createState() => _DefaultModelPickerState();
}

class _DefaultModelPickerState extends State<_DefaultModelPicker> {
  String? _picked;
  bool _saving = false;

  @override
  Widget build(BuildContext context) {
    final strings = L10n.s(context);
    final state = AppScope.of(context);
    final groups = state.modelGroups;
    // 只列真正有模型的组：空组选不出东西
    final usable = [
      for (final group in groups)
        if (group.models.isNotEmpty) group,
    ];

    return AlertDialog(
      backgroundColor: PB.bgElevated,
      title: Text(
        strings.t('onboard.pickTitle'),
        style: const TextStyle(fontSize: PB.fsLg),
      ),
      content: SizedBox(
        width: 420,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              strings.t('onboard.pickSubtitle'),
              style: TextStyle(
                fontSize: PB.fsXs,
                color: PB.textTertiary,
                height: 1.55,
              ),
            ),
            const SizedBox(height: 14),
            if (usable.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Text(
                  strings.t('onboard.noModelsInGroup'),
                  style: TextStyle(
                    fontSize: PB.fsSm,
                    color: PB.textSecondary,
                  ),
                ),
              )
            else
              Flexible(
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      for (final group in usable) ...[
                        Padding(
                          padding: const EdgeInsets.only(top: 6, bottom: 4),
                          child: Align(
                            alignment: Alignment.centerLeft,
                            child: Text(
                              group.name,
                              style: TextStyle(
                                fontSize: PB.fsXxs,
                                color: PB.textQuaternary,
                              ),
                            ),
                          ),
                        ),
                        for (final model in group.models)
                          _option(
                            slug: '${group.id}/${model.id}',
                            label: model.name.isEmpty ? model.id : model.name,
                            subtitle: model.id,
                          ),
                      ],
                    ],
                  ),
                ),
              ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: _saving ? null : () => Navigator.pop(context),
          child: Text(strings.t('common.cancel')),
        ),
        FilledButton(
          onPressed: _picked == null || _saving ? null : _confirm,
          child: Text(_saving ? strings.t('common.saving') : strings.t('onboard.pickConfirm')),
        ),
      ],
    );
  }

  Widget _option({
    required String slug,
    required String label,
    required String subtitle,
  }) {
    final selected = _picked == slug;
    return InkWell(
      key: ValueKey('default-model-$slug'),
      onTap: () => setState(() => _picked = slug),
      borderRadius: BorderRadius.circular(PB.rLg),
      child: Container(
        margin: const EdgeInsets.only(bottom: 6),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
        decoration: BoxDecoration(
          color: selected ? PB.bgBubble : Colors.transparent,
          borderRadius: BorderRadius.circular(PB.rLg),
          border: Border.all(
            color: selected
                ? PB.colors(context).accentBright
                : PB.borderSecondary,
          ),
        ),
        child: Row(
          children: [
            Icon(
              selected ? LucideIcons.circleCheck : LucideIcons.circle,
              size: 15,
              color: selected
                  ? PB.colors(context).accentBright
                  : PB.textQuaternary,
            ),
            const SizedBox(width: 9),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(label, style: const TextStyle(fontSize: PB.fsSm)),
                  if (subtitle != label)
                    Text(
                      subtitle,
                      style: TextStyle(
                        fontSize: PB.fsXxs,
                        color: PB.textQuaternary,
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _confirm() async {
    final slug = _picked;
    if (slug == null) return;
    setState(() => _saving = true);
    final state = AppScope.read(context);
    final main = state.mainBot;
    // 设到主控上：它是"不说用哪个时"的默认选择
    if (main != null) {
      await state.updateBot(main.id, {'model': slug});
    }
    if (!mounted) return;
    Navigator.pop(context, slug);
  }
}
