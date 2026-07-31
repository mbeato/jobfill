// Configurable search criteria (CFG-01, D-01). This module is the single home
// for user-editable search criteria and the relevance profile: term lists, a
// staff/lead toggle, three age caps, and a YoE threshold. Terms are DATA and
// are never treated as regex patterns (D-05) — see escapeRegExp/compileTerms
// below for the construction that guarantees that. An empty term list means
// its rule is DISABLED, never "reject everything" (D-06) — this is the fail-
// open direction, chosen deliberately because rejection in this pipeline is
// permanent (Phase 9 D-14) and the strict reading is the same failure class
// as the Phase 16 bug that silently zeroed 251 boards nightly while the
// sweep still reported `status: ok`.

import type { Database } from 'bun:sqlite';
import { readSeekMeta, writeSeekMeta } from './meta';

// Storage keys into seek_meta (D-01: a settings table in jobfill.db is the
// source of truth; committed files are first-run defaults only).
export const CRITERIA_KEY = 'criteria';
export const RELEVANCE_PROFILE_KEY = 'relevance_profile';

// CFG-04 bounds: exist so a hostile or malformed edit cannot slow a sweep.
// Sized against the existing MAX_JD_LENGTH = 12000 (jd-fetch.ts:23) and
// MAX_REASON = 500 (relevance.ts:16) precedents, and fixed at these exact
// numbers by the phase UI contract.
export const MAX_TERMS = 50;
export const MAX_TERM_LENGTH = 60;
export const MAX_PROFILE_CHARS = 4000;
export const MIN_AGE_CAP_DAYS = 1;
export const MAX_AGE_CAP_DAYS = 365;
export const MAX_YOE_THRESHOLD = 50;

export interface Criteria {
  seniorityTerms: string[];
  nonEngineeringTerms: string[];
  locationTerms: string[];
  workModeOnlyTerms: string[];
  staffLeadBuiltins: boolean;
  maxStaleDays: number;
  maxStaleDaysIndexed: number;
  maxFirstSeenDays: number;
  yoeThreshold: number | null;
}

export interface CompiledCriteria {
  seniorityRe: RegExp | null;
  nonEngineeringRe: RegExp | null;
  locationRe: RegExp | null;
  workModeOnlyRe: RegExp | null;
  staffLeadBuiltins: boolean;
  maxStaleDays: number;
  maxStaleDaysIndexed: number;
  maxFirstSeenDays: number;
  yoeThreshold: number | null;
}

// D-14: the generic fresh-install defaults. A fresh install (no seed row —
// see D-13's one-time migration, added by a later plan) resolves to exactly
// this shape.
export function defaultCriteria(): Criteria {
  return {
    // Today's title-reject lists — domain knowledge about job titles, not a
    // personal preference, so they ship ON for a fresh install.
    seniorityTerms: ['senior', 'principal', 'sr', 'vp', 'director', 'head of'],
    nonEngineeringTerms: [
      'product manager',
      'product designer',
      'designer',
      'sales',
      'recruiter',
      'marketing',
      'account executive',
      'customer success',
    ],
    // EMPTY on purpose (D-14): NY/SF is the personal value, so a fresh
    // install ships with location filtering OFF (D-06 fail open). Do not
    // "fix" this to a default location list — that breaks CFG-05.
    locationTerms: [],
    // Noise strings some sources put in the location field — domain
    // knowledge about job listings (same rationale as the title lists), so
    // they ship on for the same reason D-14 ships the title lists on.
    workModeOnlyTerms: [
      'hybrid',
      'in-office',
      'in office',
      'inoffice',
      'on-site',
      'on site',
      'onsite',
      'full-time',
      'full time',
      'fulltime',
      'part-time',
      'part time',
      'parttime',
      'contract',
      'flexible',
    ],
    staffLeadBuiltins: true, // D-14
    // D-14: today's researched values — see filter.ts's NBER w32320 citation
    // for the sizing rationale.
    maxStaleDays: 2,
    maxStaleDaysIndexed: 7,
    maxFirstSeenDays: 7,
    // D-14: 0-1 years is the personal value, so the YoE rule ships off.
    yoeThreshold: null,
  };
}

