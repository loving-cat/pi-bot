import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart';

/// 把附件存到用户选的位置。
///
/// 为什么不直接 `launchUrl` 丢给系统：那是"用别的程序打开"，不是"下载"。
/// 飞书/微信里点文件上的下载，要的是**存下来**。
///
/// 平台差异得自己抹平（file_picker 各平台行为不一致）：
///   · 桌面：saveFile 只让你选路径，返回路径，**字节要自己写**
///   · Android/iOS：saveFile 拿到 bytes 就自己落盘了
///   · Web：浏览器接管
///
/// @returns 存好的路径；用户取消返回 null。
Future<String?> saveAttachment({
  required String name,
  required List<int> bytes,
}) async {
  final path = await FilePicker.platform.saveFile(
    fileName: name,
    bytes: kIsWeb ? Uint8List.fromList(bytes) : null,
  );
  if (path == null) return null; // 用户取消
  if (kIsWeb) return path;
  // 桌面端要自己写。移动端 saveFile 已经写过一次了，再写会覆盖成一样的，无害但没必要。
  if (!Platform.isAndroid && !Platform.isIOS) {
    await File(path).writeAsBytes(bytes);
  }
  return path;
}
