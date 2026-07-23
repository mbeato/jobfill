import { localDateKey, type LastRunState } from './runs';
import type { BatchConfig } from './types';

// The daily batch fire-check (D-05, BATCH-04). Pure function: `now`,
// `lastBatchRun`, and `lastSweepRun` are all injected, never read from the
// system clock or the DB internally — mirrors scheduler.ts's shouldFireToday.
//
// Unlike the sweep scheduler, there is no targetHour: the gate is sweep
// settlement, not a clock hour. "Settled" means today's sweep either
// succeeded or exhausted its retry cap — decoupled from sweep *success* so a
// sweep that failed out its retries still unblocks the batch (there may
// still be a fillable queue from a prior day).

export function shouldFireBatchToday(
  now: Date,
  batch: BatchConfig,
  lastBatchRun: LastRunState | null,
  lastSweepRun: LastRunState | null,
): boolean {
  if (!batch.enabled) return false;

  const today = localDateKey(now);
  if (lastBatchRun?.date === today && lastBatchRun.status === 'ok') return false; // already done today
  if (lastBatchRun?.date === today && lastBatchRun.attempts >= 3) return false; // capped daily retries

  const sweepSettledToday =
    lastSweepRun?.date === today && (lastSweepRun.status === 'ok' || lastSweepRun.attempts >= 3);
  if (!sweepSettledToday) return false;

  return true;
}
