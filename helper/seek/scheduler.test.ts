import { test, expect } from 'bun:test';
import { shouldFireToday } from './scheduler';
import type { LastRunState } from './runs';
import type { ScheduleConfig } from './types';

function schedule(overrides: Partial<ScheduleConfig> = {}): ScheduleConfig {
  return { enabled: true, targetHour: 7, ...overrides };
}

// Constructs a local Date at a given hour "today" so localDateKey(now) always
// matches lastRun.date === 'today' style fixtures below without hardcoding a
// specific calendar date.
function atHour(hour: number): Date {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d;
}

const TODAY = new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0') + '-' + String(new Date().getDate()).padStart(2, '0');
const YESTERDAY = (() => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
})();

test('disabled schedule returns false regardless of hour/lastRun', () => {
  expect(shouldFireToday(atHour(9), schedule({ enabled: false }), null)).toBe(false);
});

test('before target hour returns false', () => {
  expect(shouldFireToday(atHour(6), schedule({ targetHour: 7 }), null)).toBe(false);
});

test('at/after target hour with no lastRun returns true (first run of a fresh day)', () => {
  expect(shouldFireToday(atHour(7), schedule({ targetHour: 7 }), null)).toBe(true);
});

test('already succeeded today returns false (D-02)', () => {
  const lastRun: LastRunState = { date: TODAY, status: 'ok', attempts: 1 };
  expect(shouldFireToday(atHour(9), schedule(), lastRun)).toBe(false);
});

test('failed today within retry cap returns true (D-03)', () => {
  const lastRun: LastRunState = { date: TODAY, status: 'failed', attempts: 2 };
  expect(shouldFireToday(atHour(9), schedule(), lastRun)).toBe(true);
});

test('failed today at the cap returns false', () => {
  const lastRun: LastRunState = { date: TODAY, status: 'failed', attempts: 3 };
  expect(shouldFireToday(atHour(9), schedule(), lastRun)).toBe(false);
});

test('lastRun from yesterday resets — new day fires again', () => {
  const lastRun: LastRunState = { date: YESTERDAY, status: 'ok', attempts: 1 };
  expect(shouldFireToday(atHour(9), schedule(), lastRun)).toBe(true);
});

test('sleep-catchup: 02:00 tick (before target) returns false, 09:00 tick same day with lastRun still null returns true', () => {
  const sched = schedule({ targetHour: 7 });
  const earlyResult = shouldFireToday(atHour(2), sched, null);
  expect(earlyResult).toBe(false);

  const lateResult = shouldFireToday(atHour(9), sched, null);
  expect(lateResult).toBe(true);
});
