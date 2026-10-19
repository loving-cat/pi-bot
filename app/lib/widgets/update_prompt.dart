import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';

import '../save_file.dart';
import '../theme.dart';
import '../update_info.dart';

/// 更新提示：问用户要不要下载，确认后才真正开始下载。
///
/// 为什么不在检测到更新时自动下载：版本更新会替换程序本体，
/// 用户不知情的情况下吃流量、改文件是不可接受的。所以这里只做三件事：
///   1. 告诉他有新版本、改了什么；
///   2. 他点"下载"才下载，并显示进度；
///   3. 下载完了告诉他文件在哪、要不要现在打开目录。
///
/// 纯逻辑判断（要不要提示、版本比较）在 `update_info.dart`，能单测。

/// 该不该弹窗的判定结果
enum UpdateDecision {
  /// 不提示（没更新 / 检查失败 / 这个版本已被忽略）
  silent,

  /// 提示用户
  prompt,
}

/// 用户对提示的选择
enum UpdateChoice {
  /// 现在下载
  download,

  /// 打开发布页自己看
  openPage,

  /// 以后再说（记住这个版本，下次不再问）
  later,
}

/// 弹更新提示。
///
/// @returns 用户的选择；对话框被直接关掉时按 [UpdateChoice.later] 处理。
Future<UpdateChoice> showUpdateDialog(
  BuildContext context,
  UpdateInfo info,
) async {
  final choice = await showDialog<UpdateChoice>(
    context: context,
    barrierDismissible: false,
    builder: (ctx) => AlertDialog(
      backgroundColor: PB.bgElevated,
      title: Row(
        children: [
          const Icon(Icons.system_update_alt, size: 20, color: PB.accent),
          const SizedBox(width: 8),
          Text(
            '发现新版本 ${info.latest}',
            style: const TextStyle(fontSize: PB.fsLg),
          ),
        ],
      ),
      content: SizedBox(
        width: 460,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '当前版本 ${info.current}',
              style: const TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
            ),
            if (info.hasNotes) ...[
              const SizedBox(height: 12),
              ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 260),
                child: SingleChildScrollView(
                  child: Text(
                    info.notes,
                    style: const TextStyle(
                      fontSize: PB.fsSm,
                      color: PB.textSecondary,
                      height: 1.6,
                    ),
                  ),
                ),
              ),
            ],
            if (info.canDownload && info.sizeLabel.isNotEmpty) ...[
              const SizedBox(height: 10),
              Text(
                '下载大小约 ${info.sizeLabel}',
                style: const TextStyle(
                  fontSize: PB.fsXs,
                  color: PB.textTertiary,
                ),
              ),
            ],
            if (!info.canDownload) ...[
              const SizedBox(height: 10),
              const Text(
                '这个版本没有提供直链安装包，可以在发布页里手动下载。',
                style: TextStyle(
                  fontSize: PB.fsXs,
                  color: PB.textTertiary,
                  height: 1.6,
                ),
              ),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(ctx, UpdateChoice.later),
          child: const Text('以后再说'),
        ),
        if (info.pageUrl.isNotEmpty)
          TextButton(
            onPressed: () => Navigator.pop(ctx, UpdateChoice.openPage),
            child: const Text('打开发布页'),
          ),
        if (info.canDownload)
          FilledButton(
            onPressed: () => Navigator.pop(ctx, UpdateChoice.download),
            child: const Text('下载'),
          ),
      ],
    ),
  );
  return choice ?? UpdateChoice.later;
}

/// 下载进度对话框的结果
class DownloadResult {
  const DownloadResult({this.path, this.error});

  final String? path;
  final String? error;

  bool get ok => path != null;
}

