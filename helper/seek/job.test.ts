import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createPostingsTable, upsertPosting, recordDecision, listPostingsToDecide } from './postings';
import { createQueueTable } from '../queue';
import { promotePosting } from './promote';
import { createSweepsTable, getSweepById } from './runs';
import { createBatchRunsTable } from './batch';
import { beginSweep, runSweepJob, spawnSidecar, SweepAlreadyRunningError, type JobDeps } from './job';
import type { NormalizedPosting, SeekConfig } from './types';

// In-memory DB with the full trio (sweeps/postings/queue) plus the minimal
// applications-table mirror promotePosting's tracker dedupe scan needs
// (mirrors decide.test.ts's makeDb) and seek_meta for the last_sweep upsert.
// batch_runs is required too: beginSweep now checks isBatchRunning (D-08
// reverse mutual exclusion, Phase 12).
function makeDb(): Database {
  const db = new Database(':memory:');
  createSweepsTable(db);
  createBatchRunsTable(db);
  createPostingsTable(db);
  createQueueTable(db);
  db.run(`CREATE TABLE applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company TEXT NOT NULL,
    url TEXT DEFAULT ''
  )`);
  db.run('CREATE TABLE IF NOT EXISTS seek_meta (key TEXT PRIMARY KEY, value TEXT)');
  return db;
}

