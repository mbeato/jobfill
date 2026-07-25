// Deterministic, zero-cost rules prefilter (FILT-01, D-01-D-04). Two pure classifiers —
// classifyMetadata over the stored PostingRow (title/location/freshness) and classifyYoe
// over fetched JD text — mirroring hn.ts's defensive-string-function + try/catch-fallback
// style: never throw, never call the network/LLM, worst case survives to the next stage.
// Phase 18 (CFG-01): both classifiers now read their title/location terms, age caps, and
// YoE threshold from an injected CompiledCriteria object instead of module-scope literals;
// this file compiles nothing and stays db-free (D-05 compiles once per sweep, in criteria.ts).

import type { PostingRow } from './postings';
import type { BoardRow } from './boards';
import type { CompiledCriteria } from './criteria';

// D-13 decision_reason codes, kept as literal constants (mirrors failures.ts's
// VALID_STATUSES allowlist-enum style).
const REASON_TITLE = 'rules:title';
const REASON_LOCATION = 'rules:location';
const REASON_STALE = 'rules:stale';
const REASON_YOE = 'rules:yoe';
// D-12: its own code and dashboard bucket — a new board suppressing ~400
// postings should read as exactly that, not lumped into the generic `stale`
// bucket, which reports "too old" from a completely different clock.
const REASON_BOARD_GRACE = 'rules:board-grace';

// All regexes below are linear (no nested quantifiers) to stay ReDoS-safe (T-10-05):
// title/location/JD text are untrusted third-party strings. The injected patterns on
// CompiledCriteria are built by criteria.ts from escaped literal terms (D-05), so "all
// regexes here are linear" still holds, now by construction rather than by hand-authoring.

// "staff"/"lead" are ambiguous alone (e.g. "Member of Technical Staff" must survive),
// so they only count as seniority markers when adjacent to an engineering role word.
// D-04: these two stay authored here, not user-editable, because a flat term list
// cannot express a phrase with optional interior words — they exist so "Staff Software
// Engineer" is rejected while "Member of Technical Staff" survives. The
// criteria.staffLeadBuiltins boolean is the on/off control, for the user who is
// searching FOR staff roles.
const STAFF_ENGINEER_RE = /\bstaff\s+(?:software\s+)?(?:engineer|developer)\b/i;
const LEAD_ENGINEER_RE = /\blead\s+(?:software\s+)?(?:engineer|developer)\b|\bengineering\s+lead\b/i;

// Aggregator sources whose posted_at is an INDEX time — when the aggregator
// first observed the listing, not when the employer posted it. D-09 rightly
// refuses to trust that as an employer post date, but it is still a valid
// LOWER BOUND on how long the listing has been publicly visible, which is the
// crowding signal that matters. So these get their own, far more generous cap
// (criteria.maxStaleDaysIndexed) rather than bypassing the freshness filter entirely.
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

// D-01: the sources whose posted_at carries zero age information, so
// postings.created_at (when jobfill first staged the row) is their only honest
// freshness clock. Exactly these two:
//   - greenhouse: posted_at is job.updated_at, a MODIFICATION time that an edit
//     pushes forward — carries no age information (see INDEX_DATE_SOURCES above).
//   - yc: posted_at is NULL on every row.
// jobright is excluded: posted_at_trusted is true and it is already capped at
// criteria.maxStaleDays. simplify/getro are excluded: their index date is a genuine,
// strictly-stricter lower bound than a first-seen cap could be, so they must
// not gain a second, weaker clock on top of criteria.maxStaleDaysIndexed.
const FIRST_SEEN_SOURCES = new Set(['greenhouse', 'yc']);

