import type { Database } from 'bun:sqlite';

// The `sweeps` run-history table (D-13, Phase 11): every sweep — scheduled or
// manual — gets a row here, from start to finish. Canonical operational
// record for the dashboard and the single-flight lock's persistence. Mirrors
// helper/queue.ts's dependency-injected, self-defending style (enum-guarded
// status writes, INSERT ... RETURNING * for a synchronous id).

export type SweepTrigger = 'scheduled' | 'manual';
export type SweepStatus = 'running' | 'ok' | 'failed';

export const SWEEP_STATUSES = new Set<SweepStatus>(['running', 'ok', 'failed']);

export class InvalidSweepStatusError extends Error {
  constructor(status: string) {
    super(`invalid sweep status: ${status}`);
    this.name = 'InvalidSweepStatusError';
  }
}

export interface SweepRow {
  id: number;
  trigger: SweepTrigger;
  status: SweepStatus;
  run_date: string;
  started_at: string;
  finished_at: string | null;
  detail: string | null;
}

export interface LastRunState {
  date: string;
  status: SweepStatus;
  attempts: number;
}

export function createSweepsTable(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS sweeps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger TEXT,
    status TEXT DEFAULT 'running',
    run_date TEXT,
    started_at TEXT DEFAULT (datetime('now')),
    finished_at TEXT,
    detail TEXT
  )`);
}

// LOCAL date key (not UTC) — the daily cadence is anchored to the operator's local day,
// not the server's UTC day, so getFullYear/getMonth/getDate (never
// toISOString) is the only correct source.
export function localDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function startSweepRun(db: Database, trigger: SweepTrigger): SweepRow {
  return db
    .query(`INSERT INTO sweeps (trigger, run_date) VALUES (?, ?) RETURNING *`)
    .get(trigger, localDateKey(new Date())) as SweepRow;
}

export function finishSweepRun(db: Database, id: number, status: SweepStatus, detail: unknown): SweepRow | null {
  if (!SWEEP_STATUSES.has(status)) {
    throw new InvalidSweepStatusError(status);
  }
  db.query(`UPDATE sweeps SET status = ?, finished_at = datetime('now'), detail = ? WHERE id = ?`).run(
    status,
    JSON.stringify(detail),
    id,
  );
  return db.query('SELECT * FROM sweeps WHERE id = ?').get(id) as SweepRow | null;
}

export function listSweeps(db: Database, limit?: number): SweepRow[] {
  const sql = 'SELECT * FROM sweeps ORDER BY id DESC' + (limit !== undefined ? ' LIMIT ?' : '');
  return (limit !== undefined ? db.query(sql).all(limit) : db.query(sql).all()) as SweepRow[];
}

export function getSweepById(db: Database, id: number): SweepRow | null {
  return db.query('SELECT * FROM sweeps WHERE id = ?').get(id) as SweepRow | null;
}

export function isSweepRunning(db: Database): boolean {
  return getRunningSweep(db) !== null;
}

export function getRunningSweep(db: Database): SweepRow | null {
  return db.query(`SELECT * FROM sweeps WHERE status = 'running' ORDER BY id DESC LIMIT 1`).get() as SweepRow | null;
}

// Crash reconciliation: any row still marked 'running' when the process
// starts back up can only mean the prior process died mid-sweep — flip it to
// 'failed' so a stuck row never blocks the single-flight lock forever.
// Idempotent: a second call after the first flips zero rows.
export function reconcileInterruptedSweeps(db: Database): number {
  const stuck = db.query(`SELECT id FROM sweeps WHERE status = 'running'`).all() as { id: number }[];
  if (stuck.length === 0) return 0;
  db.query(
    `UPDATE sweeps SET status = 'failed', finished_at = datetime('now'), detail = ? WHERE status = 'running'`,
  ).run(JSON.stringify({ reason: 'interrupted-by-restart' }));
  return stuck.length;
}

export function getLastRunState(db: Database): LastRunState | null {
  const latest = db.query(`SELECT MAX(run_date) as run_date FROM sweeps`).get() as { run_date: string | null } | null;
  if (!latest?.run_date) return null;
  const status = db
    .query(`SELECT status FROM sweeps WHERE run_date = ? ORDER BY id DESC LIMIT 1`)
    .get(latest.run_date) as { status: SweepStatus };
  const { count } = db
    .query(`SELECT COUNT(*) as count FROM sweeps WHERE run_date = ?`)
    .get(latest.run_date) as { count: number };
  return { date: latest.run_date, status: status.status, attempts: count };
}
