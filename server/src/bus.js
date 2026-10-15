import { EventEmitter } from 'node:events';

/**
 * 进程内事件总线：store / pi-runner 往里发，ws.js 订阅后广播给所有手机。
 * 事件形状统一为 { t: "<type>", ...payload }，与 App 侧协议一一对应。
 */
export const bus = new EventEmitter();
bus.setMaxListeners(0);
