import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
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

    final options = WindowOptions(
      // 注意：这里的 size 是**逻辑像素**，最终物理尺寸 = size × 系统缩放
      size: target?.size ?? const Size(1180, 760),
      minimumSize: kWindowMinSize,
      center: target == null,
      // ★ 不透明。不能用 Colors.transparent：无边框 + 每像素 alpha 的窗口，
      //   每次重绘都要走 DWM 的混合路径（每帧整窗重新合成）。界面本来就铺满
      //   bgApp，透明没有任何视觉效果，纯粹白花钱。
      backgroundColor: PB.bgApp,
      skipTaskbar: false,
      // ★ 真正去标题栏的是这个（插件会在窗口过程里处理 WM_NCCALCSIZE）
      titleBarStyle: TitleBarStyle.hidden,
      title: 'pi-bot',
    );
    await windowManager.waitUntilReadyToShow(options, () async {
      await windowManager.setAsFrameless();
      await windowManager.setHasShadow(true);
      if (target != null) await windowManager.setBounds(target);
      await windowManager.show();
      if (saved?.maximized == true) await windowManager.maximize();
      await windowManager.focus();
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
  void didChangeDependencies() {
    super.didChangeDependencies();
    final mainBot = AppScope.of(context).mainBot;
    final seed = mainBot == null
        ? PB.accent
        : parseAvatarColor(mainBot.avatarColor) ?? PB.colorFor(mainBot.id);
    if (_seedValue != seed.toARGB32()) {
      _seedValue = seed.toARGB32();
      _theme = PB.theme(seed: seed);
      _application = null;
    }
  }

  @override
  void didUpdateWidget(covariant PiBotThemedApplication oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.navigatorKey != widget.navigatorKey) _application = null;
  }

  @override
  Widget build(BuildContext context) => _application ??= MaterialApp(
    navigatorKey: widget.navigatorKey,
    title: 'pi-bot',
    debugShowCheckedModeBanner: false,
    themeMode: ThemeMode.dark,
    darkTheme: _theme,
    themeAnimationDuration: Duration.zero,
    // 各分栏占满窗口高度，角落窗口按钮独立叠加。
    builder: (context, child) => AvatarLife.watchPointer(
      child: DesktopWindowFrame(
        child: Stack(
          fit: StackFit.expand,
          children: [
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

    if (_devOpen.isNotEmpty) {
      final match = state.rooms.where(
        (r) => r.id == _devOpen || r.name == _devOpen,
      );
      if (match.isNotEmpty) return HomeShell(initialRoomId: match.first.id);
    }
    return const HomeShell();
  }
}
