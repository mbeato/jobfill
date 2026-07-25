import { test, expect } from 'bun:test';
import { classifyMetadata, classifyYoe, classifyBoardGrace } from './filter';
import { compileCriteria, defaultCriteria } from './criteria';
import type { Criteria, CompiledCriteria } from './criteria';
import type { PostingRow } from './postings';
import type { BoardRow } from './boards';

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

// Compiles a CompiledCriteria object over the D-14 generic defaults plus any
// overrides. Because the generic defaults ship location filtering and the
// YoE rule OFF (D-14), any test that needs those rules ON must pass an
// explicit override.
function mkCriteria(overrides: Partial<Criteria> = {}): CompiledCriteria {
  return compileCriteria({ ...defaultCriteria(), ...overrides });
}

// The pre-phase live location terms (today's NY_RE/SF_RE/US_GENERIC_RE/
// REMOTE_RE contents), used so existing location-rule tests keep their
// original meaning against generic defaults that ship the rule off.
const LIVE_LOCATION_TERMS = [
  'new york',
  'nyc',
  'ny',
  'san francisco',
  'sf',
  'united states',
  'usa',
  'us',
  'u.s.',
  'remote',
];

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

function mkBoard(overrides: Partial<BoardRow> = {}): BoardRow {
  return {
    id: 1,
    ats: 'greenhouse',
    token: 'acme',
    source_of_discovery: 'simplify',
    first_seen_at: '2026-07-24 20:52:27',
    last_ok_at: null,
    dead_since: null,
    consecutive_failures: 0,
    created_at: '2026-07-24 20:52:27',
    updated_at: '2026-07-24 20:52:27',
    ...overrides,
  };
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
    const result = classifyMetadata(mkPosting({ title }), mkCriteria());
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
    const result = classifyMetadata(mkPosting({ title }), mkCriteria());
    expect(result).toEqual({ reject: true, reason: 'rules:title' });
  });
}

const NON_ENGINEERING_TITLES = ['Product Manager', 'Product Designer', 'Sales Development Rep', 'Recruiter'];

for (const title of NON_ENGINEERING_TITLES) {
  test(`classifyMetadata rejects non-engineering title "${title}" as rules:title`, () => {
    const result = classifyMetadata(mkPosting({ title }), mkCriteria());
    expect(result).toEqual({ reject: true, reason: 'rules:title' });
  });
}

// --- Location (D-02) ---
// The D-14 generic defaults ship location filtering OFF, so these tests opt
// into the pre-phase live location list to keep their original meaning.

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
    const result = classifyMetadata(mkPosting({ location }), mkCriteria({ locationTerms: LIVE_LOCATION_TERMS }));
    expect(result.reject).toBe(false);
  });
}

const REJECTED_LOCATIONS = ['London, UK', 'Toronto, Canada', 'Singapore', 'Seattle, WA'];

for (const location of REJECTED_LOCATIONS) {
  test(`classifyMetadata rejects location "${location}" as rules:location`, () => {
    const result = classifyMetadata(mkPosting({ location }), mkCriteria({ locationTerms: LIVE_LOCATION_TERMS }));
    expect(result).toEqual({ reject: true, reason: 'rules:location' });
  });
}

// --- Freshness-where-trusted (D-01) ---

test('classifyMetadata rejects a trusted stale timestamp (5 days old) as rules:stale', () => {
  const result = classifyMetadata(mkPosting({ posted_at: daysAgo(5), posted_at_trusted: true }), mkCriteria());
  expect(result).toEqual({ reject: true, reason: 'rules:stale' });
});

test('classifyMetadata survives an untrusted stale timestamp (5 days old)', () => {
  const result = classifyMetadata(mkPosting({ posted_at: daysAgo(5), posted_at_trusted: false }), mkCriteria());
  expect(result.reject).toBe(false);
});

test('classifyMetadata survives a null posted_at', () => {
  const result = classifyMetadata(mkPosting({ posted_at: null, posted_at_trusted: true }), mkCriteria());
  expect(result.reject).toBe(false);
});

