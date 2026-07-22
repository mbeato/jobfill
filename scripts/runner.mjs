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

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = 'http://127.0.0.1:7877';
const TOKEN = 'REDACTED-TOKEN';
const EXT_DIR = join(ROOT, 'extension');
const PROFILE_DIR = join(ROOT, '.runner-profile');
const POLL_MS = 25_000;
const BUDGET_MS = 10 * 60_000;

const args = process.argv.slice(2);
const queueId = Number(args[0]);
const resumePath = args.includes('--resume')
  ? args[args.indexOf('--resume') + 1]
  : '/Users/you/resume/resume.pdf';
if (!queueId) { console.error('usage: node scripts/runner.mjs <queueId> [--resume pdf]'); process.exit(1); }

const q = async () => {
  const r = await fetch(`${HELPER}/queue`, { headers: { 'x-jobfill-token': TOKEN } });
  return (await r.json()).find((row) => row.id === queueId);
};

const row = await q();
if (!row) { console.error(`queue row ${queueId} not found`); process.exit(1); }
if (row.status !== 'queued') { console.error(`row ${queueId} is '${row.status}', not 'queued' — refusing (no re-touch)`); process.exit(1); }
console.log(`[runner] row ${queueId}: ${row.url}`);

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  args: [
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
  ],
});

// Resolve the extension ID from its MV3 service worker
let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15_000 });
const extId = new URL(sw.url()).host;
console.log(`[runner] extension loaded: ${extId}`);

// Seed extension storage via the options page context (full chrome.* access)
const opts = await ctx.newPage();
await opts.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: 'domcontentloaded' });
const state = await opts.evaluate(() => chrome.storage.local.get(['apiKey', 'profile', 'resume']));
if (!state.profile || !state.resume) {
  const profile = JSON.parse(readFileSync(join(ROOT, 'profile.local.json'), 'utf8'));
  const resume = { name: basename(resumePath), b64: readFileSync(resumePath).toString('base64') };
  await opts.evaluate((seed) => chrome.storage.local.set(seed), { profile, resume });
  console.log('[runner] seeded profile + resume into extension storage');
  await opts.reload();
}
if (!state.apiKey) {
  console.log('[runner] NO API KEY — paste your Anthropic API key in the options window that just opened, click Save. Waiting...');
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const { apiKey } = await opts.evaluate(() => chrome.storage.local.get('apiKey'));
    if (apiKey) break;
  }
  console.log('[runner] API key detected');
}
await opts.close();

// Step 2: navigate to the posting in its own tab
const postingPage = await ctx.newPage();
await postingPage.goto(row.url, { waitUntil: 'domcontentloaded' });
// Step 3: sanity check — a real form rendered (SPA may lag; poll up to 60s)
let formOk = false;
for (let i = 0; i < 20 && !formOk; i++) {
  await postingPage.waitForTimeout(3000);
  formOk = (await postingPage.locator('input, textarea, select').count()) > 2;
}
if (!formOk) {
  const title = await postingPage.title();
  const inputs = await postingPage.locator('input, textarea, select').count();
  const excerpt = (await postingPage.locator('body').innerText().catch(() => '')).slice(0, 300).replace(/\s+/g, ' ');
  console.log(`[runner] DIAG title="${title}" inputs=${inputs} body="${excerpt}"`);
  console.log('[runner] no real form rendered (login wall / CAPTCHA / empty SPA?) — stopping for the operator, browser left open');
  setInterval(() => {}, 1 << 30);
} else {
  console.log('[runner] posting form rendered');

  // Step 4: dashboard tab (the externally_connectable origin)
  const dash = await ctx.newPage();
  await dash.goto(`${HELPER}/`, { waitUntil: 'domcontentloaded' });

  // Step 5: fire-and-forget trigger from the dashboard page context
  await dash.evaluate(([id, url, qid]) => {
    chrome.runtime.sendMessage(id, { type: 'jobfill.trigger', url, queueId: qid }, () => void chrome.runtime.lastError);
    return 'fired';
  }, [extId, row.url, queueId]);
  console.log('[runner] trigger fired; polling queue');

  // Step 6: fire-and-poll
  const t0 = Date.now();
  let last = '';
  let done = false;
  while (!done && Date.now() - t0 < BUDGET_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const cur = await q();
    if (cur.status !== last) { console.log(`[runner] status: ${cur.status}`); last = cur.status; }
    if (cur.status !== 'queued' && cur.status !== 'filling') {
      console.log('[runner] RESULT ' + JSON.stringify(cur));
      done = true;
    }
  }
  if (!done) console.log('[runner] TIMEOUT — still ' + (last || 'queued') + ' after 10min; flag to the operator.');
  console.log('[runner] browser stays open for review; close the window or Ctrl+C to end');
  // exiting would kill the browser and lose the filled form — idle instead
  setInterval(() => {}, 1 << 30);
}
