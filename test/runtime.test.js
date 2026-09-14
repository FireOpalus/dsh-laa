import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { RESUME_FRAMING, childHeader, createRuntimeHarness } from './harness.js';

const BEIJING_MONDAY_PEAK = Date.UTC(2026, 8, 14, 2, 0); // 北京时间周一 10:00
const BEIJING_MONDAY_VALLEY = Date.UTC(2026, 8, 14, 4, 30); // 北京时间周一 12:30
const BEIJING_SATURDAY = Date.UTC(2026, 8, 19, 2, 0); // 北京时间周六 10:00

/**
 * 每个测试独占一个临时状态目录，避免相互干扰。
 *
 * 同步与异步的测试体都支持：异步时等它结束（含失败）再回收运行时与目录。
 */
function withHarness(options, body) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-laa-'));
  const harness = createRuntimeHarness({ statePath: join(directory, 'state.json'), ...options });
  const finish = () => {
    harness.dispose();
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    const result = body(harness);
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') return result.finally(finish);
    finish();
    return result;
  } catch (error) {
    finish();
    throw error;
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

test('子会话沿谱系跟随父会话：锚点、显示与拦截三者一致', () => {
  withHarness({ now: BEIJING_MONDAY_PEAK }, (h) => {
    h.runtime.setEnabled('session-root', true);
    const child = h.agent('session-child', { owner: 'session-root', header: childHeader('session-child', 'session-root') });
    h.runtime.start();

    assert.equal(h.runtime.anchorOf('session-child'), 'session-root');
    assert.equal(h.runtime.anchorOf('session-root'), 'session-root', '顶层会话是自己的锚点');
    assert.equal(h.runtime.isEnabled('session-child'), true);

    const snapshot = h.runtime.snapshot('session-child');
    assert.equal(snapshot.enabled, true, '子会话显示的模式与父会话一致');
    assert.equal(snapshot.inheritedFrom, 'session-root');
    assert.equal(h.runtime.snapshot('session-root').inheritedFrom, null, '顶层会话不显示“跟随父会话”');

    const decision = h.runtime.preStep({ agent: child, turn: 1, step: 1, messages: [] }, () => ({ kind: 'enter', messages: [] }));
    assert.deepEqual(decision, { kind: 'reject' });
  });
});

test('在子会话里切换开关改的是父会话，子会话不落自己的模式', () => {
  withHarness({ now: BEIJING_SATURDAY }, (h) => {
    h.agent('session-root');
    h.agent('session-child', { owner: 'session-root', header: childHeader('session-child', 'session-root') });

    h.runtime.setEnabled('session-child', true);
    assert.equal(h.runtime.isEnabled('session-root'), true, '子会话里的开启落到父会话上');
    assert.equal(h.runtime.isEnabled('session-child'), true);
    assert.equal(h.runtime.entryOf('session-child').updatedAt, 0, '子会话不保存自己的模式');
    assert.notEqual(h.runtime.entryOf('session-root').updatedAt, 0);

    h.runtime.setEnabled('session-child', false);
    assert.equal(h.runtime.isEnabled('session-root'), false);
    assert.equal(h.runtime.isEnabled('session-child'), false);
  });
});

test('父会话关掉 LAA 之后，子会话立刻恢复放行', () => {
  withHarness({ now: BEIJING_MONDAY_PEAK }, (h) => {
    h.runtime.setEnabled('session-root', true);
    const child = h.agent('session-child', { owner: 'session-root', header: childHeader('session-child', 'session-root') });
    h.runtime.start();
    assert.deepEqual(h.runtime.preStep({ agent: child, turn: 1, step: 1, messages: [] }, () => ({ kind: 'enter', messages: [] })), { kind: 'reject' });

    h.runtime.setEnabled('session-root', false);
    let downstreamRan = false;
    h.runtime.preStep({ agent: child, turn: 2, step: 1, messages: [] }, () => {
      downstreamRan = true;
      return { kind: 'enter', messages: [] };
    });
    assert.equal(downstreamRan, true);
  });
});

test('子会话被拦下的输入记在子会话名下，谷时投递给子代理而不是父代理', () => {
  withHarness({ now: BEIJING_MONDAY_PEAK }, (h) => {
    h.runtime.setEnabled('session-root', true);
    h.agent('session-root');
    const child = h.agent('session-child', { owner: 'session-root', header: childHeader('session-child', 'session-root') });
    h.runtime.start();

    h.runtime.preStep({
      agent: child,
      turn: 1,
      step: 1,
      messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '把子任务做完' }], source: { kind: 'user' } }],
    }, () => ({ kind: 'enter', messages: [] }));
    assert.equal(h.entry('session-child').deferred.length, 1);
    assert.equal(h.entry('session-root').deferred.length, 0, '父会话不该替子会话背这笔账');

    h.setNow(BEIJING_MONDAY_VALLEY);
    h.runtime.evaluate();
    assert.equal(h.followups('session-child').length, 1, '输入回到产生它的子会话');
    assert.equal(h.followups('session-child')[0].content[0].text, '把子任务做完');
    assert.equal(h.followups('session-root').length, 0, '不能把子会话的输入投给父代理');
  });
});

