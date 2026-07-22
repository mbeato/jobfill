import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createQueueTable, insertQueueEntry, updateQueueStatus, listQueue, QUEUE_STATUSES, insertQueueEntryFromPosting } from './queue';
import { createPostingsTable, upsertPosting } from './seek/postings';
import type { NormalizedPosting } from './seek/types';

function posting(overrides: Partial<NormalizedPosting> = {}) {
  return {
    company: 'Acme',
    title: 'Fullstack SWE',
    location: 'New York, NY',
    url: 'https://boards.greenhouse.io/acme/jobs/1',
    source: 'greenhouse' as const,
    posted_at: '2026-07-20',
    posted_at_trusted: true,
    login_gated: false,
    ...overrides,
  };
}

function makeDb(): Database {
  const db = new Database(':memory:');
  createQueueTable(db);
  return db;
}

test('createQueueTable creates a table that supports insert+select', () => {
  const db = makeDb();
  db.run(`INSERT INTO queue (url) VALUES ('https://x.com/job')`);
  const rows = db.query('SELECT * FROM queue').all();
  expect(rows.length).toBe(1);
});

test('QUEUE_STATUSES contains exactly the six lifecycle values', () => {
  expect([...QUEUE_STATUSES].sort()).toEqual(['failed', 'filled', 'filling', 'queued', 'reviewed', 'submitted']);
});

test('insertQueueEntry defaults status to queued', () => {
  const db = makeDb();
  const row = insertQueueEntry(db, 'https://boards.greenhouse.io/acme/jobs/1');
  expect(row.status).toBe('queued');
  expect(row.url).toBe('https://boards.greenhouse.io/acme/jobs/1');
});

test('updateQueueStatus accepts submitted as a valid allowlist value', () => {
  const db = makeDb();
  const row = insertQueueEntry(db, 'https://x.com/job');
  const updated = updateQueueStatus(db, row.id, { status: 'submitted' });
  expect(updated?.status).toBe('submitted');
});

test('updateQueueStatus rejects an XSS-shaped status and leaves prior status unchanged', () => {
  const db = makeDb();
  const row = insertQueueEntry(db, 'https://x.com/job');
  expect(() => updateQueueStatus(db, row.id, { status: 'x"><img src=x onerror=alert(1)>' })).toThrow();
  const rows = listQueue(db);
  expect(rows[0].status).toBe('queued');
});

test('results_summary above the old 2k bound is stored intact as valid JSON', () => {
  const db = makeDb();
  const row = insertQueueEntry(db, 'https://x.com/job');
  // ~40 fields at ~100 chars each — a typical Greenhouse form, well past 2,000 chars
  const results = Array.from({ length: 40 }, (_, i) => ({
    id: `0:field-${i}`, status: 'filled', kind: 'profile', confidence: 'high', reused: false,
    label: `A realistically long field label for question number ${i} on the application form`,
  }));
  const updated = updateQueueStatus(db, row.id, { results_summary: JSON.stringify(results) });
  expect(JSON.parse(updated!.results_summary)).toEqual(results);
});

test('results_summary above MAX_SUMMARY is truncated structurally, never mid-JSON', () => {
  const db = makeDb();
  const row = insertQueueEntry(db, 'https://x.com/job');
  const results = Array.from({ length: 300 }, (_, i) => ({
    id: `0:field-${i}`, status: 'filled', kind: 'essay', confidence: 'high', reused: false,
    label: 'x'.repeat(40),
    // field 1 is a didn't-stick field: status stays 'filled', stuck === false is
    // the ONLY didn't-stick signal — it must survive structural truncation
    ...(i === 1 ? { stuck: false } : {}),
  }));
  const updated = updateQueueStatus(db, row.id, { results_summary: JSON.stringify(results) });
  const parsed = JSON.parse(updated!.results_summary); // must not throw
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed.length).toBeLessThanOrEqual(200);
  expect(parsed[0]).toEqual({ id: '0:field-0', status: 'filled', label: 'x'.repeat(40) });
  expect(parsed[1]).toEqual({ id: '0:field-1', status: 'filled', label: 'x'.repeat(40), stuck: false });
});

test('a run-state patch never regresses a human-set reviewed/submitted row', () => {
  const db = makeDb();
  const row = insertQueueEntry(db, 'https://x.com/job');
  updateQueueStatus(db, row.id, { status: 'submitted' });
  const after = updateQueueStatus(db, row.id, { status: 'filled', error: 'late finish' });
  expect(after?.status).toBe('submitted');
  expect(after?.error).toBe(''); // whole write skipped, not just the status column
  // forward, human-driven transitions still work
  const reviewed = insertQueueEntry(db, 'https://x.com/job2');
  updateQueueStatus(db, reviewed.id, { status: 'filled' });
  expect(updateQueueStatus(db, reviewed.id, { status: 'reviewed' })?.status).toBe('reviewed');
});

test('listQueue returns rows newest first', () => {
  const db = makeDb();
  const a = insertQueueEntry(db, 'https://x.com/a');
  const b = insertQueueEntry(db, 'https://x.com/b');
  const rows = listQueue(db);
  expect(rows[0].id).toBe(b.id);
  expect(rows[1].id).toBe(a.id);
});

function makePostingsDb(): Database {
  const db = new Database(':memory:');
  createQueueTable(db);
  createPostingsTable(db);
  return db;
}

test('insertQueueEntryFromPosting (D-10) maps posting fields onto a queued row', () => {
  const db = makePostingsDb();
  const p = upsertPosting(db, posting())!;
  const row = insertQueueEntryFromPosting(db, p);
  expect(row!.status).toBe('queued');
  expect(row!.company).toBe('Acme');
  expect(row!.role).toBe('Fullstack SWE');
  expect(row!.url_key).toBe('boards.greenhouse.io/acme/jobs/1');
});

test('a second insertQueueEntryFromPosting with the same url_key returns null (D-11 dedupe), first row untouched', () => {
  const db = makePostingsDb();
  const p = upsertPosting(db, posting())!;
  const first = insertQueueEntryFromPosting(db, p);
  const second = insertQueueEntryFromPosting(db, p);
  expect(second).toBeNull();
  const rows = listQueue(db);
  expect(rows.length).toBe(1);
  expect(rows[0].id).toBe(first!.id);
});

test('insertQueueEntryFromPosting rejects a non-http(s) posting url', () => {
  const db = makePostingsDb();
  const p = { ...upsertPosting(db, posting())!, url: 'javascript:alert(1)' };
  expect(insertQueueEntryFromPosting(db, p)).toBeNull();
});

test('insertQueueEntryFromPosting carries login_gated/not_fillable through as 1 (D-10)', () => {
  const db = makePostingsDb();
  const p = upsertPosting(
    db,
    posting({ url: 'https://www.workatastartup.com/jobs/123', source: 'yc', login_gated: true, not_fillable: true }),
  )!;
  const row = insertQueueEntryFromPosting(db, p);
  expect(row!.login_gated).toBe(1);
  expect(row!.not_fillable).toBe(1);
});

test('legacy insertQueueEntry rows (NULL url_key) coexist with each other under the UNIQUE constraint', () => {
  const db = makeDb();
  const a = insertQueueEntry(db, 'https://x.com/a');
  const b = insertQueueEntry(db, 'https://x.com/b');
  const rows = listQueue(db);
  expect(rows.length).toBe(2);
  expect(a.id).not.toBe(b.id);
});
