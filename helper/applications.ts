import type { Database } from 'bun:sqlite';

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
}

export interface ApplicationUpdatePatch {
  status?: string;
  notes?: string;
}

// WR-04-style bound: defend the persistence boundary regardless of caller.
const MAX_TEXT = 2000;

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
export const GHOST_DAYS = 21;

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
    status_changed_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
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
  return db
    .query(
      `INSERT INTO applications (company, role, url, status, resume_path, cost_usd, summary, tailor_state, tailor_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
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
  return db.query('SELECT * FROM applications WHERE id = ?').get(id) as ApplicationRow | null;
}

// D-13/D-14/D-16/D-17: the ghost rule, pure and db-free so `bun test` covers it and
// every /applications consumer gets the identical derivation. ghosted applies to
// 'applied' rows ONLY — a non-'applied' or pre-submit row never ghosts, regardless
// of how long it has sat. Nothing is stored; the badge is entirely derived.
export function deriveGhost(
  row: { status: string; status_changed_at: string | null },
  now: Date = new Date(),
): { ghosted: boolean; days_silent: number } {
  const daysSilent = daysSince(row.status_changed_at, now);
  return { ghosted: row.status === 'applied' && daysSilent >= GHOST_DAYS, days_silent: daysSilent };
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
