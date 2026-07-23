import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createBatchRunsTable,
  startBatchRun,
  finishBatchRun,
  listBatchRuns,
  getBatchRunById,
  isBatchRunning,
  getRunningBatch,
  getFreshRunningBatch,
  reconcileInterruptedBatchRuns,
  getLastBatchRunState,
  touchBatchHeartbeat,
  BATCH_STATUSES,
  InvalidBatchStatusError,
} from './batch';
import { localDateKey } from './runs';

function makeDb(): Database {
  const db = new Database(':memory:');
  createBatchRunsTable(db);
  return db;
}

test('createBatchRunsTable creates a table that supports insert+select', () => {
  const db = makeDb();
  db.run(`INSERT INTO batch_runs (trigger, run_date) VALUES ('manual', '2026-07-22')`);
  const rows = db.query('SELECT * FROM batch_runs').all();
  expect(rows.length).toBe(1);
});

test('BATCH_STATUSES contains exactly the three lifecycle values', () => {
  expect([...BATCH_STATUSES].sort()).toEqual(['failed', 'ok', 'running']);
});

test('startBatchRun inserts a running row with a synchronous numeric id', () => {
  const db = makeDb();
  const row = startBatchRun(db, 'manual');
  expect(typeof row.id).toBe('number');
  expect(row.status).toBe('running');
  expect(row.trigger).toBe('manual');
  expect(row.run_date).toBe(localDateKey(new Date()));
  // Seeded at birth (lease semantics) so reconciliation running before a
  // lock check never flips a just-created row before its first heartbeat.
  expect(row.heartbeat_at).not.toBeNull();
});

test('finishBatchRun sets status/finished_at/detail on success', () => {
  const db = makeDb();
  const started = startBatchRun(db, 'scheduled');
  const detail = { headline: { filled: 2, skipped: 1, failed: 0 }, stop_reason: 'queue empty', skipped: [], failed: [], filled: [] };
  const finished = finishBatchRun(db, started.id, 'ok', detail);
  expect(finished?.status).toBe('ok');
  expect(finished?.finished_at).not.toBeNull();
  expect(JSON.parse(finished!.detail!)).toEqual(detail);
});

test('finishBatchRun with an invalid status throws InvalidBatchStatusError and leaves the row unchanged', () => {
  const db = makeDb();
  const started = startBatchRun(db, 'manual');
  expect(() => finishBatchRun(db, started.id, 'bogus' as any, {})).toThrow(InvalidBatchStatusError);
  const row = getBatchRunById(db, started.id);
  expect(row?.status).toBe('running');
  expect(row?.finished_at).toBeNull();
});

test('touchBatchHeartbeat refreshes a stale heartbeat_at', () => {
  const db = makeDb();
  const started = startBatchRun(db, 'manual');
  db.query(`UPDATE batch_runs SET heartbeat_at = datetime('now', '-10 minutes') WHERE id = ?`).run(started.id);
  touchBatchHeartbeat(db, started.id);
  const row = getBatchRunById(db, started.id);
  expect(row?.heartbeat_at).not.toBeNull();
  expect(getFreshRunningBatch(db)?.id).toBe(started.id);
});

test('isBatchRunning / getRunningBatch reflect the single-flight lock regardless of heartbeat freshness', () => {
  const db = makeDb();
  expect(isBatchRunning(db)).toBe(false);
  expect(getRunningBatch(db)).toBeNull();
  const started = startBatchRun(db, 'manual');
  expect(isBatchRunning(db)).toBe(true);
  expect(getRunningBatch(db)?.id).toBe(started.id);
  finishBatchRun(db, started.id, 'ok', {});
  expect(isBatchRunning(db)).toBe(false);
  expect(getRunningBatch(db)).toBeNull();
});

test('getFreshRunningBatch returns null when heartbeat_at is null (legacy/manual rows)', () => {
  const db = makeDb();
  const started = startBatchRun(db, 'manual');
  db.query(`UPDATE batch_runs SET heartbeat_at = NULL WHERE id = ?`).run(started.id);
  expect(getFreshRunningBatch(db)).toBeNull();
});

