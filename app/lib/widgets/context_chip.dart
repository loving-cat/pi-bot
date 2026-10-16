import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models.dart';
import '../scope.dart';
import '../theme.dart';

/// 会话头部那个「上下文 42%」的小圆环。
///
/// 为什么要显示它：上下文是 agent 最贵也最不透明的资源 —— 用户看到 bot
/// "突然把前面的话总结掉了"，如果不知道上下文快满了，只会以为是 bug。
/// 所以把它摆在头部，一眼能看到：用了多少、是不是正在压缩。
///
/// 点一下展开细节（服务端已经把数字都算好了，这里只是画出来）。
class ContextChip extends StatelessWidget {
  const ContextChip({super.key, required this.roomId});

  final String roomId;

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final compacting = state.compactingIn(roomId);
    final info = state.contextFor(roomId);

    if (compacting) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(
              width: 11,
              height: 11,
              child: CircularProgressIndicator(
                strokeWidth: 1.8,
                color: PB.warn,
              ),
            ),
            const SizedBox(width: 6),
            const Text(
              '压缩中',
              style: TextStyle(fontSize: PB.fsXxs, color: PB.warn),
            ),
          ],
        ),
      );
    }

    // 还不知道占用（刚开的新会话/刚压缩完）就先不占地方
    if (info == null || !info.known) return const SizedBox.shrink();

    final pct = (info.percent ?? 0).clamp(0, 100).toDouble();
    final color = pct >= 92
        ? PB.danger
        : pct >= 75
        ? PB.warn
        : PB.textTertiary;

    return Tooltip(
      message: '点了看细节',
      waitDuration: const Duration(milliseconds: 700),
      child: InkWell(
        borderRadius: BorderRadius.circular(PB.rFull),
        onTap: () => _detail(context, info),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 5),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              SizedBox(
                width: 15,
                height: 15,
                child: CustomPaint(painter: _RingPainter(pct / 100, color)),
              ),
              const SizedBox(width: 6),
              Text(
                '${pct.round()}%',
                style: TextStyle(
                  fontSize: PB.fsXxs,
                  color: color,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _detail(BuildContext context, ContextInfo info) async {
    final tokens = info.tokens ?? 0;
    final window = info.contextWindow ?? 0;
    String k(int n) => n >= 1000 ? '${(n / 1000).round()}k' : '$n';

    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: PB.bgElevated,
        title: const Text('上下文', style: TextStyle(fontSize: PB.fsLg)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _row(
              '已占用',
              '${k(tokens)} / ${k(window)}  （${(info.percent ?? 0).round()}%）',
            ),
            const SizedBox(height: 6),
            _row(
              '自动压缩',
              '开 —— 用到接近上限时，pi 会把前面的对话总结掉，'
                  '然后接着干（历史消息还在，只是不再进上下文）',
            ),
            const SizedBox(height: 10),
            const Text(
              '压缩时头部会显示「压缩中」。想让它装得更多，可以给这个 bot 单独调预算。',
              style: TextStyle(
                fontSize: PB.fsXxs,
                color: PB.textQuaternary,
                height: 1.5,
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('好'),
          ),
        ],
      ),
    );
  }

  Widget _row(String label, String value) => Padding(
    padding: const EdgeInsets.only(bottom: 2),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 64,
          child: Text(
            label,
            style: const TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
          ),
        ),
        Expanded(
          child: Text(
            value,
            style: const TextStyle(
              fontSize: PB.fsXs,
              color: PB.textSecondary,
              height: 1.5,
            ),
          ),
        ),
      ],
    ),
  );
}

/// 一个细圆环：背景灰 + 前景按占用比例画一段弧
class _RingPainter extends CustomPainter {
  _RingPainter(this.value, this.color);

  /// 0..1
  final double value;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final r = (size.shortestSide - 2) / 2;
    final c = Offset(size.width / 2, size.height / 2);
    canvas.drawCircle(
      c,
      r,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2
        ..color = PB.borderSecondary,
    );
    canvas.drawArc(
      Rect.fromCircle(center: c, radius: r),
      -math.pi / 2,
      2 * math.pi * value.clamp(0.0, 1.0),
      false,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2
        ..strokeCap = StrokeCap.round
        ..color = color,
    );
  }

  @override
  bool shouldRepaint(_RingPainter old) =>
      old.value != value || old.color != color;
}

/// 对话里那条「上下文已压缩」的小横条。
///
/// 压缩这件事必须**出现在对话里**：不然用户看到的是"bot 刚才那几轮说的话
/// 不见了"，完全不知道发生了什么。
class CompactNotice extends StatelessWidget {
  const CompactNotice({super.key, required this.msg});

  final Msg msg;

  @override
  Widget build(BuildContext context) {
    final meta = msg.meta ?? const {};
    final before = (meta['tokensBefore'] as num?)?.toInt();
    final saved = (meta['saved'] as num?)?.toInt();

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Center(
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          decoration: BoxDecoration(
            color: PB.bgElevated,
            borderRadius: BorderRadius.circular(PB.rFull),
            border: Border.all(color: PB.borderTertiary),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(
                LucideIcons.minimize2,
                size: 13,
                color: PB.textQuaternary,
              ),
              const SizedBox(width: 7),
              Flexible(
                child: Text(
                  before != null
                      ? '上下文压缩了：${before ~/ 1000}k'
                            '${saved != null && saved > 0 ? ' → 省下 ${saved ~/ 1000}k' : ''}'
                            '（前面的对话已总结）'
                      : '上下文压缩了（前面的对话已总结）',
                  style: const TextStyle(
                    fontSize: PB.fsXxs,
                    color: PB.textTertiary,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