test('多级子会话沿谱系一路找到顶层会话', () => {
  withHarness({ now: BEIJING_MONDAY_PEAK }, (h) => {
    h.runtime.setEnabled('session-root', true);
    h.agent('session-mid', { owner: 'session-root', header: childHeader('session-mid', 'session-root') });
    const leaf = h.agent('session-leaf', { owner: 'session-mid', header: childHeader('session-leaf', 'session-mid') });
    h.runtime.start();

    assert.equal(h.runtime.anchorOf('session-leaf'), 'session-root');
    assert.equal(h.runtime.isEnabled('session-leaf'), true);
    assert.deepEqual(h.runtime.preStep({ agent: leaf, turn: 1, step: 1, messages: [] }, () => ({ kind: 'enter', messages: [] })), { kind: 'reject' });
  });
});

test('看到过一次子代理就把谱系记下来，哪怕它还没进注册表、LAA 也没开', () => {
  withHarness({ now: BEIJING_SATURDAY }, (h) => {
    /* 直接交给 adopt 的 agent：`agent/created` 触发时它未必已经能被查到。 */
    h.runtime.adopt({
      id: 'session-child',
      status: 'idle',
      session: { id: 'session-child', header: childHeader('session-child', 'session-root') },
    });
    h.runtime.dispose();
    const document = JSON.parse(readFileSync(h.statePath, 'utf8'));
    assert.deepEqual(document.lineage, { 'session-child': 'session-root' });
  });
});

test('冷子会话（没有实时 agent）靠落盘的谱系跟随父会话', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-laa-'));
  try {
    const statePath = join(directory, 'state.json');
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      sessions: { 'session-root': { enabled: true, updatedAt: 1 } },
      lineage: { 'session-child': 'session-root' },
    }), 'utf8');
    const harness = createRuntimeHarness({ statePath, now: BEIJING_MONDAY_PEAK });
    try {
      assert.equal(harness.runtime.anchorOf('session-child'), 'session-root');
      assert.equal(harness.runtime.isEnabled('session-child'), true);
      assert.equal(harness.runtime.snapshot('session-child').inheritedFrom, 'session-root');

      /* 冷会话里的切换同样落到父会话上 */
      harness.runtime.setEnabled('session-child', false);
      assert.equal(harness.runtime.isEnabled('session-root'), false);
    } finally {
      harness.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('升级前就存在的冷子会话：从宿主的会话清单里补一次谱系', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-laa-'));
  try {
    const statePath = join(directory, 'state.json');
    /* 父会话的模式在，但谱系谁都没见过——正是升级后第一次打开老会话的样子。 */
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      sessions: { 'session-root': { enabled: true, updatedAt: 1 } },
    }), 'utf8');
    const harness = createRuntimeHarness({ statePath, now: BEIJING_MONDAY_PEAK });
    try {
      let scans = 0;
      harness.provide('sessionQuery', {
        listSessions: async () => {
          scans += 1;
          return [{ header: childHeader('session-child', 'session-root') }, { header: { id: 'session-root' } }];
        },
      });
      assert.equal(harness.runtime.isEnabled('session-child'), false, '补谱系之前它只能看见自己');

      assert.equal(await harness.runtime.hydrateLineage(), true);
      assert.equal(harness.runtime.anchorOf('session-child'), 'session-root');
      assert.equal(harness.runtime.isEnabled('session-child'), true);
      assert.equal(harness.runtime.snapshot('session-child').inheritedFrom, 'session-root');

      assert.equal(await harness.runtime.hydrateLineage(), false, '每个进程只扫一次清单');
      assert.equal(scans, 1);
    } finally {
      harness.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('会话清单读失败只是退回原判断，控制面照常工作', async () => {
  await withHarness({ now: BEIJING_MONDAY_PEAK }, async (h) => {
    h.provide('sessionQuery', { listSessions: async () => { throw new Error('boom'); } });
    assert.equal(await h.runtime.hydrateLineage(), false);
    assert.equal(h.runtime.isEnabled('session-child'), false);

    /* 失败不被钉死：下一次还有机会补上。 */
    h.provide('sessionQuery', { listSessions: async () => [{ header: childHeader('session-child', 'session-root') }] });
    h.runtime.setEnabled('session-root', true);
    assert.equal(await h.runtime.hydrateLineage(), true);
    assert.equal(h.runtime.isEnabled('session-child'), true);
  });
});

test('坏掉的谱系（自指或成环）不会让解析转不出来', () => {
  withHarness({ now: BEIJING_SATURDAY }, (h) => {
    h.agent('session-self', { header: { id: 'session-self', origin: 'subagent', parentSession: 'session-self' } });
    assert.equal(h.runtime.anchorOf('session-self'), 'session-self');

    h.runtime.setEnabled('session-a', true);
    h.agent('session-a', { header: childHeader('session-a', 'session-b') });
    h.agent('session-b', { header: childHeader('session-b', 'session-a') });
    assert.equal(h.runtime.anchorOf('session-a'), 'session-a');
    assert.equal(h.runtime.isEnabled('session-a'), true);
  });
});

test('通知策略：默认 enabled，always / off 原样，其它值一律退回默认', () => {
  withHarness({ now: BEIJING_SATURDAY, config: { notify: 'always' } }, (h) => {
    assert.equal(h.runtime.snapshot('session-a').notify, 'always');
  });
  withHarness({ now: BEIJING_SATURDAY, config: { notify: 'off' } }, (h) => {
    assert.equal(h.runtime.snapshot('session-a').notify, 'off');
  });
  withHarness({ now: BEIJING_SATURDAY, config: { notify: 'yes-please' } }, (h) => {
    assert.equal(h.runtime.snapshot('session-a').notify, 'enabled');
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
