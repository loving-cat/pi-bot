import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/screens/host_connect_screen.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/server/launcher.dart';
import 'package:pi_bot/server/options.dart';
import 'package:pi_bot/widgets/server_config_section.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _Launcher extends LocalServerLauncher {
  _Launcher(Directory directory) : super(stateDir: directory);

  bool failToStop = false;
  int starts = 0;

  @override
  Future<void> stop() async {
    if (failToStop) throw StateError('进程仍在运行');
  }

  @override
  Future<ServerLaunchResult> ensureRunning({
    required String baseUrl,
    Duration waitFor = const Duration(seconds: 30),
    void Function()? onProgress,
  }) async {
    starts++;
    return const ServerLaunchResult(ok: true, alreadyRunning: false);
  }
}

class _State extends AppState {
  _State(this.launcher);
  final _Launcher launcher;

  @override
  LocalServerLauncher get serverLauncher => launcher;

  @override
  Future<void> connectLocal({String? url}) async {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory temp;
  late _Launcher launcher;
  late _State state;

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    temp = Directory.systemTemp.createTempSync('pi-bot-settings-');
    launcher = _Launcher(temp);
    state = _State(launcher);
  });

  tearDown(() {
    state.dispose();
    temp.deleteSync(recursive: true);
  });

  test('保存端口、目录和 node 路径后将配置转发给新服务端', () async {
    await state.applyServerSettings(
      dataDir: ' data folder ',
      port: 9876,
      entryPath: ' server.js ',
      nodePath: ' node ',
    );
    expect(launcher.starts, 1);
    expect(launcher.options.port, 9876);
    expect(launcher.options.data, 'data folder');
    expect(launcher.options.node, 'node');
    expect(launcher.options.entry, 'server.js');
    expect(launcher.options.env['PI_BOT_PORT'], '9876');
    expect(state.localUrl, 'http://127.0.0.1:9876');
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getInt('server_port'), 9876);
    expect(prefs.getString('server_data_dir'), 'data folder');
  });

  test('旧服务端停止失败时暂停重试并显示错误，不启动新进程', () async {
    launcher.failToStop = true;
    await state.restartLocalServer();
    expect(launcher.starts, 0);
    expect(state.serverProblem, contains('进程仍在运行'));
    expect(state.lastError, state.serverProblem);
    expect(state.serverRetryPaused, isTrue);
    expect(state.serverStarting, isFalse);
  });

  test('服务端正在启动时拒绝保存，内存配置和已持久化配置不变', () async {
    SharedPreferences.setMockInitialValues({
      'server_port': 8787,
      'server_data_dir': 'original data',
      'server_entry': 'original.js',
      'server_node': 'original node',
    });
    state.serverDataDir = 'original data';
    state.serverEntryPath = 'original.js';
    state.serverNodePath = 'original node';
    state.serverStarting = true;
    final originalOptions = launcher.options;
    await state.applyServerSettings(
      dataDir: 'new data',
      port: 9876,
      entryPath: 'new.js',
      nodePath: 'new node',
    );
    expect(state.serverPort, 8787);
    expect(state.serverDataDir, 'original data');
    expect(state.serverEntryPath, 'original.js');
    expect(state.serverNodePath, 'original node');
    expect(launcher.options, same(originalOptions));
    expect(launcher.starts, 0);
    expect(state.serverProblem, contains('等待完成后再保存配置'));
    expect(state.lastError, state.serverProblem);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getInt('server_port'), 8787);
    expect(prefs.getString('server_data_dir'), 'original data');
    expect(prefs.getString('server_entry'), 'original.js');
    expect(prefs.getString('server_node'), 'original node');
  });

  test('保存配置期间阻止巡检启动，持久化完成后使用新配置重启一次', () async {
    final saving = state.applyServerSettings(
      dataDir: 'new data',
      port: 9876,
      entryPath: 'new.js',
      nodePath: 'new node',
    );
    expect(state.serverStarting, isTrue);
    final competingStart = state.bootLocalServer();
    expect(launcher.starts, 0);
    await competingStart;
    await saving;
    expect(launcher.starts, 1);
    expect(launcher.options.port, 9876);
    expect(launcher.options.entry, 'new.js');
    expect(state.serverStarting, isFalse);
  });

  Future<void> saveSettings(WidgetTester tester) async {
    await tester.pumpWidget(
      AppScope(
        state: state,
        child: const MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(child: ServerConfigSection()),
          ),
        ),
      ),
    );
    await tester.tap(find.text('修改启动配置'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('保存并重启'));
    await tester.pumpAndSettle();
  }

  testWidgets('设置保存成功提示服务端已启动', (tester) async {
    await saveSettings(tester);
    expect(find.text('已保存，本机服务端已启动'), findsOneWidget);
  });

  testWidgets('停止失败在设置中显示实际错误，不显示启动成功', (tester) async {
    launcher.failToStop = true;
    await saveSettings(tester);
    expect(find.textContaining('停止本机服务端失败：'), findsOneWidget);
    expect(find.text('已保存，本机服务端已启动'), findsNothing);
    expect(launcher.starts, 0);
  });

  testWidgets('启动过程中保存设置显示拒绝原因，原配置不变', (tester) async {
    state.serverStarting = true;
    await tester.pumpWidget(
      AppScope(
        state: state,
        child: const MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(child: ServerConfigSection()),
          ),
        ),
      ),
    );
    await tester.tap(find.text('修改启动配置'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).first, '9876');
    await tester.tap(find.text('保存并重启'));
    await tester.pumpAndSettle();
    expect(find.textContaining('等待完成后再保存配置'), findsOneWidget);
    expect(find.text('已保存，本机服务端已启动'), findsNothing);
    expect(state.serverPort, 8787);
    expect(launcher.starts, 0);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getInt('server_port'), isNull);
  });

  Future<void> openOfflineSettings(WidgetTester tester) async {
    state.serverProblem = '端口 8787 被别的程序占着';
    state.serverRetryPaused = true;
    await tester.pumpWidget(
      AppScope(
        state: state,
        child: const MaterialApp(home: HostConnectScreen()),
      ),
    );
    expect(find.text('端口 8787 被别的程序占着'), findsOneWidget);
    await tester.ensureVisible(find.text('本机服务端设置'));
    await tester.tap(find.text('本机服务端设置'));
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('本机服务端启动配置'), findsOneWidget);
  }

  testWidgets('离线页可打开本机设置并保存新端口后重启', (tester) async {
    await openOfflineSettings(tester);
    await tester.enterText(find.byType(TextField).first, '18787');
    await tester.tap(find.text('保存并重启'));
    await tester.pump(const Duration(milliseconds: 300));
    expect(state.serverPort, 18787);
    expect(launcher.options.port, 18787);
    expect(launcher.starts, 1);
    expect(find.text('已保存，本机服务端已启动'), findsOneWidget);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getInt('server_port'), 18787);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('离线页取消设置保留占用原因与原配置', (tester) async {
    await openOfflineSettings(tester);
    await tester.tap(find.text('取消'));
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('端口 8787 被别的程序占着'), findsOneWidget);
    expect(state.serverPort, 8787);
    expect(launcher.starts, 0);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getInt('server_port'), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
