import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'open_file.dart';

enum AttachmentOpenPhase { idle, opening, handedOff, failed }

/// 一次附件打开的状态；进行中忽略重复请求，销毁后不再通知界面。
class AttachmentOpenController extends ChangeNotifier {
  AttachmentOpenController({required this.operation});

  final Future<String?> Function() operation;
  AttachmentOpenPhase phase = AttachmentOpenPhase.idle;
  String? error;
  bool _disposed = false;

  bool get opening => phase == AttachmentOpenPhase.opening;

  String? get message => switch (phase) {
    AttachmentOpenPhase.idle => null,
    AttachmentOpenPhase.opening => '正在打开…',
    AttachmentOpenPhase.handedOff => '已交给系统程序',
    AttachmentOpenPhase.failed => error ?? '打开失败，请重试。',
  };

  Future<void> open() async {
    if (_disposed || opening) return;
    phase = AttachmentOpenPhase.opening;
    error = null;
    notifyListeners();
    String? failure;
    try {
      failure = await operation();
    } catch (_) {
      failure = '打开失败，请重试。';
    }
    if (_disposed) return;
    error = failure;
    phase = failure == null
        ? AttachmentOpenPhase.handedOff
        : AttachmentOpenPhase.failed;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}

final Map<String, Future<String?>> _pendingOpens = {};

/// 同一附件的并发打开共用一次下载与系统调用。
Future<String?> openAttachmentFile({
  required String name,
  required String url,
}) {
  final key = '$url\u0000$name';
  final pending = _pendingOpens[key];
  if (pending != null) return pending;
  late Future<String?> request;
  request = _downloadAndOpen(name: name, url: url).whenComplete(() {
    if (identical(_pendingOpens[key], request)) _pendingOpens.remove(key);
  });
  _pendingOpens[key] = request;
  return request;
}

/// 完整读取附件并交给系统程序；成功不代表系统程序已读取内容。
Future<String?> _downloadAndOpen({
  required String name,
  required String url,
}) async {
  try {
    final response = await http
        .get(Uri.parse(url))
        .timeout(const Duration(seconds: 120));
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return '打开失败：下载返回 HTTP ${response.statusCode}，请重试。';
    }
    return await openWithSystemApp(
      name: name,
      bytes: response.bodyBytes,
      tempDir: attachmentTempDir(),
    );
  } on TimeoutException {
    return '打开失败：下载超时，请重试。';
  } catch (_) {
    return '打开失败：无法下载附件，请检查连接后重试。';
  }
}
