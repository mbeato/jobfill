import { test, expect } from 'bun:test';
import { fetchJD, assertAllowedHost } from './jd-fetch';
import type { PostingRow } from './postings';

function makePosting(overrides: Partial<PostingRow> & Pick<PostingRow, 'url' | 'company' | 'source'>): PostingRow {
  return {
    id: 1,
    url_key: overrides.url,
    title: '',
    location: '',
    posted_at: null,
    posted_at_trusted: false,
    login_gated: false,
    not_fillable: false,
    low_confidence: false,
    fetched_at: '2026-07-22T00:00:00Z',
    created_at: '2026-07-22T00:00:00Z',
    ...overrides,
  };
}

function fakeFetch(body: unknown, ok = true, status = 200) {
  return async () =>
    ({
      ok,
      status,
      json: async () => body,
      text: async () => String(body),
    }) as Response;
}

// Real shapes captured via a live curl against public APIs (see plan's discovery notes).
const rawGreenhouseDetail = {
  content: '&lt;h2&gt;Who we are&lt;/h2&gt;\n&lt;p&gt;Stripe is a financial infrastructure platform.&lt;/p&gt;',
};

const rawLeverDetail = {
  descriptionPlain: 'A World-Changing Company\n\nPalantir builds software.',
  description: '<div>A World-Changing Company</div>',
};

const rawAshbyBoard = {
  jobs: [
    {
      id: '34413f8d-26bf-4bbc-8ade-eb309a0e2245',
      descriptionHtml: '<h1>About Ramp</h1><p>Ramp is building finance infrastructure.</p>',
    },
  ],
};

test('fetchJD (greenhouse): returns stripped content text via the gh_jid query-param url shape', async () => {
  const posting = makePosting({
    source: 'greenhouse',
    company: 'stripe',
    url: 'https://stripe.com/jobs/search?gh_jid=7954688',
  });
  const stub = fakeFetch(rawGreenhouseDetail);
  const text = await fetchJD(posting, stub);
  expect(text).toContain('Who we are');
  expect(text).toContain('Stripe is a financial infrastructure platform.');
  expect(text).not.toContain('&lt;');
});

test('fetchJD (greenhouse): also extracts the id from a default boards.greenhouse.io path url', async () => {
  const posting = makePosting({
    source: 'greenhouse',
    company: 'stripe',
    url: 'https://boards.greenhouse.io/stripe/jobs/7954688',
  });
  const stub = fakeFetch(rawGreenhouseDetail);
  const text = await fetchJD(posting, stub);
  expect(text).toContain('Who we are');
});

test('fetchJD (lever): returns descriptionPlain', async () => {
  const posting = makePosting({
    source: 'lever',
    company: 'palantir',
    url: 'https://jobs.lever.co/palantir/ac978161-6f46-4f6b-ad9e-a258e642751c',
  });
  const stub = fakeFetch(rawLeverDetail);
  const text = await fetchJD(posting, stub);
  expect(text).toBe('A World-Changing Company\n\nPalantir builds software.');
});

test('fetchJD (lever): falls back to stripped description when descriptionPlain is absent', async () => {
  const posting = makePosting({
    source: 'lever',
    company: 'palantir',
    url: 'https://jobs.lever.co/palantir/ac978161-6f46-4f6b-ad9e-a258e642751c/apply',
  });
  const stub = fakeFetch({ description: rawLeverDetail.description });
  const text = await fetchJD(posting, stub);
  expect(text).toContain('A World-Changing Company');
});

test('fetchJD (ashby): finds the matching job in the board listing and strips descriptionHtml', async () => {
  const posting = makePosting({
    source: 'ashby',
    company: 'ramp',
    url: 'https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245',
  });
  const stub = fakeFetch(rawAshbyBoard);
  const text = await fetchJD(posting, stub);
  expect(text).toContain('About Ramp');
  expect(text).toContain('Ramp is building finance infrastructure.');
});

test('fetchJD throws for a stubbed non-2xx greenhouse response', async () => {
  const posting = makePosting({
    source: 'greenhouse',
    company: 'stripe',
    url: 'https://stripe.com/jobs/search?gh_jid=7954688',
  });
  const stub = fakeFetch({}, false, 404);
  await expect(fetchJD(posting, stub)).rejects.toThrow();
});

test('fetchJD throws for a stubbed non-2xx lever response', async () => {
  const posting = makePosting({
    source: 'lever',
    company: 'palantir',
    url: 'https://jobs.lever.co/palantir/ac978161-6f46-4f6b-ad9e-a258e642751c',
  });
  const stub = fakeFetch({}, false, 404);
  await expect(fetchJD(posting, stub)).rejects.toThrow();
});

test('fetchJD throws for a stubbed non-2xx ashby response', async () => {
  const posting = makePosting({
    source: 'ashby',
    company: 'ramp',
    url: 'https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245',
  });
  const stub = fakeFetch({}, false, 404);
  await expect(fetchJD(posting, stub)).rejects.toThrow();
});

test('fetchJD (hn permalink): fetches the Algolia item and strips its HTML', async () => {
  const posting = makePosting({
    source: 'hn',
    company: 'Some Co',
    title: 'Backend Engineer',
    location: 'NYC',
    url: 'https://news.ycombinator.com/item?id=123456',
  });
  const stub = fakeFetch({ text: '<p>Some Co | Backend Engineer | NYC</p>' });
  const text = await fetchJD(posting, stub);
  expect(text).toContain('Some Co | Backend Engineer | NYC');
});

test('fetchJD (hn external apply link): returns the metadata fallback without calling fetchImpl', async () => {
  const posting = makePosting({
    source: 'hn',
    company: 'Some Co',
    title: 'Backend Engineer',
    location: 'NYC',
    url: 'https://example.com/careers/backend-engineer',
  });
  let called = false;
  const stub = async () => {
    called = true;
    return fakeFetch({})();
  };
  const text = await fetchJD(posting, stub);
  expect(text).toBe('Some Co Backend Engineer NYC');
  expect(called).toBe(false);
});

test('assertAllowedHost throws for a hostname not in the ALLOWED_HOSTS set (SSRF guard)', () => {
  expect(() => assertAllowedHost('https://evil.example.com/jobs/1')).toThrow();
  expect(() => assertAllowedHost('https://boards-api.greenhouse.io/v1/boards/x/jobs/1')).not.toThrow();
});
