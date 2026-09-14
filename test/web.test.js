import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { handleRoute, registerLaaRoutes, ROUTE_PREFIX } from '../lib/web.js';
import { childHeader, createRuntimeHarness } from './harness.js';

/** 一个测试独占一个临时状态目录。 */
function withRuntime(body) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-laa-web-'));
  try {
    const harness = createRuntimeHarness({ statePath: join(directory, 'state.json'), now: Date.UTC(2026, 8, 14, 2, 0) });
    try {
      return body(harness, harness.runtime);
    } finally {
      harness.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** 造一个 `URLSearchParams`。 */
function query(params) {
  return new URLSearchParams(params);
}

test('前缀是插件自己的命名空间', () => {
  assert.equal(ROUTE_PREFIX, '/dsh-laa');
});

test('GET /health 报告总开关与时区', () => {
  withRuntime((_harness, runtime) => {
    const outcome = handleRoute(runtime, 'GET', '', undefined, undefined);
    assert.equal(outcome.status, 200);
    assert.equal(outcome.payload.ok, true);
    assert.equal(outcome.payload.value.plugin, 'dsh-laa');
    assert.equal(outcome.payload.value.masterEnabled, true);
    assert.equal(outcome.payload.value.timeZone, 'Asia/Shanghai');
  });
});

test('GET /state 需要一个 sessionId', () => {
  withRuntime((_harness, runtime) => {
    assert.equal(handleRoute(runtime, 'GET', '/state', query({}), undefined).status, 400);
    assert.equal(handleRoute(runtime, 'GET', '/state', query({ sessionId: '' }), undefined).status, 400);
    assert.equal(handleRoute(runtime, 'GET', '/state', query({ sessionId: 's1' }), undefined).status, 200);
  });
});

test('GET /state 返回与命令、状态文件同源的那份快照', () => {
  withRuntime((_harness, runtime) => {
    const outcome = handleRoute(runtime, 'GET', 'state', query({ sessionId: 's1' }), undefined);
    const value = outcome.payload.value;
    assert.equal(value.sessionId, 's1');
    assert.equal(value.enabled, false);
    assert.equal(value.phase, 'peak');
    assert.equal(value.timeZone, 'Asia/Shanghai');
    assert.equal(value.peakWindows, '周一至周五 09:00-12:00、周一至周五 14:00-18:00');
    assert.equal(value.masterEnabled, true);
    assert.equal(value.deferred, 0);
    // 与 /laa 命令读的是同一个 snapshot()
    assert.deepEqual(value, runtime.snapshot('s1'));
  });
});

test('POST /mode 打开与关闭一个会话的 LAA 模式', () => {
  withRuntime((_harness, runtime) => {
    const on = handleRoute(runtime, 'POST', 'mode', undefined, { sessionId: 's1', enabled: true });
    assert.equal(on.status, 200);
    assert.equal(on.payload.value.enabled, true);
    assert.equal(runtime.isEnabled('s1'), true);
    assert.equal(runtime.isEnabled('s2'), false, '开关只作用于指定的那个会话');

    const off = handleRoute(runtime, 'POST', 'mode', undefined, { sessionId: 's1', enabled: false });
    assert.equal(off.payload.value.enabled, false);
    assert.equal(runtime.isEnabled('s1'), false);
  });
});

test('控制面：子会话读到父会话的模式，写入也落在父会话上', () => {
  withRuntime((harness, runtime) => {
    /* 宿主会话仓库里的实时会话对象带着子会话的谱系（origin + parentSession）。 */
    harness.provide('sessions', {
      get: (id) => (id === 'session-child' ? { header: childHeader('session-child', 'session-root') } : undefined),
    });
    runtime.setEnabled('session-root', true);

    const state = handleRoute(runtime, 'GET', 'state', query({ sessionId: 'session-child' }), undefined);
    assert.equal(state.payload.value.enabled, true, '子会话显示的模式与父会话一致');
    assert.equal(state.payload.value.inheritedFrom, 'session-root');

    const off = handleRoute(runtime, 'POST', 'mode', undefined, { sessionId: 'session-child', enabled: false });
    assert.equal(off.payload.value.enabled, false);
    assert.equal(runtime.isEnabled('session-root'), false, '子会话里的关闭改的是父会话');
    assert.equal(runtime.entryOf('session-child').updatedAt, 0);
  });
});

test('POST /mode 拒绝坏输入，而不是静默改状态', () => {
  withRuntime((_harness, runtime) => {
    assert.equal(handleRoute(runtime, 'POST', 'mode', undefined, {}).status, 400);
    assert.equal(handleRoute(runtime, 'POST', 'mode', undefined, { sessionId: 's1' }).status, 400);
    assert.equal(handleRoute(runtime, 'POST', 'mode', undefined, { sessionId: 's1', enabled: 'yes' }).status, 400);
    assert.equal(runtime.isEnabled('s1'), false);
  });
});

test('总开关关闭时控制面拒绝写入，但状态仍可读', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-laa-web-'));
  try {
    const harness = createRuntimeHarness({
      statePath: join(directory, 'state.json'),
      now: Date.UTC(2026, 8, 14, 2, 0),
      config: { enabled: false },
    });
    try {
      const runtime = harness.runtime;
      const write = handleRoute(runtime, 'POST', 'mode', undefined, { sessionId: 's1', enabled: true });
      assert.equal(write.status, 409);
      assert.equal(runtime.isEnabled('s1'), false);
      assert.equal(handleRoute(runtime, 'GET', 'state', query({ sessionId: 's1' }), undefined).status, 200);
    } finally {
      harness.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('未知路径是 404，不会误伤别的路由', () => {
  withRuntime((_harness, runtime) => {
    const outcome = handleRoute(runtime, 'GET', 'settings', undefined, undefined);
    assert.equal(outcome.status, 404);
    assert.equal(outcome.payload.ok, false);
  });
});

/** 造一个足以跑通处理器的假请求：一个有 data/end 事件的可读流加上方法、URL。 */
function createRequest(method, url, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')]);
  stream.method = method;
  stream.url = url;
  return stream;
}

/** 造一个记录结果的假响应。 */
function createResponse() {
  return {
    status: undefined,
    headers: undefined,
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body ?? '';
    },
  };
}

test('webServer 出现后路由被挂载，且能把前缀下的请求交给同一个处理器', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-laa-route-'));
  try {
    const harness = createRuntimeHarness({ statePath: join(directory, 'state.json'), now: Date.UTC(2026, 8, 14, 2, 0) });
    try {
      const routes = [];
      registerLaaRoutes(harness.ctx, harness.runtime);
      assert.equal(routes.length, 0, 'webServer 还不存在时不能挂载');

      harness.provide('webServer', { register: (route) => { routes.push(route); return () => {}; } });
      assert.equal(routes.length, 1, 'webServer 一出现就必须补挂路由');
      assert.equal(routes[0].kind, 'prefix');
      assert.equal(routes[0].path, '/dsh-laa');

      const read = createResponse();
      await routes[0].handler(createRequest('GET', '/dsh-laa/state?sessionId=s1'), read);
      assert.equal(read.status, 200);
      assert.equal(read.headers['cache-control'], 'no-store');
      assert.equal(JSON.parse(read.body).value.sessionId, 's1');

      const write = createResponse();
      await routes[0].handler(createRequest('POST', '/dsh-laa/mode', JSON.stringify({ sessionId: 's1', enabled: true })), write);
      assert.equal(write.status, 200);
      assert.equal(JSON.parse(write.body).value.enabled, true);
      assert.equal(harness.runtime.isEnabled('s1'), true);

      const badJson = createResponse();
      await routes[0].handler(createRequest('POST', '/dsh-laa/mode', '{not json'), badJson);
      assert.equal(badJson.status, 400);
      assert.equal(JSON.parse(badJson.body).ok, false);
    } finally {
      harness.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('控制面：冷子会话靠宿主会话清单补出的谱系跟随父会话', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-laa-route-'));
  try {
    const statePath = join(directory, 'state.json');
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      sessions: { 'session-root': { enabled: true, updatedAt: 1 } },
    }), 'utf8');
    const harness = createRuntimeHarness({ statePath, now: Date.UTC(2026, 8, 14, 2, 0) });
    try {
      const routes = [];
      registerLaaRoutes(harness.ctx, harness.runtime);
      harness.provide('webServer', { register: (route) => { routes.push(route); return () => {}; } });
      harness.provide('sessionQuery', { listSessions: async () => [{ header: childHeader('session-child', 'session-root') }] });

      const read = createResponse();
      await routes[0].handler(createRequest('GET', '/dsh-laa/state?sessionId=session-child'), read);
      const value = JSON.parse(read.body).value;
      assert.equal(value.enabled, true, '补谱系之后按父会话回答');
      assert.equal(value.inheritedFrom, 'session-root');

      const off = createResponse();
      await routes[0].handler(createRequest('POST', '/dsh-laa/mode', JSON.stringify({ sessionId: 'session-child', enabled: false })), off);
      assert.equal(JSON.parse(off.body).value.enabled, false);
      assert.equal(harness.runtime.isEnabled('session-root'), false, '写入也落在父会话上');
    } finally {
      harness.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('写进去的开关会持久化，重新载入的运行时读得到', () => {
  withRuntime((harness, runtime) => {
    handleRoute(runtime, 'POST', 'mode', undefined, { sessionId: 's1', enabled: true });
    runtime.dispose();
    const revived = harness.createRuntime();
    assert.equal(revived.isEnabled('s1'), true);
  });
});
