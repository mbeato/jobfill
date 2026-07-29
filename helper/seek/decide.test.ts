import { test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createPostingsTable, upsertPosting, recordDecision, listPostingsToDecide, storePostingJD } from './postings';
import { createQueueTable } from '../queue';
import { promotePosting } from './promote';
import { runFilterPromote, LLM_CAP, DECIDE_CONCURRENCY, type DecideDeps, type FilterCounts } from './decide';
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
    storePostingJD,
    recordDecision,
    listPostingsToDecide,
    listAllBoards: () => [],
    ...overrides,
  };
}

// --- D-09 shared fixture (Phase 20 plan 03, checks 1 & 2) -------------------
// One fixture used by both the concurrency=1 identity test and the
// concurrency=8 invariants tests. Every posting's outcome is a deterministic
// function of its `company` field (not of ordering or timing), so the same
// inputs give the same verdicts no matter what order the pool completes
// them in: some rejected by classifyMetadata, some scored not-relevant, some
// scored relevant, and one whose scoreRelevance throws.
type FixtureKind = 'meta-reject' | 'llm-relevant' | 'llm-not-relevant' | 'llm-throw';

const FIXTURE_SPECS: { source: string; kind: FixtureKind }[] = [
  { source: 'greenhouse', kind: 'meta-reject' },
  { source: 'greenhouse', kind: 'llm-relevant' },
  { source: 'lever', kind: 'llm-not-relevant' },
  { source: 'lever', kind: 'llm-relevant' },
  { source: 'yc', kind: 'llm-throw' },
  { source: 'yc', kind: 'llm-relevant' },
];

function seedFixture(db: Database): { id: number; url_key: string; kind: FixtureKind }[] {
  return FIXTURE_SPECS.map((spec, idx) => {
    const row = upsertPosting(
      db,
      posting({ source: spec.source, company: `${spec.kind}-${idx}`, url: `https://example.com/${spec.source}/${idx}` }),
    )!;
    return { id: row.id, url_key: row.url_key, kind: spec.kind };
  });
}

function fixtureDeps(overrides: Partial<DecideDeps> = {}): DecideDeps {
  return baseDeps({
    classifyMetadata: p => (p.company.startsWith('meta-reject') ? { reject: true, reason: 'rules:title' } : { reject: false }),
    scoreRelevance: async (_profile, _jd, p) => {
      if (p.company.startsWith('llm-not-relevant')) return { relevant: false, reason: 'no fit' };
      if (p.company.startsWith('llm-throw')) throw new Error('scoring failed');
      return { relevant: true, reason: 'good fit' };
    },
    ...overrides,
  });
}

const ORIGINAL_CAP = process.env.SEEK_LLM_CAP;
const ORIGINAL_CONCURRENCY = process.env.SEEK_DECIDE_CONCURRENCY;
beforeEach(() => {
  delete process.env.SEEK_LLM_CAP;
  delete process.env.SEEK_DECIDE_CONCURRENCY;
});
afterEach(() => {
  if (ORIGINAL_CAP === undefined) delete process.env.SEEK_LLM_CAP;
  else process.env.SEEK_LLM_CAP = ORIGINAL_CAP;
  if (ORIGINAL_CONCURRENCY === undefined) delete process.env.SEEK_DECIDE_CONCURRENCY;
  else process.env.SEEK_DECIDE_CONCURRENCY = ORIGINAL_CONCURRENCY;
});

test('LLM_CAP defaults to 800 when SEEK_LLM_CAP is unset', () => {
  expect(LLM_CAP()).toBe(800);
});

test('LLM_CAP reads a valid numeric SEEK_LLM_CAP', () => {
  process.env.SEEK_LLM_CAP = '5';
  expect(LLM_CAP()).toBe(5);
});

// WR-02: a non-numeric SEEK_LLM_CAP must fail closed to the safe default,
// not silently become NaN (every `>= NaN` comparison is false, which would
// make the cap check never trip and process the entire backlog unbounded).
test('LLM_CAP falls back to 800 on a non-numeric SEEK_LLM_CAP', () => {
  process.env.SEEK_LLM_CAP = 'unlimited';
  expect(LLM_CAP()).toBe(800);
});

