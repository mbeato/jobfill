import type { Database } from 'bun:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBatchRunning, getRunningBatch, startBatchRun, type BatchTrigger } from './batch';
import { isSweepRunning, getRunningSweep } from './runs';

// The batch single-flight begin gate + detached spawn (D-06/D-08). Mirrors
// job.ts's beginSweep/spawnSidecar pair, with one deliberate exception: the
// batch spawn carries NO kill timeout — killing it would kill the headed
// browser and every open review tab, not just a background fetch.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export class BatchAlreadyRunningError extends Error {
  runId: number;
  constructor(runId: number) {
    super(`batch already running (run ${runId})`);
    this.name = 'BatchAlreadyRunningError';
    this.runId = runId;
  }
}

// D-08: a batch trigger while a sweep is running is rejected, pointing at the
// in-progress sweep run — keeps claude-CLI mapping/tailoring calls serialized
// and mornings deterministic (sweep, then fill).
export class SweepInProgressError extends Error {
  runId: number;
  constructor(runId: number) {
    super(`sweep is running (run ${runId})`);
    this.name = 'SweepInProgressError';
    this.runId = runId;
  }
}

// Synchronous — the row exists before any await, so a caller (e.g. a
// fire-and-poll HTTP route) can read the id back immediately. Checks the
// sweep lock first (D-08: sweep takes precedence), then its own single-flight
// lock.
export function beginBatch(db: Database, trigger: BatchTrigger): { runId: number } {
  if (isSweepRunning(db)) {
    const running = getRunningSweep(db)!;
    throw new SweepInProgressError(running.id);
  }
  if (isBatchRunning(db)) {
    const running = getRunningBatch(db)!;
    throw new BatchAlreadyRunningError(running.id);
  }
  const row = startBatchRun(db, trigger);
  return { runId: row.id };
}

export interface SpawnBatchRunnerResult {
  spawned: boolean;
  error?: string;
}

// Bun.spawn's own type, aliased so a test can inject a fake implementation
// and assert on the exact argv/options spawnBatchRunner passes it.
export type SpawnFn = typeof Bun.spawn;

// D-06: fire-and-forget detached spawn. process.execPath (never a bare
// runtime-name string) so launchd's minimal PATH can never strand this spawn
// (mirrors job.ts's spawnSidecar). CRITICALLY no `timeout`/`killSignal` —
// killing this process kills the browser and every open review tab. unref()
// so the helper's own event loop / lifecycle is never tied to the child; the
// caller must NOT await proc.exited — the helper learns the run finished via
// the batch_runs row's status, PATCHed by batch-runner.mjs itself over HTTP,
// not via this process's exit.
// Single-row fill via the proven runner (scripts/runner.mjs <queueId>) — same
// detached no-kill-timeout contract as the batch spawn (D-06: killing the
// process kills the browser and any open review tabs). runner.mjs owns its own
// guards (queued-only refuse, PROFILE_LOCKED single-instance) and idles after
// the fill to keep the browser open for review.
export function spawnFillRunner(queueId: number, spawnFn: SpawnFn = Bun.spawn): SpawnBatchRunnerResult {
  try {
    const proc = spawnFn([process.execPath, join(REPO_ROOT, 'scripts', 'runner.mjs'), String(queueId)], {
      cwd: REPO_ROOT,
      env: process.env,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    proc.unref();
    return { spawned: true };
  } catch (err) {
    return { spawned: false, error: String((err as Error)?.message ?? err) };
  }
}

export function spawnBatchRunner(runId: number, spawnFn: SpawnFn = Bun.spawn): SpawnBatchRunnerResult {
  try {
    // stdio is 'ignore', not 'pipe': nothing ever drains a pipe from a
    // detached, unref()'d child, so once the ~64KB kernel buffer filled the
    // child's console.log would block and stall the run mid-fill (which in
    // turn stops its heartbeat). The helper learns outcomes over PATCH
    // /batch-runs/:id, never over stdio.
    const proc = spawnFn([process.execPath, join(REPO_ROOT, 'scripts', 'batch-runner.mjs'), String(runId)], {
      cwd: REPO_ROOT,
      env: process.env,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    proc.unref();
    return { spawned: true };
  } catch (err) {
    return { spawned: false, error: String((err as Error)?.message ?? err) };
  }
}
