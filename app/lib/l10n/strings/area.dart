/// 文案按区域拆分，每个区域一个文件、中英同放。
///
/// 为什么不是抽象类 + 每个文案一个 getter：
/// 界面有 900+ 条文案，getter 方案要写 1800 个成员，
/// 且每个新文案都要改两个类 —— 维护成本远高于收益。
/// 这里用「区域文件 + 扁平 key」，新增文案只加一行。
///
/// key 约定：<区域>.<语义>，例如 chat.send、settings.language。
/// 不要用中文拼音或直译，英文版会重排语序。
library;

/// 某区域的文案表：中文在前，英文在后。
class StringArea {
  const StringArea({required this.zh, required this.en});

  final Map<String, String> zh;
  final Map<String, String> en;
}
