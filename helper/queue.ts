import type { Database } from 'bun:sqlite';
import { normalizeUrl } from './seek/normalize';
import type { PostingRow } from './seek/postings';

// Posting queue: pre-submission review lifecycle, a sibling of the `applications`
// (post-submission CRM) table — never conflated with it. Mirrors helper/failures.ts's
// dependency-injected, self-defending style (bound text inputs, allowlist untrusted
// enum before write).

export interface QueueRow {
  id: number;
  url: string;
  status: string;
  company: string;
  role: string;
  application_id: number | null;
  results_summary: string;
  error: string;
  // Raw shape as returned by sqlite — url_key is a dedup key (D-11), not a
  // fillable URL; login_gated/not_fillable/low_confidence arrive as 0/1
  // integers, same as listQueue/updateQueueStatus already return for every
  // other row.
  url_key: string | null;
  login_gated: number;
  not_fillable: number;
  low_confidence: number;
  resume_name: string;
  created_at: string;
  updated_at: string;
}

export interface QueueUpdatePatch {
  status?: string;
  company?: string;
  role?: string;
  application_id?: number | null;
  results_summary?: string;
  error?: string;
  resume_name?: string;
}

// WR-04-style bound: defend the persistence boundary regardless of caller.
const MAX_TEXT = 2000;

// results_summary is a JSON blob (per-field results array), not display text — the
// MAX_TEXT bound would slice it mid-stream and corrupt it for any realistic form.
// Larger dedicated bound, and truncation is structural (see truncateResultsSummary)
// so the stored value is ALWAYS valid JSON.
const MAX_SUMMARY = 20_000;

// Never slice a JSON string lexically: over the bound, re-serialize a reduced
// per-field summary (id/label/status, plus the review-gating `stuck` flag —
// a didn't-stick field's status is still 'filled', so dropping `stuck` here
// would silently unflag it for the dashboard and the runner's review rules);
// if even that is too big or the input isn't valid JSON, store a marker object
// the dashboard can render safely.
function truncateResultsSummary(raw: string): string {
  if (raw.length <= MAX_SUMMARY) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const reduced = JSON.stringify(
        parsed.slice(0, 200).map((r: { id?: unknown; label?: unknown; status?: unknown; stuck?: unknown }) => ({
          id: r?.id,
          label: r?.label,
          status: r?.status,
          ...(typeof r?.stuck === 'boolean' ? { stuck: r.stuck } : {}),
        })),
      );
      if (reduced.length <= MAX_SUMMARY) return reduced;
    }
  } catch {}
  return JSON.stringify({ truncated: true });
}

// Status lifecycle: queued -> filling -> filled/failed -> reviewed -> submitted.
// 'submitted' is a legal allowlist value here — the D-02 boundary (only a human
// dashboard click may set it) is enforced by the caller, not this module.
export const QUEUE_STATUSES = new Set(['queued', 'filling', 'filled', 'failed', 'reviewed', 'submitted']);

// WR-05: reviewed/submitted are human-set, later-lifecycle states. An automated fill
// that finishes after the operator already reviewed/submitted the row must never regress it.
const HUMAN_STATUSES = new Set(['reviewed', 'submitted']);
const RUN_STATUSES = new Set(['filling', 'filled', 'failed']);

export class InvalidQueueStatusError extends Error {
  constructor(status: string) {
    super(`invalid queue status: ${status}`);
    this.name = 'InvalidQueueStatusError';
  }
}

export function createQueueTable(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    company TEXT DEFAULT '',
    role TEXT DEFAULT '',
    application_id INTEGER,
    results_summary TEXT DEFAULT '',
    error TEXT DEFAULT '',
    url_key TEXT UNIQUE,
    login_gated INTEGER DEFAULT 0,
    not_fillable INTEGER DEFAULT 0,
    low_confidence INTEGER DEFAULT 0,
    resume_name TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
}

// Manual add (POST /queue, the extension's "queue this page" path). This used
// to insert `url` alone, leaving url_key NULL — so a hand-added row carried no
// dedup key at all until the next helper restart ran the D-11 backfill, and in
// that window nothing could match it. Setting the key here closes the window
// and makes a re-add idempotent instead of duplicating.
export function insertQueueEntry(db: Database, url: string): QueueRow {
  const trimmed = String(url ?? '').slice(0, MAX_TEXT);
  const key = normalizeUrl(trimmed);
  // No derivable key (normalizeUrl failed on a malformed url): fall back to the
  // old NULL-key insert rather than letting several unkeyed rows collide on ''.
  if (!key) {
    return db.query(`INSERT INTO queue (url) VALUES (?) RETURNING *`).get(trimmed) as QueueRow;
  }
  const row = db
    .query(`INSERT INTO queue (url, url_key) VALUES (?, ?) ON CONFLICT(url_key) DO NOTHING RETURNING *`)
    .get(trimmed, key) as QueueRow | null;
  // Already queued under this key — hand back the existing row. Idempotent, and
  // it never regresses a human-set status, matching insertQueueEntryFromPosting.
  return row ?? (db.query(`SELECT * FROM queue WHERE url_key = ?`).get(key) as QueueRow);
}