function baseConfig(overrides: Partial<SeekConfig> = {}): SeekConfig {
  return {
    greenhouse: { enabled: true, tokens: ['acme'] },
    lever: { enabled: false, tokens: [] },
    ashby: { enabled: false, tokens: [] },
    hn: { enabled: false },
    yc: { enabled: false },
    jobright: { enabled: false },
    simplify: { enabled: false },
    getro: { enabled: false, networks: [] },
    ycdir: { enabled: false },
    blocklist: [],
    schedule: { enabled: true, targetHour: 7 },
    ...overrides,
  };
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

// Real recordDecision/listPostingsToDecide/promotePosting (per plan
// instruction), stubbed fetchers + classify/score/profile so no network/CLI
// or Playwright ever runs — mirrors decide.test.ts's baseDeps convention.
function baseDeps(overrides: Partial<JobDeps> = {}): JobDeps {
  return {
    fetchGreenhouse: async () => [posting()],
    fetchLever: async () => [],
    fetchAshby: async () => [],
    fetchHNPostings: async () => [],
    fetchSimplify: async () => [],
    fetchGetro: async () => ({ postings: [], errors: [] }),
    harvestYcDirectory: async () => ({ companies: 0, probed: 0, added: 0, errors: [] }),
    upsertPosting,
    upsertBoard: () => null,
    recordBoardResult: () => {},
    resolveEffectiveTokens: (_db, _ats, tokens) => tokens,
    classifyMetadata: () => ({ reject: false }),
    classifyYoe: () => ({ reject: false }),
    fetchJD: async () => 'some jd text',
    scoreRelevance: async () => ({ relevant: true, reason: 'matches profile' }),
    loadProfileSummary: async () => 'profile summary',
    promotePosting,
    recordDecision,
    listPostingsToDecide,
    spawnSidecar: async () => ({ ran: true, exitCode: 0, authExpired: [] }),
    ...overrides,
  };
}

test('beginSweep inserts a running row and returns a numeric runId', () => {
  const db = makeDb();
  const { runId } = beginSweep(db, 'manual');
  expect(typeof runId).toBe('number');
  const row = getSweepById(db, runId);
  expect(row?.status).toBe('running');
  expect(row?.trigger).toBe('manual');
});

test('a second beginSweep while one is running throws SweepAlreadyRunningError carrying the running id', () => {
  const db = makeDb();
  const { runId } = beginSweep(db, 'scheduled');
  expect(() => beginSweep(db, 'manual')).toThrow(SweepAlreadyRunningError);
  try {
    beginSweep(db, 'manual');
    throw new Error('expected beginSweep to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(SweepAlreadyRunningError);
    expect((err as SweepAlreadyRunningError).runId).toBe(runId);
  }
});

test('a directly SQL-seeded running row triggers the single-flight guard identically to one started via beginSweep', () => {
  const db = makeDb();
  db.query(`INSERT INTO sweeps (trigger, run_date, status) VALUES ('scheduled', '2026-07-01', 'running')`).run();
  expect(() => beginSweep(db, 'manual')).toThrow(SweepAlreadyRunningError);
});

test('runSweepJob composes fetch->filter->sidecar into one finished ok row with conservation-complete detail', async () => {
  const db = makeDb();
  const { runId } = beginSweep(db, 'manual');
  const result = await runSweepJob(db, baseConfig(), baseDeps(), runId);

  expect(result).toEqual({ runId, status: 'ok' });
  const row = getSweepById(db, runId);
  expect(row?.status).toBe('ok');
  expect(row?.finished_at).not.toBeNull();

  const detail = JSON.parse(row!.detail!);
  expect(Object.keys(detail).sort()).toEqual(['fetch', 'filter', 'headline', 'sidecar']);
  expect(Array.isArray(detail.fetch)).toBe(true);
  expect(detail.filter.queued).toBe(1);
  expect(detail.sidecar).toEqual({ ran: true, exitCode: 0, authExpired: [] });
  expect(detail.headline).toMatchObject({ queued: 1, held: 0 });

  // D-14 regression guard: the dashboard's #seekStats path still gets an
  // updated last_sweep row.
  const meta = db.query('SELECT value FROM seek_meta WHERE key = ?').get('last_sweep') as { value: string } | null;
  expect(meta).not.toBeNull();
  expect(JSON.parse(meta!.value)).toMatchObject({ queued: 1 });
});

test('a stubbed spawnSidecar that throws does not throw out of runSweepJob — row finishes ok with sidecar.ran=false', async () => {
  const db = makeDb();
  const { runId } = beginSweep(db, 'manual');
  const deps = baseDeps({
    spawnSidecar: async () => {
      throw new Error('sidecar boom');
    },
  });
  const result = await runSweepJob(db, baseConfig(), deps, runId);
  expect(result.status).toBe('ok');
  const row = getSweepById(db, runId);
  expect(row?.status).toBe('ok');
  const detail = JSON.parse(row!.detail!);
  expect(detail.sidecar.ran).toBe(false);
  expect(typeof detail.sidecar.error).toBe('string');
});

test('a thrown filter/decide stage finishes the row failed with detail.error set and rethrows (D-03)', async () => {
  const db = makeDb();
  const { runId } = beginSweep(db, 'manual');
  const brokenDeps = baseDeps({
    listPostingsToDecide: () => {
      throw new Error('decide stage exploded');
    },
  });
  await expect(runSweepJob(db, baseConfig(), brokenDeps, runId)).rejects.toThrow('decide stage exploded');
  const row = getSweepById(db, runId);
  expect(row?.status).toBe('failed');
  const detail = JSON.parse(row!.detail!);
  expect(detail.error).toContain('decide stage exploded');
});

test('scheduled vs manual triggers produce structurally identical detail (differ only by row trigger column)', async () => {
  const db1 = makeDb();
  const { runId: runId1 } = beginSweep(db1, 'scheduled');
  await runSweepJob(db1, baseConfig(), baseDeps(), runId1);
  const row1 = getSweepById(db1, runId1);

  const db2 = makeDb();
  const { runId: runId2 } = beginSweep(db2, 'manual');
  await runSweepJob(db2, baseConfig(), baseDeps(), runId2);
  const row2 = getSweepById(db2, runId2);

  expect(row1?.trigger).toBe('scheduled');
  expect(row2?.trigger).toBe('manual');

  const detail1 = JSON.parse(row1!.detail!);
  const detail2 = JSON.parse(row2!.detail!);
  delete detail1.headline.at;
  delete detail2.headline.at;
  expect(detail1).toEqual(detail2);
});

test('spawnSidecar is exported and callable (real impl exercised only via manual/UAT — see acceptance grep for process.execPath usage)', () => {
  expect(typeof spawnSidecar).toBe('function');
});

test('headline.tokenErrors sums per-token errors across two ATS sources (2 + 1 = 3)', async () => {
  const db = makeDb();
  const { runId } = beginSweep(db, 'manual');
  const config = baseConfig({
    greenhouse: { enabled: true, tokens: ['acme'] },
    lever: { enabled: true, tokens: ['beta'] },
  });
  const deps = baseDeps({
    fetchGreenhouse: async () => ({
      postings: [],
      errors: [{ token: 'a', error: 'boom' }, { token: 'b', error: 'boom' }],
    }),
    fetchLever: async () => ({ postings: [], errors: [{ token: 'c', error: 'boom' }] }),
  });
  await runSweepJob(db, config, deps, runId);
  const row = getSweepById(db, runId);
  const detail = JSON.parse(row!.detail!);
  expect(detail.headline.tokenErrors).toBe(3);
  expect(detail.headline.boardsAdded).toBe(0);
});

test('headline.boardsAdded sums slug-harvest results across simplify and getro (2 + 1 = 3)', async () => {
  const db = makeDb();
  const { runId } = beginSweep(db, 'manual');
  const config = baseConfig({
    greenhouse: { enabled: false, tokens: [] },
    simplify: { enabled: true },
    getro: { enabled: true, networks: [{ name: 'seedfund', id: '1' }] },
  });
  const deps = baseDeps({
    fetchSimplify: async () => [
      posting({ url: 'https://boards.greenhouse.io/acme/jobs/1', source: 'simplify' }),
      posting({ url: 'https://jobs.lever.co/beta/2', source: 'simplify' }),
    ],
    fetchGetro: async () => ({
      postings: [posting({ url: 'https://jobs.ashbyhq.com/gamma/3', source: 'getro' })],
      errors: [],
    }),
    // Real upsertBoard behavior is boards.test.ts's concern — this stub only
    // needs to signal "a board was added" (non-null) so runSweep's harvest
    // loop increments boardsAdded per candidate.
    upsertBoard: () => ({}) as any,
  });
  await runSweepJob(db, config, deps, runId);
  const row = getSweepById(db, runId);
  const detail = JSON.parse(row!.detail!);
  expect(detail.headline.boardsAdded).toBe(3);
  expect(detail.headline.tokenErrors).toBe(0);
});

test('a clean sweep reports tokenErrors: 0 and boardsAdded: 0 explicitly, never undefined, alongside every pre-existing headline field', async () => {
  const db = makeDb();
  const { runId } = beginSweep(db, 'manual');
  const result = await runSweepJob(db, baseConfig(), baseDeps(), runId);
  expect(result.status).toBe('ok');
  const row = getSweepById(db, runId);
  const detail = JSON.parse(row!.detail!);
  expect(detail.headline.tokenErrors).toBe(0);
  expect(detail.headline.boardsAdded).toBe(0);
  expect(Object.keys(detail.headline).sort()).toEqual(
    ['at', 'boardsAdded', 'byCriterion', 'deduped', 'fetched', 'held', 'queued', 'rejected', 'tokenErrors'].sort(),
  );
});
