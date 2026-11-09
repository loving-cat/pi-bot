import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:screen_retriever/screen_retriever.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:window_manager/window_manager.dart';

import 'app_log.dart';
import 'app_state.dart';
import 'avatar_appearance.dart';
import 'models.dart';
import 'frame_log.dart';
import 'widgets/avatar_life.dart';
import 'notify.dart';
import 'scope.dart';
import 'screens/pair_screen.dart';
import 'platform.dart';
import 'widgets/desktop_window_frame.dart';
import 'widgets/window_resize_overlay.dart';
import 'window_chrome.dart';
import 'screens/home_shell.dart';
import 'screens/host_connect_screen.dart';
import 'theme.dart';
import 'widgets/toast.dart';
import 'update_info.dart';
import 'widgets/update_prompt.dart';
import 'l10n/l10n.dart';
import 'widgets/model_setup_gate.dart';
import 'window_state.dart';

/// 开发用：`--dart-define=PI_BOT_URL=http://127.0.0.1:8787 --dart-define=PI_BOT_TOKEN=test-token`
/// 再配合 `--dart-define=PI_BOT_OPEN=main` 直接进某个群（截图 / 调 UI 用）。
const _devUrl = String.fromEnvironment('PI_BOT_URL');
const _devToken = String.fromEnvironment('PI_BOT_TOKEN');
const _devOpen = String.fromEnvironment('PI_BOT_OPEN');

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // 界面层的错误也要留档，和服务端的 server.log 对应
  installAppErrorLogging();

  // 帧耗时采样（只有带了 PI_BOT_FRAME_LOG 环境变量才工作，平时零开销）
  FrameLog.start();

  // 桌面窗口控制由应用绘制，窗口动作仍交给操作系统。
  if (DesktopWindowFrame.isSupported) {
    await windowManager.ensureInitialized();

    // 上次的窗口位置/大小（外接屏拔掉、分辨率变了会自动夹回可见区域）
    final prefs = await SharedPreferences.getInstance();
    final saved = decodeWindowBounds(prefs.getString(_kWindowBounds));
    Rect? target;
    if (saved != null) {
      try {
        final display = await screenRetriever.getPrimaryDisplay();
        final pos = display.visiblePosition;
        final size = display.visibleSize ?? display.size;
        target = clampWindowRect(
          saved.rect,
          Rect.fromLTWH(pos?.dx ?? 0, pos?.dy ?? 0, size.width, size.height),
        );
      } catch (_) {
        target = saved.rect;
      }
    }

    // ★ 不要用 waitUntilReadyToShow(options, callback)。
    //
    //   它在 macOS 上是**空实现**（插件源码里方法体就一句注释 nothing），
    //   传进去的回调根本不会执行，setAsFrameless / setBounds / show 从来没跑过。
    //   更麻烦的是：窗口刚 show 出来时引擎还没接管，此时设的尺寸会被
    //   按内容布局覆盖，窗口缩成 90~200px（每次都不一样），几乎看不见。
    //   所以要先把窗口显示出来，再在首帧之后强制设一次尺寸（见下面的回调）。
    await windowManager.setAsFrameless();
    await windowManager.setHasShadow(true);
    // 窗口底色跟随明暗（切换时会在 _onColorModeChanged 里再更新）
    await windowManager.setBackgroundColor(PB.bgApp);
    await windowManager.show();
    if (saved?.maximized == true) await windowManager.maximize();
    await windowManager.focus();

    // ★ 尺寸只需在**首帧之后**设一次，别反复设。
    //
    //   为什么必须在首帧之后：刚 show 出来那一瞬间引擎还没接管窗口，
    //   此时设的尺寸会被它按内容布局覆盖掉 —— 实测会缩成一百多像素。
    //   `flutter run` 下看不到这个问题（它在引擎就绪后才显示窗口），
    //   只有直接 `open` 正式包才会暴露。
    //
    //   为什么不能反复设：试过循环监测、不对就重设 setBounds，
    //   结果更糟 —— 窗口 frame 确实是 1181x756，但渲染表面被压到 130x130，
    //   整个界面完整地缩小成一团（截图确认过内容本身没问题）。
    //   反复改窗口尺寸会让引擎的渲染缓冲区跟不上窗口本身。
    //
    //   结论：设一次，然后交给引擎自己 layout。
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      try {
        await windowManager.setMinimumSize(kWindowMinSize);
        if (target != null) {
          await windowManager.setBounds(target);
        } else {
          await windowManager.setSize(const Size(1180, 760));
          await windowManager.center();
        }
      } catch (_) {
        // 窗口已经关掉之类的情况，忽略
      }
    });

    // 记住窗口：拖动/缩放结束后（400ms 空闲）写一次，最大化状态单独记
    final saver = _WindowSaver(prefs);
    windowManager.addListener(saver);
  }

  runApp(const PiBotApp());
}

