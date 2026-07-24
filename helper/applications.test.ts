import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createApplicationsTable,
  insertApplication,
  updateApplicationStatus,
  deriveGhost,
  promoteUnsubmittedToApplied,
  PRE_SUBMIT_STATUS,
  GHOST_DAYS,
  InvalidApplicationStatusError,
} from './applications';

function makeDb(): Database {
  const db = new Database(':memory:');
  createApplicationsTable(db);
  return db;
}

const noQueue = () => null;

test('createApplicationsTable + insertApplication default status to the pre-submit token (D-06) and round-trips', () => {
  const db = makeDb();
  const row = insertApplication(
    db,
    { company: 'Acme', role: 'SWE', url: 'https://acme.com/apply', cost_usd: 0.03, summary: ['a', 'b'] },
    noQueue,
  );
  expect(row.status).toBe(PRE_SUBMIT_STATUS);
  expect(row.company).toBe('Acme');
  expect(row.role).toBe('SWE');
  expect(row.cost_usd).toBe(0.03);
  // summary is stored as a JSON blob on the row
  expect(JSON.parse(row.summary)).toEqual(['a', 'b']);

  const stored = db.query('SELECT * FROM applications WHERE id = ?').get(row.id) as { status: string };
  expect(stored.status).toBe(PRE_SUBMIT_STATUS);
});

test('a status outside APPLICATION_STATUSES throws InvalidApplicationStatusError (T-13-01)', () => {
  const db = makeDb();
  const row = insertApplication(db, { company: 'Acme' }, noQueue);
  expect(() => updateApplicationStatus(db, row.id, { status: 'x"><img src=x onerror=alert(1)>' })).toThrow(
    InvalidApplicationStatusError,
  );
  // rejection happened before any write — status is still the pre-submit default
  const stored = db.query('SELECT status FROM applications WHERE id = ?').get(row.id) as { status: string };
  expect(stored.status).toBe(PRE_SUBMIT_STATUS);
});

test('D-11 clock: a real status change bumps status_changed_at; re-selecting the same status does not', () => {
  const db = makeDb();
  const row = insertApplication(db, { company: 'Acme' }, noQueue);

  // First real change sets the clock.
  updateApplicationStatus(db, row.id, { status: 'applied' });
  let stamp = (db.query('SELECT status_changed_at FROM applications WHERE id = ?').get(row.id) as {
    status_changed_at: string | null;
  }).status_changed_at;
  expect(stamp).not.toBeNull();

  // Pin the clock to a known sentinel so the no-op assertion is timing-independent:
  // if the second patch wrongly bumped it, it would become datetime('now') != sentinel.
  const SENTINEL = '2000-01-01 00:00:00';
  db.query('UPDATE applications SET status_changed_at = ? WHERE id = ?').run(SENTINEL, row.id);

  // Re-selecting the SAME status is a no-op for the clock (D-11).
  updateApplicationStatus(db, row.id, { status: 'applied' });
  stamp = (db.query('SELECT status_changed_at FROM applications WHERE id = ?').get(row.id) as {
    status_changed_at: string | null;
  }).status_changed_at;
  expect(stamp).toBe(SENTINEL);

  // A real change DOES move it off the sentinel.
  updateApplicationStatus(db, row.id, { status: 'replied' });
  stamp = (db.query('SELECT status_changed_at FROM applications WHERE id = ?').get(row.id) as {
    status_changed_at: string | null;
  }).status_changed_at;
  expect(stamp).not.toBe(SENTINEL);
});

test('deriveGhost table: only an applied row silent >= GHOST_DAYS ghosts (D-13/D-14)', () => {
  const NOW = new Date('2026-07-24T12:00:00.000Z');
  const stampDaysAgo = (n: number) =>
    new Date(NOW.getTime() - n * 86400000).toISOString().replace('T', ' ').slice(0, 19);

  // applied at 20 days -> not ghosted, days_silent floored to 20
  const a20 = deriveGhost({ status: 'applied', status_changed_at: stampDaysAgo(20) }, NOW);
  expect(a20).toEqual({ ghosted: false, days_silent: 20 });

  // applied at GHOST_DAYS (21) -> ghosted
  const a21 = deriveGhost({ status: 'applied', status_changed_at: stampDaysAgo(GHOST_DAYS) }, NOW);
  expect(a21).toEqual({ ghosted: true, days_silent: 21 });

  // a non-'applied' row never ghosts, even at 40 days (D-13 boundary)
  const replied40 = deriveGhost({ status: 'replied', status_changed_at: stampDaysAgo(40) }, NOW);
  expect(replied40).toEqual({ ghosted: false, days_silent: 40 });

  // a pre-submit row never ghosts, even at 40 days
  const unsub40 = deriveGhost({ status: PRE_SUBMIT_STATUS, status_changed_at: stampDaysAgo(40) }, NOW);
  expect(unsub40).toEqual({ ghosted: false, days_silent: 40 });
});

test('promoteUnsubmittedToApplied promotes a pre-submit row and refuses every other status (T-13-03)', () => {
  const db = makeDb();

  // pre-submit row -> promoted to 'applied', returns true
  const pending = insertApplication(db, { company: 'Acme' }, noQueue);
  expect(promoteUnsubmittedToApplied(db, pending.id)).toBe(true);
  expect((db.query('SELECT status FROM applications WHERE id = ?').get(pending.id) as { status: string }).status).toBe(
    'applied',
  );

  // already-'applied' row -> no-op, returns false
  expect(promoteUnsubmittedToApplied(db, pending.id)).toBe(false);

  // 'rejected' row -> no-op, returns false, status untouched (guard proves it refuses)
  const rejected = insertApplication(db, { company: 'Beta' }, noQueue);
  updateApplicationStatus(db, rejected.id, { status: 'rejected' });
  expect(promoteUnsubmittedToApplied(db, rejected.id)).toBe(false);
  expect((db.query('SELECT status FROM applications WHERE id = ?').get(rejected.id) as { status: string }).status).toBe(
    'rejected',
  );
});
