import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createPostingsTable,
  upsertPosting,
  listPostings,
  recordDecision,
  listPostingsToDecide,
  storePostingJD,
  resolveStoredJD,
  DECISION_VALUES,
} from './postings';
import { createQueueTable, insertQueueEntryFromPosting } from '../queue';
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

test('recordDecision (D-13) writes decision/decision_reason/decided_at and returns the updated row', () => {
  const db = makeDb();
  const row = upsertPosting(db, posting())!;
  expect(row.decision).toBeNull();
  const updated = recordDecision(db, row.id, 'rejected', 'rules:yoe');
  expect(updated!.decision).toBe('rejected');
  expect(updated!.decision_reason).toBe('rules:yoe');
  expect(updated!.decided_at).not.toBeNull();
});

test('recordDecision throws on a decision value outside the allowlist', () => {
  const db = makeDb();
  const row = upsertPosting(db, posting())!;
  expect(() => recordDecision(db, row.id, 'maybe', 'rules:yoe')).toThrow();
  expect(DECISION_VALUES.has('queued')).toBe(true);
  expect(DECISION_VALUES.has('rejected')).toBe(true);
  expect(DECISION_VALUES.has('held')).toBe(true);
  expect(DECISION_VALUES.has('maybe')).toBe(false);
});

test('recordDecision slices an overlong/XSS-shaped reason to MAX_TEXT before write', () => {
  const db = makeDb();
  const row = upsertPosting(db, posting())!;
  const longReason = `<img src=x onerror=alert(1)>${'x'.repeat(5000)}`;
  const updated = recordDecision(db, row.id, 'held', longReason);
  expect(updated!.decision_reason!.length).toBe(2000);
});

test('listPostingsToDecide returns rows source-interleaved by rank (D-01/D-02), honors the decision filter, and limit selects across sources not just the head of the largest source', () => {
  const db = makeDb();
  // A deliberately skewed backlog: 4 greenhouse, 1 lever, 2 yc. Under the old
  // FIFO-on-fetched_at ordering all four greenhouse rows would return before
  // the lever/yc rows — that is the exact starvation D-01/D-02 fix.
  const gh1 = upsertPosting(db, posting({ url: 'https://boards.greenhouse.io/acme/jobs/1', source: 'greenhouse' }))!;
  const gh2 = upsertPosting(db, posting({ url: 'https://boards.greenhouse.io/acme/jobs/2', source: 'greenhouse' }))!;
  const gh3 = upsertPosting(db, posting({ url: 'https://boards.greenhouse.io/acme/jobs/3', source: 'greenhouse' }))!;
  const gh4 = upsertPosting(db, posting({ url: 'https://boards.greenhouse.io/acme/jobs/4', source: 'greenhouse' }))!;
  const lever1 = upsertPosting(db, posting({ url: 'https://jobs.lever.co/acme/1', source: 'lever' }))!;
  const yc1 = upsertPosting(db, posting({ url: 'https://www.workatastartup.com/jobs/1', source: 'yc' }))!;
  const yc2 = upsertPosting(db, posting({ url: 'https://www.workatastartup.com/jobs/2', source: 'yc' }))!;

  // Force fetched_at so every greenhouse row is strictly older than the lever
  // row, which is strictly older than both yc rows — the old FIFO ordering
  // would have returned all four greenhouse rows before lever/yc ever appeared.
  db.query(`UPDATE postings SET fetched_at = datetime('now', '-70 minute') WHERE id = ?`).run(gh1.id);
  db.query(`UPDATE postings SET fetched_at = datetime('now', '-60 minute') WHERE id = ?`).run(gh2.id);
  db.query(`UPDATE postings SET fetched_at = datetime('now', '-50 minute') WHERE id = ?`).run(gh3.id);
  db.query(`UPDATE postings SET fetched_at = datetime('now', '-40 minute') WHERE id = ?`).run(gh4.id);
  db.query(`UPDATE postings SET fetched_at = datetime('now', '-30 minute') WHERE id = ?`).run(lever1.id);
  db.query(`UPDATE postings SET fetched_at = datetime('now', '-20 minute') WHERE id = ?`).run(yc1.id);
  db.query(`UPDATE postings SET fetched_at = datetime('now', '-10 minute') WHERE id = ?`).run(yc2.id);

  // 09-D-14: no decided row is revived by the ordering change.
  const held = upsertPosting(db, posting({ url: 'https://boards.greenhouse.io/acme/jobs/held', source: 'greenhouse' }))!;
  const queued = upsertPosting(db, posting({ url: 'https://boards.greenhouse.io/acme/jobs/queued', source: 'greenhouse' }))!;
  recordDecision(db, held.id, 'held', 'llm:hold-for-retry');
  recordDecision(db, queued.id, 'queued', 'llm:relevant');

  const rows = listPostingsToDecide(db);
  const ids = rows.map(r => r.id);

  // Interleave: greenhouse#1, lever#1, yc#1, greenhouse#2, yc#2, greenhouse#3,
  // greenhouse#4 — rank is the primary key, and a source drops out of the
  // rotation once exhausted while the larger source absorbs the remainder.
  expect(ids).toEqual([gh1.id, lever1.id, yc1.id, gh2.id, yc2.id, gh3.id, gh4.id, held.id]);
  expect(ids).not.toContain(queued.id);
  expect(ids).toContain(held.id);

  // D-02's own defect being guarded against: limit must be applied AFTER the
  // interleave, so it selects one row per source rather than the head of the
  // largest source's queue.
  const limited = listPostingsToDecide(db, 3);
  expect(limited.map(r => r.id)).toEqual([gh1.id, lever1.id, yc1.id]);

  // Within greenhouse, ascending fetched_at order is preserved.
  const ghRows = rows.filter(r => r.source === 'greenhouse');
  expect(ghRows.map(r => r.id)).toEqual([gh1.id, gh2.id, gh3.id, gh4.id, held.id]);
});

