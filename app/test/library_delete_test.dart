import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/paste_paths.dart' as pp;

/// 资料库删除的行为约束。
///
/// 这部分逻辑主要在 AppState 里（需要网络），这里测的是与界面相关的
/// 纯逻辑：删除后附件应该从列表里彻底消失，而不是留个空壳。
void main() {
  group('附件集合过滤', () {
    /// 用 Set.contains 过滤 —— 和 AppState.deleteAttachments 里的实现一致
    List<String> kept(List<String> ids, Set<String> deleted) =>
        ids.where((id) => !deleted.contains(id)).toList();

    test('删一个，只少那一个', () {
      expect(kept(['a', 'b', 'c'], {'b'}), ['a', 'c']);
    });

    test('删多个一次到位', () {
      expect(kept(['a', 'b', 'c', 'd'], {'a', 'c'}), ['b', 'd']);
    });

    test('删不存在的 id 不影响其它', () {
      expect(kept(['a', 'b'], {'zzz'}), ['a', 'b']);
    });

    test('全删光得到空列表（资料库该显示空状态）', () {
      expect(kept(['a', 'b'], {'a', 'b'}), isEmpty);
    });

    test('空输入不炸', () {
      expect(kept([], {'a'}), isEmpty);
      expect(kept(['a'], {}), ['a']);
    });
  });

  group('选择状态的判定', () {
    /// 全选/取消全选用的判断：选中数 == 总数
    bool allSelected(Set<String> sel, int total) =>
        total > 0 && sel.length == total;

    test('全勾了才算全选', () {
      expect(allSelected({'a', 'b'}, 2), isTrue);
      expect(allSelected({'a'}, 2), isFalse);
    });

    test('空列表不算全选（避免出现「全选」却没什么可选）', () {
      expect(allSelected({}, 0), isFalse);
    });

    test('选了不存在的也算数量 —— 但界面上的项是筛过的，不会出现', () {
      // 记录这个语义：判定只看数量，所以调用方必须保证集合来自当前列表
      expect(allSelected({'a', 'b', 'x'}, 2), isFalse);
    });
  });

  group('删除按钮可用性', () {
    bool canDelete(Set<String> sel) => sel.isNotEmpty;

    test('没选任何东西时删除按钮应禁用', () {
      expect(canDelete({}), isFalse);
    });

    test('选了至少一个才能删', () {
      expect(canDelete({'a'}), isTrue);
    });
  });

  group('真实文件路径（确保与粘贴解析共用同一套判定）', () {
    late Directory tmp;
    setUp(() => tmp = Directory.systemTemp.createTempSync('pi_lib_test_'));
    tearDown(() {
      if (tmp.existsSync()) tmp.deleteSync(recursive: true);
    });

    test('当前平台路径能被粘贴解析认出（资料库里的文件同样是真路径）', () {
      final f = File('${tmp.path}${Platform.pathSeparator}x.txt')
        ..writeAsStringSync('x');
      final r = pp.extractPastedFiles('看下 ${f.path} 这个');
      expect(r.files.length, 1);
    });
  });
}
