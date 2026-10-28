import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/chat_input_action.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/screens/chat_screen.dart';
import 'package:pi_bot/theme.dart';

/// 真实聊天输入组件的内存预览；不初始化应用连接或加载用户配置。
void main() => runApp(const ChatInputGallery());

class _GalleryState extends AppState {
  int sendCount = 0;
  String lastText = '';

  @override
  Future<void> loadMessages(String roomId, {bool force = false}) async {}

  @override
  Future<void> sendMessage(
    String roomId,
    String text, {
    String mode = 'steer',
    List<Attachment> attachments = const [],
    bool flushMerge = true,
  }) async {
    sendCount++;
    lastText = text;
    messages[roomId] = [
      ...messages[roomId] ?? [],
      Msg(
        id: 'fixture-input-$sendCount',
        roomId: roomId,
        authorType: 'user',
        authorName: '合成用户',
        text: text,
        status: 'done',
        createdAt: DateTime.now().millisecondsSinceEpoch,
      ),
    ];
    notifyListeners();
  }
}

class ChatInputGallery extends StatefulWidget {
  const ChatInputGallery({super.key});

  @override
  State<ChatInputGallery> createState() => _ChatInputGalleryState();
}

class _ChatInputGalleryState extends State<ChatInputGallery> {
  final List<String> _keyEvents = [];
  int _keySequence = 0;
  final room = Room(
    id: 'fixture-keyboard-room',
    name: '输入快捷键验证',
    kind: 'dm',
    botIds: const [],
  );
  late final _GalleryState state = _GalleryState()
    ..rooms = [room]
    ..link = LinkState.online;

  @override
  void initState() {
    super.initState();
    HardwareKeyboard.instance.addHandler(_observeKey);
  }

  /// 记录硬件事件与当时的修饰键状态，不消费或改写事件。
  bool _observeKey(KeyEvent event) {
    final kind = event is KeyDownEvent
        ? 'down'
        : event is KeyUpEvent
        ? 'up'
        : 'repeat';
    final keyboard = HardwareKeyboard.instance;
    setState(() {
      _keySequence++;
      _keyEvents.add(
        '$_keySequence $kind ${event.logicalKey.keyLabel}'
        ' | shift=${keyboard.isShiftPressed}'
        ' ctrl=${keyboard.isControlPressed}'
        ' meta=${keyboard.isMetaPressed}'
        ' synthesized=${event.synthesized}',
      );
      if (_keyEvents.length > 12) _keyEvents.removeAt(0);
    });
    return false;
  }

  @override
  void dispose() {
    HardwareKeyboard.instance.removeHandler(_observeKey);
    state.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AppScope(
    state: state,
    child: MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: PB.theme(),
      home: Scaffold(
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            AnimatedBuilder(
              animation: state,
              builder: (context, _) => Padding(
                padding: const EdgeInsets.all(16),
                child: Text(
                  '合成输入验证 · 不连接服务端\n发送次数：${state.sendCount}'
                  '\n平台：${defaultTargetPlatform.name} · 输入动作：${chatInputAction.name}'
                  '\n最近发送：${state.lastText.replaceAll('\n', ' ↵ ')}',
                  style: const TextStyle(color: PB.textPrimary, height: 1.5),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Text(
                '硬件按键（只读记录）\n${_keyEvents.isEmpty ? '等待按键' : _keyEvents.join('\n')}',
                style: const TextStyle(
                  color: PB.textSecondary,
                  fontSize: PB.fsXs,
                  height: 1.2,
                ),
              ),
            ),
            Expanded(child: ChatScreen(room: room, embedded: true)),
          ],
        ),
      ),
    ),
  );
}
