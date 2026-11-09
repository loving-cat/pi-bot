import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/l10n/app_strings.dart';
import 'package:pi_bot/l10n/l10n.dart';

/// 保护回执弹窗的三条语义，都是用户实际踩到的问题。
void main() {
  const zh = AppStrings(AppLanguage.zh);
  const en = AppStrings(AppLanguage.en);

  test('★ 私聊文案带上部门名', () {
    // 用户反馈：只说「在部门里干了 6 件事」，不知道是哪个部门。
    // bot 可能同时挂好几个部门，必须点名。
    final s = zh.tf('dept.dmProgressIn', {'dept': '商业模式调研组', 'n': 6});
    expect(s, contains('商业模式调研组'));
    expect(s, contains('6'));

    final title = zh.tf('dept.dmProgressMore', {'dept': '商业模式调研组'});
    expect(title, contains('商业模式调研组'));
  });

  test('★ 文案里不得残留未展开的占位符', () {
    // 用户反馈：副标题显示 "dollar-dept · 派给 dollar-fromName" ——
    // 转义写错导致插值没生效，源码里的变量名被直接渲染出来。
    final dollar = String.fromCharCode(0x24);
    final filled = [
      zh.tf('dept.dmProgressIn', {'dept': 'D', 'n': 1}),
      zh.tf('dept.dmProgressMore', {'dept': 'D'}),
      en.tf('dept.dmProgressIn', {'dept': 'D', 'n': 1}),
      en.tf('dept.dmProgressMore', {'dept': 'D'}),
    ];
    for (final s in filled) {
      expect(s.contains('${dollar}dept'), isFalse, reason: 'residue dept: $s');
      expect(
        s.contains('${dollar}fromName'),
        isFalse,
        reason: 'residue fromName: $s',
      );
      expect(s.contains('${dollar}n'), isFalse, reason: 'residue n: $s');
      expect(s.contains('{'), isFalse, reason: 'placeholder not filled: $s');
    }
  });

  test('★ 群聊的「收到 X 消息」文案保持不变', () {
    // 群里确实有多个人在发话，这个说法是对的，别被一起改掉。
    expect(zh.t('dept.received'), '收到');
    expect(zh.tf('dept.messageSuffix', {'n': 2}), contains('2'));
  });
}