const _kWindowBounds = 'window_bounds';

/// 把窗口位置/大小写进 prefs（防抖 400ms，拖动过程中不写盘）
class _WindowSaver with WindowListener {
  _WindowSaver(this.prefs);

  final SharedPreferences prefs;
  Timer? _timer;

  void _schedule() {
    _timer?.cancel();
    _timer = Timer(const Duration(milliseconds: 400), _save);
  }

  Future<void> _save() async {
    try {
      if (await windowManager.isFullScreen()) return;
      final bounds = await windowManager.getBounds();
      // ★ 不存明显不合理的尺寸。
      //
      //   启动期引擎可能把窗口压到 130x133 这种大小，这时如果顺手存下来，
      //   下次启动就会读到一个坏值，越用越小、再也回不到正常尺寸。
      //   宁可保留上一次的好值，也不要存一个用户不可能想要的尺寸。
      if (bounds.width < kWindowMinSize.width ||
          bounds.height < kWindowMinSize.height) {
        return;
      }
      final maxed = await windowManager.isMaximized();
      await prefs.setString(
        _kWindowBounds,
        encodeWindowBounds(WindowBounds(rect: bounds, maximized: maxed)),
      );
    } catch (_) {}
  }

  @override
  void onWindowResize() => _schedule();
  @override
  void onWindowMove() => _schedule();
  @override
  void onWindowMaximize() => _schedule();
  @override
  void onWindowUnmaximize() => _schedule();
  @override
  void onWindowEnterFullScreen() => _timer?.cancel();
  @override
  void onWindowLeaveFullScreen() => _schedule();
  @override
  void onWindowClose() {
    _timer?.cancel();
    _save();
  }
}

class PiBotApp extends StatefulWidget {
  const PiBotApp({super.key});

  @override
  State<PiBotApp> createState() => _PiBotAppState();
}

class _PiBotAppState extends State<PiBotApp> with WidgetsBindingObserver {
  final AppState _state = AppState();
  final GlobalKey<NavigatorState> _navKey = GlobalKey<NavigatorState>();

