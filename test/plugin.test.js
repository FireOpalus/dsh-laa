import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import * as plugin from '../lib/index.js';
import { baseConfig, childHeader, createRuntimeHarness } from './harness.js';

const BEIJING_MONDAY_PEAK = Date.UTC(2026, 8, 14, 2, 0); // 北京时间周一 10:00
const BEIJING_MONDAY_VALLEY = Date.UTC(2026, 8, 14, 4, 30); // 北京时间周一 12:30

/**
 * 每个测试独占一个临时状态目录，并按真实加载顺序组装插件：`prepare` 先造出
 * 已经存在的 agent，然后才挂载插件（DSH 加载插件时会话往往已经在跑了）。
 */
function withPlugin(options, body) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-laa-plugin-'));
  try {
    const statePath = join(directory, 'state.json');
    const harness = createRuntimeHarness({ statePath, manual: true, now: options.now });
    try {
      options.prepare?.(harness);
      const runtime = plugin.mount(
        harness.ctx,
        { ...baseConfig(statePath), ...(options.config ?? {}) },
        { now: () => harness.now() },
      );
      return body(harness, runtime);
    } finally {
      harness.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('模块形状符合 DSH 加载器约定：具名导出、且没有默认导出', () => {
  assert.equal(plugin.name, 'laa');
  assert.deepEqual(plugin.inject, ['agents']);
  assert.equal(typeof plugin.apply, 'function');
  // Loader 的 unwrapExports 会让 export default 覆盖具名导出并丢掉 inject。
  assert.equal(Object.hasOwn(plugin, 'default'), false);
});

test('mount() 之后：峰时拒绝步骤、谷时投递，整条链路可用', () => {
  withPlugin({
    now: BEIJING_MONDAY_PEAK,
    config: { defaultMode: true },
    prepare: (h) => h.agent('session-a', { status: 'running' }),
  }, (h) => {
    assert.equal(h.cancels('session-a').length, 1, '峰时载入必须停下正在运行的轮次');
    assert.deepEqual(h.cancels('session-a')[0].options, { keepInbox: true });

    const agent = h.agent('session-a');
    let downstreamRan = false;
    const decision = h.preStep({
      agent,
      turn: 2,
      step: 1,
      messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }],
    }, () => {
      downstreamRan = true;
      return { kind: 'enter', messages: [] };
    });
    assert.deepEqual(decision, { kind: 'reject' });
    assert.equal(downstreamRan, false, '被拒绝的步骤不能走到下游监听器');

    h.setNow(BEIJING_MONDAY_VALLEY);
    h.emit('agent/created', { agent: h.agent('session-b') });
    assert.equal(h.followups('session-b').length, 0, '没有遗留工作的会话不会被唤醒');
  });
});

test('mount() 注册了 /laa 命令与 agent 事件监听', () => {
  withPlugin({ now: BEIJING_MONDAY_VALLEY }, (h) => {
    const command = h.command('laa');
    assert.equal(typeof command, 'object');
    assert.equal(command.name, 'laa');
    assert.match(command.description, /LAA/);
    assert.deepEqual(command.input, { hint: '[on|off|status]' });
  });
});

test('/laa 命令：切换开关、报告峰谷相位与待恢复数量', () => {
  withPlugin({ now: BEIJING_MONDAY_PEAK }, (h, runtime) => {
    const agent = h.agent('session-a');

    const initial = h.runCommand('laa', { agent, rawInput: '' });
    assert.equal(initial.kind, 'success');
    assert.match(initial.text, /LAA 模式：关闭/);
    assert.match(initial.text, /当前 DeepSeek 时段：峰时（Asia\/Shanghai 2026-09-14 10:00（周一））/);
    assert.match(initial.text, /下一次切换：谷时 2026-09-14 12:00（周一）/);
    assert.match(initial.text, /峰时窗口：周一至周五 09:00-12:00、周一至周五 14:00-18:00/);

    const enabled = h.runCommand('laa', { agent, rawInput: 'on' });
    assert.equal(enabled.kind, 'success');
    assert.match(enabled.text, /LAA 模式已开启/);
    assert.match(enabled.text, /输入会被暂存到谷时/);
    assert.equal(runtime.isEnabled('session-a'), true);

    h.preStep({
      agent,
      turn: 1,
      step: 1,
      messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } }],
    }, () => ({ kind: 'enter', messages: [] }));

    const pending = h.runCommand('laa', { agent, rawInput: 'status' });
    assert.match(pending.text, /等待谷时：1 条暂存输入/);
    assert.equal(runtime.entryOf('session-a').deferred.length, 1);

    const disabled = h.runCommand('laa', { agent, rawInput: 'off' });
    assert.match(disabled.text, /LAA 模式已关闭/);
    assert.match(disabled.text, /不会再自动恢复/);

    const bogus = h.runCommand('laa', { agent, rawInput: 'maybe' });
    assert.equal(bogus.kind, 'error');
    assert.match(bogus.text, /用法：\/laa \[on\|off\|status\]/);
  });
});

