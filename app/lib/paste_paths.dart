import 'dart:io';

/// macOS `autofs` 目录前缀：对其调用 `existsSync()` 可能触发内核阻塞等待，必须跳过。
bool isMacOSAutomountTrap(String path, {bool? isMacOS}) {
  if (!(isMacOS ?? Platform.isMacOS)) return false;
  return path == '/net' ||
      path.startsWith('/net/') ||
      path == '/Network' ||
      path.startsWith('/Network/') ||
      path == '/home' ||
      path.startsWith('/home/');
}

/// URI 整段受保护，单字母盘符保留给 Windows 路径识别。
final _urlPattern = RegExp(
  r'''(?<![A-Za-z0-9_./\\+-])(?:[A-Za-z][A-Za-z0-9+.-]*://|[A-Za-z][A-Za-z0-9+.-]+:|//)[^\s<>"`]+''',
);

/// 从粘贴文本里认出文件路径。
///
/// 两种形态：
///   1. 整行就是路径（Finder / 资源管理器复制文件后粘贴）→ 收成附件；
///   2. 路径混在句子里（"看下 /Users/x/a.pdf 这个"）→ 只摘出真实存在的路径，
///      其余文字原样保留。
///
/// 判断只认**真实存在的文件**：宁可少认，也不能把用户正常打的文字当路径吃掉。
/// 抽成纯函数是为了能单独测 —— 这段逻辑的边界比看起来多。
class PastePathResult {
  const PastePathResult({required this.files, required this.remainingText});

  /// 认出来的文件，按出现顺序。
  final List<File> files;

  /// 摘掉路径之后剩下的文字（已去掉行尾空白与空行）。
  final String remainingText;

  bool get hasFiles => files.isNotEmpty;
}

/// 解析粘贴文本。没有认出任何文件时 `files` 为空，`remainingText` 等于原文。
PastePathResult extractPastedFiles(String text) {
  if (text.trim().isEmpty) {
    return PastePathResult(files: const [], remainingText: text);
  }
  // 太长的不当路径解析：正常粘贴文件不会这么长，避免逐字符扫描拖慢输入
  if (text.length > 8000) {
    return PastePathResult(files: const [], remainingText: text);
  }

  final files = <File>[];
  final kept = <String>[];

  for (final rawLine in text.split(RegExp(r'[\r\n]'))) {
    final line = rawLine.trim();
    if (line.isEmpty) continue;

    // 整行就是路径：整行收走。
    // 这里是「用户就粘了一个路径」，探测只做一次 —— 放宽到 1024，
    // 别把深层目录/长文件名当成超长文本丢掉（行内探测才需要收紧到 260）。
    final whole = _urlPattern.hasMatch(line)
        ? null
        : asExistingFile(line, maxLength: 1024);
    if (whole != null) {
      files.add(whole);
      continue;
    }

    // 行内混着路径：摘出路径，其余文字保留
    final stripped = extractInlinePaths(line, files);
    if (stripped.trim().isEmpty) continue;
    kept.add(stripped.trim());
  }

  return PastePathResult(
    files: files,
    remainingText: files.isEmpty ? text : kept.join('\n'),
  );
}

/// 把一个字符串当路径试：存在就返回 File，否则 null。
///
/// 允许被引号包住（Finder 复制带空格的路径会加引号）。
File? asExistingFile(String raw, {bool? isMacOS, int maxLength = 260}) {
  var text = raw.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    text = text.substring(1, text.length - 1);
  }
  if (text.isEmpty || text.length > maxLength) return null;
  // 不含路径分隔符的短词不当路径，避免把普通单词当文件
  if (!text.contains('/') && !text.contains('\\')) return null;
  if (isMacOSAutomountTrap(text, isMacOS: isMacOS)) return null;
  final file = File(text);
  return file.existsSync() ? file : null;
}

