/**
 * 连接请求：手机点"附近的电脑"之后，**电脑上要弹窗问一句**才放进来。
 *
 * ## 为什么不是"扫码/输码"就完事
 *
 * 配对码是"看得到这台电脑的人才能连"的凭证。可它有两个问题：
 *   1. 谁都能输，输对了就进来，主人全程不知道；
 *   2. 手机端体验差：要先跑到电脑前看终端里的 6 位数字。
 *
 * 连接请求把"凭据"换成了**人在电脑前点一下允许** —— 这也是更诚实的一道闸：
 * 主机上弹出来的是一条带来源 IP 的请求，而不是一条悄无声息的成功日志。
 *
 * 配对码那条路**保留**（`POST /api/pair`）：没有图形界面的部署（服务器、
 * 只跑 node 的机器）只能靠它。
 *
 * ## 安全边界（这里最容易做错）
 *
 *   · 请求 id 是 128 位随机数，**它本身就是凭证**：知道 id 才能轮询到 token。
 *     所以不能出现在日志、事件广播以外的任何地方。
 *   · 一个请求只能用一次：批准后 token 只交付一次，随后状态改成 approved 并立刻可查一次
 *     （第二次查就是 410，见 http 层）。
 *   · 没人点就过期（默认 60 秒），不会一直挂在那儿等人误点。
 *   · 同一个来源 IP 的请求有频率上限，免得有人拿它当"每分钟弹一次窗"的骚扰工具。
 */
import { randomBytes } from 'node:crypto';

/** 一个请求最多挂多久（毫秒）。超时即作废。 */
export const REQUEST_TTL_MS = 60_000;

/** 同一时刻最多几个待批请求（多了说明有人在刷） */
export const MAX_PENDING = 3;

/** 同一个 IP 60 秒内最多发几个请求 */
export const MAX_PER_IP_PER_MINUTE = 3;

const WINDOW_MS = 60_000;

/** 手机端能看到的字段（不含 token，token 只在批准后单次交付） */
function phoneView(request, { withToken = false } = {}) {
  const view = {
    id: request.id,
    status: request.status,
    device: request.device,
    expiresAt: request.expiresAt,
    expiresIn: Math.max(0, request.expiresAt - Date.now()),
  };
  if (withToken && request.status === 'approved' && request.token) {
    view.token = request.token;
    view.serverName = request.serverName;
    view.workspace = request.workspace;
  }
  return view;
}

/** 主机端（桌面 App）看到的字段：多了来源 IP，少了 token */
function hostView(request) {
  return {
    id: request.id,
    device: request.device,
    platform: request.platform,
    ip: request.ip,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  };
}

/**
 * @param {object} deps
 * @param {(name:string)=>{token:string, device:object}} deps.addDevice 批准时签发设备 token
 * @param {(event:object)=>void} deps.emit 推给电脑端（桌面 App 靠它弹窗）
 * @param {()=>object} [deps.describeServer] 批准后回给手机的服务端信息
 */
