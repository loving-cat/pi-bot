import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:pi_bot/html_preview_loader.dart';
import 'package:pi_bot/theme.dart';
import 'package:pi_bot/widgets/html_attachment_preview.dart';
import 'package:pi_bot/widgets/offline_html_view.dart';
import 'package:window_manager/window_manager.dart';

const _qaEnabled = bool.fromEnvironment('PI_BOT_HTML_QA');
const _qaOutput = String.fromEnvironment('PI_BOT_HTML_QA_OUTPUT');
const _qaCheckNames = {
  'search',
  'filter',
  'counter',
  'fold',
  'dataImage',
  'rtcUnavailable',
  'bridgeUnavailable',
  'fetchBlocked',
  'imageBlocked',
};

/// 合成 HTML 的原生验收入口；仅运行本次随机回环端口的附件服务。
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  if (Platform.isMacOS || Platform.isWindows || Platform.isLinux) {
    await windowManager.ensureInitialized();
    await windowManager.setTitle('HTML 预览验证（合成数据）');
  }
  runApp(const HtmlPreviewGallery());
}

enum _Sample {
  report('正常报告'),
  offline('离线资源检查'),
  missing('读取失败'),
  oversized('超限文件'),
  timeout('读取超时');

  const _Sample(this.label);
  final String label;
}

class _FixtureLoader extends HtmlPreviewLoader {
  _FixtureLoader(this.onStatus, {this.onFailure})
    : super(timeout: const Duration(seconds: 2));

  final ValueChanged<String> onStatus;
  final ValueChanged<String>? onFailure;

  @override
  Future<String> load(Uri source, {int declaredSize = 0}) async {
    try {
      final html = await super.load(source, declaredSize: declaredSize);
      onStatus('HTML 已读取，等待渲染');
      return html;
    } on HtmlPreviewLoadException catch (error) {
      onStatus('error：${error.message}');
      onFailure?.call(error.code);
      rethrow;
    }
  }
}

class HtmlPreviewGallery extends StatefulWidget {
  const HtmlPreviewGallery({super.key});

  @override
  State<HtmlPreviewGallery> createState() => _HtmlPreviewGalleryState();
}

class _HtmlPreviewGalleryState extends State<HtmlPreviewGallery> {
  HttpServer? _server;
  StreamSubscription<HttpRequest>? _requests;
  String? _serverError;
  _Sample _sample = _Sample.report;
  int _generation = 0;
  int _attachmentRequests = 0;
  int _resourceRequests = 0;
  String _renderStatus = '等待加载';
  String _diagnostic = '尚未创建视图';
  String _externalSelection = '尚未选择外部链接';
  final Map<String, Map<String, Object?>> _qaResults = {};
  Timer? _qaDeadline;
  bool _qaAdvancing = false;
  bool _qaFinishing = false;
  String? _qaFailure;

  @override
  void initState() {
    super.initState();
    if (_qaEnabled) {
      _qaDeadline = Timer(const Duration(seconds: 45), () {
        unawaited(_finishQa(failure: 'total_timeout'));
      });
    }
    unawaited(_startServer());
  }

  Future<void> _startServer() async {
    try {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      if (!mounted) {
        await server.close(force: true);
        return;
      }
      if ({8787, 18787}.contains(server.port)) {
        await server.close(force: true);
        throw StateError('测试端口不可用');
      }
      _server = server;
      _requests = server.listen((request) {
        unawaited(_respond(request).catchError((Object _) {}));
      });
      setState(() {});
    } catch (_) {
      if (mounted) setState(() => _serverError = '无法启动本次合成附件服务。');
      if (_qaEnabled) unawaited(_finishQa(failure: 'fixture_server'));
    }
  }

  void _notify() {
    if (mounted) setState(() {});
  }

