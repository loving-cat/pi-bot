import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/clipboard_image.dart';
import 'package:pi_bot/clipboard_image_macos.dart';

void main() {
  test('从 PowerShell 输出里取出临时 PNG 路径', () {
    const out = r'''
Add-Type : something
C:\Users\user\AppData\Local\Temp\pi-bot-paste-abc.png
''';
    expect(
      clipboardImagePathFromOutput(out),
      r'C:\Users\user\AppData\Local\Temp\pi-bot-paste-abc.png',
    );
  });

  test('没有图（空输出 / 其它输出）就是 null', () {
    expect(clipboardImagePathFromOutput(''), isNull);
    expect(clipboardImagePathFromOutput('Add-Type : missing assembly'), isNull);
    expect(clipboardImagePathFromOutput(r'C:\tmp\x.txt'), isNull);
  });

  group('macOS 剪贴板图片', () {
    final png = base64Decode(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=',
    );
    late Directory root;

    setUp(() {
      root = Directory.systemTemp.createTempSync('pi-bot-clipboard-test-');
    });

    tearDown(() async {
      await root.delete(recursive: true);
    });

    test('PNG 签名排除空内容、截断签名和其它格式', () {
      expect(hasClipboardPngSignature(png), isTrue);
      expect(hasClipboardPngSignature([]), isFalse);
      expect(hasClipboardPngSignature(png.take(7).toList()), isFalse);
      expect(hasClipboardPngSignature([71, 73, 70, 56, 57, 97, 0, 0]), isFalse);
    });

    test('读回 PNG 后立即清理临时目录', () async {
      final result = await readMacOSClipboardPng(
        temporaryRoot: root,
        startProcess: (executable, arguments) async {
          expect(executable, '/usr/bin/osascript');
          expect(arguments.take(3), ['-l', 'JavaScript', '-e']);
          await File(arguments.last).writeAsBytes(png);
          return _ClipboardProcess.completed(0);
        },
      );
      expect(result, png);
      expect(root.listSync(), isEmpty);
    });

    test('无图、空文件和非 PNG 内容返回 null 并清理', () async {
      for (final contents in [
        null,
        <int>[],
        [1, 2, 3, 4],
      ]) {
        final result = await readMacOSClipboardPng(
          temporaryRoot: root,
          startProcess: (executable, arguments) async {
            if (contents != null) {
              await File(arguments.last).writeAsBytes(contents);
            }
            return _ClipboardProcess.completed(0);
          },
        );
        expect(result, isNull);
        expect(root.listSync(), isEmpty);
      }
    });

    test('进程非零退出或启动异常时清理', () async {
      final result = await readMacOSClipboardPng(
        temporaryRoot: root,
        startProcess: (executable, arguments) async {
          await File(arguments.last).writeAsBytes(png);
          return _ClipboardProcess.completed(1);
        },
      );
      expect(result, isNull);
      expect(root.listSync(), isEmpty);
      expect(
        await readMacOSClipboardPng(
          temporaryRoot: root,
          startProcess: (executable, arguments) async {
            throw const ProcessException('osascript', [], 'start failed');
          },
        ),
        isNull,
      );
      expect(root.listSync(), isEmpty);
    });

    test('超时先 kill 并等退出，迟到写入仍被清理', () async {
      final exit = Completer<int>();
      late _ClipboardProcess process;
      final result = await readMacOSClipboardPng(
        temporaryRoot: root,
        timeout: const Duration(milliseconds: 10),
        startProcess: (executable, arguments) async {
          process = _ClipboardProcess(
            exit.future,
            onKill: () {
              Future<void>.delayed(const Duration(milliseconds: 20), () async {
                await File(arguments.last).writeAsBytes(png);
                exit.complete(-9);
              });
            },
          );
          return process;
        },
      );
      expect(result, isNull);
      expect(process.signals, [ProcessSignal.sigkill]);
      expect(exit.isCompleted, isTrue);
      expect(root.listSync(), isEmpty);
    });

    test('并发读取使用不同的私有目录', () async {
      final paths = <String>[];
      final results = await Future.wait(
        List.generate(
          4,
          (_) => readMacOSClipboardPng(
            temporaryRoot: root,
            startProcess: (executable, arguments) async {
              paths.add(arguments.last);
              await File(arguments.last).writeAsBytes(png);
              return _ClipboardProcess.completed(0);
            },
          ),
        ),
      );
      expect(paths.toSet(), hasLength(4));
      expect(results, everyElement(png));
      expect(root.listSync(), isEmpty);
    });

    test('中文、空格与引号路径仅经 argv 传递', () async {
      // Windows 不允许文件名里出现 `"`（CreateProcess 的 argv 也不会经过 shell），
      // 所以引号只在 POSIX 上测；其余特殊字符两边都测。
      final specialName = Platform.isWindows
          ? "中文 space ' quote \$ dollar"
          : '中文 space \' quote " \$ dollar';
      final special = await Directory(
        '${root.path}${Platform.pathSeparator}$specialName',
      ).create();
      final result = await readMacOSClipboardPng(
        temporaryRoot: special,
        startProcess: (executable, arguments) async {
          expect(arguments.last, startsWith(special.path));
          expect(arguments[3], isNot(contains(special.path)));
          expect(arguments[3], contains('argv[0]'));
          await File(arguments.last).writeAsBytes(png);
          return _ClipboardProcess.completed(0);
        },
      );
      expect(result, png);
      expect(special.listSync(), isEmpty);
    });
  });
}

class _ClipboardProcess implements Process {
  _ClipboardProcess(this.exitCode, {this.onKill});

  _ClipboardProcess.completed(int code) : this(Future.value(code));

  final void Function()? onKill;
  final signals = <ProcessSignal>[];

  @override
  final Future<int> exitCode;

  @override
  int get pid => 1;

  @override
  Stream<List<int>> get stdout => const Stream.empty();

  @override
  Stream<List<int>> get stderr => const Stream.empty();

  @override
  IOSink get stdin => throw UnimplementedError();

  @override
  bool kill([ProcessSignal signal = ProcessSignal.sigterm]) {
    signals.add(signal);
    onKill?.call();
    return true;
  }
}
