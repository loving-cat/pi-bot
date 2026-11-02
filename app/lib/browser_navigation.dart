/// 网络主框架地址的比较键；只补齐空根路径，查询串和非根尾斜线保持区别。
/// 片段不参与网络请求身份，原始地址仍由界面和历史记录保存。
String? browserRequestIdentity(String? value) {
  final uri = value == null ? null : Uri.tryParse(value);
  if (uri == null ||
      !const ['http', 'https'].contains(uri.scheme) ||
      uri.host.isEmpty) {
    return null;
  }
  final network = uri.removeFragment();
  return (network.path.isEmpty ? network.replace(path: '/') : network)
      .toString();
}

/// 同一 WebView 内的导航归属；异步原生地址查询必须携带启动时的 epoch。
/// 控件回调没有原生导航 ID，退役地址只用于排除尚未确认属于当前链的旧事件。
class BrowserNavigation {
  int _epoch = 0;
  bool _started = false;
  bool _finished = false;
  bool _redirectObserved = false;
  final Set<String> _addresses = {};
  final Set<String> _retired = {};

  int get epoch => _epoch;

  void begin(String url) {
    _retired.addAll(_addresses);
    while (_retired.length > 64) {
      _retired.remove(_retired.first);
    }
    _addresses.clear();
    final key = browserRequestIdentity(url);
    if (key != null) _addresses.add(key);
    _started = false;
    _finished = false;
    _redirectObserved = false;
    _epoch++;
  }

  bool contains(String? url) {
    final key = browserRequestIdentity(url);
    return key != null && _addresses.contains(key);
  }

  /// 原生明确发起的新页面导航开始新 epoch；重定向扩展当前地址链。
  /// 返回 true 表示开始了新页面，调用方可清除上一页的错误提示。
  bool request(String url, {bool explicit = false, bool redirect = false}) {
    final key = browserRequestIdentity(url);
    if (key == null) return false;
    if (redirect) {
      _redirectObserved = true;
      _addresses.add(key);
      return false;
    }
    if (explicit || _finished) {
      begin(url);
      return true;
    }
    if (_addresses.contains(key)) return false;
    if (_redirectObserved || (_started && !_retired.contains(key))) {
      _addresses.add(key);
    }
    return false;
  }

  bool started(String? url) {
    if (!contains(url)) return false;
    _started = true;
    return true;
  }

  void redirected(int epoch) {
    if (epoch == _epoch) _redirectObserved = true;
  }

  /// 调用方已确认 url 等于原生控件的实际地址；只接纳当前导航或已观察的重定向。
  bool acceptActual(String? url, int epoch) {
    if (epoch != _epoch) return false;
    final key = browserRequestIdentity(url);
    if (key == null) return false;
    if (_addresses.contains(key)) return true;
    if (_redirectObserved || (_started && !_retired.contains(key))) {
      _addresses.add(key);
      return true;
    }
    return false;
  }

  void finished(String? url, int epoch) {
    if (epoch == _epoch && contains(url)) _finished = true;
  }
}
