import 'dart:convert';
import 'dart:math';

import 'package:html/dom.dart' as dom;
import 'package:html/parser.dart' as parser;

import 'html_preview_platform_policy.dart';

const htmlPreviewSourceLimit = 1024 * 1024;
const htmlPreviewShellLimit = 2 * 1024 * 1024;
const offlineHtmlQaEnabled = bool.fromEnvironment('PI_BOT_HTML_QA');
const offlineHtmlQaChecks = <String>[
  'search',
  'filter',
  'counter',
  'fold',
  'dataImage',
  'rtcUnavailable',
  'bridgeUnavailable',
  'fetchBlocked',
  'imageBlocked',
];
const offlineHtmlDiagnosticLocks = <String>[
  'RTCPeerConnection',
  'webkitRTCPeerConnection',
  'mozRTCPeerConnection',
  'WebTransport',
  'WebSocket',
  'WebSocketStream',
  'EventSource',
  'XMLHttpRequest',
  'Worker',
  'SharedWorker',
  'BroadcastChannel',
  'Notification',
  'PresentationRequest',
  'SpeechRecognition',
  'webkitSpeechRecognition',
  'speechSynthesis',
  'DOMParser',
  'XSLTProcessor',
  'flutter_inappwebview',
  'webkit',
  'chrome',
  'external',
  'customElements',
  'print',
  'log',
  'info',
  'debug',
  'warn',
  'error',
  'trace',
  'assert',
  'dir',
  'table',
  'group',
  'groupCollapsed',
  'groupEnd',
  'clear',
  'fetch',
  'open',
  'alert',
  'confirm',
  'prompt',
  'serviceWorker',
  'mediaDevices',
  'clipboard',
  'usb',
  'serial',
  'bluetooth',
  'hid',
  'sendBeacon',
];

const _reportPolicy =
    "default-src 'none'; script-src 'unsafe-inline'; "
    "style-src 'unsafe-inline'; img-src data:; font-src data:; "
    "connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; "
    "object-src 'none'; base-uri 'none'; form-action 'none'; webrtc 'block'";
const _shellPolicy =
    "default-src 'none'; script-src 'unsafe-inline'; "
    "style-src 'unsafe-inline'; img-src data:; font-src data:; "
    "connect-src 'none'; frame-src about:; child-src about:; worker-src 'none'; "
    "object-src 'none'; base-uri 'none'; form-action 'none'; webrtc 'block'";

