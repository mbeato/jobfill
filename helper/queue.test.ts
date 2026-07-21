import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createQueueTable, insertQueueEntry, updateQueueStatus, listQueue, QUEUE_STATUSES } from './queue';

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
  }));
  const updated = updateQueueStatus(db, row.id, { results_summary: JSON.stringify(results) });
  const parsed = JSON.parse(updated!.results_summary); // must not throw
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed.length).toBeLessThanOrEqual(200);
  expect(parsed[0]).toEqual({ id: '0:field-0', status: 'filled', label: 'x'.repeat(40) });
});

test('listQueue returns rows newest first', () => {
  const db = makeDb();
  const a = insertQueueEntry(db, 'https://x.com/a');
  const b = insertQueueEntry(db, 'https://x.com/b');
  const rows = listQueue(db);
  expect(rows[0].id).toBe(b.id);
  expect(rows[1].id).toBe(a.id);
});