test('classifyMetadata survives a trusted fresh timestamp (1 day old)', () => {
  const result = classifyMetadata(mkPosting({ posted_at: daysAgo(1), posted_at_trusted: true }), mkCriteria());
  expect(result.reject).toBe(false);
});

// --- Ordering ---

test('classifyMetadata checks title before location: a bad title rejects even with a fine location', () => {
  const result = classifyMetadata(
    mkPosting({ title: 'Senior Software Engineer', location: 'New York, NY' }),
    mkCriteria({ locationTerms: LIVE_LOCATION_TERMS }),
  );
  expect(result).toEqual({ reject: true, reason: 'rules:title' });
});

test('classifyMetadata checks location before freshness: a bad location rejects even with a fresh timestamp', () => {
  const result = classifyMetadata(
    mkPosting({ location: 'London, UK', posted_at: daysAgo(1), posted_at_trusted: true }),
    mkCriteria({ locationTerms: LIVE_LOCATION_TERMS }),
  );
  expect(result).toEqual({ reject: true, reason: 'rules:location' });
});

// --- Never throws (garbage input) ---

test('classifyMetadata never throws on null/garbage input and survives', () => {
  const criteria = mkCriteria();
  expect(() => classifyMetadata(null as unknown as PostingRow, criteria)).not.toThrow();
  expect(classifyMetadata(null as unknown as PostingRow, criteria)).toEqual({ reject: false });
  expect(() => classifyMetadata(undefined as unknown as PostingRow, criteria)).not.toThrow();
  expect(classifyMetadata(undefined as unknown as PostingRow, criteria)).toEqual({ reject: false });
  expect(() => classifyMetadata({} as PostingRow, criteria)).not.toThrow();
});

// --- YOE (D-03, over JD text) ---
// The D-14 generic defaults ship the YoE rule OFF; these tests opt into the
// pre-phase live threshold (> 1 year) to keep their original meaning.

const YOE_REJECT_TEXTS = ['5+ years of experience required', 'minimum 3 years'];

for (const text of YOE_REJECT_TEXTS) {
  test(`classifyYoe rejects explicit above-1-year requirement: "${text}"`, () => {
    const result = classifyYoe(text, mkCriteria({ yoeThreshold: 1 }));
    expect(result).toEqual({ reject: true, reason: 'rules:yoe' });
  });
}

const YOE_SURVIVE_TEXTS = ['0-1 years', '1+ years', 'new grad welcome', ''];

for (const text of YOE_SURVIVE_TEXTS) {
  test(`classifyYoe survives missing/ambiguous YOE: "${text}"`, () => {
    const result = classifyYoe(text, mkCriteria({ yoeThreshold: 1 }));
    expect(result.reject).toBe(false);
  });
}

test('classifyYoe never throws on null/garbage input and survives', () => {
  const criteria = mkCriteria({ yoeThreshold: 1 });
  expect(() => classifyYoe(null as unknown as string, criteria)).not.toThrow();
  expect(classifyYoe(null as unknown as string, criteria)).toEqual({ reject: false });
  expect(() => classifyYoe(undefined as unknown as string, criteria)).not.toThrow();
  expect(classifyYoe(undefined as unknown as string, criteria)).toEqual({ reject: false });
});

test('classifyMetadata rejects "Staff Software Engineer" as rules:title (staff + intervening software)', () => {
  const result = classifyMetadata(mkPosting({ title: 'Staff Software Engineer, Government' }), mkCriteria());
  expect(result).toEqual({ reject: true, reason: 'rules:title' });
});

// --- Index-date freshness cap (aggregator sources) --------------------------
// simplify/getro carry an INDEX date (when the aggregator first saw the
// listing). Untrusted as an employer post date, but a valid lower bound on
// public visibility, so it gets a 7-day cap rather than bypassing freshness
// entirely. Sized to the ~9-day tech application window / 7-day median posting
// duration (Davis & Samaniego de la Parra, NBER w32320).

test('classifyMetadata survives a simplify posting inside the 7-day index-date cap', () => {
  const result = classifyMetadata(
    mkPosting({ source: 'simplify', posted_at: daysAgo(5), posted_at_trusted: false }),
    mkCriteria(),
  );
  expect(result.reject).toBe(false);
});

