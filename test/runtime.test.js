import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { RESUME_FRAMING, createRuntimeHarness } from './harness.js';

const BEIJING_MONDAY_PEAK = Date.UTC(2026, 8, 14, 2, 0); // 北京时间周一 10:00
const BEIJING_MONDAY_VALLEY = Date.UTC(2026, 8, 14, 4, 30); // 北京时间周一 12:30
const BEIJING_SATURDAY = Date.UTC(2026, 8, 19, 2, 0); // 北京时间周六 10:00

/** 每个测试独占一个临时状态目录，避免相互干扰。 */
function withHarness(options, body) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-laa-'));
  try {
    const harness = createRuntimeHarness({ statePath: join(directory, 'state.json'), ...options });
    try {
      return body(harness);
    } finally {
      harness.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('峰时载入：正在运行的轮次被立即中止，但已排队的输入被保留', () => {
  withHarness({ now: BEIJING_MONDAY_PEAK }, (h) => {
    h.runtime.setEnabled('session-a', true);
    h.agent('session-a', { status: 'running' });
    h.runtime.start();
    assert.equal(h.runtime.phaseNow(), 'peak');
    assert.deepEqual(h.cancels('session-a').map((call) => call.options), [{ keepInbox: true }]);
    assert.equal(h.cancels('session-a')[0].cause.kind, 'hook');
    assert.equal(h.entry('session-a').suspended, true);
  });
});

test('峰时载入：未开启 LAA 的会话不受影响', () => {
  withHarness({ now: BEIJING_MONDAY_PEAK }, (h) => {
    h.agent('session-b', { status: 'running' });
    h.runtime.start();
    assert.equal(h.cancels('session-b').length, 0);
  });
});

test('峰时：步骤被拒绝，下游监听器不会运行，输入被暂存而不是丢弃', () => {
  withHarness({ now: BEIJING_MONDAY_PEAK }, (h) => {
    h.runtime.setEnabled('session-a', true);
    const agent = h.agent('session-a');
    h.runtime.start();

    let downstreamRan = false;
    const message = { id: 'm1', role: 'user', content: [{ type: 'text', text: '帮我把测试补完' }], source: { kind: 'user' } };
    const decision = h.runtime.preStep({ agent, turn: 1, step: 1, messages: [message] }, () => {
      downstreamRan = true;
      return { kind: 'enter', messages: [] };
    });

    assert.deepEqual(decision, { kind: 'reject' });
    assert.equal(downstreamRan, false, '被拒绝的步骤不能继续走到下游监听器');
    const entry = h.entry('session-a');
    assert.equal(entry.deferred.length, 1);
    assert.deepEqual(entry.deferred[0].content, message.content);
    assert.deepEqual(entry.deferred[0].source, { kind: 'user' });
    assert.equal(entry.suspended, false, '轮次第一个步骤被拒不算「被中断的轮次」');
  });
});

test('谷时：被中断的轮次续跑，暂存输入按原顺序重放', () => {
  withHarness({ now: BEIJING_MONDAY_PEAK }, (h) => {
    h.runtime.setEnabled('session-a', true);
    const agent = h.agent('session-a');
    h.runtime.start();

    h.runtime.preStep({ agent, turn: 1, step: 1, messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '第一条' }], source: { kind: 'user' } }] }, () => ({ kind: 'enter', messages: [] }));
    h.runtime.preStep({ agent, turn: 2, step: 1, messages: [{ id: 'm2', role: 'user', content: [{ type: 'text', text: '第二条' }], source: { kind: 'user' } }] }, () => ({ kind: 'enter', messages: [] }));
    assert.equal(h.entry('session-a').deferred.length, 2);

    h.setNow(BEIJING_MONDAY_VALLEY);
    h.runtime.evaluate();

    const delivered = h.followups('session-a');
    assert.equal(delivered.length, 2);
    assert.equal(delivered[0].content[0].text, '第一条');
    assert.equal(delivered[1].content[0].text, '第二条');
    const entry = h.entry('session-a');
    assert.equal(entry.deferred.length, 0);
    assert.equal(entry.suspended, false);
  });
});

