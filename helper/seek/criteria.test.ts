import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSeekMetaTable } from './meta';
import {
  compileTerms,
  compileCriteria,
  defaultCriteria,
  readCriteria,
  saveCriteria,
  readRelevanceProfile,
  saveRelevanceProfile,
  toCriteria,
  validateCriteria,
  MAX_PROFILE_CHARS,
  SEED_CRITERIA,
} from './criteria';
import { classifyMetadata, classifyYoe } from './filter';
import type { PostingRow } from './postings';

function makeDb(): Database {
  const db = new Database(':memory:');
  createSeekMetaTable(db);
  return db;
}

// --- D-06 fail open: the load-bearing group. Behavioral, not source greps. ---

test('compileTerms returns null (rule is off) for an empty term list', () => {
  expect(compileTerms([], 'word')).toBeNull();
});

test('compileTerms returns null (rule is off) for a list of only blank/whitespace terms', () => {
  expect(compileTerms(['  ', ''], 'word')).toBeNull();
});

test('compileCriteria: an empty locationTerms list yields locationRe null while other rules stay compiled', () => {
  const c = { ...defaultCriteria(), locationTerms: [] };
  const compiled = compileCriteria(c);
  expect(compiled.locationRe).toBeNull();
  expect(compiled.seniorityRe).not.toBeNull();
  expect(compiled.nonEngineeringRe).not.toBeNull();
  expect(compiled.workModeOnlyRe).not.toBeNull();
});

test('readCriteria: an empty stored locationTerms list survives the read boundary, not replaced by the default list', () => {
  const db = makeDb();
  db.query("INSERT INTO seek_meta(key, value) VALUES ('criteria', ?)").run(JSON.stringify({ locationTerms: [] }));
  const criteria = readCriteria(db);
  expect(criteria.locationTerms).toEqual([]);
});

// --- CFG-04 hostile input ---

test('a 100,000-character term is dropped before it ever reaches compileTerms', () => {
  const hostile = 'x'.repeat(100_000);
  const criteria = toCriteria({ seniorityTerms: [hostile] });
  expect(criteria.seniorityTerms).toEqual([]);
  expect(compileTerms(criteria.seniorityTerms, 'word')).toBeNull();
});

test('a 200-entry term list is clamped to 50 on read and rejected at the write boundary', () => {
  const overlong = Array.from({ length: 200 }, (_, i) => `term${i}`);
  const criteria = toCriteria({ seniorityTerms: overlong });
  expect(criteria.seniorityTerms.length).toBe(50);

  const result = validateCriteria({ ...defaultCriteria(), seniorityTerms: overlong });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBe('too many terms — max 50');
});

test('catastrophic-backtracking-shaped terms compile without throwing and match only their literal text', () => {
  const hostileTerms = ['(a+)+$', '(x|x)*y', '[', '\\', '.*'];
  const re = compileTerms(hostileTerms, 'word');
  expect(re).not.toBeNull();
  expect(re!.test('(a+)+$')).toBe(true);
  expect(re!.test('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!')).toBe(false);
  expect(re!.test('some unrelated sentence')).toBe(false);
});

test('a 10,000-character relevance profile is truncated to MAX_PROFILE_CHARS on save', () => {
  const db = makeDb();
  saveRelevanceProfile(db, 'x'.repeat(10_000));
  const stored = readRelevanceProfile(db);
  expect(stored).not.toBeNull();
  expect(stored!.length).toBe(MAX_PROFILE_CHARS);
  expect(stored!.length).toBe(4000);
});

// --- Coercion and round-trip ---

test('readCriteria on an empty DB (no row) returns defaultCriteria()', () => {
  const db = makeDb();
  expect(readCriteria(db)).toEqual(defaultCriteria());
});

test('readCriteria on a row holding invalid JSON returns defaultCriteria() and does not throw', () => {
  const db = makeDb();
  db.query("INSERT INTO seek_meta(key, value) VALUES ('criteria', 'not valid json{{{')").run();
  expect(() => readCriteria(db)).not.toThrow();
  expect(readCriteria(db)).toEqual(defaultCriteria());
});

test('saveCriteria then readCriteria round-trips every field, including yoeThreshold null and staffLeadBuiltins false', () => {
  const db = makeDb();
  const criteria = {
    ...defaultCriteria(),
    locationTerms: ['new york', 'remote'],
    staffLeadBuiltins: false,
    yoeThreshold: null,
    maxStaleDays: 3,
  };
  saveCriteria(db, criteria);
  expect(readCriteria(db)).toEqual(criteria);
});

