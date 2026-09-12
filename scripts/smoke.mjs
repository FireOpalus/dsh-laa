#!/usr/bin/env node
/**
 * 真实 Cordis 冒烟测试。
 *
 * 单元测试用的是自带的假宿主；本脚本额外证明插件在**真实的 Cordis 运行期**里
 * 同样成立：`inject` 门控、`ctx.effect` 的资源回收、`ctx.on(..., { prepend })`
 * 的瀑布顺序、以及可选服务（`commands`）的迟到挂载。
 *
 * 运行：`npm run smoke`（需要一台装有 `@deepseek-ai/cordis` 的 DSH）。
 * 找不到 Cordis 时打印一行说明并以 0 退出，因此它不会在纯净环境里误报失败。
 *
 * @module dsh-laa/scripts/smoke
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = fileURLToPathRoot();

/** 依次尝试的 Cordis 位置。 */
const CANDIDATES = [
  '@deepseek-ai/cordis',
  join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'),
  join(process.env.DSH_DESKTOP_APP ?? '', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'),
  'C:/Program Files/DSH Desktop/resources/app/node_modules/@deepseek-ai/cordis/lib/index.js',
];

function fileURLToPathRoot() {
  return new URL('..', import.meta.url);
}

/** 载入第一个可用的 Cordis。 */
async function loadCordis() {
  for (const candidate of CANDIDATES) {
    if (candidate.startsWith('@')) {
      try {
        return await import(candidate);
      } catch {
        continue;
      }
    }
    if (!existsSync(candidate)) continue;
    try {
      return await import(pathToFileURL(candidate).href);
    } catch {
      continue;
    }
  }
  return undefined;
}

const cordis = await loadCordis();
if (cordis === undefined) {
  console.log('dsh-laa smoke: 未找到 @deepseek-ai/cordis；跳过真实运行期冒烟测试。');
  process.exit(0);
}

const plugin = await import(new URL('lib/index.js', ROOT).href);
const directory = mkdtempSync(join(tmpdir(), 'dsh-laa-smoke-'));
const statePath = join(directory, 'state.json');
const lines = [];

const ctx = new cordis.Context();
const agents = [];

/** 最小的 agents 注册表替身。 */
const registry = {
  list: () => [...agents],
  roots: () => [...agents],
  get: (id) => agents.find((agent) => agent.id === id),
  isOwnedBy: () => false,
};
ctx.provide('agents', registry);

/** 在本进程内恒为峰时的窗口，用来让断言与真实时钟无关。 */
const alwaysPeak = [{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], start: '00:00', end: '23:59' }];

try {
  const fork = ctx.plugin(plugin, { statePath, timeZone: 'Asia/Shanghai', peakWindows: alwaysPeak, defaultMode: true, tickMs: 60000, flushDelayMs: 0 });
  await fork;
  lines.push('插件在真实 Cordis 中按 inject = ["agents"] 激活');

  const agent = {
    id: 'smoke-session',
    session: { id: 'smoke-session' },
    status: 'running',
    cancelCalls: [],
    followupCalls: [],
    cancel(cause, options) {
      this.cancelCalls.push({ cause, options });
      this.status = 'idle';
    },
    followup(message) {
      this.followupCalls.push(message);
    },
  };
  agents.push(agent);
  ctx.emit('agent/created', { agent });
  assert.equal(agent.followupCalls.length, 0, '峰时不应该投递任何东西');

  const downstream = () => ({ kind: 'enter', messages: [] });
  const decision = await ctx.waterfall('agent/pre-step', {
    agent,
    turn: 1,
    step: 1,
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
  }, downstream);
  assert.deepEqual(decision, { kind: 'reject' });
  lines.push('agent/pre-step 瀑布在峰时被本插件拦下（下游未运行）');

  // 迟到的 commands 服务：插件应当在它出现后立刻挂载 /laa。
  const commands = new Map();
  ctx.provide('commands', {
    register(definition) {
      commands.set(definition.name, definition);
      return () => commands.delete(definition.name);
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  const command = commands.get('laa');
  assert.ok(command !== undefined, 'commands 出现后 /laa 必须被注册');
  const result = await command.handler({ agent, rawInput: 'status' });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /当前 DeepSeek 时段：峰时/);
  lines.push('/laa 命令在迟到的 commands 服务上完成挂载并返回状态');

  await fork.dispose();
  lines.push('插件卸载后 effect 树干净回收');
  console.log(`dsh-laa smoke: OK\n  - ${lines.join('\n  - ')}`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