// D-13 (HARD CONSTRAINT): today's live values, transcribed from the PRE-PHASE
// regexes in filter.ts (as they stood immediately before plan 18-03 deleted
// them — verified via `git show 3ea0546~1:helper/seek/filter.ts`) and from
// the committed seek.profile.md text. This is deliberately NOT
// defaultCriteria() (D-14): the seed answers "what was this install already
// doing," the defaults answer "what should a stranger's install do," and
// collapsing the two would silently change criteria on a live pipeline whose
// rejections are permanent — upsertPosting's ON CONFLICT omits
// decision/decision_reason/decided_at, so a wrongly-rejected posting is never
// revived by re-discovery (Phase 9 D-14). A one-time seed migration
// (seedCriteriaOnce, added by this plan) writes these into seek_meta exactly
// once so the live install's next sweep is byte-identical to its last one.
export const SEED_CRITERIA: Criteria = {
  // From BARE_SENIORITY_RE = /\b(senior|principal|sr\.?|vp|director|head of)\b/i.
  // 'sr' (not 'sr.') is the exact equivalent of the old `sr\.?`: a bare `sr`
  // term compiled with word boundaries matches both "Sr" and "Sr." — the \b
  // boundary sits between "r" and ".", which is itself a word/non-word
  // transition, so the trailing "." needs no explicit optional-dot handling.
  seniorityTerms: ['senior', 'principal', 'sr', 'vp', 'director', 'head of'],
  // From NON_ENGINEERING_RE, same order.
  nonEngineeringTerms: [
    'product manager',
    'product designer',
    'designer',
    'sales',
    'recruiter',
    'marketing',
    'account executive',
    'customer success',
  ],
  // The union of NY_RE, SF_RE, US_GENERIC_RE and REMOTE_RE. 'u.s.' is
  // US_GENERIC_RE's second branch (`\bu\.s\.`, no trailing \b) — it relies on
  // compileTerms' conditional trailing boundary (the term's own last
  // character, ".", is not \w, so no trailing \b is added) and must not be
  // dropped or rewritten as 'u.s'.
  locationTerms: ['new york', 'nyc', 'ny', 'san francisco', 'sf', 'united states', 'usa', 'us', 'u.s.', 'remote'],
  // WORK_MODE_ONLY_RE used `[- ]?` optional separators
  // (/^(hybrid|in[- ]?office|on[- ]?site|full[- ]?time|part[- ]?time|contract|flexible)$/i),
  // which a flat term list cannot express, so every separator variant is
  // enumerated explicitly. THIS IS THE SINGLE HIGHEST DRIFT RISK IN THE SEED:
  // an incomplete expansion means a location string that used to be treated
  // as mode-only noise (e.g. "in office") starts being compared against the
  // accepted-location list instead and gets rejected — permanently, per the
  // Phase 9 D-14 note above.
  workModeOnlyTerms: [
    'hybrid',
    'in-office',
    'in office',
    'inoffice',
    'on-site',
    'on site',
    'onsite',
    'full-time',
    'full time',
    'fulltime',
    'part-time',
    'part time',
    'parttime',
    'contract',
    'flexible',
  ],
  staffLeadBuiltins: true,
  // From MAX_STALE_DAYS / MAX_STALE_DAYS_INDEXED / MAX_FIRST_SEEN_DAYS.
  maxStaleDays: 2,
  maxStaleDaysIndexed: 7,
  maxFirstSeenDays: 7,
  // From classifyYoe's pre-phase `years > 1` comparison.
  yoeThreshold: 1,
};

