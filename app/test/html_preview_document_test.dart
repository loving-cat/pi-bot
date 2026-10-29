import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:html/parser.dart' as parser;
import 'package:pi_bot/html_preview_document.dart';

String _child(String shell) {
  final match = RegExp("atob\\('([A-Za-z0-9+/=]+)'\\)").firstMatch(shell)!;
  return utf8.decode(base64Decode(match.group(1)!));
}

Map<String, dynamic> _payload(String shell) {
  final match = RegExp("atob\\('([A-Za-z0-9+/=]+)'\\)")
      .firstMatch(_child(shell))!;
  return jsonDecode(utf8.decode(base64Decode(match.group(1)!)))
      as Map<String, dynamic>;
}

void main() {
  test('普通构建不包含原生验收结果通道', () {
    expect(offlineHtmlQaEnabled, false);
    final shell = buildOfflineHtmlDocument('<p>普通报告</p>');
    expect(shell, isNot(contains('pi-html-fixture')));
    expect(shell, isNot(contains('PI_BOT_HTML_QA:')));
  });
  test('HTML和结束标签只作为编码数据进入宿主壳', () {
    const html =
        '<h1>报告 😀</h1><script>const x="</script><iframe srcdoc="bad">";</script>';
    final shell = buildOfflineHtmlDocument(html);
    final doc = parser.parse(shell);
    expect(doc.querySelectorAll('iframe'), hasLength(1));
    expect(doc.querySelectorAll('script'), hasLength(1));
    expect(doc.querySelector('iframe')!.attributes['sandbox'], 'allow-scripts');
    expect(shell, isNot(contains('报告 😀')));
    expect(shell, isNot(contains('<iframe srcdoc="bad"')));
    expect(_payload(shell)['body'], contains('报告 😀'));
  });

  test('保留内嵌样式、内容与脚本，执行前必须完成防护', () {
    final shell = buildOfflineHtmlDocument(
      '<html><head><style>table{color:red}</style></head>'
      '<body class="report"><input id="search"><table><tr><td>内容</td></tr></table>'
      '<script>document.querySelector("table").hidden=false;</script></body></html>',
    );
    final payload = _payload(shell);
    expect(payload['head'], contains('table{color:red}'));
    expect(payload['body'], contains('<table>'));
    expect(payload['bodyAttributes'], {'class': 'report'});
    expect(payload['scripts'], hasLength(1));
    expect(
      _child(shell).indexOf("if(window.__piOfflineGuardReady!==true)"),
      lessThan(_child(shell).indexOf('const report=JSON.parse')),
    );
  });

  test('剥离原文嵌套文档、远程脚本、导航和预连接元数据', () {
    final payload = _payload(
      buildOfflineHtmlDocument('''
<base href="https://example.org"><meta http-equiv="refresh" content="0;url=https://example.org">
<link rel="dns-prefetch" href="//example.org"><iframe srcdoc="bad"></iframe>
<object data="file:///fixture"></object><input type="file"><script src="https://example.org/app.js"></script>
<p>保留正文</p><script type="application/json" id="data">{"n":1}</script>
'''),
    );
    final doc = parser.parse('${payload['head']}${payload['body']}');
    expect(
      doc.querySelectorAll(
        'iframe,object,base,link,meta[http-equiv],input[type=file],script[src]',
      ),
      isEmpty,
    );
    expect(doc.getElementById('data')!.text, '{"n":1}');
    expect(payload['body'], contains('保留正文'));
  });

  test('只列静态公共HTTPS外链，解码HTML实体且去重', () {
    final links = externalHtmlLinks(
      '''<a href="https://example.org/report?a=1&amp;b=2">资料</a>
<a href="https://example.org/report?a=1&amp;b=2">重复</a><a href="#part">内部</a>
<a href="https://localhost/path">本机</a><a href="https://127.0.0.1/">回环</a>
<a href="https://user:password@example.org">凭据</a><a href="javascript:alert(1)">脚本</a>''',
    );
    expect(links.map((uri) => uri.toString()).toList(), [
      'https://example.org/report?a=1&b=2',
    ]);
  });

  test('完整源与展开壳分别限量，不截断后交浏览器', () {
    expect(
      () => buildOfflineHtmlDocument('x' * (htmlPreviewSourceLimit + 1)),
      throwsFormatException,
    );
    expect(
      () => buildOfflineHtmlDocument('\\' * htmlPreviewSourceLimit),
      throwsFormatException,
    );
    expect(
      utf8.encode(buildOfflineHtmlDocument('<p>small</p>')).length,
      lessThan(htmlPreviewShellLimit),
    );
  });

  test('每个文档使用独立握手标记，只接受当前子帧', () {
    final first = buildOfflineHtmlDocument('<p>same</p>');
    final second = buildOfflineHtmlDocument('<p>same</p>');
    expect(first, isNot(second));
    expect(first, contains('event.source!==frame.contentWindow'));
    expect(first, contains("dataset.previewError='true'"));
    expect(first, isNot(contains('allow-same-origin')));
  });

  test('保留根元素数据属性及本地脚本初始化属性', () {
    final payload = _payload(
      buildOfflineHtmlDocument(
        '<html lang="zh-CN" data-mode="report"><body data-sort="name" onload="init()">'
        '<script id="setup" data-config="local">function init(){}</script></body></html>',
      ),
    );
    expect(payload['htmlAttributes'], containsPair('data-mode', 'report'));
    expect(payload['bodyAttributes'], containsPair('data-sort', 'name'));
    expect(payload['bodyAttributes'], containsPair('onload', 'init()'));
    expect(
      (payload['scripts'] as List).single['attributes'],
      containsPair('data-config', 'local'),
    );
  });
}