test('classifyMetadata rejects a simplify posting past the 7-day index-date cap', () => {
  const result = classifyMetadata(
    mkPosting({ source: 'simplify', posted_at: daysAgo(10), posted_at_trusted: false }),
    mkCriteria(),
  );
  expect(result).toEqual({ reject: true, reason: 'rules:stale' });
});

test('classifyMetadata rejects a very old simplify posting (the 240-day evergreen case)', () => {
  const result = classifyMetadata(
    mkPosting({ source: 'simplify', posted_at: daysAgo(240), posted_at_trusted: false }),
    mkCriteria(),
  );
  expect(result).toEqual({ reject: true, reason: 'rules:stale' });
});

test('classifyMetadata applies the index-date cap to getro as well', () => {
  const result = classifyMetadata(
    mkPosting({ source: 'getro', posted_at: daysAgo(10), posted_at_trusted: false }),
    mkCriteria(),
  );
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
  const result = classifyMetadata(
    mkPosting({ source: 'greenhouse', posted_at: daysAgo(400), posted_at_trusted: false }),
    mkCriteria(),
  );
  expect(result).toEqual({ reject: true, reason: 'rules:stale' });
});

test('the trusted 2-day cap is unchanged and still stricter than the index-date cap', () => {
  // A 5-day-old trusted posting is rejected while a 5-day-old simplify posting
  // survives — the two caps must not collapse into one.
  const criteria = mkCriteria();
  const trusted = classifyMetadata(mkPosting({ source: 'lever', posted_at: daysAgo(5), posted_at_trusted: true }), criteria);
  const indexed = classifyMetadata(
    mkPosting({ source: 'simplify', posted_at: daysAgo(5), posted_at_trusted: false }),
    criteria,
  );
  expect(trusted).toEqual({ reject: true, reason: 'rules:stale' });
  expect(indexed.reject).toBe(false);
});

// --- First-seen aging (FILT-06, D-01/D-02/D-04) ------------------------------
// greenhouse and yc postings carry zero age information in posted_at, so
// postings.created_at (when jobfill first staged the row) is their only clock.

test('classifyMetadata rejects a greenhouse posting whose created_at is 8 days old as rules:stale', () => {
  const result = classifyMetadata(mkPosting({ source: 'greenhouse', created_at: sqlDaysAgo(8) }), mkCriteria());
  expect(result).toEqual({ reject: true, reason: 'rules:stale' });
});

test('classifyMetadata survives a greenhouse posting whose created_at is 6 days old', () => {
  const result = classifyMetadata(mkPosting({ source: 'greenhouse', created_at: sqlDaysAgo(6) }), mkCriteria());
  expect(result.reject).toBe(false);
});

test('classifyMetadata rejects a yc posting whose created_at is 8 days old, posted_at null, as rules:stale', () => {
  const result = classifyMetadata(mkPosting({ source: 'yc', created_at: sqlDaysAgo(8), posted_at: null }), mkCriteria());
  expect(result).toEqual({ reject: true, reason: 'rules:stale' });
});

test('classifyMetadata survives a yc posting whose created_at is 1 day old, posted_at null', () => {
  const result = classifyMetadata(mkPosting({ source: 'yc', created_at: sqlDaysAgo(1), posted_at: null }), mkCriteria());
  expect(result.reject).toBe(false);
});

test('classifyMetadata does not add a first-seen clock to simplify (index cap governs)', () => {
  const result = classifyMetadata(
    mkPosting({ source: 'simplify', created_at: sqlDaysAgo(30), posted_at: daysAgo(3), posted_at_trusted: false }),
    mkCriteria(),
  );
  expect(result.reject).toBe(false);
});

test('classifyMetadata still applies the existing MAX_STALE_DAYS_INDEXED path to getro unchanged', () => {
  const result = classifyMetadata(
    mkPosting({ source: 'getro', created_at: sqlDaysAgo(30), posted_at: daysAgo(30), posted_at_trusted: false }),
    mkCriteria(),
  );
  expect(result).toEqual({ reject: true, reason: 'rules:stale' });
});

