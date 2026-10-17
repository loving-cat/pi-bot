import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

/// 从系统剪贴板读图片（截图直接 Ctrl+V 粘进来）。
///
/// Flutter 的 Clipboard 只给文本，拿不到位图；这里在 Windows 上用系统自带的
/// PowerShell + System.Drawing 把剪贴板里的图存成临时 PNG 再读回来。
/// 其它平台返回 null —— 那边的粘贴走普通文本，不影响使用。
///
/// 返回的临时文件由调用方读完即删（见 [ClipboardImage.dispose]）。
class ClipboardImage {
  ClipboardImage({required this.name, required this.bytes, this.tempPath});

  final String name;
  final Uint8List bytes;
  final String? tempPath;

  void dispose() {
    final path = tempPath;
    if (path == null) return;
    try {
      final f = File(path);
      if (f.existsSync()) f.deleteSync();
    } catch (_) {}
  }
}

/// 从 PowerShell 的输出里解出临时文件路径（纯函数，便于单测）
String? clipboardImagePathFromOutput(String stdout) {
  for (final line in stdout.split(RegExp(r'\r?\n')).reversed) {
    final text = line.trim();
    if (text.isEmpty) continue;
    if (!text.toLowerCase().endsWith('.png')) continue;
    return text;
  }
  return null;
}

/// PowerShell 脚本：有图就存成临时 PNG 并打印路径，没图就什么都不打印。
/// 保持纯 ASCII —— 避免 5.1 的编码问题。
const String _windowsReadScript =
    "Add-Type -AssemblyName System.Windows.Forms;"
    "Add-Type -AssemblyName System.Drawing;"
    r'$img=[System.Windows.Forms.Clipboard]::GetImage();'
    r'if($img -ne $null){'
    r'$p=Join-Path $env:TEMP ("pi-bot-paste-"+[guid]::NewGuid().ToString("N")+".png");'
    r'$img.Save($p,[System.Drawing.Imaging.ImageFormat]::Png);'
    r'$img.Dispose();'
    r'Write-Output $p'
    "}";

/// 读剪贴板图片；没有图片返回 null。
Future<ClipboardImage?> readClipboardImage() async {
  if (!Platform.isWindows) return null;
  try {
    final r = await Process.run('powershell', [
      '-NoProfile',
      '-STA',
      '-Command',
      _windowsReadScript,
    ], stdoutEncoding: utf8).timeout(const Duration(seconds: 6));
    if (r.exitCode != 0) return null;
    final path = clipboardImagePathFromOutput('${r.stdout}');
    if (path == null) return null;
    final file = File(path);
    if (!file.existsSync()) return null;
    final bytes = await file.readAsBytes();
    if (bytes.isEmpty) {
      try {
        file.deleteSync();
      } catch (_) {}
      return null;
    }
    final now = DateTime.now();
    final hhmmss =
        '${now.hour.toString().padLeft(2, '0')}${now.minute.toString().padLeft(2, '0')}${now.second.toString().padLeft(2, '0')}';
    return ClipboardImage(
      name: '粘贴图片-$hhmmss.png',
      bytes: bytes,
      tempPath: path,
    );
  } catch (_) {
    return null;
  }
}
