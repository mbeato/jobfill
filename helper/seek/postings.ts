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
  decision: string | null;
  decision_reason: string | null;
  decided_at: string | null;
  fetched_at: string;
  created_at: string;
}

const MAX_TEXT = 2000;
// Maintained SEPARATELY from types.ts's SourceName union — both lists MUST be
// edited together. A source missing here is silently dropped by the
// `!VALID_SOURCES.has(p.source)` guard below and yields zero rows, no error.
const VALID_SOURCES = new Set(['greenhouse', 'lever', 'ashby', 'hn', 'yc', 'jobright', 'simplify', 'getro', 'ycdir']);

// D-13 decision audit trail: a posting's final verdict. null = unscored.
export const DECISION_VALUES = new Set(['queued', 'rejected', 'held']);

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
    decision TEXT,
    decision_reason TEXT,
    decided_at TEXT,
    jd TEXT DEFAULT '',
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
    decision: (raw.decision as string | null) ?? null,
    decision_reason: (raw.decision_reason as string | null) ?? null,
    decided_at: (raw.decided_at as string | null) ?? null,
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
       -- D-14: decision/decision_reason/decided_at are deliberately absent from
       -- this SET list — a re-discovery upsert refreshes staging metadata but
       -- must never clobber a prior verdict.
       -- D-10: source/posted_at/posted_at_trusted keep the existing row instead
       -- of last-writer-wins whenever EITHER (a) the existing row is a
       -- trusted-date source and the incoming one is not — a trusted Ashby/Lever
       -- publishedAt must never be clobbered by an untrusted aggregator's index
       -- time — OR (b) the incoming row is an aggregator (simplify/getro/
       -- jobright) re-discovering a posting already attributed to a directly-
       -- polled board — a direct Greenhouse/Lever/Ashby poll keeps its own
       -- attribution rather than being relabeled as aggregator-sourced. One
       -- identical predicate drives all FOUR columns so provenance never
       -- splits across them.
       --
       -- company is in that set because it is NOT a display field for ATS
       -- sources: normalizeGreenhouseJob/normalizeAshbyJob store the board
       -- TOKEN there, and fetchGreenhouseJD/fetchAshbyJD interpolate it
       -- straight into the JD API path. Letting an aggregator refresh it to a
       -- human-readable name ("Buyers Edge Platform") produces
       -- boards-api.greenhouse.io/v1/boards/Buyers%20Edge%20Platform/jobs/N,
       -- a permanent 404 that strands the posting in held:jd-fetch-error.
       -- That was live: 262 of 13,921 greenhouse rows had clobbered company
       -- values before this fix. company must travel with source.
       --
       -- title/location deliberately still refresh — they are display and
       -- filter inputs only, never interpolated into an outbound URL.
       ON CONFLICT(url_key) DO UPDATE SET
         fetched_at = datetime('now'),
         company = CASE WHEN (postings.posted_at_trusted = 1 AND excluded.posted_at_trusted = 0)
                           OR (excluded.source IN ('simplify','getro','jobright') AND postings.source NOT IN ('simplify','getro','jobright'))
                         THEN postings.company ELSE excluded.company END,
         title = excluded.title,
         location = excluded.location,
         source = CASE WHEN (postings.posted_at_trusted = 1 AND excluded.posted_at_trusted = 0)
                          OR (excluded.source IN ('simplify','getro','jobright') AND postings.source NOT IN ('simplify','getro','jobright'))
                        THEN postings.source ELSE excluded.source END,
         posted_at = CASE WHEN (postings.posted_at_trusted = 1 AND excluded.posted_at_trusted = 0)
                             OR (excluded.source IN ('simplify','getro','jobright') AND postings.source NOT IN ('simplify','getro','jobright'))
                           THEN postings.posted_at ELSE excluded.posted_at END,
         posted_at_trusted = CASE WHEN (postings.posted_at_trusted = 1 AND excluded.posted_at_trusted = 0)
                                     OR (excluded.source IN ('simplify','getro','jobright') AND postings.source NOT IN ('simplify','getro','jobright'))
                                   THEN postings.posted_at_trusted ELSE excluded.posted_at_trusted END,
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

