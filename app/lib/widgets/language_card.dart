import 'package:flutter/material.dart';

import '../l10n/l10n.dart';
import '../theme.dart';

/// 设置页的语言切换：点一下立即生效并落盘。
///
/// ## 视觉约定（2026-11-18 调整）
///
/// 1. **不在卡片里再写一遍标题**：上面已经有「语言」小节标题，卡片里再写一个
///    只是把同一句话说了两遍。
/// 2. **选中只靠颜色，不用对勾**：一排选项里出现对勾 + 描边 + 底色三种信号，
///    看起来像上一代桌面软件的复选按钮；现代做法是"选中 = 底色/文字变色"。
/// 3. 未选中项**不加边框**，靠间距和文字色区分，鼠标悬停才浮出浅底。
class LanguageCard extends StatelessWidget {
  const LanguageCard({super.key});

  @override
  Widget build(BuildContext context) {
    final controller = L10n.controllerOf(context);
    final strings = controller.strings;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
      decoration: BoxDecoration(
        color: PB.bgBubble,
        borderRadius: BorderRadius.circular(PB.rLg),
        border: Border.all(color: PB.borderSecondary),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            strings.t('settings.languageSubtitle'),
            style: TextStyle(
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
                _LanguagePill(
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

class _LanguagePill extends StatelessWidget {
  const _LanguagePill({
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
    final colors = PB.colors(context);
    final textColor = selected ? colors.accentBright : PB.textSecondary;
    return Material(
      key: ValueKey('language-${language.code}'),
      color: selected ? colors.accentSoft : Colors.transparent,
      borderRadius: BorderRadius.circular(PB.rFull),
      child: InkWell(
        borderRadius: BorderRadius.circular(PB.rFull),
        onTap: onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 140),
          curve: const Cubic(0.2, 0, 0, 1),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
          child: Text(
            label,
            style: TextStyle(
              fontSize: PB.fsSm,
              fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
              color: textColor,
            ),
          ),
        ),
      ),
    );
  }
}
