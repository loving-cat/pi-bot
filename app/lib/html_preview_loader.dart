import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

const htmlPreviewMaxBytes = 1024 * 1024;

/// HTML 扩展名或附件 MIME 命中时提供网页预览，不通过内容嗅探执行其他文件。
bool isHtmlAttachment(String name, String mime) {
  final lower = name.toLowerCase();
  return lower.endsWith('.html') ||
      lower.endsWith('.htm') ||
      mime.split(';').first.trim().toLowerCase() == 'text/html';
}

class HtmlPreviewLoadException implements Exception {
  const HtmlPreviewLoadException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => message;
}

const _tooLarge = HtmlPreviewLoadException(
  'too_large',
  '文件超过 1 MiB，无法在窗口内预览，请下载后打开。',
);
const _encoding = HtmlPreviewLoadException(
  'encoding',
  '暂不支持这个文件的文字编码，请保存为 UTF-8 后重试。',
);
const _cancelled = HtmlPreviewLoadException('cancelled', '读取已取消。');

/// 严格解码 UTF-8，可带 BOM；其他声明编码或二进制内容不交给渲染器。
String decodeHtmlPreview(List<int> bytes, {String? contentType}) {
  if (bytes.length > htmlPreviewMaxBytes) throw _tooLarge;
  if (bytes.contains(0)) throw _encoding;
  var start = 0;
  if (bytes.length >= 3 &&
      bytes[0] == 0xef &&
      bytes[1] == 0xbb &&
      bytes[2] == 0xbf) {
    start = 3;
  }
  String text;
  try {
    text = utf8.decode(bytes.sublist(start));
  } on FormatException {
    throw _encoding;
  }
  final charset = RegExp(
    r'''charset\s*=\s*["']?\s*([a-zA-Z0-9_-]+)''',
    caseSensitive: false,
  );
  void checkEncoding(String value) {
    for (final match in charset.allMatches(value)) {
      if (!{
        'utf-8',
        'utf8',
        'us-ascii',
        'ascii',
      }.contains(match.group(1)!.toLowerCase()))
        throw _encoding;
    }
  }

  checkEncoding(contentType ?? '');
  final head = text.substring(0, text.length.clamp(0, 8192));
  for (final meta in RegExp(
    r'<meta\b[^>]*>',
    caseSensitive: false,
  ).allMatches(head)) {
    checkEncoding(meta.group(0)!);
  }
  return text;
}

/// 单次有界附件读取；拒绝重定向，取消和超时会关闭请求，不回显请求地址。
class HtmlPreviewLoader {
  HtmlPreviewLoader({
    http.Client? client,
    this.timeout = const Duration(seconds: 30),
  }) : _client = client ?? http.Client();

  final http.Client _client;
  final Duration timeout;
  final Completer<String> _result = Completer<String>();
  StreamSubscription<List<int>>? _subscription;
  Timer? _timer;
  bool _started = false;
  bool _closed = false;

  Future<String> load(Uri source, {int declaredSize = 0}) {
    if (_started) throw StateError('每个读取器只接收一次请求');
    _started = true;
    if (_closed) {
      _result.completeError(_cancelled);
    } else if (declaredSize > htmlPreviewMaxBytes) {
      _fail(_tooLarge);
    } else if (!{'http', 'https'}.contains(source.scheme) ||
        source.host.isEmpty ||
        source.userInfo.isNotEmpty) {
      _fail(const HtmlPreviewLoadException('address', '附件地址不可用，请重新打开附件。'));
    } else {
      _timer = Timer(
        timeout,
        () =>
            _fail(const HtmlPreviewLoadException('timeout', '读取超时，请重试或下载文件。')),
      );
      unawaited(_read(source));
    }
    return _result.future;
  }

  Future<void> _read(Uri source) async {
    try {
      final request = http.Request('GET', source)..followRedirects = false;
      final response = await _client.send(request);
      if (_result.isCompleted) {
        await response.stream.listen((_) {}).cancel();
        return;
      }
      if (response.statusCode >= 300 && response.statusCode < 400) {
        _fail(const HtmlPreviewLoadException('redirect', '附件地址发生跳转，请重新打开附件。'));
        return;
      }
      if (response.statusCode != 200) {
        _fail(const HtmlPreviewLoadException('http', '无法读取附件，请检查连接后重试。'));
        return;
      }
      if ((response.contentLength ?? 0) > htmlPreviewMaxBytes) {
        _fail(_tooLarge);
        return;
      }
      final bytes = BytesBuilder(copy: false);
      var length = 0;
      _subscription = response.stream.listen(
        (chunk) {
          if (_result.isCompleted) return;
          length += chunk.length;
          if (length > htmlPreviewMaxBytes) {
            _fail(_tooLarge);
            return;
          }
          bytes.add(chunk);
        },
        onError: (Object _) {
          _fail(const HtmlPreviewLoadException('network', '读取附件失败，请检查连接后重试。'));
        },
        onDone: () {
          if (_result.isCompleted) return;
          try {
            final html = decodeHtmlPreview(
              bytes.takeBytes(),
              contentType: response.headers['content-type'],
            );
            _result.complete(html);
            _close();
          } on HtmlPreviewLoadException catch (error) {
            _fail(error);
          }
        },
        cancelOnError: true,
      );
    } catch (_) {
      _fail(const HtmlPreviewLoadException('network', '读取附件失败，请检查连接后重试。'));
    }
  }

  void _fail(HtmlPreviewLoadException error) {
    if (!_result.isCompleted) _result.completeError(error);
    _close();
  }

  void _close() {
    if (_closed) return;
    _closed = true;
    _timer?.cancel();
    final subscription = _subscription;
    _subscription = null;
    if (subscription != null) {
      unawaited(subscription.cancel().catchError((Object _) {}));
    }
    try {
      _client.close();
    } catch (_) {
      // 读取结果已结束，关闭失败不再触发界面错误。
    }
  }

  void cancel() {
    if (!_started) {
      _close();
      return;
    }
    _fail(_cancelled);
  }
}
