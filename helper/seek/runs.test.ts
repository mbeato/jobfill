import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createSweepsTable,
  startSweepRun,
  finishSweepRun,
  listSweeps,
  getSweepById,
  isSweepRunning,
  getRunningSweep,
  reconcileInterruptedSweeps,
  getLastRunState,
  localDateKey,
  SWEEP_STATUSES,
  InvalidSweepStatusError,
} from './runs';

function makeDb(): Database {
  const db = new Database(':memory:');
  createSweepsTable(db);
  return db;
}

test('createSweepsTable creates a table that supports insert+select', () => {
  const db = makeDb();
  db.run(`INSERT INTO sweeps (trigger, run_date) VALUES ('manual', '2026-07-22')`);
  const rows = db.query('SELECT * FROM sweeps').all();
  expect(rows.length).toBe(1);
});

test('SWEEP_STATUSES contains exactly the three lifecycle values', () => {
  expect([...SWEEP_STATUSES].sort()).toEqual(['failed', 'ok', 'running']);
});

test('startSweepRun inserts a running row with a synchronous numeric id', () => {
  const db = makeDb();
  const row = startSweepRun(db, 'manual');
  expect(typeof row.id).toBe('number');
  expect(row.status).toBe('running');
  expect(row.trigger).toBe('manual');
  expect(row.run_date).toBe(localDateKey(new Date()));
});

test('finishSweepRun sets status/finished_at/detail on success', () => {
  const db = makeDb();
  const started = startSweepRun(db, 'scheduled');
  const finished = finishSweepRun(db, started.id, 'ok', { fetched: 12, upserted: 10 });
  expect(finished?.status).toBe('ok');
  expect(finished?.finished_at).not.toBeNull();
  expect(JSON.parse(finished!.detail!)).toEqual({ fetched: 12, upserted: 10 });
});

test('finishSweepRun with an invalid status throws and leaves the row unchanged', () => {
  const db = makeDb();
  const started = startSweepRun(db, 'manual');
  expect(() => finishSweepRun(db, started.id, 'bogus' as any, {})).toThrow(InvalidSweepStatusError);
  const row = getSweepById(db, started.id);
  expect(row?.status).toBe('running');
  expect(row?.finished_at).toBeNull();
});

test('isSweepRunning / getRunningSweep reflect the single-flight lock', () => {
  const db = makeDb();
  expect(isSweepRunning(db)).toBe(false);
  expect(getRunningSweep(db)).toBeNull();
  const started = startSweepRun(db, 'manual');
  expect(isSweepRunning(db)).toBe(true);
  expect(getRunningSweep(db)?.id).toBe(started.id);
  finishSweepRun(db, started.id, 'ok', {});
  expect(isSweepRunning(db)).toBe(false);
  expect(getRunningSweep(db)).toBeNull();
});

test('reconcileInterruptedSweeps flips every running row to failed and is idempotent', () => {
  const db = makeDb();
  const a = startSweepRun(db, 'manual');
  const b = startSweepRun(db, 'scheduled');
  const flipped = reconcileInterruptedSweeps(db);
  expect(flipped).toBe(2);
  const rowA = getSweepById(db, a.id);
  const rowB = getSweepById(db, b.id);
  expect(rowA?.status).toBe('failed');
  expect(rowB?.status).toBe('failed');
  expect(JSON.parse(rowA!.detail!)).toEqual({ reason: 'interrupted-by-restart' });
  const secondFlip = reconcileInterruptedSweeps(db);
  expect(secondFlip).toBe(0);
});

test('getLastRunState returns null on an empty table', () => {
  const db = makeDb();
  expect(getLastRunState(db)).toBeNull();
});

test('getLastRunState returns the most-recent run_date status and attempt count', () => {
  const db = makeDb();
  db.run(`INSERT INTO sweeps (trigger, status, run_date) VALUES ('scheduled', 'ok', '2026-07-20')`);
  db.run(`INSERT INTO sweeps (trigger, status, run_date) VALUES ('manual', 'failed', '2026-07-21')`);
  db.run(`INSERT INTO sweeps (trigger, status, run_date) VALUES ('scheduled', 'ok', '2026-07-21')`);
  const state = getLastRunState(db);
  expect(state).toEqual({ date: '2026-07-21', status: 'ok', attempts: 2 });
});

test('localDateKey derives from local getters, not UTC — same local day straddling UTC midnight yields the same key', () => {
  // 23:30 local and 00:30 local the next calendar minute both belong to the
  // SAME local day when constructed via local-time Date components (not an
  // ISO/UTC string), independent of the machine's timezone offset.
  const a = new Date(2026, 6, 22, 23, 30, 0); // local July 22, 23:30
  const b = new Date(2026, 6, 22, 23, 59, 59); // local July 22, 23:59:59
  expect(localDateKey(a)).toBe('2026-07-22');
  expect(localDateKey(b)).toBe('2026-07-22');
  const c = new Date(2026, 6, 23, 0, 0, 1); // local July 23, just after midnight
  expect(localDateKey(c)).toBe('2026-07-23');
});

test('listSweeps returns rows newest-first and respects an optional limit', () => {
  const db = makeDb();
  const a = startSweepRun(db, 'manual');
  const b = startSweepRun(db, 'scheduled');
  const c = startSweepRun(db, 'manual');
  const all = listSweeps(db);
  expect(all.map(r => r.id)).toEqual([c.id, b.id, a.id]);
  const limited = listSweeps(db, 2);
  expect(limited.map(r => r.id)).toEqual([c.id, b.id]);
});

test('getSweepById returns null for a missing id', () => {
  const db = makeDb();
  expect(getSweepById(db, 999)).toBeNull();
});
