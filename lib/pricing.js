/**
 * DeepSeek 峰谷时段（peak / off-peak）的纯计算。
 *
 * 依据 DeepSeek 官方定价页注 (3)（https://api-docs.deepseek.com/zh-cn/quick_start/pricing）：
 * 「空闲时段价格为高峰时段价格的一半。高峰时段为北京时间周一至周五 9:00-12:00、
 * 14:00-18:00（其余为空闲时段）。」
 *
 * 该口径自 2026-08-17 00:00（北京时间）起生效；周六与周日全天属于谷时。
 *
 * 本模块没有任何 DSH 依赖，只使用 `node:` 内建能力与 Intl，因此可以脱离宿主
 * 单独测试。
 *
 * @module dsh-laa/pricing
 */

/** 峰时。 */
export const PEAK = 'peak';
/** 谷时（空闲时段）。 */
export const VALLEY = 'valley';

/** 峰时窗口默认以北京时间为准。 */
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

/** 官方公布的峰时窗口：北京时间周一至周五 09:00-12:00 与 14:00-18:00。 */
export const DEFAULT_PEAK_WINDOWS = Object.freeze([
  Object.freeze({ days: Object.freeze([1, 2, 3, 4, 5]), start: '09:00', end: '12:00' }),
  Object.freeze({ days: Object.freeze([1, 2, 3, 4, 5]), start: '14:00', end: '18:00' }),
]);

/** ISO-8601 星期名：周一 = 1 … 周日 = 7。 */
const WEEKDAY_BY_NAME = Object.freeze({
  mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7,
});

/** 人类可读的星期标签，仅用于命令输出。 */
const WEEKDAY_LABELS = Object.freeze(['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']);

/** `Intl.DateTimeFormat` 实例按 IANA 时区缓存；纯函数不会每次重建。 */
const formatters = new Map();

/** 取出（并在需要时创建）某个时区的挂钟格式化器。 */
function formatterFor(timeZone) {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) return cached;
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  formatters.set(timeZone, created);
  return created;
}

/**
 * 校验一个 IANA 时区名，并返回其规范拼写。
 * @param timeZone - 待校验的时区名。
 * @returns 规范化后的时区名。
 * @throws {TypeError} 当该名称无法被运行时解析时。
 */
export function canonicalTimeZone(timeZone) {
  try {
    return formatterFor(timeZone).resolvedOptions().timeZone;
  } catch (error) {
    throw new TypeError(`dsh-laa: invalid IANA timeZone ${JSON.stringify(timeZone)}`, { cause: error });
  }
}

/**
 * 把 `HH:MM` 解析为一天内的分钟数。
 * @param clock - `HH:MM` 形式的挂钟时间。
 * @returns 0..1439 的分钟数。
 * @throws {TypeError} 当格式不合法时。
 */
export function parseClock(clock) {
  if (typeof clock !== 'string') throw new TypeError(`dsh-laa: clock must be a string, got ${typeof clock}`);
  const matched = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (matched === null) throw new TypeError(`dsh-laa: clock must look like "HH:MM", got ${JSON.stringify(clock)}`);
  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  if (hour > 23 || minute > 59) throw new TypeError(`dsh-laa: clock out of range: ${JSON.stringify(clock)}`);
  return hour * 60 + minute;
}

/**
 * 把一天内的分钟数渲染回 `HH:MM`。
 * @param minuteOfDay - 0..1439 的分钟数。
 * @returns `HH:MM` 文本。
 */
