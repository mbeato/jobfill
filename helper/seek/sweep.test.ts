import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createPostingsTable, upsertPosting, listPostings } from './postings';
import { createBoardsTable, upsertBoard, recordBoardResult, resolveEffectiveTokens, SEED_BACKFILL_FIRST_SEEN } from './boards';
import { createSeekMetaTable, readSeekMeta, writeSeekMeta } from './meta';
import { runSweep } from './sweep';
import type { NormalizedPosting, SeekConfig } from './types';
import type { SweepDeps } from './sweep';

function makePosting(overrides: Partial<NormalizedPosting> = {}): NormalizedPosting {
  return {
    company: 'acme',
    title: 'Engineer',
    location: 'NYC',
    url: 'https://boards.greenhouse.io/acme/jobs/1',
    source: 'greenhouse',
    posted_at: null,
    posted_at_trusted: false,
    login_gated: false,
    ...overrides,
  };
}

function baseConfig(overrides: Partial<SeekConfig> = {}): SeekConfig {
  return {
    greenhouse: { enabled: true, tokens: ['acme'] },
    lever: { enabled: true, tokens: ['acme'] },
    ashby: { enabled: true, tokens: ['acme'] },
    hn: { enabled: true },
    yc: { enabled: false },
    jobright: { enabled: false },
    simplify: { enabled: false },
    getro: { enabled: false, networks: [] },
    ycdir: { enabled: false },
    blocklist: [],
    ...overrides,
  } as SeekConfig;
}

function makeDb() {
  const db = new Database(':memory:');
  createPostingsTable(db);
  createBoardsTable(db);
  createSeekMetaTable(db);
  return db;
}

// Real boards.ts functions wired in by default so the union/recording tests
// below exercise genuine DB behavior; individual tests override a fetcher or
// a boards fn as needed.
function baseDeps(overrides: Partial<SweepDeps> = {}): SweepDeps {
  return {
    fetchGreenhouse: async () => ({ postings: [], errors: [] }),
    fetchLever: async () => ({ postings: [], errors: [] }),
    fetchAshby: async () => ({ postings: [], errors: [] }),
    fetchHNPostings: async () => [],
    fetchSimplify: async () => [],
    fetchGetro: async () => ({ postings: [], errors: [] }),
    harvestYcDirectory: async () => ({ companies: 0, probed: 0, added: 0, errors: [] }),
    upsertPosting,
    upsertBoard,
    recordBoardResult,
    resolveEffectiveTokens,
    ...overrides,
  };
}

