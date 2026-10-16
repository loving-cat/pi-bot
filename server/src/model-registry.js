/**
 * 模型这一层的接线：认 slug、报标签、把用户配的模型组注册进 pi。
 *
 * 独立出来的原因：这里出的错**最难查** ——
 * 用户在 App 里配了模型组，探活和菜单都显示可用，一到真跑却说找不到 key。
 * 根子就在"注册到哪个 runtime"上（必须是我们自己那个，见 session-factory）。
 * 这些函数现在只跟 modelRuntime 打交道，能单独测。
 */

/**
 * 把各种写法的模型标识认出来。
 *
 * 用户/模型可能写：`组id/模型id`（最正规）、裸 `模型id`、
 * 或者只写后半截（唯一能对上就认）。**对不上就返回 null** ——
 * 宁可不给模型（上层会退回默认），也不要瞎猜一个。
 */
export function resolveModel(runtime, slug) {
  if (!slug || !runtime) return null;
  const idx = slug.indexOf('/');
  if (idx > 0) {
    const direct = runtime.getModel(slug.slice(0, idx), slug.slice(idx + 1));
    if (direct) return direct;
  }
  const all = runtime.getModels();
  const byId = all.find((m) => m.id === slug);
  if (byId) return byId;
  // 只给了后半截：只有**唯一**匹配才认（两个组里都有同名模型时必须让人说清）
  const suffix = all.filter((m) => m.id.endsWith(`/${slug}`) || `${m.provider}/${m.id}` === slug);
  return suffix.length === 1 ? suffix[0] : null;
}

/** 当前默认模型的完整标识（日志和档位矩阵用） */
export function modelLabel(model) {
  return model ? `${model.provider}/${model.id}` : null;
}

/**
 * 把用户配的模型组同步进 pi 的 runtime。
 *
 *   · 新增的注册进去；
 *   · **删掉的显式注销** —— 不注销的话菜单里会留一个选不动的幽灵项，
 *     选中之后请求发到一个已经没了的 provider，报的错还很难懂；
 *   · registeredGroups 记住"我们注册过哪些"，避免每次全量重来。
 */
export function syncModelGroups(runtime, registered, configs, { onLog = () => {}, onError = () => {} } = {}) {
  if (!runtime) return registered;
  registered ??= new Set();

  for (const id of [...registered]) {
    if (configs[id]) continue;
    try {
      runtime.unregisterProvider(id);
      onLog(`🔌 模型组已移除：${id}`);
    } catch (err) {
      onError(id, err);
    }
    registered.delete(id);
  }

  for (const [id, cfg] of Object.entries(configs)) {
    try {
      runtime.registerProvider(id, cfg);
      registered.add(id);
    } catch (err) {
      onError(id, err);
    }
  }
  return registered;
}
