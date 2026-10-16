import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models.dart';
import '../theme.dart';

/// 「要用户拿个主意」的卡片。
///
/// 为什么要有它：bot 卡住的时候，在聊天里写一段"您看是 A 还是 B？"——
/// 用户得打字回，而且经常答得不完整，bot 又要追问一轮。
/// 换成卡片：选项直接点，还能自己写一句（自定义 query）。
///
/// 用户点了之后，**把选项文字原样当成一条普通消息发回去** ——
/// 这样服务端不用多一套协议，bot 拿到的就是用户在说话。
class AskCard extends StatelessWidget {
  const AskCard({super.key, required this.msg, required this.onAnswer});

  final Msg msg;

  /// 用户选了/写了什么 → 发回这个会话
  final void Function(String text) onAnswer;

  @override
  Widget build(BuildContext context) {
    final options = msg.askOptions;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Container(
        constraints: const BoxConstraints(maxWidth: 520),
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
        decoration: BoxDecoration(
          color: PB.bgElevated,
          borderRadius: BorderRadius.circular(PB.rXl),
          border: Border.all(color: PB.accent.withValues(alpha: 0.35)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                Icon(LucideIcons.circleHelp, size: 15, color: PB.accent),
                const SizedBox(width: 7),
                Text(
                  '${msg.authorName} 问你',
                  style: const TextStyle(
                    fontSize: PB.fsXxs,
                    color: PB.accent,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            if (msg.text.isNotEmpty)
              Text(
                msg.text,
                style: const TextStyle(
                  fontSize: PB.fsSm,
                  color: PB.textPrimary,
                  height: 1.5,
                ),
              ),
            const SizedBox(height: 10),
            // 选项：一行一个，点一下就发回去
            for (final o in options)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: _OptionButton(
                  label: o.label,
                  detail: o.detail,
                  onTap: () => onAnswer(o.label),
                ),
              ),
            if (msg.askAllowCustom) ...[
              const SizedBox(height: 2),
              _CustomAnswer(onSubmit: onAnswer),
            ],
          ],
        ),
      ),
    );
  }
}

class _OptionButton extends StatelessWidget {
  const _OptionButton({
    required this.label,
    required this.detail,
    required this.onTap,
  });

  final String label;
  final String detail;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(PB.rLg),
      onTap: onTap,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
        decoration: BoxDecoration(
          color: PB.bgActive,
          borderRadius: BorderRadius.circular(PB.rLg),
          border: Border.all(color: PB.borderSecondary),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    label,
                    style: const TextStyle(
                      fontSize: PB.fsSm,
                      color: PB.textPrimary,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                  if (detail.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(
                      detail,
                      style: const TextStyle(
                        fontSize: PB.fsXxs,
                        color: PB.textQuaternary,
                        height: 1.4,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            const Icon(
              LucideIcons.chevronRight,
              size: 15,
              color: PB.textQuaternary,
            ),
          ],
        ),
      ),
    );
  }
}

/// 「我自己说」—— 就是用户说的"自定义 query"
class _CustomAnswer extends StatefulWidget {
  const _CustomAnswer({required this.onSubmit});

  final void Function(String text) onSubmit;

  @override
  State<_CustomAnswer> createState() => _CustomAnswerState();
}

class _CustomAnswerState extends State<_CustomAnswer> {
  final _c = TextEditingController();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  void _send() {
    final t = _c.text.trim();
    if (t.isEmpty) return;
    widget.onSubmit(t);
    _c.clear();
  }

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: TextField(
            controller: _c,
            onSubmitted: (_) => _send(),
            style: const TextStyle(fontSize: PB.fsSm),
            decoration: InputDecoration(
              hintText: '或者我自己说一句…',
              hintStyle: const TextStyle(
                fontSize: PB.fsSm,
                color: PB.textQuaternary,
              ),
              isDense: true,
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 12,
                vertical: 10,
              ),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(PB.rLg),
                borderSide: const BorderSide(color: PB.borderSecondary),
              ),
            ),
          ),
        ),
        const SizedBox(width: 8),
        IconButton(
          tooltip: '发出去',
          onPressed: _send,
          icon: const Icon(LucideIcons.send, size: 17),
        ),
      ],
    );
  }
}
