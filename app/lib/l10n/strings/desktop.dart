// 桌面相关的两个"放宽"开关（设置在「系统」标签页里，和授权面板同页）。

import 'area.dart';

const areaDesktop = StringArea(
  zh: {
    'desk.title': '这台电脑上的批准与操作',
    'desk.subtitle': '这两项都是**放宽**：打开之前请先看清代价。改一次记一条审计。',
    'desk.allowLocal': '允许在这台电脑上批准',
    'desk.allowLocalHint':
        '默认关：要动鼠标、跑命令这类申请必须用手机点。因为能跑命令的 bot 理论上可以自己读本机凭据、自己点掉那张卡。'
        '如果你不用手机端，打开这个才能在桌面上批 —— 代价就是上面那句话。',
    'desk.trustPhantom': '信任合成输入',
    'desk.trustPhantomHint':
        '有些软件（远程控制、串流）会不停假装"有人动了鼠标"，于是 bot 永远以为你在用。'
        '打开这个，它会认出"光标根本没动"、继续干活。你自己在动鼠标时照样让开。',
    'desk.awayAfter': '只在我不在时才动鼠标',
    'desk.awayAfterHint': '关着（默认）= 你一停手它就能动，你一碰鼠标它立刻让开。'
        '开着 = 必须等你离开这么久（分钟）之后才动同桌面。岛上的操作不受影响。',
    'desk.diagnose': '当前输入环境',
    'desk.synthetic': '检测到有程序在持续合成输入（光标不动）',
    'desk.clean': '输入环境正常',
    'desk.saved': '已保存',
    'desk.minutes': '分钟',
  },
  en: {
    'desk.title': 'Approvals and control on this computer',
    'desk.subtitle': 'Both switches below are relaxations. Each change is audited.',
    'desk.allowLocal': 'Allow approving on this computer',
    'desk.allowLocalHint':
        'Off by default: requests for mouse/keyboard or commands must be approved on your phone, '
        'because a bot that can run commands could read the local token and click that card itself. '
        'If you do not use the mobile app, turn this on to approve on the desktop instead.',
    'desk.trustPhantom': 'Trust synthetic input',
    'desk.trustPhantomHint':
        'Remote-control and streaming tools keep reporting "someone just moved the mouse", so the bot '
        'always thinks you are busy. With this on it recognises that the cursor never moves and keeps '
        'working; it still yields the moment you actually use the mouse.',
    'desk.awayAfter': 'Only touch the mouse while I am away',
    'desk.awayAfterHint': 'Off (default): it can act once you pause, and yields the moment you touch the mouse. '
        'On: it waits until you have been away this many minutes. Islands are unaffected.',
    'desk.diagnose': 'Current input environment',
    'desk.synthetic': 'Some program is continuously synthesising input (cursor never moves)',
    'desk.clean': 'Input environment looks normal',
    'desk.saved': 'Saved',
    'desk.minutes': 'min',
  },
);
