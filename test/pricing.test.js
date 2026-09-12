import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_PEAK_WINDOWS,
  PEAK,
  VALLEY,
  canonicalTimeZone,
  describeWindows,
  formatClock,
  localParts,
  normalizeWindows,
  parseClock,
  renderLocalStamp,
  resolvePhase,
  zonedTimeToEpoch,
} from '../lib/pricing.js';

/** 2026-09-14 是星期一。 */
const MONDAY = { year: 2026, month: 9, day: 14 };

/** 把「北京时间某时刻」换算成 UTC 毫秒。 */
function beijing(hour, minute = 0, day = MONDAY, monthOffsetDays = 0) {
  return zonedTimeToEpoch({
    year: day.year,
    month: day.month,
    day: day.day + monthOffsetDays,
    hour,
    minute,
  }, 'Asia/Shanghai');
}

/** 用默认窗口判定某个北京时间时刻的相位。 */
function phaseAt(hour, minute = 0, dayOffset = 0) {
  return resolvePhase(beijing(hour, minute, MONDAY, dayOffset), DEFAULT_PEAK_WINDOWS, 'Asia/Shanghai');
}


test('北京时间偏移固定为 UTC+8', () => {
  assert.equal(beijing(10), Date.UTC(2026, 8, 14, 2));
  const parts = localParts(beijing(10, 30), 'Asia/Shanghai');
  assert.equal(parts.hour, 10);
  assert.equal(parts.minute, 30);
  assert.equal(parts.weekday, 1);
  assert.equal(parts.minuteOfDay, 630);
});

test('官方峰时窗口：周一至周五 09:00-12:00 与 14:00-18:00 为峰时', () => {
  assert.equal(phaseAt(9).phase, PEAK);
  assert.equal(phaseAt(11, 59).phase, PEAK);
  assert.equal(phaseAt(14).phase, PEAK);
  assert.equal(phaseAt(17, 59).phase, PEAK);
});

test('官方谷时窗口：其余时段一律为空闲时段', () => {
  assert.equal(phaseAt(8, 59).phase, VALLEY);
  assert.equal(phaseAt(12).phase, VALLEY);
  assert.equal(phaseAt(13, 59).phase, VALLEY);
  assert.equal(phaseAt(18).phase, VALLEY);
  assert.equal(phaseAt(23, 30).phase, VALLEY);
  assert.equal(phaseAt(3).phase, VALLEY);
});

test('周六与周日全天为谷时', () => {
  for (const dayOffset of [5, 6]) {
    for (const hour of [3, 10, 15, 23]) {
      assert.equal(phaseAt(hour, 0, dayOffset).phase, VALLEY, `day+${dayOffset} ${hour}:00`);
    }
  }
});

test('nextChangeAt 指向真正的下一个窗口边界', () => {
  const beforeMorning = phaseAt(8);
  assert.equal(beforeMorning.phase, VALLEY);
  assert.equal(beforeMorning.nextChangeAt, beijing(9));

  const insideMorning = phaseAt(10);
  assert.equal(insideMorning.nextChangeAt, beijing(12));

  const middayGap = phaseAt(12, 30);
  assert.equal(middayGap.phase, VALLEY);
  assert.equal(middayGap.nextChangeAt, beijing(14));

  const endOfDay = phaseAt(17);
  assert.equal(endOfDay.nextChangeAt, beijing(18));

  const friday = phaseAt(17, 0, 4);
  assert.equal(friday.phase, PEAK);
  assert.equal(friday.nextChangeAt, beijing(18, 0, MONDAY, 4));

  const weekend = phaseAt(12, 0, 5);
  assert.equal(weekend.phase, VALLEY);
  assert.equal(weekend.nextChangeAt, beijing(9, 0, MONDAY, 7));
});

test('跨零点窗口按「开始那一侧的星期」计算长度', () => {
  const windows = normalizeWindows([{ days: ['mon'], start: '22:00', end: '06:00' }]);
  assert.equal(resolvePhase(beijing(23, 0), windows, 'Asia/Shanghai').phase, PEAK);
  assert.equal(resolvePhase(beijing(5, 0, MONDAY, 1), windows, 'Asia/Shanghai').phase, PEAK);
  assert.equal(resolvePhase(beijing(6, 0, MONDAY, 1), windows, 'Asia/Shanghai').phase, VALLEY);
  assert.equal(resolvePhase(beijing(12, 0, MONDAY, 1), windows, 'Asia/Shanghai').phase, VALLEY);
  assert.equal(resolvePhase(beijing(22, 0), windows, 'Asia/Shanghai').phase, PEAK);
});

test('时区、时钟与窗口的解析都会拒绝非法输入', () => {
  assert.equal(parseClock('09:00'), 540);
  assert.equal(parseClock('0:05'), 5);
  assert.equal(formatClock(540), '09:00');
  assert.equal(formatClock(0), '00:00');
  assert.throws(() => parseClock('9'), TypeError);
  assert.throws(() => parseClock('24:00'), TypeError);
  assert.throws(() => canonicalTimeZone('Mars/Olympus'), TypeError);
  assert.throws(() => normalizeWindows([]), TypeError);
  assert.throws(() => normalizeWindows([{ days: [], start: '09:00', end: '12:00' }]), TypeError);
  assert.throws(() => normalizeWindows([{ days: [8], start: '09:00', end: '12:00' }]), TypeError);
  assert.throws(() => normalizeWindows([{ days: [1], start: '09:00', end: '09:00' }]), TypeError);
});

test('窗口接受星期名与数字两种写法', () => {
  const byName = normalizeWindows([{ days: ['mon', 'TUE', 'wed'], start: '09:00', end: '12:00' }]);
  const byNumber = normalizeWindows([{ days: [3, 1, 2, 2], start: '09:00', end: '12:00' }]);
  assert.deepEqual([...byName[0].days], [1, 2, 3]);
  assert.deepEqual([...byNumber[0].days], [1, 2, 3]);
  assert.equal(byName[0].start, 540);
  assert.equal(byName[0].end, 720);
});

test('人类可读的渲染稳定', () => {
  assert.equal(describeWindows(DEFAULT_PEAK_WINDOWS), '周一至周五 09:00-12:00、周一至周五 14:00-18:00');
  assert.equal(renderLocalStamp(beijing(14, 0, MONDAY, 1), 'Asia/Shanghai'), '2026-09-15 14:00（周二）');
});
