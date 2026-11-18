/**
 * Orbis 进程内 Agent SDK 门面。
 *
 * 对标 `@earendil-works/pi-coding-agent` 的可嵌入用法：
 *   const rt = await createOrbisRuntime({ dataDir, workspace, modelGroups: [...] });
 *   rt.onEvent((ev) => ...);
 *   const res = await rt.askMain('帮我整理项目结构');
 *   await rt.dispose();
 *
 * 特点：
 *   · 仅 import 本模块不会读写默认全局 `~/.local/share/pi-bot` 或 `state.json`；
 *   · 同一 Node 进程可并行创建多个互不串状态、互不抢总线的独立 runtime；
 *   · 底层仍复用唯一一条骨架：`Config + Store + Bus + GrantGate + PiRunner + Services`。
 */
import { randomUUID } from 'node:crypto';
import { defineTool } from '@earendil-works/pi-coding-agent';

import { BRAND_NAME, BRAND_SLUG } from '../brand.js';
import { createConfig } from '../config.js';
import { createBus } from '../bus.js';
import { createStore } from '../store.js';
import { createModelGroupStore } from '../model-groups.js';
import { loadOrCreateKey } from '../secrets.js';
import { PiRunner } from '../pi-runner.js';
import { createGrantGate } from '../grant-gate.js';
import { ensureLegacyGrant } from '../migration-grants.js';
import { createAutomationScheduler } from '../automations.js';
import { createServices } from '../services/index.js';
import { createTaskHost } from '../bootstrap/task-host.js';
import { createTaskCommands } from '../tasks/task-commands.js';
import { ACTION } from '../grants.js';
import { ACTIONS, TOOL_SPECS, auditCapabilities } from '../capabilities.js';
import {
  OrbisClient,
  createOrbisClient,
  PiBotClient,
  createPiBotClient,
} from './client.js';