// This seed applies only when readSeekMeta(db, RELEVANCE_PROFILE_KEY) is
// null (see the seed-once gate below) — i.e. only on a fresh install that
// has never saved a relevance profile. Existing installs already have a
// saved row and are unaffected by edits to this constant.
export const SEED_RELEVANCE_PROFILE = `# Seek Relevance Profile

Compact, user-editable steering summary for the LLM relevance pass (FILT-02).
Edit this file directly to change what "relevant" means — no code change needed.

## Target roles

(describe the roles you are targeting, e.g. "software engineer, fullstack
engineer, founding engineer at early-stage startups").

## Years of experience

(describe your experience level and any relevant degree/background, e.g.
"0-1 years, new-grad / junior, B.S. Computer Science").

## Core stack

(list the languages, frameworks, and tools you want matched against job
descriptions).

## Location

(describe your accepted locations, or note if you are open to remote).

## Anti-criteria (reject)

- (describe titles, seniority levels, or requirements to reject)
- (describe locations or role types to reject)
`;

// Read-boundary coercion, mirroring config.ts's toStringArray/toScheduleConfig
// house style for fail-closed parsing of untrusted config. A field that is
// entirely ABSENT falls back to the caller-supplied default (so a fresh
// object still resolves to the D-14 defaults); a field that is PRESENT but
// malformed coerces to the permissive/off value instead of the default — per
// D-06 that permissive value for a term list is [], the safe direction.
function toTermList(x: unknown, fallback: string[]): string[] {
  if (x === undefined) return fallback;
  if (!Array.isArray(x)) return [];
  return x
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t.length <= MAX_TERM_LENGTH)
    .slice(0, MAX_TERMS);
}

function toCap(x: unknown, fallback: number): number {
  const n = Number(x);
  return Number.isFinite(n) && n >= MIN_AGE_CAP_DAYS && n <= MAX_AGE_CAP_DAYS ? n : fallback;
}

function toYoe(x: unknown): number | null {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) && n >= 0 && n <= MAX_YOE_THRESHOLD ? n : null;
}

// Read only the nine known property names. The parsed object is never
// spread and no unknown key is ever copied through — the returned object is
// constructed field by field from literals (T-18-01-03).
export function toCriteria(x: unknown): Criteria {
  const d = defaultCriteria();
  const obj = x as Partial<Record<keyof Criteria, unknown>> | null | undefined;
  return {
    seniorityTerms: toTermList(obj?.seniorityTerms, d.seniorityTerms),
    nonEngineeringTerms: toTermList(obj?.nonEngineeringTerms, d.nonEngineeringTerms),
    locationTerms: toTermList(obj?.locationTerms, d.locationTerms),
    workModeOnlyTerms: toTermList(obj?.workModeOnlyTerms, d.workModeOnlyTerms),
    // The default is ON, so an absent or malformed value must stay on — only
    // an explicit `false` turns it off. NOT `Boolean(obj?.staffLeadBuiltins)`.
    staffLeadBuiltins: obj?.staffLeadBuiltins !== false,
    maxStaleDays: toCap(obj?.maxStaleDays, d.maxStaleDays),
    maxStaleDaysIndexed: toCap(obj?.maxStaleDaysIndexed, d.maxStaleDaysIndexed),
    maxFirstSeenDays: toCap(obj?.maxFirstSeenDays, d.maxFirstSeenDays),
    yoeThreshold: toYoe(obj?.yoeThreshold),
  };
}

const TERM_FIELDS = ['seniorityTerms', 'nonEngineeringTerms', 'locationTerms', 'workModeOnlyTerms'] as const;
const CAP_FIELDS = ['maxStaleDays', 'maxStaleDaysIndexed', 'maxFirstSeenDays'] as const;

