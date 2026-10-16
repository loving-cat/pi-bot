import 'dart:io';

import 'package:flutter/material.dart';
import 'package:window_manager/window_manager.dart';

import 'app_state.dart';
import 'frame_log.dart';
import 'resizing.dart';
import 'widgets/avatar_life.dart';
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

  // 【试验用】强制进入"拖动降级渲染"状态，好和正常状态做 A/B 对比
  //   $env:PI_BOT_FORCE_RESIZE='1'
  if (Platform.environment['PI_BOT_FORCE_RESIZE'] == '1') {
    appResizing.value = true;
  }

  // 桌面端：无边框窗口，控制按钮由 App 自己画在右上角
  if (WindowTitleBar.isSupported) {
    await windowManager.ensureInitialized();
    const options = WindowOptions(
      // 注意：这里的 size 是**逻辑像素**，最终物理尺寸 = size × 系统缩放
      size: Size(1180, 760),
      minimumSize: kWindowMinSize,
      center: true,
      // ★ 不透明。以前是 Colors.transparent —— 无边框 + 每像素 alpha 的窗口，
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
        // 让所有头像都能知道鼠标在哪（眼睛跟着看）。包在最外层，弹层里也生效。
        //
        // ★ 结构：`Column([标题条, 其余])`。
        //   标题条是**独立的一条**，窗口控制按钮住在它里面 ——
        //   于是下面所有的页面（包括 push 出来的路由、对话框、全屏浮层）
        //   从 y=0 起就和按钮没关系了，**任何页面都不需要"让位"**。
        //   以前按钮是浮在最上层的，谁的上边缘在窗口顶部谁就得手动避让，
        //   每加一个页面都要想一遍（设置页就被压过、聊天页还因此白推左 132px）。
        //
        //   手机上 WindowTitleBar 返回零高，这里等于没加东西。
        builder: (context, child) => AvatarLife.watchPointer(
          child: Stack(
            fit: StackFit.expand,
            children: [
              Column(
                children: [
                  const WindowTitleBar(),
                  Expanded(child: child ?? const SizedBox.shrink()),
                ],
              ),
              // ★ 缩放热区必须**浮在最上层**。
              //   它之前在标题条下面 —— 而热区的"顶边"就在 y=0..5，
              //   标题条（y=0..38）把它整个盖住了，于是向上拖只会移动窗口、
              //   没法把窗口往上拉伸（用户报的"没有向上拉伸的方法了"）。
              //   右上角那 132px 依然让开控制按钮（reserveTopRight）。
              if (WindowResizeOverlay.isSupported)
                const Positioned.fill(child: WindowResizeOverlay()),
            ],
          ),
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
    if (!state.paired)
      return isHostPlatform ? const HostConnectScreen() : const PairScreen();

    if (_devOpen.isNotEmpty) {
      final match = state.rooms.where(
        (r) => r.id == _devOpen || r.name == _devOpen,
      );
      if (match.isNotEmpty) return HomeShell(initialRoomId: match.first.id);
    }
    return const HomeShell();
  }
}
