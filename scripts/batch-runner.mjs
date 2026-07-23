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
import { selectEligible } from '../helper/seek/batch-eligibility';

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

// Stubbed counters/stopReason threaded through for Task 2 to fill in with
// cap enforcement, the circuit breaker, and auto-review classification.
let filled = 0;
let failed = 0;
let stopReason = 'queue empty';
const filledDetail = [];
const failedDetail = [];

for (const item of toFill) {
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
    console.log(`[batch-runner] ${item.company} / ${item.role}: filled`);
    filledDetail.push({ queueId: item.queueId, company: item.company, role: item.role, reviewed: false });
  } else {
    // D-11: no-form / failed / timeout / trigger-error / duplicate all close
    // the posting tab and move on. 'filled' is the only outcome that leaves
    // its tab open for review.
    failed++;
    if (outcome.tab) await outcome.tab.close().catch(() => {});
    console.log(`[batch-runner] ${item.company} / ${item.role}: ${outcome.state}`);
    failedDetail.push({ queueId: item.queueId, company: item.company, role: item.role, reason: outcome.state });
  }
}

stopReason = capReached ? 'cap' : 'queue empty';

const detail = {
  headline: { filled, skipped: skipped.length, failed },
  stop_reason: stopReason,
  skipped,
  failed: failedDetail,
  filled: filledDetail,
};
await patchRun({ status: 'ok', detail });
console.log(`[batch-runner] done: ${JSON.stringify(detail.headline)} stop_reason=${stopReason}`);

// exiting would kill the browser and every filled tab (D-06) — idle instead
setInterval(() => {}, 1 << 30);
