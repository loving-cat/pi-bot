// 容量输入的解析与显示。
//
// 用户可以直接写 1M / 256K / 128000 —— 三种写法指向同一个数。
// 这里只做单位换算，不推断接口真实能力：填了多少就是多少。

/// 把带单位的写法换算成 tokens；格式不合法返回 null。
///
/// 允许：128000、256k、256K、1m、1M、1.5M、0.5K。
/// 不允许：负数、0、科学计数、夹杂其它字符、超出安全整数范围。
/// 空串由调用方先判断，不走这里。
int? parseTokenCount(String raw) {
  final text = raw.trim();
  if (text.isEmpty) return null;

  final match = RegExp(r'^(\d+(?:\.\d+)?)\s*([kKmM]?)$').firstMatch(text);
  if (match == null) return null;

  final number = double.tryParse(match.group(1)!);
  if (number == null || number <= 0) return null;

  final unit = (match.group(2) ?? '').toUpperCase();
  // 不带单位时必须是整数：token 没有"1.5 个"这种说法。
  // 带单位才允许小数（1.5M = 1500000），因为那是在表达数量级。
  if (unit.isEmpty && match.group(1)!.contains('.')) return null;
  final multiplier = unit == 'K'
      ? 1000
      : unit == 'M'
      ? 1000000
      : 1;

  final value = (number * multiplier).round();
  if (value <= 0) return null;
  if (value > 9007199254740991) return null;
  return value;
}

/// 把 tokens 显示成人看得懂的写法：能整除就收成 M / K，否则原样。
///
/// 只影响显示，提交给服务端的永远是精确整数。
String formatTokenCount(int value) {
  if (value <= 0) return '';
  if (value % 1000000 == 0) return '${value ~/ 1000000}M';
  if (value >= 1000 && value % 1000 == 0) return '${value ~/ 1000}K';
  return '$value';
}
