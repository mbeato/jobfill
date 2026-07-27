// @vitest-environment node
//
// Node, not the suite-wide jsdom: this file drives a real Chromium through
// playwright, and launching a browser from inside the jsdom environment hangs
// before the first hook runs. Every other file in test/ still gets jsdom from
// vitest.config.js.
//
// Criteria editor — token inputs and the yoe cap control.
//
// Driven in a real browser rather than jsdom, for the reason recorded in the
// Phase 19 handoff: dashboard.html's state lives in script-scoped `let`s, so
// assigning `window.something` from page.evaluate creates a DIFFERENT global
// and leaves the real binding untouched. Everything below therefore goes
// through routed fetches and the page's own load path, and reads state back
// through the DOM and the page's own readCriteriaForm().
//
// Assertions use vitest's expect against plain values (with expect.poll where
// something has to settle) rather than @playwright/test's locator matchers —
// the project ships `playwright` only, and this needs no second test runner.

import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DASHBOARD = readFileSync(join(HERE, '..', 'helper', 'dashboard.html'), 'utf8');

const CRITERIA = {
  seniorityTerms: ['senior', 'principal'],
  nonEngineeringTerms: ['recruiter'],
  locationTerms: ['new york', 'remote'],
  workModeOnlyTerms: ['hybrid'],
  staffLeadBuiltins: true,
  maxStaleDays: 2,
  maxStaleDaysIndexed: 7,
  maxFirstSeenDays: 7,
  yoeThreshold: 6,
};

const TITLE_VOCAB = [
  { value: 'Software Engineer', count: 186 },
  { value: 'Senior Software Engineer', count: 150 },
  { value: 'Sales Development Representative', count: 101 },
  { value: 'Product Manager', count: 44 },
];
const LOCATION_VOCAB = [
  { value: 'San Francisco', count: 1484 },
  { value: 'New York, NY', count: 654 },
  { value: 'Remote', count: 300 },
];

let browser;
let page;
/** The body the routed /settings/criteria GET serves, and the PATCHes captured. */
let criteria;
let patches;

beforeAll(async () => {
  browser = await chromium.launch();
}, 60000);

afterAll(async () => {
  await browser?.close();
});

beforeEach(async () => {
  criteria = structuredClone(CRITERIA);
  patches = [];
  page = await browser.newPage();

  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;

    if (p === '/dashboard') {
      return route.fulfill({ contentType: 'text/html', body: DASHBOARD });
    }
    if (p === '/settings/criteria' && req.method() === 'PATCH') {
      const body = JSON.parse(req.postData() || '{}');
      patches.push(body);
      criteria = body;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(criteria) });
    }
    if (p === '/settings/criteria') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(criteria) });
    }
    if (p === '/settings/vocabulary') {
      const field = url.searchParams.get('field');
      const values = field === 'title' ? TITLE_VOCAB : field === 'location' ? LOCATION_VOCAB : [];
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ field, values }) });
    }
    // Every other surface's loader — the criteria editor is what is under
    // test, and an unrouted request would hang the page.
    return route.fulfill({ contentType: 'application/json', body: '[]' });
  });

  // #settings, not the default queue destination: every other surface is
  // display:none, and a control inside a hidden destination cannot be clicked
  // or typed into.
  await page.goto('http://jobfill.test/dashboard#settings');
  await page.waitForSelector('[data-jf-tokens="crit-seniority"] .jf-token');
}, 30000);

afterEach(async () => {
  await page?.close();
});

/** The hidden field's terms — the value readCriteriaForm() actually reads. */
const terms = (id) => page.evaluate((i) => termsOf(i), id);
const form = () => page.evaluate(() => readCriteriaForm());
const entry = (id) => page.locator(`#${id}-entry`);
const chips = (id) => page.locator(`[data-jf-tokens="${id}"] .jf-token`);
const val = (sel) => page.locator(sel).inputValue();
const checked = (sel) => page.locator(sel).isChecked();
const disabled = (sel) => page.locator(sel).isDisabled();
const text = (sel) => page.locator(sel).textContent();
const classes = (sel) => page.locator(sel).getAttribute('class');
// Every expect.poll below waits on a real browser plus a routed fetch. The
// 1s default is tight when the whole suite runs at once, and a timing-only
// failure here would say nothing about the code.
const POLL = { timeout: 8000, interval: 50 };