  /// 语言在启动前就要定下来：默认中文，读到用户偏好再覆盖。
  final LocaleController _locale = LocaleController();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _loadLocale();
    // 明暗偏好要在第一帧之前读回来，否则会先闪一下深色再变浅
    loadColorMode();
    Notifier.init();
    // 点通知 → 直接进那个会话
    Notifier.onTap = (roomId) {
      if (roomId == null) return;
      final ctx = _navKey.currentContext;
      // 还没挂载就先记着，HomeShell 一上来会消费掉
      if (ctx == null) {
        _state.requestRoom(roomId);
      } else {
        requestRoom(ctx, roomId);
      }
    };
    _state.bootstrap().then((_) {
      if (_devUrl.isNotEmpty && _devToken.isNotEmpty && !_state.paired) {
        _state.useToken(_devUrl, _devToken, device: 'dev-shell');
      }
      // 启动完成后查一次更新并提示。延后几秒：让界面先画出来，
      // 别让"连服务器 / 拉状态"和检查更新挤在一起。
      Future<void>.delayed(const Duration(seconds: 4), _maybePromptUpdate);
    });
  }

  /// 查到新版本就问用户要不要下载。
  ///
  /// 静默条件（不打扰）：
  ///   · 检查本身失败 / 没有新版本；
  ///   · 用户已经对这个版本点过"以后再说"（出了更新的版本才会再问）。
  Future<void> _maybePromptUpdate() async {
    if (!mounted) return;
    final info = await _state.checkUpdate();
    if (!mounted || info == null) return;
    if (!shouldPromptUpdate(info, _state.skippedUpdateVersion)) return;

    final choice = await showUpdateDialog(context, info);
    if (!mounted) return;

    switch (choice) {
      case UpdateChoice.later:
        await _state.skipUpdateVersion(info.latest);
      case UpdateChoice.openPage:
        if (info.pageUrl.isNotEmpty) {
          try {
            await Process.run(Platform.isWindows ? 'explorer' : 'open', [
              info.pageUrl,
            ]);
          } catch (_) {}
        }
      case UpdateChoice.download:
        final result = await downloadUpdate(context, info);
        if (!mounted) return;
        if (result.ok) {
          await showDownloadDoneDialog(context, path: result.path!, info: info);
        } else if (result.error != null && result.error != '已取消') {
          toast(context, '下载失败：${result.error}');
        }
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // 不在前台才弹通知
    _state.foreground = state == AppLifecycleState.resumed;
  }

  /// 语言偏好异步读盘；读到就刷新，界面短暂保持中文不会闪。
  Future<void> _loadLocale() async {
    final loaded = await LocaleController.load();
    if (!mounted) return;
    if (loaded.language != _locale.language) {
      await _locale.setLanguage(loaded.language);
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _locale.dispose();
    _state.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return L10n(
      controller: _locale,
      child: AppScope(
        state: _state,
        child: PiBotThemedApplication(navigatorKey: _navKey),
      ),
    );
  }
}

/// 主控颜色变化时替换主题；流式通知继续复用应用和导航实例。
class PiBotThemedApplication extends StatefulWidget {
  const PiBotThemedApplication({super.key, required this.navigatorKey});

  final GlobalKey<NavigatorState> navigatorKey;

  @override
  State<PiBotThemedApplication> createState() => _PiBotThemedApplicationState();
}

class _PiBotThemedApplicationState extends State<PiBotThemedApplication> {
  int? _seedValue;
  late ThemeData _theme;
  Widget? _application;

  @override
  void initState() {
    super.initState();
    // 明暗切换时重建主题。
    //
    // 颜色是全局 PB.xxx getter 读的，理论上不重建也能拿到新值；
    // 但 MaterialApp 的 ThemeData 是缓存的，里面还压着一份 colorScheme
    // 和文字样式（输入框、按钮那些组件用的是它）。不重建的话，
    // 聊天区变了色、输入框和按钮却还是旧的。
    pbColorMode.addListener(_onColorModeChanged);
  }

  @override
  void dispose() {
    pbColorMode.removeListener(_onColorModeChanged);
    super.dispose();
  }

  void _onColorModeChanged() {
    if (!mounted) return;
    // ★ 窗口本体也要换底色。
    //
    //   界面内容之间是有缝隙的（分栏之间的拖拽条、圆角外沿等），
    //   那些地方透出来的是 **macOS 窗口自己的背景色**，不是 Flutter 画的。
    //   只换 Flutter 主题的话，切到浅色后这些缝里还是黑的 ——
    //   表现就是侧栏和聊天区之间夹着一条深色竖条，怎么切都不掉。
    windowManager.setBackgroundColor(PB.bgApp);
    setState(() {
      _theme = PB.theme(seed: _currentSeed(), light: isLightMode);
      // 丢掉缓存的 MaterialApp 实例，强制重建。
      //
      // 只换 _theme 不够：MaterialApp 会把 ThemeData 通过 InheritedWidget
      // 往下传，而很多子组件（分割线、输入框、按钮）是在
      // Theme.of(context) 里取的。若实例被复用，那层 Inherited 可能
      // 认为"没变"而不通知子树，表现就是切换后个别控件仍是旧色。
      _application = null;
    });
  }

  Color _currentSeed() {
    final mainBot = AppScope.of(context).mainBot;
    return mainBot == null
        ? PB.accent
        : parseAvatarColor(mainBot.avatarColor) ?? PB.colorFor(mainBot.id);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final seed = _currentSeed();
    if (_seedValue != seed.toARGB32()) {
      _seedValue = seed.toARGB32();
      _theme = PB.theme(seed: seed, light: isLightMode);
      _application = null;
    }
  }

  @override
  void didUpdateWidget(covariant PiBotThemedApplication oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.navigatorKey != widget.navigatorKey) _application = null;
  }

  /// 上一次构建时用的语言。变了就把缓存的 MaterialApp 丢掉重建。
  ///
  /// _application 是缓存的（??=），不重建的话切换语言后
  /// 框架文案（返回按钮等）会停在旧语言，而我们自己的文案已经换了 ——
  /// 界面半中半英。
  String? _lastLocaleCode;

  /// 框架文案跟随应用自己的语言设置（不是系统语言）。
  ///
  /// 用户在设置里选了中文，返回按钮的 tooltip 就该是「返回」，
  /// 不能因为系统是英文就跟着变英文 —— 那是两套不同的设置。
  Locale _appLocale(BuildContext context) {
    final controller = L10n.maybeControllerOf(context);
    return controller?.language == AppLanguage.en
        ? const Locale('en')
        : const Locale('zh');
  }

  @override
  Widget build(BuildContext context) {
    // 语言变了必须重建 MaterialApp，否则框架文案停在旧语言
    final locale = _appLocale(context);
    if (_lastLocaleCode != locale.languageCode) {
      _lastLocaleCode = locale.languageCode;
      _application = null;
    }
    return _application ??= _buildApplication(locale);
  }

  Widget _buildApplication(Locale locale) => MaterialApp(
    navigatorKey: widget.navigatorKey,
    title: 'pi-bot',
    debugShowCheckedModeBanner: false,
    // ★ 框架内置组件的文案全靠这些 delegate 本地化。
    //
    //   不配的话，Flutter 只认英文：AppBar 自动生成的返回按钮
    //   tooltip 会一直是 "Back"，关闭按钮是 "Close" ——
    //   即使我们自己的界面全是中文。用户看到的就是一个中文 App 里
    //   突然蹦出几个英文单词。
    //
    //   locale 跟着我们自己的语言设置走，不要用系统语言：
    //   用户在设置里选了中文，框架文案也得跟着中文。
    locale: locale,
    supportedLocales: const [Locale('zh'), Locale('en')],
    localizationsDelegates: const [
      GlobalMaterialLocalizations.delegate,
      GlobalWidgetsLocalizations.delegate,
      GlobalCupertinoLocalizations.delegate,
    ],
    // ★ 关掉桌面端默认自动绘制的滚动条。
    //
    //   MaterialScrollBehavior 在桌面平台会给每个可滚动组件包一层
    //   滚动条。聊天区在流式输出时内容高度每几十毫秒变一次，
    //   滑块要跟着重算尺寸和位置 —— 快速滑动时就是明显的抽搐。
    //   这不是某个 Scrollbar 组件的配置问题，而是框架默认行为。
    //   滚轮/触控板滚动完全不受影响，只是不再画那个滑块。
    scrollBehavior: const _NoScrollbarBehavior(),
    // ★ themeMode 必须跟着当前模式走。
    //
    //   原来写死 ThemeMode.dark，于是即使 _theme 已经按浅色算好，
    //   MaterialApp 也只会去取 darkTheme —— 切换看起来"没反应"。
    //   现在两套都指向同一个 _theme（它自己含明暗），选哪套都一样，
    //   但 themeMode 要给出正确的值，组件才会走对应的默认分支配色。
    themeMode: isLightMode ? ThemeMode.light : ThemeMode.dark,
    theme: _theme,
    darkTheme: _theme,
    themeAnimationDuration: Duration.zero,
    // 各分栏占满窗口高度，角落窗口按钮独立叠加。
    builder: (context, child) => AvatarLife.watchPointer(
      child: DesktopWindowFrame(
        // ★ 整个内容树跟着明暗模式重建。
        //
        //   只重建 MaterialApp 不够：它下面的页面（侧栏、聊天页、右侧面板）
        //   是由 Navigator 持有、并且用 const 构造的，Flutter 认为
        //   "widget 实例没变"就跳过重建 —— 于是切换后有的栏变了、有的没变，
        //   界面处于半新半旧的错乱状态。
        //
        //   这里用 ValueListenableBuilder 把 pbColorMode 作为 key 的一部分，
        //   模式一变整棵子树换新实例。代价是页面状态（滚动位置等）会重置，
        //   但明暗切换本来就该是一次完整的重绘，重置是符合预期的。
        child: ValueListenableBuilder<PBColorMode>(
          valueListenable: pbColorMode,
          builder: (context, mode, inner) => KeyedSubtree(
            key: ValueKey('theme-${mode.name}'),
            child: inner!,
          ),
          child: Stack(
          fit: StackFit.expand,
          children: [
            // 铺一层不透明底色，别让缝隙透出窗口本体
            //（分栏间的拖拽条、圆角外沿会露缝，透出来的是 macOS 窗口背景）。
            ColoredBox(color: PB.bgApp),
            child ?? const SizedBox.shrink(),
            if (WindowResizeOverlay.isSupported)
              const Positioned.fill(
                child: WindowResizeOverlay(
                  reserveTopRight: windowChromeControlsReserve,
                ),
              ),
          ],
          ),
        ),
      ),
    ),
    home: const _Root(),
  );
}

