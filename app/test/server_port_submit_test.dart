import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/ime_guard.dart';

/// 服务端端口弹窗：回车等于点保存，且组词时不提交。
///
/// 测的是 submitUnlessComposing 这个包装（弹窗里用的就是它）——
/// 直接 pump 弹窗要拖进 AppState / 网络依赖。
void main() {
  testWidgets('回车触发提交', (tester) async {
    final c = TextEditingController();
    var submitted = 0;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: TextField(
          controller: c,
          onSubmitted: submitUnlessComposing(c, () => submitted++),
        ),
      ),
    ));
    await tester.enterText(find.byType(TextField), '8787');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    expect(submitted, 1, reason: '回车应该提交一次');
  });

  test('组词期间的回车不提交（中文输入法不吃字）', () {
    final c = TextEditingController();
    var submitted = 0;
    final handler = submitUnlessComposing(c, () => submitted++);

    // 组词中：composing 非空
    c.value = const TextEditingValue(
      text: '87',
      composing: TextRange(start: 0, end: 2),
    );
    handler('87');
    expect(submitted, 0, reason: '组词中回车应交给输入法，不能提交');

    // 选完词：composing 清空
    c.value = const TextEditingValue(text: '8787');
    handler('8787');
    expect(submitted, 1, reason: '选完词再回车才提交');
    c.dispose();
  });

  test('isImeComposing 判据', () {
    final c = TextEditingController();
    expect(isImeComposing(c), isFalse, reason: '空输入不算组词');
    c.value = const TextEditingValue(
      text: 'a',
      composing: TextRange(start: 0, end: 1),
    );
    expect(isImeComposing(c), isTrue);
    c.value = const TextEditingValue(
      text: 'ab',
      composing: TextRange.empty,
    );
    expect(isImeComposing(c), isFalse, reason: '折叠区间不算组词');
    c.dispose();
  });
}