/// 在报告脚本之前收紧浏览器能力，并封闭创建新活动文档的 DOM 入口。
const offlineHtmlBootstrapScript = r'''
(() => {
  'use strict';
  if (window.__piOfflineGuardReady === true) return;
  if (window.__piOfflineGuardStarted === true) throw new Error('保护初始化未完成');
  Object.defineProperty(window, '__piOfflineGuardStarted', {value:true, configurable:false, writable:false});
  window.__piOfflineGuardStage = 'globals';
  const apply = Reflect.apply;
  const block = () => { throw new DOMException('离线预览不允许此操作', 'SecurityError'); };
  const lock = (object, name, value) => {
    if (!object) return;
    try { Object.defineProperty(object, name, {value, writable:false, configurable:false}); }
    catch (_) {
      let same = false;
      try { same = object[name] === value; } catch (_) {}
      if (!same) { window.__piOfflineGuardFailure = name; block(); }
    }
  };
  const unavailable = ['RTCPeerConnection','webkitRTCPeerConnection','mozRTCPeerConnection',
    'WebTransport','WebSocket','WebSocketStream','EventSource','XMLHttpRequest','Worker',
    'SharedWorker','BroadcastChannel','Notification','PresentationRequest','SpeechRecognition',
    'webkitSpeechRecognition','speechSynthesis','DOMParser','XSLTProcessor'];
  for (const name of unavailable) lock(window, name, undefined);
  // WebKit 命名空间由引擎只读持有，原生控制器已关闭其消息桥。
  for (const name of ['flutter_inappwebview','chrome','external']) lock(window, name, undefined);
  lock(window, 'customElements', undefined);
  for (let prototype = Object.getPrototypeOf(window); prototype; prototype = Object.getPrototypeOf(prototype)) {
    for (const name of [...unavailable, 'flutter_inappwebview','chrome','external']) {
      if (Object.prototype.hasOwnProperty.call(prototype, name)) lock(prototype, name, undefined);
    }
  }
  lock(window, 'print', () => {});
  for (const name of ['log','info','debug','warn','error','trace','assert','dir','table','group','groupCollapsed','groupEnd','clear']) {
    if (window.console) lock(window.console, name, () => {});
  }
  lock(window, 'fetch', () => Promise.reject(new TypeError('离线预览不允许网络请求')));
  lock(window, 'open', () => null);
  lock(window, 'alert', () => {});
  lock(window, 'confirm', () => false);
  lock(window, 'prompt', () => null);
  for (const name of ['serviceWorker','mediaDevices','clipboard','usb','serial','bluetooth','hid']) {
    lock(navigator, name, undefined);
  }
  lock(navigator, 'sendBeacon', () => false);
  window.__piOfflineGuardStage = 'captures';
  const forbidden = new Set(['iframe','frame','frameset','object','embed','portal','base','link']);
  const elementCreate = Document.prototype.createElement;
  const elementCreateNS = Document.prototype.createElementNS;
  const inner = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  const remove = Element.prototype.remove;
  const query = Element.prototype.querySelectorAll;
  const documentQuery = Document.prototype.querySelectorAll;
  const fragmentQuery = DocumentFragment.prototype.querySelectorAll;
  const localName = Object.getOwnPropertyDescriptor(Element.prototype, 'localName').get;
  const nodeType = Object.getOwnPropertyDescriptor(Node.prototype, 'nodeType').get;
  const elementHasAttribute = Element.prototype.hasAttribute;
  const inputType = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'type').get;
  const nodeListLength = Object.getOwnPropertyDescriptor(NodeList.prototype, 'length').get;
  const templateContent = Object.getOwnPropertyDescriptor(HTMLTemplateElement.prototype, 'content').get;
  const isForbidden = Set.prototype.has.bind(forbidden);
  const lower = Function.prototype.call.bind(String.prototype.toLowerCase);
  const toString = String;
  const find = (node, selector) => {
    const type = apply(nodeType, node, []);
    return apply(type === 1 ? query : type === 9 ? documentQuery : fragmentQuery, node, [selector]);
  };
  const selectors = 'iframe,frame,frameset,object,embed,portal,base,link,meta[http-equiv],input[type="file"],template[shadowrootmode]';
  const bad = node => node && apply(nodeType, node, []) === 1 &&
    (isForbidden(lower(apply(localName, node, []))) ||
      lower(apply(localName, node, [])) === 'meta' && apply(elementHasAttribute, node, ['http-equiv']) ||
      lower(apply(localName, node, [])) === 'template' && apply(elementHasAttribute, node, ['shadowrootmode']) ||
      lower(apply(localName, node, [])) === 'input' && apply(inputType, node, []) === 'file');
  const cleanNode = node => {
    if (!node || typeof node !== 'object') return node;
    if (bad(node)) block();
    if ([1,9,11].includes(apply(nodeType, node, []))) {
      const items = find(node, selectors);
      for (let i=0;i<apply(nodeListLength,items,[]);i++) apply(remove,items[i],[]);
      const templates = find(node, 'template');
      for (let i=0;i<apply(nodeListLength,templates,[]);i++) cleanNode(apply(templateContent,templates[i],[]));
    }
    return node;
  };
  const cleanMarkup = value => {
    const template = apply(elementCreate, document, ['template']);
    apply(inner.set, template, [toString(value)]);
    cleanNode(apply(templateContent,template,[]));
    return apply(inner.get, template, []);
  };
  window.__piOfflineGuardStage = 'dom';
  lock(Document.prototype, 'createElement', function(name, options) {
    const text = toString(name);
    if (isForbidden(lower(text))) block();
    return apply(elementCreate, this, [text, options]);
  });
  lock(Document.prototype, 'createElementNS', function(ns, name, options) {
    const text = toString(name);
    if (isForbidden(lower(text.split(':').pop()))) block();
    return apply(elementCreateNS, this, [ns, text, options]);
  });
  for (const name of ['open','write','writeln','execCommand']) lock(Document.prototype, name, block);
  const replaceMarkupSetter = (prototype, name) => {
    if (!prototype) return;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (!descriptor || !descriptor.set) return;
    Object.defineProperty(prototype, name, {
      configurable:false, enumerable:descriptor.enumerable, get:descriptor.get,
      set(value) { apply(descriptor.set, this, [cleanMarkup(value)]); }
    });
  };
  replaceMarkupSetter(Element.prototype, 'innerHTML');
  replaceMarkupSetter(Element.prototype, 'outerHTML');
  if (window.ShadowRoot) replaceMarkupSetter(ShadowRoot.prototype, 'innerHTML');
  const adjacent = Element.prototype.insertAdjacentHTML;
  lock(Element.prototype, 'insertAdjacentHTML', function(position, text) {
    return apply(adjacent, this, [position, cleanMarkup(text)]);
  });
  for (const prototype of [Element.prototype, window.ShadowRoot && ShadowRoot.prototype]) {
    for (const name of ['setHTML','setHTMLUnsafe']) {
      if (prototype && typeof prototype[name] === 'function') {
        const original = prototype[name];
        lock(prototype, name, function(text, ...rest) { return apply(original, this, [cleanMarkup(text), ...rest]); });
      }
    }
  }
  for (const name of ['appendChild','insertBefore','replaceChild']) {
    const original = Node.prototype[name];
    lock(Node.prototype, name, function(node, ...rest) { return apply(original, this, [cleanNode(node), ...rest]); });
  }
  for (const prototype of [Element.prototype, Document.prototype, DocumentFragment.prototype, CharacterData.prototype, DocumentType.prototype]) {
    for (const name of ['append','prepend','replaceChildren','before','after','replaceWith','moveBefore']) {
      if (typeof prototype[name] !== 'function') continue;
      const original = prototype[name];
      lock(prototype, name, function(...nodes) { return apply(original, this, nodes.map(cleanNode)); });
    }
  }
  const insertElement = Element.prototype.insertAdjacentElement;
  lock(Element.prototype, 'insertAdjacentElement', function(position, element) {
    return apply(insertElement, this, [position, cleanNode(element)]);
  });
  if (window.Range) {
    const fragment = Range.prototype.createContextualFragment;
    lock(Range.prototype, 'createContextualFragment', function(text) { return apply(fragment, this, [cleanMarkup(text)]); });
    const insert = Range.prototype.insertNode;
    lock(Range.prototype, 'insertNode', function(node) { return apply(insert, this, [cleanNode(node)]); });
    const surround = Range.prototype.surroundContents;
    lock(Range.prototype, 'surroundContents', function(node) { return apply(surround, this, [cleanNode(node)]); });
  }
  lock(Element.prototype, 'attachShadow', block);
  for (const name of ['parseHTML','parseHTMLUnsafe']) if (Document[name]) lock(Document, name, block);
  if (window.HTMLFormElement) {
    lock(HTMLFormElement.prototype, 'submit', block);
    lock(HTMLFormElement.prototype, 'requestSubmit', block);
  }
  if (window.HTMLInputElement && HTMLInputElement.prototype.showPicker) {
    lock(HTMLInputElement.prototype, 'showPicker', block);
  }
  const prevent = Event.prototype.preventDefault, stop = Event.prototype.stopImmediatePropagation;
  window.__piOfflineGuardStage = 'events';
  const eventTarget = Object.getOwnPropertyDescriptor(Event.prototype, 'target').get;
  const closest = Element.prototype.closest, getAttribute = Element.prototype.getAttribute;
  document.addEventListener('submit', event => { apply(prevent,event,[]); apply(stop,event,[]); }, true);
  document.addEventListener('click', event => {
    const raw = apply(eventTarget,event,[]);
    if (!raw || apply(nodeType,raw,[]) !== 1) return;
    const target = raw;
    const link = apply(closest,target,['a,area']);
    if (link) {
      apply(prevent,event,[]);
      const href = apply(getAttribute,link,['href']) || '';
      if (href.startsWith('#')) {
        try { document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView(); } catch (_) {}
      }
    }
    if (apply(closest,target,['input[type="file"]'])) { apply(prevent,event,[]); apply(stop,event,[]); }
  }, true);
  // 固定防护所依赖的原型，避免报告通过改写原型绕过检查。
  window.__piOfflineGuardStage = 'freeze';
  for (const object of [Object, Array, String, Function, Set, Map, RegExp, Reflect, JSON,
    Object.prototype, Array.prototype, String.prototype, Function.prototype, Set.prototype,
    Map.prototype, RegExp.prototype, NodeList.prototype, Node.prototype, Element.prototype,
    Document.prototype, DocumentFragment.prototype, CharacterData.prototype, DocumentType.prototype,
    Event.prototype, HTMLInputElement.prototype, HTMLTemplateElement.prototype]) {
    Object.freeze(object);
  }
  for (const name of ['Object','Array','String','Function','Set','Map','RegExp','Reflect','JSON',
    'Node','NodeList','Element','Document','DocumentFragment','CharacterData','DocumentType',
    'Event','HTMLInputElement','HTMLFormElement','ShadowRoot','Range']) {
    if (window[name]) lock(window, name, window[name]);
  }
  Object.defineProperty(window, '__piOfflineGuardReady', {value:true, configurable:false, writable:false});
})();
''';

