// App 网络层端到端测试（需要本地 pi-bot 服务端在跑）：
//   cd ../server && PI_BOT_TOKEN=test-token node src/index.js
//   cd ../app && flutter test test/app_state_test.dart
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:shared_preferences/shared_preferences.dart';

const serverUrl = String.fromEnvironment('PI_BOT_URL', defaultValue: 'http://127.0.0.1:8787');
const token = String.fromEnvironment('PI_BOT_TOKEN', defaultValue: 'test-token');

Future<void> waitFor(bool Function() predicate, int seconds, String what) async {
  final deadline = DateTime.now().add(Duration(seconds: seconds));
  while (DateTime.now().isBefore(deadline)) {
    if (predicate()) return;
    await Future<void>.delayed(const Duration(milliseconds: 200));
  }
  fail('等待超时：$what');
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // ★ TestWidgetsFlutterBinding 会把所有 HttpClient 请求拦成 400（防止单测误打真网络）。
  //   但这是个**集成测试**：它就是要连真实服务端、跑真实 WebSocket。
  //   清掉 HttpOverrides 才能真的发出去 —— 否则永远卡在"等待 WebSocket 连上"。
  setUpAll(() => HttpOverrides.global = null);

  test('配对 + 拉状态 + 发消息 + 收流式回复', () async {
    SharedPreferences.setMockInitialValues({});
    final state = AppState();
    addTearDown(state.dispose);

    await state.bootstrap();
    // PC 端是宿主：bootstrap 会直接连本机服务端（localMode=true），不走配对。
    // 这个用例测的是**手机端扫码配对**那条路，所以先登出回到未配对状态。
    if (state.paired) await state.signOut();
    expect(state.paired, isFalse);

    await state.useToken(serverUrl, token, device: 'flutter-test');
    await waitFor(() => state.link == LinkState.online, 20, 'WebSocket 连上');

    expect(state.rooms, isNotEmpty, reason: '至少应该有一个默认群');
    expect(state.bots, isNotEmpty, reason: '至少应该有一个 bot');
    expect(state.serverInfo?.model, isNotNull);

    final room = state.rooms.first;
    await state.loadMessages(room.id, force: true);

    await state.sendMessage(room.id, '只回答两个字：你好');

    await waitFor(
      () => (state.messages[room.id] ?? const [])
          .any((m) => m.authorType == 'bot' && m.status != 'streaming'),
      120,
      'bot 回复完成',
    );

    final botMsg = (state.messages[room.id] ?? const []).lastWhere((m) => m.authorType == 'bot');
    expect(botMsg.text.trim(), isNotEmpty, reason: 'bot 回复不应该为空');
    expect(botMsg.status, 'done');

    // 用户消息也应该在列表里
    expect((state.messages[room.id] ?? const []).any((m) => m.isUser), isTrue);

    // ignore: avoid_print
    print('✅ bot 回复：${botMsg.text.trim()}  usage=${botMsg.usage}');
  }, timeout: const Timeout(Duration(minutes: 4)));
}
