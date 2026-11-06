/// 快速决策（Jev）的接入方式。
///
/// 两种：
///   typesafe —— TypeSafe 官方。地址和模型名固定，用户只填 key。
///   custom   —— 任何兼容 /v1/systemone 的服务。地址和模型名都得自己给。
///
/// 为什么官方模式要**忽略**用户填的地址：
///   他填错一个 /v1 就会得到一堆 404，而且从错误信息里看不出是地址的问题。
///   既然官方地址不会变，就别给他填错的机会。
library;

const String kDecisionModeTypesafe = 'typesafe';
const String kDecisionModeCustom = 'custom';

/// 官方的固定地址和模型名。与服务端 store.js 的 decisionRoute 保持一致。
const String kDecisionOfficialBaseUrl = 'https://api.typesafe.ai';
const String kDecisionOfficialModel = 'jev-latest';

/// 从设置里读出接入方式。脏数据回落成官方 —— 不因为一个错值让整块设置失效。
String decisionMode(Map<String, dynamic> decision) {
  final raw = decision['mode'];
  if (raw is String && raw == kDecisionModeCustom) return kDecisionModeCustom;
  return kDecisionModeTypesafe;
}

bool isCustomDecisionMode(Map<String, dynamic> decision) =>
    decisionMode(decision) == kDecisionModeCustom;

/// 实际会用的地址和模型名（配置界面只显示、请求用它）。
Map<String, String> decisionEndpoints(Map<String, dynamic> decision) {
  if (isCustomDecisionMode(decision)) {
    return {
      'baseUrl': (decision['baseUrl'] as String?)?.trim() ?? '',
      'model': (decision['model'] as String?)?.trim() ?? '',
    };
  }
  return {
    'baseUrl': kDecisionOfficialBaseUrl,
    'model': kDecisionOfficialModel,
  };
}

/// 这个配置能不能直接用。
///
/// 自定义模式还必须有模型名 —— 我们猜不出对方支持什么，
/// 留空只会在第一次决策时才炸，那时候更难查。
bool decisionReady(Map<String, dynamic> decision) {
  if (decision['hasApiKey'] != true) return false;
  final ep = decisionEndpoints(decision);
  if ((ep['baseUrl'] ?? '').isEmpty) return false;
  if (isCustomDecisionMode(decision) && (ep['model'] ?? '').isEmpty) return false;
  return true;
}