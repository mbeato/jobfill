import { test, expect } from 'bun:test';
import { normalizeGreenhouseJob, fetchGreenhouse } from './greenhouse';
import { normalizeLeverPosting, fetchLever } from './lever';
import { normalizeAshbyJob, fetchAshby } from './ashby';

// Trimmed real shapes captured via curl against public boards (see 09-02 SUMMARY spot-check).
const rawGreenhouseJob = {
  absolute_url: 'https://stripe.com/jobs/search?gh_jid=7954688',
  location: { name: 'San Francisco, CA' },
  updated_at: '2026-07-21T18:51:19-04:00',
  id: 7954688,
  title: 'Account Executive, AI Sales (Grower)',
};

const rawLeverPosting = {
  text: 'Administrative Business Partner',
  categories: {
    commitment: 'Full-time',
    location: 'London, United Kingdom',
    team: 'Administrative',
  },
  hostedUrl: 'https://jobs.lever.co/palantir/ac978161-6f46-4f6b-ad9e-a258e642751c',
  createdAt: 1711403416463,
};

const rawAshbyJob = {
  id: '34413f8d-26bf-4bbc-8ade-eb309a0e2245',
  title: 'Security Engineer, Cloud',
  location: 'New York, NY (HQ)',
  jobUrl: 'https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245',
  publishedAt: '2026-04-07T17:12:35.753+00:00',
};

function fakeFetch(body: unknown, ok = true, status = 200) {
  return async () =>
    ({
      ok,
      status,
      json: async () => body,
    }) as Response;
}

// Per-token-aware stub: keyed by token, the fetchImpl inspects the requested
// URL to decide which entry to serve, defaulting to a 404 for unknown tokens.
// Entries with body === 'UNPARSEABLE' simulate a JSON parse failure.
type TokenStubEntry = { ok: boolean; status?: number; body?: unknown };

function fakeFetchByToken(entries: Record<string, TokenStubEntry>) {
  return async (url: string) => {
    const token = Object.keys(entries).find((t) => url.includes(`/${t}`) || url.includes(`/${t}?`));
    const entry = token ? entries[token] : undefined;
    if (!entry) {
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }
    if (entry.body === 'UNPARSEABLE') {
      return {
        ok: entry.ok,
        status: entry.status ?? 200,
        json: async () => {
          throw new Error('unexpected token in JSON at position 0');
        },
      } as unknown as Response;
    }
    return {
      ok: entry.ok,
      status: entry.status ?? (entry.ok ? 200 : 404),
      json: async () => entry.body ?? {},
    } as unknown as Response;
  };
}

test('normalizeGreenhouseJob maps a raw Greenhouse job to the shared shape with posted_at_trusted false', () => {
  const posting = normalizeGreenhouseJob(rawGreenhouseJob, 'stripe');
  expect(posting.source).toBe('greenhouse');
  expect(posting.url).toBe('https://stripe.com/jobs/search?gh_jid=7954688');
  expect(posting.company).toBe('stripe');
  expect(posting.title).toBe('Account Executive, AI Sales (Grower)');
  expect(posting.location).toBe('San Francisco, CA');
  expect(posting.posted_at).toBe('2026-07-21T18:51:19-04:00');
  expect(posting.posted_at_trusted).toBe(false);
  expect(posting.login_gated).toBe(false);
});

test('normalizeGreenhouseJob tolerates a missing location without throwing', () => {
  const { location: _drop, ...noLocation } = rawGreenhouseJob;
  expect(() => normalizeGreenhouseJob(noLocation, 'stripe')).not.toThrow();
  expect(normalizeGreenhouseJob(noLocation, 'stripe').location).toBe('');
});

test('fetchGreenhouse maps a stubbed response body through normalizeGreenhouseJob', async () => {
  const stub = fakeFetch({ jobs: [rawGreenhouseJob] });
  const result = await fetchGreenhouse(['stripe'], stub);
  expect(result.postings).toHaveLength(1);
  expect(result.postings[0].source).toBe('greenhouse');
  expect(result.postings[0].posted_at_trusted).toBe(false);
  expect(result.errors).toHaveLength(0);
});

test('fetchGreenhouse isolates a bad token among many (D-03): good token still resolves, bad tokens are recorded, never thrown', async () => {
  const stub = fakeFetchByToken({
    good: { ok: true, body: { jobs: [rawGreenhouseJob] } },
    notfound: { ok: false, status: 404 },
    badjson: { ok: true, body: 'UNPARSEABLE' },
  });
  const result = await fetchGreenhouse(['good', 'notfound', 'badjson'], stub);
  expect(result.postings).toHaveLength(1);
  expect(result.errors).toHaveLength(2);
  expect(result.errors.map((e) => e.token).sort()).toEqual(['badjson', 'notfound']);
  const notfoundErr = result.errors.find((e) => e.token === 'notfound')!;
  const badjsonErr = result.errors.find((e) => e.token === 'badjson')!;
  expect(notfoundErr.error).toMatch(/fetchGreenhouse/);
  expect(notfoundErr.error).toMatch(/404/);
  expect(badjsonErr.error).toMatch(/fetchGreenhouse/);
  expect(badjsonErr.error).toMatch(/unparseable JSON/);
});

