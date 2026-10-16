import 'dart:async';
import 'dart:io';

import 'package:flutter/scheduler.dart';

/// 帧耗时采样 —— 只在启动时带了环境变量 `PI_BOT_FRAME_LOG=<文件路径>` 才工作。
///
/// 为什么要有这个东西：桌面端"拉伸窗口很卡、帧数很低"这种问题，光看代码猜
/// 十次九次猜错 —— 是布局重排太贵、是光栅太贵、还是某个持续动画在抢帧，
/// 只有帧时间能说清楚。加了一次以后每次都能用。
///
/// 每 700ms 往文件追加一行：
///   `帧数 平均ms P90ms 最慢ms 超16ms帧数 平均buildms 平均rasterms`
///
/// 用环境变量而不是 dart-define：不用重新编译就能开关。
///   PowerShell: `$env:PI_BOT_FRAME_LOG="$env:TEMP\pi-bot-frame.log"; .\pi_bot.exe`
class FrameLog {
  static const _pathEnv = 'PI_BOT_FRAME_LOG';

  static String get _path => Platform.environment[_pathEnv] ?? '';

  static bool get enabled => _path.isNotEmpty;

  static final List<FrameTiming> _frames = [];

  static void start() {
    if (!enabled) return;
    final file = File(_path);
    if (file.existsSync()) file.deleteSync();
    file.writeAsStringSync(
      '# frame log  (每行一次采样：帧数 平均ms P90ms 最慢ms >16ms帧数 build_avg_ms raster_avg_ms)\n',
    );

    SchedulerBinding.instance.addTimingsCallback((timings) {
      _frames.addAll(timings);
    });

    Timer.periodic(const Duration(milliseconds: 700), (_) => _flush());

    // 正常退出时把最后一段写掉（Ctrl+C / 关窗口都会走这里）
    ProcessSignal.sigint.watch().listen((_) => _flush());
  }

  static void _flush() {
    if (_frames.isEmpty) return;
    final total = <int>[];
    var build = 0;
    var raster = 0;
    for (final f in _frames) {
      total.add(f.totalSpan.inMicroseconds);
      build += f.buildDuration.inMicroseconds;
      raster += f.rasterDuration.inMicroseconds;
    }
    final n = total.length;
    total.sort();
    double ms(int us) => us / 1000;
    final avg = total.reduce((a, b) => a + b) / n;
    final p90 = total[(n * 0.9).floor().clamp(0, n - 1)];
    final worst = total.last;
    final slow = total.where((t) => t > 16000).length;

    try {
      File(_path).writeAsStringSync(
        '${n.toString().padLeft(4)}  '
        '${ms(avg.round()).toStringAsFixed(1).padLeft(6)}  '
        '${ms(p90).toStringAsFixed(1).padLeft(6)}  '
        '${ms(worst).toStringAsFixed(1).padLeft(6)}  '
        '${slow.toString().padLeft(4)}  '
        '${ms((build / n).round()).toStringAsFixed(1).padLeft(6)}  '
        '${ms((raster / n).round()).toStringAsFixed(1).padLeft(6)}\n',
        mode: FileMode.append,
      );
    } catch (_) {
      // 采样本身不能影响被测对象：写不进去就算了
    }
    _frames.clear();
  }
}
