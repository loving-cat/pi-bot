import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../avatar_appearance.dart';
import '../l10n/l10n.dart';
import '../theme.dart';
import 'avatar_appearance_choices.dart';
import 'blob_avatar.dart';
import 'bot_appearance_feedback.dart';

/// 形象与颜色的即时选择入口；持久化和重试由调用方处理。
class BotAppearanceControls extends StatefulWidget {
  const BotAppearanceControls({
    super.key,
    required this.seed,
    required this.color,
    required this.shape,
    required this.onColorChanged,
    required this.onShapeChanged,
    required this.onRetry,
    this.isMain = false,
    this.isSaving = false,
    this.isSaved = false,
    this.error,
    this.canRetry = false,
  });

  final String seed;
  final String? color;
  final int? shape;
  final ValueChanged<String?> onColorChanged;
  final ValueChanged<int?> onShapeChanged;
  final VoidCallback onRetry;
  final bool isMain;
  final bool isSaving;
  final bool isSaved;
  final String? error;
  final bool canRetry;

  @override
  State<BotAppearanceControls> createState() => _BotAppearanceControlsState();
}

class _BotAppearanceControlsState extends State<BotAppearanceControls> {
  final _colorMenu = MenuController();
  final _shapeMenu = MenuController();
  Timer? _debounce;
  String? _pendingColor;
  bool _waiting = false;
  int _colorVersion = 0;

  @override
  void didUpdateWidget(BotAppearanceControls oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.seed != widget.seed) {
      _debounce?.cancel();
      _pendingColor = null;
      _waiting = false;
      _colorVersion++;
    }
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _pendingColor = null;
    super.dispose();
  }

  void _chooseColor(String? color) {
    _debounce?.cancel();
    _pendingColor = null;
    setState(() {
      _waiting = false;
      if (color == null) _colorVersion++;
    });
    widget.onColorChanged(color);
  }

  void _editColor(String? color) {
    _debounce?.cancel();
    final valid = normalizeAvatarColor(color);
    if (valid == null) return;
    _pendingColor = valid;
    setState(() => _waiting = true);
    _debounce = Timer(const Duration(milliseconds: 500), _flushColor);
  }

  void _flushColor() {
    if (!mounted || _pendingColor == null) return;
    final color = _pendingColor;
    _pendingColor = null;
    _debounce?.cancel();
    setState(() => _waiting = false);
    widget.onColorChanged(color);
  }

  void _validityChanged(bool valid) {
    if (valid) return;
    _debounce?.cancel();
    _pendingColor = null;
    if (_waiting) setState(() => _waiting = false);
  }

  Widget _feedback() => BotAppearanceFeedback(
    waiting: _waiting,
    saving: widget.isSaving,
    saved: widget.isSaved,
    error: widget.error,
    canRetry: widget.canRetry,
    onRetry: widget.onRetry,
  );

  Widget _menu({
    required MenuController controller,
    required String title,
    required String value,
    required Widget icon,
    required Widget options,
    required String keyName,
  }) {
    return MenuAnchor(
      controller: controller,
      onClose: controller == _colorMenu
          ? () => scheduleMicrotask(_flushColor)
          : null,
      style: MenuStyle(
        backgroundColor: WidgetStatePropertyAll(PB.bgElevated),
        padding: const WidgetStatePropertyAll(EdgeInsets.zero),
      ),
      menuChildren: [
        SizedBox(
          width: 316,
          child: ConstrainedBox(
            constraints: BoxConstraints(
              maxHeight: MediaQuery.sizeOf(context).height * .65,
            ),
            child: SingleChildScrollView(
              primary: false,
              padding: const EdgeInsets.all(16),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 14),
                  options,
                  const SizedBox(height: 8),
                  _feedback(),
                ],
              ),
            ),
          ),
        ),
      ],
      builder: (context, menu, child) => OutlinedButton(
        key: ValueKey(keyName),
        onPressed: () {
          if (menu.isOpen) {
            menu.close();
          } else {
            if (controller == _colorMenu) _shapeMenu.close();
            if (controller == _shapeMenu) _colorMenu.close();
            menu.open();
          }
        },
        style: OutlinedButton.styleFrom(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
          foregroundColor: PB.textPrimary,
          side: BorderSide(color: PB.borderSecondary),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(PB.rLg),
          ),
        ),
        child: Row(
          children: [
            icon,
            const SizedBox(width: 7),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: const TextStyle(fontSize: PB.fsXs)),
                  Text(
                    value,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: PB.fsXxs,
                      color: PB.textTertiary,
                    ),
                  ),
                ],
              ),
            ),
            Icon(
              LucideIcons.chevronDown,
              size: 12,
              color: PB.textTertiary,
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final strings = L10n.s(context);
    final color = parseAvatarColor(widget.color) ?? PB.colorFor(widget.seed);
    final shape = normalizeAvatarShape(widget.shape);
    // ★ 标签必须跟随「实际画出来的轮廓」。
    //   shape == null 时头像按 seed 派生出某个具体轮廓，此时显示"默认轮廓"
    //   会和用户看到的形状对不上 —— 所以这里解析出真实 kind 再取名字。
    final resolvedKind = resolveAvatarShape(widget.seed, shape);
    final shapeLabel = strings.avatarShapeNames[resolvedKind.index];
    final colorName =
        strings.avatarColorName(normalizeAvatarColor(widget.color) ?? '') ??
        strings.t('avatar.colorCustom');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: _menu(
                controller: _shapeMenu,
                title: strings.t('avatar.shape'),
                value: shapeLabel,
                keyName: 'bot-appearance-shape',
                icon: BlobAvatar(
                  seed: widget.seed,
                  color: color,
                  shape: shape,
                  useBotAppearance: false,
                  size: 26,
                  animate: false,
                  followPointer: false,
                ),
                options: AvatarShapeChoices(
                  seed: widget.seed,
                  color: color,
                  shape: shape,
                  onChanged: widget.onShapeChanged,
                ),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: _menu(
                controller: _colorMenu,
                title: strings.t('avatar.color'),
                value: colorName,
                keyName: 'bot-appearance-color',
                icon: Container(
                  width: 22,
                  height: 22,
                  decoration: BoxDecoration(
                    color: color,
                    shape: BoxShape.circle,
                    border: Border.all(color: PB.borderSecondary),
                  ),
                ),
                options: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    AvatarColorChoices(
                      key: ValueKey('autosave-colors-$_colorVersion'),
                      color: widget.color,
                      onChanged: _chooseColor,
                      onCustomChanged: _editColor,
                      onValidityChanged: _validityChanged,
                      allowEmptyDefault: false,
                    ),
                    TextButton(
                      onPressed: () => _chooseColor(null),
                      child: Text(strings.t('avatar.restoreDefaultColor')),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 6),
        _feedback(),
        if (widget.isMain)
          Padding(
            padding: const EdgeInsets.only(top: 3),
            child: Text(
              strings.t('avatar.themeNote'),
              style: TextStyle(
                fontSize: PB.fsXxs,
                color: PB.textTertiary,
              ),
            ),
          ),
      ],
    );
  }
}
