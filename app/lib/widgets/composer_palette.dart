import 'package:flutter/material.dart';

import '../models.dart';
import '../theme.dart';
import 'blob_avatar.dart';

/// 光标前是否正在输入 `@成员` 触发词。
({int start, int end, String query})? detectMentionTrigger(
  String text,
  int cursorOffset,
) {
  if (text.isEmpty || cursorOffset <= 0) return null;
  final end = cursorOffset.clamp(0, text.length);
  for (var i = end - 1; i >= 0; i--) {
    final ch = text[i];
    if (ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r') {
      return null;
    }
    if (ch == '@') {
      final prevOk =
          i == 0 ||
          text[i - 1] == ' ' ||
          text[i - 1] == '\t' ||
          text[i - 1] == '\n' ||
          text[i - 1] == '\r';
      if (!prevOk) return null;
      final query = text.substring(i + 1, end);
      if (query.contains('@')) return null;
      return (start: i, end: end, query: query);
    }
  }
  return null;
}

/// 仅当输入以单个 `/` 开头且不是系统路径（如 `/Users/...`）时返回指令过滤词。
String? detectSlashTrigger(String text, int cursorOffset) {
  if (!text.startsWith('/') || cursorOffset <= 0) return null;
  if (text.contains(' ') ||
      text.contains('\t') ||
      text.contains('\n') ||
      text.contains('\\')) {
    return null;
  }
  final rest = text.substring(1);
  if (rest.contains('/')) return null;
  return rest.toLowerCase();
}

class ComposerMentionItem {
  const ComposerMentionItem({
    required this.bot,
    this.busy = false,
    this.isLead = false,
  });

  final Bot bot;
  final bool busy;
  final bool isLead;
}

class ComposerSlashItem {
  const ComposerSlashItem({
    required this.command,
    required this.title,
    required this.hint,
    required this.icon,
    required this.onRun,
  });

  final String command;
  final String title;
  final String hint;
  final IconData icon;
  final VoidCallback onRun;
}

/// 悬浮在输入框上方的 `@成员` / `/` 快捷指令浮层（不改变输入框与列表高度）。
class ComposerPalette extends StatelessWidget {
  const ComposerPalette({
    super.key,
    this.mentions = const [],
    this.commands = const [],
    this.selectedIndex = 0,
    this.onPickMention,
    this.onPickCommand,
  });

  final List<ComposerMentionItem> mentions;
  final List<ComposerSlashItem> commands;
  final int selectedIndex;
  final void Function(Bot bot)? onPickMention;
  final void Function(ComposerSlashItem cmd)? onPickCommand;

  @override
  Widget build(BuildContext context) {
    final isMentions = mentions.isNotEmpty;
    final count = isMentions ? mentions.length : commands.length;
    if (count == 0) return const SizedBox.shrink();

    final colors = PB.colors(context);
    final safeIdx = selectedIndex.clamp(0, count - 1);

    return ConstrainedBox(
      key: const ValueKey('composer-palette'),
      constraints: const BoxConstraints(maxWidth: 420, maxHeight: 236),
      child: Material(
        color: PB.bgElevated,
        elevation: 10,
        borderRadius: BorderRadius.circular(PB.rXl),
        clipBehavior: Clip.antiAlias,
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(PB.rXl),
            border: Border.all(color: PB.borderSecondary),
          ),
          child: ListView.builder(
            padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 6),
            shrinkWrap: true,
            itemCount: count,
            itemBuilder: (ctx, i) {
              final active = i == safeIdx;
              if (isMentions) {
                final item = mentions[i];
                final bot = item.bot;
                return _PaletteRow(
                  selected: active,
                  onTap: () => onPickMention?.call(bot),
                  leading: BlobAvatar(
                    seed: bot.id,
                    color: PB.colorFor(bot.id),
                    emoji: bot.emoji,
                    size: 22,
                    animate: false,
                    followPointer: false,
                  ),
                  title: bot.name,
                  subtitle: bot.tagline,
                  trailing: item.busy
                      ? Container(
                          width: 7,
                          height: 7,
                          decoration: BoxDecoration(
                            color: colors.accentBright,
                            shape: BoxShape.circle,
                          ),
                        )
                      : null,
                );
              }
              final cmd = commands[i];
              return _PaletteRow(
                selected: active,
                onTap: () => onPickCommand?.call(cmd),
                leading: Icon(cmd.icon, size: 16, color: colors.accentBright),
                title: '/${cmd.command}  ${cmd.title}',
                subtitle: cmd.hint,
              );
            },
          ),
        ),
      ),
    );
  }
}

class _PaletteRow extends StatelessWidget {
  const _PaletteRow({
    required this.selected,
    required this.onTap,
    required this.leading,
    required this.title,
    required this.subtitle,
    this.trailing,
  });

  final bool selected;
  final VoidCallback onTap;
  final Widget leading;
  final String title;
  final String subtitle;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: selected ? PB.bgHover : Colors.transparent,
      borderRadius: BorderRadius.circular(PB.rLg),
      child: InkWell(
        borderRadius: BorderRadius.circular(PB.rLg),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          child: Row(
            children: [
              leading,
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: PB.fsSm,
                        fontWeight: FontWeight.w500,
                        color: PB.textPrimary,
                      ),
                    ),
                    if (subtitle.isNotEmpty) ...[
                      const SizedBox(height: 1),
                      Text(
                        subtitle,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: PB.fsXxs,
                          color: PB.textQuaternary,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              if (trailing != null) ...[
                const SizedBox(width: 8),
                trailing!,
              ],
            ],
          ),
        ),
      ),
    );
  }
}
