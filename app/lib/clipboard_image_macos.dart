import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

typedef ClipboardProcessStarter = Future<Process> Function(
  String executable,
  List<String> arguments,
);

/// 检查图片是否带有完整的 PNG 文件签名。
bool hasClipboardPngSignature(List<int> bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < signature.length) return false;
  for (var index = 0; index < signature.length; index++) {
    if (bytes[index] != signature[index]) return false;
  }
  return true;
}

/// 读取 macOS 剪贴板的 PNG 或 TIFF 图片，并在返回前清理私有临时目录。
///
/// 路径作为进程参数传递；超时先终止进程并等待退出，再清理临时目录。
Future<Uint8List?> readMacOSClipboardPng({
  ClipboardProcessStarter? startProcess,
  Directory? temporaryRoot,
  Duration timeout = const Duration(seconds: 6),
}) async {
  Directory? temporaryDirectory;
  Process? process;
  Future<List<int>>? completion;
  try {
    temporaryDirectory = await (temporaryRoot ?? Directory.systemTemp)
        .createTemp('pi-bot-paste-');
    final image = File(
      '${temporaryDirectory.path}${Platform.pathSeparator}clipboard.png',
    );
    process = await (startProcess ?? Process.start)('/usr/bin/osascript', [
      '-l',
      'JavaScript',
      '-e',
      macOSClipboardReadScript,
      image.path,
    ]);
    completion = Future.wait([
      process.exitCode,
      process.stdout.drain<int>(0),
      process.stderr.drain<int>(0),
    ]);
    final results = await completion.timeout(timeout);
    if (results.first != 0 || !await image.exists()) return null;
    final bytes = await image.readAsBytes();
    return hasClipboardPngSignature(bytes) ? bytes : null;
  } on TimeoutException {
    process?.kill(ProcessSignal.sigkill);
    try {
      await process?.exitCode;
      await completion;
    } catch (_) {}
    return null;
  } catch (_) {
    return null;
  } finally {
    try {
      await temporaryDirectory?.delete(recursive: true);
    } catch (_) {}
  }
}

/// 从 NSPasteboard 读取 PNG；仅有 TIFF 时转成 PNG，写入 argv 指定的路径。
const macOSClipboardReadScript = r'''
ObjC.import('AppKit');
ObjC.import('Foundation');
function run(argv) {
  var board = $.NSPasteboard.generalPasteboard;
  var png = board.dataForType($.NSPasteboardTypePNG);
  if (png.isNil() || Number(png.length) === 0) {
    var tiff = board.dataForType($.NSPasteboardTypeTIFF);
    if (tiff.isNil() || Number(tiff.length) === 0) return '';
    var bitmap = $.NSBitmapImageRep.imageRepWithData(tiff);
    if (bitmap.isNil()) return '';
    png = bitmap.representationUsingTypeProperties(
      $.NSBitmapImageFileTypePNG, $({})
    );
  }
  if (png.isNil() || Number(png.length) === 0) return '';
  if (!png.writeToFileAtomically(argv[0], true)) {
    throw new Error('Cannot write clipboard image');
  }
  return 'ok';
}
''';
