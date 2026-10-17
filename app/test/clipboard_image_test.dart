import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/clipboard_image.dart';

void main() {
  test('从 PowerShell 输出里取出临时 PNG 路径', () {
    const out = r'''
Add-Type : something
C:\Users\you\AppData\Local\Temp\pi-bot-paste-abc.png
''';
    expect(
      clipboardImagePathFromOutput(out),
      r'C:\Users\you\AppData\Local\Temp\pi-bot-paste-abc.png',
    );
  });

  test('没有图（空输出 / 其它输出）就是 null', () {
    expect(clipboardImagePathFromOutput(''), isNull);
    expect(clipboardImagePathFromOutput('Add-Type : missing assembly'), isNull);
    expect(clipboardImagePathFromOutput(r'C:\tmp\x.txt'), isNull);
  });
}
