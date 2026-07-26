// Thin fire-and-poll client of POST /sweep (D-10/SCHED-02) — the CLI and the
// dashboard button both reach the exact same helper route, which itself
// drives runSweepJob (fetch sources, then filter/promote, then the
// helper-owned Playwright sidecar for the login-gated sources). This script
// never holds a single request open for the sweep's duration; each poll is a
// fresh short fetch.

const HELPER = 'http://127.0.0.1:7877';
const TOKEN = process.env.JOBFILL_TOKEN ?? 'REDACTED-TOKEN';

function printCounts(results) {
  console.log('[seek] fetch sources:');
  for (const r of results) {
    if (r.error) console.log(`  ${r.source}: error — ${r.error}`);
    else console.log(`  ${r.source}: fetched ${r.fetched}, upserted ${r.upserted ?? 0}`);
  }
}

function printFilterCounts(counts) {
  console.log('[seek] filter/decide:');
  console.log(
    `  rulesRejected ${counts.rulesRejected}, llmRejected ${counts.llmRejected}, queued ${counts.queued}, held ${counts.held}, deduped ${counts.deduped}, unscored ${counts.unscored}, errored ${counts.errored ?? 0}`,
  );
  console.log(
    `  byCriterion: title ${counts.byCriterion.title}, location ${counts.byCriterion.location}, stale ${counts.byCriterion.stale}, yoe ${counts.byCriterion.yoe}, llm ${counts.byCriterion.llm}, grace ${counts.byCriterion.grace}`,
  );
}

function printSidecar(sidecar) {
  if (!sidecar) return;
  if (!sidecar.ran) {
    console.log(`[seek] sidecar: did not run${sidecar.error ? ` (${sidecar.error})` : ''}`);
    return;
  }
  console.log(`[seek] sidecar: exited with code ${sidecar.exitCode}`);
  if (sidecar.authExpired?.length) {
    console.log(`  auth-expired: ${sidecar.authExpired.join(', ')}`);
  }
}

const startRes = await fetch(`${HELPER}/sweep`, {
  method: 'POST',
  headers: { 'x-jobfill-token': TOKEN },
});
if (startRes.status === 409) {
  const body = await startRes.json();
  console.log(`[seek] sweep already running (run ${body.runId})`);
  process.exit(0);
}
if (!startRes.ok) {
  console.error(`[seek] POST /sweep failed: HTTP ${startRes.status}`);
  process.exit(1);
}
const { id } = await startRes.json();
console.log(`[seek] sweep started (run ${id})`);

const POLL_INTERVAL_MS = 3 * 1000;
const MAX_POLL_MS = 4 * 60 * 60 * 1000;
const deadline = Date.now() + MAX_POLL_MS;

let row = null;
while (Date.now() < deadline) {
  const res = await fetch(`${HELPER}/sweeps/${id}`, { headers: { 'x-jobfill-token': TOKEN } });
  if (!res.ok) {
    console.error(`[seek] GET /sweeps/${id} failed: HTTP ${res.status}`);
    process.exit(1);
  }
  row = await res.json();
  if (row.status !== 'running') break;
  await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
}

if (!row || row.status === 'running') {
  console.error(`[seek] timed out waiting for run ${id} to finish`);
  process.exit(1);
}

const detail = row.detail ?? {};
if (detail.fetch) printCounts(detail.fetch);
if (detail.filter) printFilterCounts(detail.filter);
printSidecar(detail.sidecar);

console.log(`[seek] sweep ${row.status === 'ok' ? 'complete' : 'failed'}`);
if (row.status !== 'ok') process.exit(1);
