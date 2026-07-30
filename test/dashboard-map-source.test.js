// @vitest-environment node
//
// Node, not the suite-wide jsdom: this file drives a real Chromium through
// playwright, for the reason dashboard-criteria.test.js records — the
// dashboard's row arrays (apps, etc.) are script-scoped `let`s, so assigning
// `window.apps = …` from page.evaluate creates a DIFFERENT global and leaves
// the real binding empty. State is therefore driven only through routed
// fetches and the page's own load path, and read back through the DOM.
//
// Applications tab — map_source / map_fallback_reason render states
// (999.1-03): the fallback criterion, the reason line, the sub-line count,
// and the escaping guarantee on a hostile reason string.

import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DASHBOARD = readFileSync(join(HERE, '..', 'helper', 'dashboard.html'), 'utf8');

const HOSTILE_REASON = '<img src=x onerror="window.__jfPwned=true">';
const HAIKU_REASON =
  'helper /map 500: mapViaCLI failed (is_error=parse-error, killed=SIGKILL, bound=240000ms): spawn timeout';

/** Every field renderAppRows reads, with per-row overrides. */
function appRow(overrides) {
  return {
    id: overrides.id,
    company: `Co ${overrides.id}`,
    role: 'Engineer',
    url: `https://example.com/${overrides.id}`,
    status: 'applied',
    notes: '',
    resume_path: '',
    cost_usd: 0,
    summary: null,
    tailor_state: 'ran',
    tailor_message: '',
    map_source: '',
    map_fallback_reason: '',
    cover_letter_path: '',
    brief_path: '',
    email_path: '',
    status_changed_at: null,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    ghosted: false,
    days_silent: 0,
    ...overrides,
  };
}

const THREE_STATE_FIXTURE = [
  appRow({ id: 1, map_source: 'haiku', map_fallback_reason: HAIKU_REASON }),
  appRow({ id: 2, map_source: 'helper', map_fallback_reason: '' }),
  appRow({ id: 3, map_source: '', map_fallback_reason: '' }),
  appRow({ id: 4, map_source: 'haiku', map_fallback_reason: HOSTILE_REASON }),
];

let browser;
let page;
/** The body the routed GET /applications serves. */
let apps;

beforeAll(async () => {
  browser = await chromium.launch();
}, 60000);

afterAll(async () => {
  await browser?.close();
});

async function openApplications(fixture) {
  apps = fixture;
  page = await browser.newPage();

  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;

    if (p === '/dashboard') {
      return route.fulfill({ contentType: 'text/html', body: DASHBOARD });
    }
    if (p === '/applications' && req.method() === 'GET') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(apps) });
    }
    // Every other surface's loader — an unrouted request would hang the page.
    return route.fulfill({ contentType: 'application/json', body: '[]' });
  });

  await page.goto('http://jobfill.test/dashboard#applications');
  await page.waitForSelector('#aBody tr.jf-row');
}

beforeEach(async () => {
  await openApplications(THREE_STATE_FIXTURE);
});

afterEach(async () => {
  await page?.close();
});

const POLL = { timeout: 8000, interval: 50 };

const rowById = (id) => page.locator(`#astatus-${id}`).locator('xpath=ancestor::tr[1]');
const decisionCell = (id) => rowById(id).locator('td.jf-decision-cell');
const detailCell = (id) => rowById(id).locator('td').last();

// ---------------------------------------------------------------------------
// Three render states
// ---------------------------------------------------------------------------

test('a haiku-fallback row shows the criterion and the reason', async () => {
  await expect.poll(() => decisionCell(1).textContent(), POLL).toContain('map:haiku-fallback');
  expect(await detailCell(1).textContent()).toContain(HAIKU_REASON);
});

test('a helper-path row shows no map: criterion and no fallback prose, but keeps its own criterion', async () => {
  const decisionText = await decisionCell(2).textContent();
  expect(decisionText).not.toContain('map:');
  expect(decisionText).toContain('you:applied');
  expect(await detailCell(2).textContent()).not.toContain('mapping fell back');
});

test("a historical row with no provenance ('') renders identically to the helper row", async () => {
  const decisionText = await decisionCell(3).textContent();
  expect(decisionText).not.toContain('map:');
  expect(decisionText).toContain('you:applied');
  expect(await detailCell(3).textContent()).not.toContain('mapping fell back');
});

// ---------------------------------------------------------------------------
// Escaping guarantee (T-999.1-09)
// ---------------------------------------------------------------------------

test('a hostile fallback reason renders as text, not as an executed node', async () => {
  await expect.poll(() => decisionCell(4).textContent(), POLL).toContain('map:haiku-fallback');
  expect(await page.evaluate(() => window.__jfPwned)).toBeUndefined();
  expect(await detailCell(4).locator('img').count()).toBe(0);
  expect(await detailCell(4).textContent()).toContain(HOSTILE_REASON);
});

// ---------------------------------------------------------------------------
// Sub-line fallback count
// ---------------------------------------------------------------------------

test('#aCountSub reports N of M mapped paid once any row carries provenance', async () => {
  await expect.poll(() => page.locator('#aCountSub').textContent(), POLL).toContain('2 of 3 mapped paid');
});

test('#aCountSub omits the mapped-paid segment when no row carries provenance', async () => {
  await page.close();
  await openApplications([
    appRow({ id: 1, map_source: '', map_fallback_reason: '' }),
    appRow({ id: 2, map_source: '', map_fallback_reason: '' }),
  ]);
  const sub = await page.locator('#aCountSub').textContent();
  expect(sub).not.toContain('mapped paid');
});
