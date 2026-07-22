import { localDateKey, type LastRunState } from './runs';
import type { ScheduleConfig } from './types';

// Anacron-style catch-up scheduler check (D-01/D-02/D-03, SCHED-01). Pure
// function: `now` and `lastRun` are injected, never read from the system
// clock or the DB internally, mirroring filter.ts's no-I/O classify* style —
// this is what makes the sleep-catchup scenario unit-testable without a
// real clock.

export function shouldFireToday(now: Date, schedule: ScheduleConfig, lastRun: LastRunState | null): boolean {
  if (!schedule.enabled) return false;

  const today = localDateKey(now);
  if (lastRun?.date === today && lastRun.status === 'ok') return false; // D-02: already done today
  if (lastRun?.date === today && lastRun.attempts >= 3) return false; // D-03: capped daily retries

  return now.getHours() >= schedule.targetHour;
}
