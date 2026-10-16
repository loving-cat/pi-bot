const fs = require('fs');
const p = 'lib/screens/chat_screen.dart';
let s = fs.readFileSync(p, 'utf8');

// 1) _MessageRow 支持 mentions
s = s.replace(
  `  const _MessageRow({
    required this.msg,
    required this.showAuthor,
    required this.bot,
    required this.onLongPress,
  });`,
  `  const _MessageRow({
    required this.msg,
    required this.showAuthor,
    required this.bot,
    required this.onLongPress,
    this.mentions = const [],
  });`,
);
s = s.replace(
  `  final Bot? bot;
  final VoidCallback onLongPress;`,
  `  final Bot? bot;
  final VoidCallback onLongPress;

  /// 部门成员名字，用来高亮 @提及
  final List<String> mentions;`,
);

// 2) 传给 MdText
s = s.replace(
  `                          MdText(
                            streaming ? '\${msg.text}▍' : msg.text,
                            selectable: !streaming,
                            style: const TextStyle(fontSize: PB.fsBase, height: 1.5, color: PB.textPrimary),
                          ),`,
  `                          MdText(
                            streaming ? '\${msg.text}▍' : msg.text,
                            selectable: !streaming,
                            mentions: mentions,
                            style: const TextStyle(fontSize: PB.fsBase, height: 1.5, color: PB.textPrimary),
                          ),`,
);

// 3) builder 传成员名
s = s.replace(
  `                            child: _MessageRow(
                              msg: msg,
                              showAuthor: newAuthor,
                              bot: state.botById(msg.authorId),
                              onLongPress: () => showMessageActions(context, msg),
                            ),`,
  `                            child: _MessageRow(
                              msg: msg,
                              showAuthor: newAuthor,
                              bot: state.botById(msg.authorId),
                              mentions: room.botNames,
                              onLongPress: () => showMessageActions(context, msg),
                            ),`,
);

// 4) 群标题栏：显示部门老大
s = s.replace(
  `                  Text(
                    busy
                        ? '正在干活…'
                        : (room.isGroup
                              ? '\${room.botIds.length} 个 bot'
                              : '\${lead?.model ?? '默认模型'} · \${lead?.thinking ?? ''}'),`,
  `                  Text(
                    busy
                        ? '正在干活…'
                        : (room.isGroup
                              ? '老大 \${room.leadName ?? '-'} · \${room.botIds.length} 人'
                              : '\${shortModel(lead?.model)} · \${lead?.thinking ?? ''}'),`,
);

fs.writeFileSync(p, s);
console.log('chat_screen: @提及高亮 + 部门老大标识 已加');
