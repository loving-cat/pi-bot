/** 连接中心路由适配，调用方负责鉴权、请求体读取与响应编码。 */
export async function routeConnections({ req, res, pathname, connections, readBody, send }) {
  if (pathname === '/api/connections' && req.method === 'GET') {
    send(res, 200, connections.list());
    return true;
  }
  const match = pathname.match(/^\/api\/connections\/([^/]+)\/(verify|bots)$/);
  if (!match || (match[2] === 'verify' ? req.method !== 'POST' : req.method !== 'PUT')) return false;
  const id = decodeURIComponent(match[1]);
  const result = match[2] === 'verify'
    ? await connections.verify(id)
    : await connections.assign(id, (await readBody(req)).botIds);
  const { status = 200, ...body } = result;
  send(res, status, body);
  return true;
}
