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
 * **模式属于会话树，遗留工作属于会话自己。** 一个会话的 LAA 模式存在它的**顶层
 * 会话（锚点）**上：子会话（DSH 的 subagent 会话，header 里带 `origin: 'subagent'`
 * 与 `parentSession`）没有自己的模式，沿谱系向上取锚点的那一个。于是父会话开着
 * 的时候子会话也开着、父会话关掉的时候子会话也关掉，在子会话里切换开关就等于切换
 * 父会话。峰时被拦下的输入与被中断的轮次则记在**产生它们的那个会话**名下——它们
 * 要回到那个会话自己的 agent 上继续跑，不能记到父会话头上。
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

/**
 * 沿谱系向上找锚点时的最大层数。
 *
 * DSH 的委派深度本身有上限，真实会话树远浅于此；这个上限只是为了让一份被改坏的
 * 状态文件（自指或成环）不会把同步的 `agent/pre-step` 拖住。
 */
const MAX_LINEAGE_DEPTH = 32;

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
  /** 是否已经从宿主的会话清单里补过一次谱系（每个进程一次）。 */
  let lineageHydrated = false;

  const warn = (message, error) => ctx.logger.warn(`dsh-laa: ${message}`, error);

  /** 现在处于哪个相位。 */
  function phaseNow(now = clock()) {
    return resolvePhase(now, windows, timeZone).phase;
  }

  //#region 会话谱系与模式
  /**
   * 读一个会话的存储元数据；子会话的 `origin` 与 `parentSession` 就写在 header 上。
   *
   * 来源按可靠性排序：正在跑的 agent 手里的实时会话 → 宿主会话仓库里的实时会话 →
   * 本插件自己落盘的谱系（子会话冷着的时候只剩这一条路，见 {@link anchorOf}）。
   * 每次读到带谱系的 header 都顺手记一笔，那份落盘谱系于是会自己补齐。
   */
  function headerOf(sessionId) {
    const agent = typeof ctx.agents.get === 'function' ? ctx.agents.get(sessionId) : undefined;
    const live = agent?.session?.header;
    if (live !== undefined && live !== null) {
      noteLineage(live);
      return live;
    }
    const sessions = ctx.get('sessions');
    const attached = sessions !== undefined && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined;
    const fromSession = attached?.header;
    if (fromSession !== undefined && fromSession !== null) {
      noteLineage(fromSession);
      return fromSession;
    }
    return undefined;
  }

  /** 把一条 header 里的谱系记进状态文件；不是子会话、或与已知一致时不写。 */
  function noteLineage(header) {
    if (header === undefined || header === null || header.origin !== 'subagent') return;
    store.setLineage(header.id, header.parentSession);
  }

  /**
   * 从宿主的会话清单里补全谱系，**每个进程只做一次**。
   *
   * 第三种来源（落盘的谱系）只覆盖插件亲眼见过的子会话；升级之前就存在、之后一直
   * 冷着的子会话谁也见不到。宿主的会话查询服务本来就要给侧栏列一份带 `parentSession`
   * 的会话清单，这里借同一份清单把谱系一次补齐，于是「子会话跟随父会话」对老会话
   * 同样成立。
   *
   * 尽力而为：服务缺席、读失败都只是退回原来的判断，绝不因此让控制面报错。
   * @returns 这次是否真的读了一份清单。
   */
  async function hydrateLineage() {
    if (lineageHydrated) return false;
    const query = ctx.get('sessionQuery');
    if (query === undefined || typeof query.listSessions !== 'function') return false;
    /* 先钉住标记：并发进来的控制面请求不会各自扫一遍。 */
    lineageHydrated = true;
    try {
      for (const record of await query.listSessions()) noteLineage(record?.header);
    } catch (error) {
      lineageHydrated = false;
      warn('could not read the session corpus for sub-session lineage', error);
      return false;
    }
    return true;
  }

  /** 一个会话的直接父会话；实时元数据优先，其次是自己落盘的谱系。 */
  function parentOf(sessionId) {
    const header = headerOf(sessionId);
    if (header !== undefined) {
      if (header.origin !== 'subagent') return undefined;
      const parent = header.parentSession;
      if (typeof parent !== 'string' || parent.length === 0 || parent === sessionId) return undefined;
      return parent;
    }
    return store.lineageOf(sessionId);
  }

  /**
   * 一个会话所属的顶层会话（锚点）：LAA 模式存在这里。
   *
   * 顶层会话是自己的锚点；子会话沿 `origin: 'subagent'` 的谱系一路向上，于是
   * 「一个会话 + 它的所有子会话」永远共用同一个开关。
   */
  function anchorOf(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return sessionId;
    let current = sessionId;
    const seen = new Set([current]);
    for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth += 1) {
      const parent = parentOf(current);
      if (parent === undefined) return current;
      /* 谱系成环不可能来自 DSH，只可能来自被改坏的状态文件：退回起点而不是绕圈。 */
      if (seen.has(parent)) return sessionId;
      seen.add(parent);
      current = parent;
    }
    return current;
  }

  /** 一个锚点自己记录的模式；不沿谱系向上（那是 {@link isEnabled} 的事）。 */
  function enabledAt(sessionId) {
    if (!config.enabled) return false;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
    const entry = store.get(sessionId);
    if (entry.updatedAt === 0) return config.defaultMode;
    return entry.enabled;
  }

  /** 该会话是否开启 LAA；子会话沿谱系取顶层会话的模式。 */
  function isEnabled(sessionId) {
    return enabledAt(anchorOf(sessionId));
  }
  //#endregion

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

  /** agent 背后的会话 id：DSH 里 agent 身份就是会话身份，缺失时才退回 `agent.id`。 */
  function sessionIdOf(agent) {
    return agent?.session?.id ?? agent?.id;
  }

  /**
   * 一个 agent 是否受 LAA 管辖，以及它的遗留工作该记在哪个会话名下。
   *
   * 模式来自它所属的顶层会话（{@link isEnabled}）；返回值永远是 agent **自己的**
   * 会话 id，因为被拦下的输入要回到那个会话自己的 agent 上继续跑，记到父会话头上
   * 就会在谷时被投递给错误的一方。运行时祖先只作兜底：会话元数据里没有谱系时
   * （例如手工构造出来的 agent），仍然跟随正在跑的父代理。
   */
  function governedSessionOf(agent) {
    if (!anySessionEligible()) return undefined;
    const own = sessionIdOf(agent);
    if (own === undefined) return undefined;
    if (isEnabled(own)) return own;
    let current = runtimeOwnerOf(agent);
    for (let depth = 0; current !== undefined && depth < 64; depth += 1) {
      if (isEnabled(sessionIdOf(current))) return own;
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
      const sessionId = governedSessionOf(agent);
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

  /**
   * 谷时开始：把每个仍有遗留工作的会话交还给它的实时 agent。
   *
   * 遗留工作是按会话各自记账的，所以这里要的正是「这个会话自己的 agent」——
   * 子会话的输入回到子代理上，父会话的输入回到父代理上。
   */
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
      const sessionId = governedSessionOf(payload.agent);
      if (sessionId === undefined) return next();
      if (phaseNow() === VALLEY) return next();
      const refusal = recordRefusal(sessionId, payload);
      ctx.logger.info(`dsh-laa: refused turn ${payload.turn} step ${payload.step} of session "${sessionId}" during the peak window (${refusal.deferred} deferred)`);
      return REJECT;
    },

    /**
     * 一个新 agent 出现：谷时就把等待中的工作立刻交给它。
     *
     * 这里也是插件第一次看清一个会话的谱系的地方——`isEnabled` 会沿 header 向上
     * 找锚点，并顺手把「谁是它的父会话」记进状态文件。
     */
    adopt(agent) {
      /* 直接用手里的 agent 记谱系：`agent/created` 触发时它未必已经进了注册表。 */
      noteLineage(agent?.session?.header);
      const sessionId = sessionIdOf(agent);
      if (sessionId === undefined || !isEnabled(sessionId)) return;
      if (phaseNow() !== VALLEY) return;
      release(agent, sessionId);
    },

    isEnabled,
    anchorOf,
    hydrateLineage,
    entryOf: (sessionId) => store.get(sessionId),
    defer: (sessionId, items) => store.defer(sessionId, items),

    /**
     * 改写一个会话的开关；返回改写后的记录。
     *
     * 子会话没有自己的模式：写在它身上的改动落到它所属的顶层会话上，于是整棵
     * 会话树（父会话 + 它的所有子会话）永远只有一个开关。
     */
    setEnabled(sessionId, enabled) {
      return store.mutate(anchorOf(sessionId), (previous) => ({ ...previous, enabled, updatedAt: clock() }));
    },

    /**
     * 一个会话的完整可序列化状态。
     *
     * `/laa` 命令与浏览器的开关都读这一份，不各自拼装，因此 UI、命令与状态文件
     * 永远描述同一件事。
     * @param sessionId - 会话 id。
     * @param now - 采样时刻，默认取当前时钟。
     * @returns 纯 JSON 值。
     */
    snapshot(sessionId, now = clock()) {
      const resolved = resolvePhase(now, windows, timeZone);
      const anchor = anchorOf(sessionId);
      const inherited = typeof anchor === 'string' && anchor.length > 0 && anchor !== sessionId;
      /* 模式读锚点（可能来自父会话），遗留工作读会话自己（见模块头部说明）。 */
      const entry = store.get(inherited ? sessionId : anchor);
      return {
        sessionId,
        enabled: isEnabled(sessionId),
        /* 非 null 时说明这是子会话：模式跟随这个顶层会话。 */
        inheritedFrom: inherited ? anchor : null,
        phase: resolved.phase,
        now,
        nextChangeAt: resolved.nextChangeAt,
        timeZone,
        localNow: renderLocalStamp(now, timeZone),
        localNextChange: renderLocalStamp(resolved.nextChangeAt, timeZone),
        peakWindows: describeWindows(windows),
        deferred: entry.deferred.length,
        suspended: entry.suspended,
        lastRefusal: entry.lastRefusal,
        masterEnabled: config.enabled,
        defaultMode: config.defaultMode,
      };
    },

    /** 供 `/laa` 使用的多行摘要。 */
    describe(sessionId, now = clock()) {
      const state = this.snapshot(sessionId, now);
      const peak = state.phase === PEAK;
      const lines = [`LAA 模式：${state.enabled ? '开启' : '关闭'}`];
      if (state.inheritedFrom !== null) {
        lines.push(`跟随父会话：${state.inheritedFrom}（子会话与父会话共用同一个开关，在这里切换等于切换父会话）`);
      }
      lines.push(
        `当前 DeepSeek 时段：${peak ? '峰时' : '谷时'}（${state.timeZone} ${state.localNow}）`,
        `下一次切换：${peak ? '谷时' : '峰时'} ${state.localNextChange}`,
        `峰时窗口：${state.peakWindows}（${state.timeZone}，其余时段为谷时）`,
      );
      if (state.deferred > 0 || state.suspended) {
        lines.push(`等待谷时：${state.suspended ? '1 个被中断的轮次' : ''}${state.suspended && state.deferred > 0 ? '、' : ''}${state.deferred > 0 ? `${state.deferred} 条暂存输入` : ''}`);
      }
      if (state.lastRefusal !== null && state.deferred === 0 && !state.suspended) {
        lines.push(`上次峰时拦截：第 ${state.lastRefusal.turn} 轮第 ${state.lastRefusal.step} 步`);
      }
      if (!state.masterEnabled) lines.push('注意：插件总开关 enabled 为 false，任何会话都不会被停。');
      return lines.join('\n');
    },

    /** 相位切换用的短文本，供命令输出。 */
    phaseNow,
  };
}
