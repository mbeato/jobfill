import type { Database } from 'bun:sqlite';
import { ghostDaysFor, laneForUrl, GHOST_DAYS_DEFAULT } from './ghost-policy';

// Post-submission CRM: the applications table's lifecycle + derived ghost signal.
// Mirrors queue.ts/failures.ts — dependency-injected `Database`, self-defending at
// the persistence boundary (bound text, allowlist untrusted enum before write),
// unit-tested against a bare `new Database(':memory:')`. server.ts owns the routes
// and passes any cross-table resolver in.

export interface ApplicationRow {
  id: number;
  company: string;
  role: string;
  url: string;
  status: string;
  notes: string;
  resume_path: string;
  cost_usd: number;
  summary: string;
  tailor_state: string;
  tailor_message: string;
  jd: string;
  cover_letter_path: string;
  brief_path: string;
  email_path: string;
  map_source: string;
  map_fallback_reason: string;
  status_changed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApplicationInput {
  company?: string;
  role?: string;
  url?: string;
  status?: string;
  resume_path?: string;
  cost_usd?: number;
  summary?: unknown[];
  tailor_state?: string;
  tailor_message?: string;
  jd?: string;
  map_source?: string;
  map_fallback_reason?: string;
}

export interface ApplicationUpdatePatch {
  status?: string;
  notes?: string;
}

// WR-04-style bound: defend the persistence boundary regardless of caller.
const MAX_TEXT = 2000;

// D-04/D-06: jd gets its OWN generous bound, separate from MAX_TEXT — real JDs
// run 3k-10k+ chars and MAX_TEXT would silently truncate them.
export const MAX_JD = 50000;

// Status ladder: unsubmitted -> applied -> replied -> interviewing -> offer -> rejected.
// The pre-submit token is Claude's discretion (D-05); the UI label "awaiting submit"
// is applied in Plan 03. Stored as a lowercase id consistent with QUEUE_STATUSES vocab.
export const PRE_SUBMIT_STATUS = 'unsubmitted';
export const APPLICATION_STATUSES = new Set([
  PRE_SUBMIT_STATUS,
  'applied',
  'replied',
  'interviewing',
  'offer',
  'rejected',
]);

// D-16: the ghost threshold is a named exported constant in the helper, NOT
// seek.config.json. A row silent this many days (or more) derives ghosted=true.
// Retained as the DEFAULT threshold — the value used for any board without an
// explicit entry in GHOST_DAYS_BY_LANE. Per-lane overrides live in ghost-policy.ts.
export const GHOST_DAYS = GHOST_DAYS_DEFAULT;

// T-999.1-01: allowlist for map_source, the diagnostic twin of APPLICATION_STATUSES
// above. Coerced, not thrown, at the persistence boundary — status is a lifecycle
// enum whose corruption is a correctness bug, while map_source is a diagnostic and
// failing the whole insert over it would violate the fill path's fail-open contract.
export const MAP_SOURCES = new Set(['helper', 'haiku']);

export class InvalidApplicationStatusError extends Error {
  constructor(status: string) {
    super(`invalid application status: ${status}`);
    this.name = 'InvalidApplicationStatusError';
  }
}

// Defensive, db-free JSON parse mirroring server.ts parseSummary — summary is a
// stored JSON blob, returned to callers as an array (or null when empty/corrupt).
function parseSummary(stored: string): string[] | null {
  try {
    const arr = JSON.parse(stored);
    return Array.isArray(arr) && arr.length ? arr : null;
  } catch {
    return null;
  }
}

export function createApplicationsTable(db: Database) {
  // Fresh-create carries the FULL column set this module reads/writes: the base
  // DDL (server.ts:58-69) PLUS the columns that live only as ALTER guards on the
  // live db (summary/tailor_state/tailor_message) PLUS status_changed_at. makeDb()
  // in the test runs ONLY this — omit any and insertApplication throws "no such
  // column". The server.ts ALTER guards stay harmless no-ops on a fresh db (dual
  // pattern, same as url_key at queue.ts:103 + server.ts:113).
  db.run(`CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company TEXT NOT NULL,
    role TEXT DEFAULT '',
    url TEXT DEFAULT '',
    status TEXT DEFAULT 'applied',
    notes TEXT DEFAULT '',
    resume_path TEXT DEFAULT '',
    cost_usd REAL DEFAULT 0,
    summary TEXT DEFAULT '',
    tailor_state TEXT DEFAULT '',
    tailor_message TEXT DEFAULT '',
    jd TEXT DEFAULT '',
    cover_letter_path TEXT DEFAULT '',
    brief_path TEXT DEFAULT '',
    email_path TEXT DEFAULT '',
    map_source TEXT DEFAULT '',
    map_fallback_reason TEXT DEFAULT '',
    status_changed_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  // Dedupe at the write boundary via schema-level uniqueness, not in callers —
  // the same rule queue/postings already follow, which this table was the one
  // exception to. insertApplication's ON CONFLICT target resolves against THIS
  // index, so the two must stay in step: without it the upsert is a syntax
  // error, and without the upsert the index turns a re-fill into a throw.
  //
  // PARTIAL on url <> '': applications logged without a url are legitimate and
  // plural (34 live), and a plain unique index would let only one of them exist.
  //
  // IF NOT EXISTS makes this the migration too — an existing db picks the index
  // up at boot. That only succeeds once duplicates are gone, which is deliberate:
  // it fails loudly rather than silently leaving the table unconstrained.
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_url
          ON applications(url) WHERE url <> ''`);
}

export function insertApplication(
  db: Database,
  input: ApplicationInput,
  resolveQueueId: (url: string) => number | null,
): ApplicationRow {
  // Signature parity with failures.ts: the resolver is accepted so server.ts can
  // own the cross-table queue.application_id write, but this module never touches
  // the queue table itself — it only returns the inserted row. (Reference kept so
  // the param is not flagged unused while the caller wires the link in Plan 02.)
  void resolveQueueId;
  // T-13-01: the trust boundary is the POST body, not the extension. Allowlist any
  // caller-supplied status before it reaches the store — never trust the string.
  const status = input.status ?? PRE_SUBMIT_STATUS; // D-06 default
  if (!APPLICATION_STATUSES.has(status)) throw new InvalidApplicationStatusError(status);
  // T-999.1-01: coerce rather than throw (see MAP_SOURCES comment) — an application
  // log must never be lost over a provenance typo.
  const mapSource = MAP_SOURCES.has(input.map_source as string) ? (input.map_source as string) : '';
  return db
    .query(
      // WR-02: seed status_changed_at at insert (same instant the row is created) so a
      // direct status:'applied' POST starts an honest ghost clock instead of NULL —
      // consistent with the D-20 boot seed. Pre-submit rows never ghost regardless.
      // Upsert on url, against the partial unique index idx_applications_url
      // (see createApplicationsTable). Before this, a plain INSERT forked a NEW
      // application row on every fill of the same posting, and since
      // queue.application_id links exactly ONE of them, marking the queue row
      // submitted flipped only that one — the siblings sat at the pre-submit
      // token forever and read as "awaiting submit" for postings already
      // submitted. It also inflated the applied count. Observed live: 8 urls
      // with 2-3 rows each, 11 rows collapsed.
      //
      // Two things deliberately NOT overwritten on conflict:
      //  - status, because a re-fill must never un-submit an applied row. This
      //    is the whole correctness point; excluded.status would regress it to
      //    the pre-submit default on every refill.
      //  - notes, which are hand-written and are not the fill's to clobber.
      // cost_usd ACCUMULATES: each attempt really did spend, so summing is the
      // honest total rather than the last attempt's alone.
      //
      // The WHERE matches the index predicate, which SQLite requires to resolve
      // a partial-index conflict target. Rows with an empty url are outside the
      // index and still insert freely, as they always did.
      `INSERT INTO applications (company, role, url, status, resume_path, cost_usd, summary, tailor_state, tailor_message, jd, map_source, map_fallback_reason, status_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(url) WHERE url <> '' DO UPDATE SET
         -- CR-02: these two carry the same never-replace-a-real-value-with-a-
         -- placeholder guard as the columns below. Unguarded they were
         -- DESTRUCTIVE: extension/background.js sends role: mapping.role || '',
         -- and a missing company defaults to 'unknown' at the top of this
         -- function, so a re-fill that could not read them off the page
         -- overwrote a good "Acme Corp"/"Senior SWE" with "unknown"/"".
         -- 'unknown' is compared literally because it is this function's own
         -- default, not a value any caller means.
         company        = CASE WHEN excluded.company NOT IN ('', 'unknown') THEN excluded.company ELSE applications.company END,
         role           = CASE WHEN excluded.role           <> '' THEN excluded.role           ELSE applications.role           END,
         resume_path    = CASE WHEN excluded.resume_path    <> '' THEN excluded.resume_path    ELSE applications.resume_path    END,
         summary        = CASE WHEN excluded.summary        <> '' THEN excluded.summary        ELSE applications.summary        END,
         tailor_state   = CASE WHEN excluded.tailor_state   <> '' THEN excluded.tailor_state   ELSE applications.tailor_state   END,
         tailor_message = CASE WHEN excluded.tailor_message <> '' THEN excluded.tailor_message ELSE applications.tailor_message END,
         jd             = CASE WHEN excluded.jd             <> '' THEN excluded.jd             ELSE applications.jd             END,
         -- map_source follows the same never-replace-a-real-value-with-a-placeholder
         -- guard as the columns above. map_fallback_reason deliberately does NOT guard
         -- on its own emptiness — it guards on excluded.map_source <> '' instead, so
         -- the reason moves in lockstep with the source. Guarded on its own value, a
         -- helper-path re-fill (which sends an empty reason) would leave the previous
         -- haiku fill's error string on a row now reading map_source='helper', i.e. a
         -- row that lies. Keyed to the source, a provenance-carrying re-fill always
         -- rewrites both, and a provenance-free caller still rewrites neither.
         map_source          = CASE WHEN excluded.map_source <> '' THEN excluded.map_source          ELSE applications.map_source          END,
         map_fallback_reason = CASE WHEN excluded.map_source <> '' THEN excluded.map_fallback_reason ELSE applications.map_fallback_reason END,
         cost_usd       = applications.cost_usd + excluded.cost_usd,
         updated_at     = datetime('now')
       RETURNING *`,
    )
    .get(
      String(input.company ?? 'unknown').slice(0, MAX_TEXT),
      String(input.role ?? '').slice(0, MAX_TEXT),
      String(input.url ?? '').slice(0, MAX_TEXT),
      status,
      String(input.resume_path ?? '').slice(0, MAX_TEXT),
      Number(input.cost_usd ?? 0),
      Array.isArray(input.summary) && input.summary.length ? JSON.stringify(input.summary) : '',
      String(input.tailor_state ?? '').slice(0, MAX_TEXT),
      String(input.tailor_message ?? '').slice(0, MAX_TEXT),
      String(input.jd ?? '').slice(0, MAX_JD),
      mapSource,
      String(input.map_fallback_reason ?? '').slice(0, MAX_TEXT),
    ) as ApplicationRow;
}

export function updateApplicationStatus(
  db: Database,
  id: number,
  patch: ApplicationUpdatePatch,
): ApplicationRow | null {
  // T-13-01: allowlist the untrusted enum at the write boundary before any UPDATE.
  if (patch.status !== undefined && !APPLICATION_STATUSES.has(patch.status)) {
    throw new InvalidApplicationStatusError(patch.status);
  }
  const current = db.query('SELECT status FROM applications WHERE id = ?').get(id) as { status: string } | null;
  const fields: string[] = [];
  const vals: unknown[] = [];
  if (patch.status !== undefined) {
    fields.push('status = ?');
    vals.push(patch.status);
    // D-11: bump the ghost clock ONLY when the value actually changes — re-selecting
    // the same status is a no-op for status_changed_at, so an accidental re-pick can't
    // reset the clock. D-17: any real status change implicitly clears the ghost badge
    // because the badge derives from status_changed_at + status, with no separate path.
    if (current && patch.status !== current.status) {
      fields.push(`status_changed_at = datetime('now')`);
    }
  }
  if (patch.notes !== undefined) {
    fields.push('notes = ?');
    vals.push(String(patch.notes).slice(0, MAX_TEXT));
  }
  // D-12: updated_at bumps on every accepted edit, unconditionally (queue.ts:188).
  if (fields.length) {
    db.query(`UPDATE applications SET ${fields.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...vals, id);
  }
  // D-08: explicit jd-free column list — this row backs PATCH /applications/:id,
  // whose response is refetched into the dashboard on every status/notes edit.
  // SELECT * would ship the multi-KB jd blob back on each edit (CR-01).
  return db
    .query(
      `SELECT id, company, role, url, status, notes, resume_path, cost_usd, summary,
              tailor_state, tailor_message, status_changed_at, created_at, updated_at
       FROM applications WHERE id = ?`,
    )
    .get(id) as ApplicationRow | null;
}

// D-13/D-14/D-16/D-17: the ghost rule, pure and db-free so `bun test` covers it and
// every /applications consumer gets the identical derivation. ghosted applies to
// 'applied' rows ONLY — a non-'applied' or pre-submit row never ghosts, regardless
// of how long it has sat. Nothing is stored; the badge is entirely derived.
export function deriveGhost(
  row: { status: string; status_changed_at: string | null; url?: string | null },
  now: Date = new Date(),
): { ghosted: boolean; days_silent: number; ghost_after_days: number; lane: string } {
  const daysSilent = daysSince(row.status_changed_at, now);
  // Per-lane threshold (see ghost-policy.ts): a workatastartup row silent for two
  // weeks is dead, while an ATS row at the same age is merely in a queue. `url` is
  // optional so existing callers that pass only the lifecycle fields keep the
  // default 21 rather than silently changing behaviour.
  const ghostAfter = ghostDaysFor(row.url);
  return {
    ghosted: row.status === 'applied' && daysSilent >= ghostAfter,
    days_silent: daysSilent,
    // Surfaced so the UI can say WHY a row is or is not ghosted, instead of the
    // reader having to know the table of thresholds.
    ghost_after_days: ghostAfter,
    lane: laneForUrl(row.url),
  };
}

// Defensive: sqlite datetime('now') stores 'YYYY-MM-DD HH:MM:SS' in UTC with no zone.
// Normalize to an ISO-UTC instant before parsing so the day delta is timezone-stable;
// default to 0 on a missing/unparseable stamp (never throw — deriveGhost is pure).
function daysSince(stamp: string | null, now: Date): number {
  const raw = String(stamp ?? '').trim();
  if (!raw) return 0;
  const hasZone = /[zZ]$|[+-]\d\d:?\d\d$/.test(raw);
  const iso = raw.replace(' ', 'T') + (hasZone ? '' : 'Z');
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return 0;
  return Math.floor((now.getTime() - ts) / 86400000);
}

export function listApplications(db: Database) {
  const rows = db.query('SELECT * FROM applications ORDER BY created_at DESC').all() as ApplicationRow[];
  return rows.map(row => ({ ...row, summary: parseSummary(row.summary), ...deriveGhost(row) }));
}

// T-13-03: the D-07 submit cascade calls this. It promotes ONLY when the row is
// still at the pre-submit status; it refuses (no write, returns false) for every
// other status, so it can never advance a row past its human-set state. Routing
// through updateApplicationStatus means the D-11 clock bumps on promotion.
export function promoteUnsubmittedToApplied(db: Database, applicationId: number): boolean {
  const current = db.query('SELECT status FROM applications WHERE id = ?').get(applicationId) as {
    status: string;
  } | null;
  if (!current || current.status !== PRE_SUBMIT_STATUS) return false;
  updateApplicationStatus(db, applicationId, { status: 'applied' });
  return true;
}
