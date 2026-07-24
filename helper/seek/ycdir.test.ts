import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  YC_API_URL,
  MAX_YC_PAGES,
  fetchNewestBatches,
  fetchBatchCompanies,
  deriveCandidateSlugs,
  probeAts,
  shouldRunYcDir,
  harvestYcDirectory,
  YCDIR_INTERVAL_DAYS,
} from './ycdir';
import { createBoardsTable, upsertBoard, type BoardRow } from './boards';
import { createPostingsTable } from './postings';

// Real captured page-1 record (Conifer, S26), verified live 2026-07-24.
const CONIFER = {
  id: 33936,
  name: 'Conifer',
  slug: 'conifer',
  website: 'https://www.conifer.build',
  oneLiner: 'Local-first least cost routing system to reduce 80%+ token spend',
  teamSize: 3,
  url: 'https://www.ycombinator.com/companies/conifer',
  batch: 'S26',
  status: 'Active',
  badges: [],
};

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function makeDb(): Database {
  const db = new Database(':memory:');
  createBoardsTable(db);
  createPostingsTable(db);
  return db;
}

// --- fetchNewestBatches / fetchBatchCompanies (Task 1) ---

test('fetchNewestBatches returns distinct batch codes in order, duplicates collapsed', async () => {
  const stub = async () =>
    jsonRes({ companies: [{ batch: 'W27' }, { batch: 'S26' }, { batch: 'S26' }, { batch: 'F26' }] });
  const batches = await fetchNewestBatches(stub);
  expect(batches).toEqual(['W27', 'S26', 'F26']);
});

test('fetchNewestBatches throws a descriptive error on a non-2xx response', async () => {
  const stub = async () => jsonRes({}, false, 500);
  await expect(fetchNewestBatches(stub)).rejects.toThrow(/HTTP 500/);
});

test('fetchBatchCompanies walks 3 pages when totalPages: 3 and returns their concatenated companies', async () => {
  const calls: string[] = [];
  const stub = async (url: string) => {
    calls.push(url);
    const page = Number(new URL(url).searchParams.get('page'));
    return jsonRes({ companies: [{ ...CONIFER, name: `Co${page}`, slug: `co${page}` }], totalPages: 3 });
  };
  const companies = await fetchBatchCompanies('S26', stub);
  expect(calls).toHaveLength(3);
  expect(companies.map(c => c.slug)).toEqual(['co1', 'co2', 'co3']);
});

test('fetchBatchCompanies stops at MAX_YC_PAGES when totalPages is absurd', async () => {
  let calls = 0;
  const stub = async () => {
    calls++;
    return jsonRes({ companies: [], totalPages: 9999 });
  };
  await fetchBatchCompanies('S26', stub);
  expect(calls).toBe(MAX_YC_PAGES);
});

test('fetchBatchCompanies rejects on a non-2xx page', async () => {
  const stub = async () => jsonRes({}, false, 503);
  await expect(fetchBatchCompanies('S26', stub)).rejects.toThrow(/S26/);
});

test('fetchBatchCompanies with an empty companies array yields [] without throwing', async () => {
  const stub = async () => jsonRes({ companies: [], totalPages: 1 });
  const companies = await fetchBatchCompanies('S26', stub);
  expect(companies).toEqual([]);
});

test('fetchBatchCompanies percent-encodes the batch code in the request URL', async () => {
  const calls: string[] = [];
  const stub = async (url: string) => {
    calls.push(url);
    return jsonRes({ companies: [], totalPages: 1 });
  };
  await fetchBatchCompanies('S 26', stub);
  expect(calls[0]).toContain(encodeURIComponent('S 26'));
});

// --- deriveCandidateSlugs (Task 2) ---

test('deriveCandidateSlugs collapses matching slug and website-domain candidates', () => {
  expect(deriveCandidateSlugs({ slug: 'conifer', website: 'https://www.conifer.build' })).toEqual(['conifer']);
});

test('deriveCandidateSlugs yields both candidates, slug first, when slug and domain differ', () => {
  expect(deriveCandidateSlugs({ slug: 'acme', website: 'https://foobar.io' })).toEqual(['acme', 'foobar']);
});

