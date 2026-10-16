const fs = require('fs');

// ---------- main.dart：初始化无边框窗口 ----------
let m = fs.readFileSync('lib/main.dart', 'utf8');

m = m.replace(
  "import 'package:flutter/material.dart';",
  "import 'package:flutter/material.dart';\nimport 'package:window_manager/window_manager.dart';",
);
m = m.replace(
  "import 'platform.dart';",
  "import 'platform.dart';\nimport 'widgets/window_title_bar.dart';",
);
m = m.replace(
  "void main() {\n  runApp(const PiBotApp());\n}",
  [
    "Future<void> main() async {",
    "  WidgetsFlutterBinding.ensureInitialized();",
    "",
    "  // 桌面端：无边框窗口（像 同类客户端 那样），控制按钮由 App 自己画在右上角",
    "  if (WindowTitleBar.isSupported) {",
    "    await windowManager.ensureInitialized();",
    "    const options = WindowOptions(",
    "      size: Size(1180, 760),",
    "      minimumSize: Size(760, 520),",
    "      center: true,",
    "      backgroundColor: Colors.transparent,",
    "      skipTaskbar: false,",
    "      titleBarStyle: TitleBarStyle.hidden,",
    "      title: 'pi-bot',",
    "    );",
    "    await windowManager.waitUntilReadyToShow(options, () async {",
    "      await windowManager.setAsFrameless();",
    "      await windowManager.setHasShadow(true);",
    "      await windowManager.show();",
    "      await windowManager.focus();",
    "    });",
    "  }",
    "",
    "  runApp(const PiBotApp());",
    "}",
  ].join('\n'),
);

// MaterialApp 去掉 debug banner 已存在；加 scrollBehavior 让桌面能拖拽滚动
m = m.replace(
  "        navigatorKey: _navKey,\n        title: 'pi-bot',",
  "        navigatorKey: _navKey,\n        title: 'pi-bot',",
);

fs.writeFileSync('lib/main.dart', m);
console.log('main.dart: window_manager 初始化完成');

// ---------- home_shell：顶部加自定义标题栏 ----------
let h = fs.readFileSync('lib/screens/home_shell.dart', 'utf8');
h = h.replace(
  "import '../theme.dart';",
  "import '../theme.dart';\nimport '../widgets/window_title_bar.dart';",
);
h = h.replace(
  "    return Scaffold(\n      backgroundColor: PB.bgApp,\n      body: Row(",
  "    return Scaffold(\n      backgroundColor: PB.bgApp,\n      body: Column(\n        children: [\n          // 无边框窗口的拖拽条 + 右上角控制按钮\n          const WindowTitleBar(),\n          Expanded(\n            child: Row(",
);
fs.writeFileSync('lib/screens/home_shell.dart', h);
console.log('home_shell: 标题栏已插入（还需补收尾括号）');