/// 只提取文档中的静态外链；打开动作由宿主用户确认。
List<Uri> externalHtmlLinks(String html) {
  if (utf8.encode(html).length > htmlPreviewSourceLimit) return const [];
  final result = <Uri>[];
  final seen = <String>{};
  for (final element in parser.parse(html).querySelectorAll('a[href]')) {
    final uri = Uri.tryParse(element.attributes['href'] ?? '');
    if (uri == null || !allowExternalHtmlLink(uri) || !seen.add(uri.toString()))
      continue;
    result.add(uri);
    if (result.length == 30) break;
  }
  return result;
}

/// 将单文件报告放入受限子帧；原文只作为 base64 数据进入可信外壳。
String buildOfflineHtmlDocument(String html) {
  if (utf8.encode(html).length > htmlPreviewSourceLimit) {
    throw const FormatException('HTML 超过预览大小限制');
  }
  final document = parser.parse(html);
  for (final node in document.querySelectorAll(
    'iframe,frame,frameset,object,embed,portal,base,link,meta[http-equiv],input[type="file"],template[shadowrootmode]',
  )) {
    node.remove();
  }
  final random = Random.secure();
  final nonce = base64UrlEncode(List.generate(18, (_) => random.nextInt(256)));
  final scripts = <Map<String, dynamic>>[];
  for (final script in document.querySelectorAll('script').toList()) {
    if (script.attributes.containsKey('src')) {
      script.remove();
      continue;
    }
    final type = script.attributes['type'] ?? '';
    if (type.isNotEmpty &&
        ![
          'text/javascript',
          'application/javascript',
          'module',
        ].contains(type.toLowerCase()))
      continue;
    final id = 'preview-script-$nonce-${scripts.length}';
    scripts.add({
      'id': id,
      'code': script.text,
      'attributes': {
        for (final entry in script.attributes.entries)
          if (entry.key is String && entry.key != 'src')
            entry.key as String: entry.value,
      },
    });
    script.replaceWith(
      dom.Element.tag('span')..attributes.addAll({'id': id, 'hidden': ''}),
    );
  }
  final payload = base64Encode(
    utf8.encode(
      jsonEncode({
        'head': document.head!.innerHtml,
        'body': document.body!.innerHtml,
        'bodyAttributes': {
          for (final entry in document.body!.attributes.entries)
            if (entry.key is String) entry.key as String: entry.value,
        },
        'htmlAttributes': {
          for (final entry in document.documentElement!.attributes.entries)
            if (entry.key is String) entry.key as String: entry.value,
        },
        'scripts': scripts,
      }),
    ),
  );
  final child =
      '''<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="$_reportPolicy">
<meta http-equiv="x-dns-prefetch-control" content="off"><meta name="referrer" content="no-referrer">
</head><body><script>(()=>{try{
$offlineHtmlBootstrapScript
if(window.__piOfflineGuardReady!==true)throw new Error('guard');window.__piOfflineGuardStage='content';
const report=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob('$payload'),c=>c.charCodeAt(0))));
const byId=document.getElementById.bind(document), create=document.createElement.bind(document);
document.head.insertAdjacentHTML('beforeend',report.head);
document.body.insertAdjacentHTML('beforeend',report.body);
for(const [name,value] of Object.entries(report.bodyAttributes))document.body.setAttribute(name,value);
for(const [name,value] of Object.entries(report.htmlAttributes))document.documentElement.setAttribute(name,value);
for(const item of report.scripts){const slot=byId(item.id);if(!slot)continue;const script=create('script');for(const [name,value]of Object.entries(item.attributes))script.setAttribute(name,value);script.textContent=item.code;slot.replaceWith(script);}
parent.postMessage({nonce:'$nonce',state:'ready'},'*');
}catch(_){document.body.textContent='无法启用此报告的隔离预览，请切换源码或下载。';const stage=['globals','captures','dom','events','freeze','content'].includes(window.__piOfflineGuardStage)?window.__piOfflineGuardStage:'unknown';const lock=${jsonEncode(offlineHtmlDiagnosticLocks)}.includes(window.__piOfflineGuardFailure)?window.__piOfflineGuardFailure:'';parent.postMessage({nonce:'$nonce',state:'error',stage,lock},'*');}})();</script></body></html>''';
  final encoded = base64Encode(utf8.encode(child));
  final qaListener = offlineHtmlQaEnabled
      ? "window.addEventListener('message',event=>{if(event.source!==frame.contentWindow||event.data?.type!=='pi-html-fixture')return;const checks={};for(const key of ${jsonEncode(offlineHtmlQaChecks)})checks[key]=event.data.checks?.[key]===true;document.title='PI_BOT_HTML_QA:'+JSON.stringify(checks);});"
      : '';
  final shell =
      '''<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="$_shellPolicy">
<meta http-equiv="x-dns-prefetch-control" content="off">
<meta name="referrer" content="no-referrer">
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#fff}iframe{display:block;border:0;width:100%;height:100%}</style>
</head><body><iframe id="pi-bot-html-frame" title="HTML 报告" sandbox="allow-scripts" referrerpolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; display-capture 'none'; usb 'none'; serial 'none'; hid 'none'; bluetooth 'none'; payment 'none'"></iframe>
<script>(()=>{const frame=document.getElementById('pi-bot-html-frame');$qaListener window.addEventListener('message',event=>{if(event.source!==frame.contentWindow||event.data?.nonce!=='$nonce')return;if(event.data.state==='ready')document.body.dataset.previewReady='true';else if(event.data.state==='error'){document.body.dataset.previewError='true';if(['globals','captures','dom','events','freeze','content'].includes(event.data.stage))document.body.dataset.previewErrorStage=event.data.stage;if(${jsonEncode(offlineHtmlDiagnosticLocks)}.includes(event.data.lock))document.body.dataset.previewErrorLock=event.data.lock;}});const bytes=Uint8Array.from(atob('$encoded'),c=>c.charCodeAt(0));frame.srcdoc=new TextDecoder('utf-8',{fatal:true}).decode(bytes);})();</script>
</body></html>''';
  if (utf8.encode(shell).length > htmlPreviewShellLimit) {
    throw const FormatException('HTML 展开后超过预览大小限制');
  }
  return shell;
}