const armable = () => classes('#criteriaSaveBtn').then((c) => c.includes('jf-armable'));

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test('each term renders as one chip, and the hidden field still drives readCriteriaForm', async () => {
  expect(await chips('crit-seniority').count()).toBe(2);
  expect(await terms('crit-seniority')).toEqual(['senior', 'principal']);
  const c = await form();
  expect(c.seniorityTerms).toEqual(['senior', 'principal']);
  expect(c.locationTerms).toEqual(['new york', 'remote']);
  expect(c.workModeOnlyTerms).toEqual(['hybrid']);
});

test('the live-state row counts terms exactly as before the port', async () => {
  expect(await text('#state-seniority')).toContain('2 terms');
  expect(await text('#state-workmode')).toContain('1 terms');
});

// ---------------------------------------------------------------------------
// D-06 fail-open — the project's named catastrophic failure mode.
// An empty term list DISABLES its rule and must read as calm, never as an error.
// ---------------------------------------------------------------------------

test('emptying a list reads as "rule off", not as an error', async () => {
  await page.evaluate(() => setTerms('crit-location', []));
  const state = await text('#state-location');
  expect(state).toContain('rule off');
  expect(state).toContain('location filtering is off');
  // No error styling exists in this system, and none may appear here.
  expect(await page.locator('#state-location .jf-notice').count()).toBe(0);
  expect((await form()).locationTerms).toEqual([]);
});

test('an empty list never blocks saving — a disabled rule is a valid state', async () => {
  await page.evaluate(() => setTerms('crit-seniority', []));
  expect(await disabled('#criteriaSaveBtn')).toBe(false);
});

// ---------------------------------------------------------------------------
// Adding and removing terms
// ---------------------------------------------------------------------------

test('typing a term and pressing Enter adds it', async () => {
  await entry('crit-seniority').fill('staff');
  await entry('crit-seniority').press('Enter');
  expect(await terms('crit-seniority')).toEqual(['senior', 'principal', 'staff']);
  expect(await val('#crit-seniority-entry')).toBe('');
});

// The lists are the user's own vocabulary, not a closed enum — this is the
// requirement that rules out a <select>.
test('free text absent from the vocabulary is still addable', async () => {
  await entry('crit-nonEng').fill('zamboni driver');
  await entry('crit-nonEng').press('Enter');
  expect(await terms('crit-nonEng')).toContain('zamboni driver');
});

test('a comma commits, so a pasted comma-separated list becomes separate terms', async () => {
  await entry('crit-workmode').fill('onsite, in office, ');
  expect(await terms('crit-workmode')).toEqual(['hybrid', 'onsite', 'in office']);
});

test('the remove button drops exactly that term', async () => {
  await chips('crit-location').first().locator('.jf-token-x').click();
  expect(await terms('crit-location')).toEqual(['remote']);
});

test('Backspace on an empty entry removes the last term', async () => {
  await entry('crit-seniority').press('Backspace');
  expect(await terms('crit-seniority')).toEqual(['senior']);
});

test("a duplicate is not added twice, matching the filter's case-insensitive rules", async () => {
  // compileTerms compiles with the `i` flag, so "SENIOR" and "senior" are one
  // rule — showing both as chips would misstate the rule to someone auditing it.
  await entry('crit-seniority').fill('SENIOR');
  await entry('crit-seniority').press('Enter');
  expect(await terms('crit-seniority')).toEqual(['senior', 'principal']);
});

test('a term typed but not committed is not lost when focus leaves', async () => {
  await entry('crit-nonEng').fill('sales');
  await page.locator('#cap-stale').click();
  await expect.poll(() => terms('crit-nonEng'), POLL).toEqual(['recruiter', 'sales']);
});

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

