// 所有区域的注册表：新增区域只需在这里加一行。

import 'area.dart';
import 'avatar.dart';
import 'chat.dart';
import 'common.dart';
import 'errors.dart';
import 'model.dart';
import 'onboarding.dart';
import 'panel.dart';
import 'panel2.dart';
import 'room.dart';
import 'settings.dart';
import 'settings2.dart';

export 'area.dart';

/// 全部区域。按文件名排序，方便查重。
const allStringAreas = <StringArea>[
  areaAvatar,
  areaChat,
  areaCommon,
  areaErrors,
  areaModel,
  areaOnboarding,
  areaPanel,
  areaPanel2,
  areaRoom,
  areaSettings,
  areaSettings2,
  areaWindow,
];
