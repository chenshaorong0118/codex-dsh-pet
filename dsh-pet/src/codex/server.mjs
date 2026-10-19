import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
export function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export async function readJson(req, max = 65536) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json'))
    throw Object.assign(new Error('需要 JSON 请求'), { status: 415 });
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Object.assign(new Error('请求过大'), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
export async function serve({ port = 31380, token, routes, page, api, shutdown }) {
  let origin;
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin))
        return json(res, 403, { error: '仅允许本机宠物页面访问' });
      const pathname = new URL(req.url, origin).pathname;
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('referrer-policy', 'no-referrer');
      res.setHeader('x-frame-options', 'DENY');
      if (pathname === '/health' && req.method === 'GET')
        return json(res, 200, { name: 'codex-dsh-pet', version: '1.0.0' });
      if (pathname === '/' && req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy':
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        });
        res.end(page);
        return;
      }
      if (pathname === '/api/session' && req.method === 'POST') {
        const body = await readJson(req);
        if (!sameSecret(body.token, token)) return json(res, 403, { error: '请使用启动器打开设置' });
        res.setHeader('set-cookie', `codex_pet=${token}; HttpOnly; SameSite=Strict; Path=/`);
        return json(res, 200, { ok: true });
      }
      const bearer = req.headers.authorization?.replace(/^Bearer /, '');
      const cookie = req.headers.cookie?.match(/(?:^|;\s*)codex_pet=([^;]+)/)?.[1];
      const authorized = sameSecret(bearer, token) || (sameSecret(cookie, token) && req.headers['x-codex-pet'] === '1');
      if (!authorized) return json(res, 401, { error: '请使用启动器打开设置' });
      if (pathname === '/api/shutdown' && req.method === 'POST') {
        json(res, 200, { ok: true });
        setTimeout(shutdown, 10);
        return;
      }
      if (pathname.startsWith('/api/')) return await api(pathname, req, res);
      const route = routes.find((r) => pathname === r.path || pathname.startsWith(r.path + '/'));
      if (route) return await route.handler(req, res);
      return json(res, 404, { error: '页面不存在' });
    } catch (e) {
      if (!res.headersSent) json(res, e.status || 400, { error: e.message });
      else res.destroy();
    }
  });
  server.requestTimeout = 100000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
