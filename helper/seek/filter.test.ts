import { test, expect } from 'bun:test';
import { classifyMetadata, classifyYoe } from './filter';
import type { PostingRow } from './postings';

function mkPosting(overrides: Partial<PostingRow> = {}): PostingRow {
  return {
    id: 1,
    url: 'https://example.com/job',
    url_key: 'example.com/job',
    company: 'Acme',
    title: 'Software Engineer',
    location: '',
    source: 'greenhouse',
    posted_at: null,
    posted_at_trusted: false,
    login_gated: false,
    not_fillable: false,
    low_confidence: false,
    fetched_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

// --- Title (D-04) ---

const SURVIVING_TITLES = [
  'Software Engineer',
  'Fullstack Engineer',
  'AI Engineer',
  'Applied AI Engineer',
  'Member of Technical Staff',
  'Software Developer',
];

for (const title of SURVIVING_TITLES) {
  test(`classifyMetadata survives engineering-ish title "${title}"`, () => {
    const result = classifyMetadata(mkPosting({ title }));
    expect(result.reject).toBe(false);
  });
}

const SENIOR_TITLES = [
  'Senior Software Engineer',
  'Staff Engineer',
  'Principal Engineer',
  'Engineering Lead',
  'Lead Software Engineer',
];

for (const title of SENIOR_TITLES) {
  test(`classifyMetadata rejects seniority-marked title "${title}" as rules:title`, () => {
    const result = classifyMetadata(mkPosting({ title }));
    expect(result).toEqual({ reject: true, reason: 'rules:title' });
  });
}

const NON_ENGINEERING_TITLES = ['Product Manager', 'Product Designer', 'Sales Development Rep', 'Recruiter'];

for (const title of NON_ENGINEERING_TITLES) {
  test(`classifyMetadata rejects non-engineering title "${title}" as rules:title`, () => {
    const result = classifyMetadata(mkPosting({ title }));
    expect(result).toEqual({ reject: true, reason: 'rules:title' });
  });
}

// --- Location (D-02) ---

const SURVIVING_LOCATIONS = [
  'New York, NY',
  'NYC',
  'New York',
  'Remote',
  'Remote (US)',
  'Remote - United States',
  '',
  // D-02 amendment (2026-07-22): SF is a home market; US-generic strings and
  // work-mode-only strings survive to the LLM instead of hard-rejecting.
  'San Francisco',
  'San Francisco, CA',
  'SF Bay Area',
  'United States',
  'USA',
  'U.S. Remote',
  'Hybrid',
  'In-Office',
  'Full-time',
];

for (const location of SURVIVING_LOCATIONS) {
  test(`classifyMetadata survives location "${location}"`, () => {
    const result = classifyMetadata(mkPosting({ location }));
    expect(result.reject).toBe(false);
  });
}

const REJECTED_LOCATIONS = ['London, UK', 'Toronto, Canada', 'Singapore', 'Seattle, WA'];

for (const location of REJECTED_LOCATIONS) {
  test(`classifyMetadata rejects location "${location}" as rules:location`, () => {
    const result = classifyMetadata(mkPosting({ location }));
    expect(result).toEqual({ reject: true, reason: 'rules:location' });
  });
}

// --- Freshness-where-trusted (D-01) ---

test('classifyMetadata rejects a trusted stale timestamp (5 days old) as rules:stale', () => {
  const result = classifyMetadata(mkPosting({ posted_at: daysAgo(5), posted_at_trusted: true }));
  expect(result).toEqual({ reject: true, reason: 'rules:stale' });
});

test('classifyMetadata survives an untrusted stale timestamp (5 days old)', () => {
  const result = classifyMetadata(mkPosting({ posted_at: daysAgo(5), posted_at_trusted: false }));
  expect(result.reject).toBe(false);
});

test('classifyMetadata survives a null posted_at', () => {
  const result = classifyMetadata(mkPosting({ posted_at: null, posted_at_trusted: true }));
  expect(result.reject).toBe(false);
});

test('classifyMetadata survives a trusted fresh timestamp (1 day old)', () => {
  const result = classifyMetadata(mkPosting({ posted_at: daysAgo(1), posted_at_trusted: true }));
  expect(result.reject).toBe(false);
});

// --- Ordering ---

test('classifyMetadata checks title before location: a bad title rejects even with a fine location', () => {
  const result = classifyMetadata(mkPosting({ title: 'Senior Software Engineer', location: 'New York, NY' }));
  expect(result).toEqual({ reject: true, reason: 'rules:title' });
});

test('classifyMetadata checks location before freshness: a bad location rejects even with a fresh timestamp', () => {
  const result = classifyMetadata(
    mkPosting({ location: 'London, UK', posted_at: daysAgo(1), posted_at_trusted: true }),
  );
  expect(result).toEqual({ reject: true, reason: 'rules:location' });
});

// --- Never throws (garbage input) ---

test('classifyMetadata never throws on null/garbage input and survives', () => {
  expect(() => classifyMetadata(null as unknown as PostingRow)).not.toThrow();
  expect(classifyMetadata(null as unknown as PostingRow)).toEqual({ reject: false });
  expect(() => classifyMetadata(undefined as unknown as PostingRow)).not.toThrow();
  expect(classifyMetadata(undefined as unknown as PostingRow)).toEqual({ reject: false });
  expect(() => classifyMetadata({} as PostingRow)).not.toThrow();
});

// --- YOE (D-03, over JD text) ---

const YOE_REJECT_TEXTS = ['5+ years of experience required', 'minimum 3 years'];

for (const text of YOE_REJECT_TEXTS) {
  test(`classifyYoe rejects explicit above-1-year requirement: "${text}"`, () => {
    const result = classifyYoe(text);
    expect(result).toEqual({ reject: true, reason: 'rules:yoe' });
  });
}

const YOE_SURVIVE_TEXTS = ['0-1 years', '1+ years', 'new grad welcome', ''];

for (const text of YOE_SURVIVE_TEXTS) {
  test(`classifyYoe survives missing/ambiguous YOE: "${text}"`, () => {
    const result = classifyYoe(text);
    expect(result.reject).toBe(false);
  });
}

test('classifyYoe never throws on null/garbage input and survives', () => {
  expect(() => classifyYoe(null as unknown as string)).not.toThrow();
  expect(classifyYoe(null as unknown as string)).toEqual({ reject: false });
  expect(() => classifyYoe(undefined as unknown as string)).not.toThrow();
  expect(classifyYoe(undefined as unknown as string)).toEqual({ reject: false });
});

test('classifyMetadata rejects "Staff Software Engineer" as rules:title (staff + intervening software)', () => {
  const result = classifyMetadata(mkPosting({ title: 'Staff Software Engineer, Government' }));
  expect(result).toEqual({ reject: true, reason: 'rules:title' });
});

// --- Index-date freshness cap (aggregator sources) --------------------------
// simplify/getro carry an INDEX date (when the aggregator first saw the
// listing). Untrusted as an employer post date, but a valid lower bound on
// public visibility, so it gets a 7-day cap rather than bypassing freshness
// entirely. Sized to the ~9-day tech application window / 7-day median posting
// duration (Davis & Samaniego de la Parra, NBER w32320).

test('classifyMetadata survives a simplify posting inside the 7-day index-date cap', () => {
  const result = classifyMetadata(mkPosting({ source: 'simplify', posted_at: daysAgo(5), posted_at_trusted: false }));
  expect(result.reject).toBe(false);
});

test('classifyMetadata rejects a simplify posting past the 7-day index-date cap', () => {
  const result = classifyMetadata(mkPosting({ source: 'simplify', posted_at: daysAgo(10), posted_at_trusted: false }));
  expect(result).toEqual({ reject: true, reason: 'rules:stale' });
});

test('classifyMetadata rejects a very old simplify posting (the 240-day evergreen case)', () => {
  const result = classifyMetadata(mkPosting({ source: 'simplify', posted_at: daysAgo(240), posted_at_trusted: false }));
  expect(result).toEqual({ reject: true, reason: 'rules:stale' });
});

test('classifyMetadata applies the index-date cap to getro as well', () => {
  const result = classifyMetadata(mkPosting({ source: 'getro', posted_at: daysAgo(10), posted_at_trusted: false }));
  expect(result).toEqual({ reject: true, reason: 'rules:stale' });
});

test('greenhouse is NOT index-dated: a very old untrusted modification date must not be rejected', () => {
  // D-07: greenhouse's posted_at is job.updated_at, a MODIFICATION time that
  // moves forward on every edit. It carries no age information, so capping on
  // it would reject postings for not having been edited recently. Guards
  // against the tempting-but-wrong `posted_at_trusted === false` keying, which
  // would sweep in ~14k greenhouse rows.
  const result = classifyMetadata(mkPosting({ source: 'greenhouse', posted_at: daysAgo(400), posted_at_trusted: false }));
  expect(result.reject).toBe(false);
});

test('the trusted 2-day cap is unchanged and still stricter than the index-date cap', () => {
  // A 5-day-old trusted posting is rejected while a 5-day-old simplify posting
  // survives — the two caps must not collapse into one.
  const trusted = classifyMetadata(mkPosting({ source: 'lever', posted_at: daysAgo(5), posted_at_trusted: true }));
  const indexed = classifyMetadata(mkPosting({ source: 'simplify', posted_at: daysAgo(5), posted_at_trusted: false }));
  expect(trusted).toEqual({ reject: true, reason: 'rules:stale' });
  expect(indexed.reject).toBe(false);
});
