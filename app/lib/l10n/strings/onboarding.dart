// 首次配置引导：模型组与默认模型 + 授权范围（§13.2）。
//
// ★ 注意里面 `perm.*` 那批文案。步骤正文、风险提示、硬隔离边界的具体句子
//   由服务端算好返回（`server/src/onboarding.js`），这里是**界面骨架**的文案。
//   正文暂未本地化：英文界面下正文仍是中文。要改得先让服务端返回
//   `id` 而不是整句，这不是加几条文案能解决的（见 docs/NEXT-SESSION.md）。

import 'area.dart';

const areaOnboarding = StringArea(
  zh: {
    'onboard.title': '先配置一个模型',
    'onboard.subtitle': 'pi-bot 靠模型干活。没有可用的模型组时，bot 收到消息也无法回复。',
    'onboard.step1': '填接口地址、API Key，选接口类型',
    'onboard.step2': '点「测试连通性」，自动发现可用模型并填入',
    'onboard.step3': '保存后选一个默认模型',
    'onboard.start': '开始配置',
    'onboard.later': '稍后再说',
    'onboard.pickTitle': '选一个默认模型',
    'onboard.pickSubtitle': '助手和各团队默认用它。之后可以在设置里按 bot 单独改。',
    'onboard.pickConfirm': '就用这个',
    'onboard.noModelsInGroup': '这个模型组里没有模型，请先在设置里添加。',
    'onboard.openSettings': '打开设置',
    'onboard.hintTitle': '还没有模型组',
    'onboard.hintBody': '配好之后 bot 才能回话。',
    // ---- 首次授权页（规格 §13.2）----
    'perm.title': '先划定它能碰到的范围',
    'perm.project': '负责人项目',
    'perm.gitScope': '普通 Git 动作范围',
    'perm.confirmEach': '这些每次都要你点批准（调宽档位也免不了）',
    'perm.boundaries': '能保证的，和给不了的',
    'perm.warnings': '要留意',
    'perm.blockers': '还差东西，开始不了',
    'perm.start': '开始',
    'perm.saved': '保存改动',
    'perm.later': '稍后再说',
    'perm.blocked': '还差东西',
  },
  en: {
    'onboard.title': 'Set up a model first',
    'onboard.subtitle': 'pi-bot runs on models. Without a usable model group, bots cannot reply to anything.',
    'onboard.step1': 'Fill in the base URL, API key and API type',
    'onboard.step2': 'Hit Test connection to discover and fill in available models',
    'onboard.step3': 'Save, then pick a default model',
    'onboard.start': 'Start setup',
    'onboard.later': 'Later',
    'onboard.pickTitle': 'Pick a default model',
    'onboard.pickSubtitle': 'The assistant and all teams use it by default. You can override it per bot later in Settings.',
    'onboard.pickConfirm': 'Use this one',
    'onboard.noModelsInGroup': 'This model group has no models. Add some in Settings first.',
    'onboard.openSettings': 'Open Settings',
    'onboard.hintTitle': 'No model group yet',
    'onboard.hintBody': 'Bots can only reply once a model is configured.',
    // ---- First-run authorization page (spec §13.2) ----
    'perm.title': 'Set the bounds it can reach',
    'perm.project': 'Owning project',
    'perm.gitScope': 'Ordinary Git actions',
    'perm.confirmEach': 'These always ask you first (a wider danger level does not skip them)',
    'perm.boundaries': 'What it guarantees, and what it cannot',
    'perm.warnings': 'Worth knowing',
    'perm.blockers': 'Something is missing',
    'perm.start': 'Start',
    'perm.saved': 'Save changes',
    'perm.later': 'Later',
    'perm.blocked': 'Needs setup',
  },
);
