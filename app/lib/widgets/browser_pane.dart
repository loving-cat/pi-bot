/// 展示栏的网页与文档阅读界面；附件HTML沙箱使用独立组件。
library;

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';

import '../browser_pane_state.dart';
import '../l10n/l10n.dart';
import '../browser_navigation.dart';
import '../scope.dart';
import '../browser_platform_policy.dart';
import '../theme.dart';
import '../window_chrome.dart';
import 'attachment_actions.dart';
import 'attachment_preview_content.dart';

class BrowserPane extends StatefulWidget {
  const BrowserPane({
    super.key,
    required this.state,
    this.width,
    this.onClose,
    this.showNavigationControls = true,
    this.toolbarActions = const [],
  });

  final BrowserPaneState state;
  final double? width;
  final VoidCallback? onClose;
  final bool showNavigationControls;
  final List<Widget> toolbarActions;

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
  final _navigation = BrowserNavigation();
  int _navigationRevision = 0;
  int _viewGeneration = 0;
  bool _processFailed = false;
  int _initialGeneration = -1;
  int _initialRevision = -1;
  String _initialUrl = '';
  TargetPlatform get _platform => defaultTargetPlatform;

  @override
  void initState() {
    super.initState();
    _navigationRevision = widget.state.navigationRevision;
    _currentUrl = widget.state.url;
    _address.text = _currentUrl;
    _navigation.begin(_currentUrl);
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
  void didUpdateWidget(BrowserPane oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.state == widget.state) return;
    oldWidget.state.removeListener(_onStateChanged);
    widget.state.addListener(_onStateChanged);
    _controller = null;
    _processFailed = false;
    _viewGeneration++;
    _navigationRevision = -1;
    _onStateChanged();
  }

  @override
  void dispose() {
    widget.state.removeListener(_onStateChanged);
    _address.dispose();
    _addressFocus.dispose();
    super.dispose();
  }

  void _onStateChanged() {
    final state = widget.state;
    final shouldLoad = state.navigationRevision != _navigationRevision;
    _navigationRevision = state.navigationRevision;
    _currentUrl = state.url;
    _address.text = _currentUrl;
    if (shouldLoad) {
      _navigation.begin(_currentUrl);
      _error = null;
      _progress = 0;
      if (_processFailed) {
        _processFailed = false;
        _viewGeneration++;
      }
      final controller = _controller;
      if (state.fileRequest?.usesWebView == false) {
        _controller = null;
        _viewGeneration++;
      } else if (controller != null && _currentUrl.isNotEmpty) {
        unawaited(_load(controller, _currentUrl, _navigationRevision));
      }
    }
    if (mounted) setState(() {});
  }

  Future<void> _load(
    InAppWebViewController controller,
    String url,
    int revision,
  ) async {
    final epoch = _navigation.epoch;
    try {
      await controller.loadUrl(urlRequest: URLRequest(url: WebUri(url)));
    } catch (_) {
      if (mounted &&
          identical(_controller?.platform, controller.platform) &&
          revision == _navigationRevision &&
          epoch == _navigation.epoch) {
        setState(() => _error = L10n.s(context).t('browser.loadFailed'));
      }
    }
  }

  void _reload() {
    final request = widget.state.fileRequest;
    if (request != null && !request.usesWebView) {
      widget.state.showFile(
        name: request.file.name,
        htmlUrl: request.viewUrl,
        request: request,
      );
      return;
    }
    final controller = _controller;
    _navigation.begin(widget.state.url);
    setState(() {
      _error = null;
      _progress = 0;
      if (controller == null) _viewGeneration++;
      _processFailed = false;
    });
    if (controller != null) {
      unawaited(_load(controller, widget.state.url, _navigationRevision));
    }
  }

  bool _isCurrent(InAppWebViewController controller, int generation) =>
      mounted &&
      generation == _viewGeneration &&
      identical(_controller?.platform, controller.platform);

  Future<bool> _acceptActualLocation(
    InAppWebViewController controller,
    String? url,
    int generation,
    int epoch,
  ) async {
    if (!_isCurrent(controller, generation) || epoch != _navigation.epoch)
      return false;
    try {
      final actual = await controller.getUrl();
      return _isCurrent(controller, generation) &&
          epoch == _navigation.epoch &&
          browserRequestIdentity(actual?.toString()) != null &&
          browserRequestIdentity(actual?.toString()) ==
              browserRequestIdentity(url) &&
          _navigation.acceptActual(url, epoch);
    } catch (_) {
      return false;
    }
  }

