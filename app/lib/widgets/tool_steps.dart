import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models.dart';
import '../theme.dart';
import '../scope.dart';

/// 工具调用状态：**跑完就不显示**。
///
/// ## 为什么干脆不展示
///
/// 这不是终端。用户要看的是"它干成了没有、结果是什么"，不是
/// `read_shell / run_background / kill_shell` 这些内部命令名 ——
/// 既看不懂，又把真正的回答顶到屏幕外（截屏里一整列工具调用就是这么来的）。
///
/// ## 那还留什么
///
/// 只保留两个**有信息量**的瞬间：
///   · 正在跑 —— 显示一行"正在干活…"，否则用户以为什么都没发生
///     （长任务几十秒，没有反馈会以为卡死）
///   · 出错了 —— 把失败露出来，失败不能藏
///
/// 跑完且没出错 → 整个组件返回 `SizedBox.shrink()`，一个像素都不占。
///
/// 明细仍然留在 store 里（会话记录里有），
/// 只是不再糊到用户脸上 —— 需要排查时看日志/记录即可。
class ToolSteps extends StatefulWidget {
  const ToolSteps({
    super.key,
    required this.steps,
    this.quietWhenDone = true,
  });

  final List<ToolStep> steps;

  /// true（默认）= 跑完且无错就完全不渲染。
  /// 传 false 会回到"收起成一行"的老行为（给以后的调试面板留个口子）。
  final bool quietWhenDone;

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

    // ★ 跑完且没出错 → 什么都不画。
    //   这是主路径：绝大多数时候用户看到的应该是干净的结论，
    //   而不是一列他看不懂的命令名。
    if (widget.quietWhenDone && !running && failed.isEmpty) {
      return const SizedBox.shrink();
    }
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

