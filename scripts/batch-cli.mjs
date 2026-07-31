// Thin fire-and-poll client of POST /batch — the `bun run batch` entry point,
// mirroring scripts/seek.mjs's POST-then-poll shape. This is DISTINCT from
// scripts/batch-runner.mjs (the helper-spawned detached loop that actually
// drives the browser): the CLI only POSTs to the helper and polls
// /batch-runs/:id — it never launches a browser itself.

import { resolveToken } from '../helper/token.mjs';

const HELPER = 'http://127.0.0.1:7877';
const TOKEN = resolveToken();

const STOP_REASON_LABELS = {
  cap: 'hit the per-run cap',
  'queue empty': 'queue emptied',
  'browser busy': 'browser profile was already in use',
  'circuit breaker': 'stopped after repeated consecutive failures',
  interrupted: 'interrupted (helper restarted mid-run)',
};

function printHeadline(detail) {
  const h = detail?.headline;
  if (!h) return;
  console.log(`[batch] ${h.filled} filled · ${h.skipped} skipped · ${h.failed} failed`);
  const reasonLabel = STOP_REASON_LABELS[detail.stop_reason] ?? detail.stop_reason ?? 'unknown';
  console.log(`[batch] stop reason: ${reasonLabel}`);
}

const startRes = await fetch(HELPER + '/batch', {
  method: 'POST',
  headers: { 'x-jobfill-token': TOKEN },
});
if (startRes.status === 409) {
  const body = await startRes.json();
  if (body.error === 'sweep running') {
    console.log(`[batch] sweep is running (run ${body.runId}) — try again after it finishes`);
  } else {
    console.log(`[batch] batch already running (run ${body.runId})`);
  }
  process.exit(0);
}
if (!startRes.ok) {
  console.error(`[batch] POST /batch failed: HTTP ${startRes.status}`);
  process.exit(1);
}
const { id } = await startRes.json();
console.log(`[batch] batch started (run ${id})`);

const POLL_INTERVAL_MS = 3 * 1000;
const MAX_POLL_MS = 4 * 60 * 60 * 1000;
const deadline = Date.now() + MAX_POLL_MS;

// Fail-open polling (mirrors the runner side): the detached run survives
// helper restarts by design (D-06), so one refused connection or bad
// response must not kill the monitor with a false failure exit. Only give
// up after several consecutive failed polls.
const MAX_CONSECUTIVE_POLL_FAILURES = 5;
let row = null;
let pollFailures = 0;
while (Date.now() < deadline) {
  try {
    const res = await fetch(`${HELPER}/batch-runs/${id}`, { headers: { 'x-jobfill-token': TOKEN } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    row = await res.json();
    pollFailures = 0;
  } catch (e) {
    pollFailures += 1;
    if (pollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
      console.error(`[batch] polling failed ${pollFailures} times in a row (${e.message}) — giving up; the run itself may still be going, check the dashboard`);
      process.exit(1);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    continue;
  }
  if (row.status !== 'running') break;
  await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
}

if (!row || row.status === 'running') {
  console.error(`[batch] timed out waiting for run ${id} to finish`);
  process.exit(1);
}

printHeadline(row.detail);

console.log(`[batch] ${row.status === 'ok' ? 'complete' : 'failed'}`);
if (row.status !== 'ok') process.exit(1);
