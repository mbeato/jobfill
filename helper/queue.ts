import type { Database } from 'bun:sqlite';

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
}

// WR-04-style bound: defend the persistence boundary regardless of caller.
const MAX_TEXT = 2000;

// results_summary is a JSON blob (per-field results array), not display text — the
// MAX_TEXT bound would slice it mid-stream and corrupt it for any realistic form.
// Larger dedicated bound, and truncation is structural (see truncateResultsSummary)
// so the stored value is ALWAYS valid JSON.
const MAX_SUMMARY = 20_000;

// Never slice a JSON string lexically: over the bound, re-serialize a reduced
// per-field summary (id/label/status only); if even that is too big or the input
// isn't valid JSON, store a marker object the dashboard can render safely.
function truncateResultsSummary(raw: string): string {
  if (raw.length <= MAX_SUMMARY) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const reduced = JSON.stringify(
        parsed.slice(0, 200).map((r: { id?: unknown; label?: unknown; status?: unknown }) => ({
          id: r?.id,
          label: r?.label,
          status: r?.status,
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
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
}

export function insertQueueEntry(db: Database, url: string): QueueRow {
  return db
    .query(`INSERT INTO queue (url) VALUES (?) RETURNING *`)
    .get(String(url ?? '').slice(0, MAX_TEXT)) as QueueRow;
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
  if (fields.length) {
    db.query(`UPDATE queue SET ${fields.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...vals, id);
  }
  return db.query('SELECT * FROM queue WHERE id = ?').get(id) as QueueRow | null;
}

export function listQueue(db: Database): QueueRow[] {
  return db.query('SELECT * FROM queue ORDER BY created_at DESC, id DESC').all() as QueueRow[];
}