test('DECIDE_CONCURRENCY() defaults to 8 when SEEK_DECIDE_CONCURRENCY is unset', () => {
  expect(DECIDE_CONCURRENCY()).toBe(8);
});

test('DECIDE_CONCURRENCY() reads a valid numeric SEEK_DECIDE_CONCURRENCY', () => {
  process.env.SEEK_DECIDE_CONCURRENCY = '3';
  expect(DECIDE_CONCURRENCY()).toBe(3);
});

// WR-02: a non-numeric SEEK_DECIDE_CONCURRENCY must fail closed to the safe
// default, mirroring LLM_CAP's lesson exactly.
test('DECIDE_CONCURRENCY() falls back to 8 on a non-numeric SEEK_DECIDE_CONCURRENCY', () => {
  process.env.SEEK_DECIDE_CONCURRENCY = 'abc';
  expect(DECIDE_CONCURRENCY()).toBe(8);
});

// The guard here is `>= 1`, not LLM_CAP's `>= 0`: a cap of 0 is a
// meaningful configuration (score nothing), but a concurrency of 0 would
// spawn zero workers and silently no-op the entire decide stage -- so '0'
// and any negative value must also fail closed, unlike LLM_CAP where '0' is
// a legitimate value.
test('DECIDE_CONCURRENCY() falls back to 8 on "0" (a concurrency of 0 would silently no-op the decide stage)', () => {
  process.env.SEEK_DECIDE_CONCURRENCY = '0';
  expect(DECIDE_CONCURRENCY()).toBe(8);
});

