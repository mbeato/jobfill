import { test, expect } from 'bun:test';
import { normalizeGreenhouseJob, fetchGreenhouse } from './greenhouse';
import { normalizeLeverPosting, fetchLever } from './lever';

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

function fakeFetch(body: unknown, ok = true, status = 200) {
  return async () =>
    ({
      ok,
      status,
      json: async () => body,
    }) as Response;
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
  const postings = await fetchGreenhouse(['stripe'], stub);
  expect(postings).toHaveLength(1);
  expect(postings[0].source).toBe('greenhouse');
  expect(postings[0].posted_at_trusted).toBe(false);
});

test('fetchGreenhouse throws when the stub response is non-2xx', async () => {
  const stub = fakeFetch({}, false, 404);
  await expect(fetchGreenhouse(['nonexistent'], stub)).rejects.toThrow();
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
  const postings = await fetchLever(['palantir'], stub);
  expect(postings).toHaveLength(1);
  expect(postings[0].source).toBe('lever');
  expect(postings[0].posted_at_trusted).toBe(true);
});

test('fetchLever throws when the stub response is non-2xx', async () => {
  const stub = fakeFetch({}, false, 404);
  await expect(fetchLever(['nonexistent'], stub)).rejects.toThrow();
});
