import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models.dart';
import '../theme.dart';
import '../scope.dart';

/// 工具调用：默认**收起成一行**。
///
/// 用户看的是"它干成了没有"，不是每一步跑了什么命令 —— 展开十几个 `bash`
/// 会盖住正文，反而看不清结论。所以：
///   · 默认只显示一行：`工具调用 · 19 步`（正在跑时显示当前这一步）；
///   · 出错的行**无论如何都露出来**（红字），失败不能藏；
///   · 点一下展开全部，连续的相同调用合并成 `× N`（连续 6 个 bash 只占一行）。
class ToolSteps extends StatefulWidget {
  const ToolSteps({super.key, required this.steps});

  final List<ToolStep> steps;

  @override
  State<ToolSteps> createState() => _ToolStepsState();
}

/// 展开时合并连续重复的调用（tool + detail 都相同才算重复）
List<({ToolStep step, int count})> mergeSteps(List<ToolStep> steps) {
  final out = <({ToolStep step, int count})>[];
  for (final step in steps) {
    if (out.isNotEmpty) {
      final last = out.last.step;
      if (last.tool == step.tool && last.detail == step.detail) {
        out[out.length - 1] = (step: step, count: out.last.count + 1);
        continue;
      }
    }
    out.add((step: step, count: 1));
  }
  return out;
}

class _ToolStepsState extends State<ToolSteps> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final steps = widget.steps;
    if (steps.isEmpty) return const SizedBox.shrink();

    final running = steps.any((s) => s.status == 'running');
    final failed = steps.where((s) => s.status == 'error').toList();
    final current = steps.lastWhere(
      (s) => s.status == 'running',
      orElse: () => steps.last,
    );
    final merged = mergeSteps(steps);

    // 收起时最多露两条失败，剩下的用一句话带过 —— 失败必须看得见
    final shownFailed = _open ? failed : failed.take(2).toList();

    return Padding(
      padding: const EdgeInsets.only(bottom: 7),
      child: Container(
        decoration: BoxDecoration(
          color: PB.bgBubble.withValues(alpha: 0.55),
          borderRadius: BorderRadius.circular(PB.rXl),
          border: Border.all(color: PB.borderTertiary),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // 头部一行：状态 + 步数 + 当前工具（收起时唯一可见的东西）
            InkWell(
              onTap: () => setState(() => _open = !_open),
              borderRadius: BorderRadius.circular(PB.rXl),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(10, 7, 8, 7),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      running ? LucideIcons.loader : LucideIcons.circleCheck,
                      size: 11,
                      color: running
                          ? PB.accent
                          : (failed.isEmpty ? PB.textQuaternary : PB.danger),
                    ),
                    const SizedBox(width: 5),
                    Text(
                      running ? '正在调用工具…' : '工具调用 · ${steps.length} 步',
                      style: TextStyle(
                        fontSize: PB.fsXxs,
                        fontWeight: FontWeight.w600,
                        letterSpacing: 0.3,
                        color: running ? PB.accent : PB.textTertiary,
                      ),
                    ),
                    const SizedBox(width: 6),
                    Flexible(
                      child: Text(
                        '${current.tool}${_open ? '' : ' · 点开看明细'}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontFamily: PB.monoFamily,
                          fontFamilyFallback: PB.monoFallback,
                          fontSize: PB.fsXxs,
                          color: PB.textQuaternary,
                        ),
                      ),
                    ),
                    const SizedBox(width: 2),
                    Icon(
                      _open ? LucideIcons.chevronUp : LucideIcons.chevronDown,
                      size: 12,
                      color: PB.textQuaternary,
                    ),
                  ],
                ),
              ),
            ),

            // 失败行（收起时也露出来）
            for (final step in shownFailed)
              Padding(
                padding: const EdgeInsets.fromLTRB(10, 0, 10, 4),
                child: _StepRow(step: step, count: 1, alwaysStrong: true),
              ),
            if (!_open && failed.length > shownFailed.length)
              Padding(
                padding: const EdgeInsets.fromLTRB(10, 0, 10, 4),
                child: Text(
                  '还有 ${failed.length - shownFailed.length} 步失败（点开看）',
                  style: const TextStyle(fontSize: PB.fsXxs, color: PB.danger),
                ),
              ),

            // 展开：全部步骤（连续重复合并成 × N）
            if (_open) ...[
              for (final item in merged)
                Padding(
                  padding: const EdgeInsets.fromLTRB(10, 0, 10, 3),
                  child: _StepRow(step: item.step, count: item.count),
                ),
              const SizedBox(height: 3),
            ],
          ],
        ),
      ),
    );
  }
}

class _StepRow extends StatelessWidget {
  const _StepRow({
    required this.step,
    required this.count,
    this.alwaysStrong = false,
  });

  final ToolStep step;

  /// 连续重复的相同调用合并后的次数（1 = 不显示）
  final int count;

  /// 失败行即使收起也要用醒目颜色
  final bool alwaysStrong;

  @override
  Widget build(BuildContext context) {
    final isError = step.status == 'error';
    final isRunning = step.status == 'running';
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox(
          width: 12,
          height: 12,
          child: isRunning
              ? const CircularProgressIndicator(
                  strokeWidth: 1.6,
                  color: PB.accent,
                )
              : Icon(
                  isError ? LucideIcons.x : LucideIcons.check,
                  size: 12,
                  color: isError
                      ? PB.danger
                      : (alwaysStrong ? PB.textTertiary : PB.textQuaternary),
                ),
        ),
        const SizedBox(width: 7),
        Flexible(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 280),
            child: Text(
              '${step.tool}${step.detail.isNotEmpty ? '  ${shortText(step.detail, 62)}' : ''}'
              '${count > 1 ? '  ×$count' : ''}'
              '${step.durationMs != null ? '  ${step.durationMs}ms' : ''}',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontFamily: PB.monoFamily,
                fontFamilyFallback: PB.monoFallback,
                fontSize: PB.fsTinyCjk,
                color: isError
                    ? PB.danger
                    : (isRunning ? PB.accent : PB.textQuaternary),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

