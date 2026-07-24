import { test, expect } from 'bun:test';
import { normalizeSimplifyListing, fetchSimplify, harvestSimplifyBoards, SIMPLIFY_URL } from './simplify';
import type { NormalizedPosting } from './types';

// Real captured entry from RESEARCH.md Pattern 5 (SimplifyJobs New-Grad-Positions
// listings.json, verified live 2026-07-24), plus a small factory for overrides.
const rawSimplifyListing = {
  source: 'Simplify',
  category: 'Quant',
  company_name: "Sainsbury's",
  id: 'dea59f44-ae6a-4e46-9214-862bc2ccfd6c',
  title: 'Trading Assistant - Shift',
  active: true,
  date_updated: 1764196648,
  date_posted: 1764196648,
  url: 'https://hdhe.fa.em3.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/400040167',
  locations: ['Oxford, UK'],
  company_url: 'https://simplify.jobs/c/Sainsburys',
  is_visible: true,
  sponsorship: 'Other',
  degrees: [] as string[],
};

function listing(overrides: Partial<typeof rawSimplifyListing> = {}) {
  return { ...rawSimplifyListing, ...overrides };
}

function fakeFetch(body: unknown, ok = true, status = 200) {
  return async () =>
    ({
      ok,
      status,
      json: async () => {
        if (body === 'UNPARSEABLE') throw new Error('unexpected token in JSON at position 0');
        return body;
      },
    }) as Response;
}

test('normalizeSimplifyListing maps company/title/url to the shared shape', () => {
  const posting = normalizeSimplifyListing(rawSimplifyListing);
  expect(posting.company).toBe("Sainsbury's");
  expect(posting.title).toBe('Trading Assistant - Shift');
  expect(posting.url).toBe(
    'https://hdhe.fa.em3.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/400040167',
  );
});

test('normalizeSimplifyListing joins a two-element locations array into one comma-separated string', () => {
  const posting = normalizeSimplifyListing(listing({ locations: ['Oxford, UK', 'London, UK'] }));
  expect(posting.location).toBe('Oxford, UK, London, UK');
});

test('normalizeSimplifyListing converts date_posted seconds to the ISO string of date_posted * 1000, not a raw ms interpretation', () => {
  const posting = normalizeSimplifyListing(listing({ date_posted: 1764196648 }));
  expect(posting.posted_at).toBe(new Date(1764196648 * 1000).toISOString());
  // This assertion fails loudly if anyone treats date_posted as milliseconds:
  expect(posting.posted_at).not.toBe(new Date(1764196648).toISOString());
});

test('normalizeSimplifyListing yields posted_at_trusted false and source simplify', () => {
  const posting = normalizeSimplifyListing(rawSimplifyListing);
  expect(posting.posted_at_trusted).toBe(false);
  expect(posting.source).toBe('simplify');
  expect(posting.login_gated).toBe(false);
});

test('normalizeSimplifyListing tolerates a missing locations array without throwing', () => {
  const { locations: _drop, ...noLocations } = rawSimplifyListing;
  expect(() => normalizeSimplifyListing(noLocations)).not.toThrow();
  expect(normalizeSimplifyListing(noLocations).location).toBe('');
});

test('normalizeSimplifyListing tolerates a missing company_name without throwing', () => {
  const { company_name: _drop, ...noCompany } = rawSimplifyListing;
  expect(() => normalizeSimplifyListing(noCompany)).not.toThrow();
  expect(normalizeSimplifyListing(noCompany).company).toBe('');
});

test('normalizeSimplifyListing tolerates a null date_posted without throwing and returns null posted_at', () => {
  const posting = normalizeSimplifyListing(listing({ date_posted: null as unknown as number }));
  expect(posting.posted_at).toBeNull();
});

