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
  // ★ 进度用 ValueNotifier 而不是普通字段。
  //
  //   原来是 if (_progress > 0 && _progress < 1) 决定进度条插不插进 Column：
  //   加载开始/结束那一刻 Column 少一个/多一个孩子，WebView 高度会跳 **2px**。
  //   现在槽位常驻（2px 透明带），只让里面的内容跟着进度变 ——
  //   高度永远不变。
  //
  //   顺带把 onProgressChanged 的整窗 setState 也省了：
  //   只有这 2px 里的小方块重绘，WebView 不参与重建。
  //
  //   不要改成叠在 WebView 上面：macOS 上会多一层合成。
  //   常驻 2px 透明带背景是 PB.bgPane，基本看不出来。
  final _progress = ValueNotifier<double>(0);
  String? _error;
  String _currentUrl = '';
  final _navigation = BrowserNavigation();
  int _navigationRevision = 0;
  int _viewGeneration = 0;
  bool _processFailed = false;

  /// WebView 刚重建、新页面还没加载出来（用于起页遮罩）。
  ///
  /// ★ 只在 generation 变化（＝WebView 会重新创建）时置 true，
  ///   onLoadStop / onReceivedError 时清掉。平时不动它 ——
  ///   普通页面内跳转不该盖遮罩。
  bool _booting = false;
  int _initialGeneration = -1;
  int _initialRevision = -1;
  String _initialUrl = '';
  TargetPlatform get _platform => defaultTargetPlatform;

  // ★ 网页正文里的表格/文档页由服务端渲染，需要知道 App 当前是深色还是浅色。
  //
  //   主题**不进 URL**（早先试过 ?theme=light，问题一串：切换主题后不跟随、
  //   地址栏和历史里存着 UI 参数、复制出去的链接带脏参数）。
  //   改成加载时按当前主题拼一下，用户切主题就把当前页重载一次。
  PBColorMode _themeMode = pbColorMode.value;

  /// 把 theme 参数从地址里摘掉（地址栏、历史、state 里都只存干净地址）。
  ///
  /// WebView 实际加载的是拼过主题的地址，回调里拿到的是那一个 ——
  /// 不摘掉就会一层层叠上去（?theme=light&theme=dark&…）。
  String _stripTheme(String url) {
    final uri = Uri.tryParse(url);
    if (uri == null) return url;
    // ★ 只处理我们自己渲染的附件页，判断条件必须和 _themedUrl 完全一致。
    //   不带这个判断的话，用户自己访问的网站若本来就带 ?theme=xxx，
    //   会被我们无声地删掉 —— 那是网站自己的参数，不是我们的。
    if (!uri.path.endsWith('/html')) return url;
    if (!uri.queryParameters.containsKey('theme')) return url;
    final rest = Map<String, String>.from(uri.queryParameters)..remove('theme');
    return uri.replace(queryParameters: rest.isEmpty ? null : rest).toString();
  }

  /// 真正要加载的地址：把当前主题附加到我们自己的渲染页上。
  ///
  /// 只给 `/html` 结尾的地址加 —— 那是服务端渲染的附件页。
  /// 用户自己浏览的网页一律原样加载，不塞任何参数。
  String _themedUrl(String url) {
    final uri = Uri.tryParse(url);
    if (uri == null || !uri.path.endsWith('/html')) return url;
    return uri
        .replace(
          queryParameters: {
            ...uri.queryParameters,
            'theme': _themeMode == PBColorMode.light ? 'light' : 'dark',
          },
        )
        .toString();
  }

  /// 主题切换后重载当前渲染页（普通网页不动它——那是用户的内容）。
  void _onThemeChanged() {
    final next = pbColorMode.value;
    if (next == _themeMode) return;
    _themeMode = next;
    final controller = _controller;
    if (!mounted || controller == null) return;
    // 只有我们自己渲染的附件页需要重载。
    // ★ 用 uri.path.endsWith，和 _themedUrl / _stripTheme 同一个判断。
    //   contains('/html') 会把 https://example.com/html-guide 这类
    //   普通网页也当成附件页去重载。
    final uri = Uri.tryParse(_currentUrl);
    if (uri == null || !uri.path.endsWith('/html')) return;
    // ★ 必须走 _themedUrl 重新拼参数。
    //   直接传 _currentUrl 会一直重载旧的 theme 值 —— 表现为：
    //   深色切浅色后页面纹丝不动（白切深色"看起来正常"只是恰好赶上首次加载）。
    unawaited(_load(controller, _themedUrl(_currentUrl), _navigationRevision));
  }

  @override
  void initState() {
    super.initState();
    _navigationRevision = widget.state.navigationRevision;
    _currentUrl = widget.state.url;
    _address.text = _currentUrl;
    _navigation.begin(_currentUrl);
    widget.state.addListener(_onStateChanged);
    pbColorMode.addListener(_onThemeChanged);
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
    pbColorMode.removeListener(_onThemeChanged);
    _address.dispose();
    _addressFocus.dispose();
    _progress.dispose();
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
      _progress.value = 0;
      if (_processFailed) {
        _processFailed = false;
        _viewGeneration++;
      }
      final controller = _controller;
      if (state.fileRequest?.usesWebView == false) {
        _controller = null;
        _viewGeneration++;
      } else if (controller != null && _currentUrl.isNotEmpty) {
        unawaited(
          _load(controller, _themedUrl(_currentUrl), _navigationRevision),
        );
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

  /// 地址栏 / 文件名标签共用的外框。
  ///
  /// ★ 必须有它，两种模式的灰底才会完全重合。
  ///
  ///   TextField 的灰底由 InputDecoration(filled: true) 画 ——
  ///   它的高度是「字高 + contentPadding」，**不受外层 SizedBox 约束**。
  ///   外层再怎么定 30，实际画出来的填充也只有约 28，于是网页模式的灰底
  ///   比文件模式（Container 撑满 30）矮 2px、下沿上缩。
  ///
  ///   把背景交给这个 Container 画、TextField 自己透明，两边就都由
  ///   同一个 30px 的盒子决定，必然重合。
  Widget _addressShell({required Key key, required Widget child}) => Container(
    key: key,
    height: 30,
    padding: const EdgeInsets.symmetric(horizontal: 10),
    alignment: Alignment.centerLeft,
    decoration: BoxDecoration(
      color: PB.bgElevated,
      borderRadius: BorderRadius.circular(PB.rSm),
    ),
    child: child,
  );

  /// 从文件预览切到地址栏（用户想输网址）。
  ///
  /// ★ 为什么需要它：文件模式下地址栏位置显示的是文件名标签（静态、不可输入），
  ///   用户点那里没反应。以前要输网址只能先关掉文件、再从菜单开浏览器，
  ///   而菜单在文件占着栏时也没反应（见 BrowserPaneState.openEmpty）。
  void _switchToAddress() {
    widget.state.openEmpty();
    // 等这一帧布局完再抢焦点，否则 TextField 还没挂上
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _addressFocus.requestFocus();
      _address.selection = TextSelection(
        baseOffset: 0,
        extentOffset: _address.text.length,
      );
    });
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
    _progress.value = 0;
    setState(() {
      _error = null;
      if (controller == null) _viewGeneration++;
      _processFailed = false;
    });
    if (controller != null) {
      unawaited(
        _load(controller, _themedUrl(widget.state.url), _navigationRevision),
      );
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
    // ★ 记回 state 的必须是**干净地址**。
    //   WebView 实际加载的是 _themedUrl 拼过的（带 ?theme=…），
    //   原样记回去会让 _currentUrl 自己带上那个参数 ——
    //   下一次 _themedUrl 再拼就是 ?theme=light&theme=dark，
    //   服务端读第一个，切换等于永远不生效。
    widget.state.recordNavigation(_stripTheme(url.toString()));
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
    // 出错也要撤遮罩，否则错误提示会被它挡在后面
    if (_booting && mounted) setState(() => _booting = false);
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
    });
    _progress.value = 0;
  }

  Future<void> _submit(String raw) async {
    final normalized = normalizeUrl(raw);
    if (normalized == null) return;

    final state = widget.state;
    // ★ 只有「从文件 / PDF 原生预览切到网页」时才重建 WebView。
    //
    //   重建的代价很大：InAppWebView 是 incognito 的，重建会丢 cookie、
    //   登录态和前进后退历史。用户在同一会话里连输两个网址就被登出，
    //   完全不能接受。
    //
    //   网页 → 网页：保留同一个 WebView，直接 controller.loadUrl。
    //   文件 → 网页：必须重建 —— 当前 WebView 里装的是文件的渲染结果，
    //   在它上面跳转会让文件内容先露一下（用户看到"又退回资料了"）。
    final fromFile = state.kind != PaneContentKind.web || state.url.isEmpty;

    if (fromFile) {
      // 起页遮罩：只在重建 WebView 时需要。
      // 网页跳网页时旧页面一直显示到新页面提交，本来就该那样 ——
      // 加遮罩反而让用户看到一闪的转圈。
      _booting = true;
      _viewGeneration++;
      _controller = null;
      _progress.value = 0;
      state.openUrl(normalized);
      if (mounted) setState(() {});
    } else {
      // 同一个 WebView 上跳转，历史和登录态都留着。
      //
      // ★ 只调 openUrl —— 不要再手动 _load 一次。
      //   openUrl 里 notifyListeners 会**同步**触发 _onStateChanged，
      //   后者已经用现有 controller 加载过了。再手动调一次等于同一地址
      //   发两次 loadUrl：第二次取消第一次，旧请求的失败回调可能落进
      //   _mainFrameError，界面就显示"加载失败"。
      state.openUrl(normalized);
      if (mounted) setState(() {});
    }
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
          // 常驻 2px 槽位：有没有进度都占这 2px，WebView 高度不会跳
          SizedBox(
            height: 2,
            child: ValueListenableBuilder<double>(
              valueListenable: _progress,
              builder: (_, value, ___) {
                if (value <= 0 || value >= 1) return const SizedBox.shrink();
                return LinearProgressIndicator(
                  value: value,
                  minHeight: 2,
                  backgroundColor: Colors.transparent,
                  valueColor: const AlwaysStoppedAnimation(PB.success),
                );
              },
            ),
          ),
          Expanded(child: _content(state)),
        ],
      ),
    );
  }

  Widget _toolbar(BrowserPaneState state) => ColoredBox(
    // ★ 背景要盖住标题栏留白那一块（macOS 上 ChromeSafeHeader 会加一个
    //   top padding 给红绿灯让位）。原来 ChromeSafeHeader 在最外层、
    //   DecoratedBox 在里面 —— padding 区域没有任何背景，露出来的是
    //   Scaffold 的浅色底，深色主题下就是工具栏上方一条白边。
    //
    //   把背景提到最外层、padding 挪进里面，白边就没了。
    color: PB.bgPane,
    child: ChromeSafeHeader(
      child: DecoratedBox(
        decoration: BoxDecoration(
          border: Border(bottom: BorderSide(color: PB.borderTertiary)),
        ),
        child: Stack(
          children: [
            const Positioned.fill(child: WindowDragArea()),
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 6, 8, 6),
              // ★ 固定工具栏高度，不靠内容撑。
              //
              //   两种模式下内容不同（文件名标签 vs 地址输入框、按钮数量也不同），
              //   只要有一处尺寸对不齐，整条工具栏高度就会变 ——
              //   看起来就是"框体大小不一样"。写死高度后这件事不可能发生。
              //   52 = 图标按钮 40 + 上下 padding 12。
              child: SizedBox(
                height: _toolbarHeight,
                child: Row(
                  children: [
                    if (widget.showNavigationControls) ...[
                      // ★ 回到刚才那个文件。
                      //
                      //   用户在文件预览里点了地址栏想输网址、最后没输就退出，
                      //   原文件已经不在栏里了 —— 这个按钮把它找回来。
                      //
                      //   ★ 不可用时**必须占位**（透明但保留宽度）。
                      //     否则它在文件/网页模式间切换时忽隐忽现，
                      //     会把右边的地址栏整体推来推去 ——
                      //     看起来就是"输入框位置在跳"。
                      SizedBox(
                        width: _iconButtonWidth,
                        child: state.hasLastFile
                            ? _iconButton(
                                key: const ValueKey('browser-back-to-file'),
                                icon: LucideIcons.arrowLeftToLine,
                                tooltip: L10n.s(context)
                                    .t('browser.backToFile'),
                                enabled: true,
                                onTap: state.backToLastFile,
                              )
                            : const SizedBox.shrink(),
                      ),
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
                            // ★ 文件模式下这里仍然要能输网址。
                            //
                            //   原来整格是静态文件名标签，用户点它完全没反应 ——
                            //   "先打开文件就再也输不了网址"就是这么来的。
                            //   现在：标签本身可点（切到地址栏），右侧再放一个
                            //   明确的网址按钮，两条路都能进。
                            ? _addressShell(
                                key: const ValueKey('browser-file-label'),
                                child: Row(
                                  children: [
                                    Icon(
                                      LucideIcons.fileText,
                                      size: 14,
                                      color: PB.textTertiary,
                                    ),
                                    const SizedBox(width: 6),
                                    Expanded(
                                      child: GestureDetector(
                                        behavior: HitTestBehavior.opaque,
                                        onTap: _switchToAddress,
                                        child: Text(
                                          state.fileName
                                              .split('/')
                                              .last
                                              .split(r'\')
                                              .last,
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                          style: TextStyle(
                                            fontSize: PB.fsXs,
                                            color: PB.textSecondary,
                                            fontFamily: PB.monoFamily,
                                          ),
                                        ),
                                      ),
                                    ),
                                    const SizedBox(width: 4),
                                    // ★ 宽度必须写死成和工具栏其它图标按钮一致。
                                    //   M3 的 tapTargetSize 会把任何 minWidth 撑到 40 ——
                                    //   这里原写 minWidth: 24，实际还是 40，
                                    //   于是文件模式的标签内部比网页模式的输入框"胖"一块，
                                    //   两者的可见边缘对不上。显式 shrinkWrap 才是真 24。
                                    IconButton(
                                      key: const ValueKey(
                                        'browser-switch-to-address',
                                      ),
                                      icon: const Icon(
                                        LucideIcons.globe,
                                        size: 13,
                                      ),
                                      padding: EdgeInsets.zero,
                                      visualDensity: VisualDensity.compact,
                                      style: const ButtonStyle(
                                        tapTargetSize:
                                            MaterialTapTargetSize.shrinkWrap,
                                      ),
                                      constraints:
                                          const BoxConstraints.tightFor(
                                            width: 24,
                                            height: 24,
                                          ),
                                      tooltip: L10n.s(context)
                                          .t('browser.addressHint'),
                                      onPressed: _switchToAddress,
                                    ),
                                  ],
                                ),
                              )
                            : _addressShell(
                                // 灰底由外框画，TextField 只负责输入本身 ——
                                // 这样两种模式的灰底一定是同一个 30px 的盒子。
                                key: const ValueKey('browser-address-shell'),
                                child: TextField(
                                  key: const ValueKey('browser-address'),
                                  controller: _address,
                                  focusNode: _addressFocus,
                                  style: TextStyle(
                                    fontSize: PB.fsXs,
                                    color: PB.textSecondary,
                                    fontFamily: PB.monoFamily,
                                  ),
                                  // ★ 背景和圆角都由外框画，这里只要透明。
                                  //
                                  //   垂直居中主要靠外框的 alignment: centerLeft ——
                                  //   外框已经把这个 TextField 摆在 30px 盒子的竖直中间。
                                  //   这里用 isDense 只是个人偏好（让 InputDecorator
                                  //   内部留白更紧凑，不额外撑高），换 isCollapsed 也能居中。
                                  decoration: InputDecoration(
                                    isDense: true,
                                    filled: false,
                                    border: InputBorder.none,
                                    enabledBorder: InputBorder.none,
                                    focusedBorder: InputBorder.none,
                                    // 上下对称 → 内容在框内垂直居中
                                    contentPadding: const EdgeInsets.symmetric(
                                      vertical: 6,
                                    ),
                                    hintText: L10n.s(context)
                                        .t('browser.addressHint'),
                                    hintStyle: TextStyle(
                                      fontSize: PB.fsXs,
                                      color: PB.textQuaternary,
                                    ),
                                  ),
                                  textAlignVertical: TextAlignVertical.center,
                                  textInputAction: TextInputAction.go,
                                  onSubmitted: _submit,
                                  onTap: () => state.touch(),
                                ),
                              ),
                      ),
                    ),
                    const SizedBox(width: 4),
                    ...widget.toolbarActions,
                    // ★ 右侧宽度必须两种模式一致，否则切模式时地址栏被挤动。
                    //
                    //   实测：附件按钮是 28px（它显式设了 tapTargetSize.shrinkWrap），
                    //   工具栏按钮是 40px（M3 默认会把 28 撑到 40）—— 两者不一样，
                    //   所以不能互相套用。文件模式 = 下载 + 打开 = 56；网页模式也占 56。
                    if (state.fileRequest case final request?)
                      SizedBox(
                        width: _attachmentButtonWidth * 2,
                        child: AttachmentActionButtons(request: request),
                      )
                    else
                      SizedBox(
                        width: _attachmentButtonWidth * 2,
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            // 网页没有"下载原文件"的对象，留空占位
                            const SizedBox(
                              width: _attachmentButtonWidth,
                              height: _attachmentButtonWidth,
                            ),
                            // 外部打开用和附件按钮同样的尺寸，好对齐
                            _attachmentStyleButton(
                              key: const ValueKey('browser-open-external'),
                              icon: LucideIcons.externalLink,
                              tooltip: L10n.s(context)
                                  .t('browser.openExternal'),
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
                          ],
                        ),
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
            ),
          ],
        ),
      ),
    ),
  );

  /// 工具栏行高：写死，不靠内容撑。
  ///
  /// ★ 两种模式的内容不一样（文件名标签 vs 地址输入框、按钮数量也不同）。
  ///   只要有一处尺寸对不齐，整条工具栏高度就会变，看起来像"框体一大一小"。
  ///   52 = 图标按钮实测 40 + 上下 padding 各 6。
  ///
  /// ★ 值是 40 而不是 52：这个 SizedBox 在 Padding(上下各 6) 里面，
  ///   成品高度是 40 + 12 = 52，正好和聊天栏标题栏对齐。
  ///   写成 52 的话总高变 64，比标题栏高一截。
  static const double _toolbarHeight = 40;

  /// 工具栏图标按钮的**实际渲染宽度**。
  ///
  /// ★ 不是 28（那是 constraints.minWidth）—— M3 的 tapTargetSize 会把
  ///   它撑到 40，实测 getSize 就是 40×40。占位必须用真实值，
  ///   否则按钮显隐时地址栏仍会挪 12px。
  static const double _iconButtonWidth = 40;

  /// 附件动作按钮（下载/打开）的宽度：28。
  /// 它显式设了 tapTargetSize.shrinkWrap，不会被撑到 40。
  static const double _attachmentButtonWidth = 28;

  /// 和 AttachmentActionButtons 内部同样式的小图标按钮。
  /// 网页模式的「外部打开」用它，尺寸才能和文件模式那两个按钮对齐。
  Widget _attachmentStyleButton({
    required Key key,
    required IconData icon,
    required String tooltip,
    required bool enabled,
    required VoidCallback onTap,
  }) => IconButton(
    key: key,
    tooltip: tooltip,
    visualDensity: VisualDensity.compact,
    constraints: const BoxConstraints.tightFor(width: 28, height: 28),
    style: const ButtonStyle(tapTargetSize: MaterialTapTargetSize.shrinkWrap),
    padding: const EdgeInsets.all(6),
    icon: Icon(icon, size: 16),
    color: enabled ? PB.textTertiary : PB.textQuaternary,
    onPressed: enabled ? onTap : null,
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
      initialUrlRequest: URLRequest(url: WebUri(_themedUrl(_initialUrl))),
      initialSettings: browserPaneSettings(_platform),
      onWebViewCreated: (controller) {
        if (!mounted || generation != _viewGeneration) return;
        _controller = controller;
        if (_navigationRevision != initialRevision &&
            widget.state.url.isNotEmpty) {
          unawaited(
            _load(
              controller,
              _themedUrl(widget.state.url),
              _navigationRevision,
            ),
          );
        }
      },
      onLoadStart: (controller, url) {
        if (!_isCurrent(controller, generation) ||
            !_navigation.started(url?.toString()))
          return;
        // 只更新进度，不 setState —— 进度条有自己的 ValueListenableBuilder,
        // 没必要连带整个 BrowserPane（含 WebView）重建
        _progress.value = 0;
        state.touch();
      },
      onLoadStop: (controller, url) async {
        // ★ 必须先确认这是**当前**这一代的 WebView 回调。
        //
        //   重建 WebView 时旧实例还会把 onLoadStop 抛出来 ——
        //   在判断之前撤遮罩，旧实例会把新页面刚盖上的遮罩提前撤掉，
        //   用户又看到一闪的旧内容。
        if (!_isCurrent(controller, generation)) return;
        if (_booting && mounted) setState(() => _booting = false);
        final epoch = _navigation.epoch;
        if (url == null ||
            !await _acceptActualLocation(
              controller,
              url.toString(),
              generation,
              epoch,
            ))
          return;
        _progress.value = 1;
        _navigation.finished(url.toString(), epoch);
        await _recordLocation(controller, url, generation);
      },
      onProgressChanged: (controller, progress) {
        if (!_isCurrent(controller, generation)) return;
        _progress.value = progress / 100;
        // ★ 只要开始渲染内容就撤遮罩，不等 onLoadStop。
        //
        //   onLoadStop 要等所有子资源（图片、字体、第三方脚本）都完成，
        //   慢站上能拖好几秒 —— 那段时间用户盯着"正在加载…"，
        //   而页面其实早就可见了。进度一过 1% 就说明已经在画了。
        if (_booting && progress > 0 && mounted) {
          setState(() => _booting = false);
        }
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
          if (newPage) {
            _progress.value = 0;
            setState(() {
              _error = null;
            });
          }
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
        // ★ 起页遮罩：WebView 重建期间盖住空白。
        //
        //   只有「从文件 / PDF 预览切到网页」时才会重建 WebView（见 _submit），
        //   重建那一瞬间它是空的 —— 不加遮罩用户会看到一片纯色，
        //   像页面坏了。这里显示一句轻提示，和 2px 进度条配合说明"在加载"。
        //
        //   网页跳网页不走重建，旧页面一直显示到新页面提交，不盖遮罩。
        //
        //   置位：_submit 的 fromFile 分支；
        //   撤销：onProgressChanged 里 progress > 0（页面开始画了），
        //        或 onLoadStop / 出错时兜底清掉。
        if (_booting && _error == null)
          ColoredBox(
            color: PB.bgPane,
            child: Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: PB.textTertiary,
                    ),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    strings.t('browser.loading'),
                    style: TextStyle(
                      fontSize: PB.fsXs,
                      color: PB.textQuaternary,
                    ),
                  ),
                ],
              ),
            ),
          ),
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
      style: TextStyle(
        fontSize: PB.fsXs,
        color: PB.textQuaternary,
        height: 1.6,
      ),
    ),
  );
}
