import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

const MAIN_ASSETS = Object.freeze(new Map([
  ['/app/feedback_patch.js', ['feedback_patch.js', 'text/javascript; charset=utf-8']],
  ['/app/lib/device-preset.js', ['lib/device-preset.js', 'text/javascript; charset=utf-8']],
  ['/app/src/renderer/legacy-reservation-entry.mjs', ['src/renderer/legacy-reservation-entry.mjs', 'text/javascript; charset=utf-8']],
  ['/app/src/renderer/legacy-reservation-workspace.mjs', ['src/renderer/legacy-reservation-workspace.mjs', 'text/javascript; charset=utf-8']],
  ['/app/src/renderer/legacy-bounded-views.mjs', ['src/renderer/legacy-bounded-views.mjs', 'text/javascript; charset=utf-8']],
  ['/app/src/renderer/legacy-storage-workbench.mjs', ['src/renderer/legacy-storage-workbench.mjs', 'text/javascript; charset=utf-8']],
  ['/app/src/renderer/legacy-list-selectors.mjs', ['src/renderer/legacy-list-selectors.mjs', 'text/javascript; charset=utf-8']],
  ['/app/src/renderer/legacy-dashboard-insights.mjs', ['src/renderer/legacy-dashboard-insights.mjs', 'text/javascript; charset=utf-8']],
  ['/app/src/domain/reservation-policy.mjs', ['src/domain/reservation-policy.mjs', 'text/javascript; charset=utf-8']],
  ['/app/src/domain/audit-result.mjs', ['src/domain/audit-result.mjs', 'text/javascript; charset=utf-8']],
  ['/test/browser-desktop-adapter.mjs', ['tests/edge/browser-desktop-adapter.mjs', 'text/javascript; charset=utf-8']],
  ['/control/', ['tests/edge/control-console/index.html', 'text/html; charset=utf-8']],
  ['/control/console.css', ['tests/edge/control-console/console.css', 'text/css; charset=utf-8']],
  ['/control/console.mjs', ['tests/edge/control-console/console.mjs', 'text/javascript; charset=utf-8']]
]));

function hostError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function loopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function safeToken(actual, expected) {
  const left = Buffer.from(String(actual || ''));
  const right = Buffer.from(String(expected));
  return left.length === right.length && timingSafeEqual(left, right);
}

function send(response, statusCode, contentType, body) {
  response.writeHead(statusCode, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer'
  });
  response.end(body);
}

function sendJson(response, statusCode, value) {
  send(response, statusCode, 'application/json; charset=utf-8', `${JSON.stringify(value)}\n`);
}

async function readJson(request, maxBodyBytes) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBodyBytes) throw hostError('REQUEST_BODY_TOO_LARGE', '请求体超过安全上限', 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw hostError('REQUEST_JSON_INVALID', '请求 JSON 无效', 400);
  }
}

function assertApiAccess(request, origin, token) {
  const authorization = String(request.headers.authorization || '');
  if (!authorization.startsWith('Bearer ') || !safeToken(authorization.slice(7), token)) {
    throw hostError('TEST_HOST_UNAUTHORIZED', '测试宿主令牌无效', 401);
  }
  const requestOrigin = request.headers.origin;
  if (requestOrigin && requestOrigin !== origin) {
    throw hostError('TEST_HOST_ORIGIN_REJECTED', '测试宿主拒绝跨源请求', 403);
  }
}

function hasUnsafeEncoding(rawUrl) {
  return /(?:\.\.|%2e|%2f|%5c)/i.test(String(rawUrl || ''));
}

export async function startTestHost({
  projectRoot,
  run,
  harness,
  token,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES
}) {
  if (!projectRoot || !run || !harness || typeof token !== 'string' || token.length < 8) {
    throw new TypeError('projectRoot, run, harness and an 8+ character token are required');
  }
  let origin = '';
  let publishedSnapshot = null;
  let closed = false;

  const apiRoutes = new Map([
    ['GET /api/state', () => harness.loadState()],
    ['POST /api/state/save', body => harness.saveState(body)],
    ['POST /api/reservation', body => harness.executeReservation(body)],
    ['POST /api/storage', body => harness.executeStorage(body)],
    ['POST /api/application', body => harness.executeApplication(body)],
    ['POST /api/excel/import', () => harness.importExcel()],
    ['POST /api/excel/import-folder', () => harness.importFolder()],
    ['POST /api/excel/export', body => harness.exportExcel(body)],
    ['POST /api/dashboard/export-png', body => harness.exportDashboardPng(body)],
    ['POST /api/state/backup', () => harness.backupState()],
    ['POST /api/state/restore', body => harness.restoreState(body)],
    ['GET /api/run', () => publishedSnapshot || run.snapshot()],
    ['POST /api/run/stop', () => run.requestStop('control-console')]
  ]);

  const server = http.createServer(async (request, response) => {
    try {
      if (!loopback(request.socket.remoteAddress)) throw hostError('TEST_HOST_REMOTE_REJECTED', '仅允许本机回环访问', 403);
      if (hasUnsafeEncoding(request.url)) throw hostError('STATIC_PATH_INVALID', '请求路径包含不安全编码', 400);
      const url = new URL(request.url, origin || 'http://127.0.0.1');
      const routeKey = `${request.method} ${url.pathname}`;
      if (url.pathname.startsWith('/api/')) {
        assertApiAccess(request, origin, token);
        const handler = apiRoutes.get(routeKey);
        if (!handler) throw hostError('API_ROUTE_NOT_FOUND', '测试 API 不存在', 404);
        const body = request.method === 'POST' ? await readJson(request, maxBodyBytes) : undefined;
        sendJson(response, 200, await handler(body));
        return;
      }
      if (request.method !== 'GET') throw hostError('STATIC_METHOD_REJECTED', '静态资源只允许 GET', 405);
      if (url.pathname === '/app/') {
        const source = await readFile(path.join(projectRoot, '电池测试通道预约Demo.html'), 'utf8');
        const injected = source.replace('<head>', '<head>\n<script src="/test/browser-desktop-adapter.mjs"></script>');
        send(response, 200, 'text/html; charset=utf-8', injected);
        return;
      }
      const asset = MAIN_ASSETS.get(url.pathname);
      if (!asset) throw hostError('STATIC_ROUTE_NOT_FOUND', '静态资源不在允许清单', 404);
      const bytes = await readFile(path.join(projectRoot, asset[0]));
      send(response, 200, asset[1], bytes);
    } catch (error) {
      sendJson(response, error.statusCode || 500, {
        ok: false,
        code: error.code || 'TEST_HOST_FAILED',
        message: error.statusCode ? error.message : '测试宿主内部错误'
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;

  return Object.freeze({
    origin,
    publish(snapshot) {
      publishedSnapshot = structuredClone(snapshot);
    },
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
}