test('typing offers matching values from the observed vocabulary', async () => {
  await entry('crit-nonEng').fill('sales');
  await expect.poll(() => page.locator('#crit-nonEng-sugg .jf-sugg-opt', POLL).count()).toBe(1);
  const list = await text('#crit-nonEng-sugg');
  expect(list).toContain('Sales Development Representative');
  expect(list).toContain('101');
});

test('the title inputs draw on titles and the location inputs on locations', async () => {
  await entry('crit-seniority').fill('engineer');
  await expect.poll(() => text('#crit-seniority-sugg'), POLL).toContain('Software Engineer');
  await entry('crit-location').fill('san');
  await expect.poll(() => text('#crit-location-sugg'), POLL).toContain('San Francisco');
});

test('clicking a suggestion adds it as an ordinary term', async () => {
  await entry('crit-nonEng').fill('product');
  await page.locator('#crit-nonEng-sugg .jf-sugg-opt').first().click();
  expect(await terms('crit-nonEng')).toEqual(['recruiter', 'Product Manager']);
});

test('nothing is highlighted until the user arrows to it, so Enter commits what was typed', async () => {
  await entry('crit-seniority').fill('SENIOR');
  await expect.poll(() => page.locator('#crit-seniority-sugg', POLL).isVisible()).toBe(true);
  expect(await page.locator('#crit-seniority-sugg .jf-sugg-opt[aria-selected="true"]').count()).toBe(0);
});

test('Enter takes the highlighted suggestion once the user arrows to one', async () => {
  await entry('crit-seniority').fill('e');
  await expect.poll(() => page.locator('#crit-seniority-sugg .jf-sugg-opt', POLL).count()).toBeGreaterThan(1);
  await entry('crit-seniority').press('ArrowDown');
  await entry('crit-seniority').press('ArrowDown');
  await entry('crit-seniority').press('Enter');
  expect(await terms('crit-seniority')).toEqual(['senior', 'principal', 'Senior Software Engineer']);
});

test('Escape closes the list without adding anything', async () => {
  await entry('crit-nonEng').fill('product');
  await expect.poll(() => page.locator('#crit-nonEng-sugg', POLL).isVisible()).toBe(true);
  await entry('crit-nonEng').press('Escape');
  expect(await page.locator('#crit-nonEng-sugg').isVisible()).toBe(false);
  expect(await terms('crit-nonEng')).toEqual(['recruiter']);
});

test('a term already on the list is not offered again', async () => {
  await entry('crit-location').fill('remote');
  // "Remote" is in LOCATION_VOCAB but already a chip.
  await expect.poll(() => page.locator('#crit-location-sugg', POLL).isVisible()).toBe(false);
});

test('the editor still works when the vocabulary endpoint fails', async () => {
  await page.route('**/settings/vocabulary**', (r) => r.fulfill({ status: 500, body: 'boom' }));
  await page.evaluate(() => loadSettings());
  await page.waitForSelector('[data-jf-tokens="crit-seniority"] .jf-token');
  await entry('crit-seniority').fill('staff');
  await entry('crit-seniority').press('Enter');
  expect(await terms('crit-seniority')).toEqual(['senior', 'principal', 'staff']);
});

// ---------------------------------------------------------------------------
// 19-REVIEW WR-01 — isNarrowing() must still receive the same before/after
// term sets, and the armed two-click confirm must survive.
// ---------------------------------------------------------------------------

test('adding a term to a REJECT list arms the save button', async () => {
  expect(await armable()).toBe(false);
  await entry('crit-seniority').fill('staff');
  await entry('crit-seniority').press('Enter');
  expect(await armable()).toBe(true);
  expect(await text('#criteriaSaveBtn')).toBe('save — narrows criteria');
});

test('removing a term from the ACCEPT list arms the save button, the other direction', async () => {
  await chips('crit-location').first().locator('.jf-token-x').click();
  expect(await armable()).toBe(true);
});

test('a widening edit does not arm the button', async () => {
  await chips('crit-seniority').first().locator('.jf-token-x').click();
  expect(await armable()).toBe(false);
});

