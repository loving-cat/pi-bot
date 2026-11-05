import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../l10n/l10n.dart';
import '../theme.dart';

/// 设置页的语言切换：点一下立即生效并落盘。
class LanguageCard extends StatelessWidget {
  const LanguageCard({super.key});

  @override
  Widget build(BuildContext context) {
    final controller = L10n.controllerOf(context);
    final strings = controller.strings;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: PB.bgBubble,
        borderRadius: BorderRadius.circular(PB.rLg),
        border: Border.all(color: PB.borderSecondary),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(LucideIcons.languages, size: 18, color: PB.textSecondary),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  strings.t('settings.language'),
                  style: const TextStyle(fontSize: PB.fsSm),
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            strings.t('settings.languageSubtitle'),
            style: const TextStyle(
              fontSize: PB.fsXxs,
              color: PB.textQuaternary,
              height: 1.5,
            ),
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final language in AppLanguage.values)
                _LanguageChip(
                  language: language,
                  label: language.labelIn(controller.language),
                  selected: controller.language == language,
                  onTap: () => controller.setLanguage(language),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _LanguageChip extends StatelessWidget {
  const _LanguageChip({
    required this.language,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final AppLanguage language;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ChoiceChip(
      key: ValueKey('language-${language.code}'),
      label: Text(label),
      selected: selected,
      onSelected: (_) => onTap(),
    );
  }
}
