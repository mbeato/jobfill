import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createPostingsTable, upsertPosting, listPostings } from './postings';
import { runSweep } from './sweep';
import type { NormalizedPosting, SeekConfig } from './types';

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
    ...overrides,
  };
}

function makeDb() {
  const db = new Database(':memory:');
  createPostingsTable(db);
  return db;
}

test('runSweep with all four fetchers succeeding returns one summary entry per source and upserts postings', async () => {
  const db = makeDb();
  const config = baseConfig();
  const results = await runSweep(db, config, {
    fetchGreenhouse: async () => ({ postings: [makePosting({ source: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/1' })], errors: [] }),
    fetchLever: async () => ({ postings: [makePosting({ source: 'lever', url: 'https://jobs.lever.co/acme/1' })], errors: [] }),
    fetchAshby: async () => ({ postings: [makePosting({ source: 'ashby', url: 'https://jobs.ashbyhq.com/acme/1' })], errors: [] }),
    fetchHNPostings: async () => [makePosting({ source: 'hn', url: 'https://news.ycombinator.com/item?id=1' })],
    upsertPosting,
  });

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
  const results = await runSweep(db, config, {
    fetchGreenhouse: async () => ({ postings: [makePosting({ source: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/1' })], errors: [] }),
    fetchLever: async () => {
      throw new Error('lever API down');
    },
    fetchAshby: async () => ({ postings: [makePosting({ source: 'ashby', url: 'https://jobs.ashbyhq.com/acme/1' })], errors: [] }),
    fetchHNPostings: async () => [makePosting({ source: 'hn', url: 'https://news.ycombinator.com/item?id=1' })],
    upsertPosting,
  });

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
  const results = await runSweep(db, config, {
    fetchGreenhouse: async () => ({ postings: [makePosting({ source: 'greenhouse' })], errors: [] }),
    fetchLever: async () => ({ postings: [makePosting({ source: 'lever', url: 'https://jobs.lever.co/acme/1' })], errors: [] }),
    fetchAshby: async () => ({ postings: [makePosting({ source: 'ashby', url: 'https://jobs.ashbyhq.com/acme/1' })], errors: [] }),
    fetchHNPostings: async () => {
      hnCalls++;
      return [makePosting({ source: 'hn', url: 'https://news.ycombinator.com/item?id=1' })];
    },
    upsertPosting,
  });

  expect(hnCalls).toBe(0);
  expect(results.some(r => r.source === 'hn')).toBe(false);
  expect(results).toHaveLength(3);
});

test('runSweep surfaces tokenErrors when a fetcher returns { postings, errors } (D-03)', async () => {
  const db = makeDb();
  const config = baseConfig();
  const results = await runSweep(db, config, {
    fetchGreenhouse: async () => ({
      postings: [makePosting({ source: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/1' })],
      errors: [{ token: 'x', error: 'HTTP 404' }],
    }),
    fetchLever: async () => ({ postings: [], errors: [] }),
    fetchAshby: async () => ({ postings: [], errors: [] }),
    fetchHNPostings: async () => [],
    upsertPosting,
  });

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
  const results = await runSweep(db, config, {
    fetchGreenhouse: async () => [makePosting({ source: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/1' })],
    fetchLever: async () => [],
    fetchAshby: async () => [],
    fetchHNPostings: async () => [],
    upsertPosting,
  });

  const gh = results.find(r => r.source === 'greenhouse')!;
  expect(gh.tokenErrors).toBeUndefined();
  expect(gh.sampleTokenErrors).toBeUndefined();
});

test('runSweep caps sampleTokenErrors at 5 while tokenErrors counts the full error set', async () => {
  const db = makeDb();
  const config = baseConfig();
  const nineErrors = Array.from({ length: 9 }, (_, i) => ({ token: `t${i}`, error: 'boom' }));
  const results = await runSweep(db, config, {
    fetchGreenhouse: async () => ({ postings: [], errors: nineErrors }),
    fetchLever: async () => ({ postings: [], errors: [] }),
    fetchAshby: async () => ({ postings: [], errors: [] }),
    fetchHNPostings: async () => [],
    upsertPosting,
  });

  const gh = results.find(r => r.source === 'greenhouse')!;
  expect(gh.tokenErrors).toBe(9);
  expect(gh.sampleTokenErrors).toHaveLength(5);
});
