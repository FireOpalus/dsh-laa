/**
 * dsh-laa 的持久状态：每个会话的 LAA 开关，以及峰时被拦下、等待谷时重放的输入。
 *
 * 会话日志（`session.append`）不在这里使用：DSH 的持久化读取路径只承认本仓库
 * 已知的事件类型，仓库外插件追加的自定义事件类型会被拒绝解释。因此本插件把
 * 自己的状态放在 `$DSH_HOME/laa/state.json`，与 `.dsh` 下的其它用户数据同级。
 *
 * @module dsh-laa/store
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** 状态文件格式版本；不匹配时整个文档被丢弃并重建。 */
export const STATE_VERSION = 1;

/** 每个会话最多暂存多少条峰时输入；超出时丢弃最旧的一条。 */
export const DEFAULT_MAX_DEFERRED = 20;

/** 解析 DSH 主目录：`$DSH_HOME` 优先，否则 `~/.dsh`。 */
export function resolveDshHome(env = process.env) {
  const configured = env.DSH_HOME;
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim();
  return join(homedir(), '.dsh');
}

/** 本插件的默认状态文件路径。 */
export function defaultStatePath(env = process.env) {
  return join(resolveDshHome(env), 'laa', 'state.json');
}

/** 一个会话的空状态。 */
export function emptyEntry() {
  return {
    /** 该会话是否开启 LAA 模式。 */
    enabled: false,
    /** 最近一次改写该开关的时刻。 */
    updatedAt: 0,
    /** 峰时开始时是否中断过一个正在运行的轮次，谷时需要续跑提示。 */
    suspended: false,
    /** 最近一次被中断的时刻。 */
    suspendedAt: 0,
    /** 峰时被拒绝进入步骤的输入，等待谷时原样重放。 */
    deferred: [],
    /** 被拦下的输入里是否出现过 goal round（谷时需要重新武装 goal）。 */
    goalBlocked: false,
    /** 最近一次拒绝的可观测信息，仅用于 `/laa` 输出。 */
    lastRefusal: null,
  };
}

/** 把任意读到的值收敛成一条合法记录。 */
function sanitizeEntry(raw) {
  const base = emptyEntry();
  if (raw === null || typeof raw !== 'object') return base;
  const deferred = Array.isArray(raw.deferred)
    ? raw.deferred
      .filter((item) => item !== null && typeof item === 'object' && Array.isArray(item.content))
      .map((item) => ({
        at: Number.isFinite(item.at) ? item.at : 0,
        content: item.content,
        source: item.source !== null && typeof item.source === 'object' ? item.source : { kind: 'user' },
      }))
    : [];
  return {
    enabled: raw.enabled === true,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    suspended: raw.suspended === true,
    suspendedAt: Number.isFinite(raw.suspendedAt) ? raw.suspendedAt : 0,
    deferred,
    goalBlocked: raw.goalBlocked === true,
    lastRefusal: raw.lastRefusal !== null && typeof raw.lastRefusal === 'object' ? raw.lastRefusal : null,
  };
}

/**
 * 建立一个同步读、异步落盘的会话状态仓库。
 *
 * 读取直接来自内存，因此 `agent/pre-step` 这类同步边界永远不需要等待 I/O；
 * 写入合并到一个短暂的防抖窗口内，并在插件卸载时强制冲刷。
 *
 * @param options - `filePath`、可选的 logger、暂存上限与防抖毫秒数。
 * @returns 仓库句柄。
 */