test('classifyMetadata still applies the existing MAX_STALE_DAYS path to jobright unchanged', () => {
  const result = classifyMetadata(
    mkPosting({ source: 'jobright', posted_at_trusted: true, posted_at: daysAgo(5), created_at: sqlDaysAgo(0) }),
    mkCriteria(),
  );
  expect(result).toEqual({ reject: true, reason: 'rules:stale' });
});

test('classifyMetadata boundary: a SQLite-format created_at that would flip if parsed as local time', () => {
  // A timestamp exactly at the MAX_FIRST_SEEN_DAYS boundary in UTC. If
  // implementation regressed to a bare Date.parse (which resolves the SQLite
  // shape as LOCAL time), this machine's offset would flip the verdict.
  const justUnder = sqlDaysAgo(6.9);
  const result = classifyMetadata(mkPosting({ source: 'greenhouse', created_at: justUnder }), mkCriteria());
  expect(result.reject).toBe(false);
});

// --- Greenhouse updated_at lower bound (FILT-06, D-03) -----------------------
// updated_at >= posted_at always: an OLD updated_at is an honest lower bound
// on age, but a RECENT one proves nothing and must never signal freshness.

test('classifyMetadata rejects a greenhouse posting with an old updated_at even when created_at is fresh (D-03 lower bound)', () => {
  const result = classifyMetadata(
    mkPosting({ source: 'greenhouse', created_at: sqlDaysAgo(0), posted_at: daysAgo(30) }),
    mkCriteria(),
  );
  expect(result).toEqual({ reject: true, reason: 'rules:stale' });
});

test('classifyMetadata does NOT treat a recent greenhouse updated_at as evidence of freshness', () => {
  // created_at 1 hour ago (fresh by first-seen), posted_at (updated_at) 2 days
  // ago — a recent updated_at proves nothing and must not be used either way.
  const result = classifyMetadata(
    mkPosting({ source: 'greenhouse', created_at: sqlDaysAgo(1 / 24), posted_at: daysAgo(2) }),
    mkCriteria(),
  );
  expect(result.reject).toBe(false);
});

test('classifyMetadata survives a greenhouse posting with created_at fresh and posted_at null', () => {
  const result = classifyMetadata(
    mkPosting({ source: 'greenhouse', created_at: sqlDaysAgo(1 / 24), posted_at: null }),
    mkCriteria(),
  );
  expect(result.reject).toBe(false);
});

test('classifyMetadata survives an unparseable greenhouse created_at without throwing', () => {
  const criteria = mkCriteria();
  expect(() => classifyMetadata(mkPosting({ source: 'greenhouse', created_at: 'not-a-date' }), criteria)).not.toThrow();
  const result = classifyMetadata(mkPosting({ source: 'greenhouse', created_at: 'not-a-date' }), criteria);
  expect(result.reject).toBe(false);
});

test('classifyMetadata survives an absent greenhouse created_at field without throwing', () => {
  const posting = mkPosting({ source: 'greenhouse' });
  delete (posting as Partial<PostingRow>).created_at;
  const criteria = mkCriteria();
  expect(() => classifyMetadata(posting, criteria)).not.toThrow();
  expect(classifyMetadata(posting, criteria).reject).toBe(false);
});

test('classifyMetadata still checks title before the first-seen/stale rules', () => {
  const result = classifyMetadata(
    mkPosting({ source: 'greenhouse', title: 'Senior Software Engineer', created_at: sqlDaysAgo(8) }),
    mkCriteria(),
  );
  expect(result).toEqual({ reject: true, reason: 'rules:title' });
});

// --- classifyBoardGrace (FILT-07, D-08/D-09/D-11/D-13) -----------------------
// FS = board.first_seen_at fixed at '2026-07-24 20:52:27' in every case below.
// classifyBoardGrace's signature is unchanged by this plan.

const FS = '2026-07-24 20:52:27';

test('classifyBoardGrace rejects a posting staged ~0h after board.first_seen_at', () => {
  const board = mkBoard({ first_seen_at: FS });
  const posting = mkPosting({ created_at: '2026-07-24 20:53:10' });
  expect(classifyBoardGrace(posting, board)).toEqual({ reject: true, reason: 'rules:board-grace' });
});

