import 'dart:io';

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

    // 整行就是路径：整行收走
    final whole = asExistingFile(line);
    if (whole != null) {
      files.add(whole);
      continue;
    }

    // 行内混着路径：摘出路径，其余文字保留
    final stripped = extractInlinePaths(line, files);
    if (stripped.trim().isEmpty) continue;
    kept.add(stripped.trim());
  }

  return PastePathResult(files: files, remainingText: kept.join('\n'));
}

/// 把一个字符串当路径试：存在就返回 File，否则 null。
///
/// 允许被引号包住（Finder 复制带空格的路径会加引号）。
File? asExistingFile(String raw) {
  var text = raw.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    text = text.substring(1, text.length - 1);
  }
  if (text.isEmpty || text.length > 1024) return null;
  // 不含路径分隔符的短词不当路径，避免把普通单词当文件
  if (!text.contains('/') && !text.contains('\\')) return null;
  final file = File(text);
  return file.existsSync() ? file : null;
}

/// 从一行里抽出所有真实存在的文件路径，把抽中的 File 追加进 [out]，
/// 返回剩下的文字。
String extractInlinePaths(String line, List<File> out) {
  final buffer = StringBuffer();
  var i = 0;
  while (i < line.length) {
    final ch = line[i];

    // 引号包住的路径：优先整段试（带空格的路径只能这么认）
    if (ch == '"') {
      final close = line.indexOf('"', i + 1);
      if (close > i) {
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

    final startsPath = ch == '/' || (ch == '~' && i + 1 < line.length && line[i + 1] == '/');
    if (startsPath) {
      // 逐个可能的结束位置试，取最长能命中真实文件的片段。
      //
      // 为什么要试多个长度：路径里可能带空格（"b c.txt"），
      // 但句子里的空格同时又是分隔符。只按空格截断会漏掉带空格的路径，
      // 只用最长匹配又会把后面的句子一起吃进来。
      var best = -1;
      var end = line.length;
      while (end > i) {
        if (asExistingFile(line.substring(i, end)) != null) {
          best = end;
          break;
        }
        end--;
      }
      if (best > 0) {
        out.add(asExistingFile(line.substring(i, best))!);
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