/// 是不是 Windows 盘符（C / D / … 大小写都算）。
bool _isDriveLetter(String ch) {
  final c = ch.codeUnitAt(0);
  return (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A);
}

bool _isBoundaryChar(String ch) =>
    ch == ' ' ||
    ch == '\t' ||
    ch == ',' ||
    ch == ';' ||
    ch == ')' ||
    ch == ']' ||
    ch == '>' ||
    ch == '"' ||
    ch == "'" ||
    ch == '，' ||
    ch == '。' ||
    ch == '；' ||
    ch == '、' ||
    ch == '）' ||
    ch == '】';

/// 从一行里抽出所有真实存在的文件路径，把抽中的 File 追加进 [out]，
/// 返回剩下的文字。
String extractInlinePaths(String line, List<File> out) {
  final buffer = StringBuffer();
  final urls = _urlPattern.allMatches(line).toList();
  var urlIndex = 0;
  var i = 0;
  // 限制单行系统调用次数，避免含大量斜杠的长文阻塞 UI 线程。
  var probeBudget = 64;
  while (i < line.length) {
    while (urlIndex < urls.length && urls[urlIndex].end <= i) {
      urlIndex++;
    }
    final url = urlIndex < urls.length ? urls[urlIndex] : null;
    if (url != null && i >= url.start) {
      buffer.write(line.substring(i, url.end));
      i = url.end;
      continue;
    }
    final ch = line[i];

    // 引号包住的路径：优先整段试（带空格的路径只能这么认）
    if (ch == '"') {
      final close = line.indexOf('"', i + 1);
      if (close > i && (url == null || close < url.start) && probeBudget > 0) {
        probeBudget--;
        final file = asExistingFile(line.substring(i, close + 1));
        if (file != null) {
          out.add(file);
          i = close + 1;
          while (i < line.length && line[i] == ' ') {
            i++;
          }
          continue;
        }
      }
      buffer.write(ch);
      i++;
      continue;
    }

    // 路径可能从哪儿开始：
    //   · POSIX：/ 开头，或 ~/ 开头
    //   · Windows 盘符：C:\ 或 C:/ （字母 + 冒号 + 分隔符）
    //   · Windows UNC：\\server\share
    final startsPath =
        ch == '/' ||
        ch == '\\' ||
        (ch == '~' &&
            i + 2 < line.length &&
            (line[i + 1] == '/' || line[i + 1] == '\\')) ||
        (_isDriveLetter(ch) &&
            i + 2 < line.length &&
            line[i + 1] == ':' &&
            (line[i + 2] == '\\' || line[i + 2] == '/'));
    if (startsPath && probeBudget > 0) {
      var best = -1;
      File? bestFile;
      var maxEnd = url?.start ?? line.length;
      if (maxEnd - i > 260) maxEnd = i + 260;
      final tried = <int>{};

      // 先从高置信度边界（行尾、空格、标点）倒序探测
      for (var end = maxEnd; end > i && probeBudget > 0; end--) {
        if (end != maxEnd && !_isBoundaryChar(line[end])) continue;
        tried.add(end);
        probeBudget--;
        final hit = asExistingFile(line.substring(i, end));
        if (hit != null) {
          best = end;
          bestFile = hit;
          break;
        }
      }
      // 边界没命中时，在剩余预算内退回逐字符试探（如路径紧贴中文）
      if (best < 0 && probeBudget > 0) {
        for (var end = maxEnd; end > i && probeBudget > 0; end--) {
          if (tried.contains(end)) continue;
          probeBudget--;
          final hit = asExistingFile(line.substring(i, end));
          if (hit != null) {
            best = end;
            bestFile = hit;
            break;
          }
        }
      }
      if (best > 0 && bestFile != null) {
        out.add(bestFile);
        i = best;
        while (i < line.length && line[i] == ' ') {
          i++;
        }
        continue;
      }
    }

    buffer.write(ch);
    i++;
  }
  return buffer.toString();
}
