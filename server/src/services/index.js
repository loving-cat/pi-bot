/**
 * 统一领域服务聚合入口。
 *
 * 把 REST API（http.js）、Agent 对话内工具（tools.js / jarvis-tools.js）和外部 SDK
 * 收敛到同一套实例化服务上，确保业务规则、校验与副作用只有一份实现。
 */
import { config as defaultConfig } from '../config.js';
import { bus as defaultBus } from '../bus.js';
import { store as defaultStore } from '../store.js';
import { modelGroups as defaultModelGroups } from '../model-groups.js';
import { shells as defaultShells } from '../shells.js';

import { createBotService } from './bot-service.js';
import { createModelService, publicDecision } from './model-service.js';
import { createAutomationService } from './automation-service.js';
import { createCapabilityService } from './capability-service.js';
import { createPolicyService } from './policy-service.js';
import { createSummaryService } from './summary-service.js';

export function createServices({
  config = defaultConfig,
  store = defaultStore,
  bus = defaultBus,
  runner = null,
  modelGroups = defaultModelGroups,
  shells = defaultShells,
} = {}) {
  const { bots, rooms } = createBotService({ store, runner, modelGroups, shells });
  const models = createModelService({ store, runner, modelGroups });
  const automations = createAutomationService({ store, runner });
  const capabilities = createCapabilityService({ store, runner });
  const policy = createPolicyService({ store, runner });
  const summaries = createSummaryService({ store, runner });

  return {
    config,
    store,
    bus,
    bots,
    rooms,
    models,
    automations,
    capabilities,
    policy,
    summaries,
  };
}

export {
  createBotService,
  createModelService,
  createAutomationService,
  createCapabilityService,
  createPolicyService,
  publicDecision,
};
