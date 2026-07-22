import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createPostingsTable, upsertPosting, listPostings } from './postings';
import type { NormalizedPosting } from './types';

function makeDb(): Database {
  const db = new Database(':memory:');
  createPostingsTable(db);
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

test('inserting a NormalizedPosting stores source, login_gated, posted_at_trusted, and a normalized url_key', () => {
  const db = makeDb();
  const row = upsertPosting(db, posting());
  expect(row).not.toBeNull();
  expect(row!.source).toBe('greenhouse');
  expect(row!.login_gated).toBe(false);
  expect(row!.posted_at_trusted).toBe(true);
  const raw = db.query('SELECT url_key FROM postings WHERE id = ?').get(row!.id) as { url_key: string };
  expect(raw.url_key).toBe('boards.greenhouse.io/acme/jobs/1');
});

test('re-upserting the same posting (or a query-param variant) leaves exactly one row and refreshes fetched_at', () => {
  const db = makeDb();
  const first = upsertPosting(db, posting());
  // Backdate the stored timestamp so a real refresh must yield a strictly
  // greater value — no sleep, and a no-op ON CONFLICT can no longer pass.
  db.query(`UPDATE postings SET fetched_at = datetime('now', '-1 hour') WHERE id = ?`).run(first!.id);
  const firstFetchedAt = (db.query('SELECT fetched_at FROM postings WHERE id = ?').get(first!.id) as { fetched_at: string }).fetched_at;
  const second = upsertPosting(db, posting({ url: 'https://boards.greenhouse.io/acme/jobs/1?utm=x' }));
  const rows = db.query('SELECT count(*) as c FROM postings').get() as { c: number };
  expect(rows.c).toBe(1);
  const secondFetchedAt = (db.query('SELECT fetched_at FROM postings WHERE id = ?').get(second!.id) as { fetched_at: string }).fetched_at;
  expect(secondFetchedAt > firstFetchedAt).toBe(true);
});

test('a conflicting re-upsert never downgrades login_gated true -> false', () => {
  const db = makeDb();
  const first = upsertPosting(
    db,
    posting({ url: 'https://www.workatastartup.com/jobs/123', source: 'yc', login_gated: true }),
  );
  expect(first!.login_gated).toBe(true);
  // A later sweep stage (e.g. HN finding the same link in a comment) writes
  // login_gated: false — the stored flag must not flip back.
  const second = upsertPosting(
    db,
    posting({ url: 'https://www.workatastartup.com/jobs/123', source: 'hn', login_gated: false }),
  );
  expect(second!.login_gated).toBe(true);
  const rows = db.query('SELECT count(*) as c FROM postings').get() as { c: number };
  expect(rows.c).toBe(1);
});

test('a posting with a source outside the six-source allowlist is skipped, not stored', () => {
  const db = makeDb();
  const row = upsertPosting(db, posting({ source: 'wellfound' as NormalizedPosting['source'] }));
  expect(row).toBeNull();
  const rows = db.query('SELECT count(*) as c FROM postings').get() as { c: number };
  expect(rows.c).toBe(0);
});

test('a posting with an empty/missing url is skipped — URL-less postings must not share one dedup key', () => {
  const db = makeDb();
  expect(upsertPosting(db, posting({ url: '' }))).toBeNull();
  expect(upsertPosting(db, posting({ url: '', company: 'Other Co' }))).toBeNull();
  const rows = db.query('SELECT count(*) as c FROM postings').get() as { c: number };
  expect(rows.c).toBe(0);
});

test('a non-http(s) url is rejected at the persistence boundary, never stored', () => {
  const db = makeDb();
  expect(upsertPosting(db, posting({ url: "javascript:alert(1)//'/job/'" }))).toBeNull();
  expect(upsertPosting(db, posting({ url: 'file:///etc/passwd' }))).toBeNull();
  const rows = db.query('SELECT count(*) as c FROM postings').get() as { c: number };
  expect(rows.c).toBe(0);
});

test('oversized company/title/location text is truncated to MAX_TEXT at the write boundary', () => {
  const db = makeDb();
  const longTitle = 'x'.repeat(5000);
  const row = upsertPosting(db, posting({ title: longTitle }));
  expect(row!.title.length).toBe(2000);
});

test('posted_at is coerced to a bounded string (or null) at the write boundary', () => {
  const db = makeDb();
  const row = upsertPosting(db, posting({ posted_at: 'z'.repeat(500) }));
  expect(row!.posted_at!.length).toBe(64);
  // Remote JSON is untyped — a non-string value must not make the sqlite bind throw.
  const coerced = upsertPosting(
    db,
    posting({ url: 'https://boards.greenhouse.io/acme/jobs/9', posted_at: { nested: true } as unknown as string }),
  );
  expect(typeof coerced!.posted_at).toBe('string');
  const kept = upsertPosting(db, posting({ url: 'https://boards.greenhouse.io/acme/jobs/10', posted_at: null }));
  expect(kept!.posted_at).toBeNull();
});

test('an XSS-shaped title string is stored as inert bounded text, never executed', () => {
  const db = makeDb();
  const xssTitle = '<img src=x onerror=alert(1)>';
  const row = upsertPosting(db, posting({ title: xssTitle }));
  expect(row!.title).toBe(xssTitle);
  const stored = db.query('SELECT title FROM postings WHERE id = ?').get(row!.id) as { title: string };
  expect(stored.title).toBe(xssTitle);
});

test('listPostings returns rows newest-first with boolean flags surfaced', () => {
  const db = makeDb();
  const a = upsertPosting(db, posting({ url: 'https://boards.greenhouse.io/acme/jobs/1' }));
  const b = upsertPosting(db, posting({ url: 'https://boards.greenhouse.io/acme/jobs/2', login_gated: true, not_fillable: true, low_confidence: true }));
  const rows = listPostings(db);
  expect(rows[0].id).toBe(b!.id);
  expect(rows[1].id).toBe(a!.id);
  expect(rows[0].login_gated).toBe(true);
  expect(rows[0].not_fillable).toBe(true);
  expect(rows[0].low_confidence).toBe(true);
  expect(rows[0].posted_at_trusted).toBe(true);
});
