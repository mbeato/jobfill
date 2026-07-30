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
  MAX_JD,
  InvalidApplicationStatusError,
} from './applications';

// MAX_TEXT is module-private; mirror its value here for the truncation test
// rather than exporting it solely for the test (it is not part of the public API).
const MAX_TEXT = 2000;

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

test('insertApplication persists jd on the row (D-02/D-03)', () => {
  const db = makeDb();
  const row = insertApplication(db, { company: 'Acme', jd: 'some description text' }, noQueue);
  expect(row.jd).toBe('some description text');
});

test('insertApplication truncates an over-cap jd at MAX_JD instead of storing an unbounded blob (D-04/D-05)', () => {
  const db = makeDb();
  const row = insertApplication(db, { company: 'Acme', jd: 'x'.repeat(MAX_JD + 100) }, noQueue);
  expect(row.jd.length).toBe(MAX_JD);
});

test('insertApplication defaults a missing jd to an empty string (D-03)', () => {
  const db = makeDb();
  const row = insertApplication(db, { company: 'Acme' }, noQueue);
  expect(row.jd).toBe('');
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

// ── url dedupe (the "already submitted but shows awaiting submit" bug) ────────
// Every fill used to INSERT a fresh application row. queue.application_id links
// exactly ONE of them, so marking the queue row submitted flipped only that one
// and the siblings sat at the pre-submit token forever, reading as "awaiting
// submit" for postings already submitted. Observed live: 8 urls with 2-3 rows
// each, 11 rows collapsed, and the applied count inflated by 5.

const URL = 'https://boards.greenhouse.io/acme/jobs/1';

test('re-filling the same url updates the existing row instead of forking a second', () => {
  const db = makeDb();
  const first = insertApplication(db, { company: 'Acme', role: 'SWE', url: URL }, noQueue);
  const second = insertApplication(db, { company: 'Acme', role: 'SWE (updated)', url: URL }, noQueue);

  expect(second.id).toBe(first.id);
  expect((db.query('SELECT COUNT(*) c FROM applications WHERE url = ?').get(URL) as { c: number }).c).toBe(1);
  expect(second.role).toBe('SWE (updated)');
});

test('a re-fill never un-submits an applied row — the correctness point of the upsert', () => {
  const db = makeDb();
  const row = insertApplication(db, { company: 'Acme', url: URL }, noQueue);
  updateApplicationStatus(db, row.id, { status: 'applied' });

  // A later fill of the same posting arrives with the pre-submit default.
  const refilled = insertApplication(db, { company: 'Acme', url: URL }, noQueue);
  expect(refilled.status).toBe('applied');
});

test('a re-fill does not clobber hand-written notes', () => {
  const db = makeDb();
  const row = insertApplication(db, { company: 'Acme', url: URL }, noQueue);
  updateApplicationStatus(db, row.id, { notes: 'referred by sam' });

  const refilled = insertApplication(db, { company: 'Acme', url: URL }, noQueue);
  expect(refilled.notes).toBe('referred by sam');
});

test('cost_usd accumulates across fills — each attempt really did spend', () => {
  const db = makeDb();
  insertApplication(db, { company: 'Acme', url: URL, cost_usd: 0.02 }, noQueue);
  const second = insertApplication(db, { company: 'Acme', url: URL, cost_usd: 0.03 }, noQueue);
  expect(second.cost_usd).toBeCloseTo(0.05, 5);
});

test('an empty value on a re-fill leaves the stored one alone rather than blanking it', () => {
  const db = makeDb();
  insertApplication(db, { company: 'Acme', url: URL, jd: 'the description', resume_path: '/r.pdf' }, noQueue);
  const second = insertApplication(db, { company: 'Acme', url: URL }, noQueue);
  expect(second.jd).toBe('the description');
  expect(second.resume_path).toBe('/r.pdf');
});

test('url-less applications stay plural — the index is partial on purpose', () => {
  const db = makeDb();
  insertApplication(db, { company: 'Acme' }, noQueue);
  insertApplication(db, { company: 'Beta' }, noQueue);
  expect((db.query("SELECT COUNT(*) c FROM applications WHERE url = ''").get() as { c: number }).c).toBe(2);
});

test('the partial unique index exists after createApplicationsTable', () => {
  const db = makeDb();
  const idx = db
    .query("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name='idx_applications_url'")
    .get() as { c: number };
  expect(idx.c).toBe(1);
});

// CR-02 (review 2): company and role were the two upserted columns WITHOUT the
// never-replace-a-real-value-with-a-placeholder guard the others had. That was
// destructive: extension/background.js sends `role: mapping.role || ''` and a
// missing company defaults to 'unknown' in insertApplication, so a re-fill that
// could not read them off the page overwrote good stored values.

test('a re-fill missing company/role does not overwrite the stored ones', () => {
  const db = makeDb();
  insertApplication(db, { company: 'Acme Corp', role: 'Senior SWE', url: URL }, noQueue);
  const refilled = insertApplication(db, { url: URL }, noQueue);
  expect(refilled.company).toBe('Acme Corp');
  expect(refilled.role).toBe('Senior SWE');
});

test("the 'unknown' company placeholder never replaces a real company", () => {
  const db = makeDb();
  insertApplication(db, { company: 'Acme Corp', url: URL }, noQueue);
  const refilled = insertApplication(db, { company: 'unknown', url: URL }, noQueue);
  expect(refilled.company).toBe('Acme Corp');
});

test('a re-fill WITH better company/role still updates them', () => {
  const db = makeDb();
  insertApplication(db, { company: 'unknown', role: '', url: URL }, noQueue);
  const refilled = insertApplication(db, { company: 'Acme Corp', role: 'Senior SWE', url: URL }, noQueue);
  expect(refilled.company).toBe('Acme Corp');
  expect(refilled.role).toBe('Senior SWE');
});

// ── map_source / map_fallback_reason (T-999.1) ────────────────────────────────

test('insertApplication with map_source: haiku and a reason round-trips both values', () => {
  const db = makeDb();
  const row = insertApplication(db, { company: 'Acme', map_source: 'haiku', map_fallback_reason: 'helper timed out' }, noQueue);
  expect(row.map_source).toBe('haiku');
  expect(row.map_fallback_reason).toBe('helper timed out');
});

test('insertApplication with map_source: helper stores it with an empty reason', () => {
  const db = makeDb();
  const row = insertApplication(db, { company: 'Acme', map_source: 'helper' }, noQueue);
  expect(row.map_source).toBe('helper');
  expect(row.map_fallback_reason).toBe('');
});

test('an out-of-allowlist map_source coerces to empty string instead of throwing', () => {
  const db = makeDb();
  const row = insertApplication(
    db,
    { company: 'Acme', map_source: 'x"><img src=x onerror=alert(1)>', map_fallback_reason: 'irrelevant' },
    noQueue,
  );
  expect(row.map_source).toBe('');
});

test('insertApplication with no map_source key stores empty strings for both columns', () => {
  const db = makeDb();
  const row = insertApplication(db, { company: 'Acme' }, noQueue);
  expect(row.map_source).toBe('');
  expect(row.map_fallback_reason).toBe('');
});

test('upsert haiku-then-helper: a helper re-fill overwrites the source AND clears the stale reason', () => {
  const db = makeDb();
  insertApplication(db, { company: 'Acme', url: URL, map_source: 'haiku', map_fallback_reason: 'helper timed out' }, noQueue);
  const refilled = insertApplication(db, { company: 'Acme', url: URL, map_source: 'helper' }, noQueue);
  expect(refilled.map_source).toBe('helper');
  expect(refilled.map_fallback_reason).toBe('');
});

test('upsert provenance-then-none: a re-fill with no map_source leaves both columns at their prior values', () => {
  const db = makeDb();
  insertApplication(db, { company: 'Acme', url: URL, map_source: 'haiku', map_fallback_reason: 'helper timed out' }, noQueue);
  const refilled = insertApplication(db, { company: 'Acme', url: URL }, noQueue);
  expect(refilled.map_source).toBe('haiku');
  expect(refilled.map_fallback_reason).toBe('helper timed out');
});

test('a map_fallback_reason longer than MAX_TEXT is truncated to exactly MAX_TEXT characters', () => {
  const db = makeDb();
  const row = insertApplication(
    db,
    { company: 'Acme', map_source: 'haiku', map_fallback_reason: 'x'.repeat(MAX_TEXT + 100) },
    noQueue,
  );
  expect(row.map_fallback_reason.length).toBe(MAX_TEXT);
});
