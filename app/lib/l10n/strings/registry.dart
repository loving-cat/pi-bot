// 所有区域的注册表：新增区域只需在这里加一行。

import 'area.dart';
import 'avatar.dart';
import 'common.dart';
import 'model.dart';
import 'settings.dart';

export 'area.dart';

/// 全部区域。按文件名排序，方便查重。
const allStringAreas = <StringArea>[
  areaAvatar,
  areaCommon,
  areaModel,
  areaSettings,
  areaWindow,
];
