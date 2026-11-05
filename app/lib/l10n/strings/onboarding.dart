// 首次配置引导（模型组与默认模型）。

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
  },
);
