import 'package:flutter/material.dart';

import '../avatar_appearance.dart';
import '../theme.dart';
import 'avatar_appearance_choices.dart';
import 'blob_avatar.dart';

/// 外观草稿选择器；只回传合法草稿，不直接调用保存接口。
class AvatarAppearancePicker extends StatefulWidget {
  const AvatarAppearancePicker({
    super.key,
    required this.seed,
    required this.color,
    required this.shape,
    required this.onChanged,
    required this.onValidityChanged,
    this.isMain = false,
  });

  final String seed;
  final String? color;
  final int? shape;
  final bool isMain;
  final void Function(String? color, int? shape) onChanged;
  final ValueChanged<bool> onValidityChanged;

  @override
  State<AvatarAppearancePicker> createState() => _AvatarAppearancePickerState();
}

class _AvatarAppearancePickerState extends State<AvatarAppearancePicker> {
  int _resetVersion = 0;

  void _reset() {
    setState(() => _resetVersion++);
    widget.onValidityChanged(true);
    widget.onChanged(null, null);
  }

  @override
  Widget build(BuildContext context) {
    final previewColor =
        parseAvatarColor(widget.color) ?? PB.colorFor(widget.seed);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Expanded(
              child: Text('形象', style: TextStyle(fontWeight: FontWeight.w600)),
            ),
            TextButton(onPressed: _reset, child: const Text('恢复默认形象')),
          ],
        ),
        if (widget.isMain)
          const Padding(
            padding: EdgeInsets.only(bottom: 10),
            child: Text(
              '保存后，它的颜色会同步用于你的消息气泡、按钮和重点信息。',
              style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
            ),
          ),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(right: 16, top: 6),
              child: BlobAvatar(
                key: const ValueKey('avatar-appearance-preview'),
                seed: widget.seed,
                color: previewColor,
                shape: normalizeAvatarShape(widget.shape),
                useBotAppearance: false,
                size: 72,
                animate: false,
              ),
            ),
            Expanded(
              child: AvatarColorChoices(
                key: ValueKey('avatar-draft-colors-$_resetVersion'),
                color: widget.color,
                onChanged: (color) => widget.onChanged(color, widget.shape),
                onValidityChanged: widget.onValidityChanged,
              ),
            ),
          ],
        ),
        const SizedBox(height: 14),
        AvatarShapeChoices(
          seed: widget.seed,
          color: previewColor,
          shape: widget.shape,
          onChanged: (shape) => widget.onChanged(widget.color, shape),
        ),
      ],
    );
  }
}
