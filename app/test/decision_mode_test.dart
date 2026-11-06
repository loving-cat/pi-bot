import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/decision_mode.dart';

// 快速决策设置：两种接入方式的解析契约。
//
// 测的是 lib/decision_mode.dart 的真实实现 —— 界面和请求都用它，
// 在这里再抄一份逻辑就失去意义了。

void main() {
  group('接入方式', () {
    test('默认是官方', () {
      expect(decisionMode(const {}), kDecisionModeTypesafe);
    });

    test('显式 custom 才走自定义', () {
      expect(decisionMode(const {'mode': 'custom'}), kDecisionModeCustom);
    });

    test('脏数据回落成官方', () {
      expect(decisionMode(const {'mode': 'xxx'}), kDecisionModeTypesafe);
      expect(decisionMode(const {'mode': null}), kDecisionModeTypesafe);
      expect(decisionMode(const {'mode': 42}), kDecisionModeTypesafe);
    });
  });

  group('地址与模型名', () {
    test('官方模式：地址和模型名固定', () {
      final ep = decisionEndpoints(const {'mode': 'typesafe'});
      expect(ep['baseUrl'], kDecisionOfficialBaseUrl);
      expect(ep['model'], kDecisionOfficialModel);
    });

    test('★ 官方模式下用户填错地址也不生效', () {
      // 否则他填个 /v1 进来就全是 404，还不知道为什么
      final ep = decisionEndpoints(const {
        'mode': 'typesafe',
        'baseUrl': 'https://wrong.example/v1',
        'model': 'wrong',
      });
      expect(ep['baseUrl'], kDecisionOfficialBaseUrl);
    });

    test('自定义模式：用用户填的', () {
      final ep = decisionEndpoints(const {
        'mode': 'custom',
        'baseUrl': 'https://my.jev/v1',
        'model': 'my-model',
      });
      expect(ep['baseUrl'], 'https://my.jev/v1');
      expect(ep['model'], 'my-model');
    });

    test('两端空白要去掉', () {
      final ep = decisionEndpoints(const {
        'mode': 'custom',
        'baseUrl': '  https://x  ',
        'model': '  m  ',
      });
      expect(ep['baseUrl'], 'https://x');
      expect(ep['model'], 'm');
    });
  });

  group('能不能直接用', () {
    test('官方模式只要有 key', () {
      expect(
        decisionReady(const {'mode': 'typesafe', 'hasApiKey': true}),
        isTrue,
      );
    });

    test('没 key 就不行', () {
      expect(
        decisionReady(const {'mode': 'typesafe', 'hasApiKey': false}),
        isFalse,
      );
    });

    test('自定义模式缺地址不行', () {
      expect(
        decisionReady(const {
          'mode': 'custom',
          'hasApiKey': true,
          'baseUrl': '',
          'model': 'm',
        }),
        isFalse,
      );
    });

    test('★ 自定义模式缺模型名不行 —— 我们猜不出对方支持什么', () {
      expect(
        decisionReady(const {
          'mode': 'custom',
          'hasApiKey': true,
          'baseUrl': 'https://x',
          'model': '',
        }),
        isFalse,
      );
    });

    test('自定义模式齐全就行', () {
      expect(
        decisionReady(const {
          'mode': 'custom',
          'hasApiKey': true,
          'baseUrl': 'https://x',
          'model': 'm',
        }),
        isTrue,
      );
    });
  });
}