test('fetchGreenhouse respects a bounded concurrency argument (D-05): max in-flight never exceeds the cap over 20 tokens', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const tokens = Array.from({ length: 20 }, (_, i) => `t${i}`);
  const stub = async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    return {
      ok: true,
      status: 200,
      json: async () => ({ jobs: [rawGreenhouseJob] }),
    } as unknown as Response;
  };
  const result = await fetchGreenhouse(tokens, stub, 3);
  expect(result.postings).toHaveLength(20);
  expect(result.errors).toHaveLength(0);
  expect(maxInFlight).toBeLessThanOrEqual(3);
});

test('normalizeLeverPosting maps a raw Lever posting to the shared shape with posted_at_trusted true', () => {
  const posting = normalizeLeverPosting(rawLeverPosting, 'palantir');
  expect(posting.source).toBe('lever');
  expect(posting.url).toBe('https://jobs.lever.co/palantir/ac978161-6f46-4f6b-ad9e-a258e642751c');
  expect(posting.company).toBe('palantir');
  expect(posting.title).toBe('Administrative Business Partner');
  expect(posting.location).toBe('London, United Kingdom');
  expect(posting.posted_at).toBe(new Date(1711403416463).toISOString());
  expect(posting.posted_at_trusted).toBe(true);
  expect(posting.login_gated).toBe(false);
});

test('normalizeLeverPosting tolerates a missing categories.location without throwing', () => {
  const { categories: _drop, ...noCategories } = rawLeverPosting;
  expect(() => normalizeLeverPosting(noCategories, 'palantir')).not.toThrow();
  expect(normalizeLeverPosting(noCategories, 'palantir').location).toBe('');
});

test('fetchLever maps a stubbed bare-array response through normalizeLeverPosting', async () => {
  const stub = fakeFetch([rawLeverPosting]);
  const result = await fetchLever(['palantir'], stub);
  expect(result.postings).toHaveLength(1);
  expect(result.postings[0].source).toBe('lever');
  expect(result.postings[0].posted_at_trusted).toBe(true);
  expect(result.errors).toHaveLength(0);
});

test('fetchLever isolates a bad token among many (D-03): good token still resolves, bad tokens are recorded, never thrown', async () => {
  const stub = fakeFetchByToken({
    good: { ok: true, body: [rawLeverPosting] },
    notfound: { ok: false, status: 404 },
    badjson: { ok: true, body: 'UNPARSEABLE' },
  });
  const result = await fetchLever(['good', 'notfound', 'badjson'], stub);
  expect(result.postings).toHaveLength(1);
  expect(result.errors).toHaveLength(2);
  expect(result.errors.map((e) => e.token).sort()).toEqual(['badjson', 'notfound']);
  const notfoundErr = result.errors.find((e) => e.token === 'notfound')!;
  const badjsonErr = result.errors.find((e) => e.token === 'badjson')!;
  expect(notfoundErr.error).toMatch(/fetchLever/);
  expect(notfoundErr.error).toMatch(/404/);
  expect(badjsonErr.error).toMatch(/fetchLever/);
  expect(badjsonErr.error).toMatch(/unparseable JSON/);
});

test('normalizeAshbyJob maps a raw Ashby job to the shared shape with posted_at_trusted true', () => {
  const posting = normalizeAshbyJob(rawAshbyJob, 'ramp');
  expect(posting.source).toBe('ashby');
  expect(posting.url).toBe('https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245');
  expect(posting.company).toBe('ramp');
  expect(posting.title).toBe('Security Engineer, Cloud');
  expect(posting.location).toBe('New York, NY (HQ)');
  expect(posting.posted_at).toBe('2026-04-07T17:12:35.753+00:00');
  expect(posting.posted_at_trusted).toBe(true);
  expect(posting.login_gated).toBe(false);
});

test('normalizeAshbyJob tolerates a missing location without throwing', () => {
  const { location: _drop, ...noLocation } = rawAshbyJob;
  expect(() => normalizeAshbyJob(noLocation, 'ramp')).not.toThrow();
  expect(normalizeAshbyJob(noLocation, 'ramp').location).toBe('');
});

test('fetchAshby maps a stubbed response body through normalizeAshbyJob', async () => {
  const stub = fakeFetch({ jobs: [rawAshbyJob] });
  const result = await fetchAshby(['ramp'], stub);
  expect(result.postings).toHaveLength(1);
  expect(result.postings[0].source).toBe('ashby');
  expect(result.postings[0].posted_at_trusted).toBe(true);
  expect(result.errors).toHaveLength(0);
});

test('fetchAshby isolates a bad token among many (D-03): good token still resolves, bad tokens are recorded, never thrown', async () => {
  const stub = fakeFetchByToken({
    good: { ok: true, body: { jobs: [rawAshbyJob] } },
    notfound: { ok: false, status: 404 },
    badjson: { ok: true, body: 'UNPARSEABLE' },
  });
  const result = await fetchAshby(['good', 'notfound', 'badjson'], stub);
  expect(result.postings).toHaveLength(1);
  expect(result.errors).toHaveLength(2);
  expect(result.errors.map((e) => e.token).sort()).toEqual(['badjson', 'notfound']);
  const notfoundErr = result.errors.find((e) => e.token === 'notfound')!;
  const badjsonErr = result.errors.find((e) => e.token === 'badjson')!;
  expect(notfoundErr.error).toMatch(/fetchAshby/);
  expect(notfoundErr.error).toMatch(/404/);
  expect(badjsonErr.error).toMatch(/fetchAshby/);
  expect(badjsonErr.error).toMatch(/unparseable JSON/);
});
