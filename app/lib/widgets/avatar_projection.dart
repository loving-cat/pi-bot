import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui';

/// 归一化头像平面的透视投影；深度为正表示远离观察者。
class AvatarProjection {
  const AvatarProjection._({
    required this.yaw,
    required this.pitch,
    required this.amount,
  });

  static const center = Offset(0.49, 0.50);
  static const frontDepth = -0.145;
  static const backDepth = 0.145;
  static const cameraDistance = 1.8;
  static const maxYaw = 34 * math.pi / 180;
  static const maxPitch = 23 * math.pi / 180;

  /// 右转为负 yaw，下转为正 pitch；角度单位为弧度。
  final double yaw;
  final double pitch;
  final double amount;

  double get fit => 1 - amount * 0.08;
  bool get isNeutral => amount < 0.0001;

  factory AvatarProjection.fromGaze({
    required Offset gaze,
    required double size,
  }) {
    if (!size.isFinite || size <= 0) {
      return const AvatarProjection._(yaw: 0, pitch: 0, amount: 0);
    }
    final x = gaze.dx.isFinite
        ? (gaze.dx / (size * 0.16)).clamp(-1.0, 1.0)
        : 0.0;
    final y = gaze.dy.isFinite
        ? (gaze.dy / (size * 0.16)).clamp(-1.0, 1.0)
        : 0.0;
    return AvatarProjection._(
      yaw: -x * maxYaw,
      pitch: y * maxPitch,
      amount: math.max(x.abs(), y.abs()),
    );
  }

  /// 每个深度平面在正面姿态校准为原尺寸，转动后使用同一相机投影。
  Float64List planeTransform({
    double depth = 0,
    double roll = 0,
    double squeeze = 1,
    Offset offset = Offset.zero,
  }) {
    final cy = math.cos(yaw), sy = math.sin(yaw);
    final cp = math.cos(pitch), sp = math.sin(pitch);
    final cr = math.cos(roll), sr = math.sin(roll);
    final rest = (cameraDistance + depth) / cameraDistance;
    final safeSqueeze = squeeze.clamp(0.5, 2.0);
    final scaleX = rest * safeSqueeze;
    final scaleY = rest / safeSqueeze;

    final a = cy * cr * scaleX;
    final b = -cy * sr * scaleY;
    final c =
        sy * depth - a * (center.dx - offset.dx) - b * (center.dy - offset.dy);
    final d = (cp * sr + sp * sy * cr) * scaleX;
    final e = (cp * cr - sp * sy * sr) * scaleY;
    final f =
        -sp * cy * depth -
        d * (center.dx - offset.dx) -
        e * (center.dy - offset.dy);
    final g = (sp * sr - cp * sy * cr) * scaleX;
    final h = (sp * cr + cp * sy * sr) * scaleY;
    final i =
        cp * cy * depth -
        g * (center.dx - offset.dx) -
        h * (center.dy - offset.dy);
    final w = cameraDistance + i;
    final zoom = fit * cameraDistance;
    final matrix = Float64List(16);
    matrix[0] = (zoom * a + center.dx * g) / cameraDistance;
    matrix[4] = (zoom * b + center.dx * h) / cameraDistance;
    matrix[12] = (zoom * c + center.dx * w) / cameraDistance;
    matrix[1] = (zoom * d + center.dy * g) / cameraDistance;
    matrix[5] = (zoom * e + center.dy * h) / cameraDistance;
    matrix[13] = (zoom * f + center.dy * w) / cameraDistance;
    matrix[3] = g / cameraDistance;
    matrix[7] = h / cameraDistance;
    matrix[10] = 1;
    matrix[15] = w / cameraDistance;
    return matrix;
  }

  Offset project(Offset point, {double depth = 0}) =>
      projectAvatarPoint(point, planeTransform(depth: depth));

  /// 局部透视倍率，包含正面校准和整体边界留量，不包含平面的角度缩短。
  double scaleAt(Offset point, {double depth = 0}) {
    final matrix = planeTransform(depth: depth);
    final w = matrix[3] * point.dx + matrix[7] * point.dy + matrix[15];
    return fit * (cameraDistance + depth) / cameraDistance / w;
  }
}

/// 使用已生成的平面矩阵投影点，供轮廓侧壁和面部共用。
Offset projectAvatarPoint(Offset point, Float64List matrix) {
  final w = matrix[3] * point.dx + matrix[7] * point.dy + matrix[15];
  return Offset(
    (matrix[0] * point.dx + matrix[4] * point.dy + matrix[12]) / w,
    (matrix[1] * point.dx + matrix[5] * point.dy + matrix[13]) / w,
  );
}