test('DECIDE_CONCURRENCY() falls back to 8 on a negative value', () => {
  process.env.SEEK_DECIDE_CONCURRENCY = '-4';
  expect(DECIDE_CONCURRENCY()).toBe(8);
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

// The sweep already pays to fetch a full JD for every posting it scores, and
// used to discard it — leaving the tailor to re-derive one by scraping the page
// at fill time. Kept ONLY for postings that actually reach the queue: rejected
// ones are never tailored, and storing theirs would put ~10k chars x the whole
// pool into the db every sweep for nothing.
test('queued posting persists the JD the scorer already fetched; rejected ones do not', async () => {
  const db = makeDb();
  const keep = upsertPosting(db, posting({ company: 'Keep', url: 'https://boards.greenhouse.io/keep/jobs/1' }))!;
  const drop = upsertPosting(db, posting({ company: 'Drop', url: 'https://boards.greenhouse.io/drop/jobs/2' }))!;
  const deps = baseDeps({
    fetchJD: async p => `full description for ${p.company}`,
    scoreRelevance: async (_profile, _jd, p) =>
      p.company === 'Keep' ? { relevant: true, reason: 'fit' } : { relevant: false, reason: 'no fit' },
  });

  await runFilterPromote(db, deps);

  const read = (id: number) => (db.query('SELECT jd FROM postings WHERE id = ?').get(id) as { jd: string }).jd;
  expect(read(keep.id)).toBe('full description for Keep');
  expect(read(drop.id)).toBe('');
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

// --- Phase 20 plan 03: D-09 checks 1 & 2 (pooled decide loop) --------------

test('D-09 check 1: concurrency forced to 1 produces a FilterCounts byte-identical to the pre-pool serial loop -- the pool restructure changed nothing but scheduling', async () => {
  process.env.SEEK_DECIDE_CONCURRENCY = '1';
  process.env.SEEK_LLM_CAP = '100';
  const db = makeDb();
  seedFixture(db);

  const counts = await runFilterPromote(db, fixtureDeps());

  // Hand-derived from FIXTURE_SPECS: 1 meta-reject (rules:title), 1
  // llm-not-relevant, 3 llm-relevant (all queue -- distinct urls, no
  // dedupe), 1 llm-throw (held). Cap (100) never binds over 6 postings.
  const expected: FilterCounts = {
    toDecide: 6,
    rulesRejected: 1,
    llmRejected: 1,
    queued: 3,
    held: 1,
    deduped: 0,
    unscored: 0,
    errored: 0,
    byCriterion: { title: 1, location: 0, stale: 0, yoe: 0, llm: 1, grace: 0 },
    llmBreakerTripped: false,
  };
  expect(counts).toEqual(expected);
});

test('D-09 check 2a: concurrency 8 never exceeds LLM_CAP -- 20 eligible postings, cap 5, exactly 5 scoreRelevance calls and 15 unscored', async () => {
  process.env.SEEK_DECIDE_CONCURRENCY = '8';
  process.env.SEEK_LLM_CAP = '5';
  const db = makeDb();
  for (let i = 0; i < 20; i++) {
    upsertPosting(db, posting({ url: `https://boards.greenhouse.io/acme/jobs/${i}` }))!;
  }
  let scoreCalls = 0;
  const deps = baseDeps({
    scoreRelevance: async () => {
      scoreCalls++;
      return { relevant: true, reason: 'fit' };
    },
  });

  const counts = await runFilterPromote(db, deps);

  // Proves the claim-before-work atomicity: concurrent workers cannot
  // overshoot LLM_CAP() no matter how they interleave.
  expect(scoreCalls).toBe(5);
  expect(counts.unscored).toBe(15);
});

test('D-09 check 2b: concurrency 8 isolates a single scoring failure -- held-for-retry does not abort the pool (D-08)', async () => {
  process.env.SEEK_DECIDE_CONCURRENCY = '8';
  process.env.SEEK_LLM_CAP = '100';
  const db = makeDb();
  const rows = Array.from({ length: 6 }, (_, i) => upsertPosting(db, posting({ url: `https://boards.greenhouse.io/acme/jobs/${i}` }))!);
  const failingId = rows[3].id;
  const deps = baseDeps({
    scoreRelevance: async (_profile, _jd, p) => {
      if (p.id === failingId) throw new Error('one bad posting');
      return { relevant: true, reason: 'fit' };
    },
  });

  // Resolves (not rejects) -- the pool is never aborted by one bad posting.
  const counts = await runFilterPromote(db, deps);

  expect(counts.held).toBe(1);
  const decided = db.query('SELECT id, decision, decision_reason FROM postings').all() as {
    id: number;
    decision: string;
    decision_reason: string;
  }[];
  const failingRow = decided.find(r => r.id === failingId)!;
  expect(failingRow.decision).toBe('held');
  expect(failingRow.decision_reason).toBe('held:llm-error');
  const others = decided.filter(r => r.id !== failingId);
  expect(others.every(r => r.decision !== 'held')).toBe(true);
});

test('D-09 check 2c: decision multiset is equal between a concurrency-1 run and a concurrency-8 run when the cap is not binding', async () => {
  process.env.SEEK_LLM_CAP = '100';

  process.env.SEEK_DECIDE_CONCURRENCY = '1';
  const db1 = makeDb();
  seedFixture(db1);
  const counts1 = await runFilterPromote(db1, fixtureDeps());

  process.env.SEEK_DECIDE_CONCURRENCY = '8';
  const db8 = makeDb();
  seedFixture(db8);
  const counts8 = await runFilterPromote(db8, fixtureDeps());

  const rowsOf = (db: Database) =>
    (db.query('SELECT url_key, decision, decision_reason FROM postings').all() as { url_key: string; decision: string; decision_reason: string }[])
      .map(r => [r.url_key, r.decision, r.decision_reason] as const)
      .sort();

  // This equality holds only because the cap is not binding (100, well
  // above the 6-row fixture). When the cap binds, WHICH postings win the
  // last slots depends on completion order (D-08's accepted consequence) --
  // only checks 2a and 2b above are guaranteed under a binding cap.
  expect(rowsOf(db8)).toEqual(rowsOf(db1));
  expect(counts8).toEqual(counts1);
});

test('D-09 check 2d: concurrency 8 is genuinely concurrent -- max in-flight scoreRelevance calls is bounded by 8 but greater than 1', async () => {
  process.env.SEEK_DECIDE_CONCURRENCY = '8';
  process.env.SEEK_LLM_CAP = '100';
  const db = makeDb();
  for (let i = 0; i < 20; i++) {
    upsertPosting(db, posting({ url: `https://boards.greenhouse.io/acme/jobs/${i}` }))!;
  }
  let inFlight = 0;
  let maxInFlight = 0;
  const deps = baseDeps({
    scoreRelevance: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight--;
      return { relevant: true, reason: 'fit' };
    },
  });

  await runFilterPromote(db, deps);

  expect(maxInFlight).toBeLessThanOrEqual(8);
  // The lower bound proves the pool is actually concurrent, not
  // accidentally serial.
  expect(maxInFlight).toBeGreaterThan(1);
});

// --- Phase 20 plan 03: breaker (D-19/D-20) and DECIDE_CONCURRENCY reader ---
// Forced to concurrency 1 throughout: the breaker's own claiming is
// per-worker, so an 8-worker pool can have several calls already in flight
// when the trip is observed, making an exact invocation count
// order-dependent. Concurrency 1 is what makes "exactly N calls" assertable
// at all -- exactly the same reasoning D-09 check 1 uses for FilterCounts.

test('breaker (a): trips after BREAKER_THRESHOLD (5) consecutive scoring failures and stops claiming', async () => {
  process.env.SEEK_DECIDE_CONCURRENCY = '1';
  process.env.SEEK_LLM_CAP = '100';
  const db = makeDb();
  for (let i = 0; i < 20; i++) {
    upsertPosting(db, posting({ url: `https://boards.greenhouse.io/acme/jobs/${i}` }))!;
  }
  let scoreCalls = 0;
  const deps = baseDeps({
    scoreRelevance: async () => {
      scoreCalls++;
      throw new Error('always fails');
    },
  });

  const counts = await runFilterPromote(db, deps);

  expect(scoreCalls).toBe(5);
  expect(counts.held).toBe(5);
  expect(counts.llmBreakerTripped).toBe(true);
  // The breaker stops CLAIMING, not draining (17-D-04): the remaining 15
  // postings still had grace and classifyMetadata applied for the whole
  // backlog -- they land in unscored, not vanish.
  expect(counts.unscored).toBe(15);
});

test('breaker (b, D-19): unattempted postings stay decision NULL with decision_reason NULL, never held', async () => {
  process.env.SEEK_DECIDE_CONCURRENCY = '1';
  process.env.SEEK_LLM_CAP = '100';
  const db = makeDb();
  for (let i = 0; i < 20; i++) {
    upsertPosting(db, posting({ url: `https://boards.greenhouse.io/acme/jobs/${i}` }))!;
  }
  const deps = baseDeps({
    scoreRelevance: async () => {
      throw new Error('always fails');
    },
  });

  await runFilterPromote(db, deps);

  // Mislabelling the unattempted 15 as `held` would corrupt the
  // held-for-retry signal -- they were never attempted, so they must stay
  // indistinguishable from "not yet reached".
  const held = db.query(`SELECT count(*) as c FROM postings WHERE decision = 'held'`).get() as { c: number };
  const unattempted = db
    .query(`SELECT count(*) as c FROM postings WHERE decision IS NULL AND decision_reason IS NULL`)
    .get() as { c: number };
  expect(held.c).toBe(5);
  expect(unattempted.c).toBe(15);
});

test('breaker (c): a success resets the consecutive-failure streak -- alternating throw/success never trips it', async () => {
  process.env.SEEK_DECIDE_CONCURRENCY = '1';
  process.env.SEEK_LLM_CAP = '100';
  const db = makeDb();
  for (let i = 0; i < 20; i++) {
    upsertPosting(db, posting({ url: `https://boards.greenhouse.io/acme/jobs/${i}` }))!;
  }
  let calls = 0;
  let successes = 0;
  const deps = baseDeps({
    scoreRelevance: async () => {
      calls++;
      if (calls % 2 === 0) {
        successes++;
        return { relevant: true, reason: 'ok' };
      }
      throw new Error('flaky');
    },
  });

  const counts = await runFilterPromote(db, deps);

  // 20 calls at concurrency 1, alternating throw/success -- a
  // non-resetting counter would have tripped well before all 20 ran.
  expect(calls).toBe(20);
  expect(successes).toBe(10);
  expect(counts.llmBreakerTripped).toBe(false);
});

test('breaker (d, D-20): a failed claim is never released -- two failures permanently consume their cap slots', async () => {
  process.env.SEEK_DECIDE_CONCURRENCY = '1';
  process.env.SEEK_LLM_CAP = '3';
  const db = makeDb();
  for (let i = 0; i < 5; i++) {
    upsertPosting(db, posting({ url: `https://boards.greenhouse.io/acme/jobs/${i}` }))!;
  }
  let calls = 0;
  const deps = baseDeps({
    scoreRelevance: async () => {
      calls++;
      if (calls <= 2) throw new Error('transient');
      return { relevant: true, reason: 'ok' };
    },
  });

  const counts = await runFilterPromote(db, deps);

  // Releasing a failed claim would let a systematic failure loop
  // indefinitely against the API, which is why D-20 forbids it: the cap's 3
  // slots are permanently consumed by the 2 failures plus the 1 success, so
  // only 1 of them produced a decided (non-held) verdict.
  expect(calls).toBe(3);
  expect(counts.queued + counts.llmRejected).toBe(1);
});

// --- Phase 20 review WR-01: the breaker at the SHIPPED default concurrency --
// Every test above pins concurrency 1, where "5 consecutive failures" means
// five attempts issued one after another. At the shipped default of 8 the
// pool has 8 calls in flight with no success able to interleave among them,
// so the threshold scales with the pool width (BREAKER_THRESHOLD * 8 = 40) to
// keep the trip meaning five successive WAVES of evidence rather than one.

test('breaker (e, WR-01): at the shipped default concurrency of 8, a single failing wave does not trip the breaker', async () => {
  process.env.SEEK_DECIDE_CONCURRENCY = '8';
  process.env.SEEK_LLM_CAP = '100';
  const db = makeDb();
  for (let i = 0; i < 40; i++) {
    upsertPosting(db, posting({ url: `https://boards.greenhouse.io/acme/jobs/${i}` }))!;
  }
  let calls = 0;
  const deps = baseDeps({
    scoreRelevance: async () => {
      calls++;
      // One transient event failing the entire in-flight wave — a rate-limit
      // burst, or 8 of relevance.ts's 60s timeouts expiring together.
      if (calls <= 8) throw new Error('rate limited');
      return { relevant: true, reason: 'fit' };
    },
  });

  const counts = await runFilterPromote(db, deps);

  // The whole point: one wave is one data point, not 8. Under an unscaled
  // threshold of 5 the latched breaker would trip inside that first wave and
  // abandon the remaining 32 postings for the rest of the sweep.
  expect(counts.llmBreakerTripped).toBe(false);
  expect(calls).toBe(40);
  expect(counts.held).toBe(8);
  expect(counts.queued).toBe(32);
  expect(counts.unscored).toBe(0);
});

test('breaker (f, WR-01): at concurrency 8 a sustained failure still trips, after ~5 waves rather than ~5 calls', async () => {
  process.env.SEEK_DECIDE_CONCURRENCY = '8';
  process.env.SEEK_LLM_CAP = '100';
  const db = makeDb();
  for (let i = 0; i < 80; i++) {
    upsertPosting(db, posting({ url: `https://boards.greenhouse.io/acme/jobs/${i}` }))!;
  }
  let calls = 0;
  const deps = baseDeps({
    scoreRelevance: async () => {
      calls++;
      throw new Error('channel down');
    },
  });

  const counts = await runFilterPromote(db, deps);

  expect(counts.llmBreakerTripped).toBe(true);
  // At least the threshold (5 * 8 = 40), and bounded above by it plus the
  // at-most-7 other calls already in flight when the trip was observed. The
  // exact number inside that window is completion-order dependent (D-08), so
  // it is deliberately not pinned.
  expect(calls).toBeGreaterThanOrEqual(40);
  expect(calls).toBeLessThanOrEqual(47);
  expect(counts.held).toBe(calls);
  // The breaker stops CLAIMING, not draining (17-D-04) — the rest of the
  // backlog still ran the cheap rules and lands in unscored.
  expect(counts.unscored).toBe(80 - calls);
});

// --- Phase 20 review WR-02: the breaker covers both stages a slot pays for --

test('breaker (g, WR-02): a systematic JD-fetch failure trips the breaker instead of draining the whole cap into held:jd-fetch-error', async () => {
  process.env.SEEK_DECIDE_CONCURRENCY = '1';
  process.env.SEEK_LLM_CAP = '100';
  const db = makeDb();
  for (let i = 0; i < 20; i++) {
    upsertPosting(db, posting({ url: `https://boards.greenhouse.io/acme/jobs/${i}` }))!;
  }
  let fetchCalls = 0;
  const deps = baseDeps({
    fetchJD: async () => {
      fetchCalls++;
      throw new Error('ATS host down');
    },
  });

  const counts = await runFilterPromote(db, deps);

  // The slot is claimed before the fetch, so a fetch that throws is a
  // claimed slot that produced no verdict — identical to a scoring failure
  // from the budget's point of view, and D-20 means neither is returned.
  expect(fetchCalls).toBe(5);
  expect(counts.held).toBe(5);
  expect(counts.llmBreakerTripped).toBe(true);
  expect(counts.unscored).toBe(15);
});

test('breaker (g2, WR-02): a JD-fetch failure streak is reset by a successful verdict, so intermittent 404s never trip it', async () => {
  process.env.SEEK_DECIDE_CONCURRENCY = '1';
  process.env.SEEK_LLM_CAP = '100';
  const db = makeDb();
  for (let i = 0; i < 20; i++) {
    upsertPosting(db, posting({ url: `https://boards.greenhouse.io/acme/jobs/${i}` }))!;
  }
  let fetchCalls = 0;
  const deps = baseDeps({
    fetchJD: async () => {
      fetchCalls++;
      if (fetchCalls % 2 === 0) throw new Error('greenhouse acme/1 returned HTTP 404');
      return 'some jd text';
    },
  });

  const counts = await runFilterPromote(db, deps);

  // An ordinary 404 is transient and per-posting (see the held-for-retry
  // test above); only a run with no success between them is evidence the
  // channel itself is down.
  expect(fetchCalls).toBe(20);
  expect(counts.held).toBe(10);
  expect(counts.queued).toBe(10);
  expect(counts.llmBreakerTripped).toBe(false);
});

// --- Phase 20 review CR-01: the pool's outer catch is counted, not silent ---
// The pre-pool serial loop had no outer catch, so a recordDecision/
// promotePosting throw failed the sweep loudly. The pool must still isolate
// it (one bad posting never aborts the pool), but it must not erase it.

test('CR-01: a posting whose decision write throws is isolated, counted in counts.errored, and does not abort the pool', async () => {
  process.env.SEEK_DECIDE_CONCURRENCY = '1';
  process.env.SEEK_LLM_CAP = '100';
  const db = makeDb();
  const rows = Array.from({ length: 4 }, (_, i) => upsertPosting(db, posting({ url: `https://boards.greenhouse.io/acme/jobs/${i}` }))!);
  const throwingId = rows[1].id;
  // The reachable path to the outer catch: the failing write also fails the
  // inner catch's own recordDecision(held), so no row can be written at all.
  const deps = baseDeps({
    recordDecision: (db2, id, decision, reason) => {
      if (id === throwingId) throw new Error('SQLITE_BUSY');
      return recordDecision(db2, id, decision, reason);
    },
  });

  const counts = await runFilterPromote(db, deps);

  expect(counts.errored).toBe(1);
  expect(counts.queued).toBe(3);
  // Not held: the recordDecision that would have written that row is
  // downstream of the throw. Not unscored either (D-19 reserves that for
  // never-attempted). The row stays decision NULL and comes back next
  // sweep, which is exactly what counts.errored makes visible.
  expect(counts.held).toBe(0);
  expect(counts.unscored).toBe(0);
  const stored = db.query('SELECT decision FROM postings WHERE id = ?').get(throwingId) as { decision: string | null };
  expect(stored.decision).toBeNull();
});

test('CR-01: a systematic throw (every posting) trips the breaker instead of burning the whole cap on a sweep that reports ok', async () => {
  process.env.SEEK_DECIDE_CONCURRENCY = '1';
  process.env.SEEK_LLM_CAP = '100';
  const db = makeDb();
  for (let i = 0; i < 20; i++) {
    upsertPosting(db, posting({ url: `https://boards.greenhouse.io/acme/jobs/${i}` }))!;
  }
  const deps = baseDeps({
    // A DB-level write failure throws for every posting, not one.
    recordDecision: () => {
      throw new Error('disk I/O error');
    },
  });

  const counts = await runFilterPromote(db, deps);

  expect(counts.errored).toBe(5);
  expect(counts.llmBreakerTripped).toBe(true);
  expect(counts.unscored).toBe(15);
  // Reconcilable against toDecide, which is the property the silent
  // swallow broke.
  expect(counts.errored + counts.unscored).toBe(counts.toDecide);
});
