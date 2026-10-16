const fs = require('fs');
const p = 'lib/screens/chat_screen.dart';
let s = fs.readFileSync(p, 'utf8');

// 1) 引入 services（HardwareKeyboard / LogicalKeyboardKey）
if (!s.includes("import 'package:flutter/services.dart';")) {
  s = s.replace("import 'package:flutter/material.dart';", "import 'package:flutter/material.dart';\nimport 'package:flutter/services.dart';");
}

// 2) 发完保持焦点
s = s.replace(
  `    } catch (err) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$err')));
        _input.text = text;
      }
    }
  }`,
  `    } catch (err) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$err')));
        _input.text = text;
      }
    } finally {
      // 发完继续留着焦点，方便接着敲
      if (mounted) _focus.requestFocus();
    }
  }`,
);

// 3) 整块替换 _Composer
const startMarker = 'class _Composer extends StatelessWidget {';
const endMarker = 'class _RoundButton extends StatelessWidget {';
const start = s.indexOf(startMarker);
const end = s.indexOf(endMarker);
if (start < 0 || end < 0) {
  console.error('找不到 _Composer 区块');
  process.exit(1);
}

const newComposer = `class _Composer extends StatefulWidget {
  const _Composer({
    required this.controller,
    required this.focus,
    required this.busy,
    required this.queuedCount,
    required this.onSend,
    required this.onStop,
  });

  final TextEditingController controller;
  final FocusNode focus;
  final bool busy;
  final int queuedCount;
  final VoidCallback onSend;
  final VoidCallback onStop;

  @override
  State<_Composer> createState() => _ComposerState();
}

class _ComposerState extends State<_Composer> {
  bool _hasText = false;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onTextChanged);
    _hasText = widget.controller.text.trim().isNotEmpty;
  }

  void _onTextChanged() {
    final hasText = widget.controller.text.trim().isNotEmpty;
    if (hasText != _hasText) setState(() => _hasText = hasText);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onTextChanged);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    final busy = widget.busy;
    final queuedCount = widget.queuedCount;
    final onSend = widget.onSend;
    final onStop = widget.onStop;
    final hasText = _hasText;

    return SafeArea(
      top: false,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (busy)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 5),
                decoration: BoxDecoration(
                  color: PB.bgBubble,
                  borderRadius: BorderRadius.circular(PB.rFull),
                  border: Border.all(color: PB.borderTertiary),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.bolt_rounded, size: 12, color: PB.accent),
                    const SizedBox(width: 5),
                    Text(
                      queuedCount > 0
                          ? '已插话 $queuedCount 条，它会在下一步看到'
                          : '正在干活 —— 现在发送 = 插话引导，不用等',
                      style: const TextStyle(fontSize: PB.fsXxs, color: PB.textTertiary),
                    ),
                  ],
                ),
              ),
            ),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  child: Container(
                    decoration: BoxDecoration(
                      color: PB.bgInput,
                      borderRadius: BorderRadius.circular(22),
                      border: Border.all(color: PB.borderSecondary),
                    ),
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    child: Focus(
                      // Enter 发送 / Shift+Enter 换行 / Ctrl(⌘)+Enter 也发送
                      onKeyEvent: (node, event) {
                        if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
                          return KeyEventResult.ignored;
                        }
                        final key = event.logicalKey;
                        final isEnter = key == LogicalKeyboardKey.enter ||
                            key == LogicalKeyboardKey.numpadEnter;
                        if (!isEnter) return KeyEventResult.ignored;
                        // Shift+Enter 交给 TextField 自己插换行
                        if (HardwareKeyboard.instance.isShiftPressed) {
                          return KeyEventResult.ignored;
                        }
                        onSend();
                        return KeyEventResult.handled;
                      },
                      child: TextField(
                        controller: controller,
                        focusNode: widget.focus,
                        minLines: 1,
                        maxLines: 6,
                        keyboardType: TextInputType.multiline,
                        // 手机软键盘上回车键直接变成「发送」
                        textInputAction: TextInputAction.send,
                        onSubmitted: (_) => onSend(),
                        style: const TextStyle(fontSize: PB.fsBase, height: 1.4),
                        decoration: InputDecoration(
                          hintText: busy ? '插话引导…' : '说点什么',
                          hintStyle: const TextStyle(color: PB.textQuaternary, fontSize: PB.fsBase),
                          border: InputBorder.none,
                          enabledBorder: InputBorder.none,
                          focusedBorder: InputBorder.none,
                          filled: false,
                          isDense: true,
                          contentPadding: const EdgeInsets.symmetric(vertical: 13),
                        ),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                if (busy) ...[
                  _RoundButton(
                    icon: Icons.stop_rounded,
                    color: PB.bgActive,
                    iconColor: PB.textSecondary,
                    tooltip: '打断这一轮',
                    onTap: onStop,
                  ),
                  const SizedBox(width: 6),
                ],
                _RoundButton(
                  icon: busy ? Icons.bolt_rounded : Icons.arrow_upward_rounded,
                  color: hasText ? PB.accent : PB.bgActive,
                  iconColor: hasText ? Colors.white : PB.textQuaternary,
                  tooltip: busy ? '插话引导 (Enter)' : '发送 (Enter)',
                  onTap: onSend,
                ),
              ],
            ),
          ),
          if (hasText)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Text(
                busy ? 'Enter 插话 · Shift+Enter 换行' : 'Enter 发送 · Shift+Enter 换行',
                style: const TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
              ),
            ),
        ],
      ),
    );
  }
}

`;

s = s.slice(0, start) + newComposer + s.slice(end);
fs.writeFileSync(p, s);
console.log('_Composer 已替换为带快捷键的版本');
