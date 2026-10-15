import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models.dart';
import '../theme.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// 长按消息 → 底部操作面板
Future<void> showMessageActions(BuildContext context, Msg msg) async {
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
          ListTile(
            leading: const Icon(LucideIcons.clipboardCopy, size: 20),
            title: const Text('复制内容', style: TextStyle(fontSize: PB.fsSm)),
            onTap: () {
              Clipboard.setData(ClipboardData(text: msg.text));
              Navigator.pop(ctx);
            },
          ),
          ListTile(
            leading: const Icon(LucideIcons.hash, size: 20),
            title: const Text('复制消息 id', style: TextStyle(fontSize: PB.fsSm)),
            onTap: () {
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
