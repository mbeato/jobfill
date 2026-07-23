import type { QueueRow } from '../queue';
import type { BatchConfig } from './types';

// Pure batch decision layer (D-09/D-10/D-13/D-15/D-03): what to fill, what to
// skip, and when a fill is clean enough to auto-review — all before any
// browser opens. No I/O, mirrors filter.ts's no-throw, no-network classify*
// style so this module stays trivially unit-testable.

// Review-worthy status enum, copied verbatim from dashboard.html:420 /
// docs/runner-protocol.md's "Reviewing and recording the outcome" section.
const REVIEW_WORTHY = new Set(['verify', 'needs_manual', 'error', 'partial', 'not_found', 'stale', 'frame_error']);

export interface EligibilityItem {
  queueId: number;
  company: string;
  role: string;
  url: string;
}

export interface SkippedItem extends EligibilityItem {
  reason: 'login-gated' | 'not-fillable' | 'unsupported-host';
}

export interface SelectEligibleResult {
  toFill: EligibilityItem[];
  skipped: SkippedItem[];
  capReached: boolean;
  backlog: number;
  headroom: number;
}

// hostname equals an allowlist entry, or ends with '.' + entry (registrable-
// suffix match) — accepts boards.greenhouse.io, rejects evilgreenhouse.io and
// greenhouse.io.attacker.com (T-12-03-01). Never throws on a malformed URL.
export function hostAllowed(url: string, allowlist: string[]): boolean {
  try {
    const { hostname } = new URL(url);
    return allowlist.some(entry => hostname === entry || hostname.endsWith('.' + entry));
  } catch {
    return false;
  }
}

// D-10 eligibility (login-gated/not-fillable/host allowlist), D-15 newest-
// first (relies on the caller passing queueRows in listQueue's newest-first
// order — preserved, never re-sorted here), D-13 cap against the existing
// filled+reviewed backlog computed from the SAME row set.
export function selectEligible(queueRows: QueueRow[], batchConfig: BatchConfig): SelectEligibleResult {
  const backlog = queueRows.filter(r => r.status === 'filled' || r.status === 'reviewed').length;
  const headroom = Math.max(0, batchConfig.cap - backlog);

  const skipped: SkippedItem[] = [];
  const eligible: EligibilityItem[] = [];

  for (const row of queueRows) {
    if (row.status !== 'queued') continue;
    const item: EligibilityItem = { queueId: row.id, company: row.company, role: row.role, url: row.url };
    if (row.login_gated) {
      skipped.push({ ...item, reason: 'login-gated' });
    } else if (row.not_fillable) {
      skipped.push({ ...item, reason: 'not-fillable' });
    } else if (!hostAllowed(row.url, batchConfig.hostAllowlist)) {
      skipped.push({ ...item, reason: 'unsupported-host' });
    } else {
      eligible.push(item);
    }
  }

  const toFill = eligible.slice(0, headroom);
  const capReached = eligible.length > headroom;

  return { toFill, skipped, capReached, backlog, headroom };
}

// D-03: fail-safe review classification — an unparseable/non-array results
// summary is never auto-reviewed. flagged true if any field's status is
// review-worthy OR its stuck flag is explicitly false (a didn't-stick field
// whose status is still 'filled').
export function classifyReviewFlags(resultsSummary: string): { flagged: boolean; flaggedCount: number } {
  try {
    const parsed = JSON.parse(resultsSummary);
    if (!Array.isArray(parsed)) return { flagged: true, flaggedCount: 0 };
    let flaggedCount = 0;
    for (const field of parsed as { status?: unknown; stuck?: unknown }[]) {
      if (REVIEW_WORTHY.has(String(field?.status)) || field?.stuck === false) flaggedCount++;
    }
    return { flagged: flaggedCount > 0, flaggedCount };
  } catch {
    return { flagged: true, flaggedCount: 0 };
  }
}