test('upsertPosting re-run on a decided posting never clobbers decision/decision_reason/decided_at (D-14)', () => {
  const db = makeDb();
  const row = upsertPosting(db, posting())!;
  const decided = recordDecision(db, row.id, 'rejected', 'rules:location')!;
  const reupserted = upsertPosting(db, posting({ company: 'Acme Renamed' }))!;
  expect(reupserted.decision).toBe('rejected');
  expect(reupserted.decision_reason).toBe('rules:location');
  expect(reupserted.decided_at).toBe(decided.decided_at);
  expect(reupserted.company).toBe('Acme Renamed');
});

// --- D-10 precedence ---

test('precedence: a trusted-date row survives a later untrusted re-upsert on the same url_key; company travels with source, title still refreshes', () => {
  const db = makeDb();
  const url = 'https://boards.greenhouse.io/acme/jobs/1';
  upsertPosting(
    db,
    posting({ url, source: 'ashby', posted_at: '2026-07-01T00:00:00Z', posted_at_trusted: true }),
  );
  const second = upsertPosting(
    db,
    posting({
      url,
      source: 'simplify',
      posted_at: '2026-07-24T00:00:00Z',
      posted_at_trusted: false,
      company: 'Acme Renamed',
      title: 'Renamed Title',
    }),
  )!;
  expect(second.source).toBe('ashby');
  expect(second.posted_at).toBe('2026-07-01T00:00:00Z');
  expect(second.posted_at_trusted).toBe(true);
  // company travels with source: for ATS sources it is the board TOKEN that
  // fetchAshbyJD/fetchGreenhouseJD interpolate into the JD API path, not a
  // display name. Letting the aggregator's human-readable name win here is
  // what stranded 262 live greenhouse rows in held:jd-fetch-error.
  expect(second.company).toBe('Acme');
  // title/location are display+filter only, never interpolated into a URL,
  // so they still take the newer value.
  expect(second.title).toBe('Renamed Title');
});

test('precedence: an untrusted row first, then a trusted row on the same url_key — the trusted row wins', () => {
  const db = makeDb();
  const url = 'https://boards.greenhouse.io/acme/jobs/2';
  upsertPosting(
    db,
    posting({ url, source: 'simplify', posted_at: '2026-07-24T00:00:00Z', posted_at_trusted: false }),
  );
  const second = upsertPosting(
    db,
    posting({ url, source: 'ashby', posted_at: '2026-07-01T00:00:00Z', posted_at_trusted: true }),
  )!;
  expect(second.source).toBe('ashby');
  expect(second.posted_at).toBe('2026-07-01T00:00:00Z');
  expect(second.posted_at_trusted).toBe(true);
});

test('precedence: a directly-polled greenhouse row keeps its source when an aggregator re-discovers it', () => {
  const db = makeDb();
  const url = 'https://boards.greenhouse.io/acme/jobs/3';
  upsertPosting(db, posting({ url, source: 'greenhouse', posted_at_trusted: false }));
  const second = upsertPosting(db, posting({ url, source: 'simplify', posted_at_trusted: false }))!;
  expect(second.source).toBe('greenhouse');
});

