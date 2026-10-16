const fs = require('fs');

// ---------- chat_screen ----------
let c = fs.readFileSync('lib/screens/chat_screen.dart', 'utf8');

// 1) 群标题栏：老大 + 人数
c = c.replace(
  "                              ? '${room.botIds.length} 个 bot'",
  "                              ? '老大 ${room.leadName ?? '-'} · ${room.botIds.length} 人'",
);

// 2) 作者名后面的模型标签太长 → 只留最后一段
c = c.replace(
  `                            child: Text(
                              '\${bot!.model ?? '默认'} · \${bot!.thinking}',`,
  `                            child: Text(
                              '\${shortModel(bot!.model)} · \${bot!.thinking}',`,
);

// 3) 用量全 0 时不显示（群成员常常没有 usage）
c = c.replace(
  `  static String _usageLine(Map<String, dynamic> usage) {
    final input = usage['input'] ?? 0;
    final output = usage['output'] ?? 0;
    final cache = usage['cacheRead'] ?? 0;
    final cost = (usage['cost'] is Map) ? (usage['cost']['total'] ?? 0) : 0;
    final costText = cost is num && cost > 0 ? '  \\\$\${cost.toStringAsFixed(5)}' : '';
    return '↑\$input ↓\$output ⚡\$cache\$costText';
  }`,
  `  static String _usageLine(Map<String, dynamic> usage) {
    final input = usage['input'] ?? 0;
    final output = usage['output'] ?? 0;
    final cache = usage['cacheRead'] ?? 0;
    final cost = (usage['cost'] is Map) ? (usage['cost']['total'] ?? 0) : 0;
    final costText = cost is num && cost > 0 ? '  \\\$\${cost.toStringAsFixed(5)}' : '';
    return '↑\$input ↓\$output ⚡\$cache\$costText';
  }

  /// 全是 0 就别显示（很多模型不返回 usage）
  static bool _hasUsage(Map<String, dynamic> usage) {
    final n = (usage['input'] ?? 0) + (usage['output'] ?? 0) + (usage['cacheRead'] ?? 0);
    return n is num && n > 0;
  }`,
);

c = c.replace(
  `                if (!streaming && msg.usage != null && showAuthor)`,
  `                if (!streaming && msg.usage != null && showAuthor && _hasUsage(msg.usage!))`,
);

fs.writeFileSync('lib/screens/chat_screen.dart', c);

// ---------- config：群内步数上限放宽 + 加时间预算 ----------
let cfg = fs.readFileSync('../server/src/config.js', 'utf8');
cfg = cfg.replace(
  "  groupTurnMaxSteps: Number(process.env.PI_BOT_GROUP_MAX_STEPS || 12),",
  "  groupTurnMaxSteps: Number(process.env.PI_BOT_GROUP_MAX_STEPS || 30),\n  /** 部门里单轮最长跑多久（毫秒），到点收住交给下一个人 */\n  groupTurnMaxMs: Number(process.env.PI_BOT_GROUP_TURN_MAX_MS || 300_000),",
);
fs.writeFileSync('../server/src/config.js', cfg);

console.log('UI + 步数上限 补丁完成');
