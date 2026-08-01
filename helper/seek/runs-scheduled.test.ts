import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSweepsTable, getLastRunState, getLastScheduledRunState, localDateKey } from './runs';
import { shouldFireToday } from './scheduler';

const SCHEDULE = { enabled: true, targetHour: 7 };

function db() {
  const d = new Database(':memory:');
  createSweepsTable(d);
  return d;
}

// run_date is the local date key, which is what the scheduler compares against.
function sweep(d: Database, trigger: string, status: string, runDate: string) {
  return d
    .query(`INSERT INTO sweeps (trigger, status, run_date, finished_at) VALUES (?, ?, ?, datetime('now')) RETURNING *`)
    .get(trigger, status, runDate);
}

const today = localDateKey(new Date());
const at = (hour: number) => {
  const n = new Date();
  n.setHours(hour, 0, 0, 0);
  return n;
};

test('THE BUG: a manual sweep before targetHour used to cancel the scheduled run', () => {
  const d = db();
  sweep(d, 'manual', 'ok', today); // operator swept at 01:49

  // Old behaviour: any-trigger state reports the day as done...
  const anyTrigger = getLastRunState(d);
  expect(anyTrigger?.status).toBe('ok');
  expect(shouldFireToday(at(9), SCHEDULE, anyTrigger)).toBe(false); // ...so 09:00 skipped

  // Fixed: scheduled-only state sees no scheduled run today, so it still fires.
  expect(getLastScheduledRunState(d)).toBeNull();
  expect(shouldFireToday(at(9), SCHEDULE, getLastScheduledRunState(d))).toBe(true);
});

test('manual sweeps no longer consume the scheduler 3-attempt retry budget', () => {
  const d = db();
  sweep(d, 'manual', 'failed', today);
  sweep(d, 'manual', 'failed', today);
  sweep(d, 'manual', 'failed', today);

  expect(getLastRunState(d)?.attempts).toBe(3); // any-trigger sees the cap spent
  expect(shouldFireToday(at(9), SCHEDULE, getLastRunState(d))).toBe(false);

  expect(getLastScheduledRunState(d)).toBeNull(); // scheduler has attempted nothing
  expect(shouldFireToday(at(9), SCHEDULE, getLastScheduledRunState(d))).toBe(true);
});

test('a successful scheduled run today still suppresses a second one', () => {
  const d = db();
  sweep(d, 'scheduled', 'ok', today);
  const s = getLastScheduledRunState(d);
  expect(s).toEqual({ date: today, status: 'ok', attempts: 1 });
  expect(shouldFireToday(at(9), SCHEDULE, s)).toBe(false);
});

test('the scheduler retry cap still applies to its own failures', () => {
  const d = db();
  sweep(d, 'scheduled', 'failed', today);
  expect(shouldFireToday(at(9), SCHEDULE, getLastScheduledRunState(d))).toBe(true); // retry
  sweep(d, 'scheduled', 'failed', today);
  sweep(d, 'scheduled', 'failed', today);
  expect(getLastScheduledRunState(d)?.attempts).toBe(3);
  expect(shouldFireToday(at(9), SCHEDULE, getLastScheduledRunState(d))).toBe(false); // capped
});

test('manual sweeps mixed in do not inflate the scheduled attempt count', () => {
  const d = db();
  sweep(d, 'scheduled', 'failed', today);
  sweep(d, 'manual', 'ok', today);
  sweep(d, 'manual', 'ok', today);
  expect(getLastRunState(d)?.attempts).toBe(3);
  expect(getLastScheduledRunState(d)?.attempts).toBe(1);
  expect(shouldFireToday(at(9), SCHEDULE, getLastScheduledRunState(d))).toBe(true);
});

test('yesterday\'s scheduled run does not suppress today', () => {
  const d = db();
  const y = new Date();
  y.setDate(y.getDate() - 1);
  sweep(d, 'scheduled', 'ok', localDateKey(y));
  expect(shouldFireToday(at(9), SCHEDULE, getLastScheduledRunState(d))).toBe(true);
});

test('before targetHour it still holds, however the day looks', () => {
  const d = db();
  expect(shouldFireToday(at(3), SCHEDULE, getLastScheduledRunState(d))).toBe(false);
});

test('the batch gate keeps any-trigger semantics — a manual sweep settles the day', () => {
  const d = db();
  sweep(d, 'manual', 'ok', today);
  // Batch reads getLastRunState on purpose: fresh queue data exists, so batch
  // must not idle waiting for the scheduler.
  expect(getLastRunState(d)?.status).toBe('ok');
  expect(getLastRunState(d)?.date).toBe(today);
});
