import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

/// 「用系统程序打开」——桌面端专用的一条捷径。
///
/// 附件躺在**服务端的工作目录**里，客户端手上只有字节 —— 所以要先落到临时文件，
/// 再交给系统默认程序（PDF 给阅读器、xlsx 给表格、png 给看图）。
///
/// 为什么值得做：手机上"预览不了 PDF"是常态，但电脑上用户想看原样，
/// 而不是我们抽出来的文字。**不试图自己渲染** —— 那是另一个产品。
///
/// 失败不抛错，只回一句人话（调用方拿去提示）。
Future<String?> openWithSystemApp({
  required String name,
  required List<int> bytes,
  required String tempDir,
}) async {
  // Web 没有"本地程序"这回事；移动端交给各自的分享/打开机制（暂不做）
  if (kIsWeb || Platform.isAndroid || Platform.isIOS) return '这个平台上不支持用系统程序打开';

  try {
    final dir = Directory(tempDir);
    if (!dir.existsSync()) dir.createSync(recursive: true);
    // 用原文件名落盘：系统的"最近文件"和默认程序关联都看扩展名
    final file = File('${dir.path}${Platform.pathSeparator}$name');
    await file.writeAsBytes(bytes, flush: true);

    // 桌面端：launchUrl 走的是 ShellExecute / xdg-open，等于双击那个文件
    final ok = await launchUrl(Uri.file(file.path));
    return ok ? null : '系统没有能打开 .${_ext(name)} 的程序';
  } catch (err) {
    return '打不开：$err';
  }
}

String _ext(String name) {
  final i = name.lastIndexOf('.');
  return i >= 0 && i < name.length - 1 ? name.substring(i + 1) : '(未知)';
}

/// 临时目录按"这次会话"分开放，避免不同附件的同名文件互相覆盖。
String attachmentTempDir({String? base}) {
  final root = base ?? Directory.systemTemp.path;
  return '$root${Platform.pathSeparator}pi-bot-attachments';
}

/// 把字节复制到剪贴板（文本附件用）。
Future<void> copyTextSilently(String text) =>
    Clipboard.setData(ClipboardData(text: text));