export function createStore({ filePath, logger, maxDeferred = DEFAULT_MAX_DEFERRED, flushDelayMs = 250 }) {
  /** @type {Map<string, ReturnType<typeof emptyEntry>>} */
  let sessions = new Map();
  let timer = null;
  let closed = false;
  let dirty = false;

  const warn = (message, error) => {
    if (logger !== undefined && typeof logger.warn === 'function') logger.warn(`dsh-laa: ${message}`, error);
  };

  /** 从磁盘加载；任何损坏都被收敛为「空状态」而不是让插件加载失败。 */
  function load() {
    let text;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return;
      warn(`could not read ${filePath}; starting from an empty state`, error);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      warn(`${filePath} is not valid JSON; starting from an empty state`, error);
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || parsed.version !== STATE_VERSION || parsed.sessions === null || typeof parsed.sessions !== 'object') {
      warn(`${filePath} has an unsupported shape or version; starting from an empty state`);
      return;
    }
    for (const [sessionId, raw] of Object.entries(parsed.sessions)) {
      if (typeof sessionId === 'string' && sessionId.length > 0) sessions.set(sessionId, sanitizeEntry(raw));
    }
  }

  /** 立即把当前内存状态原子地写回磁盘。 */
  function writeNow() {
    if (!dirty || closed) return;
    dirty = false;
    const document = { version: STATE_VERSION, sessions: Object.fromEntries(sessions) };
    const temporary = `${filePath}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
      renameSync(temporary, filePath);
    } catch (error) {
      warn(`could not persist ${filePath}`, error);
      try {
        rmSync(temporary, { force: true });
      } catch {
        /* 清理失败不影响主流程 */
      }
    }
  }

  /** 安排一次防抖落盘。 */
  function schedule() {
    dirty = true;
    if (timer !== null || closed) return;
    timer = setTimeout(() => {
      timer = null;
      writeNow();
    }, flushDelayMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  load();

  return {
    /** 该会话的当前记录，缺失时返回一条空记录。 */
    get(sessionId) {
      return sessions.get(sessionId) ?? emptyEntry();
    },

    /** 是否存在任何已开启 LAA 的会话；`agent/pre-step` 的快路径。 */
    hasEnabled() {
      for (const entry of sessions.values()) if (entry.enabled) return true;
      return false;
    },

    /** 所有已开启 LAA 的会话 id。 */
    enabledIds() {
      const ids = [];
      for (const [sessionId, entry] of sessions) if (entry.enabled) ids.push(sessionId);
      return ids;
    },

    /** 所有「有峰时遗留工作」的会话 id：被中断过，或仍有暂存输入。 */
    pendingIds() {
      const ids = [];
      for (const [sessionId, entry] of sessions) {
        if (entry.suspended || entry.deferred.length > 0) ids.push(sessionId);
      }
      return ids;
    },

    /** 记录一条暂存输入；超出上限时丢弃最旧的一条。 */
    defer(sessionId, items) {
      if (items.length === 0) return;
      const entry = sessions.get(sessionId) ?? emptyEntry();
      const merged = [...entry.deferred, ...items];
      const trimmed = merged.length > maxDeferred ? merged.slice(merged.length - maxDeferred) : merged;
      if (merged.length > maxDeferred) warn(`session ${sessionId} exceeded ${maxDeferred} deferred inputs; the oldest were dropped`);
      sessions.set(sessionId, { ...entry, deferred: trimmed });
      schedule();
    },

    /** 就地改写一条记录，返回改写后的结果。 */
    update(sessionId, patch) {
      const next = { ...(sessions.get(sessionId) ?? emptyEntry()), ...patch };
      sessions.set(sessionId, next);
      schedule();
      return next;
    },

    /** 原子地完成「读取—改写」，避免并发读取之间的覆盖。 */
    mutate(sessionId, transform) {
      const next = transform(sessions.get(sessionId) ?? emptyEntry());
      sessions.set(sessionId, next);
      schedule();
      return next;
    },

    /** 丢弃一条记录（仅用于测试与显式清理）。 */
    clear(sessionId) {
      sessions.delete(sessionId);
      schedule();
    },

    /** 强制落盘，供命令与卸载路径使用。 */
    flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      writeNow();
    },

    /** 取消挂起的落盘并做最后一次写入。 */
    close() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      writeNow();
      closed = true;
    },

    /** 仅供测试与诊断：状态文件路径。 */
    get filePath() {
      return filePath;
    },
  };
}
