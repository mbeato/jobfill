// The detached, unattended batch-fill loop the helper spawns (D-06).
// Reads the batch_runs id from argv, opens ONE headed browser, selects
// eligible queued postings (helper/seek/batch-eligibility.ts), drives each
// through fillOne (scripts/lib/runner-core.mjs) leaving filled tabs open,
// and reports the outcome back to the helper over HTTP. This IS the runner
// protocol (docs/runner-protocol.md) in a loop — no invariant relaxed:
// never submits, never types into ATS fields, one fill in flight per
// posting, no auto-retry.
//
// Usage: bun scripts/batch-runner.mjs <runId>
// (Runs under Bun — the helper spawns it via process.execPath = bun — so
// importing helper/seek/*.ts directly is fine.)
// The browser idles forever after the run so the operator can review filled tabs.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupRunner, fillOne } from './lib/runner-core.mjs';
import { loadSeekConfig } from '../helper/seek/config';
import { selectEligible, classifyReviewFlags } from '../helper/seek/batch-eligibility';

// fillOne state -> detail.failed[].reason mapping (the two enums differ ONLY
// in the 'failed'->'fill-failed' rename; a caught thrown fillOne is given
// synthetic state 'failed' below, so it maps through here too).
const REASON_MAP = {
  failed: 'fill-failed',
  'no-form': 'no-form',
  timeout: 'timeout',
  'trigger-error': 'trigger-error',
  duplicate: 'duplicate',
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = join(ROOT, 'extension');
const PROFILE_DIR = join(ROOT, '.runner-profile');
const HELPER = 'http://127.0.0.1:7877';
const TOKEN = process.env.JOBFILL_TOKEN ?? 'REDACTED-TOKEN';
const POLL_MS = 25_000;
const BUDGET_MS = 600_000;
const RESUME_PATH = '/Users/you/resume/resume.pdf';

const runId = Number(process.argv[2]);
if (!runId) {
  console.error('usage: bun scripts/batch-runner.mjs <runId>');
  process.exit(1);
}

// Fail-open (docs/runner-protocol.md's cardinal invariant, applied to the
// run-record channel too): a helper hiccup must never crash the process
// that owns the browser.
async function patchRun(body) {
  try {
    await fetch(`${HELPER}/batch-runs/${runId}`, {
      method: 'PATCH',
      headers: { 'x-jobfill-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.log(`[batch-runner] patchRun failed (helper hiccup?): ${e.message}`);
  }
}

async function patchQueue(queueId, body) {
  try {
    await fetch(`${HELPER}/queue/${queueId}`, {
      method: 'PATCH',
      headers: { 'x-jobfill-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.log(`[batch-runner] queue ${queueId} patch failed (helper hiccup?): ${e.message}`);
  }
}

async function getQueue() {
  const res = await fetch(`${HELPER}/queue`, { headers: { 'x-jobfill-token': TOKEN } });
  return res.json();
}

const config = await loadSeekConfig();
const queueRows = await getQueue();
const { toFill, skipped, capReached } = selectEligible(queueRows, config.batch);
console.log(
  `[batch-runner] run ${runId}: ${toFill.length} eligible to fill, ${skipped.length} skipped, capReached=${capReached}`,
);

let ctx, extId, dashPage;
try {
  ({ ctx, extId, dashPage } = await setupRunner({
    profileDir: PROFILE_DIR,
    extDir: EXT_DIR,
    root: ROOT,
    resumePath: RESUME_PATH,
    explicitResume: false,
  }));
} catch (e) {
  if (e.code === 'PROFILE_LOCKED') {
    // D-02: a live runner already owns .runner-profile — clean 'browser
    // busy' outcome, not a crash. No browser was opened, so no idle either.
    console.error(`[batch-runner] browser busy — .runner-profile is already locked: ${e.message}`);
    await patchRun({
      status: 'failed',
      detail: {
        headline: { filled: 0, skipped: 0, failed: 0 },
        stop_reason: 'browser busy',
        skipped: [],
        failed: [],
        filled: [],
      },
    });
    process.exit(0);
  }
  throw e;
}

let filled = 0;
let failed = 0;
let consecutiveFailures = 0;
let stopReason = 'queue empty';
const filledDetail = [];
const failedDetail = [];

// A browser is alive from here on (or will be, once the loop opens tabs) —
// nothing below may throw uncaught, or the operator loses both the browser and the
// filled-tab review queue it was holding open. This guard records a failed
// run and still idles rather than letting the process die.
try {
  for (const item of toFill) {
    // Refreshed at least every posting; fillOne itself is bounded by
    // BUDGET_MS but the ~25s poll keeps gaps well inside the 3min stale
    // window reconcileInterruptedBatchRuns checks (helper/seek/batch.ts).
    await patchRun({ heartbeat: true });

    let outcome;
    try {
      // BATCH-02: one bad posting never stops the run — a thrown fillOne is
      // caught, counted as a failure, and the loop continues.
      outcome = await fillOne(ctx, extId, dashPage, { id: item.queueId, url: item.url }, { pollMs: POLL_MS, budgetMs: BUDGET_MS });
    } catch (e) {
      console.log(`[batch-runner] ${item.company} / ${item.role}: fillOne threw (${e.message}) — isolated, continuing`);
      outcome = { state: 'failed', tab: null };
    }

    if (outcome.state === 'filled') {
      filled++;
      consecutiveFailures = 0;
      // D-03: zero flagged fields -> advance to 'reviewed'; any flag -> leave
      // 'filled' for the operator's own review pass. NEVER 'submitted'.
      const { flagged } = classifyReviewFlags(outcome.row?.results_summary ?? '');
      if (!flagged) {
        await patchQueue(item.queueId, { status: 'reviewed' });
        console.log(`[batch-runner] ${item.company} / ${item.role}: filled, clean — marked reviewed`);
        filledDetail.push({ queueId: item.queueId, company: item.company, role: item.role, reviewed: true });
      } else {
        console.log(`[batch-runner] ${item.company} / ${item.role}: filled, flagged — left for review`);
        filledDetail.push({ queueId: item.queueId, company: item.company, role: item.role, reviewed: false });
      }
    } else {
      // D-11: no-form / failed / timeout / trigger-error / duplicate all
      // close the posting tab and move on. 'filled' is the only outcome
      // that leaves its tab open for review.
      failed++;
      consecutiveFailures++;
      if (outcome.tab) await outcome.tab.close().catch(() => {});
      const reason = REASON_MAP[outcome.state] ?? 'fill-failed';
      console.log(`[batch-runner] ${item.company} / ${item.role}: ${reason}`);
      failedDetail.push({ queueId: item.queueId, company: item.company, role: item.role, reason });

      // D-12: 3 consecutive failures signals a systemic outage (e.g. helper
      // down, extension broken) rather than bad-luck individual postings —
      // abort the run instead of burning through the rest of the queue.
      // Skips never reach this counter (selectEligible pre-filters them
      // before the loop), so only real fill attempts can trip it.
      if (consecutiveFailures >= 3) {
        stopReason = 'circuit breaker';
        console.log('[batch-runner] 3 consecutive failures — circuit breaker tripped, stopping');
        break;
      }
    }
  }

  if (stopReason !== 'circuit breaker') {
    // toFill was already sliced to headroom by selectEligible, so the
    // natural end-of-loop stop is either every eligible posting got filled
    // (capReached false) or eligible postings remained beyond headroom
    // (capReached true).
    stopReason = capReached ? 'cap' : 'queue empty';
  }
} catch (e) {
  console.error(`[batch-runner] unexpected error mid-run: ${e.message} — recording run, browser stays open`);
  stopReason = 'interrupted';
}

const detail = {
  headline: { filled, skipped: skipped.length, failed },
  stop_reason: stopReason,
  skipped,
  failed: failedDetail,
  filled: filledDetail,
};
// status is 'ok' even for a circuit-breaker/interrupted abort — the browser
// did start and holds filled tabs; only a browser-busy start (above) is
// recorded 'failed'.
await patchRun({ status: 'ok', detail });
console.log(`[batch-runner] done: ${JSON.stringify(detail.headline)} stop_reason=${stopReason}`);

// exiting would kill the browser and every filled tab (D-06) — idle instead
setInterval(() => {}, 1 << 30);
