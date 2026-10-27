import 'dart:typed_data';
import 'dart:ui';

/// 连续侧壁的数据：顶点色连接表面，同向实体覆盖消除内部共享边的抗锯齿接缝。
class AvatarSolidWall {
  AvatarSolidWall({
    required List<Offset> front,
    required List<Offset> back,
    required List<Color> frontColors,
    required List<Color> backColors,
    List<double>? frontDistance,
    List<double>? backDistance,
  }) {
    final count = front.length;
    assert(count >= 3 && back.length == count);
    assert(frontColors.length == count && backColors.length == count);
    assert(frontDistance == null || frontDistance.length == count);
    assert(backDistance == null || backDistance.length == count);
    positions = Float32List(count * 4);
    colors = Int32List(count * 2);
    for (var i = 0; i < count; i++) {
      positions[i * 4] = front[i].dx;
      positions[i * 4 + 1] = front[i].dy;
      positions[i * 4 + 2] = back[i].dx;
      positions[i * 4 + 3] = back[i].dy;
      colors[i * 2] = frontColors[i].toARGB32();
      colors[i * 2 + 1] = backColors[i].toARGB32();
    }

    final faces = List<int>.generate(count, (index) => index);
    if (frontDistance != null && backDistance != null) {
      double distance(int i) {
        final next = (i + 1) % count;
        return frontDistance[i] +
            frontDistance[next] +
            backDistance[i] +
            backDistance[next];
      }

      faces.sort((a, b) => distance(b).compareTo(distance(a)));
    }
    indices = Uint16List(count * 6);
    coverage = Path();
    void addCoverage(List<Offset> polygon) {
      coverage.addPolygon(
        signedAvatarArea(polygon) < 0 ? polygon.reversed.toList() : polygon,
        true,
      );
    }

    // 前、后面和侧壁在同一路径中填充，使共享边位于不透明实体内部。
    addCoverage(front);
    addCoverage(back);
    for (var order = 0; order < faces.length; order++) {
      final i = faces[order], next = (i + 1) % count;
      final quad = [front[i], back[i], back[next], front[next]];
      addCoverage(quad);
      indices.setRange(order * 6, order * 6 + 6, [
        i * 2,
        i * 2 + 1,
        next * 2 + 1,
        i * 2,
        next * 2 + 1,
        next * 2,
      ]);
    }
  }

  late final Float32List positions;
  late final Int32List colors;
  late final Uint16List indices;
  late final Path coverage;
}

/// 多边形有向面积，用于统一侧壁覆盖面的绕向。
double signedAvatarArea(List<Offset> points) {
  var twiceArea = 0.0;
  for (var i = 0; i < points.length; i++) {
    final next = points[(i + 1) % points.length];
    twiceArea += points[i].dx * next.dy - next.dx * points[i].dy;
  }
  return twiceArea * 0.5;
}