  Future<void> _respond(HttpRequest request) async {
    final sampleName = request.uri.path.split('/').last;
    if (!request.uri.path.startsWith('/fixture/')) {
      _resourceRequests++;
      _notify();
      request.response.statusCode = HttpStatus.forbidden;
      request.response.headers.contentType = ContentType.text;
      request.response.write('Fixture request counter');
      await request.response.close();
      return;
    }
    _attachmentRequests++;
    _notify();
    final sample = _Sample.values.firstWhere(
      (item) => item.name == sampleName,
      orElse: () => _Sample.missing,
    );
    if (sample == _Sample.timeout) {
      await Future<void>.delayed(const Duration(seconds: 5));
      request.response.statusCode = HttpStatus.requestTimeout;
      await request.response.close();
      return;
    }
    if (sample == _Sample.missing) {
      request.response.statusCode = HttpStatus.notFound;
      await request.response.close();
      return;
    }
    final body = sample == _Sample.oversized
        ? utf8.encode('x' * (htmlPreviewMaxBytes + 256))
        : utf8.encode(
            _reportHtml(
              networkCheck: sample == _Sample.offline,
              port: _server!.port,
            ),
          );
    request.response.headers.contentType = ContentType(
      'text',
      'html',
      charset: 'utf-8',
    );
    request.response.headers.set('Cache-Control', 'no-store');
    request.response.contentLength = body.length;
    request.response.add(body);
    await request.response.close();
  }

  void _select(_Sample sample) {
    setState(() {
      _sample = sample;
      _generation++;
      _renderStatus = '等待加载';
      _externalSelection = '尚未选择外部链接';
    });
  }

