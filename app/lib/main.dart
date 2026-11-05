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
    await windowManager.show();
    if (saved?.maximized == true) await windowManager.maximize();
    await windowManager.focus();

    // ★ 尺寸必须在**首帧之后**再设一次。
    //
    //   刚 show 出来的那一瞬间 Flutter 引擎还没接管窗口，此时设的尺寸会被
    //   引擎按内容布局覆盖掉 —— 实测窗口会缩成 90~200px 不等，每次都不一样，
    //   取决于当时内容算出来的固有尺寸。
    //   `flutter run` 下看不到这个问题，因为它在引擎就绪后才显示窗口；
    //   直接 `open` 正式包才会暴露。
    //
    //   等第一帧真的画完再设，引擎已经稳定，尺寸就立得住了。
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final wanted = target?.size ?? const Size(1180, 760);
      try {
        await windowManager.setMinimumSize(kWindowMinSize);
        if (target != null) {
          await windowManager.setBounds(target);
        } else {
          await windowManager.setSize(wanted);
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