// Write-boundary validation — the codebase's double posture (allowlist and
// explicit rejection at write, fail-closed coercion at read). Returns
// { ok: false, error } instead of silently coercing, so a bad PATCH gets a
// 400 rather than a surprise. An EMPTY term list is VALID and must pass — it
// is how a user turns a rule off (D-06); there is no "at least one term"
// check on any list.
export function validateCriteria(x: unknown): { ok: true; criteria: Criteria } | { ok: false; error: string } {
  const obj = x as Record<string, unknown> | null | undefined;
  if (obj === null || typeof obj !== 'object') {
    return { ok: false, error: 'malformed criteria' };
  }

  for (const field of TERM_FIELDS) {
    const list = obj[field];
    if (!Array.isArray(list)) {
      return { ok: false, error: 'malformed criteria' };
    }
    if (list.length > MAX_TERMS) {
      return { ok: false, error: 'too many terms — max 50' };
    }
    for (const term of list) {
      if (typeof term !== 'string') {
        return { ok: false, error: 'malformed criteria' };
      }
      if (term.length > MAX_TERM_LENGTH) {
        return { ok: false, error: `"${term}" is too long — max 60 characters` };
      }
    }
  }

  if (typeof obj.staffLeadBuiltins !== 'boolean') {
    return { ok: false, error: 'malformed criteria' };
  }

  for (const field of CAP_FIELDS) {
    const n = Number(obj[field]);
    if (!Number.isFinite(n) || n < MIN_AGE_CAP_DAYS || n > MAX_AGE_CAP_DAYS) {
      return { ok: false, error: 'must be between 1 and 365 days' };
    }
  }

  const yoe = obj.yoeThreshold;
  if (yoe !== null && yoe !== undefined && yoe !== '') {
    const n = Number(yoe);
    if (!Number.isFinite(n) || n < 0 || n > MAX_YOE_THRESHOLD) {
      return { ok: false, error: 'must be between 0 and 50, or left blank for no cap' };
    }
  }

  // Stored document is always the normalized, trimmed shape.
  return { ok: true, criteria: toCriteria(x) };
}

