import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../app_state.dart';
import '../models.dart';
import '../scope.dart';
import '../theme.dart';
import 'toast.dart';

/// 经验库面板（设置在「技能」标签页里，技能库下面）。
///
/// 经验是**从实际执行里长出来的**：群聊收尾后自动复盘，产出候选；
/// 用户点「启用」之后才会进主控的提示词。
///
/// 为什么要人点一下：复盘是模型写的，它会写歪。一条写歪的经验直接影响
/// 下一个任务，就是把错误做法固化下来。所以界面上要能看清：
///   · 它说的是什么情境（cue）
///   · 下次具体怎么做（lesson）
///   · 凭什么是它说的（evidence 原话）
/// 然后由人决定要不要让它生效。
class LessonsSection extends StatefulWidget {
  const LessonsSection({super.key});

  @override
  State<LessonsSection> createState() => _LessonsSectionState();
}

enum _Filter { candidate, active, all }

class _LessonsSectionState extends State<LessonsSection> {
  _Filter _filter = _Filter.candidate;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      AppScope.of(context).loadLessons();
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final all = state.lessons;
    final candidates = all.where((l) => l.isCandidate).length;
    final active = all.where((l) => l.isActive).length;
    final list = switch (_filter) {
      _Filter.candidate => all.where((l) => l.isCandidate).toList(),
      _Filter.active => all.where((l) => l.isActive).toList(),
      _Filter.all => all,
    };