test('getFreshRunningBatch returns the row when heartbeat_at is within the stale window', () => {
  const db = makeDb();
  const started = startBatchRun(db, 'manual');
  touchBatchHeartbeat(db, started.id);
  const fresh = getFreshRunningBatch(db);
  expect(fresh?.id).toBe(started.id);
});

test('getFreshRunningBatch returns null when heartbeat_at is older than the stale window', () => {
  const db = makeDb();
  const started = startBatchRun(db, 'manual');
  db.query(`UPDATE batch_runs SET heartbeat_at = datetime('now', '-10 minutes') WHERE id = ?`).run(started.id);
  expect(getFreshRunningBatch(db)).toBeNull();
});

test('reconcileInterruptedBatchRuns flips a NULL-heartbeat running row to failed with stop_reason interrupted', () => {
  const db = makeDb();
  const started = startBatchRun(db, 'manual');
  db.query(`UPDATE batch_runs SET heartbeat_at = NULL WHERE id = ?`).run(started.id);
  const flipped = reconcileInterruptedBatchRuns(db);
  expect(flipped).toBe(1);
  const row = getBatchRunById(db, started.id);
  expect(row?.status).toBe('failed');
  const detail = JSON.parse(row!.detail!);
  expect(detail.stop_reason).toBe('interrupted');
  expect(detail.headline).toEqual({ filled: 0, skipped: 0, failed: 0 });
});

test('reconcileInterruptedBatchRuns flips a stale-heartbeat running row to failed', () => {
  const db = makeDb();
  const started = startBatchRun(db, 'manual');
  db.query(`UPDATE batch_runs SET heartbeat_at = datetime('now', '-10 minutes') WHERE id = ?`).run(started.id);
  const flipped = reconcileInterruptedBatchRuns(db);
  expect(flipped).toBe(1);
  expect(getBatchRunById(db, started.id)?.status).toBe('failed');
});

test('reconcileInterruptedBatchRuns leaves a fresh-heartbeat running row untouched', () => {
  const db = makeDb();
  const started = startBatchRun(db, 'manual');
  touchBatchHeartbeat(db, started.id);
  const flipped = reconcileInterruptedBatchRuns(db);
  expect(flipped).toBe(0);
  const row = getBatchRunById(db, started.id);
  expect(row?.status).toBe('running');
});

test('reconcileInterruptedBatchRuns is idempotent', () => {
  const db = makeDb();
  const started = startBatchRun(db, 'manual');
  db.query(`UPDATE batch_runs SET heartbeat_at = datetime('now', '-10 minutes') WHERE id = ?`).run(started.id);
  const first = reconcileInterruptedBatchRuns(db);
  expect(first).toBe(1);
  const second = reconcileInterruptedBatchRuns(db);
  expect(second).toBe(0);
});

test('getLastBatchRunState returns null on an empty table', () => {
  const db = makeDb();
  expect(getLastBatchRunState(db)).toBeNull();
});

test('getLastBatchRunState returns the most-recent run_date status and attempt count', () => {
  const db = makeDb();
  db.run(`INSERT INTO batch_runs (trigger, status, run_date) VALUES ('scheduled', 'ok', '2026-07-20')`);
  db.run(`INSERT INTO batch_runs (trigger, status, run_date) VALUES ('manual', 'failed', '2026-07-21')`);
  db.run(`INSERT INTO batch_runs (trigger, status, run_date) VALUES ('scheduled', 'ok', '2026-07-21')`);
  const state = getLastBatchRunState(db);
  expect(state).toEqual({ date: '2026-07-21', status: 'ok', attempts: 2 });
});

test('listBatchRuns returns rows newest-first and respects an optional limit', () => {
  const db = makeDb();
  const a = startBatchRun(db, 'manual');
  const b = startBatchRun(db, 'scheduled');
  const c = startBatchRun(db, 'manual');
  const all = listBatchRuns(db);
  expect(all.map(r => r.id)).toEqual([c.id, b.id, a.id]);
  const limited = listBatchRuns(db, 2);
  expect(limited.map(r => r.id)).toEqual([c.id, b.id]);
});

test('getBatchRunById returns null for a missing id', () => {
  const db = makeDb();
  expect(getBatchRunById(db, 999)).toBeNull();
});
