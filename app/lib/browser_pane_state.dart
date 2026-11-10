/// 展示栏状态、完整导航历史与多栏活动顺序。
library;

import 'package:flutter/foundation.dart';

import 'attachment_preview_request.dart';

/// 一栏的标识。用于「宽度不够时收谁」的判定。
enum PaneKind {
  rooms('左栏：会话列表'),
  chat('中栏：聊天'),
  roomPanel('右栏：Bot 信息'),
  browser('最右栏：内置浏览器');

  const PaneKind(this.label);

  final String label;
}

/// 记录每个栏的打开与最近交互时间；显示范围由桌面布局模块决定。
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

class _BrowserLocation {
  const _BrowserLocation({
    required this.url,
    required this.kind,
    required this.title,
    this.fileName = '',
    this.nativeViewer = false,
    this.fileRequest,
  });
  final String url;
  final PaneContentKind kind;
  final String title;
  final String fileName;
  final bool nativeViewer;
  final AttachmentPreviewRequest? fileRequest;
}

/// 上一次在展示栏里打开的文件（切到网页后用来回退）。
class _FileSnapshot {
  const _FileSnapshot({
    required this.name,
    required this.url,
    required this.title,
    required this.nativeViewer,
    required this.request,
  });

  final String name;
  final String url;
  final String title;
  final bool nativeViewer;
  final AttachmentPreviewRequest? request;
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
  AttachmentPreviewRequest? _fileRequest;
  AttachmentPreviewRequest? get fileRequest => _fileRequest;

  /// 切到网页模式前正在看的文件（用于"回到刚才的材料"）。
  ///
  /// ★ 为什么要记：用户在文件预览里点地址栏想输网址，输完却没输就退出时，
  ///   原文件已经被 openEmpty() 清掉了 —— 回不去，只能重新点一遍附件。
  ///   这里留一份快照，菜单里给"回到上一个文件"的入口。
  _FileSnapshot? _lastFile;

  /// 有没有可回退的文件
  bool get hasLastFile => _lastFile != null;
  final List<_BrowserLocation> _history = [];
  int _navigationRevision = 0;

