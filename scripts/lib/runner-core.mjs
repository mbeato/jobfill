// Shared runner mechanics for the jobfill queue (docs/runner-protocol.md).
// Extracted from scripts/runner.mjs so the batch loop (scripts/batch-runner.mjs,
// Plan 04) can reuse the same launch + per-posting fire-and-poll primitives
// without relaxing any protocol invariant. scripts/runner.mjs imports this
// module and matches its pre-extraction observable behavior — tab ordering
// included: the posting tab opens first and the dashboard tab only after the
// form sanity-check passes (lazily, via getDashPage below); the no-form path
// never opens a dashboard tab. One deliberate deviation: a locked
// .runner-profile now surfaces as a tagged PROFILE_LOCKED error so callers
// print a clean 'browser busy' message instead of a raw Playwright crash
// (same exit code).
//
// Invariants (docs/runner-protocol.md): never submits, never types into ATS
// fields, one fill in flight, no auto-retry. Orchestration only — no code
// path here can click, type into, or submit an ATS form.

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { resolveToken } from '../../helper/token.mjs';

export const HELPER = 'http://127.0.0.1:7877';
export const TOKEN = resolveToken();
export const POLL_MS = 25_000;
export const BUDGET_MS = 10 * 60_000;

// Visible controls only: login walls and SPA skeletons carry hidden inputs
// (CSRF tokens, framework state) that would pass a raw count.
export const VISIBLE_FIELDS = 'input:visible:not([type=hidden]), textarea:visible, select:visible';

// Queue-fetch helper, parameterized by queueId (used internally by fillOne's
// poll loop and returned from setupRunner for callers that need it directly).
export async function q(queueId) {
  const r = await fetch(`${HELPER}/queue`, { headers: { 'x-jobfill-token': TOKEN } });
  return (await r.json()).find((row) => row.id === queueId);
}

// Launch the persistent Chromium context with the extension loaded, and seed
// profile/resume + wait for the API key on first run. The dashboard-origin
// tab (externally_connectable trigger origin) is NOT opened here — fillOne
// opens it lazily via the returned getDashPage, only after a posting's form
// sanity-check has passed (pre-extraction ordering), then reuses it across
// calls.
export async function setupRunner({ profileDir, extDir, root, resumePath, explicitResume }) {
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      // Without this, Playwright emulates a FIXED 1280x720 viewport that does not
      // follow the OS window — so resizing the Chrome-for-Testing window visibly
      // does nothing to the page, while ordinary Chrome resizes fine. `null` hands
      // the viewport back to the real window, which is what a headful window you
      // are meant to watch and drive by hand needs. Nothing here measures or
      // screenshots against a fixed size, so there is no test to re-pin.
      viewport: null,
      args: [
        `--disable-extensions-except=${extDir}`,
        `--load-extension=${extDir}`,
      ],
    });
  } catch (e) {
    // D-02: .runner-profile is single-instance. Tag the rejection so callers
    // map it to a 'browser busy' outcome instead of an unhandled crash.
    const err = new Error(`profile launch failed (locked?): ${e.message}`);
    err.code = 'PROFILE_LOCKED';
    err.cause = e;
    throw err;
  }

  // Resolve the extension ID from its MV3 service worker
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15_000 });
  const extId = new URL(sw.url()).host;
  console.log(`[runner] extension loaded: ${extId}`);

  // Seed extension storage via the options page context (full chrome.* access)
  const opts = await ctx.newPage();
  await opts.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: 'domcontentloaded' });
  const state = await opts.evaluate(() => chrome.storage.local.get(['apiKey', 'helperToken', 'profile', 'resume']));
  // Profile always reseeds fresh from disk: profile.local.json is the source of
  // truth (edit-config-not-code), so contact/EEO edits apply on the next start
  // instead of being shadowed forever by a stale copy in extension storage.
  // An explicit --resume stays authoritative for the resume: reseed even if storage
  // already holds one from a previous run (otherwise the flag is silently a no-op).
  const profile = JSON.parse(readFileSync(join(root, 'profile.local.json'), 'utf8'));
  // helperToken always reseeds unconditionally from resolveToken() (T-22-09): a stale
  // token left over in extension storage from a previous install must never silently
  // survive a rotation of .jobfill-token.
  const seed = { profile, helperToken: TOKEN };
  if (!state.resume || explicitResume) {
    seed.resume = { name: basename(resumePath), b64: readFileSync(resumePath).toString('base64') };
  }
  await opts.evaluate((s) => chrome.storage.local.set(s), seed);
  console.log(`[runner] seeded profile + helper token${seed.resume ? ` + resume (${basename(resumePath)})` : ''} into extension storage`);
  await opts.reload();
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

  // One dashboard-origin tab, opened lazily on first use, reused by every
  // fillOne call after that.
  let dashPage = null;
  const getDashPage = async () => {
    if (!dashPage || dashPage.isClosed()) {
      dashPage = await ctx.newPage();
      await dashPage.goto(`${HELPER}/`, { waitUntil: 'domcontentloaded' });
    }
    return dashPage;
  };

  return { ctx, extId, getDashPage, q };
}

