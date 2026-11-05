import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../l10n/l10n.dart';
import '../scope.dart';
import '../ime_guard.dart';
import '../theme.dart';
import 'toast.dart';

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
    toast(context, L10n.s(context).t('user.saved'));
  }

  @override
  Widget build(BuildContext context) {
    final strings = L10n.s(context);
    final state = AppScope.of(context);
    if (!_dirty && _c.text != state.userName) _c.text = state.userName;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Icon(LucideIcons.userRound, size: 15, color: PB.textTertiary),
            const SizedBox(width: 8),
            Text(
              strings.t('user.title'),
              style: const TextStyle(
                fontSize: PB.fsSm,
                fontWeight: FontWeight.w600,
                color: PB.textSecondary,
              ),
            ),
            const Spacer(),
            if (_dirty)
              FilledButton(
                onPressed: _save,
                child: Text(strings.t('common.save')),
              ),
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
              Text(
                strings.t('user.explain'),
                style: const TextStyle(
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
                onSubmitted: submitUnlessComposing(_c, _save),
                style: const TextStyle(fontSize: PB.fsSm),
                decoration: InputDecoration(
                  hintText: strings.t('user.hint'),
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
