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

// Phase 17 D-02: the first-seen aging cutoff for sources whose posted_at carries
// zero age information (see FIRST_SEEN_SOURCES below). Its own constant, NOT
// shared with MAX_STALE_DAYS (2) or MAX_STALE_DAYS_INDEXED (7): with
// LLM_CAP() = 100 against a ~2,000-row FIFO backlog, a 2-day cutoff would
// auto-reject postings because the LLM budget ran out before reaching them,
// not because they are actually old. 7 days tracks the same application-window
// research cited above for MAX_STALE_DAYS_INDEXED. Exported (unlike the two
// existing caps) because Phase 18's CFG-01 exposes it as a user-editable setting.
export const MAX_FIRST_SEEN_DAYS = 7;

// D-01: the sources whose posted_at carries zero age information, so
// postings.created_at (when jobfill first staged the row) is their only honest
// freshness clock. Exactly these two:
//   - greenhouse: posted_at is job.updated_at, a MODIFICATION time that an edit
//     pushes forward — carries no age information (see INDEX_DATE_SOURCES above).
//   - yc: posted_at is NULL on every row.
// jobright is excluded: posted_at_trusted is true and it is already capped at
// MAX_STALE_DAYS. simplify/getro are excluded: their index date is a genuine,
// strictly-stricter lower bound than a first-seen cap could be, so they must
// not gain a second, weaker clock on top of MAX_STALE_DAYS_INDEXED.
const FIRST_SEEN_SOURCES = new Set(['greenhouse', 'yc']);

// SQLite writes datetime('now') as 'YYYY-MM-DD HH:MM:SS' — UTC but with no zone
// designator. A bare Date.parse on that string resolves it as LOCAL time,
// introducing a whole-timezone-offset error. This helper detects the SQLite
// shape and normalizes it to an explicit UTC ISO string before parsing;
// anything else (e.g. a real ISO-8601 string from a third-party API) falls
// back to plain Date.parse unchanged. Used identically by the first-seen aging
// check below and by classifyBoardGrace — the one case PATTERNS.md permits a
// shared helper in this file, since both read the same SQLite-format columns
// (postings.created_at, boards.first_seen_at).
function parseStoredTs(value: unknown): number {
  const s = String(value ?? '');
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    return Date.parse(`${s.replace(' ', 'T')}Z`);
  }
  return Date.parse(s);
}

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

    // D-01/D-04: first-seen aging for sources whose posted_at carries no age
    // information — postings.created_at (when jobfill first staged the row) is
    // the only honest clock available. Fires across the whole to-decide
    // backlog, including postings the LLM never reached: a posting held
    // MAX_FIRST_SEEN_DAYS without evaluation is stale by the time it would be
    // evaluated, so backlog GC is the intended behavior, not a side effect.
    if (FIRST_SEEN_SOURCES.has(String(posting?.source ?? ''))) {
      const createdTs = parseStoredTs(posting?.created_at);
      if (!Number.isNaN(createdTs)) {
        const ageDays = (Date.now() - createdTs) / (1000 * 60 * 60 * 24);
        if (ageDays > MAX_FIRST_SEEN_DAYS) {
          return { reject: true, reason: REASON_STALE };
        }
      }
    }

    // D-03: greenhouse's posted_at (= job.updated_at) is a lower bound on age
    // in exactly one direction. updated_at >= posted_at always, so an OLD
    // updated_at is honest proof the listing is at least that old — but a
    // RECENT updated_at proves nothing (an edit pushes it forward) and must
    // never be treated as evidence of freshness. The value is used only in
    // the direction where it is provably true, never the reverse (Phase 9
    // D-07, no fabricated dates). posted_at here is a real ISO-8601 string
    // from the Greenhouse API, not the SQLite format, so plain Date.parse
    // applies (not parseStoredTs).
    if (String(posting?.source ?? '') === 'greenhouse' && posting?.posted_at) {
      const updatedTs = Date.parse(posting.posted_at);
      if (!Number.isNaN(updatedTs)) {
        const ageDays = (Date.now() - updatedTs) / (1000 * 60 * 60 * 24);
        if (ageDays > MAX_FIRST_SEEN_DAYS) {
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