  Future<void> _recordLocation(
    InAppWebViewController controller,
    WebUri? url,
    int generation,
  ) async {
    final epoch = _navigation.epoch;
    if (url == null ||
        !await _acceptActualLocation(
          controller,
          url.toString(),
          generation,
          epoch,
        ))
      return;
    widget.state.recordNavigation(url.toString());
    widget.state.touch();
  }

  Future<void> _mainFrameError(
    InAppWebViewController controller,
    WebResourceRequest request,
    int generation, {
    int? status,
    bool cancelled = false,
  }) async {
    if (!_isCurrent(controller, generation) ||
        request.isForMainFrame != true ||
        cancelled)
      return;
    final epoch = _navigation.epoch;
    final url = request.url.toString();
    if (!_navigation.contains(url) &&
        !await _acceptActualLocation(controller, url, generation, epoch))
      return;
    if (!_isCurrent(controller, generation) || epoch != _navigation.epoch)
      return;
    setState(() {
      final strings = L10n.s(context);
      if (status == 415) {
        _error = strings.t('browser.notConvertible');
      } else if (status != null) {
        _error = strings.tf('browser.httpStatus', {'status': status});
      } else {
        _error = widget.state.nativeViewer
            ? strings.t('browser.pdfFailed')
            : strings.t('browser.loadFailedRefresh');
      }
    });
    _navigation.finished(url, epoch);
  }

  Future<void> _redirected(
    InAppWebViewController controller,
    int generation,
  ) async {
    if (!_isCurrent(controller, generation)) return;
    final epoch = _navigation.epoch;
    _navigation.redirected(epoch);
    try {
      final actual = await controller.getUrl();
      if (_isCurrent(controller, generation) && epoch == _navigation.epoch) {
        _navigation.acceptActual(actual?.toString(), epoch);
      }
    } catch (_) {}
  }

