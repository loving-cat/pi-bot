const fs = require('fs');

// ---------- app_state.dart：流式 delta 走独立 tick，不触发全树重建 ----------
let a = fs.readFileSync('lib/app_state.dart', 'utf8');

a = a.replace(
  `  /// 每个会话里排队/插话中的用户消息条数
  final Map<String, int> queued = {};`,
  `  /// 每个会话里排队/插话中的用户消息条数
  final Map<String, int> queued = {};

  /// 流式输出的高频更新走这个，不走 notifyListeners。
  /// 否则每 80ms 一次 delta 会把整个界面（含左侧会话列表）重建一遍。
  final ValueNotifier<int> streamTick = ValueNotifier<int>(0);`,
);

// delta / steps 只 bump tick
a = a.replace(
  `      case 'msg.delta':
        final msg = _find(ev['roomId'] as String, ev['msgId'] as String);
        if (msg != null) {
          msg.text = ev['text'] as String? ?? msg.text;
          msg.status = 'streaming';
        }
        break;`,
  `      case 'msg.delta':
        final msg = _find(ev['roomId'] as String, ev['msgId'] as String);
        if (msg != null) {
          msg.text = ev['text'] as String? ?? msg.text;
          msg.status = 'streaming';
          streamTick.value++;
          return; // 不走 notifyListeners
        }
        break;`,
);

a = a.replace(
  `      case 'msg.steps':
        final msg = _find(ev['roomId'] as String, ev['msgId'] as String);
        if (msg != null) {
          msg.steps = ((ev['steps'] as List?) ?? const [])
              .whereType<Map<String, dynamic>>()
              .map(ToolStep.fromJson)
              .toList();
        }
        break;`,
  `      case 'msg.steps':
        final msg = _find(ev['roomId'] as String, ev['msgId'] as String);
        if (msg != null) {
          msg.steps = ((ev['steps'] as List?) ?? const [])
              .whereType<Map<String, dynamic>>()
              .map(ToolStep.fromJson)
              .toList();
          streamTick.value++;
          return; // 不走 notifyListeners
        }
        break;`,
);

a = a.replace(
  `  @override
  void dispose() {
    _disposed = true;
    disconnect();
    super.dispose();
  }`,
  `  @override
  void dispose() {
    _disposed = true;
    disconnect();
    streamTick.dispose();
    super.dispose();
  }`,
);

fs.writeFileSync('lib/app_state.dart', a);

// ---------- chat_screen.dart：消息列表订阅 tick ----------
let c = fs.readFileSync('lib/screens/chat_screen.dart', 'utf8');

c = c.replace(
  `                      ListView.builder(
                        controller: _scroll,
                        padding: const EdgeInsets.fromLTRB(12, 16, 12, 16),
                        itemCount: msgs.length,
                        itemBuilder: (ctx, i) {`,
  `                      ValueListenableBuilder<int>(
                        valueListenable: state.streamTick,
                        builder: (context, _, __) => ListView.builder(
                        controller: _scroll,
                        padding: const EdgeInsets.fromLTRB(12, 16, 12, 16),
                        itemCount: msgs.length,
                        itemBuilder: (ctx, i) {`,
);

// 给 ListView 收尾补一个括号
c = c.replace(
  `                          );
                        },
                      ),
                      // 顶部渐变：消息滚上去时柔和淡出，而不是被标题栏硬切`,
  `                          );
                        },
                      ),
                      ),
                      // 顶部渐变：消息滚上去时柔和淡出，而不是被标题栏硬切`,
);

fs.writeFileSync('lib/screens/chat_screen.dart', c);
console.log('性能补丁：streamTick 细粒度通知 已加');
