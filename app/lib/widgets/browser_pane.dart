/// 最右列：内置浏览器。
///
/// 布局约定（用户定的）：Bot 信息栏永远在右侧第一列，这个浏览器栏永远在
/// **最右列**。两栏互不覆盖、各自让出宽度，不抢同一个位置。
///
/// 和附件预览的关系：这**不是**附件预览的复用。附件预览刻意锁死到只看
/// about:srcdoc，这里要真的浏览网页，所以用的是 `browser_platform_policy.dart`
/// 那套独立配置。两者不共享 settings，避免为了浏览网页把预览的沙箱拆掉。
library;

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';

import '../browser_pane_state.dart';
import '../scope.dart';
import '../browser_platform_policy.dart';
import '../theme.dart';

class BrowserPane extends StatefulWidget {
  const BrowserPane({
    super.key,
    required this.state,
    this.width,
  });

  final BrowserPaneState state;
  final double? width;

  @override
  State<BrowserPane> createState() => _BrowserPaneState();
}

class _BrowserPaneState extends State<BrowserPane> {
  InAppWebViewController? _controller;
  final TextEditingController _address = TextEditingController();
  final FocusNode _addressFocus = FocusNode();
  double _progress = 0;
  String? _error;
  String _currentUrl = '';
  final bool _environmentFailed = false;
  TargetPlatform get _platform => defaultTargetPlatform;

  @override
  void initState() {
    super.initState();
    _currentUrl = widget.state.url;
    _address.text = _currentUrl;
    widget.state.addListener(_onStateChanged);
    _addressFocus.addListener(() {
      if (_addressFocus.hasFocus) {
        // 获得焦点时全选，方便直接覆盖输入
        _address.selection = TextSelection(
          baseOffset: 0,
          extentOffset: _address.text.length,
        );
      }
    });
  }

  @override
  void dispose() {
    widget.state.removeListener(_onStateChanged);
    _address.dispose();
    _addressFocus.dispose();
    super.dispose();
  }

  void _onStateChanged() {
    final next = widget.state.url;
    if (next != _currentUrl) {
      _currentUrl = next;
      _address.text = next;
      unawaited(_controller?.loadUrl(urlRequest: URLRequest(url: WebUri(next))));
    }
    if (mounted) setState(() {});
  }

  Future<void> _submit(String raw) async {
    final normalized = normalizeUrl(raw);
    if (normalized == null) return;
    widget.state.openUrl(normalized);
    _addressFocus.unfocus();
  }

  @override
  Widget build(BuildContext context) {
    final state = widget.state;
    return Container(
      width: widget.width,
      color: PB.bgPane,
      child: Column(
        children: [
          _toolbar(state),
          if (_progress > 0 && _progress < 1)
            SizedBox(
              height: 2,
              child: LinearProgressIndicator(
                value: _progress,
                minHeight: 2,
                backgroundColor: Colors.transparent,
                valueColor: const AlwaysStoppedAnimation(PB.success),
              ),
            ),
          Expanded(child: _content(state)),
        ],
      ),
    );
  }

