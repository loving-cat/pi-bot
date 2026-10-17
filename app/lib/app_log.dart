import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';

import 'server/launcher.dart';

/// 应用自身的错误日志。
///
/// 为什么要有：服务端有 `server.log`，但**界面这边崩了/报错了没有任何记录** ——
/// 用户只会说"它闪退了"，我们连堆栈都拿不到。这里把 Flutter 层的错误落盘，
/// 并在设置页给出日志位置。
///
/// 位置与 server.log 同一个目录（`%LOCALAPPDATA%\\pi-bot` / macOS 的
/// Application Support），超过 1MB 轮转一次。

Timer? _flushTimer;
final List<String> _pending = <String>[];

String get appLogPath => '${LocalServerLauncher.defaultStateDir().path}'
    '${Platform.pathSeparator}app.log';

String get appLogDir => LocalServerLauncher.defaultStateDir().path;

File _file() => File(appLogPath);

void _rotateIfNeeded() {
  try {
    final f = _file();
    if (f.existsSync() && f.lengthSync() > 1024 * 1024) {
      final prev = File('$appLogPath.prev');
      if (prev.existsSync()) prev.deleteSync();
      f.renameSync(prev.path);
    }
  } catch (_) {}
}

void _flush() {
  if (_pending.isEmpty) return;
  final lines = _pending.join('\n');
  _pending.clear();
  try {
    _rotateIfNeeded();
    _file().writeAsStringSync(
      '$lines\n',
      mode: FileMode.append,
      flush: false,
    );
  } catch (_) {
    // 日志写不进去也不能影响主流程
  }
}

/// 记一条（会合并 200ms 内的多条，避免崩溃循环刷爆磁盘）
void appendAppLog(String message, {String level = 'ERROR'}) {
  final stamp = DateTime.now().toIso8601String();
  _pending.add('[$stamp] $level $message');
  _flushTimer ??= Timer(const Duration(milliseconds: 200), () {
    _flushTimer = null;
    _flush();
  });
}

/// 装好全局错误捕获：Flutter 框架错误 / 未捕获异步错误都落盘
void installAppErrorLogging() {
  FlutterError.onError = (details) {
    appendAppLog(
      '${details.exceptionAsString()}\n${details.stack ?? ''}',
      level: 'FLUTTER',
    );
    if (kDebugMode) FlutterError.presentError(details);
  };

  PlatformDispatcher.instance.onError = (error, stack) {
    appendAppLog('$error\n$stack', level: 'ASYNC');
    return true; // 不让它把进程带走
  };

  appendAppLog('应用启动（${Platform.operatingSystem}）', level: 'INFO');
}

/// 打开日志所在目录（设置页按钮用）
Future<void> openLogFolder() async {
  _flush();
  final dir = appLogDir;
  try {
    if (Platform.isWindows) {
      await Process.run('explorer', [dir]);
    } else if (Platform.isMacOS) {
      await Process.run('open', [dir]);
    } else {
      await Process.run('xdg-open', [dir]);
    }
  } catch (_) {}
}

/// 测试用：立刻把缓冲写下去
void flushAppLogNow() {
  if (_flushTimer != null) {
    _flushTimer!.cancel();
    _flushTimer = null;
  }
  _flush();
}