test('/laa 命令大小写与空白不敏感，谷时不提示暂存', () => {
  withPlugin({ now: BEIJING_MONDAY_VALLEY }, (h, runtime) => {
    const agent = h.agent('session-a');
    const enabled = h.runCommand('laa', { agent, rawInput: '  ON  ' });
    assert.equal(enabled.kind, 'success');
    assert.match(enabled.text, /当前是谷时：会话立即恢复运行/);
    assert.equal(runtime.isEnabled('session-a'), true);

    assert.equal(h.runCommand('laa', { agent, rawInput: 'Off' }).kind, 'success');
    assert.equal(runtime.isEnabled('session-a'), false);
  });
});

test('/laa 在子会话里报告「跟随父会话」，并把开关写到父会话上', () => {
  withPlugin({
    now: BEIJING_MONDAY_PEAK,
    prepare: (h) => {
      h.agent('session-root');
      h.agent('session-child', { owner: 'session-root', header: childHeader('session-child', 'session-root') });
    },
  }, (h, runtime) => {
    const child = h.agent('session-child');

    const status = h.runCommand('laa', { agent: child, rawInput: 'status' });
    assert.equal(status.kind, 'success');
    assert.match(status.text, /LAA 模式：关闭/);
    assert.match(status.text, /跟随父会话：session-root（子会话与父会话共用同一个开关/);

    const on = h.runCommand('laa', { agent: child, rawInput: 'on' });
    assert.equal(on.kind, 'success');
    assert.equal(runtime.isEnabled('session-root'), true, '子会话里的开启落在父会话上');
    assert.equal(runtime.isEnabled('session-child'), true);
    assert.equal(runtime.entryOf('session-child').updatedAt, 0, '子会话不保存自己的模式');

    const off = h.runCommand('laa', { agent: child, rawInput: 'off' });
    assert.match(off.text, /这是子会话：父会话 session-root 的开关已一并关闭/);
    assert.equal(runtime.isEnabled('session-root'), false);

    const root = h.runCommand('laa', { agent: h.agent('session-root'), rawInput: 'on' });
    assert.match(root.text, /LAA 模式已开启/);
    assert.doesNotMatch(root.text, /跟随父会话/, '顶层会话不该说自己跟随谁');
  });
});

test('defaultMode 让每个从未被切换过的会话默认开启 LAA', () => {
  withPlugin({
    now: BEIJING_MONDAY_PEAK,
    config: { defaultMode: true },
    prepare: (h) => h.agent('session-fresh', { status: 'running' }),
  }, (h, runtime) => {
    assert.equal(runtime.isEnabled('session-fresh'), true);
    assert.equal(h.cancels('session-fresh').length, 1);

    // 用户显式关掉之后，defaultMode 不再把它打开。
    h.runCommand('laa', { agent: h.agent('session-fresh'), rawInput: 'off' });
    assert.equal(runtime.isEnabled('session-fresh'), false);
  });
});

test('enabled: false 时插件照常加载，但任何会话都不会被停', () => {
  withPlugin({
    now: BEIJING_MONDAY_PEAK,
    config: { enabled: false, defaultMode: true },
    prepare: (h) => h.agent('session-a', { status: 'running' }),
  }, (h, runtime) => {
    assert.equal(h.cancels('session-a').length, 0);
    assert.equal(runtime.isEnabled('session-a'), false);
    let downstreamRan = false;
    const decision = h.preStep({ agent: h.agent('session-a'), turn: 1, step: 1, messages: [] }, () => {
      downstreamRan = true;
      return { kind: 'enter', messages: [] };
    });
    assert.equal(downstreamRan, true);
    assert.deepEqual(decision, { kind: 'enter', messages: [] });
  });
});

test('峰时中断过的会话在谷时由 agent/created 立刻接手', () => {
  withPlugin({
    now: BEIJING_MONDAY_PEAK,
    config: { defaultMode: true },
    prepare: (h) => h.agent('session-a', { status: 'running' }),
  }, (h) => {
    h.setNow(BEIJING_MONDAY_VALLEY);
    h.emit('agent/created', { agent: h.agent('session-a') });
    assert.equal(h.followups('session-a').length, 1);
    assert.equal(h.followups('session-a')[0].source.plugin, 'laa');
  });
});
