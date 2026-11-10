import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../l10n/l10n.dart';
import '../models.dart';
import '../theme.dart';
import 'blob_avatar.dart';

/// 「新建群」对话框。
///
/// 重设计要点（旧版是 AlertDialog + CheckboxListTile 平铺）：
///
///   · 成员改成带搜索的行列表，选中态用填充圆点 + 整行高亮，
///     而不是右侧一个空勾选框 —— 一眼看不出选了谁。
///   · 选中的成员浮到顶部一个「已选」区，可以先确认再加/减。
///   · 行高收紧、头像和文字基线对齐，去掉 CheckboxListTile 那种
///     上下留白过大的默认间距。
///   · 底部按钮固定，列表自己滚，标题区不跟着滚走。
class CreateGroupDialog extends StatefulWidget {
  const CreateGroupDialog({super.key, required this.bots});

  /// 候选成员（调用方已排除 mainbot）。
  final List<Bot> bots;

  @override
  State<CreateGroupDialog> createState() => CreateGroupDialogState();
}

class CreateGroupDialogState extends State<CreateGroupDialog> {
  final _name = TextEditingController();
  final _topic = TextEditingController();
  final _search = TextEditingController();
  final _selected = <String>{};

  @override
  void dispose() {
    _name.dispose();
    _topic.dispose();
    _search.dispose();
    super.dispose();
  }

  List<Bot> get _candidates {
    final q = _search.text.trim().toLowerCase();
    if (q.isEmpty) return widget.bots;
    return [
      for (final b in widget.bots)
        if (b.name.toLowerCase().contains(q) ||
            b.tagline.toLowerCase().contains(q))
          b,
    ];
  }

  bool get _canCreate => _name.text.trim().isNotEmpty;

  /// 供调用方在对话框关闭后读取 ——
  /// 让调用方自己持有三个 controller 再传进来只会让两边生命周期纠缠。
  String get name => _name.text.trim();
  String get topic => _topic.text.trim();
  List<String> get botIds => _selected.toList();

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    final accent = PB.colors(context).accentBright;
    final picked = [
      for (final b in widget.bots)
        if (_selected.contains(b.id)) b,
    ];