test('deriveCandidateSlugs tolerates an empty/garbage website without throwing', () => {
  expect(() => deriveCandidateSlugs({ slug: 'acme', website: 'not a url' })).not.toThrow();
  expect(deriveCandidateSlugs({ slug: 'acme', website: 'not a url' })).toEqual(['acme']);
  expect(deriveCandidateSlugs({ slug: '', website: '' })).toEqual([]);
});

test('deriveCandidateSlugs drops a slug containing a slash, a space, or too long', () => {
  expect(deriveCandidateSlugs({ slug: 'a/b', website: '' })).toEqual([]);
  expect(deriveCandidateSlugs({ slug: 'a b', website: '' })).toEqual([]);
  expect(deriveCandidateSlugs({ slug: 'a'.repeat(100), website: '' })).toEqual([]);
});

// --- probeAts (Task 2) ---

test('probeAts returns the first ATS whose template 2xxs, recorded URLs are exactly the three hardcoded templates', async () => {
  const requested: string[] = [];
  const stub = async (url: string) => {
    requested.push(url);
    return jsonRes({}, url.includes('api.lever.co'), url.includes('api.lever.co') ? 200 : 404);
  };
  const result = await probeAts('acme', stub);
  expect(result).toBe('lever');
  // Templates are tried in order and probing stops at the first 2xx (lever),
  // so ashby is never requested — every URL that IS requested must still be
  // exactly one of the three hardcoded templates with only the candidate varying.
  expect(requested).toEqual([
    'https://boards-api.greenhouse.io/v1/boards/acme/jobs',
    'https://api.lever.co/v0/postings/acme?mode=json',
  ]);
});

test('probeAts returns null when all three ATS templates 404', async () => {
  const stub = async () => jsonRes({}, false, 404);
  expect(await probeAts('acme', stub)).toBeNull();
});

test('probeAts SSRF-lite: a path-traversal or full-URL candidate returns null and issues zero fetches', async () => {
  const requested: string[] = [];
  const stub = async (url: string) => {
    requested.push(url);
    return jsonRes({}, true, 200);
  };
  expect(await probeAts('../../admin', stub)).toBeNull();
  expect(await probeAts('https://evil.example.com', stub)).toBeNull();
  expect(requested).toEqual([]);
});

test('probeAts isolates a network error on one ATS from the others', async () => {
  const stub = async (url: string) => {
    if (url.includes('greenhouse')) throw new Error('network error');
    return jsonRes({}, url.includes('api.ashbyhq.com'), url.includes('api.ashbyhq.com') ? 200 : 404);
  };
  expect(await probeAts('acme', stub)).toBe('ashby');
});

// --- shouldRunYcDir weekly gate (Task 3) ---

test('weeklyGate: null last-run returns true', () => {
  expect(shouldRunYcDir(new Date('2026-07-24T00:00:00Z'), null)).toBe(true);
});

test('weeklyGate: a last run 6 days 23 hours ago returns false', () => {
  expect(shouldRunYcDir(new Date('2026-07-24T00:00:00Z'), '2026-07-17T01:00:00Z')).toBe(false);
});

test('weeklyGate: exactly 7 days ago returns true', () => {
  expect(shouldRunYcDir(new Date('2026-07-24T00:00:00Z'), '2026-07-17T00:00:00Z')).toBe(true);
});

test('weeklyGate: an unparseable last-run string returns true', () => {
  expect(shouldRunYcDir(new Date('2026-07-24T00:00:00Z'), 'not-a-date')).toBe(true);
});

test('YCDIR_INTERVAL_DAYS is 7', () => {
  expect(YCDIR_INTERVAL_DAYS).toBe(7);
});

// --- harvestYcDirectory (Task 3) ---

function harvestStub(opts: { confirmSlug: string; confirmAts: 'greenhouse' | 'lever' | 'ashby'; deadSlug: string }) {
  const atsHost = { greenhouse: 'boards-api.greenhouse.io', lever: 'api.lever.co', ashby: 'api.ashbyhq.com' }[
    opts.confirmAts
  ];
  return async (url: string) => {
    if (url === YC_API_URL) return jsonRes({ companies: [{ batch: 'S26' }] });
    if (url.startsWith(`${YC_API_URL}?batch=S26&page=1`)) {
      return jsonRes({
        companies: [
          { name: 'Confirmco', slug: opts.confirmSlug, website: '', batch: 'S26' },
          { name: 'Deadco', slug: opts.deadSlug, website: '', batch: 'S26' },
        ],
        totalPages: 1,
      });
    }
    if (url.includes(atsHost) && url.includes(`/${opts.confirmSlug}`)) return jsonRes({}, true, 200);
    return jsonRes({}, false, 404);
  };
}