test('a narrowing save takes two clicks and the first sends nothing', async () => {
  await entry('crit-seniority').fill('staff');
  await entry('crit-seniority').press('Enter');
  await page.locator('#criteriaSaveBtn').click();
  expect(patches).toEqual([]);
  expect(await text('#criteriaSaveBtn')).toBe('confirm?');
  await page.locator('#criteriaSaveBtn').click();
  await expect.poll(() => patches.length, POLL).toBe(1);
  expect(patches[0].seniorityTerms).toEqual(['senior', 'principal', 'staff']);
});

// ---------------------------------------------------------------------------
// yoe cap — slider + number + explicit no-cap.
//
// The hard constraint: blank means the rule is OFF, and a bare range input
// always has a value. null must survive the round trip, or Phase 9 D-14 makes
// the silent conversion permanent.
// ---------------------------------------------------------------------------

test('a set cap shows on both the slider and the number box, with no-cap unticked', async () => {
  expect(await val('#cap-yoe')).toBe('6');
  expect(await val('#cap-yoe-range')).toBe('6');
  expect(await checked('#cap-yoe-nocap')).toBe(false);
  expect((await form()).yoeThreshold).toBe(6);
});

test('dragging the slider updates the number box and the value read from the form', async () => {
  await page.locator('#cap-yoe-range').fill('12');
  expect(await val('#cap-yoe')).toBe('12');
  expect((await form()).yoeThreshold).toBe(12);
});

test('typing in the number box moves the slider', async () => {
  await page.locator('#cap-yoe').fill('3');
  expect(await val('#cap-yoe-range')).toBe('3');
  expect((await form()).yoeThreshold).toBe(3);
});

test('ticking no cap turns the rule OFF — yoeThreshold is null, not 0', async () => {
  await page.locator('#cap-yoe-nocap').check();
  expect((await form()).yoeThreshold).toBeNull();
  expect(await val('#cap-yoe')).toBe('');
  expect(await disabled('#cap-yoe-range')).toBe(true);
  expect(await text('#state-yoe')).toContain('rule off');
});

test('a cap of 0 is a real cap and is not confused with no cap', async () => {
  await page.locator('#cap-yoe').fill('0');
  expect((await form()).yoeThreshold).toBe(0);
  expect(await checked('#cap-yoe-nocap')).toBe(false);
  expect(await text('#state-yoe')).toContain('cap 0');
});

test('clearing the number box ticks no cap, so the two controls cannot disagree', async () => {
  await page.locator('#cap-yoe').fill('');
  expect(await checked('#cap-yoe-nocap')).toBe(true);
  expect((await form()).yoeThreshold).toBeNull();
});

test('the number box stays editable while no cap is ticked — it is the way back', async () => {
  await page.locator('#cap-yoe-nocap').check();
  expect(await disabled('#cap-yoe')).toBe(false);
  await page.locator('#cap-yoe').fill('9');
  expect(await checked('#cap-yoe-nocap')).toBe(false);
  expect((await form()).yoeThreshold).toBe(9);
});

test('unticking no cap restores a real cap rather than leaving the rule half-on', async () => {
  await page.locator('#cap-yoe-nocap').check();
  await page.locator('#cap-yoe-nocap').uncheck();
  const c = await form();
  expect(c.yoeThreshold).not.toBeNull();
  expect(Number.isFinite(c.yoeThreshold)).toBe(true);
});

test('null round-trips through the PATCH body and back into the form', async () => {
  await page.locator('#cap-yoe-nocap').check();
  // Turning a cap OFF is widening, so it saves on one click.
  await page.locator('#criteriaSaveBtn').click();
  await expect.poll(() => patches.length, POLL).toBe(1);
  expect(patches[0].yoeThreshold).toBeNull();
  await page.waitForSelector('[data-jf-tokens="crit-seniority"] .jf-token');
  await expect.poll(() => checked('#cap-yoe-nocap'), POLL).toBe(true);
  expect((await form()).yoeThreshold).toBeNull();
});

test('turning a cap ON from no-cap is narrowing and asks for a second click', async () => {
  criteria.yoeThreshold = null;
  await page.evaluate(() => loadSettings());
  await page.waitForSelector('[data-jf-tokens="crit-seniority"] .jf-token');
  await page.locator('#cap-yoe').fill('5');
  expect(await armable()).toBe(true);
});
