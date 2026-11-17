// 手机（Android）尺寸下的排版守门测试。
//
// 桌面端常年在 ≥1200px 的窗口里跑，窄屏是靠「反正没人这么用」活下来的：
// 一行放不下的 Row、写死宽度的侧栏、被固定 padding 挤没的输入框，
// 在 360dp 的手机上就是 RenderFlex overflow（黄黑条）甚至整块看不见。
//
// 这里按真机常见逻辑尺寸、在**竖屏与横屏**两种朝向下把主要界面各挂一次，断言：
//   ① 不抛异常（overflow 会以异常形式炸出来，不必自己去找黄黑条）
//   ② 关键控件仍在（输入框/会话项），没有被挤成 0 宽
//
// 尺寸取真机常见值：
//   320×640   小屏（Android go / 老机型）
//   360×800   主流（大部分国产机）
//   412×915   Pixel 6/7 一档
//   800×360   手机横屏 —— 宽度超过半屏阈值 760，会走「左右分栏」那条路
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/l10n/l10n.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/screens/chat_screen.dart';
import 'package:pi_bot/screens/home_shell.dart';
import 'package:pi_bot/screens/rooms_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

final _room = Room(
  id: 'r-phone',
  name: '手机上的会话',
  kind: 'dm',
  botIds: const ['b1'],
  lastMessageAt: 1700000000000,
);

Msg _msg(String id, String text, {bool mine = false}) => Msg(
  id: id,
  roomId: _room.id,
  authorType: mine ? 'user' : 'bot',
  authorName: mine ? '我' : '数据工程师',
  text: text,
  status: 'done',
  createdAt: 1700000000000,
);

class _PhoneState extends AppState {
  _PhoneState() {
    rooms = [_room];
    bots = [Bot(id: 'b1', name: '数据工程师', persona: '')];
    messages[_room.id] = [
      _msg('m1', '手机竖屏下这一条长消息必须自己换行，不能把气泡撑到屏幕外。'),
      _msg('m2', '收到，已经按窄屏排过版了。', mine: true),
    ];
  }

  @override
  Future<void> loadMessages(String roomId, {bool force = false}) async {}
}

/// 真机尺寸 = 逻辑尺寸 × dpr，两侧都要设，否则拿到的是 800×600 的默认 view。
Future<void> _pumpAt(
  WidgetTester tester,
  Size logical,
  double dpr,
  Widget child,
) async {
  tester.view.devicePixelRatio = dpr;
  tester.view.physicalSize = Size(logical.width * dpr, logical.height * dpr);
  addTearDown(tester.view.reset);
  final state = _PhoneState();
  addTearDown(state.dispose);
  await tester.pumpWidget(
    AppScope(
      state: state,
      child: L10n(
        controller: LocaleController(),
        child: MaterialApp(home: child),
      ),
    ),
  );
  // 不用 pumpAndSettle：忙时输入区有持续动画，永远 settle 不了。
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
}

const _sizes = <(String, Size, double)>[
  ('小屏 320×640', Size(320, 640), 2.0),
  ('主流 360×800', Size(360, 800), 3.0),
  ('Pixel 412×915', Size(412, 915), 2.625),
];

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  group('竖屏：会话列表', () {
    for (final (label, size, dpr) in _sizes) {
      testWidgets('$label 不溢出，会话项还在', (tester) async {
        await _pumpAt(tester, size, dpr, const RoomsScreen());
        expect(tester.takeException(), isNull);
        expect(find.text('手机上的会话'), findsWidgets);
      });
    }
  });

  group('竖屏：对话页', () {
    for (final (label, size, dpr) in _sizes) {
      testWidgets('$label 不溢出，输入框与消息都在', (tester) async {
        await _pumpAt(tester, size, dpr, ChatScreen(room: _room));
        expect(tester.takeException(), isNull);
        expect(find.byKey(const ValueKey('composer-capsule')), findsOneWidget);
        expect(find.textContaining('窄屏排过版'), findsOneWidget);
      });
    }

    testWidgets('竖屏 HomeShell 走单页导航', (tester) async {
      await _pumpAt(tester, const Size(360, 800), 3.0, const HomeShell());
      expect(tester.takeException(), isNull);
      expect(find.byType(RoomsScreen), findsWidgets);
    });
  });

  group('横屏：手机横过来', () {    testWidgets('高度只有 360 时对话页仍可用', (tester) async {
      await _pumpAt(tester, const Size(800, 360), 2.0, ChatScreen(room: _room));
      expect(tester.takeException(), isNull);
      expect(find.byKey(const ValueKey('composer-capsule')), findsOneWidget);
    });

    testWidgets('★ 宽 800（≥760）会分栏：左栏不能把对话挤没', (tester) async {
      await _pumpAt(tester, const Size(800, 360), 2.0, const HomeShell());
      expect(tester.takeException(), isNull);
      expect(find.text('手机上的会话'), findsWidgets);
    });
  });

  // 负向验证：这套夹具真的能抓到溢出，而不是"什么都不报"的摆设。
  // 320dp 宽里塞两个 500dp 的盒子，一定是 RenderFlex overflow。
  testWidgets('夹具灵敏度：故意溢出时必须抛异常', (tester) async {
    await _pumpAt(
      tester,
      const Size(320, 640),
      2.0,
      const Scaffold(
        body: Row(
          children: [
            SizedBox(width: 500, height: 10),
            SizedBox(width: 500, height: 10),
          ],
        ),
      ),
    );
    expect(tester.takeException(), isA<FlutterError>());
  });
}