test('harvestYcDirectory: one company confirms on ashby, the other 404s everywhere -> exactly one boards row, added: 1', async () => {
  const db = makeDb();
  const stub = harvestStub({ confirmSlug: 'confirmco', confirmAts: 'ashby', deadSlug: 'deadco' });
  const result = await harvestYcDirectory({ db, fetchImpl: stub, upsertBoard, maxBatches: 1 });
  expect(result.added).toBe(1);
  expect(result.companies).toBe(2);
  const rows = db.query('SELECT * FROM boards').all() as BoardRow[];
  expect(rows).toHaveLength(1);
  expect(rows[0].ats).toBe('ashby');
  expect(rows[0].token).toBe('confirmco');
  expect(rows[0].source_of_discovery).toBe('ycdir');
});

test('harvestYcDirectory: postings table is empty afterward (D-17 slug-only contract)', async () => {
  const db = makeDb();
  const stub = harvestStub({ confirmSlug: 'confirmco', confirmAts: 'greenhouse', deadSlug: 'deadco' });
  await harvestYcDirectory({ db, fetchImpl: stub, upsertBoard, maxBatches: 1 });
  const postingsCount = db.query('SELECT COUNT(*) AS n FROM postings').get() as { n: number };
  expect(postingsCount.n).toBe(0);
});

test('harvestYcDirectory: a blocklisted confirmed slug produces zero rows', async () => {
  const db = makeDb();
  const stub = harvestStub({ confirmSlug: 'confirmco', confirmAts: 'lever', deadSlug: 'deadco' });
  const result = await harvestYcDirectory({
    db,
    fetchImpl: stub,
    upsertBoard,
    blocklist: ['confirmco'],
    maxBatches: 1,
  });
  expect(result.added).toBe(0);
  const rows = db.query('SELECT * FROM boards').all();
  expect(rows).toHaveLength(0);
});

test('harvestYcDirectory: a company whose write throws is recorded in errors while the other company still lands', async () => {
  const db = makeDb();
  const stub = async (url: string) => {
    if (url === YC_API_URL) return jsonRes({ companies: [{ batch: 'S26' }] });
    if (url.startsWith(`${YC_API_URL}?batch=S26&page=1`)) {
      return jsonRes({
        companies: [
          { name: 'Goodco', slug: 'goodco', website: '', batch: 'S26' },
          { name: 'Throwco', slug: 'throwco', website: '', batch: 'S26' },
        ],
        totalPages: 1,
      });
    }
    if (url.includes('api.ashbyhq.com') && (url.includes('/goodco') || url.includes('/throwco'))) {
      return jsonRes({}, true, 200);
    }
    return jsonRes({}, false, 404);
  };
  const throwingUpsertBoard: typeof upsertBoard = (dbArg, input, blocklist) => {
    if (input.token === 'throwco') throw new Error('simulated write failure');
    return upsertBoard(dbArg, input, blocklist);
  };
  const result = await harvestYcDirectory({ db, fetchImpl: stub, upsertBoard: throwingUpsertBoard, maxBatches: 1 });
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0].company).toBe('Throwco');
  const rows = db.query('SELECT * FROM boards').all() as BoardRow[];
  expect(rows).toHaveLength(1);
  expect(rows[0].token).toBe('goodco');
});

test('harvestYcDirectory: a batch fetch failure is recorded in errors without aborting the harvest', async () => {
  const db = makeDb();
  const stub = async (url: string) => {
    if (url === YC_API_URL) return jsonRes({ companies: [{ batch: 'S26' }] });
    return jsonRes({}, false, 500);
  };
  const result = await harvestYcDirectory({ db, fetchImpl: stub, upsertBoard, maxBatches: 1 });
  expect(result.errors).toHaveLength(1);
  expect(result.companies).toBe(0);
  expect(result.added).toBe(0);
});