class _Root extends StatelessWidget {
  const _Root();

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    if (!state.ready) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    // 桌面端是宿主：永远不显示手机那套配对界面。
    //
    // ★ "本机服务端" 这条路要有三个状态：
    //   不能只要 localMode 就当已连上（paired 为 true）直接进主界面 ——
    //   服务端还没起时用户看到的是骨架屏 + "离线 · 自动重连中"，永远等不到东西。
    //   起服务端期间 / 一个房间都还没拿到时，
    //   先给"正在启动 / 为什么起不来"那一页（它会自己重试，也会把服务端拉起来）。
    if (isHostPlatform) {
      final stillBooting =
          state.serverStarting ||
          !state.paired ||
          (state.localMode &&
              state.link != LinkState.online &&
              state.rooms.isEmpty);
      if (stillBooting) return const HostConnectScreen();
    }
    if (!state.paired) return const PairScreen();

    // ★ 没有任何模型组时先挡一下。
    //
    //   没有模型时 bot 收到消息只会静默失败 —— 用户看到的是"它不理我"，
    //   而不是"我还没配模型"。与其让人去猜，不如在进主界面前讲清楚并给出入口。
    //   用户可以点"稍后再说"跳过，不强制。
    if (state.needsModelSetup) return const ModelSetupGate();

    if (_devOpen.isNotEmpty) {
      final match = state.rooms.where(
        (r) => r.id == _devOpen || r.name == _devOpen,
      );
      if (match.isNotEmpty) return HomeShell(initialRoomId: match.first.id);
    }
    return const HomeShell();
  }
}

/// 桌面端不画滚动条（滚动本身照常可用）。
///
/// 为什么需要：MaterialScrollBehavior 在桌面平台会自动给可滚动组件
/// 套一层 Scrollbar。聊天内容在流式输出时高度高频变化，
/// 滑块跟着反复重算 —— 观感就是"抽搐"。关掉它最直接。
class _NoScrollbarBehavior extends MaterialScrollBehavior {
  const _NoScrollbarBehavior();

  @override
  Widget buildScrollbar(BuildContext context, Widget child, ScrollableDetails details) {
    // 直接返回内容，不套 Scrollbar
    return child;
  }
}
