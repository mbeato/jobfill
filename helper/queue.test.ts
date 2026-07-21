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

test('listQueue returns rows newest first', () => {
  const db = makeDb();
  const a = insertQueueEntry(db, 'https://x.com/a');
  const b = insertQueueEntry(db, 'https://x.com/b');
  const rows = listQueue(db);
  expect(rows[0].id).toBe(b.id);
  expect(rows[1].id).toBe(a.id);
});
