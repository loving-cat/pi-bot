import { EventEmitter } from 'node:events';

/**
 * 进程内事件总线：store / pi-runner 往里发，ws.js / SDK 订阅事件。
 * 事件形状统一为 { t: "<type>", ...payload }，与 App 侧协议一一对应。
 */
export function createBus() {
  const instance = new EventEmitter();
  instance.setMaxListeners(0);
  return instance;
}

export const bus = createBus();