  /// 宿主发起的导航序号；页面自身导航不会再次触发加载。
  int get navigationRevision => _navigationRevision;
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
    AttachmentPreviewRequest? request,
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
    _fileRequest = request;
    _pushHistory();
    _navigationRevision++;
    notifyListeners();
  }

  /// 当前文件是否交给内核自己渲染（PDF）
  bool get nativeViewer => _nativeViewer;

  /// 地址栏里显示的文本
  String get displayUrl => _url;

  bool get canGoBack => _historyIndex > 0;
  bool get canGoForward =>
      _historyIndex >= 0 && _historyIndex < _history.length - 1;

  List<String> get history =>
      List.unmodifiable(_history.map((entry) => entry.url));

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
    _fileRequest = null;
    _title = Uri.tryParse(normalized)?.host ?? '';
    _url = normalized;
    _pushHistory();
    _navigationRevision++;
    notifyListeners();
  }

  _BrowserLocation get _location => _BrowserLocation(
    url: _url,
    kind: _kind,
    title: _title,
    fileName: _fileName,
    nativeViewer: _nativeViewer,
    fileRequest: _fileRequest,
  );

  void _restore(_BrowserLocation entry) {
    _url = entry.url;
    _kind = entry.kind;
    _title = entry.title;
    _fileName = entry.fileName;
    _nativeViewer = entry.nativeViewer;
    _fileRequest = entry.fileRequest;
  }

  void _pushHistory() {
    if (_historyIndex >= 0 && _history[_historyIndex].url == _url) {
      _history[_historyIndex] = _location;
      return;
    }
    if (_historyIndex < _history.length - 1) {
      _history.removeRange(_historyIndex + 1, _history.length);
    }
    _history.add(_location);
    _historyIndex = _history.length - 1;
  }

  /// 记录页面实际跳转，不发出新的宿主加载指令。
  void recordNavigation(String url) {
    final uri = Uri.tryParse(url);
    if (uri == null ||
        !['http', 'https'].contains(uri.scheme) ||
        uri.host.isEmpty ||
        url == _url)
      return;
    final sameFile =
        _kind == PaneContentKind.file &&
        Uri.tryParse(_url)?.replace(fragment: '') == uri.replace(fragment: '');
    _url = url;
    if (!sameFile) {
      _kind = PaneContentKind.web;
      _title = uri.host;
      _fileName = '';
      _nativeViewer = false;
      _fileRequest = null;
    }
    _pushHistory();
    activity.touched(PaneKind.browser);
    notifyListeners();
  }

  /// 打开浏览器栏（不加载任何地址）。
  ///
  /// ★ 两种情况要分开处理：
  ///   · 栏根本没开 → 打开。
  ///   · 栏开着正显示某个文件 → **切到网页模式**。
  ///     以前这里判断 `if (_open) return;`，于是「先打开文件、再从菜单点
  ///     打开浏览器」完全没反应：栏已经开着（被文件占着），菜单只是
  ///     标了一下活跃，屏幕上什么都不变。
  ///   · 已经停在网页模式 → 只标活跃，不动地址和历史（从菜单再点一次
  ///     不该把正在看的页面弄丢）。
  void openEmpty() {
    final opening = !_open;
    if (opening) {
      _open = true;
      activity.opened(PaneKind.browser);
    } else {
      activity.touched(PaneKind.browser);
    }
    // 已经停在网页模式且地址没变 → 没什么可切的，只标活跃
    if (!opening && _kind == PaneContentKind.web && _url.isEmpty) {
      notifyListeners();
      return;
    }
    // 从文件切过来：先把文件存一份快照，再清掉当前文件态。
    // 网页地址留着（切回来还能继续看）；文件地址必须丢掉 ——
    // 那是 /html 或原文件地址，拿去当网页地址没意义。
    final wasFile = _kind == PaneContentKind.file;
    if (wasFile) {
      _lastFile = _FileSnapshot(
        name: _fileName,
        url: _url,
        title: _title,
        nativeViewer: _nativeViewer,
        request: _fileRequest,
      );
    }
    final keepUrl = _kind == PaneContentKind.web && _url.isNotEmpty;
    _kind = PaneContentKind.web;
    _fileName = '';
    _nativeViewer = false;
    _fileRequest = null;
    _title = '';
    if (!keepUrl) _url = '';
    // 历史是跟着内容的：从文件切过来时清掉，免得"后退"退到文件页
    if (!keepUrl) {
      _history.clear();
      _historyIndex = -1;
    }
    // ★ 地址为空时**不要**压历史。
    //   _pushHistory 不看 url 是否为空，压进去就是一条空记录 ——
    //   用户接着输网址后，history 变成 ['', 'https://…']，
    //   点「后退」会回到一片空白。
    if (_url.isNotEmpty) _pushHistory();
    _navigationRevision++;
    notifyListeners();
  }

  /// 回到切到网页之前正在看的那个文件。
  ///
  /// 用户在文件预览里点地址栏、又没输网址就退出时，用这个把材料找回来。
  /// 没有快照就什么都不做。
  void backToLastFile() {
    final snap = _lastFile;
    if (snap == null) return;
    _lastFile = null;
    _open = true;
    _kind = PaneContentKind.file;
    _fileName = snap.name;
    _title = snap.title;
    _url = snap.url;
    _nativeViewer = snap.nativeViewer;
    _fileRequest = snap.request;
    activity.touched(PaneKind.browser);
    // 文件的历史栈和网页不通用，重新起一条
    _history
      ..clear()
      ..add(_location);
    _historyIndex = 0;
    _navigationRevision++;
    notifyListeners();
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
    _restore(_history[_historyIndex]);
    _navigationRevision++;
    activity.touched(PaneKind.browser);
    notifyListeners();
    return _url;
  }

  String? forward() {
    if (!canGoForward) return null;
    _historyIndex++;
    _restore(_history[_historyIndex]);
    _navigationRevision++;
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
