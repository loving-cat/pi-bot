/// 角色轮廓与面部参数；相同种子在不同进程和平台产生相同结果。
enum AvatarCharacterKind {
  bean,
  pillow,
  pebble,
  capsule,
  cloud,
  wedge,
  hexagon,
  egg,
}

class AvatarCharacter {
  const AvatarCharacter({
    required this.kind,
    required this.eyeSpacing,
    required this.eyeScale,
    required this.faceLift,
    required this.restTilt,
  });

  final AvatarCharacterKind kind;
  final double eyeSpacing;
  final double eyeScale;
  final double faceLift;
  final double restTilt;

  /// 用有界整数运算生成稳定身份，不依赖运行时的 String.hashCode。
  factory AvatarCharacter.fromSeed(String seed) {
    var hash = 5381;
    for (final code in seed.codeUnits) {
      hash = ((hash * 33) ^ code) & 0x7fffffff;
    }
    hash = ((hash ^ (hash >> 16)) * 127) & 0x7fffffff;
    double fraction(int shift) => ((hash >> shift) & 255) / 255;
    return AvatarCharacter(
      kind:
          AvatarCharacterKind.values[hash % AvatarCharacterKind.values.length],
      eyeSpacing: 0.091 + fraction(4) * 0.012,
      eyeScale: 0.94 + fraction(8) * 0.10,
      faceLift: (fraction(12) - 0.5) * 0.014,
      restTilt: -0.17 - fraction(20) * 0.12,
    );
  }
}
