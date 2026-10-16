import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../scope.dart';
import '../theme.dart';

/// 设置里的「群聊轮次」区块。
///
/// 为什么要给用户这个开关：bot 之间靠 `@同事` 互相派活，谁也没规定什么时候停。
/// 遇到解不了的活，它们会一直"你说一句我说一句" —— 既费钱又刷屏。
/// 这几个数就是闸门，交给用户按群的性质调。
///
/// 服务端读的是 store 里这份（不是环境变量），改完立刻生效，不用重启。
class GroupLimitsSection extends StatefulWidget {
  const GroupLimitsSection({super.key});

  @override
  State<GroupLimitsSection> createState() => _GroupLimitsSectionState();
}

class _GroupLimitsSectionState extends State<GroupLimitsSection> {
  final _lead = TextEditingController();
  final _member = TextEditingController();
  final _runs = TextEditingController();
  final _steps = TextEditingController();
  bool _dirty = false;
  bool _saving = false;

  @override
  void dispose() {
    _lead.dispose();
    _member.dispose();
    _runs.dispose();
    _steps.dispose();
    super.dispose();
  }

  void _fill(Map<String, int> l) {
    if (_dirty) return; // 用户正在改，别被刷新冲掉
    _lead.text = '${l['leadTurns'] ?? 4}';
    _member.text = '${l['memberTurns'] ?? 2}';
    _runs.text = '${l['maxRuns'] ?? 10}';
    _steps.text = '${l['maxSteps'] ?? 30}';
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    await AppScope.read(context).saveGroupLimits({
      'leadTurns': int.tryParse(_lead.text.trim()) ?? 0,
      'memberTurns': int.tryParse(_member.text.trim()) ?? 0,
      'maxRuns': int.tryParse(_runs.text.trim()) ?? 0,
      'maxSteps': int.tryParse(_steps.text.trim()) ?? 0,
    });
    if (!mounted) return;
    setState(() {
      _saving = false;
      _dirty = false;
    });
    ScaffoldMessenger.maybeOf(context)
        ?.showSnackBar(const SnackBar(content: Text('已生效（不用重启）')));
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    _fill(state.groupLimits);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Icon(
              LucideIcons.usersRound,
              size: 15,
              color: PB.textTertiary,
            ),
            const SizedBox(width: 8),
            const Text(
              '群聊轮次',
              style: TextStyle(
                fontSize: PB.fsSm,
                fontWeight: FontWeight.w600,
                color: PB.textSecondary,
              ),
            ),
            const Spacer(),
            if (_dirty)
              FilledButton(
                onPressed: _saving ? null : _save,
                child: Text(_saving ? '保存中…' : '保存'),
              ),
          ],
        ),
        const SizedBox(height: 4),
        Container(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
          decoration: BoxDecoration(
            color: PB.bgPane,
            borderRadius: BorderRadius.circular(PB.rXl),
            border: Border.all(color: PB.borderTertiary),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'bot 之间用 @ 互相派活，谁也没规定什么时候停 —— 解不了的活它们会一直聊。'
                '这几个数就是闸门。改完立刻生效。',
                style: TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textQuaternary,
                  height: 1.6,
                ),
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  _num('老大最多几轮', _lead, '4'),
                  const SizedBox(width: 10),
                  _num('成员最多几轮', _member, '2'),
                ],
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  _num('一条消息最多跑几次', _runs, '10'),
                  const SizedBox(width: 10),
                  _num('单次最多动手几步', _steps, '30'),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _num(String label, TextEditingController c, String hint) {
    return Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: const TextStyle(fontSize: PB.fsXxs, color: PB.textTertiary),
          ),
          const SizedBox(height: 4),
          TextField(
            controller: c,
            keyboardType: TextInputType.number,
            onChanged: (_) {
              if (!_dirty) setState(() => _dirty = true);
            },
            style: const TextStyle(fontSize: PB.fsSm),
            decoration: InputDecoration(
              hintText: hint,
              isDense: true,
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 10,
                vertical: 10,
              ),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(PB.rLg),
                borderSide: const BorderSide(color: PB.borderSecondary),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
