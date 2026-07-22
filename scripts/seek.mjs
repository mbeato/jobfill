// Shared full-sweep entrypoint (D-12) — also the job Phase 11's scheduler
// drives. Sequence: POST /seek runs the fetch sources (Greenhouse/Lever/Ashby/
// HN), then the Playwright sidecar runs the login-gated sources (YC/Jobright)
// and POSTs its own findings to /seek/results. A missing/failing sidecar never
// aborts the sweep (fail-open, D-13) — per-source failure is not a sweep
// failure, so this script always exits 0 once the fetch-source POST completes.

import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = 'http://127.0.0.1:7877';
const TOKEN = process.env.JOBFILL_TOKEN ?? 'REDACTED-TOKEN';

function printCounts(label, results) {
  console.log(`[seek] ${label}:`);
  for (const r of results) {
    if (r.error) console.log(`  ${r.source}: error — ${r.error}`);
    else console.log(`  ${r.source}: fetched ${r.fetched}, upserted ${r.upserted ?? 0}`);
  }
}

const res = await fetch(`${HELPER}/seek`, {
  method: 'POST',
  headers: { 'x-jobfill-token': TOKEN },
});
if (!res.ok) {
  console.error(`[seek] POST /seek failed: HTTP ${res.status}`);
  process.exit(1);
}
const fetchResults = await res.json();
printCounts('fetch sources', fetchResults);

try {
  const sidecarPath = join(ROOT, 'scripts', 'seek-sidecar.mjs');
  const exitCode = await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [sidecarPath], { stdio: 'inherit' });
    proc.on('error', reject);
    proc.on('exit', code => resolve(code));
  });
  console.log(`[seek] sidecar exited with code ${exitCode}`);
} catch (err) {
  console.error(`[seek] sidecar did not run (${err?.message ?? err}) — continuing, fetch sources already swept`);
}

console.log('[seek] sweep complete');
