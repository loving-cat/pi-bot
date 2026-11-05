import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../app_log.dart';
import '../l10n/l10n.dart';
import '../theme.dart';

/// 设置里的「日志」：告诉用户日志在哪、一键打开目录。
///
/// 排障最怕"闪退了但没有任何记录"：服务端日志与界面日志都落在同一个目录，
/// 这里把路径露出来，用户能自己找到并贴给我们。
class LogSection extends StatelessWidget {
  const LogSection({super.key});

  @override
  Widget build(BuildContext context) {
    final strings = L10n.s(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(LucideIcons.fileText, size: 15, color: PB.textTertiary),
            const SizedBox(width: 8),
            Text(
              strings.t('log.title'),
              style: TextStyle(
                fontSize: PB.fsSm,
                fontWeight: FontWeight.w600,
                color: PB.textSecondary,
              ),
            ),
            const Spacer(),
            TextButton.icon(
              onPressed: openLogFolder,
              icon: const Icon(LucideIcons.folderOpen, size: 15),
              label: Text(strings.t('log.openFolder')),
            ),
          ],
        ),
        const SizedBox(height: 4),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
          decoration: BoxDecoration(
            color: PB.bgPane,
            borderRadius: BorderRadius.circular(PB.rXl),
            border: Border.all(color: PB.borderTertiary),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                strings.t('log.note'),
                style: TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textQuaternary,
                  height: 1.6,
                ),
              ),
              const SizedBox(height: 8),
              SelectableText(
                appLogDir,
                style: TextStyle(
                  fontFamily: PB.monoFamily,
                  fontFamilyFallback: PB.monoFallback,
                  fontSize: PB.fsXs,
                  color: PB.textSecondary,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
