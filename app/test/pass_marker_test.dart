import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/text_utils.dart';

void main() {
  group('剥掉结尾的 [PASS]', () {
    test('报告末尾的标记连括号说明一起剥', () {
      const text = '报告写完了，三条官方路径都核对过。\n\n[PASS]（不需要接，直接回答进度）';
      expect(
        stripTrailingPassMarker(text),
        '报告写完了，三条官方路径都核对过。',
      );
    });

    test('纯 PASS 保持原样（服务端会直接删这条消息）', () {
      expect(stripTrailingPassMarker('[PASS]'), '[PASS]');
      expect(stripTrailingPassMarker('[PASS]（轮不到我）'), '[PASS]（轮不到我）');
    });

    test('英文标点与全角括号都认', () {
      expect(stripTrailingPassMarker('做完了。[PASS](nobody asked me)'), '做完了。');
      expect(stripTrailingPassMarker('做完了。【pass】（轮不到我）'), '做完了。');
    });

    test('正文中间提到 PASS 不动', () {
      const text = '规则是：不需要接就回 [PASS]。这条别再改了。';
      expect(stripTrailingPassMarker(text), text);
    });
  });

  group('消息解析时就清掉（老消息也一起）', () {
    test('fromJson 得到的正文不带 PASS 尾巴', () {
      final msg = Msg.fromJson({
        'id': 'm1',
        'roomId': 'r1',
        'authorType': 'bot',
        'authorId': 'b1',
        'authorName': '负责人',
        'text': '都核对完了。\n[PASS]（不需要接）',
        'status': 'done',
        'createdAt': 1000,
      });
      expect(msg.text, '都核对完了。');
    });
  });
}