test('classifyBoardGrace rejects a posting staged ~23h after board.first_seen_at', () => {
  const board = mkBoard({ first_seen_at: FS });
  const posting = mkPosting({ created_at: '2026-07-25 20:00:00' });
  expect(classifyBoardGrace(posting, board)).toEqual({ reject: true, reason: 'rules:board-grace' });
});

test('classifyBoardGrace rejects a posting staged ~47h after board.first_seen_at (inside window)', () => {
  const board = mkBoard({ first_seen_at: FS });
  const posting = mkPosting({ created_at: '2026-07-26 20:00:00' });
  expect(classifyBoardGrace(posting, board)).toEqual({ reject: true, reason: 'rules:board-grace' });
});

test('classifyBoardGrace survives a posting staged ~48.1h after board.first_seen_at (just outside window)', () => {
  const board = mkBoard({ first_seen_at: FS });
  const posting = mkPosting({ created_at: '2026-07-26 21:00:00' });
  expect(classifyBoardGrace(posting, board)).toEqual({ reject: false });
});

test('classifyBoardGrace survives a posting staged far beyond the grace window', () => {
  const board = mkBoard({ first_seen_at: FS });
  const posting = mkPosting({ created_at: '2026-07-30 12:00:00' });
  expect(classifyBoardGrace(posting, board)).toEqual({ reject: false });
});

test('classifyBoardGrace survives a posting staged BEFORE the board row existed (negative delta)', () => {
  const board = mkBoard({ first_seen_at: FS });
  const posting = mkPosting({ created_at: '2026-07-22 06:04:43' });
  expect(classifyBoardGrace(posting, board)).toEqual({ reject: false });
});

test('classifyBoardGrace fails open when board is null (D-11)', () => {
  const posting = mkPosting({ created_at: FS });
  expect(classifyBoardGrace(posting, null)).toEqual({ reject: false });
});

test('classifyBoardGrace fails open on a garbage board.first_seen_at', () => {
  const board = mkBoard({ first_seen_at: 'garbage' });
  const posting = mkPosting({ created_at: FS });
  expect(classifyBoardGrace(posting, board)).toEqual({ reject: false });
});

test('classifyBoardGrace fails open on an empty or undefined posting.created_at', () => {
  const board = mkBoard({ first_seen_at: FS });
  expect(classifyBoardGrace(mkPosting({ created_at: '' }), board)).toEqual({ reject: false });
  const posting = mkPosting();
  delete (posting as Partial<PostingRow>).created_at;
  expect(classifyBoardGrace(posting, board)).toEqual({ reject: false });
});

test('classifyBoardGrace never throws on a frozen/exotic object missing fields entirely', () => {
  const weird = Object.freeze({}) as unknown as PostingRow;
  expect(() => classifyBoardGrace(weird, mkBoard())).not.toThrow();
  expect(classifyBoardGrace(weird, mkBoard())).toEqual({ reject: false });
  const weirdBoard = Object.freeze({}) as unknown as BoardRow;
  expect(() => classifyBoardGrace(mkPosting(), weirdBoard)).not.toThrow();
  expect(classifyBoardGrace(mkPosting(), weirdBoard)).toEqual({ reject: false });
});

test('classifyBoardGrace is wall-clock independent: identical inputs give an identical verdict across calls', () => {
  const board = mkBoard({ first_seen_at: FS });
  // created_at is years in the past relative to "now" — if the function ever
  // read Date.now()/new Date(), this would behave differently than a
  // recently-staged posting. It must not: the verdict depends only on the
  // fixed delta between the two stored timestamps.
  const posting = mkPosting({ created_at: '2026-07-24 20:53:10' });
  const first = classifyBoardGrace(posting, board);
  const second = classifyBoardGrace(posting, board);
  expect(first).toEqual({ reject: true, reason: 'rules:board-grace' });
  expect(second).toEqual(first);
});

// --- D-06 fail open (empty list means the rule is disabled, never "reject
// everything") -- the most important test group in this plan. ---------------

test('classifyMetadata survives an empty accepted-locations list for a non-US location: Berlin (D-06 fail open)', () => {
  const criteria = mkCriteria({ locationTerms: [] });
  const result = classifyMetadata(mkPosting({ location: 'Berlin, Germany' }), criteria);
  expect(result).toEqual({ reject: false });
});

