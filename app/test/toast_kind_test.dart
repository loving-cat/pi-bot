// 提示的图标必须跟结果一致。
//
// 真实事故：`sites_section.dart` 里的 `_toast` 把 kind 写死成 `ToastKind.error`，
// 于是"连接成功""已添加""已删除"全都顶着红叉弹出来 —— 用户以为失败了，
// 其实早就成了。这类 bug 不会崩、不会报错，只会让人反复重试。
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/widgets/toast.dart';

void main() {
  test('成功用对勾、失败用叉、普通用信息图标', () {
    // 图标与颜色的映射在 build 里，这里守的是"三种结果确实分开了"这个前提：
    // 只要有人把 kind 写死，下面那条源码断言就会红。
    expect(defaultToastDuration(ToastKind.success).inSeconds, lessThan(4));
    expect(defaultToastDuration(ToastKind.error).inSeconds, greaterThanOrEqualTo(4));
  });

  group('源码里不许把提示写死成失败', () {
    List<File> dartFiles() {
      final out = <File>[];
      for (final entity in Directory('lib').listSync(recursive: true)) {
        if (entity is File && entity.path.endsWith('.dart')) out.add(entity);
      }
      return out;
    }

    test('★ 没有任何地方写 toast(..., kind: ToastKind.error) 却传成功文案', () {
      final offenders = <String>[];
      for (final file in dartFiles()) {
        final text = file.readAsStringSync();
        // 找 "kind: ToastKind.error" 所在语句里是否同时出现"成功/已/ok"这种词
        for (final match in RegExp(r'toast\([^;]{0,400}?ToastKind\.error[^;]{0,80};', dotAll: true)
            .allMatches(text)) {
          final call = match.group(0)!;
          final looksSuccessful = RegExp(r'(成功|已添加|已删除|已保存|连接成功|connectOk|saved|added|removed)').hasMatch(call);
          // 允许 "err == null ? success : error" 这种三元——它本身就在分流
          final splits = call.contains('ToastKind.success');
          if (looksSuccessful && !splits) {
            offenders.add('${file.path}: ${call.replaceAll(RegExp(r'\s+'), ' ')}');
          }
        }
      }
      expect(offenders, isEmpty, reason: '成功却画红叉：\n${offenders.join('\n')}');
    });

    test('sites_section 的 _toast 有 kind 参数，且连接结果按 ok 分流', () {
      final source = File('lib/widgets/sites_section.dart').readAsStringSync();
      expect(source, contains('void _toast('));
      expect(source, contains('ToastKind kind = ToastKind.info'),
          reason: '默认不能是 error（否则成功也画叉）');
      expect(source, contains("kind: r['ok'] == true ? ToastKind.success : ToastKind.error"));
    });
  });
}