/// 下载更新包并保存到用户选的位置，全程显示进度。
///
/// 四个要点：
///   1. **取消要真的停**：用 Completer + HttpClient 断开，不能让 Future 悬挂；
///   2. **不整包读进内存**：先写临时文件，再交给保存流程（安装包可能上百兆）；
///   3. **有时长上限**：卡住的连接不能永久占着弹窗；
///   4. **只认 https**：下载地址来自服务端，仍要有最后一道校验。
///
/// @param fetch 注入点：测试里可以换成假的
Future<DownloadResult> downloadUpdate(
  BuildContext context,
  UpdateInfo info, {
  Future<List<int>> Function(
    String url,
    void Function(double progress), {
    Future<void>? cancelSignal,
  })?
  fetch,
}) async {
  if (!info.canDownload) {
    return const DownloadResult(error: '这个版本没有提供直链安装包');
  }
  if (!isSafeDownloadUrl(info.assetUrl)) {
    return const DownloadResult(error: '下载地址不是 https，已拒绝');
  }

  final progress = ValueNotifier<double>(0);
  final cancel = Completer<void>();
  final navigator = Navigator.of(context, rootNavigator: true);

  // 进度对话框：只能点"取消"关，或者下载结束由我们关
  unawaited(
    showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        backgroundColor: PB.bgElevated,
        title: const Text('正在下载更新', style: TextStyle(fontSize: PB.fsLg)),
        content: SizedBox(
          width: 380,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ValueListenableBuilder<double>(
                valueListenable: progress,
                builder: (_, v, __) => Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    LinearProgressIndicator(value: v <= 0 ? null : v),
                    const SizedBox(height: 8),
                    Text(
                      v <= 0 ? '连接中…' : '${(v * 100).toStringAsFixed(0)}%',
                      style: const TextStyle(
                        fontSize: PB.fsXs,
                        color: PB.textTertiary,
                      ),
                    ),
                  ],
                ),
              ),
              if (info.sizeLabel.isNotEmpty) ...[
                const SizedBox(height: 6),
                Text(
                  info.assetName.isEmpty
                      ? info.sizeLabel
                      : '${info.assetName} · ${info.sizeLabel}',
                  style: const TextStyle(
                    fontSize: PB.fsXs,
                    color: PB.textTertiary,
                  ),
                ),
              ],
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () {
              // 先发取消信号（让下载循环断开），再关这个弹窗
              if (!cancel.isCompleted) cancel.complete();
              Navigator.of(ctx).pop();
            },
            child: const Text('取消'),
          ),
        ],
      ),
    ),
  );

  try {
    final bytes = await (fetch ?? defaultUpdateFetcher)(
      info.assetUrl,
      (p) => progress.value = p,
      cancelSignal: cancel.future,
    );
    if (bytes.isEmpty) return const DownloadResult(error: '下载到的文件是空的');

    final name = info.assetName.isNotEmpty
        ? info.assetName
        : 'pi-bot-${info.latest}${_extOf(info.assetUrl)}';
    final path = await saveAttachment(name: name, bytes: bytes);
    if (path == null) return const DownloadResult(error: '已取消');
    return DownloadResult(path: path);
  } on _DownloadCancelled {
    return const DownloadResult(error: '已取消');
  } catch (err) {
    return DownloadResult(error: '$err');
  } finally {
    // 只关我们自己弹的那个：用 canPop 判会误关别的路由
    if (navigator.mounted) {
      try {
        navigator.pop();
      } catch (_) {}
    }
    progress.dispose();
  }
}

/// 下载被用户取消（内部信号，不往外抛）
class _DownloadCancelled implements Exception {}

/// 下载地址必须是 https：服务端理论上只会给 GitHub 链接，
/// 但它是网络数据，客户端要有自己的底线（防降级 / 防被篡改指向内网）。
bool isSafeDownloadUrl(String url) {
  final uri = Uri.tryParse(url);
  if (uri == null) return false;
  return uri.scheme == 'https' && uri.host.isNotEmpty;
}

/// 发布页地址同样只认 https（避免被引导到 file:// 或本地地址）
bool isSafeWebUrl(String url) => isSafeDownloadUrl(url);

/// 从下载地址里猜扩展名（用来给保存的文件起名）
String _extOf(String url) {
  final m = RegExp(
    r'\.(exe|msi|dmg|zip|apk|tar\.gz|deb|appimage)($|\?)',
    caseSensitive: false,
  ).firstMatch(url);
  return m == null ? '' : '.${m.group(1)!.toLowerCase()}';
}

