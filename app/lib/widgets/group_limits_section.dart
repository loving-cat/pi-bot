import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../l10n/l10n.dart';
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
    // 兜底值必须和服务端 GROUP_LIMITS_DEFAULT 一致，
    // 否则拿不到数据时会显示一个用户从没设置过的数字。
    _lead.text = '${l['leadTurns'] ?? 15}';
    _member.text = '${l['memberTurns'] ?? 15}';
    _runs.text = '${l['maxRuns'] ?? 100}';
    _steps.text = '${l['maxSteps'] ?? 30}';
    final ms = l['turnMaxMs'] ?? 600000;
    _turnMin.text = '${(ms / 60000).round()}';
  }

  Future<void> _savePolicy(Map<String, dynamic> patch) async {
    await AppScope.read(context).savePolicy(patch);
    if (!mounted) return;
    toast(
      context,
      L10n.s(context).t('limits.savedRunning'),
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
    toast(context, L10n.s(context).t('limits.saved'));
  }

  @override
  Widget build(BuildContext context) {
    final strings = L10n.s(context);
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
            Text(
              strings.t('limits.title'),
              style: const TextStyle(
                fontSize: PB.fsSm,
                fontWeight: FontWeight.w600,
                color: PB.textSecondary,
              ),
            ),
            const Spacer(),
            if (_dirty)
              FilledButton(
                onPressed: _saving ? null : _save,
                child: Text(
                  _saving
                      ? strings.t('common.saving')
                      : strings.t('common.save'),
                ),
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
              Text(
                strings.t('limits.intro'),
                style: const TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textQuaternary,
                  height: 1.6,
                ),
              ),
              const SizedBox(height: 14),
              // 第一组：单个 bot 能跑多少（最常调的）
              _groupTitle(strings.t('limits.groupPerBot')),
              const SizedBox(height: 8),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _num(
                    strings.t('limits.turnMinutes'),
                    _turnMin,
                    '10',
                    desc: strings.t('limits.turnMinutesDesc'),
                  ),
                  const SizedBox(width: 10),
                  _num(
                    strings.t('limits.leadTurns'),
                    _lead,
                    '15',
                    desc: strings.t('limits.leadTurnsDesc'),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _num(
                    strings.t('limits.memberTurns'),
                    _member,
                    '15',
                    desc: strings.t('limits.memberTurnsDesc'),
                  ),
                  const SizedBox(width: 10),
                  const Expanded(child: SizedBox()),
                ],
              ),
              const SizedBox(height: 16),
              // 第二组：整个任务的兜底上限（很少需要动）
              _groupTitle(strings.t('limits.groupPerTask')),
              const SizedBox(height: 8),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _num(
                    strings.t('limits.runsPerMessage'),
                    _runs,
                    '100',
                    desc: strings.t('limits.runsPerMessageDesc'),
                  ),
                  const SizedBox(width: 10),
                  _num(
                    strings.t('limits.stepsPerRun'),
                    _steps,
                    '30',
                    desc: strings.t('limits.stepsPerRunDesc'),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Text(
                strings.t('limits.turnHint'),
                style: const TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textQuaternary,
                  height: 1.6,
                ),
              ),
              const SizedBox(height: 16),
              const Divider(height: 1, color: PB.borderTertiary),
              const SizedBox(height: 14),
              Text(
                strings.t('limits.rulesTitle'),
                style: const TextStyle(
                  fontSize: PB.fsXs,
                  fontWeight: FontWeight.w600,
                  color: PB.textSecondary,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                strings.t('limits.rulesHint'),
                style: const TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textQuaternary,
                  height: 1.6,
                ),
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    child: Text(
                      strings.t('limits.fileAndCommand'),
                      style: const TextStyle(
                        fontSize: PB.fsSm,
                        color: PB.textPrimary,
                      ),
                    ),
                  ),
                  SegmentedButton<String>(
                    segments: [
                      ButtonSegment(
                        value: 'allow',
                        label: Text(strings.t('limits.allow')),
                      ),
                      ButtonSegment(
                        value: 'ask',
                        label: Text(strings.t('limits.ask')),
                      ),
                      ButtonSegment(
                        value: 'deny',
                        label: Text(strings.t('limits.deny')),
                      ),
                    ],
                    selected: {
                      policy['dangerous'] == 'deny'
                          ? 'deny'
                          : policy['dangerous'] == 'ask'
                          ? 'ask'
                          : 'allow',
                    },
                    onSelectionChanged: (v) =>
                        _savePolicy({'dangerous': v.first}),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Text(
                strings.t('limits.policyHint'),
                style: const TextStyle(
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
                title: Text(
                  strings.t('limits.requireProof'),
                  style: const TextStyle(
                    fontSize: PB.fsSm,
                    color: PB.textPrimary,
                  ),
                ),
                subtitle: Text(
                  strings.t('limits.requireProofHint'),
                  style: const TextStyle(
                    fontSize: PB.fsXxs,
                    color: PB.textQuaternary,
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  /// 分组标题：把"单个 bot 能跑多久"和"整个任务的兜底上限"分开。
  Widget _groupTitle(String text) => Text(
    text,
    style: const TextStyle(
      fontSize: PB.fsXxs,
      fontWeight: FontWeight.w600,
      color: PB.textTertiary,
    ),
  );

  /// 一个数字输入项。
  ///
  /// [desc] 是这个数到底管什么 —— 光有名字（"负责人一次发言跑几步"）
  /// 用户还是不知道几步算多、几步算少，必须给一句具体的。
  Widget _num(
    String label,
    TextEditingController c,
    String hint, {
    String? desc,
  }) {
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
          if (desc != null) ...[
            const SizedBox(height: 4),
            Text(
              desc,
              style: const TextStyle(
                fontSize: PB.fsXxs,
                color: PB.textQuaternary,
                height: 1.45,
              ),
            ),
          ],
        ],
      ),
    );
  }
}