test('precedence: a greenhouse board TOKEN survives an aggregator re-discovery carrying a display name', () => {
  // Reproduces the live defect. The test above could not catch it because both
  // upserts used the same default company; the whole failure is that the two
  // sources disagree about what `company` means. Greenhouse stores the board
  // token (normalizeGreenhouseJob -> `company: token`); SimplifyJobs stores a
  // human-readable name. fetchGreenhouseJD interpolates company into
  // boards-api.greenhouse.io/v1/boards/<company>/jobs/<id>, so a clobbered
  // value is a permanent 404 and a permanent held:jd-fetch-error.
  const db = makeDb();
  const url = 'https://boards.greenhouse.io/buyersedge/jobs/4';
  upsertPosting(db, posting({ url, source: 'greenhouse', company: 'buyersedge', posted_at_trusted: false }));
  const second = upsertPosting(
    db,
    posting({ url, source: 'simplify', company: 'Buyers Edge Platform', posted_at_trusted: false }),
  )!;
  expect(second.source).toBe('greenhouse');
  expect(second.company).toBe('buyersedge');
});

test('precedence: an aggregator-owned row still accepts a company refresh from another aggregator', () => {
  // The guard must not over-apply: when no directly-polled source owns the row,
  // there is no board token to protect and the newer value should win.
  const db = makeDb();
  const url = 'https://jobs.smartrecruiters.com/acme/5';
  upsertPosting(db, posting({ url, source: 'simplify', company: 'Acme Inc', posted_at_trusted: false }));
  const second = upsertPosting(
    db,
    posting({ url, source: 'getro', company: 'Acme Incorporated', posted_at_trusted: false }),
  )!;
  expect(second.company).toBe('Acme Incorporated');
});

test('preserves: login_gated still only ratchets up and a prior decision still survives after the D-10 change', () => {
  const db = makeDb();
  const url = 'https://www.workatastartup.com/jobs/456';
  const first = upsertPosting(db, posting({ url, source: 'yc', login_gated: true }))!;
  const second = upsertPosting(db, posting({ url, source: 'hn', login_gated: false }))!;
  expect(second.login_gated).toBe(true);

  const decisionRow = upsertPosting(db, posting({ url: 'https://boards.greenhouse.io/acme/jobs/4' }))!;
  const decided = recordDecision(db, decisionRow.id, 'rejected', 'rules:location')!;
  const reupserted = upsertPosting(
    db,
    posting({ url: 'https://boards.greenhouse.io/acme/jobs/4', source: 'simplify', posted_at_trusted: false }),
  )!;
  expect(reupserted.decision).toBe('rejected');
  expect(reupserted.decision_reason).toBe('rules:location');
  expect(reupserted.decided_at).toBe(decided.decided_at);
});

test('the new sources still hit the existing write-boundary guards: scheme allowlist and MAX_TEXT truncation', () => {
  const db = makeDb();
  const rejected = upsertPosting(
    db,
    posting({ source: 'simplify', url: "javascript:alert(1)//'/job/'", posted_at_trusted: false }),
  );
  expect(rejected).toBeNull();
  const rows = db.query('SELECT count(*) as c FROM postings').get() as { c: number };
  expect(rows.c).toBe(0);

  const longTitle = 'x'.repeat(5000);
  const stored = upsertPosting(
    db,
    posting({
      source: 'getro',
      url: 'https://jobs.uncorkcapital.com/apply/1',
      title: longTitle,
      posted_at_trusted: false,
    }),
  )!;
  expect(stored.title.length).toBe(2000);
});

// The tailor's JD used to come only from the extension's page scrape. The sweep
// already fetched a clean one from the ATS detail API, so prefer that when the
// fill is working a queue row that traces back to a posting. Joined on url_key
// rather than the fill url: applications.url is the APPLY route
// (…/{id}/application, …/embed/job_app?…) and normalizeUrl keeps the path and
// drops the query, so it never equals the canonical posting key.
test('resolveStoredJD: returns the posting jd for a queue row that shares its url_key', () => {
  const db = makeDb();
  createQueueTable(db);
  const row = upsertPosting(db, posting())!;
  storePostingJD(db, row.id, 'the real description');
  const q = insertQueueEntryFromPosting(db, { ...row, jd: '' } as never)!;
  expect(resolveStoredJD(db, q.id)).toBe('the real description');
});

test('resolveStoredJD: returns empty for an unknown queue id, and for a queue row with no matching posting', () => {
  const db = makeDb();
  createQueueTable(db);
  expect(resolveStoredJD(db, 999)).toBe('');
  db.query(`INSERT INTO queue (url, url_key) VALUES ('https://example.com/x', 'example.com/x')`).run();
  const orphan = db.query('SELECT id FROM queue').get() as { id: number };
  expect(resolveStoredJD(db, orphan.id)).toBe('');
});
