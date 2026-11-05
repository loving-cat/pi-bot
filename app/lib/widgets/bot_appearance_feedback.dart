import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../l10n/l10n.dart';
import '../theme.dart';

/// 外观选择的保存进度、结果和重试入口。
class BotAppearanceFeedback extends StatelessWidget {
  const BotAppearanceFeedback({
    super.key,
    required this.waiting,
    required this.saving,
    required this.saved,
    required this.error,
    required this.canRetry,
    required this.onRetry,
  });
  final bool waiting;
  final bool saving;
  final bool saved;
  final String? error;
  final bool canRetry;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final strings = L10n.s(context);
    final hasError = error != null && error!.isNotEmpty;
    final busy = saving || waiting;
    return Semantics(
      liveRegion: true,
      child: Row(
        children: [
          if (busy)
            SizedBox(
              width: 12,
              height: 12,
              child: CircularProgressIndicator(
                strokeWidth: 1.5,
                color: PB.colors(context).accentBright,
              ),
            )
          else if (saved && !hasError)
            Icon(
              LucideIcons.check,
              size: 13,
              color: PB.colors(context).accentBright,
            ),
          if (busy || (saved && !hasError)) const SizedBox(width: 5),
          Expanded(
            child: Text(
              busy
                  ? (waiting
                        ? strings.t('appearance.waiting')
                        : strings.t('common.saving'))
                  : hasError
                  ? strings.tf('appearance.saveFailed', {'error': error})
                  : saved
                  ? strings.t('common.saved')
                  : strings.t('avatar.autoSaved'),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: PB.fsXxs,
                color: hasError && !busy ? PB.danger : PB.textTertiary,
              ),
            ),
          ),
          if (hasError && canRetry && !busy)
            TextButton(
              onPressed: onRetry,
              child: Text(strings.t('common.retry')),
            ),
        ],
      ),
    );
  }
}
