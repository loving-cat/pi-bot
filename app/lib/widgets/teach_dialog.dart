import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../scope.dart';
import '../models.dart';
import '../motion.dart';
import '../theme.dart';

/// 「教它做一项任务」对话框。
///
/// 用户用大白话写一遍"以后遇到这类事，你就这么做"，存成 [BotSkill]。
/// 服务端会把它拼进这个 bot 的系统提示词（`appendSystemPrompt`），
/// 于是它**真的学会了** —— 下次遇到同类事情直接照做，不用再摸索、也不用再问。
///
/// 和「人设」的区别：人设是"你是谁"，技能是"你会做什么"。
/// 人设很长很抽象，技能短、具体、可枚举，所以单独列出来给用户自己加。
Future<void> showTeachDialog(BuildContext context, Bot bot) async {
  final state = AppScope.of(context);
  final title = TextEditingController();
  final howto = TextEditingController();

  final saved = await showDialog<bool>(
    context: context,
    barrierColor: Colors.black.withValues(alpha: 0.6),
    builder: (ctx) => _TeachDialog(
      bot: bot,
      title: title,
      howto: howto,
    ),
  );

  if (saved != true) return;
  final t = title.text.trim();
  final h = howto.text.trim();
  if (t.isEmpty || h.isEmpty) return;

  final next = [
    ...bot.skills.map((s) => s.toJson()),
    {'title': t, 'howto': h},
  ];
  await state.updateBot(bot.id, {'skills': next});
}

class _TeachDialog extends StatefulWidget {
  const _TeachDialog({
    required this.bot,
    required this.title,
    required this.howto,
  });

  final Bot bot;
  final TextEditingController title;
  final TextEditingController howto;

  @override
  State<_TeachDialog> createState() => _TeachDialogState();
}

class _TeachDialogState extends State<_TeachDialog> {
  bool get _ready =>
      widget.title.text.trim().isNotEmpty && widget.howto.text.trim().isNotEmpty;

  @override
  void initState() {
    super.initState();
    widget.title.addListener(_onChange);
    widget.howto.addListener(_onChange);
  }

  void _onChange() => setState(() {});

  @override
  void dispose() {
    widget.title.removeListener(_onChange);
    widget.howto.removeListener(_onChange);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Dialog(
      backgroundColor: Colors.transparent,
      insetPadding: const EdgeInsets.all(28),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: Container(
          decoration: BoxDecoration(
            color: PB.bgPane,
            borderRadius: BorderRadius.circular(PB.r3xl),
            border: Border.all(color: PB.borderSecondary),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withValues(alpha: 0.55),
                blurRadius: 40,
                offset: const Offset(0, 16),
              ),
            ],
          ),
          padding: const EdgeInsets.fromLTRB(22, 20, 22, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Icon(
                    LucideIcons.target,
                    size: 17,
                    color: PB.danger,
                  ),
                  const SizedBox(width: 9),
                  Expanded(
                    child: Text(
                      '教 ${widget.bot.name} 做一项任务',
                      style: const TextStyle(
                        fontSize: PB.fsLg,
                        fontWeight: FontWeight.w600,
                        color: PB.textPrimary,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              const Text(
                '写一遍"以后遇到这类事就照这么做"，它就记住了。',
                style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
              ),
              const SizedBox(height: 18),
              _field(
                label: '这是一件什么事',
                hint: '例：每周五收盘后汇总本周数据',
                controller: widget.title,
                maxLines: 1,
              ),
              const SizedBox(height: 14),
              _field(
                label: '具体怎么做',
                hint: '例：先读 data/ 下本周的 csv，算涨跌幅和成交额，'
                    '生成一张对比表，再发一条带表格的消息到群里。',
                controller: widget.howto,
                maxLines: 6,
              ),
              const SizedBox(height: 18),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  HoverTap(
                    baseColor: Colors.transparent,
                    hoverColor: PB.bgHover,
                    borderRadius: BorderRadius.circular(PB.rXl),
                    onTap: () => Navigator.pop(context, false),
                    child: const Padding(
                      padding: EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                      child: Text(
                        '取消',
                        style: TextStyle(
                          fontSize: PB.fsSm,
                          color: PB.textSecondary,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  HoverTap(
                    enabled: _ready,
                    baseColor: _ready ? PB.accent : PB.bgActive,
                    hoverColor: _ready ? PB.accentHover : PB.bgActive,
                    borderRadius: BorderRadius.circular(PB.rXl),
                    onTap: () => Navigator.pop(context, true),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 18,
                        vertical: 10,
                      ),
                      child: Text(
                        '教给它',
                        style: TextStyle(
                          fontSize: PB.fsSm,
                          fontWeight: FontWeight.w600,
                          color: _ready ? Colors.white : PB.textQuaternary,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _field({
    required String label,
    required String hint,
    required TextEditingController controller,
    required int maxLines,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(
            fontSize: PB.fsXs,
            color: PB.textTertiary,
            fontWeight: FontWeight.w500,
          ),
        ),
        const SizedBox(height: 7),
        Container(
          decoration: BoxDecoration(
            color: PB.bgInput,
            borderRadius: BorderRadius.circular(PB.rXl),
            border: Border.all(color: PB.borderSecondary),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
          child: TextField(
            controller: controller,
            maxLines: maxLines,
            minLines: maxLines > 1 ? 3 : 1,
            style: const TextStyle(fontSize: PB.fsSm, color: PB.textPrimary),
            decoration: InputDecoration(
              border: InputBorder.none,
              isDense: true,
              contentPadding: const EdgeInsets.symmetric(vertical: 10),
              hintText: hint,
              hintStyle: const TextStyle(
                fontSize: PB.fsSm,
                color: PB.textQuaternary,
              ),
            ),
          ),
        ),
      ],
    );
  }
}