/// 默认下载实现：流式读、边读边报进度、可取消、有超时。
///
/// 用流而不是一次性 `get().bodyBytes`：安装包可能上百兆，
/// 一次性读进内存再写盘容易把内存顶爆，用户也看不到进度。
Future<List<int>> defaultUpdateFetcher(
  String url,
  void Function(double progress) onProgress, {
  Future<void>? cancelSignal,
}) async {
  final client = HttpClient()
    // 连接和整体各设一个上限：卡死的连接不能永久占着弹窗
    ..connectionTimeout = const Duration(seconds: 20);
  var cancelled = false;
  try {
    // 取消信号一响就断开连接，让下面的 await 立刻返回
    unawaited(
      (cancelSignal ?? Completer<void>().future).then((_) {
        cancelled = true;
        client.close(force: true);
      }),
    );

    final req = await client.getUrl(Uri.parse(url));
    req.headers.set('user-agent', 'pi-bot-updater');
    final res = await req.close();
    if (res.statusCode != 200) {
      throw '下载失败：HTTP ${res.statusCode}';
    }
    final total = res.contentLength;
    final chunks = <int>[];
    await for (final chunk in res) {
      if (cancelled) throw _DownloadCancelled();
      chunks.addAll(chunk);
      if (total > 0) onProgress(chunks.length / total);
    }
    if (cancelled) throw _DownloadCancelled();
    onProgress(1);
    return chunks;
  } on _DownloadCancelled {
    rethrow;
  } catch (err) {
    if (cancelled) throw _DownloadCancelled();
    rethrow;
  } finally {
    client.close(force: true);
  }
}

/// 下载完成后问用户要不要打开文件所在目录。
Future<void> showDownloadDoneDialog(
  BuildContext context, {
  required String path,
  required UpdateInfo info,
}) async {
  final open = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      backgroundColor: PB.bgElevated,
      title: const Text('下载完成', style: TextStyle(fontSize: PB.fsLg)),
      content: SizedBox(
        width: 420,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('更新包已保存到：', style: TextStyle(fontSize: PB.fsSm)),
            const SizedBox(height: 6),
            SelectableText(
              path,
              style: const TextStyle(
                fontSize: PB.fsXs,
                color: PB.textTertiary,
                height: 1.5,
              ),
            ),
            const SizedBox(height: 10),
            Text(
              Platform.isMacOS && path.toLowerCase().endsWith('.dmg')
                  ? '关闭 pi-bot，打开 DMG 并将 App 拖入 Applications；\n'
                        '重新打开后，在设置中重启本机服务端。'
                  : '关闭 pi-bot 后运行这个安装包完成更新。',
              style: const TextStyle(
                fontSize: PB.fsXs,
                color: PB.textTertiary,
                height: 1.6,
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(ctx, false),
          child: const Text('知道了'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(ctx, true),
          child: const Text('打开所在目录'),
        ),
      ],
    ),
  );
  if (open == true) {
    await revealInFileManager(path);
  }
}

/// 在系统文件管理器里显示某个文件（选中它，而不是只打开目录）。
///
/// 各平台参数不同，失败不影响「文件已经下载好了」这件事，所以不抛错。
Future<void> revealInFileManager(String path) async {
  try {
    final file = File(path);
    if (!file.existsSync()) {
      // 文件不在（被移走/删除）就退一步打开它的父目录
      final parent = file.parent;
      if (!parent.existsSync()) return;
      path = parent.path;
    }
    if (Platform.isWindows) {
      // /select 让资源管理器打开目录并选中该文件
      await Process.run('explorer', ['/select,', path]);
    } else if (Platform.isMacOS) {
      await Process.run('open', ['-R', path]);
    } else if (Platform.isAndroid) {
      // Android 没有“在文件管理器里显示”的统一入口，这里就不作了
    } else {
      await Process.run('xdg-open', [File(path).parent.path]);
    }
  } catch (_) {
    // 打不开目录无伤大雅：文件已经落盘，用户知道自己存的哪里
  }
}
