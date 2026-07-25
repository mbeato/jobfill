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

// SQLite stores datetime('now') as 'YYYY-MM-DD HH:MM:SS' (UTC, no zone
// designator) — a bare Date.parse on that shape resolves it as LOCAL time.
// Tests for postings.created_at / boards.first_seen_at MUST use this format
// (not the ISO-8601 `daysAgo` above) so a regression to bare Date.parse in the
// implementation is caught.
function sqlDaysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
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

test('greenhouse is NOT index-dated via INDEX_DATE_SOURCES/MAX_STALE_DAYS_INDEXED (a different path from D-03)', () => {
  // D-07: greenhouse's posted_at is job.updated_at, a MODIFICATION time that
  // moves forward on every edit, so it must never be keyed on the tempting-but-
  // wrong `posted_at_trusted === false` INDEX_DATE_SOURCES path (that would
  // sweep in ~14k greenhouse rows). It is NOT in INDEX_DATE_SOURCES and never
  // will be. Phase 17 D-03 separately (and correctly) rejects an old
  // updated_at as an honest lower bound on age via its own dedicated check —
  // see the D-03 lower-bound tests below, which is why this 400-day-old
  // posted_at now IS rejected, just not via the INDEX_DATE_SOURCES path.
  const result = classifyMetadata(mkPosting({ source: 'greenhouse', posted_at: daysAgo(400), posted_at_trusted: false }));
  expect(result).toEqual({ reject: true, reason: 'rules:stale' });
});

test('the trusted 2-day cap is unchanged and still stricter than the index-date cap', () => {
  // A 5-day-old trusted posting is rejected while a 5-day-old simplify posting
  // survives — the two caps must not collapse into one.
  const trusted = classifyMetadata(mkPosting({ source: 'lever', posted_at: daysAgo(5), posted_at_trusted: true }));
  const indexed = classifyMetadata(mkPosting({ source: 'simplify', posted_at: daysAgo(5), posted_at_trusted: false }));
  expect(trusted).toEqual({ reject: true, reason: 'rules:stale' });
  expect(indexed.reject).toBe(false);
});

// --- First-seen aging (FILT-06, D-01/D-02/D-04) ------------------------------
// greenhouse and yc postings carry zero age information in posted_at, so
// postings.created_at (when jobfill first staged the row) is their only clock.

test('classifyMetadata rejects a greenhouse posting whose created_at is 8 days old as rules:stale', () => {
  const result = classifyMetadata(mkPosting({ source: 'greenhouse', created_at: sqlDaysAgo(8) }));
  expect(result).toEqual({ reject: true, reason: 'rules:stale' });
});

test('classifyMetadata survives a greenhouse posting whose created_at is 6 days old', () => {
  const result = classifyMetadata(mkPosting({ source: 'greenhouse', created_at: sqlDaysAgo(6) }));
  expect(result.reject).toBe(false);
});

test('classifyMetadata rejects a yc posting whose created_at is 8 days old, posted_at null, as rules:stale', () => {
  const result = classifyMetadata(mkPosting({ source: 'yc', created_at: sqlDaysAgo(8), posted_at: null }));
  expect(result).toEqual({ reject: true, reason: 'rules:stale' });
});

test('classifyMetadata survives a yc posting whose created_at is 1 day old, posted_at null', () => {
  const result = classifyMetadata(mkPosting({ source: 'yc', created_at: sqlDaysAgo(1), posted_at: null }));
  expect(result.reject).toBe(false);
});

test('classifyMetadata does not add a first-seen clock to simplify (index cap governs)', () => {
  const result = classifyMetadata(
    mkPosting({ source: 'simplify', created_at: sqlDaysAgo(30), posted_at: daysAgo(3), posted_at_trusted: false }),
  );
  expect(result.reject).toBe(false);
});

test('classifyMetadata still applies the existing MAX_STALE_DAYS_INDEXED path to getro unchanged', () => {
  const result = classifyMetadata(
    mkPosting({ source: 'getro', created_at: sqlDaysAgo(30), posted_at: daysAgo(30), posted_at_trusted: false }),
  );
  expect(result).toEqual({ reject: true, reason: 'rules:stale' });
});

test('classifyMetadata still applies the existing MAX_STALE_DAYS path to jobright unchanged', () => {
  const result = classifyMetadata(
    mkPosting({ source: 'jobright', posted_at_trusted: true, posted_at: daysAgo(5), created_at: sqlDaysAgo(0) }),
  );
  expect(result).toEqual({ reject: true, reason: 'rules:stale' });
});

test('classifyMetadata boundary: a SQLite-format created_at that would flip if parsed as local time', () => {
  // A timestamp exactly at the MAX_FIRST_SEEN_DAYS boundary in UTC. If
  // implementation regressed to a bare Date.parse (which resolves the SQLite
  // shape as LOCAL time), this machine's offset would flip the verdict.
  const justUnder = sqlDaysAgo(6.9);
  const result = classifyMetadata(mkPosting({ source: 'greenhouse', created_at: justUnder }));
  expect(result.reject).toBe(false);
});

// --- Greenhouse updated_at lower bound (FILT-06, D-03) -----------------------
// updated_at >= posted_at always: an OLD updated_at is an honest lower bound
// on age, but a RECENT one proves nothing and must never signal freshness.

test('classifyMetadata rejects a greenhouse posting with an old updated_at even when created_at is fresh (D-03 lower bound)', () => {
  const result = classifyMetadata(
    mkPosting({ source: 'greenhouse', created_at: sqlDaysAgo(0), posted_at: daysAgo(30) }),
  );
  expect(result).toEqual({ reject: true, reason: 'rules:stale' });
});

test('classifyMetadata does NOT treat a recent greenhouse updated_at as evidence of freshness', () => {
  // created_at 1 hour ago (fresh by first-seen), posted_at (updated_at) 2 days
  // ago — a recent updated_at proves nothing and must not be used either way.
  const result = classifyMetadata(
    mkPosting({ source: 'greenhouse', created_at: sqlDaysAgo(1 / 24), posted_at: daysAgo(2) }),
  );
  expect(result.reject).toBe(false);
});

test('classifyMetadata survives a greenhouse posting with created_at fresh and posted_at null', () => {
  const result = classifyMetadata(mkPosting({ source: 'greenhouse', created_at: sqlDaysAgo(1 / 24), posted_at: null }));
  expect(result.reject).toBe(false);
});

test('classifyMetadata survives an unparseable greenhouse created_at without throwing', () => {
  expect(() => classifyMetadata(mkPosting({ source: 'greenhouse', created_at: 'not-a-date' }))).not.toThrow();
  const result = classifyMetadata(mkPosting({ source: 'greenhouse', created_at: 'not-a-date' }));
  expect(result.reject).toBe(false);
});

test('classifyMetadata survives an absent greenhouse created_at field without throwing', () => {
  const posting = mkPosting({ source: 'greenhouse' });
  delete (posting as Partial<PostingRow>).created_at;
  expect(() => classifyMetadata(posting)).not.toThrow();
  expect(classifyMetadata(posting).reject).toBe(false);
});

test('classifyMetadata still checks title before the first-seen/stale rules', () => {
  const result = classifyMetadata(
    mkPosting({ source: 'greenhouse', title: 'Senior Software Engineer', created_at: sqlDaysAgo(8) }),
  );
  expect(result).toEqual({ reject: true, reason: 'rules:title' });
});
