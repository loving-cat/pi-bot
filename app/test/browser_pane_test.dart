// 内置浏览器栏的状态与策略
//
// 只测纯逻辑和策略函数：真实 webview 要开机跑，单测不碰。
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/browser_pane_state.dart';
import 'package:pi_bot/browser_platform_policy.dart';
import 'package:pi_bot/widgets/attachment_view.dart';

void main() {
  group('normalizeUrl', () {
    test('完整网址原样保留', () {
      expect(normalizeUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
      expect(normalizeUrl('http://example.com/'), 'http://example.com/');
    });

    test('没写协议但有域名：补 https', () {
      expect(normalizeUrl('example.com'), 'https://example.com');
      expect(normalizeUrl('news.ycombinator.com/item?id=1'),
          'https://news.ycombinator.com/item?id=1');
      expect(normalizeUrl('127.0.0.1:8080/x'), 'https://127.0.0.1:8080/x');
    });

    test('★ 危险协议一律拒绝', () {
      for (final bad in [
        'file:///C:/Windows/System32/drivers/etc/hosts',
        'javascript:alert(1)',
        'content://media/external/images/1',
        'data:text/html,<script>alert(1)</script>',
      ]) {
        expect(normalizeUrl(bad), isNull, reason: '应该拒绝：$bad');
      }
    });

    test('不是域名的当搜索词', () {
      final url = normalizeUrl('flutter 侧边栏');
      expect(url, isNotNull);
      expect(url!.startsWith('https://'), isTrue);
      expect(url.contains('q='), isTrue);
    });

    test('空输入没结果', () {
      expect(normalizeUrl(''), isNull);
      expect(normalizeUrl('   '), isNull);
    });
  });

  group('导航策略', () {
    test('只放行 http/https 且有主机名', () {
      expect(allowBrowserNavigation(Uri.parse('https://a.com')), isTrue);
      expect(allowBrowserNavigation(Uri.parse('http://a.com')), isTrue);
      expect(allowBrowserNavigation(Uri.parse('file:///etc/passwd')), isFalse);
      expect(allowBrowserNavigation(Uri.parse('javascript:void(0)')), isFalse);
      expect(allowBrowserNavigation(null), isFalse);
    });

    test('mailto/tel 交给系统，不当页面加载', () {
      // 样例域名用 example.com —— 服务端的密钥扫描会把真实邮箱形状判为泄漏
      expect(isExternalScheme(Uri.parse('mailto:someone@example.com')), isTrue);
      expect(isExternalScheme(Uri.parse('tel:+8610000')), isTrue);
      expect(isExternalScheme(Uri.parse('https://a.com')), isFalse);
    });

    test('Windows 上拦非 http(s) 请求，放行页面自身需要的 data/about/blob', () {
      expect(shouldBlockBrowserRequest(Uri.parse('https://a.com/x')), isFalse);
      expect(shouldBlockBrowserRequest(Uri.parse('file:///c:/x')), isTrue);
      expect(shouldBlockBrowserRequest(Uri.parse('about:blank')), isFalse);
      expect(shouldBlockBrowserRequest(Uri.parse('data:image/png;base64,AA')), isFalse);
    });

    test('内置浏览器只在桌面端提供', () {
      expect(supportsBrowserPane(TargetPlatform.windows), isTrue);
      expect(supportsBrowserPane(TargetPlatform.macOS), isTrue);
      expect(supportsBrowserPane(TargetPlatform.android), isFalse);
      expect(supportsBrowserPane(TargetPlatform.iOS), isFalse);
    });
  });

  group('BrowserPaneState', () {
    test('打开后记录地址与标题栏文本', () {
      final s = BrowserPaneState();
      expect(s.open, isFalse);
      s.openUrl('https://example.com');
      expect(s.open, isTrue);
      expect(s.url, 'https://example.com');
      expect(s.displayUrl, 'https://example.com');
    });

    test('★ 历史可以前后走，新开页会砍掉前进记录', () {
      final s = BrowserPaneState();
      s.openUrl('https://a.com');
      s.openUrl('https://b.com');
      expect(s.canGoBack, isTrue);
      expect(s.back(), 'https://a.com');
      expect(s.canGoForward, isTrue);
      expect(s.forward(), 'https://b.com');
      // 从中间开新页 → 前进记录被砍
      s.back();
      s.openUrl('https://c.com');
      expect(s.canGoForward, isFalse);
      expect(s.url, 'https://c.com');
    });

    test('非法地址不会打开栏', () {
      final s = BrowserPaneState();
      s.openUrl('file:///etc/passwd');
      expect(s.open, isFalse);
    });

    test('关闭清掉活动记录，不影响历史', () {
      final s = BrowserPaneState();
      s.openUrl('https://a.com');
      expect(s.activity.lastTouchedAt(PaneKind.browser), isNotNull);
      s.close();
      expect(s.open, isFalse);
      expect(s.activity.lastTouchedAt(PaneKind.browser), isNull);
      expect(s.history, ['https://a.com']);
    });
  });

  group('通用展示栏：文件模式', () {
    test('★ 展示文件：栏打开、标题是文件名、历史记一条', () {
      final s = BrowserPaneState();
      s.showFile(name: '预算表.xlsx', htmlUrl: '/api/files/abc/html');
      expect(s.open, isTrue);
      expect(s.kind, PaneContentKind.file);
      expect(s.title, '预算表.xlsx');
      expect(s.fileName, '预算表.xlsx');
      expect(s.url, '/api/files/abc/html');
      expect(s.history.last, '/api/files/abc/html');
    });

    test('★ 从文件切回网页：模式与标题都跟着变', () {
      final s = BrowserPaneState();
      s.showFile(name: 'a.xlsx', htmlUrl: '/api/files/x/html');
      s.openUrl('https://example.com/docs');
      expect(s.kind, PaneContentKind.web);
      expect(s.fileName, '');
      expect(s.title, 'example.com');
    });

    test('★ PDF 走内核自带阅读器（nativeViewer）', () {
      final s = BrowserPaneState();
      s.showFile(
        name: '报告.pdf',
        htmlUrl: '/api/files/abc',
        nativeViewer: true,
      );
      expect(s.kind, PaneContentKind.file);
      expect(s.nativeViewer, isTrue);
      expect(s.url, '/api/files/abc', reason: 'PDF 不该走 /html');
    });

    test('表格/Word 仍走服务端渲染的 HTML', () {
      final s = BrowserPaneState();
      s.showFile(name: 'a.xlsx', htmlUrl: '/api/files/x/html');
      expect(s.nativeViewer, isFalse);
    });

    test('从 PDF 切到网页：nativeViewer 复位', () {
      final s = BrowserPaneState();
      s.showFile(name: 'a.pdf', htmlUrl: '/api/files/y', nativeViewer: true);
      s.openUrl('https://example.com');
      expect(s.nativeViewer, isFalse);
      expect(s.kind, PaneContentKind.web);
    });

    test('文件模式不影响前后退', () {
      final s = BrowserPaneState();
      s.openUrl('https://a.com');
      s.showFile(name: 'b.pdf', htmlUrl: '/api/files/y/html');
      expect(s.canGoBack, isTrue);
      expect(s.back(), 'https://a.com');
    });
  });

  group('点文件的落地策略', () {
    test('★ 表格 / PDF / Word 应该进展示栏', () {
      for (final n in ['a.xlsx', 'a.xls', 'a.csv', 'a.tsv', 'a.pdf', 'a.docx']) {
        expect(FileChip.canShowInPane(n), isTrue, reason: '$n 应该能进展示栏');
      }
    });

    test('★ 图片 / HTML / 纯文本不抢展示栏（各有自己的查看器）', () {
      for (final n in ['a.png', 'a.jpg', 'a.html', 'a.md', 'a.txt']) {
        expect(FileChip.canShowInPane(n), isFalse, reason: '$n 不该进展示栏');
      }
    });

    test('大小写不敏感', () {
      expect(FileChip.canShowInPane('REPORT.PDF'), isTrue);
      expect(FileChip.canShowInPane('Data.XLSX'), isTrue);
    });
  });

  group('PaneActivity：放不下时收哪栏', () {
    test('★ 收最早开的那栏', () async {
      final a = PaneActivity();
      a.opened(PaneKind.roomPanel);
      await Future<void>.delayed(const Duration(milliseconds: 15));
      a.opened(PaneKind.browser);
      final oldest = a.oldestAmong([PaneKind.roomPanel, PaneKind.browser]);
      expect(oldest, PaneKind.roomPanel, reason: 'Bot 信息栏开得更早');
    });

    test('★ 后来的操作会改变优先级：没被动过的先收', () async {
      final a = PaneActivity();
      a.opened(PaneKind.browser);
      await Future<void>.delayed(const Duration(milliseconds: 15));
      a.opened(PaneKind.roomPanel);
      // 浏览器栏刚被用户滚过 —— 它不该被收
      a.touched(PaneKind.browser);
      final oldest = a.oldestAmong([PaneKind.roomPanel, PaneKind.browser]);
      expect(oldest, PaneKind.roomPanel);
    });

    test('从没记录过的算最老', () {
      final a = PaneActivity();
      a.opened(PaneKind.roomPanel);
      final oldest = a.oldestAmong([PaneKind.roomPanel, PaneKind.browser]);
      expect(oldest, PaneKind.browser);
    });

    test('候选为空时返回 null，不崩', () {
      final a = PaneActivity();
      expect(a.oldestAmong(const []), isNull);
    });
  });
}
