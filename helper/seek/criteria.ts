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