  void _recordStatus(String status, int generation) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && generation == _generation) {
        setState(() => _renderStatus = status);
      }
    });
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  void _recordDiagnostic(String stage, int generation) {
    if (!mounted || generation != _generation) return;
    if (_qaEnabled && stage.startsWith('qa-result:')) {
      try {
        final decoded = jsonDecode(stage.substring('qa-result:'.length));
        final Object? payload = decoded is Map && decoded.containsKey('checks')
            ? decoded['checks']
            : decoded;
        if (payload is! Map ||
            payload.length != _qaCheckNames.length ||
            payload.keys.any((key) => !_qaCheckNames.contains(key)) ||
            payload.values.any((value) => value is! bool)) {
          throw const FormatException('invalid_checks');
        }
        final checks = Map<String, bool>.from(payload);
        unawaited(
          _completeQaSample(generation, {
            'passed': checks.values.every((value) => value),
            'checks': checks,
          }),
        );
      } catch (_) {
        unawaited(
          _completeQaSample(generation, {
            'passed': false,
            'error': 'invalid_diagnostic',
          }),
        );
      }
      return;
    }
    setState(() {
      _diagnostic = [
        ..._diagnostic.split(' · '),
        stage,
      ].reversed.take(6).toList().reversed.join(' · ');
    });
  }

  void _recordLoadFailure(String code, int generation) {
    if (!_qaEnabled || !mounted || generation != _generation) return;
    final expected = switch (_sample) {
      _Sample.missing => 'http',
      _Sample.oversized => 'too_large',
      _Sample.timeout => 'timeout',
      _ => null,
    };
    unawaited(
      _completeQaSample(generation, {
        'passed': expected != null && code == expected,
        'expectedError': expected,
        'actualError': code,
      }),
    );
  }

  Future<void> _completeQaSample(
    int generation,
    Map<String, Object?> result,
  ) async {
    if (!_qaEnabled ||
        _qaAdvancing ||
        _qaFinishing ||
        !mounted ||
        generation != _generation) {
      return;
    }
    _qaAdvancing = true;
    await Future<void>.delayed(const Duration(milliseconds: 300));
    if (_qaFinishing || !mounted || generation != _generation) return;
    _qaResults[_sample.name] = {
      ...result,
      'passed': result['passed'] == true && _resourceRequests == 0,
      'attachmentRequests': _attachmentRequests,
      'resourceRequests': _resourceRequests,
    };
    if (!await _writeQaEvidence(completed: false)) {
      await _finishQa(failure: 'evidence_write');
      return;
    }
    if (_sample == _Sample.values.last) {
      await _finishQa();
    } else {
      _select(_Sample.values[_sample.index + 1]);
      _qaAdvancing = false;
    }
  }

  Future<bool> _writeQaEvidence({required bool completed}) async {
    if (_qaOutput.isEmpty) return true;
    try {
      await File(_qaOutput).writeAsString(
        const JsonEncoder.withIndent('  ').convert({
          'fixture': 'pi-bot-html-preview',
          'syntheticOnly': true,
          'bridgeCheckScope': ['flutter_inappwebview', 'chrome', 'external'],
          'webkitNamespace': 'displayed_for_observation_only',
          'completed': completed,
          'passed':
              completed &&
              _qaFailure == null &&
              _qaResults.length == _Sample.values.length &&
              _qaResults.values.every((result) => result['passed'] == true) &&
              _attachmentRequests == _Sample.values.length &&
              _resourceRequests == 0,
          'failure': _qaFailure,
          'diagnostic': _diagnostic,
          'currentSample': _sample.name,
          'attachmentRequests': _attachmentRequests,
          'resourceRequests': _resourceRequests,
          'samples': {
            for (final sample in _Sample.values)
              sample.name:
                  _qaResults[sample.name] ??
                  {
                    'passed': false,
                    'status': sample == _sample ? 'incomplete' : 'not_run',
                  },
          },
        }),
        flush: true,
      );
      return true;
    } catch (_) {
      _qaFailure = 'evidence_write';
      return false;
    }
  }

  Future<void> _finishQa({String? failure}) async {
    if (!_qaEnabled || _qaFinishing) return;
    _qaFinishing = true;
    _qaDeadline?.cancel();
    _qaFailure ??= failure;
    final written = await _writeQaEvidence(completed: true);
    final success =
        written &&
        _qaFailure == null &&
        _qaResults.length == _Sample.values.length &&
        _qaResults.values.every((result) => result['passed'] == true) &&
        _attachmentRequests == _Sample.values.length &&
        _resourceRequests == 0;
    await _requests?.cancel();
    await _server?.close(force: true);
    _requests = null;
    _server = null;
    exit(success ? 0 : 1);
  }

  @override
  void dispose() {
    _generation++;
    _qaDeadline?.cancel();
    final requests = _requests;
    final server = _server;
    if (requests != null) unawaited(requests.cancel());
    if (server != null) unawaited(server.close(force: true));
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final server = _server;
    final generation = _generation;
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: PB.theme(),
      home: Scaffold(
        appBar: AppBar(title: const Text('HTML 预览验证（合成数据）')),
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('仅使用本次随机本机端口，不连接模型、用户配置或外网。'),
                  const SizedBox(height: 6),
                  Text(
                    '附件读取：$_attachmentRequests · 网页资源请求：$_resourceRequests（期望 0）',
                    key: const ValueKey('html-gallery-request-counts'),
                  ),
                  Text('渲染回调：$_renderStatus'),
                  Text('平台阶段：$_diagnostic'),
                  Text('外部链接：$_externalSelection'),
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      for (final sample in _Sample.values)
                        ChoiceChip(
                          label: Text(sample.label),
                          selected: sample == _sample,
                          onSelected: _qaEnabled
                              ? null
                              : (_) => _select(sample),
                          labelStyle: TextStyle(
                            color: sample == _sample
                                ? PB.textPrimary
                                : PB.textSecondary,
                          ),
                          selectedColor: PB.bgActive,
                          backgroundColor: PB.bgPane,
                          side: const BorderSide(color: PB.borderTertiary),
                        ),
                      TextButton(
                        onPressed: _qaEnabled ? null : () => _select(_sample),
                        child: const Text('重新加载'),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            const Divider(height: 1),
            Expanded(
              child: _serverError != null
                  ? Center(child: Text(_serverError!))
                  : server == null
                  ? const Center(child: CircularProgressIndicator())
                  : HtmlAttachmentPreview(
                      key: ValueKey(generation),
                      source: Uri(
                        scheme: 'http',
                        host: '127.0.0.1',
                        port: server.port,
                        path: '/fixture/${_sample.name}',
                        queryParameters: {'generation': '$generation'},
                      ),
                      loaderFactory: () => _FixtureLoader(
                        (status) => _recordStatus(status, generation),
                        onFailure: (code) =>
                            _recordLoadFailure(code, generation),
                      ),
                      onExternalLink: (uri) async {
                        if (mounted && generation == _generation) {
                          setState(() {
                            _externalSelection = '${uri.host}（只记录，不打开浏览器）';
                          });
                        }
                      },
                      rendererBuilder:
                          (
                            context, {
                            required html,
                            required onReady,
                            required onError,
                            required onExternalLink,
                          }) => OfflineHtmlView(
                            html: html,
                            onDiagnostic: (stage) =>
                                _recordDiagnostic(stage, generation),
                            onReady: () {
                              onReady();
                              _recordStatus('ready', generation);
                            },
                            onError: (message) {
                              onError(message);
                              _recordStatus('error：$message', generation);
                              if (_qaEnabled) {
                                unawaited(
                                  _completeQaSample(generation, {
                                    'passed': false,
                                    'error': 'renderer_error',
                                  }),
                                );
                              }
                            },
                            onExternalLink: onExternalLink,
                          ),
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

String _reportHtml({required bool networkCheck, required int port}) {
  final localBase = 'http://127.0.0.1:$port';
  final resourceMarkup = networkCheck
      ? '<img id="network-image" alt="外部图片应被阻止" width="180" height="24">'
      : '';
  final resourceScript = networkCheck
      ? '''const imageOutcome=new Promise(resolve=>{
  const image=document.getElementById('network-image');
  image.addEventListener('load',()=>resolve(false),{once:true});
  image.addEventListener('error',()=>resolve(true),{once:true});
  setTimeout(()=>resolve(false),2500);
  image.src='$localBase/blocked-image';
});
const fetchOutcome=fetch('$localBase/blocked-fetch').then(() => {
  document.getElementById('network').textContent = '请求已完成，请核对宿主计数';
  return false;
}).catch(() => {
  document.getElementById('network').textContent = 'fetch 已被阻止';
  return true;
});'''
      : """document.getElementById('network').textContent = '此页没有网络资源';
const imageOutcome=Promise.resolve(true);
const fetchOutcome=Promise.resolve(true);""";
  final qaScript = _qaEnabled
      ? '''async function runFixtureChecks(){
  const checks={search:false,filter:false,counter:false,fold:false,dataImage:false,rtcUnavailable:false,bridgeUnavailable:false,fetchBlocked:false,imageBlocked:false};
  try {
    const search=document.getElementById('search');
    const category=document.getElementById('category');
    const visibleRows=()=>Array.from(document.querySelectorAll('tr[data-category]')).filter(row=>!row.hidden);
    search.value='Alpha';search.dispatchEvent(new Event('input',{bubbles:true}));
    checks.search=visibleRows().length===1&&visibleRows()[0].textContent.includes('Alpha')&&document.getElementById('visible').textContent==='显示 1 条';
    search.value='';search.dispatchEvent(new Event('input',{bubbles:true}));
    category.value='research';category.dispatchEvent(new Event('change',{bubbles:true}));
    checks.filter=visibleRows().length===2&&visibleRows().every(row=>row.dataset.category==='research')&&document.getElementById('visible').textContent==='显示 2 条';
    category.value='all';category.dispatchEvent(new Event('change',{bubbles:true}));
    const counter=document.getElementById('counter');counter.click();
    checks.counter=counter.textContent==='点击计数：1';
    const details=document.querySelector('details');details.querySelector('summary').click();
    checks.fold=details.open&&details.textContent.includes('展开无需联网');
    const embedded=document.getElementById('data-image');
    checks.dataImage=await new Promise(resolve=>{
      const loaded=()=>resolve(embedded.complete&&embedded.naturalWidth===1&&embedded.naturalHeight===1);
      if(embedded.complete){loaded();return;}
      embedded.addEventListener('load',loaded,{once:true});
      embedded.addEventListener('error',()=>resolve(false),{once:true});
      setTimeout(()=>resolve(false),2500);
    });
    checks.rtcUnavailable=typeof window.RTCPeerConnection==='undefined';
    checks.bridgeUnavailable=[typeof window.flutter_inappwebview,typeof window.chrome,typeof window.external].every(value=>value==='undefined');
    checks.fetchBlocked=await Promise.race([fetchOutcome,new Promise(resolve=>setTimeout(()=>resolve(false),2500))]);
    checks.imageBlocked=await imageOutcome;
  } catch(_) {}
  parent.postMessage({type:'pi-html-fixture',checks},'*');
}
setTimeout(runFixtureChecks,50);'''
      : '';
  return '''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>合成项目资料报告</title><style>
body{margin:0;padding:24px;font:15px/1.6 system-ui,sans-serif;color:#27313b;background:#f6f7f9}
main{max-width:900px;margin:auto}h1{font-size:25px;margin:0 0 4px}p{margin:6px 0 18px}
.tools,.card{padding:16px;background:#fff;border:1px solid #dce0e5;border-radius:12px;margin:14px 0}
.tools{display:flex;gap:10px;flex-wrap:wrap}input,select,button{font:inherit;padding:7px 10px;border:1px solid #ccd3db;border-radius:7px}
button{cursor:pointer;background:#edf3fb;color:#234f85}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 10px;border-bottom:1px solid #e5e9ed}
th{background:#f3f6f8}details{margin:12px 0}summary{cursor:pointer;font-weight:600}code{font-size:13px}small{color:#68717d}
</style></head><body><main>
<h1>合成项目资料报告</h1><p>搜索、分类、折叠和按钮计数均由文档内脚本处理。</p>
<div class="tools"><input id="search" placeholder="搜索名称" aria-label="搜索名称">
<select id="category" aria-label="筛选类别"><option value="all">全部类别</option><option value="research">研究</option><option value="delivery">交付</option></select>
<button id="counter">点击计数：0</button><span id="visible">显示 3 条</span></div>
<section class="card"><table><thead><tr><th>名称</th><th>类别</th><th>状态</th></tr></thead><tbody>
<tr data-category="research"><td>Alpha 资料核对</td><td>研究</td><td>已完成</td></tr>
<tr data-category="delivery"><td>Beta 页面整理</td><td>交付</td><td>待复核</td></tr>
<tr data-category="research"><td>Gamma 方法说明</td><td>研究</td><td>草稿</td></tr>
</tbody></table><details><summary>展开补充说明</summary><p>这是随报告保留的本地内容，展开无需联网。</p></details></section>
<section class="card"><h2>内嵌图片</h2>
<img id="data-image" alt="内嵌测试图" width="64" height="32" style="image-rendering:pixelated;background:#d9e8f6" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMw6v/wHwAFWQKxr17fHgAAAABJRU5ErkJggg==">
$resourceMarkup</section>
<section class="card"><h2>预览状态</h2><p id="network">等待脚本初始化</p><table>
<tr><th>RTC 类型</th><td id="rtc">待检查</td></tr><tr><th>原生桥类型</th><td id="bridge">待检查</td></tr>
<tr><th>文档地址</th><td id="location">待检查</td></tr></table>
<p><a href="https://example.org/report-reference">合成外部资料链接</a> <small>通过宿主外部链接列表确认，本验证只记录选择。</small></p></section>
</main><script>
let count=0;
function filterRows(){const q=document.getElementById('search').value.toLowerCase();const c=document.getElementById('category').value;let visible=0;
document.querySelectorAll('tr[data-category]').forEach(row=>{const show=row.textContent.toLowerCase().includes(q)&&(c==='all'||row.dataset.category===c);row.hidden=!show;if(show)visible++;});
document.getElementById('visible').textContent='显示 '+visible+' 条';}
document.getElementById('search').addEventListener('input',filterRows);
document.getElementById('category').addEventListener('change',filterRows);
document.getElementById('counter').addEventListener('click',()=>{count++;document.getElementById('counter').textContent='点击计数：'+count;});
document.getElementById('rtc').textContent=typeof window.RTCPeerConnection;
document.getElementById('bridge').textContent=[typeof window.flutter_inappwebview,typeof window.webkit,typeof window.chrome,typeof window.external].join(' / ');
document.getElementById('location').textContent=location.href;
$resourceScript
$qaScript
</script></body></html>''';
}
