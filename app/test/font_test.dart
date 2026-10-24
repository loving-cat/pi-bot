// 字体的两条铁律。都不是"样式好不好看"，而是"改了却一点用没有"这种坑。
//
// 1. 随包的中文字体必须**真的被用上**。
//    TextStyle 只要显式写了 fontFamily，它就不再继承 ThemeData 上的
//    fontFamilyFallback —— 汉字于是去问系统默认字体（Windows 是雅黑），
//    随包的 NotoSansSC 排不上。表现是：改了字体，界面一点没变。
//
// 2. 中文必须能吃到连续的字重。
//    雅黑只有 Regular / Bold 两档：w500 和 w400 渲染结果逐像素相同，
//    w600 直接跳到 Bold（墨量约 1.6 倍）。一屏之内拉丁是 Inter 的
//    semi-bold、中文却是粗黑，字重就断档了 —— 这是"中英混排不齐"的根因。
//    换成带 wght 轴的可变字体后，w400/500/600 才是连续的。
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/theme.dart';

const _fontFiles = {
  'Inter': 'assets/fonts/Inter.ttf',
  'NotoSansSC': 'assets/fonts/NotoSansSC.ttf',
};

Future<void> _loadFonts() async {
  for (final e in _fontFiles.entries) {
    final loader = FontLoader(e.key);
    final bytes = File(e.value).readAsBytesSync();
    loader.addFont(Future.value(ByteData.view(bytes.buffer)));
    await loader.load();
  }
}

void main() {
  test('中文字体随包存在，且是可变字重（不是两档）', () {
    for (final path in _fontFiles.values) {
      expect(File(path).existsSync(), isTrue, reason: '$path 必须随包分发');
    }
    // NotoSansSC 由 tools/subset-font.py 生成，丢了 fvar 就退化成单字重，
    // 中文字重会重新变成"要么不变、要么跳粗体"。
    final bytes = File('assets/fonts/NotoSansSC.ttf').readAsBytesSync();
    final tags = <String>{};
    final numTables = bytes[4] << 8 | bytes[5];
    for (var i = 0; i < numTables; i++) {
      final off = 12 + i * 16;
      tags.add(String.fromCharCodes(bytes.sublist(off, off + 4)));
    }
    expect(tags.contains('fvar'), isTrue, reason: '字重轴（fvar）不能丢');
    expect(tags.contains('gvar'), isTrue, reason: '可变字形（gvar）不能丢');
  });

  testWidgets('主题里的样式必须带 CJK 回落', (tester) async {
    final theme = PB.theme();
    for (final entry in {
      'bodyMedium': theme.textTheme.bodyMedium,
      'bodySmall': theme.textTheme.bodySmall,
      'titleMedium': theme.textTheme.titleMedium,
      'titleLarge': theme.textTheme.titleLarge,
    }.entries) {
      expect(
        entry.value?.fontFamily,
        PB.fontFamily,
        reason: '${entry.key} 用 Inter 打底',
      );
      expect(
        entry.value?.fontFamilyFallback,
        contains(PB.cjkFamily),
        reason: '${entry.key} 必须把汉字交给随包的中文字体',
      );
    }
  });

  testWidgets('页面里只写 fontSize 的 TextStyle 也拿到中文字体', (tester) async {
    // 侧边栏房间名就是这么写的：const TextStyle(fontSize:..., fontWeight:...)
    // 它靠 DefaultTextStyle 继承字体 —— 这条链断了，汉字就落回系统字体。
    TextStyle? effective;
    await tester.pumpWidget(
      MaterialApp(
        theme: PB.theme(),
        home: Scaffold(
          body: Builder(
            builder: (ctx) {
              const own = TextStyle(
                fontSize: PB.fsBase,
                fontWeight: FontWeight.w600,
              );
              effective = DefaultTextStyle.of(ctx).style.merge(own);
              return const Text('二组运营总监', style: own);
            },
          ),
        ),
      ),
    );
    await tester.pump();

    expect(effective?.fontFamily, PB.fontFamily);
    expect(
      effective?.fontFamilyFallback,
      contains(PB.cjkFamily),
      reason: '继承链上必须带着 CJK 回落，否则汉字走系统字体',
    );
  });

  group('中文字重的连续性（真渲染，比墨量）', () {
    /// 渲染一段中文，返回墨量。墨量随字重单调增，用来看字重轴是否连续。
    Future<double> ink(WidgetTester tester, FontWeight w) async {
      const key = ValueKey('ink');
      await tester.pumpWidget(
        Directionality(
          textDirection: TextDirection.ltr,
          child: Center(
            child: RepaintBoundary(
              key: key,
              child: Container(
                color: const Color(0xFF000000),
                padding: const EdgeInsets.all(8),
                child: Text(
                  '运营总监',
                  textDirection: TextDirection.ltr,
                  style: TextStyle(
                    fontFamily: PB.fontFamily,
                    fontFamilyFallback: PB.fontFallback,
                    fontSize: 32,
                    fontWeight: w,
                    height: 1.2,
                    color: const Color(0xFFFFFFFF),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      final boundary = tester.renderObject<RenderRepaintBoundary>(
        find.byKey(key),
      );
      final img = await tester.runAsync(() => boundary.toImage());
      final data = await tester.runAsync(
        () => img!.toByteData(format: ui.ImageByteFormat.rawRgba),
      );
      // ★ 不能求和 alpha：整张图是不透明的（alpha 恒为 255），
      //   那样算出来的"墨量"其实等于像素总数，任何字重都一样。
      //   要按**亮度**累加，笔画变粗才有区别。
      final bytes = data!.buffer.asUint8List();
      var sum = 0.0;
      for (var i = 0; i < bytes.length; i += 4) {
        sum += bytes[i] * 0.299 + bytes[i + 1] * 0.587 + bytes[i + 2] * 0.114;
      }
      return sum / 255.0;
    }

    testWidgets('w400 < w500 < w600 且不跳粗体', (tester) async {
      // 字体必须在这个 testWidgets 里加载：pumpWidget 会重置 binding，
      // setUpAll 里装的字体到这里已经不在登记表里了。
      await _loadFonts();
      final w400 = await ink(tester, FontWeight.w400);
      final w500 = await ink(tester, FontWeight.w500);
      final w600 = await ink(tester, FontWeight.w600);

      expect(w500, greaterThan(w400), reason: '雅黑时代这里是相等的（w500 完全无效）');
      expect(w600, greaterThan(w500));
      // 雅黑时代 w600/w400 = 1.62（直接变成 Bold）；可变字体约 1.3
      expect(w600 / w400, lessThan(1.45), reason: 'w600 应该是 semi-bold，不是粗体');
    }, timeout: const Timeout(Duration(minutes: 2)));
  });
}
