import 'dart:async';
import 'dart:io';

/// 有界等待原生资源；超时或取消后到达的资源立即释放。
Future<T> awaitHtmlPreviewResource<T>({
  required Future<T> creation,
  required bool Function() isCancelled,
  required Future<void> Function(T) releaseLate,
  Duration timeout = const Duration(seconds: 8),
}) async {
  var expired = false;
  final observed = creation.then((resource) async {
    if (expired || isCancelled()) {
      await releaseLate(resource);
      throw StateError('预览环境已关闭');
    }
    return resource;
  });
  try {
    return await observed.timeout(timeout);
  } on TimeoutException {
    expired = true;
    rethrow;
  }
}

/// 同一个预览环境只释放一次；后续调用复用首次释放的完成结果。
class HtmlPreviewEnvironmentLease {
  HtmlPreviewEnvironmentLease({required this.releaseNative});

  final Future<void> Function() releaseNative;
  Future<void>? _disposal;

  Future<void> dispose() => _disposal ??= Future<void>.sync(releaseNative);
}

/// 仅删除当前视图创建的临时目录，等待原生进程释放句柄的时间有界。
Future<void> removeHtmlPreviewDirectory(Directory directory) async {
  for (var attempt = 0; attempt < 8; attempt++) {
    try {
      if (await directory.exists()) await directory.delete(recursive: true);
      return;
    } on FileSystemException {
      if (attempt == 7) return;
      await Future<void>.delayed(Duration(milliseconds: 100 * (attempt + 1)));
    }
  }
}