test('谷时：先续跑被中断的轮次，再重放暂存输入', () => {
  withHarness({ now: BEIJING_MONDAY_PEAK }, (h) => {
    h.runtime.setEnabled('session-a', true);
    const agent = h.agent('session-a', { status: 'running' });
    h.runtime.start(); // 峰时开始 -> 中断

    h.runtime.preStep({ agent, turn: 2, step: 1, messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '接着做' }], source: { kind: 'user' } }] }, () => ({ kind: 'enter', messages: [] }));

    h.setNow(BEIJING_MONDAY_VALLEY);
    h.runtime.evaluate();

    const delivered = h.followups('session-a');
    assert.equal(delivered.length, 2);
    assert.equal(delivered[0].content[0].text, RESUME_FRAMING);
    assert.equal(delivered[0].source.plugin, 'laa');
    assert.equal(delivered[1].content[0].text, '接着做');
  });
});

test('峰时中途的步骤只标记续跑，不会把工具结果当成用户输入重放', () => {
  withHarness({ now: BEIJING_MONDAY_PEAK }, (h) => {
    h.runtime.setEnabled('session-a', true);
    const agent = h.agent('session-a');
    h.runtime.start();

    const toolResult = { id: 't1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [], isError: false }], source: { kind: 'tool', callId: 'c1' } };
    h.runtime.preStep({ agent, turn: 1, step: 3, messages: [toolResult] }, () => ({ kind: 'enter', messages: [] }));

    const entry = h.entry('session-a');
    assert.equal(entry.deferred.length, 0);
    assert.equal(entry.suspended, true);

    h.setNow(BEIJING_MONDAY_VALLEY);
    h.runtime.evaluate();
    const delivered = h.followups('session-a');
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].content[0].text, RESUME_FRAMING);
  });
});

test('谷时：步骤照常进入，不做任何拦截', () => {
  withHarness({ now: BEIJING_SATURDAY }, (h) => {
    h.runtime.setEnabled('session-a', true);
    const agent = h.agent('session-a');
    h.runtime.start();
    assert.equal(h.runtime.phaseNow(), 'valley');
    let downstreamRan = false;
    const decision = h.runtime.preStep({ agent, turn: 1, step: 1, messages: [] }, () => {
      downstreamRan = true;
      return { kind: 'enter', messages: [] };
    });
    assert.equal(downstreamRan, true);
    assert.deepEqual(decision, { kind: 'enter', messages: [] });
  });
});

test('未开启 LAA 的会话完全不被观察', () => {
  withHarness({ now: BEIJING_MONDAY_PEAK }, (h) => {
    const agent = h.agent('session-z');
    h.runtime.start();
    let downstreamRan = false;
    h.runtime.preStep({ agent, turn: 1, step: 1, messages: [] }, () => {
      downstreamRan = true;
      return { kind: 'enter', messages: [] };
    });
    assert.equal(downstreamRan, true);
  });
});

test('子代理继承所属会话的模式', () => {
  withHarness({ now: BEIJING_MONDAY_PEAK }, (h) => {
    h.agent('session-root');
    h.runtime.setEnabled('session-root', true);
    const child = h.agent('session-child', { owner: 'session-root' });
    h.runtime.start();
    const decision = h.runtime.preStep({ agent: child, turn: 1, step: 1, messages: [] }, () => ({ kind: 'enter', messages: [] }));
    assert.deepEqual(decision, { kind: 'reject' });
  });
});

test('开关会持久化到状态文件，并在下一次载入时恢复', () => {
  withHarness({ now: BEIJING_SATURDAY }, (h) => {
    h.runtime.setEnabled('session-a', true);
    h.runtime.dispose();
    const revived = h.createRuntime();
    assert.equal(revived.isEnabled('session-a'), true);
    assert.equal(revived.isEnabled('session-b'), false);
    revived.dispose();
  });
});

test('峰时暂存的输入同样跨进程存活，并在谷时被投递', () => {
  withHarness({ now: BEIJING_MONDAY_PEAK }, (h) => {
    h.runtime.setEnabled('session-a', true);
    const agent = h.agent('session-a');
    h.runtime.start();
    h.runtime.preStep({ agent, turn: 1, step: 1, messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '别丢了' }], source: { kind: 'user' } }] }, () => ({ kind: 'enter', messages: [] }));
    h.runtime.dispose();

    h.setNow(BEIJING_MONDAY_VALLEY);
    const revived = h.createRuntime();
    revived.start();
    assert.equal(h.followups('session-a').length, 1);
    assert.equal(h.followups('session-a')[0].content[0].text, '别丢了');
    revived.dispose();
  });
});
