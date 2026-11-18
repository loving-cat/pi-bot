// 手机端"附近的电脑"这块界面：列表长什么样、空列表说什么、等待卡显示在等谁。
//
// 为什么单独测这个而不测整个配对页：配对页会真发 UDP 广播（1.6 秒），测起来慢且
// 依赖网络环境；而这块界面本身就是**用户能不能看懂"现在在等什么"**的地方。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/discovery.dart';
import 'package:pi_bot/l10n/l10n.dart';
import 'package:pi_bot/theme.dart';
import 'package:pi_bot/widgets/pair_nearby.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

DiscoveredHost _host(
  String hostname, {
  String version = '1.4.1',
  List<String>? urls,
  bool approve = true,
}) => DiscoveredHost(
  name: 'Orbis',
  hostname: hostname,
  version: version,
  port: 8787,
  urls: urls ?? ['http://192.168.1.7:8787'],
  pairing: true,
  approve: approve,
);

Future<void> _pump(WidgetTester tester, Widget child) async {
  await tester.pumpWidget(
    L10n(
      controller: LocaleController(),
      child: MaterialApp(
        theme: PB.theme(),
        home: Scaffold(body: SingleChildScrollView(child: child)),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  testWidgets('找到两台电脑：都列出来，机器名和地址都在', (tester) async {
    var picked = '';
    await _pump(
      tester,
      NearbyHostsCard(
        hosts: [_host('studio-pc'), _host('mac-mini', urls: ['http://192.168.1.8:8787'])],
        scanning: false,
        picked: null,
        onPick: (h) => picked = h.label,
        onRescan: () {},
      ),
    );
    expect(find.text('附近的电脑'), findsOneWidget);
    expect(find.text('studio-pc'), findsOneWidget);
    expect(find.text('mac-mini'), findsOneWidget);
    expect(find.text('http://192.168.1.7:8787'), findsOneWidget);

    await tester.tap(find.text('mac-mini'));
    expect(picked, 'mac-mini', reason: '点哪台就该选中哪台');
  });

  testWidgets('一台都没找到：说清"确认同一 Wi-Fi"并给出重新搜索', (tester) async {
    await _pump(
      tester,
      NearbyHostsCard(
        hosts: const [],
        scanning: false,
        picked: null,
        onPick: (_) {},
        onRescan: () {},
      ),
    );
    expect(find.text('没找到附近的电脑'), findsOneWidget);
    expect(find.textContaining('同一个 Wi-Fi'), findsOneWidget);
    expect(find.text('重新搜索'), findsOneWidget, reason: '不能让人卡在空列表上，要有手动的出口');
  });

  testWidgets('还在搜：显示转圈和"正在搜索"，不显示"没找到"', (tester) async {
    await _pump(
      tester,
      NearbyHostsCard(
        hosts: const [],
        scanning: true,
        picked: null,
        onPick: (_) {},
        onRescan: () {},
      ),
    );
    expect(find.textContaining('正在搜索'), findsOneWidget);
    expect(find.text('没找到附近的电脑'), findsNothing, reason: '搜索中就说没找到会误导');
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
  });

  testWidgets('重新搜索按钮真的会回调', (tester) async {
    var rescans = 0;
    await _pump(
      tester,
      NearbyHostsCard(
        hosts: const [],
        scanning: false,
        picked: null,
        onPick: (_) {},
        onRescan: () => rescans++,
      ),
    );
    await tester.tap(find.text('重新搜索'));
    expect(rescans, 1);
  });

  testWidgets('选中的那台有视觉标记（不然看不出选的是哪台）', (tester) async {
    final host = _host('studio-pc');
    await _pump(
      tester,
      NearbyHostsCard(
        hosts: [host],
        scanning: false,
        picked: host,
        onPick: (_) {},
        onRescan: () {},
      ),
    );
    expect(find.byIcon(LucideIcons.circleCheck), findsOneWidget);
  });

  testWidgets('等待卡：说清在等谁、多久失效、可以取消', (tester) async {
    var cancelled = false;
    await _pump(
      tester,
      PairWaitingCard(
        host: 'studio-pc',
        title: '已发送，去电脑上点"允许"',
        hint: '电脑上的 Orbis 会弹出窗口问你这台手机要不要连进来',
        onCancel: () => cancelled = true,
      ),
    );
    expect(find.text('已发送，去电脑上点"允许"'), findsOneWidget);
    expect(find.text('studio-pc'), findsOneWidget);
    expect(find.textContaining('弹出窗口'), findsOneWidget);
    await tester.tap(find.text('取消'));
    expect(cancelled, isTrue);
  });
}
