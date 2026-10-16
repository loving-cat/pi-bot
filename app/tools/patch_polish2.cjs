const fs = require('fs');

// ---- rooms_screen: 空会话不要只说"还没有消息"，显示模型/职责更有信息量
let r = fs.readFileSync('lib/screens/rooms_screen.dart', 'utf8');
r = r.replace(
  `    final preview = busy
        ? '正在干活…'
        : last == null
            ? (room.topic.isNotEmpty ? room.topic : '还没有消息')
            : '\${last.isUser ? '我' : last.authorName}：\${shortText(last.text, 46)}';`,
  `    final bot = state.botById(room.botIds.isNotEmpty ? room.botIds.first : null);
    final preview = busy
        ? '正在干活…'
        : last == null
            ? (room.topic.isNotEmpty
                ? room.topic
                : (!room.isGroup && bot != null
                    ? '\${bot.model ?? '默认模型'} · thinking \${bot.thinking ?? '-'}'
                    : '还没有消息'))
            : '\${last.isUser ? '我' : last.authorName}：\${shortText(last.text, 46)}';`,
);
fs.writeFileSync('lib/screens/rooms_screen.dart', r);

// ---- chat_screen: 消息区顶部加一层渐变遮罩，滚动时不会"糊"到标题栏上
let c = fs.readFileSync('lib/screens/chat_screen.dart', 'utf8');
c = c.replace(
  `                      if (!_stick)
                        Positioned(
                          right: 16,
                          bottom: 12,`,
  `                      // 顶部渐变：消息滚上去时柔和淡出，而不是被标题栏硬切
                      Positioned(
                        left: 0,
                        right: 0,
                        top: 0,
                        height: 22,
                        child: IgnorePointer(
                          child: DecoratedBox(
                            decoration: BoxDecoration(
                              gradient: LinearGradient(
                                begin: Alignment.topCenter,
                                end: Alignment.bottomCenter,
                                colors: [PB.bgPane, PB.bgPane.withValues(alpha: 0)],
                              ),
                            ),
                          ),
                        ),
                      ),
                      if (!_stick)
                        Positioned(
                          right: 16,
                          bottom: 12,`,
);
fs.writeFileSync('lib/screens/chat_screen.dart', c);
console.log('补丁完成');