  Widget _toolbar(BrowserPaneState state) => Container(
    padding: const EdgeInsets.fromLTRB(8, 6, 8, 6),
    decoration: const BoxDecoration(
      border: Border(bottom: BorderSide(color: PB.borderTertiary)),
    ),
    child: Row(
      children: [
        _iconButton(
          key: const ValueKey('browser-back'),
          icon: LucideIcons.chevronLeft,
          tooltip: '后退',
          enabled: state.canGoBack,
          onTap: () {
            final url = state.back();
            if (url != null) {
              unawaited(
                _controller?.loadUrl(urlRequest: URLRequest(url: WebUri(url))),
              );
            }
          },
        ),
        _iconButton(
          key: const ValueKey('browser-forward'),
          icon: LucideIcons.chevronRight,
          tooltip: '前进',
          enabled: state.canGoForward,
          onTap: () {
            final url = state.forward();
            if (url != null) {
              unawaited(
                _controller?.loadUrl(urlRequest: URLRequest(url: WebUri(url))),
              );
            }
          },
        ),
        _iconButton(
          key: const ValueKey('browser-reload'),
          icon: LucideIcons.rotateCw,
          tooltip: '刷新',
          enabled: _controller != null,
          onTap: () => unawaited(_controller?.reload()),
        ),
        const SizedBox(width: 4),
        Expanded(
          child: SizedBox(
            height: 30,
            // 文件模式不让人编辑地址：那不是网址，改它没有意义。
            child: state.kind == PaneContentKind.file
                ? Container(
                    key: const ValueKey('browser-file-label'),
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                    decoration: BoxDecoration(
                      color: PB.bgElevated,
                      borderRadius: BorderRadius.circular(PB.rSm),
                    ),
                    child: Row(
                      children: [
                        const Icon(
                          LucideIcons.fileText,
                          size: 14,
                          color: PB.textTertiary,
                        ),
                        const SizedBox(width: 6),
                        Expanded(
                          child: Text(
                            // 只显示文件名，不让长路径把工具栏撑爆
                            state.fileName.split('/').last.split(r'\').last,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: PB.fsXs,
                              color: PB.textSecondary,
                              fontFamily: PB.monoFamily,
                            ),
                          ),
                        ),
                      ],
                    ),
                  )
                : TextField(
              key: const ValueKey('browser-address'),
              controller: _address,
              focusNode: _addressFocus,
              style: const TextStyle(
                fontSize: PB.fsXs,
                color: PB.textSecondary,
                fontFamily: PB.monoFamily,
              ),
              decoration: InputDecoration(
                isDense: true,
                filled: true,
                fillColor: PB.bgElevated,
                contentPadding:
                    const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(PB.rSm),
                  borderSide: BorderSide.none,
                ),
                hintText: '输入网址或搜索词',
                hintStyle: const TextStyle(
                  fontSize: PB.fsXs,
                  color: PB.textQuaternary,
                ),
              ),
              textInputAction: TextInputAction.go,
              onSubmitted: _submit,
              onTap: () => state.touch(),
            ),
          ),
        ),
        const SizedBox(width: 4),
        _iconButton(
          key: const ValueKey('browser-open-external'),
          icon: LucideIcons.externalLink,
          tooltip: '用系统浏览器打开',
          enabled: _currentUrl.isNotEmpty,
          onTap: () async {
            final uri = Uri.tryParse(_currentUrl);
            if (uri != null) {
              await launchUrl(uri, mode: LaunchMode.externalApplication);
            }
          },
        ),
        _iconButton(
          key: const ValueKey('browser-close'),
          icon: LucideIcons.x,
          tooltip: '关闭',
          enabled: true,
          // ★ 走 AppState 而不是 state.close：
          //   展示栏是布局里的一列，只有 AppState 的通知能读到 HomeShell。
          onTap: () => AppScope.read(context).closeBrowserPane(),
        ),
      ],
    ),
  );

  Widget _iconButton({
    required Key key,
    required IconData icon,
    required String tooltip,
    required bool enabled,
    required VoidCallback onTap,
  }) => IconButton(
    key: key,
    icon: Icon(icon, size: 14),
    tooltip: tooltip,
    visualDensity: VisualDensity.compact,
    padding: const EdgeInsets.all(6),
    constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
    color: enabled ? PB.textTertiary : PB.textQuaternary,
    onPressed: enabled ? onTap : null,
  );

  Widget _content(BrowserPaneState state) {
    if (kIsWeb || !supportsBrowserPane(_platform)) {
      return const _Hint('内置浏览器只在桌面端提供（Windows / macOS）。');
    }
    if (_environmentFailed) {
      return const _Hint('这个系统的 WebView 运行时不可用，没法内置浏览。\n可以用右上角「用系统浏览器打开」。');
    }
    if (state.url.isEmpty) {
      return const _Hint('在聊天里点任何链接，都会在这里打开。');
    }
    if (_error != null) {
      return _Hint(_error!);
    }
    return InAppWebView(
      key: const ValueKey('browser-webview'),
      initialUrlRequest: URLRequest(url: WebUri(state.url)),
      initialSettings: browserPaneSettings(_platform),
      onWebViewCreated: (controller) {
        _controller = controller;
      },
      onLoadStart: (controller, url) {
        if (!mounted) return;
        setState(() {
          _progress = 0;
          _error = null;
          if (url != null) _currentUrl = url.toString();
        });
        state.touch();
      },
      onLoadStop: (controller, url) async {
        if (!mounted) return;
        setState(() {
          _progress = 1;
          if (url != null) {
            _currentUrl = url.toString();
            _address.text = _currentUrl;
          }
        });
        // 读真实标题，方便以后做标签页
        state.touch();
      },
      onProgressChanged: (controller, progress) {
        if (!mounted) return;
        setState(() => _progress = progress / 100);
      },
      onReceivedError: (controller, request, error) {
        if (!mounted) return;
        // 只报主框架的错误；子资源失败不该整页变错误页
        if (!request.isForMainFrame!) return;
        setState(() {
          _error = widget.state.nativeViewer
              ? '这个 PDF 没打开（${error.description}）。\n'
                    '可以用工具栏的「用系统浏览器打开」，或先下载。'
              : '打不开这个页面（${error.description}）';
        });
      },
      // 服务端对「不能渲染的格式」返回 415：这里换成一句人话，
      // 而不是让 webview 显示一个 415 错误页。
      onReceivedHttpError: (controller, request, response) {
        if (!mounted) return;
        if (request.isForMainFrame != true) return;
        final status = response.statusCode ?? 0;
        if (status == 415) {
          setState(() {
            _error =
                '这个文件不能转成网页查看。\n'
                '用工具栏的「用系统浏览器打开」，或先下载再打开。';
          });
        } else if (status >= 400) {
          setState(() => _error = '服务端返回 HTTP $status');
        }
      },
      shouldOverrideUrlLoading: (controller, action) async {
        final uri = action.request.url;
        if (uri == null) return NavigationActionPolicy.CANCEL;
        // 非 http/https（mailto:、tel:）交给系统
        if (isExternalScheme(uri)) {
          unawaited(launchUrl(uri, mode: LaunchMode.externalApplication));
          return NavigationActionPolicy.CANCEL;
        }
        // 只认 http/https，其余拦掉（file:、content: 等）
        if (!shouldLoadInPlace(uri)) return NavigationActionPolicy.CANCEL;
        return NavigationActionPolicy.ALLOW;
      },
      shouldInterceptRequest: _platform == TargetPlatform.windows
          ? (controller, request) async {
              if (shouldBlockBrowserRequest(request.url)) {
                return WebResourceResponse(
                  contentType: 'text/plain',
                  data: Uint8List(0),
                );
              }
              return null;
            }
          : null,
      onCreateWindow: (controller, action) async => false,
    );
  }
}

class _Hint extends StatelessWidget {
  const _Hint(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(20),
    child: Text(
      text,
      textAlign: TextAlign.center,
      style: const TextStyle(
        fontSize: PB.fsXs,
        color: PB.textQuaternary,
        height: 1.6,
      ),
    ),
  );
}