test('fetchSimplify filters a four-entry stub (active+visible, active+hidden, inactive+visible, inactive+hidden) to exactly one posting', async () => {
  const stub = fakeFetch([
    listing({ id: '1', active: true, is_visible: true }),
    listing({ id: '2', active: true, is_visible: false }),
    listing({ id: '3', active: false, is_visible: true }),
    listing({ id: '4', active: false, is_visible: false }),
  ]);
  const postings = await fetchSimplify(stub);
  expect(postings).toHaveLength(1);
  expect(postings[0].source).toBe('simplify');
});

test('fetchSimplify includes a non-ATS host entry (SmartRecruiters) in its output (D-08)', async () => {
  const stub = fakeFetch([
    listing({
      active: true,
      is_visible: true,
      url: 'https://jobs.smartrecruiters.com/Acme/some-role',
    }),
  ]);
  const postings = await fetchSimplify(stub);
  expect(postings).toHaveLength(1);
  expect(postings[0].url).toBe('https://jobs.smartrecruiters.com/Acme/some-role');
});

test('fetchSimplify rejects on a non-2xx stub response', async () => {
  const stub = fakeFetch([], false, 500);
  await expect(fetchSimplify(stub)).rejects.toThrow(/fetchSimplify/);
  await expect(fetchSimplify(stub)).rejects.toThrow(/500/);
});

test('fetchSimplify yields an empty array rather than throwing on a non-array body', async () => {
  const stub = fakeFetch({ not: 'an array' });
  const postings = await fetchSimplify(stub);
  expect(postings).toEqual([]);
});

test('SIMPLIFY_URL points at the New-Grad-Positions dev branch, not Summer2026-Internships', () => {
  // D-07: New-Grad only. The branch is `dev` (the repo's default); the `main`
  // path 404s, which is what the 16-09 smoke run caught. This assertion is the
  // offline tripwire for that specific regression — it cannot prove the feed is
  // reachable, only that we did not silently revert to the dead `main` path.
  expect(SIMPLIFY_URL).toContain('New-Grad-Positions/dev');
  expect(SIMPLIFY_URL).not.toContain('New-Grad-Positions/main');
  expect(SIMPLIFY_URL).not.toContain('Summer2026');
});

function posting(url: string): NormalizedPosting {
  return {
    company: 'Acme',
    title: 'Role',
    location: '',
    url,
    source: 'simplify',
    posted_at: null,
    posted_at_trusted: false,
    login_gated: false,
  };
}

test('harvestSimplifyBoards yields exactly the real ATS entries across all three Greenhouse host forms, a Lever URL, an Ashby URL, and excludes non-ATS + embed URLs', () => {
  const postings = [
    posting('https://job-boards.greenhouse.io/acme/jobs/1'),
    posting('https://boards.greenhouse.io/foo/jobs/2'),
    posting('https://job-boards.eu.greenhouse.io/bar/jobs/3'),
    posting('https://jobs.lever.co/baz/abc-123'),
    posting('https://jobs.ashbyhq.com/qux/def-456'),
    posting('https://jobs.smartrecruiters.com/Corp/some-role'),
    posting('https://ngc.wd1.myworkdayjobs.com/en-US/careers/job/1'),
    posting('https://boards.greenhouse.io/embed/job_app?token=6099883'),
  ];
  const result = harvestSimplifyBoards(postings);
  expect(result).toHaveLength(5);
  expect(result).toEqual([
    { ats: 'greenhouse', token: 'acme' },
    { ats: 'greenhouse', token: 'foo' },
    { ats: 'greenhouse', token: 'bar' },
    { ats: 'lever', token: 'baz' },
    { ats: 'ashby', token: 'qux' },
  ]);
  expect(result.some((r) => r.token === 'embed')).toBe(false);
});

test('harvestSimplifyBoards collapses two postings on the same company slug to one entry', () => {
  const postings = [
    posting('https://jobs.lever.co/acme/abc-111'),
    posting('https://jobs.lever.co/acme/abc-222'),
  ];
  const result = harvestSimplifyBoards(postings);
  expect(result).toEqual([{ ats: 'lever', token: 'acme' }]);
});

test('harvestSimplifyBoards yields an empty array for an empty list', () => {
  expect(harvestSimplifyBoards([])).toEqual([]);
});