  void _processStopped(InAppWebViewController controller, int generation) {
    if (!_isCurrent(controller, generation)) return;
    setState(() {
      _controller = null;
      _processFailed = true;
      _error = L10n.s(context).t('browser.processStopped');
      _progress = 0;
    });
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

  Widget _toolbar(BrowserPaneState state) => ChromeSafeHeader(
    child: DecoratedBox(
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: PB.borderTertiary)),
      ),
      child: Stack(
        children: [
          const Positioned.fill(child: WindowDragArea()),
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 6, 8, 6),
            child: Row(
              children: [
                if (widget.showNavigationControls) ...[
                  _iconButton(
                    key: const ValueKey('browser-back'),
                    icon: LucideIcons.chevronLeft,
                    tooltip: L10n.s(context).t('browser.back'),
                    enabled: state.canGoBack,
                    onTap: () => state.back(),
                  ),
                  _iconButton(
                    key: const ValueKey('browser-forward'),
                    icon: LucideIcons.chevronRight,
                    tooltip: L10n.s(context).t('browser.forward'),
                    enabled: state.canGoForward,
                    onTap: () => state.forward(),
                  ),
                  _iconButton(
                    key: const ValueKey('browser-reload'),
                    icon: LucideIcons.rotateCw,
                    tooltip: L10n.s(context).t('common.refresh'),
                    enabled: state.url.isNotEmpty,
                    onTap: _reload,
                  ),
                  const SizedBox(width: 4),
                ],
                Expanded(
                  child: SizedBox(
                    height: 30,
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
                                    state.fileName
                                        .split('/')
                                        .last
                                        .split(r'\')
                                        .last,
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
                              contentPadding: const EdgeInsets.symmetric(
                                horizontal: 10,
                                vertical: 6,
                              ),
                              border: OutlineInputBorder(
                                borderRadius: BorderRadius.circular(PB.rSm),
                                borderSide: BorderSide.none,
                              ),
                              hintText: L10n.s(context)
                                  .t('browser.addressHint'),
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
                ...widget.toolbarActions,
                if (state.fileRequest case final request?)
                  AttachmentActionButtons(request: request)
                else
                  _iconButton(
                    key: const ValueKey('browser-open-external'),
                    icon: LucideIcons.externalLink,
                    tooltip: L10n.s(context).t('browser.openExternal'),
                    enabled: _currentUrl.isNotEmpty,
                    onTap: () async {
                      final uri = Uri.tryParse(_currentUrl);
                      if (uri != null) {
                        await launchUrl(
                          uri,
                          mode: LaunchMode.externalApplication,
                        );
                      }
                    },
                  ),
                _iconButton(
                  key: const ValueKey('browser-close'),
                  icon: LucideIcons.x,
                  tooltip: L10n.s(context).t('common.close'),
                  enabled: true,
                  onTap:
                      widget.onClose ??
                      () => AppScope.read(context).closeBrowserPane(),
                ),
              ],
            ),
          ),
        ],
      ),
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
    final request = state.fileRequest;
    if (request != null && !request.usesWebView) {
      return AttachmentPreviewContent(
        key: ValueKey((request, state.navigationRevision)),
        request: request,
      );
    }
    final strings = L10n.s(context);
    if (kIsWeb || !supportsBrowserPane(_platform)) {
      return request == null
          ? _Hint(strings.t('browser.desktopOnly'))
          : AttachmentPreviewContent(request: request);
    }
    if (state.url.isEmpty) {
      return _Hint(strings.t('browser.emptyHint'));
    }
    final generation = _viewGeneration;
    if (_initialGeneration != generation) {
      _initialGeneration = generation;
      _initialRevision = _navigationRevision;
      _initialUrl = state.url;
    }
    final initialRevision = _initialRevision;
    final view = InAppWebView(
      key: ValueKey('browser-webview-$generation'),
      initialUrlRequest: URLRequest(url: WebUri(_initialUrl)),
      initialSettings: browserPaneSettings(_platform),
      onWebViewCreated: (controller) {
        if (!mounted || generation != _viewGeneration) return;
        _controller = controller;
        if (_navigationRevision != initialRevision &&
            widget.state.url.isNotEmpty) {
          unawaited(_load(controller, widget.state.url, _navigationRevision));
        }
      },
      onLoadStart: (controller, url) {
        if (!_isCurrent(controller, generation) ||
            !_navigation.started(url?.toString()))
          return;
        setState(() => _progress = 0);
        state.touch();
      },
      onLoadStop: (controller, url) async {
        final epoch = _navigation.epoch;
        if (url == null ||
            !await _acceptActualLocation(
              controller,
              url.toString(),
              generation,
              epoch,
            ))
          return;
        setState(() => _progress = 1);
        _navigation.finished(url.toString(), epoch);
        await _recordLocation(controller, url, generation);
      },
      onProgressChanged: (controller, progress) {
        if (!_isCurrent(controller, generation)) return;
        setState(() => _progress = progress / 100);
      },
      onReceivedError: (controller, request, error) => _mainFrameError(
        controller,
        request,
        generation,
        cancelled: error.type == WebResourceErrorType.CANCELLED,
      ),
      onReceivedHttpError: (controller, request, response) async {
        final status = response.statusCode ?? 0;
        if (status >= 400) {
          await _mainFrameError(
            controller,
            request,
            generation,
            status: status,
          );
        }
      },
      onDidReceiveServerRedirectForProvisionalNavigation: (controller) =>
          _redirected(controller, generation),
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
        if (_isCurrent(controller, generation) &&
            action.isForMainFrame == true) {
          final newPage = _navigation.request(
            uri.toString(),
            explicit:
                action.navigationType == NavigationType.LINK_ACTIVATED ||
                action.navigationType == NavigationType.FORM_SUBMITTED ||
                action.navigationType == NavigationType.BACK_FORWARD ||
                action.navigationType == NavigationType.RELOAD,
            redirect: action.isRedirect == true,
          );
          if (newPage)
            setState(() {
              _error = null;
              _progress = 0;
            });
        }
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
      onUpdateVisitedHistory: (controller, url, _) =>
          _recordLocation(controller, url, generation),
      onPermissionRequest: (_, request) async => PermissionResponse(
        resources: request.resources,
        action: PermissionResponseAction.DENY,
      ),
      onWebContentProcessDidTerminate: (controller) =>
          _processStopped(controller, generation),
      onProcessFailed: (controller, _) =>
          _processStopped(controller, generation),
      onCreateWindow: (controller, action) async => false,
    );
    return Stack(
      fit: StackFit.expand,
      children: [
        view,
        if (_error != null)
          ColoredBox(
            color: PB.bgPane,
            child: Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  _Hint(_error!),
                  TextButton(
                    onPressed: _reload,
                    child: Text(strings.t('common.retry')),
                  ),
                ],
              ),
            ),
          ),
      ],
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
