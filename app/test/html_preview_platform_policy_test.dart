import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/html_preview_environment.dart';
import 'package:pi_bot/html_preview_platform_policy.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('渲染导航只接受内存文档及其页内锚点', () {
    for (final value in [
      'about:blank',
      'about:srcdoc',
      'about:srcdoc#section',
    ]) {
      expect(
        allowOfflineHtmlNavigation(Uri.parse(value)),
        isTrue,
        reason: value,
      );
    }
    for (final value in [
      'https://example.com/',
      'http://127.0.0.1:8787/api/state',
      'http://localhost:18787/',
      'file:///etc/passwd',
      'data:text/html,hello',
      'blob:null/fixture',
      'javascript:alert(1)',
      'ftp://example.com/file',
      'custom-app://open',
      'about://blank',
      'about:blank?next=https://example.com',
      'about:config',
    ]) {
      expect(
        allowOfflineHtmlNavigation(Uri.parse(value)),
        isFalse,
        reason: value,
      );
    }
    expect(allowOfflineHtmlNavigation(null), isFalse);
  });

  test('外部链接必须为无凭据的普通HTTPS目标', () {
    expect(
      allowExternalHtmlLink(
        Uri.parse('https://docs.example.com/report?a=1#part'),
      ),
      isTrue,
    );
    expect(
      allowExternalHtmlLink(Uri.parse('https://docs.example.com:443/report')),
      isTrue,
    );
    for (final value in [
      'http://example.com/',
      'https://user:pass@example.com/',
      'https://example.com:8443/',
      'https://localhost/',
      'https://127.0.0.1/',
      'https://[::1]/',
      'https://2130706433/',
      'https://0x7f000001/',
      'https://pi-bot.local/',
      'https://service.internal/',
      'file:///fixture/report.html',
      'javascript:alert(1)',
      'https://local/',
      'https://service.localhost./',
      'https://bad_host.example.com/',
    ]) {
      expect(allowExternalHtmlLink(Uri.parse(value)), isFalse, reason: value);
    }
  });

  test('不支持的平台不尝试建立原生视图', () {
    expect(supportsOfflineHtmlPreview(TargetPlatform.macOS), isTrue);
    expect(supportsOfflineHtmlPreview(TargetPlatform.windows), isTrue);
    for (final platform in [
      TargetPlatform.android,
      TargetPlatform.iOS,
      TargetPlatform.linux,
      TargetPlatform.fuchsia,
    ]) {
      expect(supportsOfflineHtmlPreview(platform), isFalse);
    }
  });

  test('Mac使用内容规则，Windows使用资源回调，均禁持久存储与文件访问', () {
    for (final platform in [TargetPlatform.macOS, TargetPlatform.windows]) {
      final settings = offlineHtmlSettings(platform);
      expect(settings.javaScriptBridgeEnabled, isFalse);
      expect(settings.generalAutofillEnabled, isFalse);
      expect(settings.passwordAutosaveEnabled, isFalse);
      expect(settings.incognito, isTrue);
      expect(settings.cacheEnabled, isFalse);
      expect(settings.sharedCookiesEnabled, isFalse);
      expect(settings.allowFileAccess, isFalse);
      expect(settings.allowFileAccessFromFileURLs, isFalse);
      expect(settings.allowUniversalAccessFromFileURLs, isFalse);
      expect(settings.useShouldOverrideUrlLoading, isTrue);
      expect(settings.javaScriptCanOpenWindowsAutomatically, isFalse);
      expect(settings.supportMultipleWindows, isFalse);
      expect(settings.isInspectable, isFalse);
      if (platform == TargetPlatform.macOS) {
        expect(settings.contentBlockers, hasLength(6));
        final filters = settings.contentBlockers!.map((rule) {
          expect(rule.trigger.urlFilter, isNot(contains('|')));
          return RegExp(rule.trigger.urlFilter, caseSensitive: false);
        }).toList();
        for (final address in [
          'http://localhost/',
          'https://example.com/',
          'file:///fixture',
          'ftp://example.com/',
          'ws://example.com/',
          'wss://example.com/',
        ]) {
          expect(filters.any((filter) => filter.hasMatch(address)), isTrue);
        }
        for (final address in [
          'about:srcdoc',
          'data:image/png;base64,fixture',
        ]) {
          expect(filters.any((filter) => filter.hasMatch(address)), isFalse);
        }
      } else {
        expect(settings.useShouldInterceptRequest, isTrue);
      }
    }
  });

  test('并发释放环境时复用同一个完成结果，完成后不再释放', () async {
    var releases = 0;
    final completion = Completer<void>();
    final lease = HtmlPreviewEnvironmentLease(
      releaseNative: () {
        releases++;
        return completion.future;
      },
    );
    final first = lease.dispose();
    expect(lease.dispose(), same(first));
    expect(releases, 1);
    completion.complete();
    await first;
    expect(lease.dispose(), same(first));
    expect(releases, 1);
  });

  test('环境释放失败保留原始错误，不重复调用原生释放', () async {
    var releases = 0;
    final lease = HtmlPreviewEnvironmentLease(
      releaseNative: () async {
        releases++;
        throw StateError('fixture');
      },
    );
    final first = lease.dispose();
    await expectLater(first, throwsStateError);
    expect(lease.dispose(), same(first));
    expect(releases, 1);
  });

  test('同步释放异常转换为同一个失败结果，不重复清理', () async {
    var calls = 0;
    final lease = HtmlPreviewEnvironmentLease(
      releaseNative: () {
        calls++;
        throw StateError('fixture');
      },
    );
    final first = lease.dispose();
    await expectLater(first, throwsStateError);
    expect(lease.dispose(), same(first));
    expect(calls, 1);
  });

  test('临时目录清理仅作用于传入的本次目录且可重复', () async {
    final parent = await Directory.systemTemp.createTemp(
      'pi-bot-html-policy-test-',
    );
    addTearDown(() => parent.delete(recursive: true));
    final owned = await Directory('${parent.path}/owned').create();
    final unrelated = File('${parent.path}/unrelated');
    await unrelated.writeAsString('fixture');
    await File('${owned.path}/cache').writeAsString('fixture');
    await removeHtmlPreviewDirectory(owned);
    await removeHtmlPreviewDirectory(owned);
    expect(await owned.exists(), isFalse);
    expect(await unrelated.readAsString(), 'fixture');
  });

  test('正常到达的原生资源直接交给调用者，不提前释放', () async {
    final resource = Object();
    var releases = 0;
    final result = await awaitHtmlPreviewResource(
      creation: Future.value(resource),
      isCancelled: () => false,
      releaseLate: (_) async {
        releases++;
      },
    );
    expect(result, same(resource));
    expect(releases, 0);
  });

  test('取消后到达的原生资源会释放且不交给已关闭视图', () async {
    final creation = Completer<Object>();
    final resource = Object();
    final released = <Object>[];
    var cancelled = false;
    final result = awaitHtmlPreviewResource(
      creation: creation.future,
      isCancelled: () => cancelled,
      releaseLate: (resource) async {
        released.add(resource);
      },
    );
    final failure = expectLater(result, throwsStateError);
    cancelled = true;
    creation.complete(resource);
    await failure;
    expect(released, [resource]);
  });

  test('创建超时后仍保留晚到资源的释放路径', () async {
    final creation = Completer<Object>();
    final resource = Object();
    final released = Completer<Object>();
    final result = awaitHtmlPreviewResource(
      creation: creation.future,
      isCancelled: () => false,
      releaseLate: (resource) async {
        released.complete(resource);
      },
      timeout: const Duration(milliseconds: 1),
    );
    await expectLater(result, throwsA(isA<TimeoutException>()));
    expect(released.isCompleted, isFalse);
    creation.complete(resource);
    expect(await released.future, same(resource));
  });

  test('原生创建失败直接返回错误，不释放未获得的资源', () async {
    var releases = 0;
    await expectLater(
      awaitHtmlPreviewResource<Object>(
        creation: Future.error(StateError('fixture')),
        isCancelled: () => false,
        releaseLate: (_) async {
          releases++;
        },
      ),
      throwsStateError,
    );
    expect(releases, 0);
  });
}
