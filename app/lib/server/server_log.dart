import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';

/// 服务端日志文件的读写封装。
///
/// 服务端的 stdout/stderr 由操作系统直接重定向到此文件（见 supervisor.dart），
/// App 侧只负责：轮转、记录启动参数、读取尾部供界面展示。
class ServerLog {
  ServerLog(this.file);

  /// `%LOCALAPPDATA%\pi-bot\server.log`（或临时目录下的同名文件）
  final File file;

  /// 只保留最近这么多行给界面
  static const int maxLines = 80;

  final List<String> _lines = <String>[];

  /// 本次尝试从文件的哪个字节开始（只解析本次尝试写入的内容）
  int _from = 0;

  List<String> get lines => List<String>.unmodifiable(_lines);

  String get path => file.path;

  /// 每次 App 启动时重置：已有内容移到 `server.log.prev`，新日志从空文件开始。
  void resetForNewRun() {
    try {
      if (file.existsSync() && file.lengthSync() > 0) {
        final prev = File('${file.path}.prev');
        if (prev.existsSync()) prev.deleteSync();
        file.renameSync(prev.path);
      }
    } catch (_) {}
    _lines.clear();
    _from = 0;
  }

  /// 标记一次新尝试的起点（后续 sync() 只读取此位置之后的内容）
  void markAttemptStart() {
    _from = file.existsSync() ? file.lengthSync() : 0;
    _lines.clear();
  }

  /// 日志过大时轮转（超过 `limit` 字节）
  void rotateIfHuge({int limit = 2 * 1024 * 1024}) {
    try {
      if (!file.existsSync() || file.lengthSync() < limit) return;
      final backup = File('${file.path}.1');
      if (backup.existsSync()) backup.deleteSync();
      file.renameSync(backup.path);
    } catch (_) {}
  }

  /// 读取本次尝试写入的尾部
  void sync({int window = 8192}) {
    try {
      if (!file.existsSync()) return;
      final length = file.lengthSync();
      if (length <= _from) return;
      final windowStart = length > window ? length - window : 0;
      final start = _from > windowStart ? _from : windowStart;
      final raf = file.openSync();
      try {
        raf.setPositionSync(start);
        final bytes = raf.readSync(length - start);
        final text = const Utf8Decoder(allowMalformed: true).convert(bytes);
        _lines
          ..clear()
          ..addAll(text.split(RegExp(r'\r?\n')).where((l) => l.trim().isNotEmpty));
        while (_lines.length > maxLines) {
          _lines.removeAt(0);
        }
      } finally {
        raf.closeSync();
      }
    } catch (_) {}
  }

  /// 记录 App 侧的说明行（启动参数等），仅保存在内存中供界面展示
  void note(String line) {
    _lines.add(line);
    while (_lines.length > maxLines) {
      _lines.removeAt(0);
    }
    if (kDebugMode) debugPrint('[server] $line');
  }
}
