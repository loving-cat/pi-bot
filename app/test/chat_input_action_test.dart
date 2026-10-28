import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/chat_input_action.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/screens/chat_screen.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';

class _MemoryState extends AppState {
  final sent = <String>[];

  @override
  Future<void> loadMessages(String roomId, {bool force = false}) async {}

  @override
  Future<void> sendMessage(
    String roomId,
    String text, {
    String mode = 'steer',
    List<Attachment> attachments = const [],
    bool flushMerge = true,
  }) async => sent.add(text);
}

Finder get _input => find.byWidgetPredicate(
  (widget) => widget is TextField && widget.decoration?.hintText == '说点什么',
);

Future<void> _pressEnter(WidgetTester tester, LogicalKeyboardKey key) async {
  if (defaultTargetPlatform == TargetPlatform.windows &&
      key == LogicalKeyboardKey.numpadEnter) {
    // Windows 的旧 RawKeyEvent 测试映射缺此键；平台布局仍为 Windows，
    // 使用可表达该逻辑键的原始事件格式驱动完整焦点分发。
    await tester.sendKeyEvent(key, platform: 'macos');
  } else {
    await tester.sendKeyEvent(key);
  }
}

Future<(_MemoryState, TextEditingController)> _host(WidgetTester tester) async {
  tester.view.physicalSize = const Size(1000, 760);
  tester.view.devicePixelRatio = 1;
  final room = Room(
    id: 'fixture-newline-room',
    name: '键盘验证',
    kind: 'dm',
    botIds: const [],
  );
  final state = _MemoryState()
    ..rooms = [room]
    ..link = LinkState.online;
  await tester.pumpWidget(
    AppScope(
      state: state,
      child: MaterialApp(home: ChatScreen(room: room)),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(_input);
  await tester.pumpAndSettle();
  addTearDown(() async {
    await tester.pumpWidget(const SizedBox.shrink());
    state.dispose();
    tester.view.reset();
  });
  return (state, tester.widget<TextField>(_input).controller!);
}

void main() {
  setUp(() => BlobAvatar.animationsEnabled = false);
  tearDown(() {
    BlobAvatar.animationsEnabled = true;
    debugDefaultTargetPlatformOverride = null;
  });

  test('桌面使用换行动作，移动端保留发送动作', () {
    for (final platform in [
      TargetPlatform.macOS,
      TargetPlatform.windows,
      TargetPlatform.linux,
    ]) {
      expect(chatInputActionFor(platform), TextInputAction.newline);
    }
    for (final platform in [
      TargetPlatform.iOS,
      TargetPlatform.android,
      TargetPlatform.fuchsia,
    ]) {
      expect(chatInputActionFor(platform), TextInputAction.send);
    }
  });

  for (final platform in [
    TargetPlatform.macOS,
    TargetPlatform.windows,
    TargetPlatform.linux,
  ]) {
    for (final key in [
      LogicalKeyboardKey.enter,
      LogicalKeyboardKey.numpadEnter,
    ]) {
      testWidgets('$platform ${key.keyLabel} 普通回车只发送一次', (tester) async {
        final (state, controller) = await _host(tester);
        await tester.enterText(_input, 'fixture message');
        await _pressEnter(tester, key);
        await tester.pumpAndSettle();
        expect(state.sent, ['fixture message']);
        expect(controller.text, isEmpty);
      }, variant: TargetPlatformVariant.only(platform));

      testWidgets('$platform Shift+${key.keyLabel}交原生换行且不发送', (tester) async {
        final (state, controller) = await _host(tester);
        await tester.enterText(_input, '第一行第二行');
        controller.selection = const TextSelection.collapsed(offset: 3);
        expect(
          tester.widget<TextField>(_input).textInputAction,
          TextInputAction.newline,
        );
        await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
        await _pressEnter(tester, key);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
        expect(state.sent, isEmpty);
        expect(controller.text, '第一行第二行');
        // 平台键事件与原生文本编辑回调是独立通道；模拟原生已插入的结果。
        tester.testTextInput.updateEditingValue(
          const TextEditingValue(
            text: '第一行\n第二行',
            selection: TextSelection.collapsed(offset: 4),
          ),
        );
        await tester.testTextInput.receiveAction(TextInputAction.newline);
        await tester.pump();
        expect(controller.text, '第一行\n第二行');
        expect(controller.selection.baseOffset, 4);
        expect(state.sent, isEmpty);
        expect(tester.widget<TextField>(_input).focusNode!.hasFocus, true);
      }, variant: TargetPlatformVariant.only(platform));
    }

    testWidgets('$platform 主修饰键加回车仍发送一次', (tester) async {
      final (state, _) = await _host(tester);
      await tester.enterText(_input, 'fixture shortcut');
      final modifier = platform == TargetPlatform.macOS
          ? LogicalKeyboardKey.metaLeft
          : LogicalKeyboardKey.controlLeft;
      await tester.sendKeyDownEvent(modifier);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(modifier);
      await tester.pumpAndSettle();
      expect(state.sent, ['fixture shortcut']);
    }, variant: TargetPlatformVariant.only(platform));

    testWidgets('$platform 原生选区替换换行不会发送', (tester) async {
      final (state, controller) = await _host(tester);
      await tester.enterText(_input, 'abcXYZdef');
      controller.selection = const TextSelection(
        baseOffset: 3,
        extentOffset: 6,
      );
      tester.testTextInput.updateEditingValue(
        const TextEditingValue(
          text: 'abc\ndef',
          selection: TextSelection.collapsed(offset: 4),
        ),
      );
      await tester.testTextInput.receiveAction(TextInputAction.newline);
      await tester.pump();
      expect(controller.text, 'abc\ndef');
      expect(state.sent, isEmpty);
    }, variant: TargetPlatformVariant.only(platform));

    testWidgets('$platform 中文组词回车和原生确认不误发送', (tester) async {
      final (state, controller) = await _host(tester);
      tester.testTextInput.updateEditingValue(
        const TextEditingValue(
          text: 'nihao',
          selection: TextSelection.collapsed(offset: 5),
          composing: TextRange(start: 0, end: 5),
        ),
      );
      expect(controller.value.composing.isCollapsed, false);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      expect(state.sent, isEmpty);
      expect(controller.text, 'nihao');
      tester.testTextInput.updateEditingValue(
        const TextEditingValue(
          text: '你好',
          selection: TextSelection.collapsed(offset: 2),
        ),
      );
      await tester.testTextInput.receiveAction(TextInputAction.newline);
      await tester.pump();
      expect(controller.text, '你好');
      expect(state.sent, isEmpty);
    }, variant: TargetPlatformVariant.only(platform));
  }

  for (final platform in [TargetPlatform.android, TargetPlatform.iOS]) {
    testWidgets('$platform 软键盘发送仍生效', (tester) async {
      final (state, _) = await _host(tester);
      await tester.enterText(_input, 'fixture mobile');
      expect(
        tester.widget<TextField>(_input).textInputAction,
        TextInputAction.send,
      );
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pumpAndSettle();
      expect(state.sent, ['fixture mobile']);
    }, variant: TargetPlatformVariant.only(platform));
  }
}