// D-09: boards are harvested DURING a sweep but first polled on the NEXT
// sweep, so the grace window has to span harvest→next-poll regardless of time
// of day. Live evidence: all 427 auto-added boards have first_seen_at within
// one minute of each other, and their postings were staged by a LATER sweep.
// 24h would fall just short of that first poll for a board added late in the
// day and let its whole backlog through — exactly the failure FILT-07 exists
// to prevent. 72h was rejected as discarding two extra days of genuinely-new
// postings. Named explicitly in HOURS (not days, unlike every other cap in
// this file) to avoid a silent 24x unit-ambiguity bug. This window is
// deliberately NOT user-editable (Phase 17 D-13, Phase 18 D-03) — setting it
// to 0 would re-open the FILT-07 failure Phase 17 shipped to prevent,
// measured live at roughly 1,855 undecided rows from boards added the
// previous day.
export const GRACE_WINDOW_HOURS = 48;

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

export function classifyMetadata(posting: PostingRow, criteria: CompiledCriteria): { reject: boolean; reason?: string } {
  try {
    const title = String(posting?.title ?? '');
    // A null regex means that rule is skipped entirely (D-06) — never treat null as
    // "match all". criteria.staffLeadBuiltins gates the two adjacency-nuanced regexes.
    if (
      (criteria.seniorityRe !== null && criteria.seniorityRe.test(title)) ||
      (criteria.staffLeadBuiltins &&
        (STAFF_ENGINEER_RE.test(title) ||
          LEAD_ENGINEER_RE.test(title))) ||
      (criteria.nonEngineeringRe !== null && criteria.nonEngineeringRe.test(title))
    ) {
      return { reject: true, reason: REASON_TITLE };
    }

    const location = String(posting?.location ?? '').trim();
    // D-06 fail-open point: criteria.locationRe !== null is checked FIRST. An empty
    // accepted-locations list compiles to a null locationRe, meaning location
    // filtering is off — every posting reaches the precision-biased LLM stage. The
    // strict reading (empty accept-list means accept nothing) would silently reject
    // an entire sweep on rules:location, and rejection is permanent (Phase 9 D-14).
    if (
      criteria.locationRe !== null &&
      location &&
      (criteria.workModeOnlyRe === null || !criteria.workModeOnlyRe.test(location)) &&
      !criteria.locationRe.test(location)
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
        // criteria.maxStaleDaysIndexed (the generous cap for index-date sources) is
        // sized to the ~9-day average application window in tech-sector postings
        // (Davis & Samaniego de la Parra, "Application Flows", NBER w32320 — 66M
        // applications across ~8M Dice postings: 39% of applications arrive within
        // 48h of posting, 54% within 96h, median posting duration 7 days). 7 days
        // tracks that median: past it, the applicant pool has overwhelmingly formed
        // and the window is typically closing. Both caps are user-editable (CFG-01);
        // this research is why the D-14 generic defaults keep 2 / 7.
        const cap = trusted ? criteria.maxStaleDays : criteria.maxStaleDaysIndexed;
        if (ageDays > cap) {
          return { reject: true, reason: REASON_STALE };
        }
      }
    }

    // D-01/D-04: first-seen aging for sources whose posted_at carries no age
    // information — postings.created_at (when jobfill first staged the row) is
    // the only honest clock available. Fires across the whole to-decide
    // backlog, including postings the LLM never reached: a posting held
    // criteria.maxFirstSeenDays without evaluation is stale by the time it would
    // be evaluated, so backlog GC is the intended behavior, not a side effect.
    //
    // Phase 17 D-02: this cap has its own constant, NOT shared with
    // criteria.maxStaleDays (2) or criteria.maxStaleDaysIndexed (7): with
    // LLM_CAP() = 100 against a ~2,000-row FIFO backlog, a 2-day cutoff would
    // auto-reject postings because the LLM budget ran out before reaching them,
    // not because they are actually old. 7 days tracks the same application-window
    // research cited above for maxStaleDaysIndexed. Formerly exported from this
    // file as MAX_FIRST_SEEN_DAYS specifically because Phase 18's CFG-01 was
    // going to expose it as a user-editable setting — that claim was correct, and
    // this is where it was fulfilled: the cap now arrives as
    // criteria.maxFirstSeenDays. Unlike the GRACE_WINDOW_HOURS comment above, this
    // one is not being corrected, it is being fulfilled.
    if (FIRST_SEEN_SOURCES.has(String(posting?.source ?? ''))) {
      const createdTs = parseStoredTs(posting?.created_at);
      if (!Number.isNaN(createdTs)) {
        const ageDays = (Date.now() - createdTs) / (1000 * 60 * 60 * 24);
        if (ageDays > criteria.maxFirstSeenDays) {
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
        if (ageDays > criteria.maxFirstSeenDays) {
          return { reject: true, reason: REASON_STALE };
        }
      }
    }

    return { reject: false };
  } catch {
    return { reject: false };
  }
}

