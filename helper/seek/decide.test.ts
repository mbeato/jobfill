import { test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createPostingsTable, upsertPosting, recordDecision, listPostingsToDecide } from './postings';
import { createQueueTable } from '../queue';
import { promotePosting } from './promote';
import { runFilterPromote, LLM_CAP, type DecideDeps } from './decide';
import { createBoardsTable, upsertBoard } from './boards';
import { classifyBoardGrace } from './filter';
import { compileCriteria, defaultCriteria } from './criteria';
import type { NormalizedPosting } from './types';

function makeDb(): Database {
  const db = new Database(':memory:');
  createPostingsTable(db);
  createQueueTable(db);
  createBoardsTable(db);
  // Minimal mirror of helper/server.ts's applications table (promotePosting's
  // tracker dedupe scan needs it to exist).
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

// Real recordDecision/listPostingsToDecide/promotePosting from the modules
// (per the plan's instruction), stubbed classifyMetadata/classifyYoe/fetchJD/
// scoreRelevance/loadProfileSummary so no network/CLI ever runs.
function baseDeps(overrides: Partial<DecideDeps> = {}): DecideDeps {
  return {
    loadCriteria: () => compileCriteria(defaultCriteria()),
    classifyMetadata: () => ({ reject: false }),
    classifyBoardGrace: () => ({ reject: false }),
    classifyYoe: () => ({ reject: false }),
    fetchJD: async () => 'some jd text',
    scoreRelevance: async () => ({ relevant: true, reason: 'matches profile' }),
    loadProfileSummary: async () => 'profile summary',
    promotePosting,
    recordDecision,
    listPostingsToDecide,
    listAllBoards: () => [],
    ...overrides,
  };
}

const ORIGINAL_CAP = process.env.SEEK_LLM_CAP;
beforeEach(() => {
  delete process.env.SEEK_LLM_CAP;
});
afterEach(() => {
  if (ORIGINAL_CAP === undefined) delete process.env.SEEK_LLM_CAP;
  else process.env.SEEK_LLM_CAP = ORIGINAL_CAP;
});

test('LLM_CAP defaults to 100 when SEEK_LLM_CAP is unset', () => {
  expect(LLM_CAP()).toBe(100);
});

test('LLM_CAP reads a valid numeric SEEK_LLM_CAP', () => {
  process.env.SEEK_LLM_CAP = '5';
  expect(LLM_CAP()).toBe(5);
});

// WR-02: a non-numeric SEEK_LLM_CAP must fail closed to the safe default,
// not silently become NaN (every `>= NaN` comparison is false, which would
// make the cap check never trip and process the entire backlog unbounded).
test('LLM_CAP falls back to 100 on a non-numeric SEEK_LLM_CAP', () => {
  process.env.SEEK_LLM_CAP = 'unlimited';
  expect(LLM_CAP()).toBe(100);
});

test('metadata reject: fetchJD and scoreRelevance are never called, decision is rejected with the rules reason', async () => {
  const db = makeDb();
  const row = upsertPosting(db, posting())!;
  let fetchCalls = 0;
  let scoreCalls = 0;
  const deps = baseDeps({
    classifyMetadata: () => ({ reject: true, reason: 'rules:title' }),
    fetchJD: async () => {
      fetchCalls++;
      return 'jd';
    },
    scoreRelevance: async () => {
      scoreCalls++;
      return { relevant: true, reason: 'x' };
    },
  });

  const counts = await runFilterPromote(db, deps);

  expect(fetchCalls).toBe(0);
  expect(scoreCalls).toBe(0);
  expect(counts.rulesRejected).toBe(1);
  expect(counts.byCriterion.title).toBe(1);
  const stored = db.query('SELECT decision, decision_reason FROM postings WHERE id = ?').get(row.id) as {
    decision: string;
    decision_reason: string;
  };
  expect(stored.decision).toBe('rejected');
  expect(stored.decision_reason).toBe('rules:title');
});

test('happy queue: metadata survives, YOE survives, scoreRelevance relevant, promotePosting promotes -> queued', async () => {
  const db = makeDb();
  const row = upsertPosting(db, posting())!;
  const deps = baseDeps({
    scoreRelevance: async () => ({ relevant: true, reason: 'great fit' }),
  });

  const counts = await runFilterPromote(db, deps);

  expect(counts.queued).toBe(1);
  const stored = db.query('SELECT decision, decision_reason FROM postings WHERE id = ?').get(row.id) as {
    decision: string;
    decision_reason: string;
  };
  expect(stored.decision).toBe('queued');
  expect(stored.decision_reason.startsWith('llm:relevant')).toBe(true);
  const queueRows = db.query('SELECT count(*) as c FROM queue').get() as { c: number };
  expect(queueRows.c).toBe(1);
});

test('LLM not-relevant: scoreRelevance returns relevant:false -> rejected with llm:not-relevant reason', async () => {
  const db = makeDb();
  const row = upsertPosting(db, posting())!;
  const deps = baseDeps({
    scoreRelevance: async () => ({ relevant: false, reason: 'wrong stack' }),
  });

  const counts = await runFilterPromote(db, deps);

  expect(counts.llmRejected).toBe(1);
  expect(counts.byCriterion.llm).toBe(1);
  const stored = db.query('SELECT decision, decision_reason FROM postings WHERE id = ?').get(row.id) as {
    decision: string;
    decision_reason: string;
  };
  expect(stored.decision).toBe('rejected');
  expect(stored.decision_reason.startsWith('llm:not-relevant')).toBe(true);
});

test('YOE reject: fetchJD returns text classifyYoe rejects -> rules:yoe, scoreRelevance not called', async () => {
  const db = makeDb();
  const row = upsertPosting(db, posting())!;
  let scoreCalls = 0;
  const deps = baseDeps({
    classifyYoe: () => ({ reject: true, reason: 'rules:yoe' }),
    scoreRelevance: async () => {
      scoreCalls++;
      return { relevant: true, reason: 'x' };
    },
  });

  const counts = await runFilterPromote(db, deps);

  expect(scoreCalls).toBe(0);
  expect(counts.rulesRejected).toBe(1);
  expect(counts.byCriterion.yoe).toBe(1);
  const stored = db.query('SELECT decision, decision_reason FROM postings WHERE id = ?').get(row.id) as {
    decision: string;
    decision_reason: string;
  };
  expect(stored.decision).toBe('rejected');
  expect(stored.decision_reason).toBe('rules:yoe');
});

test('held on fetch failure: fetchJD throws -> held with reason exactly held:jd-fetch-error, scoreRelevance not called, retried next run', async () => {
  const db = makeDb();
  const row = upsertPosting(db, posting())!;
  let scoreCalls = 0;
  const deps = baseDeps({
    fetchJD: async () => {
      throw new Error('network down');
    },
    scoreRelevance: async () => {
      scoreCalls++;
      return { relevant: true, reason: 'x' };
    },
  });

  const counts = await runFilterPromote(db, deps);

  expect(scoreCalls).toBe(0);
  expect(counts.held).toBe(1);
  const stored = db.query('SELECT decision, decision_reason FROM postings WHERE id = ?').get(row.id) as {
    decision: string;
    decision_reason: string;
  };
  expect(stored.decision).toBe('held');
  expect(stored.decision_reason).toBe('held:jd-fetch-error');
  const queueRows = db.query('SELECT count(*) as c FROM queue').get() as { c: number };
  expect(queueRows.c).toBe(0);

  // Still in the to-decide backlog for a second run.
  const stillToDecide = listPostingsToDecide(db);
  expect(stillToDecide.map(r => r.id)).toContain(row.id);
});

test('held on LLM failure: scoreRelevance throws -> held with reason exactly held:llm-error, retried next run', async () => {
  const db = makeDb();
  const row = upsertPosting(db, posting())!;
  const deps = baseDeps({
    scoreRelevance: async () => {
      throw new Error('CLI timeout');
    },
  });

  const counts = await runFilterPromote(db, deps);

  expect(counts.held).toBe(1);
  const stored = db.query('SELECT decision, decision_reason FROM postings WHERE id = ?').get(row.id) as {
    decision: string;
    decision_reason: string;
  };
  expect(stored.decision).toBe('held');
  expect(stored.decision_reason).toBe('held:llm-error');

  const stillToDecide = listPostingsToDecide(db);
  expect(stillToDecide.map(r => r.id)).toContain(row.id);
});

test('dedupe: promotePosting reports not-promoted -> rejected with the dedupe reason, deduped count 1, not re-scored next run', async () => {
  const db = makeDb();
  const row = upsertPosting(db, posting())!;
  let scoreCalls = 0;
  const deps = baseDeps({
    scoreRelevance: async () => {
      scoreCalls++;
      return { relevant: true, reason: 'great fit' };
    },
    promotePosting: () => ({ promoted: false, reason: 'dedupe:queue' }),
  });

  const counts = await runFilterPromote(db, deps);

  expect(counts.deduped).toBe(1);
  expect(scoreCalls).toBe(1);
  const stored = db.query('SELECT decision, decision_reason FROM postings WHERE id = ?').get(row.id) as {
    decision: string;
    decision_reason: string;
  };
  expect(stored.decision).toBe('rejected');
  expect(stored.decision_reason).toBe('dedupe:queue');

  // Decided (rejected), so a second run must not re-score it (D-14, enforced
  // by listPostingsToDecide).
  const stillToDecide = listPostingsToDecide(db);
  expect(stillToDecide.map(r => r.id)).not.toContain(row.id);
});

test('cap: with LLM_CAP=1 and two metadata-surviving postings, exactly one scoreRelevance call happens; the second stays unscored', async () => {
  process.env.SEEK_LLM_CAP = '1';
  const db = makeDb();
  const a = upsertPosting(db, posting({ url: 'https://boards.greenhouse.io/acme/jobs/1' }))!;
  const b = upsertPosting(db, posting({ url: 'https://boards.greenhouse.io/acme/jobs/2' }))!;
  db.query(`UPDATE postings SET fetched_at = datetime('now', '-1 hour') WHERE id = ?`).run(a.id);
  let scoreCalls = 0;
  const deps = baseDeps({
    scoreRelevance: async () => {
      scoreCalls++;
      return { relevant: true, reason: 'great fit' };
    },
  });

  const counts = await runFilterPromote(db, deps);

  expect(scoreCalls).toBe(1);
  expect(counts.queued).toBe(1);
  expect(counts.unscored).toBe(1);

  const aRow = db.query('SELECT decision FROM postings WHERE id = ?').get(a.id) as { decision: string | null };
  expect(aRow.decision).toBe('queued');
  const bRow = db.query('SELECT decision FROM postings WHERE id = ?').get(b.id) as { decision: string | null };
  expect(bRow.decision).toBeNull();

  const stillToDecide = listPostingsToDecide(db);
  expect(stillToDecide.map((r: { id: number }) => r.id)).toContain(b.id);
});

test('isolation: one posting whose fetchJD throws does not prevent a later posting from being queued in the same run', async () => {
  const db = makeDb();
  const failing = upsertPosting(db, posting({ url: 'https://boards.greenhouse.io/acme/jobs/1' }))!;
  const surviving = upsertPosting(db, posting({ url: 'https://boards.greenhouse.io/acme/jobs/2' }))!;
  db.query(`UPDATE postings SET fetched_at = datetime('now', '-1 hour') WHERE id = ?`).run(failing.id);

  const deps = baseDeps({
    fetchJD: async (p: { id: number }) => {
      if (p.id === failing.id) throw new Error('network down');
      return 'some jd text';
    },
    scoreRelevance: async () => ({ relevant: true, reason: 'great fit' }),
  });

  const counts = await runFilterPromote(db, deps);

  expect(counts.held).toBe(1);
  expect(counts.queued).toBe(1);
  const failingRow = db.query('SELECT decision FROM postings WHERE id = ?').get(failing.id) as { decision: string };
  expect(failingRow.decision).toBe('held');
  const survivingRow = db.query('SELECT decision FROM postings WHERE id = ?').get(surviving.id) as { decision: string };
  expect(survivingRow.decision).toBe('queued');
});

test('login-gated posting: fetchJD and classifyYoe are skipped, LLM judges on metadata-only placeholder JD', async () => {
  const db = makeDb();
  const row = upsertPosting(
    db,
    posting({ login_gated: true, url: 'https://www.workatastartup.com/jobs/999', source: 'yc' }),
  )!;
  let fetchCalls = 0;
  let yoeCalls = 0;
  let seenJd = '';
  const deps = baseDeps({
    fetchJD: async () => {
      fetchCalls++;
      throw new Error('login wall');
    },
    classifyYoe: () => {
      yoeCalls++;
      return { reject: false };
    },
    scoreRelevance: async (_profile, jdText) => {
      seenJd = jdText;
      return { relevant: true, reason: 'metadata fit' };
    },
  });

  const counts = await runFilterPromote(db, deps);

  expect(fetchCalls).toBe(0);
  expect(yoeCalls).toBe(0);
  // Empty jd is the metadata-only signal — guidance lives on relevance.ts's
  // trusted prompt side, never in the untrusted jd slot.
  expect(seenJd).toBe('');
  expect(counts.queued).toBe(1);
  const stored = db.query('SELECT decision FROM postings WHERE id = ?').get(row.id) as { decision: string };
  expect(stored.decision).toBe('queued');
});

// --- Phase 16 follow-up: aggregator sources have no fetchJD branch ----------
// Observed live after the phase-16 sweep: 73 of 81 drained simplify postings
// were stranded in held:jd-fetch-error, because fetchJD throws
// `unsupported source` for every source outside JD_FETCHABLE_SOURCES. Left
// unfixed, every simplify/getro posting is permanently unscoreable.

test('simplify posting: fetchJD/classifyYoe skipped, scored on metadata-only JD instead of held', async () => {
  const db = makeDb();
  const row = upsertPosting(
    db,
    posting({
      source: 'simplify',
      login_gated: false,
      posted_at_trusted: false,
      url: 'https://jobs.smartrecruiters.com/acme/12345',
    }),
  )!;
  let fetchCalls = 0;
  let yoeCalls = 0;
  let seenJd = 'unset';
  const deps = baseDeps({
    fetchJD: async () => {
      fetchCalls++;
      throw new Error('fetchJD: unsupported source simplify');
    },
    classifyYoe: () => {
      yoeCalls++;
      return { reject: false };
    },
    scoreRelevance: async (_profile, jdText) => {
      seenJd = jdText;
      return { relevant: true, reason: 'new grad SWE in NYC' };
    },
  });

  const counts = await runFilterPromote(db, deps);

  expect(fetchCalls).toBe(0);
  expect(yoeCalls).toBe(0);
  expect(seenJd).toBe('');
  expect(counts.held).toBe(0);
  expect(counts.queued).toBe(1);
  const stored = db.query('SELECT decision FROM postings WHERE id = ?').get(row.id) as { decision: string };
  expect(stored.decision).toBe('queued');
});

test('getro posting is also routed to metadata-only scoring', async () => {
  const db = makeDb();
  upsertPosting(
    db,
    posting({ source: 'getro', login_gated: false, posted_at_trusted: false, url: 'https://jobs.craftventures.com/companies/x/jobs/1' }),
  )!;
  let seenJd = 'unset';
  const deps = baseDeps({
    fetchJD: async () => {
      throw new Error('fetchJD: unsupported source getro');
    },
    scoreRelevance: async (_profile, jdText) => {
      seenJd = jdText;
      return { relevant: true, reason: 'seed-stage startup' };
    },
  });

  const counts = await runFilterPromote(db, deps);
  expect(seenJd).toBe('');
  expect(counts.held).toBe(0);
  expect(counts.queued).toBe(1);
});

// --- Phase 17 D-13: grace step, batch board load, and the grace bucket -----

test('grace reject: posting staged within 48h of its board first_seen_at is rejected as rules:board-grace, buckets under grace not stale, and short-circuits before classifyMetadata/fetchJD/scoreRelevance', async () => {
  const db = makeDb();
  const board = upsertBoard(db, { ats: 'greenhouse', token: 'acme', source_of_discovery: 'seed' })!;
  db.query(`UPDATE boards SET first_seen_at = datetime('now', '-2 hours') WHERE id = ?`).run(board.id);
  const row = upsertPosting(db, posting({ company: 'acme' }))!;

  let metaCalls = 0;
  let fetchCalls = 0;
  let scoreCalls = 0;
  const deps = baseDeps({
    classifyBoardGrace,
    listAllBoards: db2 => (db2 === db ? [board] : []),
    classifyMetadata: () => {
      metaCalls++;
      return { reject: false };
    },
    fetchJD: async () => {
      fetchCalls++;
      return 'jd';
    },
    scoreRelevance: async () => {
      scoreCalls++;
      return { relevant: true, reason: 'x' };
    },
  });

  const counts = await runFilterPromote(db, deps);

  expect(metaCalls).toBe(0);
  expect(fetchCalls).toBe(0);
  expect(scoreCalls).toBe(0);
  expect(counts.rulesRejected).toBe(1);
  expect(counts.byCriterion.grace).toBe(1);
  expect(counts.byCriterion.stale).toBe(0);
  const stored = db.query('SELECT decision, decision_reason FROM postings WHERE id = ?').get(row.id) as {
    decision: string;
    decision_reason: string;
  };
  expect(stored.decision).toBe('rejected');
  expect(stored.decision_reason).toBe('rules:board-grace');
});

test('listAllBoards is invoked exactly once per runFilterPromote call regardless of posting count (D-13, no per-posting query)', async () => {
  const db = makeDb();
  upsertPosting(db, posting({ url: 'https://boards.greenhouse.io/acme/jobs/1' }))!;
  upsertPosting(db, posting({ url: 'https://boards.greenhouse.io/acme/jobs/2' }))!;
  upsertPosting(db, posting({ url: 'https://boards.greenhouse.io/acme/jobs/3' }))!;

  let listAllBoardsCalls = 0;
  const deps = baseDeps({
    listAllBoards: () => {
      listAllBoardsCalls++;
      return [];
    },
  });

  await runFilterPromote(db, deps);

  expect(listAllBoardsCalls).toBe(1);
});

test('join miss: a posting whose (source, company) matches no board row receives null as the board argument and proceeds to classifyMetadata rather than being grace-rejected', async () => {
  const db = makeDb();
  const row = upsertPosting(db, posting({ company: 'unmatched-token' }))!;

  let seenBoard: unknown = 'unset';
  let metaCalls = 0;
  const deps = baseDeps({
    classifyBoardGrace: (_p, board) => {
      seenBoard = board;
      return { reject: false };
    },
    classifyMetadata: () => {
      metaCalls++;
      return { reject: false };
    },
  });

  const counts = await runFilterPromote(db, deps);

  expect(seenBoard).toBeNull();
  expect(metaCalls).toBeGreaterThan(0);
  expect(counts.byCriterion.grace).toBe(0);
  const stored = db.query('SELECT decision FROM postings WHERE id = ?').get(row.id) as { decision: string | null };
  expect(stored.decision).not.toBe('rejected');
});

test('a simplify posting (human-readable company, no matching board) proceeds normally; counts.byCriterion.grace stays 0', async () => {
  const db = makeDb();
  upsertPosting(
    db,
    posting({ source: 'simplify', posted_at_trusted: false, company: 'Acme Inc', url: 'https://jobs.smartrecruiters.com/acme/1' }),
  )!;

  const deps = baseDeps({ classifyBoardGrace });

  const counts = await runFilterPromote(db, deps);

  expect(counts.byCriterion.grace).toBe(0);
});

test('D-04: with SEEK_LLM_CAP=0, a classifyMetadata rules:stale rejection is counted even though the LLM stage is never reached', async () => {
  process.env.SEEK_LLM_CAP = '0';
  const db = makeDb();
  upsertPosting(db, posting())!;

  const deps = baseDeps({
    classifyMetadata: () => ({ reject: true, reason: 'rules:stale' }),
  });

  const counts = await runFilterPromote(db, deps);

  expect(counts.byCriterion.stale).toBe(1);
  expect(counts.unscored).toBe(0);
});

test('D-07 finality: a grace-rejected posting re-upserted by a later sweep keeps decision rejected and reason rules:board-grace', async () => {
  const db = makeDb();
  const board = upsertBoard(db, { ats: 'greenhouse', token: 'acme', source_of_discovery: 'seed' })!;
  db.query(`UPDATE boards SET first_seen_at = datetime('now', '-2 hours') WHERE id = ?`).run(board.id);
  const row = upsertPosting(db, posting({ company: 'acme' }))!;

  const deps = baseDeps({
    classifyBoardGrace,
    listAllBoards: () => [board],
  });
  await runFilterPromote(db, deps);

  // Re-discovery upsert (same url_key) — upsertPosting's ON CONFLICT omits
  // decision/decision_reason/decided_at, so the prior verdict must survive.
  upsertPosting(db, posting({ company: 'acme' }))!;

  const stored = db.query('SELECT decision, decision_reason FROM postings WHERE id = ?').get(row.id) as {
    decision: string;
    decision_reason: string;
  };
  expect(stored.decision).toBe('rejected');
  expect(stored.decision_reason).toBe('rules:board-grace');
});

test('counts.byCriterion.grace is present and 0 on a sweep with no grace rejections', async () => {
  const db = makeDb();
  upsertPosting(db, posting())!;

  const counts = await runFilterPromote(db, baseDeps());

  expect(counts.byCriterion.grace).toBe(0);
});

test('a JD-fetchable source keeps held-for-retry semantics: a transient greenhouse failure is NOT metadata-only', async () => {
  // Guard against over-broad fixes. The metadata-only branch is source-
  // structural; an ordinary greenhouse 404 is transient and must still be
  // held for retry rather than silently scored without its JD.
  const db = makeDb();
  const row = upsertPosting(db, posting({ source: 'greenhouse' }))!;
  let scoreCalls = 0;
  const deps = baseDeps({
    fetchJD: async () => {
      throw new Error('fetchJD: greenhouse acme/1 returned HTTP 404');
    },
    scoreRelevance: async () => {
      scoreCalls++;
      return { relevant: true, reason: 'should never be reached' };
    },
  });

  const counts = await runFilterPromote(db, deps);

  expect(scoreCalls).toBe(0);
  expect(counts.held).toBe(1);
  expect(counts.queued).toBe(0);
  const stored = db.query('SELECT decision, decision_reason FROM postings WHERE id = ?').get(row.id) as {
    decision: string;
    decision_reason: string;
  };
  expect(stored.decision).toBe('held');
  expect(stored.decision_reason).toBe('held:jd-fetch-error');
});

// --- Plan 18-05: criteria loaded once per sweep, injected everywhere -------

test('loadCriteria is called exactly once per runFilterPromote call regardless of posting count (T-18-05-01, no per-posting compile)', async () => {
  const db = makeDb();
  upsertPosting(db, posting({ url: 'https://boards.greenhouse.io/acme/jobs/1' }))!;
  upsertPosting(db, posting({ url: 'https://boards.greenhouse.io/acme/jobs/2' }))!;
  upsertPosting(db, posting({ url: 'https://boards.greenhouse.io/acme/jobs/3' }))!;

  let loadCriteriaCalls = 0;
  const deps = baseDeps({
    loadCriteria: () => {
      loadCriteriaCalls++;
      return compileCriteria(defaultCriteria());
    },
  });

  await runFilterPromote(db, deps);

  expect(loadCriteriaCalls).toBe(1);
});

test('every classifyMetadata call receives the exact same compiled criteria object loadCriteria returned (proves the compile is not repeated per posting)', async () => {
  const db = makeDb();
  upsertPosting(db, posting({ url: 'https://boards.greenhouse.io/acme/jobs/1' }))!;
  upsertPosting(db, posting({ url: 'https://boards.greenhouse.io/acme/jobs/2' }))!;
  upsertPosting(db, posting({ url: 'https://boards.greenhouse.io/acme/jobs/3' }))!;

  const sentinel = compileCriteria(defaultCriteria());
  const seenCriteria: unknown[] = [];
  const deps = baseDeps({
    loadCriteria: () => sentinel,
    classifyMetadata: (_p, criteria) => {
      seenCriteria.push(criteria);
      return { reject: false };
    },
  });

  await runFilterPromote(db, deps);

  expect(seenCriteria.length).toBe(3);
  expect(seenCriteria.every((c) => c === sentinel)).toBe(true);
});
