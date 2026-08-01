import type { Database } from 'bun:sqlite';
import { normalizeUrl } from './seek/normalize';

// The queue<->application link, isolated so it can be tested.
//
// queue.ts and applications.ts each deliberately refuse to touch the other's
// table (see insertApplication's docstring), which left the link itself owned by inline
// code in server.ts and therefore unreachable from any test: server.ts binds a
// port at import time, so nothing can import it. The link then broke silently.
//
// The failure it broke in: a fill POSTs the application and the queue row within
// the same second, application first. POST /applications resolves a queue id and
// finds none (the row does not exist yet), so it writes no link; POST /queue then
// inserts with application_id NULL. Nothing reconnects them except the D-18 boot
// backfill, so a long-running helper accumulates unlinked rows — and the submit
// cascade, which is gated on application_id, silently promotes nothing. The
// operator marks a posting submitted and the applications tab still reads
// "awaiting submit".
//
// This module holds only the resolution half (a read). The write stays in
// server.ts, which owns cross-table writes.

/**
 * Newest application whose normalized url matches `urlKey`, or null.
 *
 * Normalizes on read because `applications` has no url_key column — matching on
 * raw url would miss the trailing-slash and host-case variants that the queue's
 * key already folds away. Newest-wins mirrors the D-18 backfill and D-03
 * latest-fill-wins.
 */
export function findApplicationIdForUrlKey(db: Database, urlKey: string | null): number | null {
  if (!urlKey) return null;
  const apps = db.query('SELECT id, url FROM applications ORDER BY created_at DESC, id DESC').all() as {
    id: number;
    url: string;
  }[];
  return apps.find(a => normalizeUrl(a.url) === urlKey)?.id ?? null;
}
