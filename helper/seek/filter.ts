// Deterministic, zero-cost rules prefilter (FILT-01, D-01-D-04). Two pure classifiers —
// classifyMetadata over the stored PostingRow (title/location/freshness) and classifyYoe
// over fetched JD text — mirroring hn.ts's defensive-string-function + try/catch-fallback
// style: never throw, never call the network/LLM, worst case survives to the next stage.

import type { PostingRow } from './postings';

// D-13 decision_reason codes, kept as literal constants (mirrors failures.ts's
// VALID_STATUSES allowlist-enum style).
const REASON_TITLE = 'rules:title';
const REASON_LOCATION = 'rules:location';
const REASON_STALE = 'rules:stale';
const REASON_YOE = 'rules:yoe';

// All regexes below are linear (no nested quantifiers) to stay ReDoS-safe (T-10-05):
// title/location/JD text are untrusted third-party strings.

// Bare seniority words that are unambiguous on their own.
const BARE_SENIORITY_RE = /\b(senior|principal|sr\.?|vp|director|head of)\b/i;
// "staff"/"lead" are ambiguous alone (e.g. "Member of Technical Staff" must survive),
// so they only count as seniority markers when adjacent to an engineering role word.
const STAFF_ENGINEER_RE = /\bstaff\s+(?:software\s+)?(?:engineer|developer)\b/i;
const LEAD_ENGINEER_RE = /\blead\s+(?:software\s+)?(?:engineer|developer)\b|\bengineering\s+lead\b/i;

const NON_ENGINEERING_RE =
  /\b(product manager|product designer|designer|sales|recruiter|marketing|account executive|customer success)\b/i;

// D-02 as amended 2026-07-22: NY and SF are both home markets; US-generic
// location strings ("United States", "USA", "US") read as US-remote-friendly
// and survive to the LLM rather than hard-rejecting.
const NY_RE = /\b(new york|nyc|ny)\b/i;
const SF_RE = /\b(san francisco|sf)\b/i;
const US_GENERIC_RE = /\b(united states|usa|us)\b|\bu\.s\./i;
const REMOTE_RE = /\bremote\b/i;
// Work-mode strings some sources put in the location field ("Hybrid",
// "In-Office", "Full-time") carry no geography — treat as ambiguous (pass to
// the LLM), same as an empty location, instead of hard-rejecting.
const WORK_MODE_ONLY_RE = /^(hybrid|in[- ]?office|on[- ]?site|full[- ]?time|part[- ]?time|contract|flexible)$/i;

const MAX_STALE_DAYS = 2;

// Aggregator sources whose posted_at is an INDEX time — when the aggregator
// first observed the listing, not when the employer posted it. D-09 rightly
// refuses to trust that as an employer post date, but it is still a valid
// LOWER BOUND on how long the listing has been publicly visible, which is the
// crowding signal that matters. So these get their own, far more generous cap
// rather than bypassing the freshness filter entirely.
//
// Deliberately keyed on source, NOT on `posted_at_trusted === false`, because
// that flag covers two incompatible semantics:
//   - index date (simplify/getro): a lower bound on age — cappable.
//   - modification date (greenhouse's job.updated_at, per D-07): carries NO
//     age information, since an edit pushes it forward and makes an old
//     listing look new. Capping on it would reject ~14k greenhouse postings
//     for not having been edited recently, which is stability, not staleness.
// Greenhouse's real freshness clock is phase 17's first_seen_at.
const INDEX_DATE_SOURCES = new Set(['simplify', 'getro']);

// Sized to the ~9-day average application window in tech-sector postings
// (Davis & Samaniego de la Parra, "Application Flows", NBER w32320 — 66M
// applications across ~8M Dice postings: 39% of applications arrive within
// 48h of posting, 54% within 96h, median posting duration 7 days). 7 days
// tracks that median: past it, the applicant pool has overwhelmingly formed
// and the window is typically closing.
const MAX_STALE_DAYS_INDEXED = 7;

// Captures a leading integer immediately before "year(s)"/"yr(s)" (optionally with a
// trailing "+"), which covers plain ("3 years"), plus ("5+ years"), and
// minimum/at-least phrasing ("minimum 3 years") without a separate pattern.
const YOE_RE = /(\d+)\s*\+?\s*(?:years?|yrs?)/gi;

export function classifyMetadata(posting: PostingRow): { reject: boolean; reason?: string } {
  try {
    const title = String(posting?.title ?? '');
    if (BARE_SENIORITY_RE.test(title) || STAFF_ENGINEER_RE.test(title) || LEAD_ENGINEER_RE.test(title)) {
      return { reject: true, reason: REASON_TITLE };
    }
    if (NON_ENGINEERING_RE.test(title)) {
      return { reject: true, reason: REASON_TITLE };
    }

    const location = String(posting?.location ?? '').trim();
    if (
      location &&
      !WORK_MODE_ONLY_RE.test(location) &&
      !NY_RE.test(location) &&
      !SF_RE.test(location) &&
      !US_GENERIC_RE.test(location) &&
      !REMOTE_RE.test(location)
    ) {
      return { reject: true, reason: REASON_LOCATION };
    }

    const postedAt = posting?.posted_at;
    const trusted = posting?.posted_at_trusted === true;
    const indexed = !trusted && INDEX_DATE_SOURCES.has(String(posting?.source ?? ''));
    if ((trusted || indexed) && postedAt) {
      const ts = Date.parse(postedAt);
      if (!Number.isNaN(ts)) {
        const ageDays = (Date.now() - ts) / (1000 * 60 * 60 * 24);
        const cap = trusted ? MAX_STALE_DAYS : MAX_STALE_DAYS_INDEXED;
        if (ageDays > cap) {
          return { reject: true, reason: REASON_STALE };
        }
      }
    }

    return { reject: false };
  } catch {
    return { reject: false };
  }
}

export function classifyYoe(jdText: string): { reject: boolean; reason?: string } {
  try {
    const text = String(jdText ?? '');
    for (const match of text.matchAll(YOE_RE)) {
      const years = parseInt(match[1], 10);
      if (!Number.isNaN(years) && years > 1) {
        return { reject: true, reason: REASON_YOE };
      }
    }
    return { reject: false };
  } catch {
    return { reject: false };
  }
}
