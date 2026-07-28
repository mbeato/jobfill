import { test, expect, describe } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createQueueTable, insertQueueEntry, updateQueueStatus, deleteQueueEntry, listQueue, QUEUE_STATUSES, insertQueueEntryFromPosting } from './queue';
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

// WR-03: low_confidence (hn.ts's non-conforming-comment flag, D-08) must
// survive the promotion boundary into queue — it's the signal that warns
// the operator to double-check the company/role guess before filling.
test('insertQueueEntryFromPosting carries low_confidence through as 1 (WR-03)', () => {
  const db = makePostingsDb();
  const p = upsertPosting(
    db,
    posting({ url: 'https://news.ycombinator.com/item?id=123', source: 'hn', low_confidence: true }),
  )!;
  const row = insertQueueEntryFromPosting(db, p);
  expect(row!.low_confidence).toBe(1);
});

test('insertQueueEntryFromPosting defaults low_confidence to 0 when unset', () => {
  const db = makePostingsDb();
  const p = upsertPosting(db, posting())!;
  const row = insertQueueEntryFromPosting(db, p);
  expect(row!.low_confidence).toBe(0);
});

test('legacy insertQueueEntry rows (NULL url_key) coexist with each other under the UNIQUE constraint', () => {
  const db = makeDb();
  const a = insertQueueEntry(db, 'https://x.com/a');
  const b = insertQueueEntry(db, 'https://x.com/b');
  const rows = listQueue(db);
  expect(rows.length).toBe(2);
  expect(a.id).not.toBe(b.id);
});

describe('deleteQueueEntry', () => {
  test('deletes a queued row', () => {
    const db = makeDb();
    const row = insertQueueEntry(db, 'https://example.com/job');
    const result = deleteQueueEntry(db, row.id);
    expect(result.deleted).toBe(true);
    expect(db.query('SELECT * FROM queue WHERE id = ?').get(row.id)).toBeNull();
  });

  test('refuses to delete a filling row', () => {
    const db = makeDb();
    const row = insertQueueEntry(db, 'https://example.com/job2');
    updateQueueStatus(db, row.id, { status: 'filling' });
    const result = deleteQueueEntry(db, row.id);
    expect(result.deleted).toBe(false);
    expect(result.reason).toBe('fill in progress');
    expect(db.query('SELECT * FROM queue WHERE id = ?').get(row.id)).not.toBeNull();
  });

  test('reports not found for missing rows', () => {
    const db = makeDb();
    expect(deleteQueueEntry(db, 9999)).toEqual({ deleted: false, reason: 'not found' });
  });
});

// ---------------------------------------------------------------------------
// Removal is a decision and has to outlive the row (2026-07-28).
//
// deleteQueueEntry was a bare DELETE: the posting kept decision = 'queued' and
// nothing recorded that the operator had removed it — 37 live postings were in that
// state. Nothing re-promoted them only because the decide loop skips decided
// rows; the day the same job arrives under a different dedup key it returns,
// and the live db already holds 399 posting pairs that are one job under two
// keys.
// ---------------------------------------------------------------------------

