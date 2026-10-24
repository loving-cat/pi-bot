import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../scope.dart';
import '../theme.dart';
import 'toast.dart';

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

  /// 单轮最长几分钟（存的是毫秒，界面给人看分钟）
  final _turnMin = TextEditingController();
  bool _dirty = false;
  bool _saving = false;

  @override
  void dispose() {
    _lead.dispose();
    _member.dispose();
    _runs.dispose();
    _steps.dispose();
    _turnMin.dispose();
    super.dispose();
  }

  void _fill(Map<String, int> l) {
    if (_dirty) return; // 用户正在改，别被刷新冲掉
    _lead.text = '${l['leadTurns'] ?? 4}';
    _member.text = '${l['memberTurns'] ?? 2}';
    _runs.text = '${l['maxRuns'] ?? 10}';
    _steps.text = '${l['maxSteps'] ?? 30}';
    final ms = l['turnMaxMs'] ?? 600000;
    _turnMin.text = '${(ms / 60000).round()}';
  }

  Future<void> _savePolicy(Map<String, dynamic> patch) async {
    await AppScope.read(context).savePolicy(patch);
    if (!mounted) return;
    toast(
      context,
      '已生效（正在跑的会话下次跑就用新规矩）',
      kind: ToastKind.success,
    );
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    await AppScope.read(context).saveGroupLimits({
      'leadTurns': int.tryParse(_lead.text.trim()) ?? 0,
      'memberTurns': int.tryParse(_member.text.trim()) ?? 0,
      'maxRuns': int.tryParse(_runs.text.trim()) ?? 0,
      'maxSteps': int.tryParse(_steps.text.trim()) ?? 0,
      // 界面填分钟，服务端收毫秒
      'turnMaxMs': (int.tryParse(_turnMin.text.trim()) ?? 10) * 60000,
    });
    if (!mounted) return;
    setState(() {
      _saving = false;
      _dirty = false;
    });
    toast(context, '已生效（不用重启）');
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    _fill(state.groupLimits);
    final policy = state.policy;

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
                  _num('单次最多来回几轮', _steps, '30'),
                ],
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  _num('单轮最长几分钟', _turnMin, '10'),
                  const SizedBox(width: 10),
                  const Expanded(child: SizedBox()),
                ],
              ),
              const SizedBox(height: 6),
              const Text(
                '一个成员一轮最多跑这么久，到点收住交给别人 —— 防止一个人把整个部门卡住。'
                '写代码这类慢活可以调大（比如 20）。',
                style: TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textQuaternary,
                  height: 1.6,
                ),
              ),
              const SizedBox(height: 16),
              const Divider(height: 1, color: PB.borderTertiary),
              const SizedBox(height: 14),
              const Text(
                '部门规矩',
                style: TextStyle(
                  fontSize: PB.fsXs,
                  fontWeight: FontWeight.w600,
                  color: PB.textSecondary,
                ),
              ),
              const SizedBox(height: 4),
              const Text(
                '预算管的是"能跑多久"；规矩管的是"能不能拆家"。',
                style: TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textQuaternary,
                  height: 1.6,
                ),
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  const Expanded(
                    child: Text(
                      '改文件 / 跑命令',
                      style: TextStyle(fontSize: PB.fsSm, color: PB.textPrimary),
                    ),
                  ),
                  SegmentedButton<String>(
                    segments: const [
                      ButtonSegment(value: 'allow', label: Text('允许')),
                      ButtonSegment(value: 'ask', label: Text('需批准')),
                      ButtonSegment(value: 'deny', label: Text('只读')),
                    ],
                    selected: {
                      policy['dangerous'] == 'deny'
                          ? 'deny'
                          : policy['dangerous'] == 'ask'
                          ? 'ask'
                          : 'allow',
                    },
                    onSelectionChanged: (v) => _savePolicy({'dangerous': v.first}),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              const Text(
                '需批准 = 工具照给，但每一次改文件/跑命令都先弹一张卡片让你点。'
                '只读 = 直接不给这些工具（看还是能看的）。'
                '两种都是真拦得住 —— 靠提示词里写"请先问"是拦不住的。',
                style: TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textQuaternary,
                  height: 1.6,
                ),
              ),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                dense: true,
                value: policy['requireProof'] == true,
                onChanged: (v) => _savePolicy({'requireProof': v}),
                title: const Text(
                  '交付要附证据',
                  style: TextStyle(fontSize: PB.fsSm, color: PB.textPrimary),
                ),
                subtitle: const Text(
                  '交活时必须带上命令输出 / 文件路径 / 测试结果，不许只说"改好了"',
                  style: TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
                ),
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
