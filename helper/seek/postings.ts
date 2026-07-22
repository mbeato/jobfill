import type { Database } from 'bun:sqlite';
import { normalizeUrl } from './normalize';
import type { NormalizedPosting } from './types';

// The `postings` staging table (D-05/D-06/D-07): every discovered posting is
// recorded here before Phase 10 scores it and promotes survivors into `queue`.
// Never conflated with `queue` or `applications`. Mirrors helper/failures.ts's
// dependency-injected, self-defending style: bound untrusted text at the write
// boundary, dedup via UNIQUE(url_key).

export interface PostingRow {
  id: number;
  url: string;
  url_key: string;
  company: string;
  title: string;
  location: string;
  source: string;
  posted_at: string | null;
  posted_at_trusted: boolean;
  login_gated: boolean;
  not_fillable: boolean;
  low_confidence: boolean;
  fetched_at: string;
  created_at: string;
}

const MAX_TEXT = 2000;
const VALID_SOURCES = new Set(['greenhouse', 'lever', 'ashby', 'hn', 'yc', 'jobright']);

export function createPostingsTable(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS postings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    url_key TEXT NOT NULL UNIQUE,
    company TEXT DEFAULT '',
    title TEXT DEFAULT '',
    location TEXT DEFAULT '',
    source TEXT NOT NULL,
    posted_at TEXT,
    posted_at_trusted INTEGER DEFAULT 0,
    login_gated INTEGER DEFAULT 0,
    not_fillable INTEGER DEFAULT 0,
    low_confidence INTEGER DEFAULT 0,
    fetched_at TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now'))
  )`);
}

function toRow(raw: Record<string, unknown>): PostingRow {
  return {
    id: raw.id as number,
    url: raw.url as string,
    url_key: raw.url_key as string,
    company: raw.company as string,
    title: raw.title as string,
    location: raw.location as string,
    source: raw.source as string,
    posted_at: (raw.posted_at as string | null) ?? null,
    posted_at_trusted: raw.posted_at_trusted === 1,
    login_gated: raw.login_gated === 1,
    not_fillable: raw.not_fillable === 1,
    low_confidence: raw.low_confidence === 1,
    fetched_at: raw.fetched_at as string,
    created_at: raw.created_at as string,
  };
}

export function upsertPosting(db: Database, p: NormalizedPosting): PostingRow | null {
  if (!VALID_SOURCES.has(p.source)) return null;
  // Persistence-boundary scheme allowlist (mirrors POST /queue): postings are
  // rendered as anchors and promoted into `queue` by Phase 10 — never store a
  // non-http(s) URL (sidecar hrefs come from untrusted third-party DOM).
  if (!/^https?:\/\//i.test(String(p.url ?? ''))) return null;
  const urlKey = normalizeUrl(p.url);
  // An empty key would make every URL-less posting collide on UNIQUE(url_key)
  // and clobber each other into one chimera row — skip them instead.
  if (!urlKey) return null;
  const raw = db
    .query(
      `INSERT INTO postings (url, url_key, company, title, location, source, posted_at, posted_at_trusted, login_gated, not_fillable, low_confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       -- login_gated only ever ratchets up on conflict: once a URL is known to
       -- be login-walled, no later sweep stage (e.g. HN re-discovering the same
       -- link) may downgrade it back into the fillable pool.
       ON CONFLICT(url_key) DO UPDATE SET
         fetched_at = datetime('now'),
         company = excluded.company,
         title = excluded.title,
         location = excluded.location,
         source = excluded.source,
         posted_at = excluded.posted_at,
         posted_at_trusted = excluded.posted_at_trusted,
         login_gated = MAX(postings.login_gated, excluded.login_gated),
         not_fillable = excluded.not_fillable,
         low_confidence = excluded.low_confidence
       RETURNING *`,
    )
    .get(
      String(p.url ?? '').slice(0, MAX_TEXT),
      urlKey,
      String(p.company ?? '').slice(0, MAX_TEXT),
      String(p.title ?? '').slice(0, MAX_TEXT),
      String(p.location ?? '').slice(0, MAX_TEXT),
      p.source,
      p.posted_at == null ? null : String(p.posted_at).slice(0, 64),
      p.posted_at_trusted ? 1 : 0,
      p.login_gated ? 1 : 0,
      p.not_fillable ? 1 : 0,
      p.low_confidence ? 1 : 0,
    ) as Record<string, unknown>;
  return toRow(raw);
}

export function listPostings(db: Database): PostingRow[] {
  const rows = db.query('SELECT * FROM postings ORDER BY fetched_at DESC, id DESC').all() as Record<string, unknown>[];
  return rows.map(toRow);
}