test('classifyMetadata survives an empty accepted-locations list for a second, unrelated non-US location: Tokyo (D-06 fail open)', () => {
  const criteria = mkCriteria({ locationTerms: [] });
  const result = classifyMetadata(mkPosting({ location: 'Tokyo' }), criteria);
  expect(result).toEqual({ reject: false });
});

test('classifyMetadata with seniorityTerms cleared no longer rejects "Senior Software Engineer" via the term list', () => {
  const criteria = mkCriteria({ seniorityTerms: [] });
  const result = classifyMetadata(mkPosting({ title: 'Senior Software Engineer' }), criteria);
  expect(result).toEqual({ reject: false });
});

test('classifyMetadata still rejects "Staff Software Engineer" via the builtin with seniorityTerms cleared -- the two title paths are independent (D-04)', () => {
  const criteria = mkCriteria({ seniorityTerms: [], staffLeadBuiltins: true });
  const result = classifyMetadata(mkPosting({ title: 'Staff Software Engineer' }), criteria);
  expect(result).toEqual({ reject: true, reason: 'rules:title' });
});

test('classifyMetadata with nonEngineeringTerms cleared no longer rejects "Product Manager"', () => {
  const criteria = mkCriteria({ nonEngineeringTerms: [] });
  const result = classifyMetadata(mkPosting({ title: 'Product Manager' }), criteria);
  expect(result).toEqual({ reject: false });
});

test('classifyYoe with yoeThreshold null does not reject "10+ years of experience required"', () => {
  const criteria = mkCriteria({ yoeThreshold: null });
  const result = classifyYoe('10+ years of experience required', criteria);
  expect(result).toEqual({ reject: false });
});

test('classifyMetadata rejects "hybrid" once workModeOnlyTerms is cleared -- turning the noise rule off removes the exemption, the documented consequence, not a bug', () => {
  const criteria = mkCriteria({ workModeOnlyTerms: [], locationTerms: LIVE_LOCATION_TERMS });
  const result = classifyMetadata(mkPosting({ location: 'hybrid' }), criteria);
  expect(result).toEqual({ reject: true, reason: 'rules:location' });
});

// --- D-04 toggle: staffLeadBuiltins genuinely turns the builtins off --------

test('classifyMetadata rejects "Staff Software Engineer" and "Engineering Lead" via the builtins, and does not reject "Member of Technical Staff", when staffLeadBuiltins is true', () => {
  const criteria = mkCriteria({ staffLeadBuiltins: true });
  expect(classifyMetadata(mkPosting({ title: 'Staff Software Engineer' }), criteria)).toEqual({
    reject: true,
    reason: 'rules:title',
  });
  expect(classifyMetadata(mkPosting({ title: 'Engineering Lead' }), criteria)).toEqual({
    reject: true,
    reason: 'rules:title',
  });
  expect(classifyMetadata(mkPosting({ title: 'Member of Technical Staff' }), criteria)).toEqual({ reject: false });
});

test('classifyMetadata with staffLeadBuiltins false lets "Staff Software Engineer", "Engineering Lead" and "Member of Technical Staff" all through', () => {
  const criteria = mkCriteria({ staffLeadBuiltins: false, seniorityTerms: [], nonEngineeringTerms: [] });
  expect(classifyMetadata(mkPosting({ title: 'Staff Software Engineer' }), criteria).reject).toBe(false);
  expect(classifyMetadata(mkPosting({ title: 'Engineering Lead' }), criteria).reject).toBe(false);
  expect(classifyMetadata(mkPosting({ title: 'Member of Technical Staff' }), criteria).reject).toBe(false);
});

// --- Per-cap independence (CFG-01) ------------------------------------------

test('classifyMetadata: maxStaleDays 30 lets a 10-day-old trusted posting survive (the default 2 would reject it)', () => {
  const criteria = mkCriteria({ maxStaleDays: 30 });
  const result = classifyMetadata(mkPosting({ source: 'lever', posted_at: daysAgo(10), posted_at_trusted: true }), criteria);
  expect(result.reject).toBe(false);
});

