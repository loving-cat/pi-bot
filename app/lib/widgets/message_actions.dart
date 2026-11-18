import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../l10n/l10n.dart';
import '../models.dart';
import '../theme.dart';

import 'package:lucide_icons_flutter/lucide_icons.dart';

/// 长按消息 → 底部操作面板
Future<void> showMessageActions(
  BuildContext context,
  Msg msg, {
  VoidCallback? onReply,
  VoidCallback? onMention,
  String? mentionLabel,
}) async {
  final strings = L10n.s(context);
  await showModalBottomSheet<void>(
    context: context,
    backgroundColor: PB.bgElevated,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(PB.r3xl)),
    ),
    builder: (ctx) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const SizedBox(height: 10),
          Container(
            width: 36,
            height: 4,
            decoration: BoxDecoration(
              color: PB.borderPrimary,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
          const SizedBox(height: 6),
          if (onReply != null && msg.text.trim().isNotEmpty)
            ListTile(
              leading: const Icon(LucideIcons.reply, size: 20),
              title: Text(
                strings.t('msg.reply'),
                style: const TextStyle(fontSize: PB.fsSm),
              ),
              onTap: () {
                HapticFeedback.selectionClick();
                Navigator.pop(ctx);
                onReply();
              },
            ),
          if (onMention != null)
            ListTile(
              leading: const Icon(LucideIcons.atSign, size: 20),
              title: Text(
                mentionLabel ?? strings.t('msg.mentionBot'),
                style: const TextStyle(fontSize: PB.fsSm),
              ),
              onTap: () {
                HapticFeedback.selectionClick();
                Navigator.pop(ctx);
                onMention();
              },
            ),
          ListTile(
            leading: const Icon(LucideIcons.clipboardCopy, size: 20),
            title: Text(
              strings.t('msg.copyContent'),
              style: const TextStyle(fontSize: PB.fsSm),
            ),
            onTap: () {
              HapticFeedback.selectionClick();
              Clipboard.setData(ClipboardData(text: msg.text));
              Navigator.pop(ctx);
            },
          ),
          ListTile(
            leading: const Icon(LucideIcons.hash, size: 20),
            title: Text(
              strings.t('msg.copyId'),
              style: const TextStyle(fontSize: PB.fsSm),
            ),
            onTap: () {
              HapticFeedback.selectionClick();
              Clipboard.setData(ClipboardData(text: msg.id));
              Navigator.pop(ctx);
            },
          ),
          const SizedBox(height: 8),
        ],
      ),
    ),
  );
}
