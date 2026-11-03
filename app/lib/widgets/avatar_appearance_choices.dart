import 'package:flutter/material.dart';

import '../avatar_appearance.dart';
import '../theme.dart';
import 'avatar_character.dart';
import 'blob_avatar.dart';

const avatarColorPresets = [
  '#1E86FC',
  '#12C878',
  '#FB3A9C',
  '#9B5CFF',
  '#10C4AE',
  '#F94A80',
  '#F0901A',
  '#8C939B',
];

const avatarShapeNames = ['豆豆', '软方', '圆石', '胶囊', '云朵', '圆角三角', '六边形', '圆蛋'];

/// 共用颜色选择器；预设立即回传，自定义输入仅回传完整合法颜色。
class AvatarColorChoices extends StatefulWidget {
  const AvatarColorChoices({
    super.key,
    required this.color,
    required this.onChanged,
    this.onCustomChanged,
    this.onValidityChanged,
    this.allowEmptyDefault = true,
  });

  final String? color;
  final ValueChanged<String?> onChanged;
  final ValueChanged<String?>? onCustomChanged;
  final ValueChanged<bool>? onValidityChanged;
  final bool allowEmptyDefault;

  @override
  State<AvatarColorChoices> createState() => _AvatarColorChoicesState();
}

class _AvatarColorChoicesState extends State<AvatarColorChoices> {
  late final TextEditingController _hex = TextEditingController(
    text: normalizeAvatarColor(widget.color) ?? '',
  );
  final _focus = FocusNode();
  String? _error;

  @override
  void didUpdateWidget(AvatarColorChoices oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.color != oldWidget.color && !_focus.hasFocus) {
      _hex.text = normalizeAvatarColor(widget.color) ?? '';
      _error = null;
    }
  }

  @override
  void dispose() {
    _hex.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _choose(String? color) {
    setState(() {
      _error = null;
      _hex.text = color ?? '';
    });
    widget.onValidityChanged?.call(true);
    widget.onChanged(color);
  }

  void _edit(String value) {
    final valid =
        parseAvatarColor(value) != null ||
        (widget.allowEmptyDefault && value.isEmpty);
    setState(() {
      _error = valid ? null : '请输入完整的 #RRGGBB';
    });
    widget.onValidityChanged?.call(valid);
    if (valid) {
      (widget.onCustomChanged ?? widget.onChanged)(normalizeAvatarColor(value));
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = PB.colors(context);
    final selected = normalizeAvatarColor(widget.color);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final hex in avatarColorPresets)
              Semantics(
                button: true,
                selected: selected == hex,
                label: '颜色 $hex',
                child: Tooltip(
                  message: hex,
                  child: InkWell(
                    key: ValueKey('avatar-color-$hex'),
                    onTap: () => _choose(hex),
                    borderRadius: BorderRadius.circular(18),
                    child: Container(
                      width: 30,
                      height: 30,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: parseAvatarColor(hex),
                        border: Border.all(
                          color: selected == hex
                              ? colors.accentBright
                              : PB.borderSecondary,
                          width: selected == hex ? 3 : 1,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
        const SizedBox(height: 12),
        TextField(
          key: const ValueKey('avatar-color-hex'),
          controller: _hex,
          focusNode: _focus,
          onChanged: _edit,
          maxLength: 7,
          autocorrect: false,
          enableSuggestions: false,
          decoration: InputDecoration(
            labelText: widget.allowEmptyDefault ? '自定义颜色（留空默认）' : '自定义颜色',
            hintText: '#RRGGBB',
            errorText: _error,
            counterText: '',
          ),
        ),
      ],
    );
  }
}

/// 共用的八种轮廓和默认轮廓选项，只回传选择。
class AvatarShapeChoices extends StatelessWidget {
  const AvatarShapeChoices({
    super.key,
    required this.seed,
    required this.color,
    required this.shape,
    required this.onChanged,
  });

  final String seed;
  final Color color;
  final int? shape;
  final ValueChanged<int?> onChanged;

  @override
  Widget build(BuildContext context) {
    final selected = normalizeAvatarShape(shape);
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        ChoiceChip(
          key: const ValueKey('avatar-shape-default'),
          label: const Text('默认轮廓'),
          selected: selected == null,
          onSelected: (_) => onChanged(null),
        ),
        for (var i = 0; i < AvatarCharacterKind.values.length; i++)
          ChoiceChip(
            key: ValueKey('avatar-shape-$i'),
            avatar: BlobAvatar(
              seed: seed,
              color: color,
              shape: i,
              useBotAppearance: false,
              size: 22,
              animate: false,
              followPointer: false,
            ),
            label: Text(avatarShapeNames[i]),
            selected: selected == i,
            onSelected: (_) => onChanged(i),
          ),
      ],
    );
  }
}
