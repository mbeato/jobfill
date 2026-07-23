import type { Database } from 'bun:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSweep, type SweepDeps } from './sweep';
import { runFilterPromote, type DecideDeps, type FilterCounts } from './decide';
import { startSweepRun, finishSweepRun, isSweepRunning, getRunningSweep, type SweepTrigger } from './runs';
import { isBatchRunning, getRunningBatch, reconcileInterruptedBatchRuns } from './batch';
import type { SeekConfig } from './types';

// The single sweep entrypoint (D-09/SCHED-02): scheduler tick and POST /sweep
// (a later plan) both call runSweepJob — one function performs a sweep, so
// "identical code path" holds by construction. Composes Phase 9's fetch
// sweep, Phase 10's filter/promote, and the helper-owned sidecar spawn into
// exactly one finished `sweeps` row (D-13).

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export class SweepAlreadyRunningError extends Error {
  runId: number;
  constructor(runId: number) {
    super(`sweep already running (run ${runId})`);
    this.name = 'SweepAlreadyRunningError';
    this.runId = runId;
  }
}

// D-08 reverse mutual exclusion: a sweep trigger while a batch is running is
// rejected, pointing at the in-progress batch run.
export class BatchInProgressError extends Error {
  runId: number;
  constructor(runId: number) {
    super(`batch is running (run ${runId})`);
    this.name = 'BatchInProgressError';
    this.runId = runId;
  }
}

export interface SidecarResult {
  ran: boolean;
  exitCode?: number;
  error?: string;
  authExpired: string[];
}

export interface JobDeps extends SweepDeps, DecideDeps {
  spawnSidecar: () => Promise<SidecarResult>;
}

// D-11 single-flight gate: rejects a second concurrent start, carrying the
// already-running run's id. Synchronous — the row exists before any await,
// so a caller (e.g. a fire-and-poll HTTP route) can read the id back
// immediately.
export function beginSweep(db: Database, trigger: SweepTrigger): { runId: number } {
  // A detached batch-runner can die without ever PATCHing its row (SIGKILL,
  // crash) — clear heartbeat-stale 'running' rows before consulting the raw
  // lock, or a dead run wedges sweep scheduling until a helper restart.
  // Idempotent and heartbeat-gated: a live run is never touched.
  reconcileInterruptedBatchRuns(db);
  if (isBatchRunning(db)) {
    const running = getRunningBatch(db)!;
    throw new BatchInProgressError(running.id);
  }
  if (isSweepRunning(db)) {
    const running = getRunningSweep(db)!;
    throw new SweepAlreadyRunningError(running.id);
  }
  const row = startSweepRun(db, trigger);
  return { runId: row.id };
}

const AUTH_EXPIRED_RE = /^\[auth-expired\]\s+(yc|jobright)\b/;

// D-09/Pattern 4: the helper (not the CLI) owns spawning the login-gated
// sidecar. process.execPath (never a bare runtime-name string) so launchd's
// minimal PATH can never strand this spawn. Never throws — every failure mode collapses
// into { ran: false, error, authExpired: [] } (D-12/D-13 fail-open).
export async function spawnSidecar(): Promise<SidecarResult> {
  try {
    const proc = Bun.spawn([process.execPath, join(REPO_ROOT, 'scripts', 'seek-sidecar.mjs')], {
      cwd: REPO_ROOT,
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10 * 60 * 1000,
      killSignal: 'SIGTERM',
    });
    const exitCode = await proc.exited;
    const stdoutText = await new Response(proc.stdout).text();
    const authExpired: string[] = [];
    for (const line of stdoutText.split('\n')) {
      const match = AUTH_EXPIRED_RE.exec(line);
      if (match) authExpired.push(match[1]);
    }
    return { ran: true, exitCode, authExpired };
  } catch (err) {
    return { ran: false, error: String((err as Error)?.message ?? err), authExpired: [] };
  }
}

// D-15-style headline shape (fetched/rejected/deduped/held/queued/byCriterion)
// — the exact literal helper/server.ts's POST /seek route already builds,
// preserved verbatim so nothing the old flow printed is dropped.
function buildHeadline(fetchedTotal: number, filterCounts: FilterCounts) {
  return {
    at: new Date().toISOString(),
    fetched: fetchedTotal || filterCounts.toDecide,
    rejected: filterCounts.rulesRejected + filterCounts.llmRejected + filterCounts.deduped,
    deduped: filterCounts.deduped,
    held: filterCounts.held,
    queued: filterCounts.queued,
    byCriterion: filterCounts.byCriterion,
  };
}

export async function runSweepJob(
  db: Database,
  config: SeekConfig,
  deps: JobDeps,
  runId: number,
): Promise<{ runId: number; status: 'ok' | 'failed' }> {
  let fetchResults;
  let filterCounts: FilterCounts;
  try {
    fetchResults = await runSweep(db, config, deps);
    filterCounts = await runFilterPromote(db, deps);
  } catch (err) {
    // D-03: a sweep-level failure is not "done" — the scheduler retries
    // within the daily cap.
    finishSweepRun(db, runId, 'failed', { error: String((err as Error)?.message ?? err) });
    throw err;
  }

  // D-12/D-13: the sidecar is fail-open — a second defensive try/catch here
  // guarantees no thrown deps.spawnSidecar implementation can ever escalate
  // into a sweep-level failure, on top of the real impl's own try/catch.
  let sidecar: SidecarResult;
  try {
    sidecar = await deps.spawnSidecar();
  } catch (err) {
    sidecar = { ran: false, error: String((err as Error)?.message ?? err), authExpired: [] };
  }

  const fetchedTotal = fetchResults.reduce((sum, r) => sum + (r.fetched ?? 0), 0);
  const headline = buildHeadline(fetchedTotal, filterCounts);
  const detail = { fetch: fetchResults, filter: filterCounts, sidecar, headline };

  finishSweepRun(db, runId, 'ok', detail);
  // Preserve the existing dashboard #seekStats path — nothing regresses.
  db.run('INSERT OR REPLACE INTO seek_meta(key, value) VALUES (?, ?)', ['last_sweep', JSON.stringify(headline)]);

  return { runId, status: 'ok' };
}
