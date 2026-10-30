/// 右侧「通用展示栏」的状态：开关、当前内容、历史，以及多栏争抢宽度时的收纳规则。
///
/// 这一栏既是浏览器（点链接打开网页），也是**通用查看器**（表格 / PDF / Word
/// 由服务端渲染成 HTML 后在这里显示）—— 两者共用同一个 webview 和宽度管理，
/// 所以只有一个状态对象。
///
/// 为什么放这里而不是 widget 里：它是 HomeShell 布局里的一栏，
/// 但开启入口散在 Markdown 链接、附件卡片、顶部按钮等多处，需要一个共同的地方。
library;

import 'package:flutter/foundation.dart';

/// 一栏的标识。用于「宽度不够时收谁」的判定。
enum PaneKind {
  rooms('左栏：会话列表'),
  chat('中栏：聊天'),
  roomPanel('右栏：Bot 信息'),
  browser('最右栏：内置浏览器');

  const PaneKind(this.label);

  final String label;
}

/// 记录每一栏「最后一次被用户动过」的时间。
///
/// 判定规则（用户定的）：分辨率不够时，**自动收起用户最早开的那栏** ——
/// 开得久且一直没动，大概率是已经不需要了。
/// 注意「开」和「动」分开记：开得早但刚滚过消息，不该被收。
class PaneActivity {
  final Map<PaneKind, int> _lastTouched = {};

  int get now => DateTime.now().millisecondsSinceEpoch;

  /// 某栏刚被创建/打开时调用
  void opened(PaneKind kind) => _lastTouched[kind] = now;

  /// 用户在栏里做了任何事（滚动、点、输入）时调用
  void touched(PaneKind kind) => _lastTouched[kind] = now;

  /// 关闭时清掉，下次重开重新计时
  void closed(PaneKind kind) => _lastTouched.remove(kind);

  int? lastTouchedAt(PaneKind kind) => _lastTouched[kind];

  /// 从候选里挑一个最久没被动过的。从没记过的算最老（排最前面）。
  PaneKind? oldestAmong(Iterable<PaneKind> candidates) {
    PaneKind? oldest;
    int? oldestAt;
    for (final kind in candidates) {
      final at = _lastTouched[kind];
      if (at == null) return kind; // 从没动过 = 最该收
      if (oldestAt == null || at < oldestAt) {
        oldestAt = at;
        oldest = kind;
      }
    }
    return oldest;
  }

  void clear() => _lastTouched.clear();
}

/// 展示栏里正在显示什么。
enum PaneContentKind {
  /// 网页（点链接、地址栏输入）
  web,

  /// 附件渲染成的页面（表格 / Word 走 HTML，PDF 走内核自带阅读器）
  file,
}

/// 内置浏览器 / 通用展示栏的状态。
class BrowserPaneState extends ChangeNotifier {
  bool _open = false;
  String _url = '';
  PaneContentKind _kind = PaneContentKind.web;
  String _title = '';
  /// 当前展示的附件名（file 模式下用于标签显示）
  String _fileName = '';

  /// 是否由 webview 内核直接渲染（PDF）而不是显示我们的 HTML
  bool _nativeViewer = false;
  final List<String> _history = [];
  int _historyIndex = -1;

  final PaneActivity activity = PaneActivity();

  bool get open => _open;
  String get url => _url;

  /// 当前是网页还是文件
  PaneContentKind get kind => _kind;

  /// 栏标题（网页用主机名、文件用文件名）
  String get title => _title;

  String get fileName => _fileName;

  /// 把一个附件在这个栏里打开。
  ///
  /// [nativeViewer] = true 表示这是 PDF 这类由 **webview 内核自己渲染**的文件
  /// （地址指向原文件，不是 /html）；false 表示服务端渲染好的 HTML 页面。
  void showFile({
    required String name,
    required String htmlUrl,
    bool nativeViewer = false,
  }) {
    if (!_open) {
      _open = true;
      activity.opened(PaneKind.browser);
    } else {
      activity.touched(PaneKind.browser);
    }
    _kind = PaneContentKind.file;
    _fileName = name;
    _title = name;
    _url = htmlUrl;
    _nativeViewer = nativeViewer;
    _pushHistory(htmlUrl);
    notifyListeners();
  }

  /// 当前文件是否交给内核自己渲染（PDF）
  bool get nativeViewer => _nativeViewer;

  /// 地址栏里显示的文本
  String get displayUrl => _url;

  bool get canGoBack => _historyIndex > 0;
  bool get canGoForward => _historyIndex >= 0 && _historyIndex < _history.length - 1;

  List<String> get history => List.unmodifiable(_history);

  /// 打开某个网页地址。已经开着就换页，不重置历史。
  void openUrl(String url) {
    final normalized = normalizeUrl(url);
    if (normalized == null) return;
    if (!_open) {
      _open = true;
      activity.opened(PaneKind.browser);
    } else {
      activity.touched(PaneKind.browser);
    }
    _kind = PaneContentKind.web;
    _fileName = '';
    _nativeViewer = false;
    _title = Uri.tryParse(normalized)?.host ?? '';
    _url = normalized;
    _pushHistory(normalized);
    notifyListeners();
  }

  /// 记一条历史（同一地址不重复记）
  void _pushHistory(String normalized) {
    if (_historyIndex >= 0 && _history[_historyIndex] == normalized) return;
    if (_historyIndex < _history.length - 1) {
      _history.removeRange(_historyIndex + 1, _history.length);
    }
    _history.add(normalized);
    _historyIndex = _history.length - 1;
  }

  void close() {
    if (!_open) return;
    _open = false;
    activity.closed(PaneKind.browser);
    notifyListeners();
  }

  void toggle() => _open ? close() : notifyListeners();

  /// 用户在浏览器栏里操作了（滚动、点链接等）
  void touch() {
    if (!_open) return;
    activity.touched(PaneKind.browser);
  }

  String? back() {
    if (!canGoBack) return null;
    _historyIndex--;
    _url = _history[_historyIndex];
    activity.touched(PaneKind.browser);
    notifyListeners();
    return _url;
  }

  String? forward() {
    if (!canGoForward) return null;
    _historyIndex++;
    _url = _history[_historyIndex];
    activity.touched(PaneKind.browser);
    notifyListeners();
    return _url;
  }
}

/// 把用户输入/链接整理成可导航的地址。
///
/// 只放行 http/https：内置浏览器不该接 file:、content:、javascript: 这些。
/// 没写协议的（`example.com`）按 https 补全；明显是搜词的也交给 https 搜索。
String? normalizeUrl(String input) {
  final text = input.trim();
  if (text.isEmpty) return null;
  final uri = Uri.tryParse(text);
  if (uri != null && uri.hasScheme) {
    final scheme = uri.scheme.toLowerCase();
    if (scheme != 'http' && scheme != 'https') return null;
    if (uri.host.isEmpty) return null;
    return uri.toString();
  }
  // 没有协议：看着像域名就补 https，否则当搜索词
  final looksLikeHost = RegExp(
    r'^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+(?::\d+)?(?:/.*)?$',
  ).hasMatch(text);
  if (looksLikeHost) {
    final withScheme = Uri.tryParse('https://$text');
    if (withScheme != null && withScheme.host.isNotEmpty) {
      return withScheme.toString();
    }
    return null;
  }
  return Uri.https('www.bing.com', '/search', {'q': text}).toString();
}
