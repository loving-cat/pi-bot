import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/server/options.dart';

void main() {
  test('端口始终传给服务端，空数据目录保留服务端的平台默认值', () {
    expect(const ServerLaunchOptions().env, {'PI_BOT_PORT': '8787'});
    expect(
      const ServerLaunchOptions(port: 9876, dataDir: '  data folder  ').env,
      {'PI_BOT_PORT': '9876', 'PI_BOT_HOME': 'data folder'},
    );
  });

  test('启动参数比较使用规范化的路径和端口', () {
    const a = ServerLaunchOptions(entryPath: ' app.js ', nodePath: ' node ');
    const b = ServerLaunchOptions(entryPath: 'app.js', nodePath: 'node');
    expect(a, b);
    expect(a.hashCode, b.hashCode);
    expect(a, isNot(const ServerLaunchOptions(port: 9876)));
    expect(
      const ServerLaunchOptions(),
      const ServerLaunchOptions(dataDir: ' '),
    );
  });
}
