import 'package:flutter/material.dart';
import 'package:window_manager/window_manager.dart';

import 'app_state.dart';
import 'frame_log.dart';
import 'notify.dart';
import 'scope.dart';
import 'screens/pair_screen.dart';
import 'platform.dart';
import 'widgets/window_title_bar.dart';
import 'screens/home_shell.dart';
import 'screens/host_connect_screen.dart';
import 'theme.dart';

/// 开发用：`--dart-define=PI_BOT_URL=http://127.0.0.1:8787 --dart-define=PI_BOT_TOKEN=test-token`
/// 再配合 `--dart-define=PI_BOT_OPEN=main` 直接进某个群（截图 / 调 UI 用）。
const _devUrl = String.fromEnvironment('PI_BOT_URL');
const _devToken = String.fromEnvironment('PI_BOT_TOKEN');
const _devOpen = String.fromEnvironment('PI_BOT_OPEN');

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // 帧耗时采样（只有带了 PI_BOT_FRAME_LOG 环境变量才工作，平时零开销）
  FrameLog.start();

  // 桌面端：无边框窗口（像 同类客户端 那样），控制按钮由 App 自己画在右上角
  if (WindowTitleBar.isSupported) {
    await windowManager.ensureInitialized();
    const options = WindowOptions(
      // 注意：这里的 size 是**逻辑像素**，最终物理尺寸 = size × 系统缩放
      size: Size(1180, 760),
      minimumSize: Size(760, 520),
      center: true,
      backgroundColor: Colors.transparent,
      skipTaskbar: false,
      // ★ 真正去标题栏的是这个（插件会在窗口过程里处理 WM_NCCALCSIZE）
      titleBarStyle: TitleBarStyle.hidden,
      title: 'pi-bot',
    );
    await windowManager.waitUntilReadyToShow(options, () async {
      await windowManager.setAsFrameless();
      await windowManager.setHasShadow(true);
      await windowManager.show();
      await windowManager.focus();
    });
  }

  runApp(const PiBotApp());
}

class PiBotApp extends StatefulWidget {
  const PiBotApp({super.key});

  @override
  State<PiBotApp> createState() => _PiBotAppState();
}

class _PiBotAppState extends State<PiBotApp> with WidgetsBindingObserver {
  final AppState _state = AppState();
  final GlobalKey<NavigatorState> _navKey = GlobalKey<NavigatorState>();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
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
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // 不在前台才弹通知
    _state.foreground = state == AppLifecycleState.resumed;
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _state.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AppScope(
      state: _state,
      child: MaterialApp(
        navigatorKey: _navKey,
        title: 'pi-bot',
        debugShowCheckedModeBanner: false,
        themeMode: ThemeMode.dark,
        darkTheme: PB.theme(),
        // 无边框窗口：控制按钮和八向缩放热区铺在最上层。
        // 放根上而不是 HomeShell 里 —— 配对页 / 连不上服务端那页也要能关窗口、能缩放。
        // 顺序要紧：后面的先命中，所以窗口按钮压住缩放热区（右上角那个角别抢"关闭"）。
        builder: (context, child) => Stack(
          fit: StackFit.expand,
          children: [
            if (child != null) child,
            if (WindowResizeOverlay.isSupported)
              const Positioned.fill(child: WindowResizeOverlay()),
            if (WindowControlsOverlay.isSupported)
              const Positioned(
                top: 0,
                right: 0,
                child: WindowControlsOverlay(),
              ),
          ],
        ),
        home: const _Root(),
      ),
    );
  }
}

class _Root extends StatelessWidget {
  const _Root();

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    if (!state.ready) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    // 桌面端是宿主：永远不显示手机那套配对界面，连不上就显示「怎么起服务端」
    if (!state.paired) return isHostPlatform ? const HostConnectScreen() : const PairScreen();

    if (_devOpen.isNotEmpty) {
      final match = state.rooms.where(
        (r) => r.id == _devOpen || r.name == _devOpen,
      );
      if (match.isNotEmpty) return HomeShell(initialRoomId: match.first.id);
    }
    return const HomeShell();
  }
}