export function formatClock(minuteOfDay) {
  const wrapped = ((minuteOfDay % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

/** 解析一个星期标记：接受 1..7 的数字或 mon..sun 名称。 */
function parseWeekday(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 7) return value;
  if (typeof value === 'string') {
    const named = WEEKDAY_BY_NAME[value.trim().toLowerCase()];
    if (named !== undefined) return named;
    const numeric = Number(value);
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 7) return numeric;
  }
  throw new TypeError(`dsh-laa: weekday must be 1..7 (Mon..Sun) or a three-letter name, got ${JSON.stringify(value)}`);
}

/** 已经归一化过的窗口数组，让 {@link ensureWindows} 可以零成本复用。 */
const normalizedWindows = new WeakSet();

/**
 * 归一化并校验用户给出的峰时窗口。
 * @param windows - 形如 `{ days, start, end }` 的窗口数组；`days` 为 1..7 或 mon..sun，
 *   `start`/`end` 为 `HH:MM` 文本。
 * @returns 冻结的窗口数组，按开始时间排序，时刻已折算为一天内的分钟数。
 * @throws {TypeError} 当任一窗口不合法，或整个数组为空时。
 */
export function normalizeWindows(windows) {
  if (!Array.isArray(windows)) throw new TypeError('dsh-laa: peakWindows must be an array');
  if (windows.length === 0) throw new TypeError('dsh-laa: peakWindows must contain at least one window');
  const normalized = windows.map((window, index) => {
    if (window === null || typeof window !== 'object') throw new TypeError(`dsh-laa: peakWindows[${index}] must be an object`);
    const days = [...new Set((Array.isArray(window.days) ? window.days : []).map(parseWeekday))].sort((a, b) => a - b);
    if (days.length === 0) throw new TypeError(`dsh-laa: peakWindows[${index}].days must list at least one weekday`);
    const start = parseClock(window.start);
    const end = parseClock(window.end);
    if (start === end) throw new TypeError(`dsh-laa: peakWindows[${index}] start and end must differ`);
    return Object.freeze({ days: Object.freeze(days), start, end });
  });
  const result = Object.freeze(normalized.sort((a, b) => a.start - b.start));
  normalizedWindows.add(result);
  return result;
}

/**
 * 接受原始写法或已归一化的窗口。
 *
 * {@link DEFAULT_PEAK_WINDOWS} 与 patch 行里的窗口是人写的 `HH:MM` 文本，而
 * 判定与渲染需要分钟数；本函数让这两侧共用同一个入口，并且对已经归一化的数组
 * 只做一次 WeakSet 查询。
 * @param windows - 任一写法的窗口数组。
 * @returns 归一化的窗口数组。
 */
export function ensureWindows(windows) {
  return Array.isArray(windows) && normalizedWindows.has(windows) ? windows : normalizeWindows(windows);
}

/**
 * 读取某一时刻在给定时区下的挂钟字段。
 * @param epochMs - 毫秒时间戳。
 * @param timeZone - IANA 时区名。
 * @returns `{ year, month, day, hour, minute, second, weekday, minuteOfDay }`，星期为 ISO 编号。
 */
export function localParts(epochMs, timeZone) {
  const parts = Object.fromEntries(formatterFor(timeZone).formatToParts(new Date(epochMs)).map((part) => [part.type, part.value]));
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const weekdayName = String(parts.weekday).slice(0, 3).toLowerCase();
  return Object.freeze({
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute,
    second: Number(parts.second),
    weekday: WEEKDAY_BY_NAME[weekdayName],
    minuteOfDay: hour * 60 + minute,
  });
}

/** 某一时刻该时区相对 UTC 的偏移分钟数。 */
function offsetMinutesAt(epochMs, timeZone) {
  const local = localParts(epochMs, timeZone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  const truncated = Math.floor(epochMs / 1000) * 1000;
  return Math.round((asUtc - truncated) / 60000);
}

/**
 * 把「该时区下的挂钟时间」换算为 UTC 毫秒时间戳。
 * 对夏令时缺口与重叠使用两次逼近，与 `Intl` 的实际解析保持一致。
 * @param fields - `{ year, month, day, hour, minute }`。
 * @param timeZone - IANA 时区名。
 * @returns UTC 毫秒时间戳。
 */
export function zonedTimeToEpoch(fields, timeZone) {
  const naive = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, 0, 0);
  const first = naive - offsetMinutesAt(naive, timeZone) * 60000;
  return naive - offsetMinutesAt(first, timeZone) * 60000;
}

/**
 * 判断窗口是否覆盖某个挂钟时刻。
 *
 * 普通窗口属于它开始的那一天。跨零点的窗口（`end <= start`）从 `days` 中那天
 * 的 `start` 一直延伸到次日 `end`，是一段连续的峰时，因此它同时覆盖次日
 * 零点之后、`end` 之前的那一段——即使次日并不在 `days` 里。
 */
function windowCovers(window, weekday, minuteOfDay) {
  if (window.start <= window.end) {
    return window.days.includes(weekday) && minuteOfDay >= window.start && minuteOfDay < window.end;
  }
  if (window.days.includes(weekday) && minuteOfDay >= window.start) return true;
  const previousWeekday = weekday === 1 ? 7 : weekday - 1;
  return window.days.includes(previousWeekday) && minuteOfDay < window.end;
}

/** 某个「朴素本地日期」的 ISO 星期编号（周一 = 1 … 周日 = 7）。 */
function isoWeekdayOf(year, month, day) {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/** 把「朴素本地日期」的字段还原成 `{ year, month, day, hour, minute }`。 */
function shiftDays(year, month, day, dayShift, minuteOfDay) {
  const shifted = new Date(Date.UTC(year, month - 1, day + dayShift));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: Math.floor(minuteOfDay / 60),
    minute: minuteOfDay % 60,
  };
}

/**
 * 判定某一时刻是峰时还是谷时，并给出下一次切换的时刻。
 *
 * @param epochMs - 待判定的毫秒时间戳。
 * @param windows - 已归一化的峰时窗口（见 {@link normalizeWindows}）。
 * @param timeZone - 窗口所依据的 IANA 时区。
 * @returns `{ phase, nextChangeAt, local }`；`phase` 为 {@link PEAK} 或 {@link VALLEY}。
 */
export function resolvePhase(epochMs, rawWindows, timeZone) {
  const windows = ensureWindows(rawWindows);
  const local = localParts(epochMs, timeZone);
  let phase = VALLEY;
  for (const window of windows) {
    if (windowCovers(window, local.weekday, local.minuteOfDay)) {
      phase = PEAK;
      break;
    }
  }

  /*
   * 相位只会在一段峰时的两个端点上改变，因此把「今天 -1 天」到「今天 +8 天」之间
   * 每个窗口的两端都换算成 UTC，取最近的一个未来时刻。窗口属于它开始的那一天，
   * 跨零点窗口的终点落在次日，所以这里用同一个 `dayShift` 约定，与
   * {@link windowCovers} 保持一致。
   */
  const midnight = Date.UTC(local.year, local.month - 1, local.day);
  let nextChangeAt = Number.POSITIVE_INFINITY;
  for (let dayOffset = -1; dayOffset <= 8; dayOffset += 1) {
    if (Number.isFinite(nextChangeAt)) break;
    const day = new Date(midnight + dayOffset * 86400000);
    const year = day.getUTCFullYear();
    const month = day.getUTCMonth() + 1;
    const date = day.getUTCDate();
    const weekday = isoWeekdayOf(year, month, date);
    for (const window of windows) {
      if (!window.days.includes(weekday)) continue;
      const edges = window.end <= window.start
        ? [[0, window.start], [1, window.end]]
        : [[0, window.start], [0, window.end]];
      for (const [dayShift, minuteOfDay] of edges) {
        const at = zonedTimeToEpoch(shiftDays(year, month, date, dayShift, minuteOfDay), timeZone);
        if (at > epochMs && at < nextChangeAt) nextChangeAt = at;
      }
    }
  }
  return Object.freeze({
    phase,
    nextChangeAt: Number.isFinite(nextChangeAt) ? nextChangeAt : epochMs + 86400000,
    local,
  });
}

/**
 * 用一句话渲染「下一次切换」为可读文本，供命令输出使用。
 * @param epochMs - 切换时刻。
 * @param timeZone - 展示用的 IANA 时区。
 * @returns 形如 `2026-09-14 18:00（周一）` 的文本。
 */
export function renderLocalStamp(epochMs, timeZone) {
  const local = localParts(epochMs, timeZone);
  const date = `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`;
  return `${date} ${formatClock(local.minuteOfDay)}（${WEEKDAY_LABELS[local.weekday]}）`;
}

/**
 * 把峰时窗口渲染为一行摘要，供命令输出与日志使用。
 * @param windows - 任一写法的窗口数组。
 * @returns 人类可读的摘要。
 */
export function describeWindows(rawWindows) {
  return ensureWindows(rawWindows)
    .map((window) => `${renderWeekdays(window.days)} ${formatClock(window.start)}-${formatClock(window.end)}`)
    .join('、');
}

/**
 * 把星期编号列表渲染成紧凑文本：连续三天以上折叠为「周一至周五」。
 * @param days - 升序的 ISO 星期编号。
 * @returns 人类可读的星期描述。
 */
export function renderWeekdays(days) {
  const runs = [];
  let start = days[0];
  let previous = days[0];
  for (let index = 1; index <= days.length; index += 1) {
    const current = days[index];
    if (current === previous + 1) {
      previous = current;
      continue;
    }
    runs.push([start, previous]);
    start = current;
    previous = current;
  }
  return runs.map(([from, to]) => {
    if (from === to) return WEEKDAY_LABELS[from];
    if (to === from + 1) return `${WEEKDAY_LABELS[from]}${WEEKDAY_LABELS[to]}`;
    return `${WEEKDAY_LABELS[from]}至${WEEKDAY_LABELS[to]}`;
  }).join('、');
}
