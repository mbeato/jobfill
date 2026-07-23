import type { Database } from 'bun:sqlite';
import { localDateKey, type LastRunState } from './runs';

// The `batch_runs` run-history table (D-07, Phase 12): every batch fill —
// scheduled or manual — gets a row here, from start to finish. Mirrors
// runs.ts's sweeps table exactly, plus one addition: heartbeat_at. The batch
// process is detached and survives helper restarts (D-06), so a stale
// 'running' row can only be reconciled to 'failed' once its heartbeat has
// gone cold — a live detached run keeps refreshing it and is never wrongly
// cleared.

export type BatchTrigger = 'scheduled' | 'manual';
export type BatchStatus = 'running' | 'ok' | 'failed';

export const BATCH_STATUSES = new Set<BatchStatus>(['running', 'ok', 'failed']);

export class InvalidBatchStatusError extends Error {
  constructor(status: string) {
    super(`invalid batch status: ${status}`);
    this.name = 'InvalidBatchStatusError';
  }
}

export interface BatchRow {
  id: number;
  trigger: BatchTrigger;
  status: BatchStatus;
  run_date: string;
  started_at: string;
  finished_at: string | null;
  heartbeat_at: string | null;
  detail: string | null;
}

// Canonical batch_runs.detail JSON contract (12-01-PLAN.md <interfaces>).
// Plans 04/05/06 consume this shape verbatim.
export interface BatchDetail {
  headline: { filled: number; skipped: number; failed: number };
  stop_reason: 'cap' | 'queue empty' | 'browser busy' | 'circuit breaker' | 'interrupted';
  skipped: { queueId: number; company: string; role: string; reason: 'login-gated' | 'not-fillable' | 'unsupported-host' }[];
  failed: { queueId: number; company: string; role: string; reason: 'no-form' | 'fill-failed' | 'timeout' | 'trigger-error' | 'duplicate' }[];
  filled: { queueId: number; company: string; role: string; reviewed: boolean }[];
}

const STALE_HEARTBEAT_MS = 180_000; // 3 minutes

export function createBatchRunsTable(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS batch_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger TEXT,
    status TEXT DEFAULT 'running',
    run_date TEXT,
    started_at TEXT DEFAULT (datetime('now')),
    finished_at TEXT,
    heartbeat_at TEXT,
    detail TEXT
  )`);
}

export function startBatchRun(db: Database, trigger: BatchTrigger): BatchRow {
  return db
    .query(`INSERT INTO batch_runs (trigger, run_date) VALUES (?, ?) RETURNING *`)
    .get(trigger, localDateKey(new Date())) as BatchRow;
}

export function finishBatchRun(db: Database, id: number, status: BatchStatus, detail: unknown): BatchRow | null {
  if (!BATCH_STATUSES.has(status)) {
    throw new InvalidBatchStatusError(status);
  }
  db.query(`UPDATE batch_runs SET status = ?, finished_at = datetime('now'), detail = ? WHERE id = ?`).run(
    status,
    JSON.stringify(detail),
    id,
  );
  return db.query('SELECT * FROM batch_runs WHERE id = ?').get(id) as BatchRow | null;
}

// The detached batch process (D-06) calls this periodically to prove it's
// still alive — this is what lets reconcileInterruptedBatchRuns tell a live
// long-running batch apart from one that died mid-run.
export function touchBatchHeartbeat(db: Database, id: number): void {
  db.query(`UPDATE batch_runs SET heartbeat_at = datetime('now') WHERE id = ?`).run(id);
}

export function listBatchRuns(db: Database, limit?: number): BatchRow[] {
  const sql = 'SELECT * FROM batch_runs ORDER BY id DESC' + (limit !== undefined ? ' LIMIT ?' : '');
  return (limit !== undefined ? db.query(sql).all(limit) : db.query(sql).all()) as BatchRow[];
}

export function getBatchRunById(db: Database, id: number): BatchRow | null {
  return db.query('SELECT * FROM batch_runs WHERE id = ?').get(id) as BatchRow | null;
}

export function isBatchRunning(db: Database): boolean {
  return getRunningBatch(db) !== null;
}

export function getRunningBatch(db: Database): BatchRow | null {
  return db.query(`SELECT * FROM batch_runs WHERE status = 'running' ORDER BY id DESC LIMIT 1`).get() as BatchRow | null;
}

// Only reports a running row whose heartbeat is fresh — used by the
// single-flight lock so a genuinely dead run doesn't wedge it, while a live
// detached run (which keeps calling touchBatchHeartbeat) is reported as
// legitimately in-progress.
export function getFreshRunningBatch(db: Database, staleMs: number = STALE_HEARTBEAT_MS): BatchRow | null {
  const offset = `-${Math.floor(staleMs / 1000)} seconds`;
  return db
    .query(
      `SELECT * FROM batch_runs WHERE status = 'running' AND heartbeat_at IS NOT NULL AND heartbeat_at >= datetime('now', ?) ORDER BY id DESC LIMIT 1`,
    )
    .get(offset) as BatchRow | null;
}

// Crash reconciliation (heartbeat-gated, unlike reconcileInterruptedSweeps):
// a 'running' row with a NULL or stale heartbeat can only mean the detached
// process died — flip it to 'failed'. A 'running' row with a fresh heartbeat
// is a live detached run and is left untouched. Idempotent.
export function reconcileInterruptedBatchRuns(db: Database, staleMs: number = STALE_HEARTBEAT_MS): number {
  const offset = `-${Math.floor(staleMs / 1000)} seconds`;
  const stuck = db
    .query(`SELECT id FROM batch_runs WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < datetime('now', ?))`)
    .all(offset) as { id: number }[];
  if (stuck.length === 0) return 0;
  const detail: BatchDetail = {
    headline: { filled: 0, skipped: 0, failed: 0 },
    stop_reason: 'interrupted',
    skipped: [],
    failed: [],
    filled: [],
  };
  db.query(
    `UPDATE batch_runs SET status = 'failed', finished_at = datetime('now'), detail = ? WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < datetime('now', ?))`,
  ).run(JSON.stringify(detail), offset);
  return stuck.length;
}

export function getLastBatchRunState(db: Database): LastRunState | null {
  const latest = db.query(`SELECT MAX(run_date) as run_date FROM batch_runs`).get() as { run_date: string | null } | null;
  if (!latest?.run_date) return null;
  const status = db
    .query(`SELECT status FROM batch_runs WHERE run_date = ? ORDER BY id DESC LIMIT 1`)
    .get(latest.run_date) as { status: BatchStatus };
  const { count } = db
    .query(`SELECT COUNT(*) as count FROM batch_runs WHERE run_date = ?`)
    .get(latest.run_date) as { count: number };
  return { date: latest.run_date, status: status.status, attempts: count };
}
