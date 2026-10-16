import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../scope.dart';
import '../theme.dart';

/// 设置里的「我是谁」。
///
/// 为什么要有：bot 需要知道**在跟谁说话**。不设这个的话，它只能从人设里猜，
/// 或者干脆不称呼你 —— 而在群里它还得知道"哪条消息是那个真人发的"。
/// 设了之后服务端会把它拼进每个 bot 的系统提示（下一轮生效），
/// 你不用再往每个人的人设里写"用户叫 XX"。
class UserNameSection extends StatefulWidget {
  const UserNameSection({super.key});

  @override
  State<UserNameSection> createState() => _UserNameSectionState();
}

class _UserNameSectionState extends State<UserNameSection> {
  final _c = TextEditingController();
  bool _dirty = false;

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    await AppScope.read(context).saveUserName(_c.text.trim());
    if (!mounted) return;
    setState(() => _dirty = false);
    ScaffoldMessenger.maybeOf(context)
        ?.showSnackBar(const SnackBar(content: Text('已保存，bot 下一轮起会这么称呼你')));
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    if (!_dirty && _c.text != state.userName) _c.text = state.userName;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Icon(LucideIcons.userRound, size: 15, color: PB.textTertiary),
            const SizedBox(width: 8),
            const Text(
              '我是谁',
              style: TextStyle(
                fontSize: PB.fsSm,
                fontWeight: FontWeight.w600,
                color: PB.textSecondary,
              ),
            ),
            const Spacer(),
            if (_dirty) FilledButton(onPressed: _save, child: const Text('保存')),
          ],
        ),
        const SizedBox(height: 4),
        Container(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
          decoration: BoxDecoration(
            color: PB.bgPane,
            borderRadius: BorderRadius.circular(PB.rXl),
            border: Border.all(color: PB.borderTertiary),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'bot 会用这个名字称呼你。设一次就行 —— 不用往每个人的人设里写'
                '"用户叫 XX"。群里它也知道哪条是你发的（其余都是同事）。',
                style: TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textQuaternary,
                  height: 1.6,
                ),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _c,
                onChanged: (_) {
                  if (!_dirty) setState(() => _dirty = true);
                },
                onSubmitted: (_) => _save(),
                style: const TextStyle(fontSize: PB.fsSm),
                decoration: InputDecoration(
                  hintText: '比如：小陈 / Boss / 老板',
                  isDense: true,
                  contentPadding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 10,
                  ),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(PB.rLg),
                    borderSide: const BorderSide(color: PB.borderSecondary),
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
