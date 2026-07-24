import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createPostingsTable, upsertPosting, listPostings } from './postings';
import { createBoardsTable, upsertBoard, recordBoardResult, resolveEffectiveTokens } from './boards';
import { createSeekMetaTable } from './meta';
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