// D-09/D-10/D-11: promotion insert from a scored `postings` row. Schema-level
// dedupe via url_key UNIQUE — a second insert for an already-queued posting
// is a no-op (ON CONFLICT DO NOTHING), the first row survives untouched.
export function insertQueueEntryFromPosting(db: Database, posting: PostingRow): QueueRow | null {
  // Scheme allowlist re-asserted at this boundary (defense in depth, mirrors
  // the postings.ts persistence-boundary check).
  if (!/^https?:\/\//i.test(String(posting.url ?? ''))) return null;
  const urlKey = normalizeUrl(posting.url);
  if (!urlKey) return null;
  const raw = db
    .query(
      `INSERT INTO queue (url, url_key, company, role, login_gated, not_fillable, low_confidence, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')
       ON CONFLICT(url_key) DO NOTHING
       RETURNING *`,
    )
    .get(
      String(posting.url ?? '').slice(0, MAX_TEXT),
      urlKey,
      String(posting.company ?? '').slice(0, MAX_TEXT),
      String(posting.title ?? '').slice(0, MAX_TEXT),
      posting.login_gated ? 1 : 0,
      posting.not_fillable ? 1 : 0,
      posting.low_confidence ? 1 : 0,
    ) as QueueRow | undefined;
  return raw ?? null;
}

export function updateQueueStatus(db: Database, id: number, patch: QueueUpdatePatch): QueueRow | null {
  if (patch.status !== undefined && !QUEUE_STATUSES.has(patch.status)) {
    throw new InvalidQueueStatusError(patch.status);
  }
  // WR-05: skip the whole write (return the current row) when an automated run-state
  // patch would move a row backwards out of a human-set reviewed/submitted status.
  if (patch.status !== undefined && RUN_STATUSES.has(patch.status)) {
    const current = db.query('SELECT * FROM queue WHERE id = ?').get(id) as QueueRow | null;
    if (current && HUMAN_STATUSES.has(current.status)) return current;
  }
  const fields: string[] = [];
  const vals: unknown[] = [];
  if (patch.status !== undefined) {
    fields.push('status = ?');
    vals.push(patch.status);
  }
  if (patch.company !== undefined) {
    fields.push('company = ?');
    vals.push(String(patch.company).slice(0, MAX_TEXT));
  }
  if (patch.role !== undefined) {
    fields.push('role = ?');
    vals.push(String(patch.role).slice(0, MAX_TEXT));
  }
  if (patch.application_id !== undefined) {
    fields.push('application_id = ?');
    vals.push(patch.application_id);
  }
  if (patch.results_summary !== undefined) {
    fields.push('results_summary = ?');
    vals.push(truncateResultsSummary(String(patch.results_summary)));
  }
  if (patch.error !== undefined) {
    fields.push('error = ?');
    vals.push(String(patch.error).slice(0, MAX_TEXT));
  }
  if (patch.resume_name !== undefined) {
    fields.push('resume_name = ?');
    vals.push(String(patch.resume_name).slice(0, MAX_TEXT));
  }
  if (fields.length) {
    db.query(`UPDATE queue SET ${fields.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...vals, id);
  }
  return db.query('SELECT * FROM queue WHERE id = ?').get(id) as QueueRow | null;
}

// Hard removal for rows the operator decides not to pursue (wrong YoE, dead posting).
// Refuses while a fill is in flight — the runner is actively writing to the row
// and a mid-fill delete would strand its PATCHes. Postings-table decisions are
// untouched, so a removed swept posting is not re-promoted (decided stays decided).
// Removing a row from the queue is a DECISION, and it has to outlive the row.
//
// This used to be a bare DELETE. The posting it came from kept
// decision = 'queued' with nothing anywhere recording that the operator had removed it —
// 37 postings are in exactly that state. Nothing re-promoted them only because
// the decide loop skips anything already decided; the moment the same job
// arrives under a different dedup key it comes back, and the live db already
// holds 399 posting pairs that are one job under two keys. So the removal is
// written down as a user rejection, which the decide loop will not revisit and
// which the documented safe-re-decide rule already excludes from any future
// re-open sweep (only `rules:*` rejections may ever be reconsidered).
export function deleteQueueEntry(db: Database, id: number): { deleted: boolean; reason?: string } {
  const row = db.query('SELECT id, status, url, url_key FROM queue WHERE id = ?').get(id) as
    | { id: number; status: string; url: string; url_key: string | null }
    | null;
  if (!row) return { deleted: false, reason: 'not found' };
  if (row.status === 'filling') return { deleted: false, reason: 'fill in progress' };
  db.query('DELETE FROM queue WHERE id = ?').run(id);
  // url_key can be NULL on a legacy row or a D-11 collision-duplicate, so derive
  // it when absent rather than skipping the tombstone.
  const key = row.url_key || normalizeUrl(String(row.url ?? ''));
  if (key) {
    // Best-effort, and deliberately AFTER the delete: the row is already gone,
    // so a throw here would fail the request for work that actually succeeded.
    // Mirrors captureFailure's "never let a bookkeeping bug regress the real
    // operation" posture. Logged rather than swallowed silently — a tombstone
    // that stops being written is how the reappearing-jobs bug comes back.
    try {
      // Only over an undecided/queued/held posting — an existing rejection keeps
      // its original reason, and nothing here can revive a decided row.
      db.query(
        `UPDATE postings
            SET decision = 'rejected',
                decision_reason = 'user:removed-from-queue',
                decided_at = datetime('now')
          WHERE url_key = ?
            AND (decision IS NULL OR decision IN ('queued', 'held'))`,
      ).run(key);
    } catch (e) {
      console.error('[queue] removal tombstone failed for', key, e);
    }
  }
  return { deleted: true };
}

export function listQueue(db: Database): QueueRow[] {
  return db.query('SELECT * FROM queue ORDER BY created_at DESC, id DESC').all() as QueueRow[];
}
