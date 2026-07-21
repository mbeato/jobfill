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

// Status lifecycle: queued -> filling -> filled/failed -> reviewed -> submitted.
// 'submitted' is a legal allowlist value here — the D-02 boundary (only a human
// dashboard click may set it) is enforced by the caller, not this module.
export const QUEUE_STATUSES = new Set(['queued', 'filling', 'filled', 'failed', 'reviewed', 'submitted']);

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
    vals.push(String(patch.results_summary).slice(0, MAX_TEXT));
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
