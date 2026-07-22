import type { Database } from 'bun:sqlite';
import { normalizeUrl } from './normalize';
import type { PostingRow } from './postings';
import { insertQueueEntryFromPosting, type QueueRow } from '../queue';

// D-09/D-10/D-11: the single promotion write boundary. Dedupe happens here in
// two directions — schema-level against `queue` (delegated to
// insertQueueEntryFromPosting's ON CONFLICT(url_key)) and a linear scan against
// the `applications` tracker (mirrors helper/server.ts's resolveApplicationId
// pattern) — before this module owns ORCHESTRATION only; queue.ts owns the
// write and the login_gated/not_fillable/text-bounding carry-through.

export interface PromoteResult {
  promoted: boolean;
  queueRow?: QueueRow;
  reason?: string;
}

export function promotePosting(db: Database, posting: PostingRow): PromoteResult {
  // Scheme allowlist re-asserted at this boundary (defense in depth).
  if (!/^https?:\/\//i.test(String(posting.url ?? ''))) {
    return { promoted: false, reason: 'dedupe:invalid-url' };
  }
  const key = normalizeUrl(posting.url);
  if (!key) {
    return { promoted: false, reason: 'dedupe:invalid-url' };
  }
  // Tracker dedupe: linear scan + normalizeUrl equality, mirroring
  // resolveApplicationId (helper/server.ts) rather than a SQL join.
  const appRows = db.query('SELECT id, url FROM applications').all() as { id: number; url: string }[];
  if (appRows.some(row => normalizeUrl(row.url) === key)) {
    return { promoted: false, reason: 'dedupe:tracker' };
  }
  // Schema-level queue dedupe + flag carry-through: this is a fresh INSERT only
  // (never an UPDATE), so a human-set queue status can never be regressed (WR-05
  // satisfied by construction).
  const queueRow = insertQueueEntryFromPosting(db, posting);
  if (!queueRow) {
    return { promoted: false, reason: 'dedupe:queue' };
  }
  return { promoted: true, queueRow };
}
