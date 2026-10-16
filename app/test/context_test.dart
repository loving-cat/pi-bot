// 上下文占用显示。
//
// 两件要钉住的：
//   1. 群里选"哪个 bot 的占用"要选**最满的那个** —— 头部只放得下一个，
//      而"哪个快满了"才是用户要看的
//   2. 占用未知时不能显示 0%（那会让人以为上下文是空的）
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';

void main() {
  group('ContextInfo', () {
    test('能解析服务端给的四个字段', () {
      final c = ContextInfo.fromJson({
        'tokens': 423000,
        'contextWindow': 1000000,
        'percent': 42.3,
        'compacting': false,
      });
      expect(c.tokens, 423000);
      expect(c.contextWindow, 1000000);
      expect(c.percent, 42.3);
      expect(c.known, isTrue);
    });

    test('★ 刚压缩完 tokens 是 null —— 那叫"还不知道"，不是"空的"', () {
      final c = ContextInfo.fromJson({
        'tokens': null,
        'contextWindow': 1000000,
        'percent': null,
      });
      expect(c.known, isFalse, reason: '界面该显示"—"而不是 0%');
    });

    test('contextWindow 为 0 也算未知（不能拿它做分母）', () {
      final c = ContextInfo.fromJson({'tokens': 100, 'contextWindow': 0});
      expect(c.known, isFalse);
    });
  });

  group('AppState.contextFor：群里取占用最高的那个', () {
    AppState withContexts(Map<String, Map<String, dynamic>> raw) {
      final s = AppState();
      s.contexts.addAll(
        raw.map((k, v) => MapEntry(k, ContextInfo.fromJson(v))),
      );
      return s;
    }

    test('群里好几个 bot 时，取占用最高的', () {
      final s = withContexts({
        'r1:b1': {'tokens': 100, 'contextWindow': 1000, 'percent': 10.0},
        'r1:b2': {'tokens': 800, 'contextWindow': 1000, 'percent': 80.0},
        'r1:b3': {'tokens': 300, 'contextWindow': 1000, 'percent': 30.0},
      });
      expect(s.contextFor('r1')?.percent, 80.0);
      s.dispose();
    });

    test('别把别的房间的算进来', () {
      final s = withContexts({
        'r1:b1': {'tokens': 100, 'contextWindow': 1000, 'percent': 10.0},
        'r2:b9': {'tokens': 990, 'contextWindow': 1000, 'percent': 99.0},
      });
      expect(s.contextFor('r1')?.percent, 10.0);
      s.dispose();
    });

    test('未知占用不参与比较（不能被当成 0 或者 -1 抢走）', () {
      final s = withContexts({
        'r1:b1': {'tokens': null, 'contextWindow': 1000, 'percent': null},
        'r1:b2': {'tokens': 200, 'contextWindow': 1000, 'percent': 20.0},
      });
      expect(s.contextFor('r1')?.percent, 20.0);
      s.dispose();
    });

    test('一个都没有就返回 null（界面据此不画指示器）', () {
      final s = AppState();
      expect(s.contextFor('r1'), isNull);
      s.dispose();
    });
  });

  group('压缩状态', () {
    test('compactingIn 只看这个房间', () {
      final s = AppState();
      s.contexts['r1:b1'] = ContextInfo.fromJson({
        'tokens': 1,
        'contextWindow': 100,
        'percent': 1.0,
        'compacting': true,
      });
      s.contexts['r2:b1'] = ContextInfo.fromJson({
        'tokens': 1,
        'contextWindow': 100,
        'percent': 1.0,
      });
      expect(s.compactingIn('r1'), isTrue);
      expect(s.compactingIn('r2'), isFalse);
      s.dispose();
    });

    test('bot.compacting 事件会更新状态（并且保住原来的数字）', () {
      final s = AppState();
      s.contexts['r1:b1'] = ContextInfo.fromJson({
        'tokens': 500,
        'contextWindow': 1000,
        'percent': 50.0,
      });
      s.contexts['r1:b1'] = s.contexts['r1:b1']!.copyWith(compacting: true);
      expect(s.compactingIn('r1'), isTrue);
      expect(s.contextFor('r1')?.tokens, 500, reason: '压缩只是打个标记，数字不该丢');
      s.dispose();
    });
  });

  test('kind=compact 的消息要认出来（它要画成一条横条，不是气泡）', () {
    final m = Msg.fromJson({
      'id': 'm1',
      'kind': 'compact',
      'meta': {'tokensBefore': 210000, 'saved': 180000},
    });
    expect(m.isCompact, isTrue);
    expect(m.isRef, isFalse, reason: '别和引用气泡搞混');
    expect(m.meta?['tokensBefore'], 210000);
  });
}

// 引用气泡的文案：有往来条数时要说"N 条消息往来"，而不是"已发送给 X"
