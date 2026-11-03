import 'package:flutter/painting.dart';

import 'models.dart';
import 'widgets/avatar_character.dart';

/// 仅接受完整的 #RRGGBB；非法值不参与头像与主题着色。
Color? parseAvatarColor(String? value) {
  if (value == null || !RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(value)) {
    return null;
  }
  return Color(0xff000000 | int.parse(value.substring(1), radix: 16));
}

/// 规范化合法的颜色，null 表示使用默认外观。
String? normalizeAvatarColor(String? value) {
  return parseAvatarColor(value) == null ? null : value!.toUpperCase();
}

/// 仅允许已提供的轮廓下标，越界或未指定时使用种子轮廓。
int? normalizeAvatarShape(int? shape) =>
    shape != null && shape >= 0 && shape < AvatarCharacterKind.values.length
    ? shape
    : null;

Color? resolveAvatarColor(Bot? bot) => parseAvatarColor(bot?.avatarColor);

AvatarCharacterKind resolveAvatarShape(String seed, int? shape) {
  final index = normalizeAvatarShape(shape);
  return index == null
      ? AvatarCharacter.fromSeed(seed).kind
      : AvatarCharacterKind.values[index];
}

/// 外观保存字段；null 明确恢复默认值，形状 0 是有效选择。
Map<String, dynamic> avatarAppearancePatch({String? color, int? shape}) => {
  'avatarColor': normalizeAvatarColor(color),
  'avatarShape': normalizeAvatarShape(shape),
};
