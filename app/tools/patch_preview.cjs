const fs = require('fs');

// ---------- rooms_screen ----------
let r = fs.readFileSync('lib/screens/rooms_screen.dart', 'utf8');
r = r.replace("import '../theme.dart';", "import '../text_utils.dart';\nimport '../theme.dart';");

r = r.replace(
  "            : '${last.isUser ? '我' : last.authorName}：${shortText(last.text, 46)}';",
  "            : '${last.isUser ? '我' : last.authorName}：${preview(last.text, 46)}';",
);

r = r.replace(
  [
    '                : (!room.isGroup && bot != null',
    "                      ? '${bot.model ?? '默认模型'} · thinking ${bot.thinking ?? '-'}'",
    '                      : (room.isGroup && room.leadName != null',
    "                            ? '老大 ${room.leadName} · ${room.botIds.length} 人'",
    "                            : '还没有消息'))",
  ].join('\n'),
  [
    '                : (!room.isGroup && bot != null',
    '                      ? (firstLine(bot.persona).isNotEmpty',
    '                            ? preview(bot.persona, 40)',
    "                            : '还没有消息')",
    '                      : (room.isGroup && room.leadName != null',
    "                            ? '老大 ${room.leadName} · ${room.botIds.length} 人'",
    "                            : '还没有消息'))",
  ].join('\n'),
);

fs.writeFileSync('lib/screens/rooms_screen.dart', r);
console.log('rooms_screen: 预览去 markdown + 私聊不再显示模型');

// ---------- chat_screen ----------
let c = fs.readFileSync('lib/screens/chat_screen.dart', 'utf8');
c = c.replace("import '../scope.dart';", "import '../scope.dart';\nimport '../text_utils.dart';");

// 作者名后面那串模型标签：整块删掉
const authorModelBlock = [
  '                        const SizedBox(width: 8),',
  '                        if (bot != null && !bot!.isMain)',
  '                          Flexible(',
  '                            child: Text(',
  "                              '${shortModel(bot!.model)} · ${bot!.thinking}',",
  '                              overflow: TextOverflow.ellipsis,',
  '                              style: const TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),',
  '                            ),',
  '                          ),',
].join('\n');
c = c.replace(authorModelBlock, '');

// DM 标题栏副标题：改成职责
c = c.replace(
  "                              : '${shortModel(lead?.model)} · ${lead?.thinking ?? ''}'),",
  [
    '                              : (firstLine(lead?.persona ?? "").isNotEmpty',
    '                                    ? preview(lead!.persona, 34)',
    "                                    : '在线')),",
  ].join('\n'),
);

// 用量行（↑0 ↓0 ⚡0）整块删掉，属于噪音
const usageBlock = [
  '                if (!streaming && msg.usage != null && showAuthor && _hasUsage(msg.usage!))',
  '                  Padding(',
  '                    padding: const EdgeInsets.only(top: 5, left: 2),',
  '                    child: Text(',
  '                      _usageLine(msg.usage!),',
  '                      style: const TextStyle(',
  '                        fontSize: PB.fsXxs,',
  '                        color: PB.textQuaternary,',
  "                        fontFamily: 'monospace',",
  '                      ),',
  '                    ),',
  '                  ),',
].join('\n');
c = c.replace(usageBlock, '');

fs.writeFileSync('lib/screens/chat_screen.dart', c);
console.log('chat_screen: 去掉作者名后的模型 / 标题栏模型 / 用量行');

// ---------- app_state：通知正文去 markdown ----------
let a = fs.readFileSync('lib/app_state.dart', 'utf8');
a = a.replace("import 'platform.dart';", "import 'platform.dart';\nimport 'text_utils.dart';");
a = a.replace(
  [
    '    Notifier.show(',
    "      title: room?.isGroup == true ? '${room!.name} · ${msg.authorName}' : msg.authorName,",
    '      body: text,',
    '      roomId: msg.roomId,',
    '    );',
  ].join('\n'),
  [
    '    Notifier.show(',
    "      title: room?.isGroup == true ? '${room!.name} · ${msg.authorName}' : msg.authorName,",
    '      body: preview(text, 120),',
    '      roomId: msg.roomId,',
    '    );',
  ].join('\n'),
);
fs.writeFileSync('lib/app_state.dart', a);
console.log('app_state: 通知正文去 markdown');
