import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// 界面文案里不该出现开发期的内部术语。
///
/// 这些词是「让 agent 开发这个项目时方便理解架构」用的：
/// 主控、总经理、花名册、部门、派活、班子。
/// 用户看到只会困惑 —— “这里为什么有个总经理？”
/// 产品里该说人话：助手、成员、团队、分工。
///
/// 直接扫文案表文件，而不是走 AppStrings 的 key 遍历：
/// 文案表是唯一的事实来源，扫文件能同时覆盖 key 名和值。
void main() {
  /// 禁用词 → 应该怎么说
  const banned = <String, String>{
    '主控': '助手',
    '总经理': '助手',
    '花名册': '成员',
    '派活': '分工 / 安排',
    '班子': '配置 / 团队',
  };

  /// 英文侧的同类问题
  const bannedEn = <String>['main bot', 'Main bot', 'roster', 'Roster'];

  late List<File> files;

  setUpAll(() {
    final dir = Directory('lib/l10n/strings');
    expect(dir.existsSync(), isTrue, reason: '找不到文案目录 lib/l10n/strings');
    files = dir.listSync().whereType<File>().where((f) => f.path.endsWith('.dart')).toList();
    expect(files, isNotEmpty);
  });

  test('中文文案值里没有内部术语', () {
    final problems = <String>[];
    for (final f in files) {
      final lines = f.readAsLinesSync();
      for (var i = 0; i < lines.length; i++) {
        final line = lines[i];
        final trimmed = line.trimLeft();
        // 注释里保留内部术语是好事（帮助维护者理解架构），不查
        if (trimmed.startsWith('//')) continue;
        // 只看有中文文案值的行（形如 'key': '值'）
        if (!line.contains("':")) continue;
        for (final entry in banned.entries) {
          if (line.contains(entry.key)) {
            problems.add(
              '${f.path}:${i + 1} 含「${entry.key}」（应改成「${entry.value}」）',
            );
          }
        }
      }
    }
    expect(problems, isEmpty, reason: problems.join('\n'));
  });

  test('英文文案值里没有 main bot / roster / manager', () {
    final problems = <String>[];
    for (final f in files) {
      final lines = f.readAsLinesSync();
      for (var i = 0; i < lines.length; i++) {
        final line = lines[i];
        if (line.trimLeft().startsWith('//')) continue;
        if (!line.contains("':")) continue;
        for (final term in bannedEn) {
          if (line.contains(term)) {
            problems.add('${f.path}:${i + 1} 含「$term」');
          }
        }
      }
    }
    expect(problems, isEmpty, reason: problems.join('\n'));
  });

  test('助手这个说法本身在文案里存在（确认替换落到了实处）', () {
    final all = files.map((f) => f.readAsStringSync()).join('\n');
    expect(all.contains('助手'), isTrue, reason: '应该已经用「助手」替换掉旧词');
  });
}