// D-13: records a posting's final verdict. Never touched by upsertPosting's
// ON CONFLICT (see D-14 comment above) — this is the only write path.
export function recordDecision(db: Database, id: number, decision: string, reason: string): PostingRow | null {
  if (!DECISION_VALUES.has(decision)) {
    throw new Error(`invalid posting decision: ${decision}`);
  }
  db.query(`UPDATE postings SET decision = ?, decision_reason = ?, decided_at = datetime('now') WHERE id = ?`).run(
    decision,
    String(reason ?? '').slice(0, MAX_TEXT),
    id,
  );
  const raw = db.query('SELECT * FROM postings WHERE id = ?').get(id) as Record<string, unknown> | null;
  return raw ? toRow(raw) : null;
}

// Persists the JD the relevance scorer already fetched, so the tailor does not
// have to re-derive one by scraping the apply page at fill time. Written ONLY
// for postings that reach the queue (see decide.ts) — a rejected posting is
// never tailored, so storing its JD would add the whole scored pool's worth of
// ~10k-char blobs to the db every sweep for nothing. Bounded by the same
// MAX_JD_LENGTH fetchJD already applies; MAX_TEXT would truncate a real JD.
export function storePostingJD(db: Database, id: number, jd: string): void {
  db.query(`UPDATE postings SET jd = ? WHERE id = ?`).run(String(jd ?? ''), id);
}

// The read side of storePostingJD: the JD for the posting a queue row was
// promoted from, or '' when there is none.
//
// Joined on url_key, and reached via the queue id rather than the fill url,
// because those are the only two things that actually line up. queue.url_key is
// set from normalizeUrl(posting.url) at promotion (promote.ts), so it equals
// postings.url_key by construction. The url the extension fills is the APPLY
// route — …/{id}/application, …/embed/job_app?for=…&token=… — and normalizeUrl
// keeps the path while dropping the query, so normalizing IT lands on neither
// the posting key (extra /application segment) nor anything unique at all
// (every greenhouse embed collapses to job-boards.greenhouse.io/embed/job_app).
export function resolveStoredJD(db: Database, queueId: number): string {
  const row = db
    .query(
      `SELECT p.jd AS jd FROM queue q JOIN postings p ON p.url_key = q.url_key
       WHERE q.id = ? AND q.url_key IS NOT NULL`,
    )
    .get(queueId) as { jd: string | null } | null;
  return row?.jd ?? '';
}

// D-08/D-12: the sweep's scoring backlog — unscored (null) or held-for-retry
// postings, source-interleaved per D-01/D-02 rather than drained in one flat
// pass — a ROW_NUMBER() ranks each source's queue independently so a source that
// arrives late in a sweep reaches the front within one sweep instead of
// sitting behind the whole greenhouse backlog. `fetched_at ASC, id ASC` is
// kept as the within-rank tiebreak, so a source's own rows are still
// oldest-first. `limit` is applied to the OUTER query, after the interleave
// — applying it before would silently defeat fairness by truncating to
// whichever source's rows happen to sort first. D-03: a posting that never
// wins a slot ages out unscored at MAX_FIRST_SEEN_DAYS — 17-D-04 already
// ruled that is intended backlog GC, not a defect.
export function listPostingsToDecide(db: Database, limit?: number): PostingRow[] {
  const sql =
    `SELECT id, url, url_key, company, title, location, source, posted_at, posted_at_trusted, login_gated, not_fillable, low_confidence, decision, decision_reason, decided_at, fetched_at, created_at FROM (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY source ORDER BY fetched_at ASC, id ASC) AS rn
       FROM postings WHERE decision IS NULL OR decision = 'held'
     ) ORDER BY rn ASC, fetched_at ASC, id ASC` +
    (limit !== undefined ? ' LIMIT ?' : '');
  const rows = (limit !== undefined ? db.query(sql).all(limit) : db.query(sql).all()) as Record<string, unknown>[];
  return rows.map(toRow);
}
