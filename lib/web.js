/**
 * 浏览器控制面：给前端的 LAA 开关提供读写接口。
 *
 * 只用 `ctx.webServer.register()` 这一条既有路由 seam（不新增依赖、不需要
 * typert 远端声明），路径全部挂在 `/dsh-laa` 前缀下：
 *
 * | 方法 | 路径 | 作用 |
 * |---|---|---|
 * | `GET`  | `/dsh-laa/health` | 插件是否在跑、总开关、时区 |
 * | `GET`  | `/dsh-laa/state?sessionId=<id>` | 一个会话的完整状态 |
 * | `POST` | `/dsh-laa/mode` | `{ sessionId, enabled }`，改写该会话的 LAA 模式 |
 *
 * 路由挂载是可选的：没有 webServer 的组合（headless / SDK / ACP）只是没有这个
 * 浏览器入口，LAA 的调度行为不受影响。
 *
 * @module dsh-laa/web
 */

/** 所有路由共用的路径前缀。 */
export const ROUTE_PREFIX = '/dsh-laa';

/** 请求体上限：这里只收发一个会话 id 与一个布尔值。 */
const MAX_BODY_BYTES = 64 * 1024;

/** 读完整请求体并解析为 JSON；空体解析为 `{}`。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(text);
        resolve(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

/** 回一个 JSON 响应。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 一个合法的会话 id：非空字符串且长度有界。 */
function validSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : undefined;
}

/**
 * 处理一条控制面请求。
 *
 * 独立导出而不是内联在路由里：它没有 `req`/`res` 之外的依赖，因此可以在单元测试
 * 里用一个假请求直接调用，不必真的开一个 HTTP 服务。
 * @param runtime - LAA 运行时。
 * @param method - HTTP 方法（大写）。
 * @param pathname - `${ROUTE_PREFIX}` 之后的剩余路径，已去掉首尾斜杠。
 * @param query - `URLSearchParams`（GET 参数）。
 * @param body - 已解析的请求体（POST）。
 * @returns `{ status, payload }`。
 */
export function handleRoute(runtime, method, pathname, query, body) {
  const route = pathname.replace(/^\/+|\/+$/g, '');

  if (method === 'GET' && (route === '' || route === 'health')) {
    return { status: 200, payload: { ok: true, value: {
      plugin: 'dsh-laa',
      masterEnabled: runtime.config.enabled,
      timeZone: runtime.timeZone,
      defaultMode: runtime.config.defaultMode,
    } } };
  }

  if (method === 'GET' && route === 'state') {
    const sessionId = validSessionId(query?.get?.('sessionId'));
    if (sessionId === undefined) return { status: 400, payload: { ok: false, error: 'sessionId is required' } };
    return { status: 200, payload: { ok: true, value: runtime.snapshot(sessionId) } };
  }

  if (method === 'POST' && route === 'mode') {
    const sessionId = validSessionId(body?.sessionId);
    if (sessionId === undefined) return { status: 400, payload: { ok: false, error: 'sessionId is required' } };
    if (typeof body?.enabled !== 'boolean') return { status: 400, payload: { ok: false, error: 'enabled must be a boolean' } };
    if (!runtime.config.enabled) return { status: 409, payload: { ok: false, error: 'dsh-laa is disabled by its enabled config' } };
    runtime.setEnabled(sessionId, body.enabled);
    return { status: 200, payload: { ok: true, value: runtime.snapshot(sessionId) } };
  }

  return { status: 404, payload: { ok: false, error: `no such route: ${method} ${ROUTE_PREFIX}/${route}` } };
}

/**
 * 把控制面挂到宿主 HTTP 服务上。
 * @param ctx - 插件上下文。
 * @param runtime - LAA 运行时。
 */
export function registerLaaRoutes(ctx, runtime) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://dsh-laa');
        const method = (req.method ?? 'GET').toUpperCase();
        try {
          const body = method === 'POST' || method === 'PUT' ? await readJsonBody(req) : undefined;
          const outcome = handleRoute(runtime, method, url.pathname.slice(ROUTE_PREFIX.length), url.searchParams, body);
          sendJson(res, outcome.status, outcome.payload);
        } catch (error) {
          ctx.logger.warn(`dsh-laa: control-plane request failed (${method} ${url.pathname})`, error);
          sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    });
  });
}
