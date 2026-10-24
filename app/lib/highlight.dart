/// 代码高亮：一个够用就好的小分词器。
///
/// 为什么自己写而不是引三方库：
///   · 目标是"在聊天气泡里看代码"，不是编辑器 —— 不需要完整语法树；
///   · 现成的库大多把整套 highlight.js 语法打包进来（几百 KB + 一堆依赖）；
///   · 自己写就能单测：**分词是纯函数**，输入代码输出带类型的片段，
///     不用起 widget 就能验证"关键字被染色了""注释整行是灰的"。
///
/// 支持的形态（覆盖聊天里 95% 的代码）：注释 / 字符串 / 数字 / 关键字 /
/// 类型名 / 函数调用 / 标点。语言靠关键字表和注释符区分，认不出的语言
/// 一律当纯文本（绝不猜）。
library;

enum TokKind { plain, keyword, str, comment, number, type, fn, punct }

class Tok {
  const Tok(this.text, this.kind);
  final String text;
  final TokKind kind;

  @override
  String toString() => '$kind($text)';
}

/// 关键字表。按语言分组；`_generic` 是所有类 C 语言共用的兜底。
const Map<String, Set<String>> _keywords = {
  'dart': {
    'abstract', 'as', 'assert', 'async', 'await', 'break', 'case', 'catch',
    'class', 'const', 'continue', 'covariant', 'default', 'deferred', 'do',
    'dynamic', 'else', 'enum', 'export', 'extends', 'extension', 'external',
    'factory', 'false', 'final', 'finally', 'for', 'get', 'hide', 'if',
    'implements', 'import', 'in', 'interface', 'is', 'late', 'library',
    'mixin', 'new', 'null', 'on', 'operator', 'part', 'required', 'rethrow',
    'return', 'sealed', 'set', 'show', 'static', 'super', 'switch', 'sync',
    'this', 'throw', 'true', 'try', 'typedef', 'var', 'void', 'when', 'while',
    'with', 'yield',
  },
  'js': {
    'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const',
    'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export',
    'extends', 'false', 'finally', 'for', 'function', 'get', 'if', 'import',
    'in', 'instanceof', 'let', 'new', 'null', 'of', 'return', 'set', 'static',
    'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined',
    'var', 'void', 'while', 'yield',
  },
  'python': {
    'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
    'def', 'del', 'elif', 'else', 'except', 'False', 'finally', 'for', 'from',
    'global', 'if', 'import', 'in', 'is', 'lambda', 'None', 'nonlocal', 'not',
    'or', 'pass', 'raise', 'return', 'True', 'try', 'while', 'with', 'yield',
  },
  'bash': {
    'case', 'do', 'done', 'elif', 'else', 'esac', 'export', 'fi', 'for',
    'function', 'if', 'in', 'local', 'return', 'then', 'until', 'while',
  },
  'sql': {
    'add', 'all', 'alter', 'and', 'as', 'asc', 'by', 'case', 'create',
    'delete', 'desc', 'distinct', 'drop', 'else', 'end', 'from', 'group',
    'having', 'if', 'in', 'index', 'insert', 'into', 'join', 'left', 'like',
    'limit', 'not', 'null', 'on', 'or', 'order', 'outer', 'primary', 'select',
    'set', 'table', 'then', 'union', 'unique', 'update', 'values', 'when',
    'where',
  },
};

/// 别名 → 用哪张关键字表 / 注释符
const Map<String, String> _langAlias = {
  'js': 'js', 'javascript': 'js', 'jsx': 'js', 'ts': 'js', 'tsx': 'js',
  'typescript': 'js', 'json': 'js', 'node': 'js',
  'dart': 'dart', 'flutter': 'dart',
  'py': 'python', 'python': 'python', 'python3': 'python',
  'sh': 'bash', 'bash': 'bash', 'zsh': 'bash', 'shell': 'bash', 'console': 'bash',
  'sql': 'sql', 'mysql': 'sql', 'postgres': 'sql', 'psql': 'sql',
  // 其余语言走 generic（只有注释和字符串会被认出来）
  'go': 'generic', 'rust': 'generic', 'rs': 'generic', 'java': 'generic',
  'kotlin': 'generic', 'swift': 'generic', 'c': 'generic', 'cpp': 'generic',
  'cs': 'generic', 'csharp': 'generic', 'php': 'generic', 'ruby': 'generic',
  'rb': 'generic', 'yaml': 'generic', 'yml': 'generic', 'toml': 'generic',
  'ini': 'generic', 'conf': 'generic', 'dockerfile': 'generic',
  'makefile': 'generic', 'html': 'generic', 'xml': 'generic', 'css': 'generic',
  'scss': 'generic', 'vue': 'generic', 'text': 'plain', 'txt': 'plain',
};

/// 这些语言里 `#` 是注释（不是 C 系的 `//`）
const Set<String> _hashComment = {'python', 'bash'};

/// 兜底关键字（generic 用）
const Set<String> _generic = {
  'break', 'case', 'class', 'const', 'continue', 'default', 'do', 'else',
  'enum', 'export', 'extends', 'false', 'final', 'for', 'func', 'fn',
  'function', 'go', 'if', 'impl', 'import', 'in', 'interface', 'let',
  'match', 'new', 'nil', 'null', 'package', 'pub', 'return', 'self', 'static',
  'struct', 'super', 'switch', 'this', 'throw', 'trait', 'true', 'try',
  'type', 'use', 'var', 'while',
};

