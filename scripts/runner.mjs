// Playwright-driven runner for the jobfill queue (docs/runner-protocol.md).
// Launches a headed Chromium with the jobfill unpacked extension loaded,
// self-seeds extension storage (profile/resume from disk; API key is pasted
// by the operator in the options page — the runner never handles it), opens the
// posting + dashboard tabs, fires jobfill.trigger from the dashboard origin,
// and polls the queue until the fill leaves `filling`.
//
// Usage: node scripts/runner.mjs <queueId> [--resume /path/to/resume.pdf]
// The browser stays open after the run so the operator can review the filled form.
// Invariants (docs/runner-protocol.md): never submits, never types into ATS
// fields, one fill in flight, no auto-retry.
//
// Mechanics live in ./lib/runner-core.mjs (shared with the batch loop,
// scripts/batch-runner.mjs); this script drives a single queue row through
// setupRunner + fillOne, unchanged from its pre-extraction observable
// behavior — with one deliberate deviation: a locked .runner-profile now
// prints a clean 'browser busy' message instead of a raw Playwright crash
// (same exit code 1).

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupRunner, fillOne, q } from './lib/runner-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = join(ROOT, 'extension');
const PROFILE_DIR = join(ROOT, '.runner-profile');

const args = process.argv.slice(2);
const queueId = Number(args[0]);
const resumeFlag = args.indexOf('--resume');
const explicitResume = resumeFlag !== -1;
if (explicitResume && !args[resumeFlag + 1]) { console.error('--resume requires a path'); process.exit(1); }
const resumePath = explicitResume ? args[resumeFlag + 1] : '/Users/you/resume/resume.pdf';
if (explicitResume && !existsSync(resumePath)) { console.error(`--resume file not found: ${resumePath}`); process.exit(1); }
if (!queueId) { console.error('usage: node scripts/runner.mjs <queueId> [--resume pdf]'); process.exit(1); }

const row = await q(queueId);
if (!row) { console.error(`queue row ${queueId} not found`); process.exit(1); }
if (row.status !== 'queued') { console.error(`row ${queueId} is '${row.status}', not 'queued' — refusing (no re-touch)`); process.exit(1); }
console.log(`[runner] row ${queueId}: ${row.url}`);

let ctx, extId, getDashPage;
try {
  ({ ctx, extId, getDashPage } = await setupRunner({ profileDir: PROFILE_DIR, extDir: EXT_DIR, root: ROOT, resumePath, explicitResume }));
} catch (e) {
  if (e.code === 'PROFILE_LOCKED') {
    console.error(`[runner] browser busy — .runner-profile is already locked: ${e.message}`);
    process.exit(1);
  }
  throw e;
}

await fillOne(ctx, extId, getDashPage, row);

// exiting would kill the browser and lose the filled form — idle instead
setInterval(() => {}, 1 << 30);