export function createPairRequests({ addDevice, emit = () => {}, describeServer = () => ({}), ttlMs = REQUEST_TTL_MS, now = Date.now } = {}) {
  const byId = new Map();
  /** ip → 最近创建时间戳列表 */
  const perIp = new Map();

  function prune(at) {
    for (const [id, request] of byId) {
      // 过期的**先留着**、只把状态改成 expired：手机正好在轮询时要能看到"过期了"，
      // 直接删掉会让它收到 410，界面上只能显示一句笼统的"已失效"。
      if (request.expiresAt <= at && request.status === 'pending') {
        request.status = 'expired';
      } else if (request.expiresAt + 5 * 60_000 <= at) {
        // 批过/拒过的也留一小会儿再清，免得轮询正好撞上清理
        byId.delete(id);
      }
    }
    for (const [ip, stamps] of perIp) {
      const kept = stamps.filter((t) => at - t < WINDOW_MS);
      if (kept.length) perIp.set(ip, kept);
      else perIp.delete(ip);
    }
  }

  function recentCount(ip) {
    return (perIp.get(ip) ?? []).length;
  }

  /**
   * 手机发起一个连接请求。
   * @throws {Error & {code:string}} 频率超了 / 待批太多
   */
  function create({ device, ip, platform }) {
    const at = now();
    prune(at);
    if (recentCount(ip) >= MAX_PER_IP_PER_MINUTE) {
      const err = new Error('连接请求太频繁，等一分钟再试');
      err.code = 'PAIR_REQUEST_RATE_LIMITED';
      throw err;
    }
    const pending = [...byId.values()].filter((r) => r.status === 'pending').length;
    if (pending >= MAX_PENDING) {
      const err = new Error('电脑上已经有好几个待批的连接请求了，先在电脑上处理一下');
      err.code = 'PAIR_REQUEST_BUSY';
      throw err;
    }
    const request = {
      id: randomBytes(16).toString('hex'),
      device: String(device ?? '').trim().slice(0, 60) || '一台手机',
      platform: String(platform ?? '').trim().slice(0, 20),
      ip: String(ip ?? ''),
      status: 'pending',
      createdAt: at,
      expiresAt: at + ttlMs,
      token: null,
      serverName: null,
      workspace: null,
    };
    byId.set(request.id, request);
    perIp.set(request.ip, [...(perIp.get(request.ip) ?? []), at]);
    emit({ t: 'pair.request', request: hostView(request) });
    return phoneView(request);
  }

  /**
   * 手机轮询。批准后**只交付一次** token。
   *
   * token 只交给**发起这条请求的那个 IP**：同一片 Wi-Fi 里有人抓包拿到了
   * 请求 id（比如从被入侵的路由器日志、或者手机装了流氓 App），只要他不在
   * 同一个地址上，就拿不到 token。这不是加密的替代品 —— 明文链路上 token
   * 本身仍然可被嗅探（见 docs/ANDROID.md 的"还没做的事"），但它把
   * "知道 id 就能换 token" 这条路堵掉了。
   */
  function poll(id, { ip = null, at = now() } = {}) {
    prune(at);
    const request = byId.get(String(id ?? ''));
    if (!request) return { ok: false, code: 'PAIR_REQUEST_NOT_FOUND' };
    if (request.status === 'pending' && request.expiresAt <= at) {
      request.status = 'expired';
    }
    if (ip && request.ip && String(ip) !== request.ip) {
      // 不交付 token，也不暴露这条请求的任何内容
      const err = new Error('这条连接请求不是从当前网络发起的');
      err.code = 'PAIR_REQUEST_WRONG_NETWORK';
      throw err;
    }
    const view = phoneView(request, { withToken: true });
    // 交付一次就把 token 从记录里抹掉：同一个 id 再轮询拿不到第二次。
    if (view.token) request.token = null;
    return { ok: true, view };
  }

  /** 电脑上点允许/拒绝。 */
  function decide(id, approve) {
    const at = now();
    prune(at);
    const request = byId.get(String(id ?? ''));
    if (!request) return { ok: false, code: 'PAIR_REQUEST_NOT_FOUND' };
    if (request.status !== 'pending') return { ok: false, code: 'PAIR_REQUEST_ALREADY_DECIDED', status: request.status };

    if (!approve) {
      request.status = 'denied';
      emit({ t: 'pair.request.resolved', request: hostView(request), status: 'denied' });
      return { ok: true, status: 'denied' };
    }

    const { token, device } = addDevice(request.device);
    request.status = 'approved';
    request.token = token;
    request.deviceId = device.id;
    const info = describeServer() ?? {};
    request.serverName = info.serverName ?? null;
    request.workspace = info.workspace ?? null;
    emit({ t: 'pair.request.resolved', request: hostView(request), status: 'approved' });
    return { ok: true, status: 'approved', device };
  }

  function pending() {
    prune(now());
    return [...byId.values()].filter((r) => r.status === 'pending').map(hostView);
  }

  return { create, poll, decide, pending, hostView, phoneView };
}
