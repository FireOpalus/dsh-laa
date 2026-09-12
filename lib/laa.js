/**
 * dsh-laa 运行时：把「DeepSeek 峰时停机、谷时续跑」施加到每一个开启 LAA 的会话上。
 *
 * 状态机只有两个相位，由 {@link resolvePhase} 从挂钟推导，插件自己不保存
 * 「现在是峰时还是谷时」这类可失真的状态：
 *
 * - **峰时**：正在运行的轮次被 `agent.cancel(cause, { keepInbox: true })` 中止；
 *   任何试图进入的步骤在 `agent/pre-step` 瀑布中被拒绝（下游监听器不会运行，
 *   因此该步骤不会产生任何模型请求）。被拒绝步骤的输入由本插件接管、落盘暂存。
 * - **谷时**：暂存的输入按原顺序用 `agent.followup()` 重放；如果峰时中断过
 *   一个轮次，则先投递一条续跑提示词。
 *
 * 本模块只用 `node:` 内建能力，不导入任何 `@deepseek-ai/*` 包：DSH 的
 * 第三方插件在 profile 的 `node_modules` 中解析依赖，避免版本耦合能让插件在
 * 任意 DSH 版本上加载。
 *
 * @module dsh-laa/runtime
 */

import { randomUUID } from 'node:crypto';
import {
  DEFAULT_PEAK_WINDOWS,
  DEFAULT_TIME_ZONE,
  PEAK,
  VALLEY,
  canonicalTimeZone,
  describeWindows,
  normalizeWindows,
  renderLocalStamp,
  resolvePhase,
} from './pricing.js';
import { createStore, defaultStatePath } from './store.js';

/** 提示词来源标记：所有由本插件投递的消息都带这个 identity。 */
export const SOURCE = 'laa';

/**
 * 峰时中断后、谷时开始时投递的续跑提示词。
 *
 * 保持英文：DSH 中其它面向模型的保留提示词（例如 Schedule 的
 * `[SCHEDULE REMINDER]`）同样使用稳定的英文 framing。
 */
export const RESUME_FRAMING = [
  '[LAA MODE — OFF-PEAK WINDOW OPENED]',
  'LAA mode holds work during DeepSeek peak hours and releases it during off-peak hours.',
  'The previous turn was stopped at the peak boundary; the off-peak window has now begun.',
  'Continue the interrupted work from the current session history, workspace state, and tool results.',
  'Do not restate what is already finished: resume at the first unfinished step and tell the user in one line what you are resuming.',
].join('\n');

/**
 * 交给 `agent.cancel()` 的原因。取值必须落在 `AgentCancelCause` 封闭联合内
 * （`user` / `parent` / `hook` / `disposed`）；插件用它区分自己发起的中断。
 */
const CANCEL_CAUSE = Object.freeze({ kind: 'hook', reason: 'dsh-laa: deepseek peak window' });

/** `agent/pre-step` 的拒绝决定；下游监听器不会被调用，因此不会有模型请求。 */
const REJECT = Object.freeze({ kind: 'reject' });

/** 一个正的安全整数，否则取默认值。 */
function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** 把 patch 行里的原始 config 收敛为完整的运行时配置。 */
export function normalizeConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {};
  const statePath = typeof config.statePath === 'string' && config.statePath.trim().length > 0
    ? config.statePath.trim()
    : undefined;
  return {
    enabled: config.enabled !== false,
    statePath,
    timeZone: typeof config.timeZone === 'string' && config.timeZone.trim().length > 0
      ? config.timeZone.trim()
      : DEFAULT_TIME_ZONE,
    peakWindows: config.peakWindows === undefined ? DEFAULT_PEAK_WINDOWS : config.peakWindows,
    tickMs: positiveInteger(config.tickMs, 30000),
    cancelRunningOnPeak: config.cancelRunningOnPeak !== false,
    resumeOnValley: config.resumeOnValley !== false,
    defaultMode: config.defaultMode === true,
    maxDeferred: positiveInteger(config.maxDeferred, 20),
    flushDelayMs: positiveInteger(config.flushDelayMs, 250),
  };
}