// Load-bearing line of CFG-04 (D-05): after this call, no character in `s`
// retains regex metacharacter meaning, so every pattern compiled below is a
// fixed alternation of escaped literals — linear, and unable to run away on
// adversarial input. This is why the phase needs no scoring of pattern
// danger, no cap on how long a match may run, and no scan for risky nested-
// repeat shapes: if any of those ever appear, this escape has been bypassed
// somewhere, and that is the bug to find.
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// terms -> a single compiled alternation, or null when the rule is OFF
// (D-06 — an empty/all-blank list never compiles to a "match nothing"
// regex). Both modes compile case-insensitive with NO `g` flag: a `g` regex
// carries lastIndex state across .test() calls, which would make the
// classifier non-deterministic.
export function compileTerms(terms: string[], mode: 'word' | 'whole'): RegExp | null {
  const clean = terms.map((t) => t.trim()).filter((t) => t.length > 0);
  if (clean.length === 0) return null;
  // The escape makes construction unreachable-to-throw in practice; the
  // try/catch guarantees that even an unreachable failure degrades to
  // rule-off rather than to a thrown sweep.
  try {
    const pattern =
      mode === 'whole'
        ? // Whole-string semantics, reproducing WORK_MODE_ONLY_RE.
          `^(?:${clean.map(escapeRegExp).join('|')})$`
        : // Word mode: the \b on each side is conditional on whether the
          // ORIGINAL (pre-escape) first/last character is a word character.
          // A fixed \b(...)\b would break a term like "u.s.": \b after a "."
          // demands a following word character, so "Remote, U.S." would
          // stop matching. Anchoring only where the boundary is actually a
          // word/non-word transition reproduces filter.ts's existing
          // asymmetric regexes (US_GENERIC_RE's `\bu\.s\.` has no trailing
          // \b) exactly.
          `(?:${clean
            .map((t) => {
              const lead = /\w/.test(t[0]) ? '\\b' : '';
              const trail = /\w/.test(t[t.length - 1]) ? '\\b' : '';
              return `${lead}${escapeRegExp(t)}${trail}`;
            })
            .join('|')})`;
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

// Called once per sweep (D-05), never per posting.
export function compileCriteria(c: Criteria): CompiledCriteria {
  return {
    seniorityRe: compileTerms(c.seniorityTerms, 'word'),
    nonEngineeringRe: compileTerms(c.nonEngineeringTerms, 'word'),
    locationRe: compileTerms(c.locationTerms, 'word'),
    workModeOnlyRe: compileTerms(c.workModeOnlyTerms, 'whole'),
    staffLeadBuiltins: c.staffLeadBuiltins,
    maxStaleDays: c.maxStaleDays,
    maxStaleDaysIndexed: c.maxStaleDaysIndexed,
    maxFirstSeenDays: c.maxFirstSeenDays,
    yoeThreshold: c.yoeThreshold,
  };
}

// Fresh-read, no caching — mirrors loadSeekConfig/loadProfileSummary.
// Snapshot-per-sweep semantics: a save that lands mid-sweep takes effect on
// the NEXT call (the next sweep), not the one in flight. A missing row
// (fresh install, no seed yet) or any parse failure both fall back to
// defaultCriteria() — this never throws onto the sweep hot path.
export function readCriteria(db: Database): Criteria {
  try {
    const raw = readSeekMeta(db, CRITERIA_KEY);
    if (raw === null) return defaultCriteria();
    return toCriteria(JSON.parse(raw));
  } catch {
    return defaultCriteria();
  }
}

// The single function plan 05 injects into DecideDeps.
export function loadCriteria(db: Database): CompiledCriteria {
  return compileCriteria(readCriteria(db));
}

// Callers pass the normalized object out of validateCriteria — never a raw
// request body — so what lands in seek_meta is always the trimmed,
// bounds-clamped shape.
export function saveCriteria(db: Database, c: Criteria): void {
  writeSeekMeta(db, CRITERIA_KEY, JSON.stringify(c));
}

// Stored as raw text, not JSON-wrapped.
export function readRelevanceProfile(db: Database): string | null {
  try {
    return readSeekMeta(db, RELEVANCE_PROFILE_KEY);
  } catch {
    return null;
  }
}

export function saveRelevanceProfile(db: Database, text: string): void {
  writeSeekMeta(db, RELEVANCE_PROFILE_KEY, text.slice(0, MAX_PROFILE_CHARS));
}

// D-13: its own module-local constant with its own version suffix — distinct
// from sweep.ts's Phase 17 board-backfill gate key. A shared key would make
// one migration silently skip the other.
export const CRITERIA_SEED_KEY = 'criteria_seed_v1';

// One-time D-13 seed migration. Two call sites wire this in: runSweep's
// prologue (covers every sweep path) and helper startup (covers the window
// between a deploy and the first sweep, during which the settings tab is
// already reachable and a user could save). Both are gated on the same key,
// so calling twice is a no-op.
//
// Returns whether THIS call seeded, so tests and callers can observe it.
//
// Deliberately no try/catch here (unlike readCriteria/readRelevanceProfile
// above): the callers own the degrade-silently posture (mirroring how
// runSweep's prologue wraps the board backfill), and swallowing here would
// make the "gate key written only on success" contract below unobservable —
// a caller-side catch needs the throw to propagate before the gate key is
// written, or the retry-on-failure guarantee silently breaks.
export function seedCriteriaOnce(db: Database): boolean {
  // The gate has already fired; the ordinary read path (readCriteria) owns
  // the values from here on.
  if (readSeekMeta(db, CRITERIA_SEED_KEY) !== null) return false;

  // Absent-only per-key check — a SECOND guard on top of the gate above. If a
  // user somehow saved settings before the gate fired, the seed must not
  // clobber their save.
  if (readSeekMeta(db, CRITERIA_KEY) === null) {
    saveCriteria(db, SEED_CRITERIA);
  }
  if (readSeekMeta(db, RELEVANCE_PROFILE_KEY) === null) {
    saveRelevanceProfile(db, SEED_RELEVANCE_PROFILE);
  }

  // Written LAST, only after both writes above succeed. If either throws,
  // this line never runs, so the gate key is never written and the next
  // sweep retries instead of burning the one-time window and silently
  // falling through to the D-14 generic defaults — which on the live install
  // would mean running a stranger's criteria against the operator's backlog.
  writeSeekMeta(db, CRITERIA_SEED_KEY, new Date().toISOString());
  return true;
}
