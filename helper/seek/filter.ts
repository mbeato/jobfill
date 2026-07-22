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
const STAFF_ENGINEER_RE = /\bstaff\s+(?:engineer|developer)\b/i;
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
    if (posting?.posted_at_trusted === true && postedAt) {
      const ts = Date.parse(postedAt);
      if (!Number.isNaN(ts)) {
        const ageDays = (Date.now() - ts) / (1000 * 60 * 60 * 24);
        if (ageDays > MAX_STALE_DAYS) {
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