// D-13: a separate pure classifier, called as its own step in decide.ts's loop
// before classifyMetadata. The board is injected by the caller (batch-loaded
// once per sweep via a Map, per D-13) rather than queried here — this
// function stays db-free, pure, and never-throwing, exactly like
// classifyMetadata/classifyYoe above.
//
// D-08: both operands (posting.created_at, board.first_seen_at) are write-once
// stored timestamps — postings.created_at is absent from upsertPosting's ON
// CONFLICT SET list, and boards.first_seen_at is preserved by upsertBoard's ON
// CONFLICT per Phase 16 D-02. That is what makes a posting's grace verdict
// fixed forever: it never flips on re-examination, never depends on when this
// function happens to run, and degrades correctly when a sweep is skipped.
// This function therefore contains NO Date.now(), NO new Date(), and NO
// database access.
export function classifyBoardGrace(
  posting: PostingRow,
  board: BoardRow | null,
): { reject: boolean; reason?: string } {
  try {
    // D-11: fail open on a posting→board join miss. A posting whose
    // (source, company) matched no board row proceeds under normal
    // first-seen aging rather than being suppressed — a handful of extra
    // postings reaching the LLM is far cheaper than silently suppressing a
    // live board.
    if (!board) return { reject: false };

    const boardSeen = parseStoredTs(board?.first_seen_at);
    const postingCreated = parseStoredTs(posting?.created_at);
    if (Number.isNaN(boardSeen) || Number.isNaN(postingCreated)) return { reject: false };

    const deltaHours = (postingCreated - boardSeen) / (1000 * 60 * 60);

    // The deltaHours >= 0 lower bound is required, not optional. D-08's
    // predicate is "the posting was first staged WITHIN the window of the
    // board's own first-seen, i.e. it arrived in the same batch as the board
    // itself." A negative delta means the posting was staged BEFORE the
    // board row existed, so it demonstrably did not arrive with the board —
    // this happens when an already-polled token is later re-discovered by a
    // harvest and gains a board row after its postings were staged. Without
    // this guard, a bare `deltaHours < GRACE_WINDOW_HOURS` would permanently
    // reject every posting that predates its board row.
    if (deltaHours >= 0 && deltaHours < GRACE_WINDOW_HOURS) {
      return { reject: true, reason: REASON_BOARD_GRACE };
    }

    return { reject: false };
  } catch {
    return { reject: false };
  }
}

export function classifyYoe(jdText: string, criteria: CompiledCriteria): { reject: boolean; reason?: string } {
  try {
    // D-06/D-14: an unset threshold means the YoE rule is off — the JD is not
    // scanned at all.
    if (criteria.yoeThreshold === null) return { reject: false };
    const text = String(jdText ?? '');
    for (const match of text.matchAll(YOE_RE)) {
      const years = parseInt(match[1], 10);
      if (!Number.isNaN(years) && years > criteria.yoeThreshold) {
        return { reject: true, reason: REASON_YOE };
      }
    }
    return { reject: false };
  } catch {
    return { reject: false };
  }
}
