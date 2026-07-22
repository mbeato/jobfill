import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createPostingsTable, upsertPosting } from './postings';
import { createQueueTable } from '../queue';
import { promotePosting } from './promote';
import type { NormalizedPosting } from './types';

function makeDb(): Database {
  const db = new Database(':memory:');
  createPostingsTable(db);
  createQueueTable(db);
  // Minimal mirror of helper/server.ts's applications table — id/company/url
  // columns suffice for the tracker linear-scan dedupe check.
  db.run(`CREATE TABLE applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company TEXT NOT NULL,
    url TEXT DEFAULT ''
  )`);
  return db;
}

function posting(overrides: Partial<NormalizedPosting> = {}): NormalizedPosting {
  return {
    company: 'Acme',
    title: 'Fullstack SWE',
    location: 'New York, NY',
    url: 'https://boards.greenhouse.io/acme/jobs/1',
    source: 'greenhouse',
    posted_at: '2026-07-20',
    posted_at_trusted: true,
    login_gated: false,
    ...overrides,
  };
}

test('conservation: login_gated/not_fillable/url_key/company/role travel from the source posting onto the queue row unchanged', () => {
  const db = makeDb();
  const row = upsertPosting(db, posting({ login_gated: true, not_fillable: true }))!;
  const result = promotePosting(db, row);
  expect(result.promoted).toBe(true);
  const queueRow = db.query('SELECT * FROM queue WHERE id = ?').get(result.queueRow!.id) as {
    login_gated: number;
    not_fillable: number;
    url_key: string;
    company: string;
    role: string;
  };
  expect(queueRow.login_gated).toBe(1);
  expect(queueRow.not_fillable).toBe(1);
  expect(queueRow.url_key).toBe('boards.greenhouse.io/acme/jobs/1');
  expect(queueRow.company).toBe('Acme');
  expect(queueRow.role).toBe('Fullstack SWE');
});

test('queue dedupe: promoting the same posting twice inserts exactly one queue row; the second call reports dedupe:queue', () => {
  const db = makeDb();
  const row = upsertPosting(db, posting())!;
  const first = promotePosting(db, row);
  expect(first.promoted).toBe(true);
  const second = promotePosting(db, row);
  expect(second.promoted).toBe(false);
  expect(second.reason).toBe('dedupe:queue');
  const rows = db.query('SELECT count(*) as c FROM queue').get() as { c: number };
  expect(rows.c).toBe(1);
});

test('tracker dedupe: a posting whose normalized URL already exists in applications is never queued', () => {
  const db = makeDb();
  const row = upsertPosting(db, posting())!;
  db.query(`INSERT INTO applications (company, url) VALUES (?, ?)`).run(
    'Acme',
    'https://boards.greenhouse.io/acme/jobs/1?utm=x',
  );
  const result = promotePosting(db, row);
  expect(result.promoted).toBe(false);
  expect(result.reason).toBe('dedupe:tracker');
  const rows = db.query('SELECT count(*) as c FROM queue').get() as { c: number };
  expect(rows.c).toBe(0);
});

test('scheme guard: a non-http(s) posting URL is never promoted', () => {
  const db = makeDb();
  const row = upsertPosting(db, posting())!;
  // Simulate a posting row whose url has drifted from the allowlist (defense
  // in depth re-check at the promotion boundary itself).
  const tampered = { ...row, url: 'javascript:alert(1)' };
  const result = promotePosting(db, tampered);
  expect(result.promoted).toBe(false);
  expect(result.reason).toBe('dedupe:invalid-url');
  const rows = db.query('SELECT count(*) as c FROM queue').get() as { c: number };
  expect(rows.c).toBe(0);
});

test('an XSS-shaped company string is stored inert (bounded text, never executed) and travels through unchanged', () => {
  const db = makeDb();
  const xssCompany = '<img src=x onerror=alert(1)>';
  const row = upsertPosting(db, posting({ company: xssCompany }))!;
  const result = promotePosting(db, row);
  expect(result.promoted).toBe(true);
  const queueRow = db.query('SELECT company FROM queue WHERE id = ?').get(result.queueRow!.id) as { company: string };
  expect(queueRow.company).toBe(xssCompany);
});