    return Dialog(
      backgroundColor: Colors.transparent,
      child: Container(
        width: 460,
        constraints: const BoxConstraints(maxHeight: 620),
        decoration: BoxDecoration(
          color: PB.bgPane,
          borderRadius: BorderRadius.circular(PB.rXl),
          border: Border.all(color: PB.borderSecondary),
          boxShadow: PB.shadow(y: 18, blur: 48, alpha: 0.55),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 18, 16, 14),
              child: Row(
                children: [
                  Icon(LucideIcons.users, size: 17, color: accent),
                  const SizedBox(width: 9),
                  Text(
                    s.t('rooms.createGroupTitle'),
                    style: TextStyle(
                      fontSize: PB.fsXl,
                      fontWeight: FontWeight.w600,
                      color: PB.textPrimary,
                    ),
                  ),
                  const Spacer(),
                  _IconBtn(
                    icon: LucideIcons.x,
                    tooltip: s.t('common.close'),
                    onTap: () => Navigator.pop(context, false),
                  ),
                ],
              ),
            ),
            Divider(height: 1, color: PB.borderTertiary),
            Flexible(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _Field(
                      controller: _name,
                      hint: s.t('rooms.groupName'),
                      icon: LucideIcons.users,
                      autofocus: true,
                      onChanged: (_) => setState(() {}),
                    ),
                    const SizedBox(height: 10),
                    _Field(
                      controller: _topic,
                      hint: s.t('rooms.groupTopic'),
                      icon: LucideIcons.alignLeft,
                    ),
                    const SizedBox(height: 20),
                    if (picked.isNotEmpty) ...[
                      _Label(
                        text: '已选 ${picked.length} 人',
                        color: accent,
                        trailing: TextButton(
                          onPressed: () => setState(_selected.clear),
                          style: TextButton.styleFrom(
                            minimumSize: Size.zero,
                            padding: const EdgeInsets.symmetric(
                              horizontal: 6,
                              vertical: 2,
                            ),
                            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                          ),
                          child: Text(
                            '清空',
                            style: TextStyle(
                              fontSize: PB.fsXs,
                              color: PB.textTertiary,
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(height: 8),
                      Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        children: [
                          for (final b in picked)
                            _PickedChip(
                              bot: b,
                              onRemove: () =>
                                  setState(() => _selected.remove(b.id)),
                            ),
                        ],
                      ),
                      const SizedBox(height: 18),
                    ],
                    Row(
                      children: [
                        _Label(text: s.t('rooms.addWho')),
                        const Spacer(),
                        SizedBox(
                          width: 168,
                          height: 30,
                          child: TextField(
                            controller: _search,
                            onChanged: (_) => setState(() {}),
                            style: TextStyle(
                              fontSize: PB.fsXs,
                              color: PB.textPrimary,
                            ),
                            decoration: InputDecoration(
                              isDense: true,
                              filled: true,
                              fillColor: PB.bgInput,
                              hintText: '搜索',
                              hintStyle: TextStyle(
                                fontSize: PB.fsXs,
                                color: PB.textQuaternary,
                              ),
                              prefixIcon: Icon(
                                LucideIcons.search,
                                size: 13,
                                color: PB.textTertiary,
                              ),
                              prefixIconConstraints: const BoxConstraints(
                                minWidth: 30,
                                minHeight: 30,
                              ),
                              contentPadding: const EdgeInsets.symmetric(
                                vertical: 8,
                              ),
                              border: OutlineInputBorder(
                                borderRadius: BorderRadius.circular(PB.rFull),
                                borderSide: BorderSide(
                                  color: PB.borderTertiary,
                                ),
                              ),
                              enabledBorder: OutlineInputBorder(
                                borderRadius: BorderRadius.circular(PB.rFull),
                                borderSide: BorderSide(
                                  color: PB.borderTertiary,
                                ),
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    if (widget.bots.isEmpty)
                      _Empty(text: '还没有成员，先去「成员」里创建几个 bot')
                    else if (_candidates.isEmpty)
                      _Empty(text: '没有匹配「${_search.text.trim()}」的成员')
                    else
                      for (final b in _candidates)
                        _MemberRow(
                          bot: b,
                          selected: _selected.contains(b.id),
                          onTap: () => setState(
                            () => _selected.contains(b.id)
                                ? _selected.remove(b.id)
                                : _selected.add(b.id),
                          ),
                        ),
                  ],
                ),
              ),
            ),
            Divider(height: 1, color: PB.borderTertiary),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 14),
              child: Row(
                children: [
                  Text(
                    picked.isEmpty ? '不选也行，之后再拉' : '已选 ${picked.length} 人',
                    style: TextStyle(
                      fontSize: PB.fsXxs,
                      color: PB.textTertiary,
                    ),
                  ),
                  const Spacer(),
                  TextButton(
                    onPressed: () => Navigator.pop(context, false),
                    child: Text(s.t('common.cancel')),
                  ),
                  const SizedBox(width: 6),
                  FilledButton(
                    onPressed: _canCreate
                        ? () => Navigator.pop(context, true)
                        : null,
                    style: FilledButton.styleFrom(
                      backgroundColor: accent,
                      foregroundColor: Colors.black,
                      disabledBackgroundColor: PB.bgActive,
                      disabledForegroundColor: PB.textQuaternary,
                      padding: const EdgeInsets.symmetric(
                        horizontal: 20,
                        vertical: 12,
                      ),
                    ),
                    child: Text(s.t('rooms.create')),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ───────────────────────── 小部件 ─────────────────────────

class _Label extends StatelessWidget {
  const _Label({required this.text, this.color, this.trailing});
  final String text;
  final Color? color;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Text(
        text,
        style: TextStyle(
          fontSize: PB.fsXs,
          fontWeight: FontWeight.w600,
          color: color ?? PB.textSecondary,
        ),
      ),
      if (trailing != null) trailing!,
    ],
  );
}

class _Field extends StatelessWidget {
  const _Field({
    required this.controller,
    required this.hint,
    required this.icon,
    this.autofocus = false,
    this.onChanged,
  });

  final TextEditingController controller;
  final String hint;
  final IconData icon;
  final bool autofocus;
  final ValueChanged<String>? onChanged;

  @override
  Widget build(BuildContext context) => TextField(
    controller: controller,
    autofocus: autofocus,
    onChanged: onChanged,
    style: TextStyle(fontSize: PB.fsBase, color: PB.textPrimary),
    decoration: InputDecoration(
      isDense: true,
      filled: true,
      fillColor: PB.bgInput,
      hintText: hint,
      hintStyle: TextStyle(fontSize: PB.fsBase, color: PB.textQuaternary),
      prefixIcon: Icon(icon, size: 16, color: PB.textTertiary),
      prefixIconConstraints: const BoxConstraints(minWidth: 38, minHeight: 38),
      contentPadding: const EdgeInsets.symmetric(vertical: 13),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(PB.rLg),
        borderSide: BorderSide(color: PB.borderTertiary),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(PB.rLg),
        borderSide: BorderSide(color: PB.borderTertiary),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(PB.rLg),
        borderSide: BorderSide(color: PB.colors(context).accent),
      ),
    ),
  );
}

class _MemberRow extends StatefulWidget {
  const _MemberRow({
    required this.bot,
    required this.selected,
    required this.onTap,
  });

  final Bot bot;
  final bool selected;
  final VoidCallback onTap;

  @override
  State<_MemberRow> createState() => _MemberRowState();
}

class _MemberRowState extends State<_MemberRow> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final accent = PB.colors(context).accentBright;
    final on = widget.selected;

    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 110),
          margin: const EdgeInsets.only(bottom: 2),
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
          decoration: BoxDecoration(
            color: on
                ? PB.colors(context).accent.withValues(alpha: 0.10)
                : (_hover ? PB.bgHover : Colors.transparent),
            borderRadius: BorderRadius.circular(PB.rLg),
            border: Border.all(
              color: on
                  ? PB.colors(context).accent.withValues(alpha: 0.35)
                  : Colors.transparent,
            ),
          ),
          child: Row(
            children: [
              BlobAvatar(
                seed: widget.bot.id,
                color: PB.colorFor(widget.bot.id),
                emoji: widget.bot.emoji,
                size: 24,
                animate: false,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      widget.bot.name,
                      style: TextStyle(
                        fontSize: PB.fsSm,
                        fontWeight: on ? FontWeight.w600 : FontWeight.w400,
                        color: on ? PB.textPrimary : PB.textSecondary,
                      ),
                    ),
                    if (widget.bot.tagline.isNotEmpty)
                      Text(
                        widget.bot.tagline,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: PB.fsXxs,
                          color: PB.textQuaternary,
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              AnimatedContainer(
                duration: const Duration(milliseconds: 110),
                width: 18,
                height: 18,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: on ? accent : Colors.transparent,
                  border: Border.all(
                    color: on ? accent : PB.borderSecondary,
                    width: 1.5,
                  ),
                ),
                child: on
                    ? const Icon(Icons.check, size: 11, color: Colors.black)
                    : null,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PickedChip extends StatelessWidget {
  const _PickedChip({required this.bot, required this.onRemove});

  final Bot bot;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(5, 3, 4, 3),
      decoration: BoxDecoration(
        color: PB.bgElevated,
        borderRadius: BorderRadius.circular(PB.rFull),
        border: Border.all(color: PB.borderTertiary),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          BlobAvatar(
            seed: bot.id,
            color: PB.colorFor(bot.id),
            emoji: bot.emoji,
            size: 16,
            animate: false,
          ),
          const SizedBox(width: 5),
          Text(
            bot.name,
            style: TextStyle(fontSize: PB.fsXs, color: PB.textSecondary),
          ),
          const SizedBox(width: 2),
          GestureDetector(
            onTap: onRemove,
            child: Padding(
              padding: const EdgeInsets.all(2),
              child: Icon(LucideIcons.x, size: 11, color: PB.textQuaternary),
            ),
          ),
        ],
      ),
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty({required this.text});
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 28),
    child: Center(
      child: Text(
        text,
        style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
      ),
    ),
  );
}

class _IconBtn extends StatefulWidget {
  const _IconBtn({
    required this.icon,
    required this.onTap,
    required this.tooltip,
  });

  final IconData icon;
  final VoidCallback onTap;
  final String tooltip;

  @override
  State<_IconBtn> createState() => _IconBtnState();
}

class _IconBtnState extends State<_IconBtn> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) => Tooltip(
    message: widget.tooltip,
    waitDuration: const Duration(milliseconds: 500),
    child: MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        onTap: widget.onTap,
        child: Container(
          width: 26,
          height: 26,
          decoration: BoxDecoration(
            color: _hover ? PB.bgHover : Colors.transparent,
            borderRadius: BorderRadius.circular(PB.rBase),
          ),
          child: Icon(widget.icon, size: 14, color: PB.textTertiary),
        ),
      ),
    ),
  );
}
