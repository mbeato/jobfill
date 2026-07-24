import type { Database } from 'bun:sqlite';

// Machine-discovered ATS-slug cache (D-01/D-02) that feeds greenhouse/lever/ashby's
// token lists — a sibling of `postings` (job listings) and `queue` (fill lifecycle),
// never conflated with either. D-04: every slug is inserted optimistically with no
// pre-probe; the next sweep is its verification, and repeated failures mark it dead.

export interface BoardRow {
  id: number;
  ats: string;
  token: string;
  source_of_discovery: string;
  first_seen_at: string;
  last_ok_at: string | null;
  dead_since: string | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
}

export const BOARDS_ATS = new Set(['greenhouse', 'lever', 'ashby']);
// 'consider' stays allowlisted even though no Consider.co adapter ships (D-13) so a
// future adapter needs no schema change; 'seed' is reserved for rows promoted from
// seek.config.json.
export const BOARDS_SOURCES = new Set(['simplify', 'getro', 'consider', 'ycdir', 'seed']);

// Outbound-request guard (T-16-03): a harvested token is later interpolated into
// boards-api.greenhouse.io/v1/boards/<token>/jobs, so a slash, `..`, `?`, `@` or
// percent-escape in a harvested slug must never reach a fetch URL.
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function createBoardsTable(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS boards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ats TEXT NOT NULL,
    token TEXT NOT NULL,
    source_of_discovery TEXT NOT NULL,
    first_seen_at TEXT DEFAULT (datetime('now')),
    last_ok_at TEXT,
    dead_since TEXT,
    consecutive_failures INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(ats, token)
  )`);
}

function toRow(raw: Record<string, unknown>): BoardRow {
  return {
    id: raw.id as number,
    ats: raw.ats as string,
    token: raw.token as string,
    source_of_discovery: raw.source_of_discovery as string,
    first_seen_at: raw.first_seen_at as string,
    last_ok_at: (raw.last_ok_at as string | null) ?? null,
    dead_since: (raw.dead_since as string | null) ?? null,
    consecutive_failures: Number(raw.consecutive_failures ?? 0),
    created_at: raw.created_at as string,
    updated_at: raw.updated_at as string,
  };
}

// T-16-04: ats/source_of_discovery are allowlist-checked before any write, mirroring
// VALID_SOURCES/DECISION_VALUES — out-of-enum input returns null and writes nothing,
// matching upsertPosting's silent-skip posture (callers feed this bulk third-party data).
export function upsertBoard(
  db: Database,
  input: { ats: string; token: string; source_of_discovery: string },
  blocklist: string[] = [],
): BoardRow | null {
  if (!BOARDS_ATS.has(input.ats)) return null;
  if (!BOARDS_SOURCES.has(input.source_of_discovery)) return null;
  const token = String(input.token ?? '').trim();
  if (!TOKEN_RE.test(token)) return null;
  // D-06: blocklist enforced at insert time (case-insensitive) so a slug the operator never
  // wants polled can never enter `boards` in the first place.
  const lowerToken = token.toLowerCase();
  if (blocklist.some(b => String(b ?? '').trim().toLowerCase() === lowerToken)) return null;
  const raw = db
    .query(
      `INSERT INTO boards (ats, token, source_of_discovery)
       VALUES (?, ?, ?)
       -- D-02: first_seen_at and source_of_discovery are write-once provenance —
       -- Phase 17's grace window reads first_seen_at, and re-discovery must not
       -- reset it or re-attribute who found it first.
       ON CONFLICT(ats, token) DO UPDATE SET updated_at = datetime('now')
       RETURNING *`,
    )
    .get(input.ats, token, input.source_of_discovery) as Record<string, unknown>;
  return toRow(raw);
}