    return Container(
      margin: const EdgeInsets.only(top: 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(LucideIcons.lightbulb, size: 15, color: PB.accent),
              const SizedBox(width: 7),
              const Text(
                '经验',
                style: TextStyle(
                  fontSize: PB.fsSm,
                  fontWeight: FontWeight.w600,
                  color: PB.textSecondary,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  '只有启用的会进主控提示词，一次最多 3 条 / 600 字',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          _filters(candidates, active),
          const SizedBox(height: 10),
          if (!state.lessonsLoaded)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 18),
              child: Center(
                child: SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              ),
            )
          else if (list.isEmpty)
            _emptyHint(candidates, active)
          else
            ...list.map(
              (lesson) => _LessonCard(
                key: ValueKey(lesson.id),
                lesson: lesson,
                onToggle: (status) async {
                  final err = await state.setLessonStatus(lesson.id, status);
                  if (err != null && context.mounted) _showError(err);
                },
                onDelete: () => _confirmDelete(state, lesson),
              ),
            ),
        ],
      ),
    );
  }

  Widget _filters(int candidates, int active) {
    Widget chip(_Filter f, String label) {
      final selected = _filter == f;
      return Padding(
        padding: const EdgeInsets.only(right: 6),
        child: InkWell(
          borderRadius: BorderRadius.circular(PB.rFull),
          onTap: () => setState(() => _filter = f),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            decoration: BoxDecoration(
              color: selected ? PB.bgElevated : Colors.transparent,
              borderRadius: BorderRadius.circular(PB.rFull),
              border: Border.all(
                color: selected ? PB.accent.withValues(alpha: 0.5) : PB.borderTertiary,
              ),
            ),
            child: Text(
              label,
              style: TextStyle(
                fontSize: PB.fsXxs,
                color: selected ? PB.textPrimary : PB.textTertiary,
              ),
            ),
          ),
        ),
      );
    }

    return Row(
      children: [
        chip(_Filter.candidate, '待确认 $candidates'),
        chip(_Filter.active, '已启用 $active'),
        chip(_Filter.all, '全部'),
      ],
    );
  }

  Widget _emptyHint(int candidates, int active) {
    final text = switch (_filter) {
      _Filter.candidate =>
        candidates == 0
            ? '还没有待确认的经验。群聊收尾后会自动复盘出候选，你在这里决定要不要让它记住。'
            : '没有待确认的经验',
      _Filter.active =>
        active == 0 ? '还没有启用的经验。候选条目点「启用」后，主控派活时才会参考它。' : '没有启用的经验',
      _Filter.all => '还没有经验。群聊收尾后会自动复盘出候选。',
    };
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: PB.bgPane,
        borderRadius: BorderRadius.circular(PB.rXl),
        border: Border.all(color: PB.borderTertiary),
      ),
      child: Text(
        text,
        style: const TextStyle(
          fontSize: PB.fsXs,
          color: PB.textQuaternary,
          height: 1.6,
        ),
      ),
    );
  }

  Future<void> _confirmDelete(AppState state, LibraryLesson lesson) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: PB.bgElevated,
        title: const Text('删掉这条经验？', style: TextStyle(fontSize: PB.fsLg)),
        content: Text(
          '「${lesson.cue}」会从库里移除，之后不会再被注入。',
          style: const TextStyle(
            fontSize: PB.fsSm,
            color: PB.textSecondary,
            height: 1.6,
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: FilledButton.styleFrom(backgroundColor: PB.danger),
            child: const Text('删掉'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    final err = await state.removeLesson(lesson.id);
    if (err != null && mounted) _showError(err);
  }

  /// 操作失败时的文案：列表可能已经过期（这条被别处删了），
  /// 直接甩“经验不存在”用户看不懂，也以为自己点错了。
  void _showError(String err) {
    if (!mounted) return;
    toast(
      context,
      err.contains('不存在') ? '这条经验已经不在了（可能被删了），列表已刷新' : err,
    );
  }
}

class _LessonCard extends StatelessWidget {
  const _LessonCard({
    super.key,
    required this.lesson,
    required this.onToggle,
    required this.onDelete,
  });

  final LibraryLesson lesson;
  final ValueChanged<String> onToggle;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final active = lesson.isActive;
    final accent = switch (lesson.verdict) {
      'hurt' => PB.warn,
      'helped' => PB.success,
      _ => PB.textTertiary,
    };

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.fromLTRB(14, 12, 10, 10),
      decoration: BoxDecoration(
        color: PB.bgPane,
        borderRadius: BorderRadius.circular(PB.rXl),
        border: Border.all(
          color: active ? PB.accent.withValues(alpha: 0.45) : PB.borderTertiary,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                margin: const EdgeInsets.only(top: 3, right: 8),
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: accent.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(PB.rFull),
                ),
                child: Text(
                  lesson.verdictLabel,
                  style: TextStyle(fontSize: 9, color: accent),
                ),
              ),
              Expanded(
                child: Text(
                  lesson.cue,
                  style: const TextStyle(
                    fontSize: PB.fsXs,
                    fontWeight: FontWeight.w600,
                    color: PB.textPrimary,
                    height: 1.5,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              if (active)
                const Padding(
                  padding: EdgeInsets.only(top: 2),
                  child: Text(
                    '已启用',
                    style: TextStyle(fontSize: PB.fsXxs, color: PB.success),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            lesson.lesson,
            style: const TextStyle(
              fontSize: PB.fsXs,
              color: PB.textSecondary,
              height: 1.6,
            ),
          ),
          if (lesson.evidence.isNotEmpty) ...[
            const SizedBox(height: 6),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              decoration: BoxDecoration(
                color: PB.bgElevated.withValues(alpha: 0.5),
                borderRadius: BorderRadius.circular(PB.rSm),
              ),
              child: Row(
                children: [
                  const Text(
                    '证据',
                    style: TextStyle(fontSize: 9, color: PB.textQuaternary),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      lesson.evidence.first.quote,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: PB.fsXxs,
                        color: PB.textTertiary,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
          const SizedBox(height: 6),
          Row(
            children: [
              if (lesson.dept.isNotEmpty)
                Text(
                  lesson.dept,
                  style: const TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
                ),
              if (lesson.hits > 0) ...[
                const SizedBox(width: 8),
                Text(
                  '已命中 ${lesson.hits} 次',
                  style: const TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
                ),
              ],
              const Spacer(),
              if (!active)
                TextButton(
                  onPressed: () => onToggle('active'),
                  child: const Text('启用', style: TextStyle(fontSize: PB.fsXs)),
                )
              else
                TextButton(
                  onPressed: () => onToggle('candidate'),
                  child: const Text('停用', style: TextStyle(fontSize: PB.fsXs)),
                ),
              IconButton(
                onPressed: onDelete,
                icon: const Icon(LucideIcons.trash2, size: 14),
                color: PB.textQuaternary,
                tooltip: '删掉',
                visualDensity: VisualDensity.compact,
              ),
            ],
          ),
        ],
      ),
    );
  }
}
