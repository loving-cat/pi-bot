import 'package:flutter/material.dart';

import '../l10n/l10n.dart';
import '../models.dart';
import '../theme.dart';
import 'toast.dart';

/// 删除助手前的二次确认。**删除没有撤销**，所以必须问。
///
/// 抽成公共函数是因为有两个入口要删助手：
///   · 会话列表右键菜单（rooms_screen）
///   · 助手编辑页的删除按钮（bots_screen）
/// 原来编辑页那个是直接 `state.deleteBot()` 的 —— 点一下就没了，
/// 和右键菜单的行为不一致，而且没有退路。
///
/// 返回 true 表示用户确认了（此时已经删掉了）。
Future<bool> confirmDeleteBot(
  BuildContext context,
  Bot bot, {
  required Future<void> Function(String botId) delete,
}) async {
  final s = L10n.s(context);
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      backgroundColor: PB.bgElevated,
      title: Text(
        s.tf('rooms.deleteBotTitle', {
          'name': '${bot.emoji ?? ''}${bot.name}',
        }),
        style: const TextStyle(fontSize: PB.fsLg),
      ),
      content: Text(
        s.t('rooms.deleteBotBody'),
        style: TextStyle(
          fontSize: PB.fsSm,
          color: PB.textSecondary,
          height: 1.6,
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(ctx, false),
          child: Text(s.t('common.cancel')),
        ),
        FilledButton(
          style: FilledButton.styleFrom(backgroundColor: PB.danger),
          onPressed: () => Navigator.pop(ctx, true),
          child: Text(s.t('rooms.confirmDelete')),
        ),
      ],
    ),
  );
  if (ok != true) return false;   // 取消 = 什么都不做
  await delete(bot.id);
  if (!context.mounted) return true;
  toast(context, s.tf('rooms.botDeleted', {'name': bot.name}));
  return true;
}