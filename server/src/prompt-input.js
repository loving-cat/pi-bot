/**
 * 把「用户这句话 + 他发的附件」拼成喂给模型的一段输入。
 *
 * 这里全是拼装逻辑，没有网络、没有会话 ——
 * 依赖（附件元数据、路径、正文提取）由外面注入，所以能拿假的依赖直接测，
 * 不用真往磁盘上放文件。
 */
import path from 'node:path';

/**
 * @param {object} deps
 * @param {string} deps.workspace      工作目录（算相对路径用）
 * @param {(id:string)=>any} deps.metaFor        附件元数据
 * @param {(id:string)=>string|null} deps.inboxPath   附件在工作目录里的落点
 * @param {(abs:string,name:string)=>Promise<string>} deps.attachmentBlock  文档正文提取
 */
export function createBuildInput({ workspace, metaFor, inboxPath, attachmentBlock }) {
  return async function buildInput(clean, files = []) {
    const imageIds = [];
    const docBlocks = [];
    const inboxRel = [];

    for (const id of files) {
      const meta = metaFor(id);
      if (!meta) continue;
      // 图片直接喂给模型（视觉模型能看图），不走正文提取
      if (meta.kind === 'image') {
        imageIds.push(id);
        continue;
      }
      const abs = inboxPath(id);
      if (!abs) continue;
      inboxRel.push(path.relative(workspace, abs).replace(/\\/g, '/'));
      docBlocks.push(await attachmentBlock(abs, meta.name));
    }

    const parts = [];
    if (clean) parts.push(clean);
    if (imageIds.length) parts.push(`（用户发了 ${imageIds.length} 张图）`);
    if (docBlocks.length) {
      if (!clean) parts.push('用户发了文件，正文如下：');
      parts.push('', ...docBlocks);
    }
    if (inboxRel.length) {
      // 正文已经抽出来了，但原文件也在工作目录里 —— 告诉它需要重读时用哪个工具
      parts.push('', `【附件已放进工作目录：${inboxRel.join('、')}，需要重读时用 extract_file】`);
    }

    return { promptText: parts.join('\n').trim(), imageIds };
  };
}