test('runSweep with all four fetchers succeeding returns one summary entry per source and upserts postings', async () => {
  const db = makeDb();
  const config = baseConfig();
  const results = await runSweep(db, config, baseDeps({
    fetchGreenhouse: async () => ({ postings: [makePosting({ source: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/1' })], errors: [] }),
    fetchLever: async () => ({ postings: [makePosting({ source: 'lever', url: 'https://jobs.lever.co/acme/1' })], errors: [] }),
    fetchAshby: async () => ({ postings: [makePosting({ source: 'ashby', url: 'https://jobs.ashbyhq.com/acme/1' })], errors: [] }),
    fetchHNPostings: async () => [makePosting({ source: 'hn', url: 'https://news.ycombinator.com/item?id=1' })],
  }));

  expect(results).toHaveLength(4);
  for (const r of results) {
    expect(r.fetched).toBe(1);
    expect(r.upserted).toBe(1);
    expect(r.error).toBeUndefined();
    expect(r.tokenErrors).toBeUndefined();
  }
  expect(listPostings(db)).toHaveLength(4);
});

test('runSweep isolates a throwing source (D-13): the other three still report fetched/upserted counts', async () => {
  const db = makeDb();
  const config = baseConfig();
  const results = await runSweep(db, config, baseDeps({
    fetchGreenhouse: async () => ({ postings: [makePosting({ source: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/1' })], errors: [] }),
    fetchLever: async () => {
      throw new Error('lever API down');
    },
    fetchAshby: async () => ({ postings: [makePosting({ source: 'ashby', url: 'https://jobs.ashbyhq.com/acme/1' })], errors: [] }),
    fetchHNPostings: async () => [makePosting({ source: 'hn', url: 'https://news.ycombinator.com/item?id=1' })],
  }));

  expect(results).toHaveLength(4);
  const bySource = Object.fromEntries(results.map(r => [r.source, r]));

  expect(bySource.lever.error).toBe('lever API down');
  expect(bySource.lever.fetched).toBe(0);
  expect(bySource.lever.upserted).toBeUndefined();

  for (const s of ['greenhouse', 'ashby', 'hn'] as const) {
    expect(bySource[s].fetched).toBe(1);
    expect(bySource[s].upserted).toBe(1);
    expect(bySource[s].error).toBeUndefined();
  }

  const stored = listPostings(db);
  expect(stored.map(p => p.source).sort()).toEqual(['ashby', 'greenhouse', 'hn']);
});

test('runSweep skips a disabled source and never invokes its fetcher', async () => {
  const db = makeDb();
  const config = baseConfig({ hn: { enabled: false } });
  let hnCalls = 0;
  const results = await runSweep(db, config, baseDeps({
    fetchGreenhouse: async () => ({ postings: [makePosting({ source: 'greenhouse' })], errors: [] }),
    fetchLever: async () => ({ postings: [makePosting({ source: 'lever', url: 'https://jobs.lever.co/acme/1' })], errors: [] }),
    fetchAshby: async () => ({ postings: [makePosting({ source: 'ashby', url: 'https://jobs.ashbyhq.com/acme/1' })], errors: [] }),
    fetchHNPostings: async () => {
      hnCalls++;
      return [makePosting({ source: 'hn', url: 'https://news.ycombinator.com/item?id=1' })];
    },
  }));

  expect(hnCalls).toBe(0);
  expect(results.some(r => r.source === 'hn')).toBe(false);
  expect(results).toHaveLength(3);
});

test('runSweep surfaces tokenErrors when a fetcher returns { postings, errors } (D-03)', async () => {
  const db = makeDb();
  const config = baseConfig();
  const results = await runSweep(db, config, baseDeps({
    fetchGreenhouse: async () => ({
      postings: [makePosting({ source: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/1' })],
      errors: [{ token: 'x', error: 'HTTP 404' }],
    }),
  }));

  const gh = results.find(r => r.source === 'greenhouse')!;
  expect(gh.fetched).toBe(1);
  expect(gh.upserted).toBe(1);
  expect(gh.error).toBeUndefined();
  expect(gh.tokenErrors).toBe(1);
  expect(gh.sampleTokenErrors).toHaveLength(1);
});

test('runSweep still accepts a plain-array fetcher return with tokenErrors left undefined', async () => {
  const db = makeDb();
  const config = baseConfig();
  const results = await runSweep(db, config, baseDeps({
    fetchGreenhouse: async () => [makePosting({ source: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/1' })],
    fetchLever: async () => [],
    fetchAshby: async () => [],
  }));

  const gh = results.find(r => r.source === 'greenhouse')!;
  expect(gh.tokenErrors).toBeUndefined();
  expect(gh.sampleTokenErrors).toBeUndefined();
});

test('runSweep caps sampleTokenErrors at 5 while tokenErrors counts the full error set', async () => {
  const db = makeDb();
  const config = baseConfig();
  const nineErrors = Array.from({ length: 9 }, (_, i) => ({ token: `t${i}`, error: 'boom' }));
  const results = await runSweep(db, config, baseDeps({
    fetchGreenhouse: async () => ({ postings: [], errors: nineErrors }),
  }));

  const gh = results.find(r => r.source === 'greenhouse')!;
  expect(gh.tokenErrors).toBe(9);
  expect(gh.sampleTokenErrors).toHaveLength(5);
});

// --- D-01 effective-token resolution + D-04 board-result recording ---

test('the greenhouse stub receives the union of config tokens and active board tokens, minus blocklist', async () => {
  const db = makeDb();
  upsertBoard(db, { ats: 'greenhouse', token: 'beta', source_of_discovery: 'simplify' });
  upsertBoard(db, { ats: 'greenhouse', token: 'blocked', source_of_discovery: 'simplify' });
  const config = baseConfig({
    greenhouse: { enabled: true, tokens: ['acme'] },
    lever: { enabled: false, tokens: [] },
    ashby: { enabled: false, tokens: [] },
    hn: { enabled: false },
    blocklist: ['blocked'],
  });
  let seenTokens: string[] = [];
  await runSweep(db, config, baseDeps({
    fetchGreenhouse: async (tokens: string[]) => {
      seenTokens = tokens;
      return { postings: [], errors: [] };
    },
  }));

  expect(seenTokens.sort()).toEqual(['acme', 'beta']);
});

test('after a sweep where the stub errors on token beta, consecutive_failures becomes 1 while acme is untouched', async () => {
  const db = makeDb();
  upsertBoard(db, { ats: 'greenhouse', token: 'beta', source_of_discovery: 'simplify' });
  upsertBoard(db, { ats: 'greenhouse', token: 'acme', source_of_discovery: 'seed' });
  const config = baseConfig({
    greenhouse: { enabled: true, tokens: ['acme'] },
    lever: { enabled: false, tokens: [] },
    ashby: { enabled: false, tokens: [] },
    hn: { enabled: false },
  });
  await runSweep(db, config, baseDeps({
    fetchGreenhouse: async () => ({ postings: [], errors: [{ token: 'beta', error: 'HTTP 500' }] }),
  }));

  const beta = db.query('SELECT consecutive_failures, last_ok_at FROM boards WHERE token = ?').get('beta') as {
    consecutive_failures: number;
    last_ok_at: string | null;
  };
  const acme = db.query('SELECT consecutive_failures, last_ok_at FROM boards WHERE token = ?').get('acme') as {
    consecutive_failures: number;
    last_ok_at: string | null;
  };
  expect(beta.consecutive_failures).toBe(1);
  expect(beta.last_ok_at).toBeNull();
  expect(acme.consecutive_failures).toBe(0);
  expect(acme.last_ok_at).not.toBeNull();
});

test('a whole-source throw leaves every board consecutive_failures at 0', async () => {
  const db = makeDb();
  upsertBoard(db, { ats: 'greenhouse', token: 'beta', source_of_discovery: 'simplify' });
  const config = baseConfig({
    greenhouse: { enabled: true, tokens: ['acme'] },
    lever: { enabled: false, tokens: [] },
    ashby: { enabled: false, tokens: [] },
    hn: { enabled: false },
  });
  await runSweep(db, config, baseDeps({
    fetchGreenhouse: async () => {
      throw new Error('greenhouse API down');
    },
  }));

  const beta = db.query('SELECT consecutive_failures FROM boards WHERE token = ?').get('beta') as {
    consecutive_failures: number;
  };
  expect(beta.consecutive_failures).toBe(0);
});

// --- D-11/D-14 simplify + getro posting sources and slug harvesters ---

function disabledSourcesConfig(overrides: Partial<SeekConfig> = {}): SeekConfig {
  return baseConfig({
    greenhouse: { enabled: false, tokens: [] },
    lever: { enabled: false, tokens: [] },
    ashby: { enabled: false, tokens: [] },
    hn: { enabled: false },
    ...overrides,
  });
}

test('a sweep with simplify enabled upserts postings and creates boards rows tagged simplify', async () => {
  const db = makeDb();
  const config = disabledSourcesConfig({ simplify: { enabled: true } });
  const results = await runSweep(db, config, baseDeps({
    fetchSimplify: async () => [
      makePosting({ source: 'simplify', company: 'Acme', url: 'https://boards.greenhouse.io/acme/jobs/1' }),
      makePosting({ source: 'simplify', company: 'Beta', url: 'https://jobs.lever.co/beta/1' }),
    ],
  }));

  expect(listPostings(db)).toHaveLength(2);
  const boards = db.query('SELECT ats, token, source_of_discovery FROM boards').all() as {
    ats: string;
    token: string;
    source_of_discovery: string;
  }[];
  expect(boards).toHaveLength(2);
  for (const b of boards) expect(b.source_of_discovery).toBe('simplify');
  expect(boards.map(b => `${b.ats}:${b.token}`).sort()).toEqual(['greenhouse:acme', 'lever:beta']);

  const simplifyResult = results.find(r => r.source === 'simplify')!;
  expect(simplifyResult.boardsAdded).toBe(2);
});

test('a sweep with getro enabled upserts postings and creates boards rows tagged getro', async () => {
  const db = makeDb();
  const config = disabledSourcesConfig({ getro: { enabled: true, networks: [{ name: 'craftventures', id: '1' }] } });
  const results = await runSweep(db, config, baseDeps({
    fetchGetro: async () => ({
      postings: [makePosting({ source: 'getro', company: 'Gamma', url: 'https://jobs.ashbyhq.com/gamma/1' })],
      errors: [],
    }),
  }));

  expect(listPostings(db)).toHaveLength(1);
  const boards = db.query('SELECT ats, token, source_of_discovery FROM boards').all() as {
    ats: string;
    token: string;
    source_of_discovery: string;
  }[];
  expect(boards).toHaveLength(1);
  expect(boards[0].source_of_discovery).toBe('getro');
  expect(boards[0].ats).toBe('ashby');
  expect(boards[0].token).toBe('gamma');

  const getroResult = results.find(r => r.source === 'getro')!;
  expect(getroResult.boardsAdded).toBe(1);
});

test('a blocklisted slug yields a posting but zero board rows', async () => {
  const db = makeDb();
  const config = disabledSourcesConfig({ simplify: { enabled: true }, blocklist: ['acme'] });
  await runSweep(db, config, baseDeps({
    fetchSimplify: async () => [
      makePosting({ source: 'simplify', company: 'Acme', url: 'https://boards.greenhouse.io/acme/jobs/1' }),
    ],
  }));

  expect(listPostings(db)).toHaveLength(1);
  const boards = db.query('SELECT * FROM boards').all();
  expect(boards).toHaveLength(0);
});

test('a getro stub with one failing network yields a getro result carrying tokenErrors while the healthy network postings are stored', async () => {
  const db = makeDb();
  const config = disabledSourcesConfig({
    getro: { enabled: true, networks: [{ name: 'healthy', id: '1' }, { name: 'dead', id: '2' }] },
  });
  const results = await runSweep(db, config, baseDeps({
    fetchGetro: async () => ({
      postings: [makePosting({ source: 'getro', company: 'Healthy Co', url: 'https://jobs.ashbyhq.com/healthy/1' })],
      errors: [{ network: 'dead', error: 'HTTP 500' }],
    }),
  }));

  const getroResult = results.find(r => r.source === 'getro')!;
  expect(getroResult.tokenErrors).toBe(1);
  expect(getroResult.sampleTokenErrors).toEqual([{ token: 'dead', error: 'HTTP 500' }]);
  expect(listPostings(db)).toHaveLength(1);
});

test('a throwing fetchSimplify produces an error result and does not affect other sources', async () => {
  const db = makeDb();
  const config = disabledSourcesConfig({ simplify: { enabled: true }, hn: { enabled: true } });
  const results = await runSweep(db, config, baseDeps({
    fetchSimplify: async () => {
      throw new Error('simplify feed down');
    },
    fetchHNPostings: async () => [makePosting({ source: 'hn', url: 'https://news.ycombinator.com/item?id=1' })],
  }));

  const bySource = Object.fromEntries(results.map(r => [r.source, r]));
  expect(bySource.simplify.error).toBe('simplify feed down');
  expect(bySource.simplify.fetched).toBe(0);
  expect(bySource.hn.fetched).toBe(1);
  expect(bySource.hn.error).toBeUndefined();
});

// --- D-17/D-19 weekly-gated ycdir slug harvest ---

test('with no prior ycdir_last_run, the harvest stub runs once and writes an ISO timestamp', async () => {
  const db = makeDb();
  const config = disabledSourcesConfig({ ycdir: { enabled: true } });
  let calls = 0;
  const results = await runSweep(db, config, baseDeps({
    harvestYcDirectory: async () => {
      calls++;
      return { companies: 3, probed: 3, added: 2, errors: [] };
    },
  }));

  expect(calls).toBe(1);
  const written = readSeekMeta(db, 'ycdir_last_run');
  expect(written).not.toBeNull();
  expect(Number.isNaN(new Date(written!).getTime())).toBe(false);

  const ycdirResult = results.find(r => r.source === 'ycdir')!;
  expect(ycdirResult.fetched).toBe(0);
  expect(ycdirResult.boardsAdded).toBe(2);
  expect(listPostings(db)).toHaveLength(0);
});

test('with ycdir_last_run 2 days ago, the harvest stub is not invoked', async () => {
  const db = makeDb();
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  writeSeekMeta(db, 'ycdir_last_run', twoDaysAgo.toISOString());
  const config = disabledSourcesConfig({ ycdir: { enabled: true } });
  let calls = 0;
  const results = await runSweep(db, config, baseDeps({
    harvestYcDirectory: async () => {
      calls++;
      return { companies: 0, probed: 0, added: 0, errors: [] };
    },
  }));

  expect(calls).toBe(0);
  expect(results.some(r => r.source === 'ycdir')).toBe(false);
});

test('with ycdir_last_run 8 days ago, the harvest stub is invoked', async () => {
  const db = makeDb();
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  writeSeekMeta(db, 'ycdir_last_run', eightDaysAgo.toISOString());
  const config = disabledSourcesConfig({ ycdir: { enabled: true } });
  let calls = 0;
  const results = await runSweep(db, config, baseDeps({
    harvestYcDirectory: async () => {
      calls++;
      return { companies: 0, probed: 0, added: 0, errors: [] };
    },
  }));

  expect(calls).toBe(1);
  expect(results.some(r => r.source === 'ycdir')).toBe(true);
});

test('a throwing harvest leaves ycdir_last_run unchanged and pushes an error result while other sources complete', async () => {
  const db = makeDb();
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  writeSeekMeta(db, 'ycdir_last_run', twoWeeksAgo.toISOString());
  const config = disabledSourcesConfig({ ycdir: { enabled: true }, hn: { enabled: true } });
  const results = await runSweep(db, config, baseDeps({
    harvestYcDirectory: async () => {
      throw new Error('ycdir probe down');
    },
    fetchHNPostings: async () => [makePosting({ source: 'hn', url: 'https://news.ycombinator.com/item?id=1' })],
  }));

  expect(readSeekMeta(db, 'ycdir_last_run')).toBe(twoWeeksAgo.toISOString());
  const bySource = Object.fromEntries(results.map(r => [r.source, r]));
  expect(bySource.ycdir.error).toBe('ycdir probe down');
  expect(bySource.hn.fetched).toBe(1);
  expect(listPostings(db)).toHaveLength(1);
});

// --- D-05/D-06/D-10 seed sync prologue: one-time backdated backfill, then
// the per-sweep idempotent config->boards sync ---

test('a fresh sweep gives every config token a seed boards row backdated to the sentinel, and sets the one-time flag', async () => {
  const db = makeDb();
  const config = baseConfig({
    greenhouse: { enabled: true, tokens: ['acme'] },
    lever: { enabled: true, tokens: ['acme'] },
    ashby: { enabled: true, tokens: ['acme'] },
    hn: { enabled: false },
  });
  await runSweep(db, config, baseDeps());

  const boards = db.query('SELECT ats, token, first_seen_at, source_of_discovery FROM boards').all() as {
    ats: string;
    token: string;
    first_seen_at: string;
    source_of_discovery: string;
  }[];
  expect(boards).toHaveLength(3);
  for (const b of boards) {
    expect(b.first_seen_at).toBe(SEED_BACKFILL_FIRST_SEEN);
    expect(b.source_of_discovery).toBe('seed');
  }
  expect(readSeekMeta(db, 'seed_backfill_v1')).not.toBeNull();
});

test('a second runSweep on the same DB does not re-run the backfill and leaves first_seen_at at the sentinel (D-10 one-time gate)', async () => {
  const db = makeDb();
  const config = baseConfig({
    greenhouse: { enabled: true, tokens: ['acme'] },
    lever: { enabled: true, tokens: ['acme'] },
    ashby: { enabled: true, tokens: ['acme'] },
    hn: { enabled: false },
  });
  await runSweep(db, config, baseDeps());
  await runSweep(db, config, baseDeps());

  const boards = db.query('SELECT first_seen_at FROM boards').all() as { first_seen_at: string }[];
  expect(boards).toHaveLength(3);
  for (const b of boards) {
    expect(b.first_seen_at).toBe(SEED_BACKFILL_FIRST_SEEN);
  }
});

test('a token added to the config after the flag is set enters grace with first_seen_at = now(), not the sentinel (D-06)', async () => {
  const db = makeDb();
  const config1 = baseConfig({
    greenhouse: { enabled: true, tokens: ['acme'] },
    lever: { enabled: false, tokens: [] },
    ashby: { enabled: false, tokens: [] },
    hn: { enabled: false },
  });
  await runSweep(db, config1, baseDeps());

  const config2 = baseConfig({
    greenhouse: { enabled: true, tokens: ['acme', 'beta'] },
    lever: { enabled: false, tokens: [] },
    ashby: { enabled: false, tokens: [] },
    hn: { enabled: false },
  });
  await runSweep(db, config2, baseDeps());

  const beta = db.query('SELECT first_seen_at FROM boards WHERE token = ?').get('beta') as { first_seen_at: string };
  expect(beta.first_seen_at).not.toBe(SEED_BACKFILL_FIRST_SEEN);
});

test('a pre-existing simplify-discovered row is repaired to the sentinel on the first backfill, keeping its source_of_discovery (D-10 repair proof)', async () => {
  const db = makeDb();
  upsertBoard(db, { ats: 'greenhouse', token: 'acme', source_of_discovery: 'simplify' });
  db.run(`UPDATE boards SET first_seen_at = '2026-07-24 20:52:27' WHERE ats = 'greenhouse' AND token = 'acme'`);

  const config = baseConfig({
    greenhouse: { enabled: true, tokens: ['acme'] },
    lever: { enabled: false, tokens: [] },
    ashby: { enabled: false, tokens: [] },
    hn: { enabled: false },
  });
  await runSweep(db, config, baseDeps());

  const row = db.query('SELECT first_seen_at, source_of_discovery FROM boards WHERE token = ?').get('acme') as {
    first_seen_at: string;
    source_of_discovery: string;
  };
  expect(row.first_seen_at).toBe(SEED_BACKFILL_FIRST_SEEN);
  expect(row.source_of_discovery).toBe('simplify');
});

test('a token in config.blocklist gets no boards row from the seed sync', async () => {
  const db = makeDb();
  const config = baseConfig({
    greenhouse: { enabled: true, tokens: ['acme', 'blocked'] },
    lever: { enabled: false, tokens: [] },
    ashby: { enabled: false, tokens: [] },
    hn: { enabled: false },
    blocklist: ['blocked'],
  });
  await runSweep(db, config, baseDeps());

  const boards = db.query('SELECT token FROM boards').all() as { token: string }[];
  expect(boards.map(b => b.token)).toEqual(['acme']);
});

test('a throwing backfillSeedBoards degrades silently and the sweep completes normally', async () => {
  const db = new Database(':memory:');
  createPostingsTable(db);
  createSeekMetaTable(db); // deliberately no createBoardsTable(db) -- forces the backfill's INSERT to throw
  const config = disabledSourcesConfig({ hn: { enabled: true }, greenhouse: { enabled: false, tokens: ['acme'] } });
  const results = await runSweep(db, config, baseDeps({
    // Stubbed so this test isolates the backfill throw, rather than also
    // hitting the missing boards table via the real resolveEffectiveTokens.
    resolveEffectiveTokens: () => [],
    fetchHNPostings: async () => [makePosting({ source: 'hn', url: 'https://news.ycombinator.com/item?id=1' })],
  }));

  expect(results.some(r => r.error)).toBe(false);
  const hn = results.find(r => r.source === 'hn')!;
  expect(hn.fetched).toBe(1);
  expect(readSeekMeta(db, 'seed_backfill_v1')).toBeNull();
});

test('deps.upsertBoard throwing during the ordinary per-sweep sync degrades silently and the sweep completes normally', async () => {
  const db = makeDb();
  writeSeekMeta(db, 'seed_backfill_v1', new Date().toISOString()); // flag already set -> ordinary sync path
  const config = disabledSourcesConfig({ hn: { enabled: true }, greenhouse: { enabled: true, tokens: ['acme'] } });
  const results = await runSweep(db, config, baseDeps({
    upsertBoard: () => {
      throw new Error('boom');
    },
    fetchGreenhouse: async () => ({ postings: [], errors: [] }),
    fetchHNPostings: async () => [makePosting({ source: 'hn', url: 'https://news.ycombinator.com/item?id=1' })],
  }));

  expect(results.some(r => r.error)).toBe(false);
});

test('the seed sync never contributes to any SourceResult.boardsAdded value', async () => {
  const db = makeDb();
  const config = baseConfig();
  const results = await runSweep(db, config, baseDeps());
  for (const r of results) {
    expect(r.boardsAdded).toBeUndefined();
  }
});

test('sources disabled in config still have their tokens synced into boards (config membership, not enablement, defines the set)', async () => {
  const db = makeDb();
  const config = baseConfig({
    greenhouse: { enabled: false, tokens: ['acme'] },
    lever: { enabled: false, tokens: ['acme'] },
    ashby: { enabled: false, tokens: ['acme'] },
    hn: { enabled: false },
  });
  await runSweep(db, config, baseDeps());

  const boards = db.query('SELECT ats, token, source_of_discovery FROM boards').all() as {
    ats: string;
    token: string;
    source_of_discovery: string;
  }[];
  expect(boards).toHaveLength(3);
  for (const b of boards) {
    expect(b.token).toBe('acme');
    expect(b.source_of_discovery).toBe('seed');
  }
});
