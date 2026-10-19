import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models.dart';
import '../scope.dart';
import '../theme.dart';
import 'toast.dart';
import 'model_picker_field.dart';

/// 「运行参数」—— 面板的「详情」页里那一段：这个会话到底用谁、用什么模型、
/// 想多久、上下文给多大。
///
/// 用户问的："不是应该在胶囊点击后的右侧侧边栏 有一个可以调模型 上下文窗口
/// 思考等级之类的吗？" —— 以前这些只能跑去 bot 花名册里改（离得远，而且
/// 用户根本不知道在哪儿）。现在就在这里，就地改。
///
/// 为什么放在「详情」而不是「成员」页：详情页是"这个会话怎么跑"的地方，
/// 成员页是"里面都有谁"。参数属于前者。
class BotRunSection extends StatefulWidget {
  const BotRunSection({super.key, required this.bot});

  /// 这个会话"说了算"的那个 bot：私聊就是对方，群聊就是负责人。
  final Bot bot;

  @override
  State<BotRunSection> createState() => _BotRunSectionState();
}

class _BotRunSectionState extends State<BotRunSection> {
  static const _levels = ['off', 'low', 'medium', 'high', 'max'];

  late final TextEditingController _model = TextEditingController(
    text: widget.bot.model ?? '',
  );
  late final TextEditingController _reserve = TextEditingController(
    text: widget.bot.reserveTokens?.toString() ?? '',
  );
  late final TextEditingController _keep = TextEditingController(
    text: widget.bot.keepRecentTokens?.toString() ?? '',
  );
  bool _saving = false;

  @override
  void didUpdateWidget(BotRunSection old) {
    super.didUpdateWidget(old);
    // 换会话/换 bot 了：把输入框同步成新的值
    if (old.bot.id != widget.bot.id) {
      _model.text = widget.bot.model ?? '';
      _reserve.text = widget.bot.reserveTokens?.toString() ?? '';
      _keep.text = widget.bot.keepRecentTokens?.toString() ?? '';
    }
  }

  @override
  void dispose() {
    _model.dispose();
    _reserve.dispose();
    _keep.dispose();
    super.dispose();
  }

  Future<void> _patch(Map<String, dynamic> patch, {String? msg}) async {
    final state = AppScope.read(context);
    setState(() => _saving = true);
    try {
      await state.updateBot(widget.bot.id, patch);
      if (!mounted) return;
      // ★ 参数别叫 toast —— 会把这个文件里的 toast() 函数遮蔽掉
      if (msg != null) {
        toast(context, msg);
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _saveModel() => _patch(
    {'model': _model.text.trim()},
    msg: _model.text.trim().isEmpty
        ? '已恢复默认模型（下一轮生效）'
        : '模型已保存，下一轮生效',
  );

  Future<void> _saveBudget() async {
    int? num(TextEditingController c) {
      final t = c.text.trim();
      if (t.isEmpty) return null;
      return int.tryParse(t);
    }

    final r = num(_reserve);
    final k = num(_keep);
    if (r == null && _reserve.text.trim().isNotEmpty) {
      _toast('预留值要填数字（或者留空用默认）');
      return;
    }
    if (k == null && _keep.text.trim().isNotEmpty) {
      _toast('保留最近要填数字（或者留空用默认）');
      return;
    }
    await _patch(
      {'reserveTokens': r, 'keepRecentTokens': k},
      msg: '上下文预算已保存，下一轮生效',
    );
  }

  void _toast(String text) => toast(context, text);

  @override
  Widget build(BuildContext context) {
    final bot = widget.bot;
    final thinking = bot.thinking ?? '';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 6),
        Row(
          children: [
            const Icon(LucideIcons.slidersHorizontal, size: 14, color: PB.textTertiary),
            const SizedBox(width: 6),
            const Text(
              '运行参数',
              style: TextStyle(
                fontSize: PB.fsXs,
                fontWeight: FontWeight.w600,
                color: PB.textSecondary,
              ),
            ),
            const Spacer(),
            Text(
              bot.isMain ? '主控' : bot.name,
              style: const TextStyle(fontSize: PB.fsXs, color: PB.textQuaternary),
            ),
            if (_saving) ...[
              const SizedBox(width: 8),
              const SizedBox(
                width: 11,
                height: 11,
                child: CircularProgressIndicator(strokeWidth: 1.8, color: PB.accent),
              ),
            ],
          ],
        ),
        const SizedBox(height: 10),

        // 模型
        ModelPickerField(controller: _model, label: '模型（留空用默认）'),
        const SizedBox(height: 4),
        Align(
          alignment: Alignment.centerRight,
          child: TextButton.icon(
            onPressed: _saving ? null : _saveModel,
            icon: const Icon(LucideIcons.check, size: 14),
            label: const Text('保存模型', style: TextStyle(fontSize: PB.fsXs)),
          ),
        ),

        // 思考等级
        const Text(
          '思考等级',
          style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
        ),
        const SizedBox(height: 6),
        Wrap(
          spacing: 6,
          children: [
            for (final level in _levels)
              ChoiceChip(
                label: Text(
                  level,
                  style: TextStyle(
                    fontSize: PB.fsXs,
                    color: thinking == level ? Colors.white : PB.textSecondary,
                  ),
                ),
                selected: thinking == level,
                selectedColor: PB.accent,
                backgroundColor: PB.bgActive,
                side: BorderSide(color: PB.borderSecondary),
                onSelected: (_) {
                  // 点一下立刻生效。**不弹提示** —— chip 自己会变成选中态，
                  // 用户看得见；底部再弹一条"思考等级：xxx（下一轮生效）"纯属噪音。
                  _patch({'thinking': level});
                },
              ),
          ],
        ),
        const SizedBox(height: 12),

        // 上下文预算
        const Text(
          '上下文预算',
          style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
        ),
        const SizedBox(height: 4),
        const Text(
          '留空就用全局默认。改大 = 记得更多但更贵；改小 = 便宜但更容易忘事。',
          style: TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary, height: 1.5),
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(
              child: TextField(
                controller: _reserve,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(
                  isDense: true,
                  labelText: '预留（给回复）',
                  hintText: '默认',
                ),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: TextField(
                controller: _keep,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(
                  isDense: true,
                  labelText: '保留最近',
                  hintText: '默认',
                ),
              ),
            ),
          ],
        ),
        Align(
          alignment: Alignment.centerRight,
          child: TextButton.icon(
            onPressed: _saving ? null : _saveBudget,
            icon: const Icon(LucideIcons.check, size: 14),
            label: const Text('保存预算', style: TextStyle(fontSize: PB.fsXs)),
          ),
        ),
      ],
    );
  }
}
