#!/usr/bin/env node
/**
 * 零成本的端到端验证：真实的 DSH、真实的 agent loop、真实的会话，但一个
 * 模型请求都不发。
 *
 * 原理：`.dsh-test` 的 headless profile 把 dsh-laa 的峰时窗口设成整天，于是
 * 任何步骤都会在 `agent/pre-step` 里被拒绝——拒绝发生在构建并发出请求之前，
 * 所以这次运行不会花掉任何 token，却完整走过了真实的 agent loop。判定依据不是
 * stdout，而是插件自己的状态文件：被拒绝的输入必须原样躺在 `laa/state.json` 里。
 *
 *   node scripts/e2e.mjs        # 或 npm run e2e
 *
 * @module dsh-laa/scripts/e2e
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ENV_DIR, provision, runDsh } from './dev-home.mjs';

/** 插件的状态文件；它同时是这次验证的观察窗口。 */
const STATE_PATH = join(ENV_DIR, 'laa', 'state.json');

/** 每次运行都用一条唯一的输入，避免和上一次的遗留记录混淆。 */
const PROMPT = `dsh-laa e2e probe ${Date.now()}`;

/** 读状态文件；不存在或损坏时返回一个空文档。 */
function readState() {
  if (!existsSync(STATE_PATH)) return { version: 1, sessions: {} };
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && typeof parsed.sessions === 'object' ? parsed : { version: 1, sessions: {} };
  } catch {
    return { version: 1, sessions: {} };
  }
}

/** 一条消息的纯文本，用于和探针输入比对。 */
function textOf(message) {
  return (message.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('');
}

const checks = [];
/** 记录一条断言。 */
function check(ok, label, detail) {
  checks.push({ ok, label, detail });
  console.log(`${ok ? '  ✔' : '  ✖'} ${label}${detail === undefined ? '' : ` — ${detail}`}`);
}

const web = provision().web;
if (web.linkState !== 'kept' && web.linkState !== 'created') throw new Error('无法建立插件链接');

const before = new Set(Object.keys(readState().sessions));
console.log(`dsh-laa e2e：在隔离环境里跑一次真实的 headless 运行`);
console.log(`  DSH_HOME  ${ENV_DIR}`);
console.log(`  输入      ${PROMPT}`);
console.log(`  峰时窗口  整天（headless profile）→ 预期步骤被拒绝、不发请求\n`);

const exitCode = await runDsh(['--profile', 'headless', PROMPT]);

const state = readState();
const fresh = Object.entries(state.sessions).filter(([id]) => !before.has(id));
const [, entry] = fresh[0] ?? [];

console.log('\n断言：');
check(fresh.length >= 1, '一次真实的 headless 运行创建了新会话并在插件里留了记录', `${fresh.length} 条新记录`);
check(exitCode !== 0, '该运行没有正常完成（被拦下的轮次映射为非零退出码）', `exit=${exitCode}`);
check(entry?.lastRefusal?.turn === 1 && entry?.lastRefusal?.step === 1, '被拒绝的是第 1 轮第 1 步', entry === undefined ? '没有记录' : JSON.stringify(entry.lastRefusal));
check(entry?.deferred?.some((item) => textOf(item) === PROMPT), '输入没有丢：被原样暂存进 laa/state.json', entry === undefined ? '没有记录' : `deferred=${entry.deferred.length}`);
check(entry?.suspended === false, '轮次第一个步骤被拒不算「被中断的轮次」', `suspended=${entry?.suspended}`);

const failed = checks.filter((item) => !item.ok);
console.log(`\n${failed.length === 0 ? 'e2e 通过' : `e2e 失败（${failed.length}/${checks.length}）`}；状态文件：${STATE_PATH}`);
if (failed.length > 0) {
  console.log('提示：如果一条新记录都没有，说明插件根本没被加载——检查 headless profile 的 bundle 列表与 node_modules/dsh-laa 链接。');
  console.log('     如果记录存在但 deferred 为空，说明输入在别处被消耗了，请贴出上面的记录。');
}
process.exit(failed.length === 0 ? 0 : 1);