test('saveCriteria then readCriteria round-trips a non-null yoeThreshold', () => {
  const db = makeDb();
  const criteria = { ...defaultCriteria(), yoeThreshold: 5 };
  saveCriteria(db, criteria);
  expect(readCriteria(db).yoeThreshold).toBe(5);
});

test('readRelevanceProfile on an empty DB returns null', () => {
  const db = makeDb();
  expect(readRelevanceProfile(db)).toBeNull();
});

test('compileTerms whole mode matches only the full string, not a substring', () => {
  const re = compileTerms(['hybrid'], 'whole');
  expect(re!.test('hybrid')).toBe(true);
  expect(re!.test('hybrid, nyc')).toBe(false);
});

// --- D-13: SEED_CRITERIA reproduces the pre-phase classifier verdicts ---
//
// A failure in this group means the live install's next sweep would filter
// differently than its last one. Because rejection is permanent (Phase 9
// D-14 — upsertPosting's ON CONFLICT omits decision/decision_reason/
// decided_at, so a re-discovery upsert never revives a rejected row), the
// correct response to a failure here is to FIX SEED_CRITERIA, never to
// update the expectation.

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

// SQLite writes datetime('now') as 'YYYY-MM-DD HH:MM:SS' (UTC, no zone
// designator); filter.ts's parseStoredTs relies on that exact shape for the
// first-seen-aging clock, so greenhouse's created_at cases must use it.
function sqlDaysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

const seedCompiled = compileCriteria(SEED_CRITERIA);

interface EquivalenceCase {
  name: string;
  posting: Partial<PostingRow>;
  expectReject: boolean;
  expectReason?: string;
}