// Drive one posting through the fill sequence: navigate, sanity-check for a
// real form, fire jobfill.trigger from the dashboard tab's context, and
// fire-and-poll the queue row until it leaves 'filling' (or the budget
// expires). Returns a structured outcome instead of idling — the caller
// decides what to do next (idle for review, or move to the next posting).
export async function fillOne(ctx, extId, getDashPage, row, { pollMs = POLL_MS, budgetMs = BUDGET_MS } = {}) {
  // Step 2: navigate to the posting in its own tab
  const postingPage = await ctx.newPage();
  await postingPage.goto(row.url, { waitUntil: 'domcontentloaded' });

  // Step 3: sanity check — a real form rendered (SPA may lag; poll up to 60s).
  let formOk = false;
  for (let i = 0; i < 20 && !formOk; i++) {
    await postingPage.waitForTimeout(3000);
    formOk = (await postingPage.locator(VISIBLE_FIELDS).count()) > 2;
  }
  if (!formOk) {
    const title = await postingPage.title();
    const inputs = await postingPage.locator(VISIBLE_FIELDS).count();
    const excerpt = (await postingPage.locator('body').innerText().catch(() => '')).slice(0, 300).replace(/\s+/g, ' ');
    console.log(`[runner] DIAG title="${title}" inputs=${inputs} body="${excerpt}"`);
    console.log('[runner] no real form rendered (login wall / CAPTCHA / empty SPA?) — stopping for the operator, browser left open');
    return { state: 'no-form', tab: postingPage };
  }
  console.log('[runner] posting form rendered');

  // Step 4: dashboard tab (the externally_connectable origin) — opened only
  // now that the form check passed, matching pre-extraction ordering; the
  // getter caches the tab so later fillOne calls reuse it.
  const dashPage = await getDashPage();

  // Step 5: fire the trigger from the dashboard page context. Non-blocking — the
  // evaluate returns immediately ('fired'); the sendMessage callback reports back
  // later through an exposed binding. Duplicate and trigger-rejection outcomes
  // exist ONLY on this callback (they occur before the 'filling' PATCH), so
  // discarding it means a 10-minute TIMEOUT with no cause.
  // The binding name is per-row so dashPage can be reused across multiple
  // fillOne calls (batch loop) without re-registering the same function name.
  let triggerResp = null;
  const resultFn = `__runnerResult_${row.id}`;
  await dashPage.exposeFunction(resultFn, (r) => { triggerResp = r; });
  await dashPage.evaluate(([id, url, qid, fnName]) => {
    chrome.runtime.sendMessage(id, { type: 'jobfill.trigger', url, queueId: qid },
      (resp) => window[fnName](chrome.runtime.lastError ? { state: 'error', error: chrome.runtime.lastError.message } : resp));
    return 'fired';
  }, [extId, row.url, row.id, resultFn]);
  console.log('[runner] trigger fired; polling queue');

  // Step 6: fire-and-poll
  const t0 = Date.now();
  let last = '';
  let done = false;
  let cur = null;
  let outState = null;
  while (!done && Date.now() - t0 < budgetMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    // The trigger callback carries outcomes that never reach the queue row
    // (duplicate early-return, resolveTargetTab rejection) — end the poll with
    // the real reason instead of burning the full budget into a fake TIMEOUT.
    if (triggerResp?.state === 'duplicate' || triggerResp?.state === 'error') {
      console.log('[runner] TRIGGER ' + JSON.stringify(triggerResp));
      console.log(`[runner] trigger ended as '${triggerResp.state}' — row stays queued; stopping poll, browser left open`);
      outState = triggerResp.state === 'duplicate' ? 'duplicate' : 'trigger-error';
      done = true;
      break;
    }
    // Fail-open (docs/runner-protocol.md): a transient helper hiccup or a vanished
    // row must never crash the process — that would kill the headed browser and
    // destroy the filled form the operator is meant to review.
    try {
      cur = await q(row.id);
    } catch (e) {
      console.log(`[runner] poll failed (helper hiccup?) — retrying: ${e.message}`);
      continue;
    }
    if (!cur) {
      console.log(`[runner] row ${row.id} vanished from queue — stopping poll; browser left open`);
      break;
    }
    if (cur.status !== last) { console.log(`[runner] status: ${cur.status}`); last = cur.status; }
    if (cur.status !== 'queued' && cur.status !== 'filling') {
      console.log('[runner] RESULT ' + JSON.stringify(cur));
      outState = cur.status;
      done = true;
    }
  }
  if (!done) console.log('[runner] TIMEOUT — still ' + (last || 'queued') + ' after 10min; flag to the operator.');
  console.log('[runner] browser stays open for review; close the window or Ctrl+C to end');
  return { state: outState ?? 'timeout', row: cur, tab: postingPage };
}