/// 归一化语言名：`Dart` / `dart ` / `language-dart` 都认
String normalizeLang(String? raw) {
  var s = (raw ?? '').trim().toLowerCase();
  if (s.startsWith('language-')) s = s.substring(9);
  if (s.isEmpty) return 'plain';
  return _langAlias[s] ?? 'generic';
}

/// 把一段代码切成带类型的片段。**纯函数**，可以直接单测。
List<Tok> highlightCode(String code, String? lang) {
  final langKey = normalizeLang(lang);
  if (langKey == 'plain') return [Tok(code, TokKind.plain)];

  final kws = langKey == 'generic'
      ? _generic
      : (_keywords[langKey] ?? _generic);
  final hash = _hashComment.contains(langKey);

  final out = <Tok>[];
  final buf = StringBuffer();

  void flush(TokKind kind) {
    if (buf.isEmpty) return;
    out.add(Tok(buf.toString(), kind));
    buf.clear();
  }

  bool isIdentStart(int c) =>
      (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c == 0x5F || c > 0x7F;
  bool isIdent(int c) => isIdentStart(c) || (c >= 0x30 && c <= 0x39) || c == 0x24;
  bool isDigit(int c) => c >= 0x30 && c <= 0x39;

  var i = 0;
  while (i < code.length) {
    final c = code.codeUnitAt(i);

    // 行注释：`#` 系
    if (hash && c == 0x23) {
      flush(TokKind.plain);
      final end = code.indexOf('\n', i);
      final stop = end < 0 ? code.length : end;
      out.add(Tok(code.substring(i, stop), TokKind.comment));
      i = stop;
      continue;
    }
    // 行注释：`//` 系
    if (!hash && c == 0x2F && i + 1 < code.length && code.codeUnitAt(i + 1) == 0x2F) {
      flush(TokKind.plain);
      final end = code.indexOf('\n', i);
      final stop = end < 0 ? code.length : end;
      out.add(Tok(code.substring(i, stop), TokKind.comment));
      i = stop;
      continue;
    }
    // 块注释
    if (!hash && c == 0x2F && i + 1 < code.length && code.codeUnitAt(i + 1) == 0x2A) {
      flush(TokKind.plain);
      final end = code.indexOf('*/', i + 2);
      final stop = end < 0 ? code.length : end + 2;
      out.add(Tok(code.substring(i, stop), TokKind.comment));
      i = stop;
      continue;
    }
    // 字符串（单/双/反引号，带转义）
    if (c == 0x22 || c == 0x27 || c == 0x60) {
      flush(TokKind.plain);
      final quote = c;
      var j = i + 1;
      while (j < code.length) {
        final d = code.codeUnitAt(j);
        if (d == 0x5C) {
          j += 2;
          continue;
        }
        if (d == quote) {
          j++;
          break;
        }
        if (d == 0x0A) break; // 不跨行（聊天里的代码很少有跨行字符串）
        j++;
      }
      out.add(Tok(code.substring(i, j), TokKind.str));
      i = j;
      continue;
    }
    // 数字
    if (isDigit(c) || (c == 0x2E && i + 1 < code.length && isDigit(code.codeUnitAt(i + 1)))) {
      flush(TokKind.plain);
      var j = i;
      while (j < code.length &&
          (isDigit(code.codeUnitAt(j)) ||
              code.codeUnitAt(j) == 0x2E ||
              code.codeUnitAt(j) == 0x78 ||
              code.codeUnitAt(j) == 0x58 ||
              (code.codeUnitAt(j) >= 0x61 && code.codeUnitAt(j) <= 0x66) ||
              (code.codeUnitAt(j) >= 0x41 && code.codeUnitAt(j) <= 0x46))) {
        j++;
      }
      out.add(Tok(code.substring(i, j), TokKind.number));
      i = j;
      continue;
    }
    // 标识符 / 关键字 / 类型 / 函数名
    if (isIdentStart(c)) {
      flush(TokKind.plain);
      var j = i;
      while (j < code.length && isIdent(code.codeUnitAt(j))) {
        j++;
      }
      final word = code.substring(i, j);
      // 后面紧跟 `(` 的当函数名（视觉上一眼能区分调用和变量）
      var k = j;
      while (k < code.length && code.codeUnitAt(k) == 0x20) {
        k++;
      }
      final call = k < code.length && code.codeUnitAt(k) == 0x28;
      // 首字母大写且不是关键字的当类型
      final looksType =
          word.length > 1 && word[0] == word[0].toUpperCase() && word[0] != '_';
      out.add(Tok(
        word,
        kws.contains(word)
            ? TokKind.keyword
            : call
                ? TokKind.fn
                : looksType
                    ? TokKind.type
                    : TokKind.plain,
      ));
      i = j;
      continue;
    }
    // 标点/运算符：合并连续的
    if (!(c == 0x20 || c == 0x09)) {
      flush(TokKind.plain);
      var j = i;
      while (j < code.length &&
          !isIdentStart(code.codeUnitAt(j)) &&
          !isDigit(code.codeUnitAt(j)) &&
          code.codeUnitAt(j) != 0x20 &&
          code.codeUnitAt(j) != 0x09 &&
          code.codeUnitAt(j) != 0x0A) {
        final d = code.codeUnitAt(j);
        if (d == 0x22 || d == 0x27 || d == 0x60) break;
        j++;
      }
      // 兜底：没有任何字符被吃掉时（比如遇上了奇怪的符号），
      // 也必须往前走一步 —— 否则这里会死循环
      if (j == i) j = i + 1;
      out.add(Tok(code.substring(i, j), TokKind.punct));
      i = j;
      continue;
    }
    buf.writeCharCode(c);
    i++;
  }
  flush(TokKind.plain);
  return out;
}