const equivalenceCases: EquivalenceCase[] = [
  // --- Title reject: bare seniority terms (ex-BARE_SENIORITY_RE) ---
  { name: 'title "Senior Software Engineer" rejects', posting: { title: 'Senior Software Engineer' }, expectReject: true, expectReason: 'rules:title' },
  { name: 'title "Sr. Engineer" rejects', posting: { title: 'Sr. Engineer' }, expectReject: true, expectReason: 'rules:title' },
  { name: 'title "Sr Engineer" rejects', posting: { title: 'Sr Engineer' }, expectReject: true, expectReason: 'rules:title' },
  { name: 'title "VP of Engineering" rejects', posting: { title: 'VP of Engineering' }, expectReject: true, expectReason: 'rules:title' },
  { name: 'title "Head of Product" rejects', posting: { title: 'Head of Product' }, expectReject: true, expectReason: 'rules:title' },
  { name: 'title "Principal Engineer" rejects', posting: { title: 'Principal Engineer' }, expectReject: true, expectReason: 'rules:title' },
  // --- Title reject: staff/lead builtins (D-04, staffLeadBuiltins: true) ---
  { name: 'title "Staff Software Engineer" rejects', posting: { title: 'Staff Software Engineer' }, expectReject: true, expectReason: 'rules:title' },
  { name: 'title "Engineering Lead" rejects', posting: { title: 'Engineering Lead' }, expectReject: true, expectReason: 'rules:title' },
  // --- Title survives: adjacency nuance and non-seniority markers ---
  { name: 'title "Member of Technical Staff" survives', posting: { title: 'Member of Technical Staff' }, expectReject: false },
  { name: 'title "Founding Engineer" survives', posting: { title: 'Founding Engineer' }, expectReject: false },
  { name: 'title "Software Engineer" survives', posting: { title: 'Software Engineer' }, expectReject: false },
  // --- Title reject: non-engineering terms (ex-NON_ENGINEERING_RE) ---
  { name: 'title "Product Manager" rejects', posting: { title: 'Product Manager' }, expectReject: true, expectReason: 'rules:title' },
  { name: 'title "Account Executive" rejects', posting: { title: 'Account Executive' }, expectReject: true, expectReason: 'rules:title' },
  { name: 'title "Customer Success Manager" rejects', posting: { title: 'Customer Success Manager' }, expectReject: true, expectReason: 'rules:title' },

  // --- Locations that survive: NY/SF/US-generic/remote (ex-NY_RE/SF_RE/US_GENERIC_RE/REMOTE_RE) ---
  { name: 'location "New York, NY" survives', posting: { location: 'New York, NY' }, expectReject: false },
  { name: 'location "NYC" survives', posting: { location: 'NYC' }, expectReject: false },
  { name: 'location "San Francisco, CA" survives', posting: { location: 'San Francisco, CA' }, expectReject: false },
  { name: 'location "SF" survives', posting: { location: 'SF' }, expectReject: false },
  { name: 'location "United States" survives', posting: { location: 'United States' }, expectReject: false },
  { name: 'location "USA" survives', posting: { location: 'USA' }, expectReject: false },
  { name: 'location "Remote" survives', posting: { location: 'Remote' }, expectReject: false },
  { name: 'location "Remote, U.S." survives', posting: { location: 'Remote, U.S.' }, expectReject: false },
  { name: 'location "" (empty, rule not applicable) survives', posting: { location: '' }, expectReject: false },
  // Isolates the 'u.s.' term specifically — no other seeded location term
  // matches this string (unlike "Remote, U.S." above, which independently
  // survives via the 'remote' term and so would NOT go red if 'u.s.' were
  // dropped). This is the case the deliberate-corruption demonstration below
  // actually exercises.
  { name: 'location "Chicago, U.S." survives via the u.s. term alone', posting: { location: 'Chicago, U.S.' }, expectReject: false },

  // --- Locations that reject: no accepted term present ---
  { name: 'location "Berlin, Germany" rejects', posting: { location: 'Berlin, Germany' }, expectReject: true, expectReason: 'rules:location' },
  { name: 'location "London, UK" rejects', posting: { location: 'London, UK' }, expectReject: true, expectReason: 'rules:location' },
  { name: 'location "Toronto, Canada" rejects', posting: { location: 'Toronto, Canada' }, expectReject: true, expectReason: 'rules:location' },

  // --- Work-mode-only noise (ex-WORK_MODE_ONLY_RE): ambiguous, not a hard reject ---
  { name: 'location "hybrid" survives (work-mode noise)', posting: { location: 'hybrid' }, expectReject: false },
  { name: 'location "in-office" survives (work-mode noise)', posting: { location: 'in-office' }, expectReject: false },
  { name: 'location "Full-Time" survives (work-mode noise)', posting: { location: 'Full-Time' }, expectReject: false },

  // --- Staleness: three independent clocks (maxStaleDays=2, maxStaleDaysIndexed=7, maxFirstSeenDays=7) ---
  {
    name: 'jobright posting with a trusted posted_at 5 days ago rejects (maxStaleDays=2)',
    posting: { source: 'jobright', posted_at: daysAgo(5), posted_at_trusted: true },
    expectReject: true,
    expectReason: 'rules:stale',
  },
  {
    name: 'getro posting with an untrusted posted_at 10 days ago rejects (maxStaleDaysIndexed=7)',
    posting: { source: 'getro', posted_at: daysAgo(10), posted_at_trusted: false },
    expectReject: true,
    expectReason: 'rules:stale',
  },
  {
    name: 'greenhouse posting with created_at 10 days ago rejects (maxFirstSeenDays=7)',
    posting: { source: 'greenhouse', created_at: sqlDaysAgo(10), posted_at: null },
    expectReject: true,
    expectReason: 'rules:stale',
  },
  {
    name: 'greenhouse posting with created_at 1 day ago and no posted_at survives',
    posting: { source: 'greenhouse', created_at: sqlDaysAgo(1), posted_at: null },
    expectReject: false,
  },
];

for (const c of equivalenceCases) {
  test(`D-13: SEED_CRITERIA reproduces the pre-phase verdict — ${c.name}`, () => {
    const result = classifyMetadata(mkPosting(c.posting), seedCompiled);
    expect(result.reject).toBe(c.expectReject);
    if (c.expectReason) {
      expect(result.reason).toBe(c.expectReason);
    }
  });
}

test('D-13: SEED_CRITERIA (yoeThreshold=1) rejects "requires 3 years of experience"', () => {
  const result = classifyYoe('requires 3 years of experience', compileCriteria(SEED_CRITERIA));
  expect(result.reject).toBe(true);
  expect(result.reason).toBe('rules:yoe');
});

test('D-13: defaultCriteria() (yoeThreshold unset) does NOT reject the same JD text — the seed-vs-default divergence made observable at the classifier', () => {
  const result = classifyYoe('requires 3 years of experience', compileCriteria(defaultCriteria()));
  expect(result.reject).toBe(false);
});