describe('removal tombstone', () => {
  function dbWithPosting(overrides = {}) {
    const db = new Database(':memory:');
    createQueueTable(db);
    createPostingsTable(db);
    const p = upsertPosting(db, posting(overrides))!;
    const q = insertQueueEntryFromPosting(db, p)!;
    return { db, p, q };
  }
  const decisionOf = (db: Database, id: number) =>
    db.query('SELECT decision, decision_reason FROM postings WHERE id = ?').get(id) as
      | { decision: string | null; decision_reason: string | null }
      | null;

  test('removing a queued row records a user rejection on its posting', () => {
    const { db, p, q } = dbWithPosting();
    db.query("UPDATE postings SET decision='queued' WHERE id=?").run(p.id);
    expect(deleteQueueEntry(db, q.id).deleted).toBe(true);
    expect(decisionOf(db, p.id)).toEqual({
      decision: 'rejected',
      decision_reason: 'user:removed-from-queue',
    });
  });

  test('the tombstone keeps the decide loop from ever reconsidering it', () => {
    const { db, p, q } = dbWithPosting();
    db.query("UPDATE postings SET decision='queued' WHERE id=?").run(p.id);
    deleteQueueEntry(db, q.id);
    // listPostingsToDecide's predicate, verbatim.
    const again = db
      .query("SELECT count(*) AS n FROM postings WHERE decision IS NULL OR decision = 'held'")
      .get() as { n: number };
    expect(again.n).toBe(0);
  });

  test('an undecided posting is tombstoned too', () => {
    const { db, p, q } = dbWithPosting();
    expect(decisionOf(db, p.id)!.decision).toBeNull();
    deleteQueueEntry(db, q.id);
    expect(decisionOf(db, p.id)!.decision).toBe('rejected');
  });

  test('an existing rejection keeps its original reason', () => {
    const { db, p, q } = dbWithPosting();
    db.query("UPDATE postings SET decision='rejected', decision_reason='rules:location' WHERE id=?").run(p.id);
    deleteQueueEntry(db, q.id);
    expect(decisionOf(db, p.id)!.decision_reason).toBe('rules:location');
  });

  test('a refused delete writes no tombstone', () => {
    const { db, p, q } = dbWithPosting();
    db.query("UPDATE queue SET status='filling' WHERE id=?").run(q.id);
    expect(deleteQueueEntry(db, q.id).deleted).toBe(false);
    expect(decisionOf(db, p.id)!.decision).toBeNull();
  });

  test('a row with no url_key still tombstones, via the derived key', () => {
    const db = new Database(':memory:');
    createQueueTable(db);
    createPostingsTable(db);
    const p = upsertPosting(db, posting())!;
    db.query("UPDATE postings SET decision='queued' WHERE id=?").run(p.id);
    // A legacy / D-11 collision-duplicate row: same url, url_key left NULL.
    const legacy = db
      .query('INSERT INTO queue (url) VALUES (?) RETURNING *')
      .get('https://boards.greenhouse.io/acme/jobs/1') as { id: number };
    deleteQueueEntry(db, legacy.id);
    expect(decisionOf(db, p.id)!.decision_reason).toBe('user:removed-from-queue');
  });

  test('removing a queue row with no posting behind it does not throw', () => {
    const db = new Database(':memory:');
    createQueueTable(db);
    createPostingsTable(db);
    const row = insertQueueEntry(db, 'https://example.com/manual-add');
    expect(() => deleteQueueEntry(db, row.id)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Manual adds carried no dedup key until the next restart's D-11 backfill.
// ---------------------------------------------------------------------------

describe('manual add keys itself', () => {
  function freshDb() {
    const db = new Database(':memory:');
    createQueueTable(db);
    return db;
  }

  test('insertQueueEntry sets url_key immediately', () => {
    const db = freshDb();
    const row = insertQueueEntry(db, 'https://boards.greenhouse.io/acme/jobs/1?src=email');
    expect(row.url_key).toBe('boards.greenhouse.io/acme/jobs/1');
  });

  test('re-adding the same job is idempotent rather than duplicating', () => {
    const db = freshDb();
    const first = insertQueueEntry(db, 'https://boards.greenhouse.io/acme/jobs/1');
    // Same job, different query string — normalizeUrl drops it.
    const second = insertQueueEntry(db, 'https://boards.greenhouse.io/acme/jobs/1?utm=x');
    expect(second.id).toBe(first.id);
    expect((db.query('SELECT count(*) AS n FROM queue').get() as { n: number }).n).toBe(1);
  });

  test('a re-add never regresses a status already set by hand', () => {
    const db = freshDb();
    const first = insertQueueEntry(db, 'https://boards.greenhouse.io/acme/jobs/1');
    updateQueueStatus(db, first.id, { status: 'submitted' });
    const again = insertQueueEntry(db, 'https://boards.greenhouse.io/acme/jobs/1');
    expect(again.status).toBe('submitted');
  });

  // normalizeUrl falls back to the raw string rather than '' when URL parsing
  // throws, so even an unparseable url gets a stable key and still dedupes.
  // (POST /queue rejects non-http(s) before reaching here anyway.)
  test('an unparseable url still gets a stable key and still dedupes', () => {
    const db = freshDb();
    const row = insertQueueEntry(db, 'not a url');
    expect(row.id).toBeGreaterThan(0);
    expect(row.url_key).toBe('not a url');
    expect(insertQueueEntry(db, 'not a url').id).toBe(row.id);
  });

  test('the tombstone never breaks the delete, even with no postings table', () => {
    const db = freshDb(); // queue only — no postings table
    const row = insertQueueEntry(db, 'https://boards.greenhouse.io/acme/jobs/9');
    expect(deleteQueueEntry(db, row.id)).toEqual({ deleted: true });
    expect((db.query('SELECT count(*) AS n FROM queue').get() as { n: number }).n).toBe(0);
  });
});