/** 一条消息是否可以在谷时原样重放：必须是用户角色、非工具结果、且有内容。 */
function isReplayable(message) {
  if (message === null || typeof message !== 'object') return false;
  if (message.role !== 'user') return false;
  if (message.source !== null && typeof message.source === 'object' && message.source.kind === 'tool') return false;
  return Array.isArray(message.content) && message.content.length > 0;
}

/** 构造一条带稳定身份的 user 消息，等价于 DSH 的 `createUserMessage`。 */
export function createUserMessage(input) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: input.content,
    source: input.source,
  });
}

/**
 * 建立 LAA 运行时。
 * @param ctx - 插件上下文（需要 `agents` 服务）。
 * @param rawConfig - patch 行提供的原始配置。
 * @param deps - 仅用于测试的可替换依赖：`now` 提供当前毫秒时间戳。
 * @returns 运行时句柄。
 */
export function createLaaRuntime(ctx, rawConfig, deps = {}) {
  const clock = typeof deps.now === 'function' ? deps.now : Date.now;
  const config = normalizeConfig(rawConfig);
  const windows = normalizeWindows(config.peakWindows);
  const timeZone = canonicalTimeZone(config.timeZone);
  const store = createStore({
    filePath: config.statePath ?? defaultStatePath(),
    logger: ctx.logger,
    maxDeferred: config.maxDeferred,
    flushDelayMs: config.flushDelayMs,
  });

  let timer = null;
  let phase;
  let disposed = false;

  const warn = (message, error) => ctx.logger.warn(`dsh-laa: ${message}`, error);

  /** 现在处于哪个相位。 */
  function phaseNow(now = clock()) {
    return resolvePhase(now, windows, timeZone).phase;
  }

  /** 该会话是否开启 LAA。 */
  function isEnabled(sessionId) {
    if (!config.enabled) return false;
    const entry = store.get(sessionId);
    if (entry.updatedAt === 0) return config.defaultMode;
    return entry.enabled;
  }

  /** 是否存在任何可能受管于 LAA 的会话；`pre-step` 的快路径。 */
  function anySessionEligible() {
    if (!config.enabled) return false;
    return config.defaultMode || store.hasEnabled();
  }

  /** 一个 agent 的直接运行时创建者，没有则返回 undefined。 */
  function runtimeOwnerOf(agent) {
    for (const candidate of ctx.agents.list()) {
      if (candidate === agent) continue;
      if (ctx.agents.isOwnedBy(agent.id, candidate)) return candidate;
    }
    return undefined;
  }

  /**
   * 解析一个 agent 归属的 LAA 会话：它自己的会话，或最近的、已开启 LAA 的
   * 运行时祖先。子代理因此继承所属会话的模式，同时不会污染自己的会话状态。
   */
  function ownerSessionOf(agent) {
    if (!anySessionEligible()) return undefined;
    let current = agent;
    for (let depth = 0; current !== undefined && depth < 64; depth += 1) {
      const sessionId = current.session?.id ?? current.id;
      if (sessionId !== undefined && isEnabled(sessionId)) return sessionId;
      current = runtimeOwnerOf(current);
    }
    return undefined;
  }

  /** agent 在运行时树中的深度，用于「先停子代理、再停根代理」。 */
  function depthOf(agent) {
    let depth = 0;
    let current = runtimeOwnerOf(agent);
    while (current !== undefined && depth < 64) {
      depth += 1;
      current = runtimeOwnerOf(current);
    }
    return depth;
  }

  /**
   * 记录一次被拒绝的步骤。只有轮次的第一个步骤携带「这一轮要做什么」的输入，
   * 因此只有它会被暂存；中途步骤（step > 1）只把会话标记为需要续跑。
   */
  function recordRefusal(sessionId, payload) {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const goalBlocked = messages.some((message) => message?.source?.kind === 'goal');
    const deferred = payload.step === 1 ? messages.filter(isReplayable).map((message) => ({
      at: clock(),
      content: message.content,
      source: message.source,
    })) : [];
    const entry = store.mutate(sessionId, (previous) => ({
      ...previous,
      suspended: previous.suspended || payload.step !== 1,
      goalBlocked: previous.goalBlocked || goalBlocked,
      lastRefusal: { at: clock(), turn: payload.turn, step: payload.step, deferred: deferred.length },
    }));
    if (deferred.length > 0) store.defer(sessionId, deferred);
    return { entry, deferred: entry.deferred.length + deferred.length };
  }

  /** 峰时开始：中止所有受管 agent 正在运行的轮次，保留它们已排队的输入。 */
  function enterPeak() {
    if (!config.cancelRunningOnPeak) return;
    const agents = [...ctx.agents.list()].sort((left, right) => depthOf(right) - depthOf(left));
    const stopped = [];
    for (const agent of agents) {
      const sessionId = ownerSessionOf(agent);
      if (sessionId === undefined) continue;
      if (agent.status !== 'running') continue;
      store.mutate(sessionId, (previous) => ({ ...previous, suspended: true, suspendedAt: clock() }));
      try {
        agent.cancel(CANCEL_CAUSE, { keepInbox: true });
        stopped.push(agent.id);
      } catch (error) {
        warn(`could not stop agent "${agent.id}" for the peak window`, error);
      }
    }
    if (stopped.length > 0) ctx.logger.info(`dsh-laa: peak window began; stopped ${stopped.length} running turn(s)`);
  }

  /** 谷时：重新武装被峰时拦下的 goal，让自动续行回到用户原本的意图。 */
  function rearmGoal(agent) {
    const goals = ctx.get('goals');
    if (goals === undefined || typeof goals.get !== 'function' || typeof goals.resume !== 'function') return;
    try {
      const goal = goals.get(agent);
      if (goal === undefined || goal.phase !== 'active' || goal.activation === 'armed') return;
      goals.resume(agent, { id: goal.id, revision: goal.revision });
    } catch (error) {
      warn(`could not re-arm the goal of agent "${agent.id}"`, error);
    }
  }

  /**
   * 把一个会话的峰时遗留工作交还给它的 agent：先续跑被中断的轮次，再按原顺序
   * 重放被拦下的输入。只有真正投递成功的部分才会被清除。
   */
  function release(agent, sessionId) {
    const entry = store.get(sessionId);
    if (!entry.suspended && entry.deferred.length === 0) return false;
    if (entry.goalBlocked) rearmGoal(agent);
    const delivered = [];
    try {
      if (entry.suspended) {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: RESUME_FRAMING }],
          source: { kind: 'plugin', plugin: SOURCE, form: 'notice' },
        }));
      }
      for (const item of entry.deferred) {
        agent.followup(createUserMessage({ content: item.content, source: item.source }));
        delivered.push(item);
      }
    } catch (error) {
      warn(`could not release deferred work for session "${sessionId}"`, error);
    }
    store.mutate(sessionId, (previous) => ({
      ...previous,
      suspended: false,
      suspendedAt: 0,
      goalBlocked: false,
      lastRefusal: null,
      deferred: previous.deferred.slice(delivered.length),
    }));
    if (entry.suspended || delivered.length > 0) {
      ctx.logger.info(`dsh-laa: off-peak began; session "${sessionId}" resumed (${delivered.length} deferred input(s))`);
    }
    return true;
  }

  /** 谷时开始：把每个仍有遗留工作的会话交还给它的实时 agent。 */
  function enterValley() {
    if (!config.resumeOnValley) return;
    for (const sessionId of store.pendingIds()) {
      if (!isEnabled(sessionId)) continue;
      const agent = ctx.agents.get(sessionId);
      if (agent === undefined) continue;
      release(agent, sessionId);
    }
  }

  /** 安排下一次相位评估：不晚于下一个窗口边界，并且至少每 `tickMs` 醒一次。 */
  function arm() {
    if (disposed) return;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const now = clock();
    const resolved = resolvePhase(now, windows, timeZone);
    const untilBoundary = Math.max(0, resolved.nextChangeAt - now);
    const delay = Math.max(250, Math.min(config.tickMs, untilBoundary + 1000));
    timer = setTimeout(evaluate, delay);
    /* 绝不因为一个后台计时器而让一次性的 headless 进程无法退出。 */
    if (typeof timer.unref === 'function') timer.unref();
  }

  /** 每次时钟唤醒：比较相位，跨边界时执行对应的那一侧。 */
  function evaluate() {
    /* 定时器已经触发时这里是空操作；手动调用时它取消掉上一次排程，避免堆积。 */
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (disposed) return;
    const resolved = resolvePhase(clock(), windows, timeZone);
    const previous = phase;
    phase = resolved.phase;
    if (previous !== phase) {
      if (phase === PEAK) enterPeak();
      else enterValley();
    }
    arm();
  }

  return {
    config,
    windows,
    timeZone,

    /** 启动时钟；载入时先按当前相位做一次评估（峰时载入同样会停机）。 */
    start() {
      evaluate();
    },

    /** 立刻重新评估相位；定时器与测试共用同一个入口。 */
    evaluate,

    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      store.close();
    },

    /** `agent/pre-step` 瀑布处理器。 */
    preStep(payload, next) {
      if (disposed) return next();
      const sessionId = ownerSessionOf(payload.agent);
      if (sessionId === undefined) return next();
      if (phaseNow() === VALLEY) return next();
      const refusal = recordRefusal(sessionId, payload);
      ctx.logger.info(`dsh-laa: refused turn ${payload.turn} step ${payload.step} of session "${sessionId}" during the peak window (${refusal.deferred} deferred)`);
      return REJECT;
    },

    /** 一个新 agent 出现：谷时就把等待中的工作立刻交给它。 */
    adopt(agent) {
      const sessionId = agent.session?.id;
      if (sessionId === undefined || !isEnabled(sessionId)) return;
      if (phaseNow() !== VALLEY) return;
      release(agent, sessionId);
    },

    isEnabled,
    entryOf: (sessionId) => store.get(sessionId),
    defer: (sessionId, items) => store.defer(sessionId, items),

    /** 改写一个会话的开关；返回改写后的记录。 */
    setEnabled(sessionId, enabled) {
      return store.mutate(sessionId, (previous) => ({ ...previous, enabled, updatedAt: clock() }));
    },

    /** 供 `/laa` 使用的一行摘要。 */
    describe(sessionId, now = clock()) {
      const resolved = resolvePhase(now, windows, timeZone);
      const entry = store.get(sessionId);
      const enabled = isEnabled(sessionId);
      const lines = [
        `LAA 模式：${enabled ? '开启' : '关闭'}`,
        `当前 DeepSeek 时段：${resolved.phase === PEAK ? '峰时' : '谷时'}（${timeZone} ${renderLocalStamp(now, timeZone)}）`,
        `下一次切换：${resolved.phase === PEAK ? '谷时' : '峰时'} ${renderLocalStamp(resolved.nextChangeAt, timeZone)}`,
        `峰时窗口：${describeWindows(windows)}（${timeZone}，其余时段为谷时）`,
      ];
      const deferred = entry.deferred.length;
      if (deferred > 0 || entry.suspended) {
        lines.push(`等待谷时：${entry.suspended ? '1 个被中断的轮次' : ''}${entry.suspended && deferred > 0 ? '、' : ''}${deferred > 0 ? `${deferred} 条暂存输入` : ''}`);
      }
      if (entry.lastRefusal !== null && deferred === 0 && !entry.suspended) {
        lines.push(`上次峰时拦截：第 ${entry.lastRefusal.turn} 轮第 ${entry.lastRefusal.step} 步`);
      }
      return lines.join('\n');
    },

    /** 相位切换用的短文本，供命令输出。 */
    phaseNow,
  };
}
