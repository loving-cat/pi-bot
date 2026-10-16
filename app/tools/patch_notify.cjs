const fs = require('fs');

// ---------- main.dart：生命周期 + 通知初始化 + 点击跳转 ----------
let m = fs.readFileSync('lib/main.dart', 'utf8');

m = m.replace(
  "import 'app_state.dart';",
  "import 'app_state.dart';\nimport 'notify.dart';",
);

m = m.replace(
  `class _PiBotAppState extends State<PiBotApp> {
  final AppState _state = AppState();

  @override
  void initState() {
    super.initState();
    _state.bootstrap().then((_) {
      if (_devUrl.isNotEmpty && _devToken.isNotEmpty && !_state.paired) {
        _state.useToken(_devUrl, _devToken, device: 'dev-shell');
      }
    });
  }`,
  `class _PiBotAppState extends State<PiBotApp> with WidgetsBindingObserver {
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
      _state.openRoom(roomId);
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
  }`,
);

m = m.replace(
  `  @override
  void dispose() {
    _state.dispose();
    super.dispose();
  }`,
  `  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _state.dispose();
    super.dispose();
  }`,
);

m = m.replace(
  "      child: MaterialApp(\n        title: 'pi-bot',",
  "      child: MaterialApp(\n        navigatorKey: _navKey,\n        title: 'pi-bot',",
);

fs.writeFileSync('lib/main.dart', m);
console.log('main.dart 已接生命周期与通知');
