/**
 * 测试替身：一个只实现 LAA 实际用到的那部分 Cordis 契约的假宿主。
 *
 * 这里刻意不引入 `@deepseek-ai/cordis`：LAA 自己也不依赖它，测试因此可以在
 * 任何 Node 版本上直接跑 `node --test`。
 *
 * @module dsh-laa/test/harness
 */

import { DEFAULT_PEAK_WINDOWS } from '../lib/pricing.js';
import { RESUME_FRAMING, createLaaRuntime } from '../lib/laa.js';

export { RESUME_FRAMING };

/** 缺省配置：北京时间、官方峰时窗口、测试期间不落盘抖动。 */
export function baseConfig(statePath) {
  return {
    statePath,
    timeZone: 'Asia/Shanghai',
    peakWindows: DEFAULT_PEAK_WINDOWS,
    tickMs: 60_000,
    flushDelayMs: 0,
  };
}

/**
 * 建立一套受控的运行时环境。
 * @param options - `statePath`、`now`（初始毫秒时间戳）与 `manual`（为 true 时不预先
 *   创建运行时，留给 `apply()` 自己去建，用于端到端验证插件入口）。
 * @returns 宿主句柄。
 */
export function createRuntimeHarness({ statePath, now, manual = false }) {
  let clock = now;
  /** @type {any[]} */
  const agents = [];
  /** @type {any[]} */
  const disposers = [];
  /** @type {Map<string, any[]>} */
  const listeners = new Map();
  /** @type {Map<string, any>} */
  const commands = new Map();
  const logs = [];

  const ctx = {
    logger: {
      info: (...args) => logs.push({ level: 'info', text: args.map(String).join(' ') }),
      warn: (...args) => logs.push({ level: 'warn', text: args.map(String).join(' ') }),
    },
    agents: {
      list: () => [...agents],
      get: (id) => agents.find((agent) => agent.id === id),
      roots: () => agents.filter((agent) => agent.owner === undefined),
      isOwnedBy: (id, owner) => {
        const child = agents.find((agent) => agent.id === id);
        return child !== undefined && child.owner !== undefined && child.owner === owner.id;
      },
    },
    commands: {
      register(definition) {
        if (commands.has(definition.name)) throw new Error(`duplicate command ${definition.name}`);
        commands.set(definition.name, definition);
        return () => commands.delete(definition.name);
      },
    },
    on(event, handler) {
      const bucket = listeners.get(event) ?? [];
      bucket.push(handler);
      listeners.set(event, bucket);
      return () => {
        const index = bucket.indexOf(handler);
        if (index >= 0) bucket.splice(index, 1);
      };
    },
    effect: (callback) => {
      const disposer = callback();
      if (typeof disposer === 'function') disposers.push(disposer);
    },
    inject: (_services, callback) => {
      callback(ctx);
    },
    get: () => undefined,
  };

  /** 造一个假 agent；同一个 id 重复调用会复用并更新状态。 */
  function agent(id, options = {}) {
    const existing = agents.find((candidate) => candidate.id === id);
    if (existing !== undefined) {
      if (options.status !== undefined) existing.status = options.status;
      return existing;
    }
    const record = {
      id,
      owner: options.owner,
      status: options.status ?? 'idle',
      session: { id },
      cancelCalls: [],
      followupCalls: [],
      cancel(cause, cancelOptions) {
        record.cancelCalls.push({ cause, options: cancelOptions, statusAtCall: record.status });
        record.status = 'idle';
      },
      followup(message) {
        record.followupCalls.push(message);
        record.status = 'running';
      },
    };
    agents.push(record);
    return record;
  }

  /** 用当前时钟建立一个新的运行时（同一份状态文件）。 */
  function createRuntime() {
    const runtime = createLaaRuntime(ctx, baseConfig(statePath), { now: () => clock });
    disposers.push(() => runtime.dispose());
    return runtime;
  }

  let current = manual ? undefined : createRuntime();

  return {
    ctx,
    logs,
    get runtime() {
      if (current === undefined) throw new Error('harness: no runtime was created (manual mode)');
      return current;
    },
    agent,
    createRuntime() {
      current = createRuntime();
      return current;
    },
    setNow(value) {
      clock = value;
    },
    now() {
      return clock;
    },
    /** 触发一次已注册的 `agent/pre-step` 瀑布，返回第一个非 undefined 的决定。 */
    preStep(payload, next) {
      for (const handler of listeners.get('agent/pre-step') ?? []) {
        const decision = handler(payload, next);
        if (decision !== undefined) return decision;
      }
      return undefined;
    },
    emit(event, payload) {
      for (const handler of listeners.get(event) ?? []) handler(payload);
    },
    command(name) {
      return commands.get(name);
    },
    runCommand(name, invocation) {
      return commands.get(name).handler(invocation);
    },
    cancels: (id) => agent(id).cancelCalls,
    followups: (id) => agent(id).followupCalls,
    entry: (id) => current.entryOf(id),
    dispose() {
      for (const disposer of disposers.splice(0)) disposer();
    },
  };
}