test('classifyMetadata: maxStaleDaysIndexed 1 rejects a 3-day-old getro posting', () => {
  const criteria = mkCriteria({ maxStaleDaysIndexed: 1 });
  const result = classifyMetadata(
    mkPosting({ source: 'getro', posted_at: daysAgo(3), posted_at_trusted: false }),
    criteria,
  );
  expect(result).toEqual({ reject: true, reason: 'rules:stale' });
});

test('classifyMetadata: maxFirstSeenDays 1 rejects a greenhouse posting whose created_at is 3 days ago', () => {
  const criteria = mkCriteria({ maxFirstSeenDays: 1 });
  const result = classifyMetadata(mkPosting({ source: 'greenhouse', created_at: sqlDaysAgo(3) }), criteria);
  expect(result).toEqual({ reject: true, reason: 'rules:stale' });
});

test('classifyMetadata: changing maxStaleDays does not move the verdict for a first-seen-source posting', () => {
  const looseStale = mkCriteria({ maxStaleDays: 365 });
  const tightStale = mkCriteria({ maxStaleDays: 1 });
  const posting = mkPosting({ source: 'greenhouse', created_at: sqlDaysAgo(8) });
  expect(classifyMetadata(posting, looseStale)).toEqual({ reject: true, reason: 'rules:stale' });
  expect(classifyMetadata(posting, tightStale)).toEqual({ reject: true, reason: 'rules:stale' });
});

test('classifyMetadata: changing maxStaleDaysIndexed does not move the verdict for a trusted-date posting', () => {
  const looseIndexed = mkCriteria({ maxStaleDaysIndexed: 365 });
  const tightIndexed = mkCriteria({ maxStaleDaysIndexed: 1 });
  const posting = mkPosting({ source: 'lever', posted_at: daysAgo(5), posted_at_trusted: true });
  expect(classifyMetadata(posting, looseIndexed)).toEqual({ reject: true, reason: 'rules:stale' });
  expect(classifyMetadata(posting, tightIndexed)).toEqual({ reject: true, reason: 'rules:stale' });
});

// --- CFG-04 hostile input ----------------------------------------------------

test('classifyMetadata treats a catastrophic-backtracking-shaped location term as a plain rejected literal, returning promptly (CFG-04, ReDoS safety by construction)', () => {
  const criteria = mkCriteria({ locationTerms: ['(a+)+$'] });
  const hostileLocation = 'a'.repeat(200);
  const start = Date.now();
  const result = classifyMetadata(mkPosting({ location: hostileLocation }), criteria);
  const elapsedMs = Date.now() - start;
  expect(elapsedMs).toBeLessThan(500);
  expect(result).toEqual({ reject: true, reason: 'rules:location' });
});

test('classifyMetadata never throws on a 100,000-character title', () => {
  const criteria = mkCriteria();
  const hugeTitle = 'x'.repeat(100000);
  expect(() => classifyMetadata(mkPosting({ title: hugeTitle }), criteria)).not.toThrow();
  expect(classifyMetadata(mkPosting({ title: hugeTitle }), criteria).reject).toBe(false);
});

// --- Never-throw envelope ----------------------------------------------------

test('classifyMetadata never throws and survives a null posting with valid criteria', () => {
  const criteria = mkCriteria();
  expect(classifyMetadata(null as unknown as PostingRow, criteria)).toEqual({ reject: false });
});

test('classifyMetadata never throws and survives a valid posting with null criteria', () => {
  expect(classifyMetadata(mkPosting(), null as unknown as CompiledCriteria)).toEqual({ reject: false });
});

test('classifyYoe never throws and survives null JD text with valid criteria', () => {
  const criteria = mkCriteria({ yoeThreshold: 1 });
  expect(classifyYoe(null as unknown as string, criteria)).toEqual({ reject: false });
});

test('classifyYoe does not reject when years exactly equals the threshold (strict greater-than)', () => {
  const criteria = mkCriteria({ yoeThreshold: 3 });
  const result = classifyYoe('requires 3 years of experience', criteria);
  expect(result.reject).toBe(false);
});