export async function createOrbisRuntime(options = {}) {
  const cfg = createConfig({
    ...(options.config ?? {}),
    ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
    ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
    autoProbe: options.autoProbe ?? options.config?.autoProbe ?? false,
    lessonReflect: options.lessonReflect ?? options.config?.lessonReflect ?? false,
    serverBoot: false,
  });

  const bus = createBus();
  const secretsKey = options.secretsKey ?? loadOrCreateKey(cfg.dataDir);
  const store = createStore({ config: cfg, bus, dataDir: cfg.dataDir, secretsKey });
  const modelGroups = createModelGroupStore({ dataDir: cfg.dataDir });

  if (options.userName) {
    store.updateUserName(options.userName);
  }
  if (Array.isArray(options.modelGroups)) {
    for (const group of options.modelGroups) {
      const r = modelGroups.upsert(group);
      if (r.error) throw new Error(`模型组配置不合法：${r.error}`);
    }
  }
  if (options.policy && typeof options.policy === 'object') {
    store.updatePolicy(options.policy);
  }

  const generation = `sdk-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const taskIntake = Boolean(options.taskIntake ?? false);
  const runner = new PiRunner({
    config: cfg,
    store,
    bus,
    modelGroups,
    sessionApi: options.sessionApi ?? null,
    modelRuntimeFactory: options.modelRuntimeFactory ?? null,
    inheritHostProviders: options.inheritHostProviders ?? false,
    taskIntake,
  });

  if (options.installGrantGate !== false) {
    const syncGrants = ({ botIds }) => ensureLegacyGrant({
      store,
      policy: store.policy(),
      policyRevision: store.policyVersion(),
      botIds,
      chiefBotId: store.mainBot()?.id ?? null,
      generation,
    });
    syncGrants({ botIds: store.listBots().map((b) => b.id) });
    runner.grantGate = createGrantGate({
      store,
      currentPolicyRevision: () => store.policyVersion(),
      currentGeneration: () => generation,
      syncGrants,
      bus,
    });
    runner.grantGate.start();
    runner.grantGeneration = () => generation;
  }

  const services = createServices({ config: cfg, store, bus, runner, modelGroups });
  runner.services = services;

  await runner.init();

  if (options.defaultModel) {
    const res = await services.models.setDefaultModel(options.defaultModel);
    if (!res.ok) throw new Error(res.error || `无法设置默认模型：${options.defaultModel}`);
  }

  let taskHost = null;
  if (taskIntake) {
    taskHost = createTaskHost({ store, runner });
    runner.taskCommands = createTaskCommands({ store, runner, taskRuns: store.taskRuns });
  }

  let scheduler = null;
  if (options.enableAutomations === true) {
    scheduler = createAutomationScheduler({
      store,
      run: (automation) => runner.runAutomation(automation),
    });
    scheduler.start();
  }

  let disposed = false;

  function onEvent(handler) {
    if (typeof handler !== 'function') return () => {};
    bus.on('event', handler);
    return () => bus.off('event', handler);
  }

  async function askMain(text, opts = {}) {
    const main = store.mainBot();
    if (!main) throw new Error('找不到 mainBot');
    const dm = store.ensureDm(main.id);
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 120_000;
    const { timeoutMs: _drop, ...sendOpts } = opts;

    let doneMsg = null;
    let settled = false;
    let timer = null;
    let resolveTurn;
    let rejectTurn;
    const donePromise = new Promise((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    donePromise.catch(() => {});

    const onBusEvent = (ev) => {
      const evRoomId = ev?.roomId ?? ev?.msg?.roomId;
      if (settled || evRoomId !== dm.id) return;
      if (ev.t === 'msg.done' && ev.msg?.authorType === 'bot' && ev.msg?.authorId === main.id) {
        settled = true;
        doneMsg = ev.msg;
        resolveTurn(ev.msg);
      } else if (ev.t === 'msg.error') {
        settled = true;
        const err = new Error(ev.error || 'mainBot 执行失败');
        err.msg = ev.msg ?? null;
        rejectTurn(err);
      }
    };
    bus.on('event', onBusEvent);
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        rejectTurn(new Error(`askMain 超时（>${timeoutMs}ms）`));
      }, timeoutMs);
    }

    try {
      const sendResult = await runner.send(dm.id, text, { flushMerge: true, ...sendOpts });
      const reply = doneMsg ?? await donePromise;
      return {
        roomId: dm.id,
        userMessage: sendResult?.userMessage ?? null,
        reply,
        replyText: reply?.text ?? '',
      };
    } finally {
      bus.off('event', onBusEvent);
      if (timer) clearTimeout(timer);
    }
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    scheduler?.stop?.();
    taskHost?.dispose?.();
    runner.grantGate?.stop?.();
    runner.disposeAll();
    store.dispose();
    bus.removeAllListeners();
  }

  return {
    config: cfg,
    store,
    bus,
    modelGroups,
    runner,
    generation,
    services,
    bots: services.bots,
    rooms: services.rooms,
    models: services.models,
    automations: services.automations,
    capabilities: services.capabilities,
    policy: services.policy,
    send: (roomId, text, opts = {}) => runner.send(roomId, text, { flushMerge: true, ...opts }),
    askMain,
    runBotOnce: (args) => runner.runBotOnce(args),
    abort: (roomId, opts = {}) => runner.abort(roomId, opts),
    reset: (roomId) => runner.resetRoomSessions(roomId),
    onEvent,
    dispose,
  };
}

/** 向后兼容旧称 */
export const createPiBotRuntime = createOrbisRuntime;

export {
  defineTool,
  BRAND_NAME,
  BRAND_SLUG,
  ACTIONS,
  ACTION,
  TOOL_SPECS,
  auditCapabilities,
  createConfig,
  createBus,
  createStore,
  createModelGroupStore,
  createServices,
  OrbisClient,
  createOrbisClient,
  PiBotClient,
  createPiBotClient,
};
