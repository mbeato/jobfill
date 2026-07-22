// Playwright sidecar for the two login-gated discovery sources: YC Work at a
// Startup and Jobright (docs/runner-protocol.md / .planning 09-CONTEXT D-04,
// D-10). Reuses the runner's persistent Chromium profile (.runner-profile) so
// the operator's one-time YC/Jobright logins persist across runs — see
// scripts/runner.mjs for the profile pattern this sidecar copies (that file
// is NOT modified). Both sources are best-effort and fail-open (D-13): a
// broken scrape of one source is logged and skipped, never crashing the
// process or blocking the other source.
//
// Every posting this sidecar emits is flagged `login_gated: true` (SEEK-03) —
// this is the flag Phase 12 batch fill reads to skip these sources entirely.
//
// Usage: node scripts/seek-sidecar.mjs [--source yc|jobright]
// With no --source flag, runs whichever of yc/jobright is enabled in
// seek.config.json (repo root, read fresh on every run — SEEK-05).

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = 'http://127.0.0.1:7877';
const TOKEN = 'REDACTED-TOKEN';
const PROFILE_DIR = join(ROOT, '.runner-profile');

const args = process.argv.slice(2);
const sourceFlag = args.indexOf('--source');
let onlySource = null;
if (sourceFlag !== -1) {
  onlySource = args[sourceFlag + 1];
  if (!onlySource || !['yc', 'jobright'].includes(onlySource)) {
    console.error('usage: node scripts/seek-sidecar.mjs [--source yc|jobright]');
    process.exit(1);
  }
}

// Fresh read, no caching (SEEK-05) — mirrors helper/seek/config.ts's
// fail-open default: a missing/malformed config never crashes the sidecar,
// it just runs nothing.
function loadGatedConfig() {
  try {
    const parsed = JSON.parse(readFileSync(join(ROOT, 'seek.config.json'), 'utf8'));
    return {
      yc: Boolean(parsed?.yc?.enabled),
      jobright: Boolean(parsed?.jobright?.enabled),
    };
  } catch {
    return { yc: false, jobright: false };
  }
}

const config = loadGatedConfig();
const toRun = ['yc', 'jobright'].filter((s) => (onlySource ? s === onlySource : config[s]));

if (toRun.length === 0) {
  console.log('[seek-sidecar] no login-gated sources enabled — exiting');
  process.exit(0);
}

// Best-effort DOM extraction (D-04): workatastartup.com and jobright.ai have
// no public API and no stable contract — selectors are fragile by design and
// are expected to need live-DOM tuning (see 09-05 checkpoint). Zero listings
// found is not an error; it just posts an empty array.
async function scrapeYC(page) {
  await page.goto('https://www.workatastartup.com/companies', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const raw = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/companies/"]'));
    return anchors.map((a) => {
      const container = a.closest('[class*="company"]') || a.parentElement || a;
      const lines = (container.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
      return {
        url: a.href,
        company: lines[0] || '',
        title: lines[1] || '',
        location: lines.find((l) => /,\s*[A-Z]{2}\b/.test(l)) || lines[2] || '',
      };
    });
  });
  const seen = new Set();
  const postings = [];
  for (const r of raw) {
    if (!r.url || !r.company || seen.has(r.url)) continue;
    seen.add(r.url);
    postings.push({
      company: r.company.slice(0, 200),
      title: (r.title || 'Unknown role').slice(0, 200),
      location: (r.location || '').slice(0, 200),
      url: r.url,
      source: 'yc',
      posted_at: null,
      posted_at_trusted: false,
      login_gated: true,
      not_fillable: false,
    });
  }
  return postings;
}

async function scrapeJobright(page) {
  await page.goto('https://jobright.ai/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const raw = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/jobs/"], a[href*="/job/"]'));
    return anchors.map((a) => {
      const container = a.closest('[class*="job"]') || a.parentElement || a;
      const lines = (container.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
      return {
        url: a.href,
        title: lines[0] || '',
        company: lines[1] || '',
        location: lines.find((l) => /,\s*[A-Z]{2}\b/.test(l)) || lines[2] || '',
      };
    });
  });
  const seen = new Set();
  const postings = [];
  for (const r of raw) {
    if (!r.url || !r.title || seen.has(r.url)) continue;
    seen.add(r.url);
    postings.push({
      company: (r.company || 'Unknown').slice(0, 200),
      title: r.title.slice(0, 200),
      location: (r.location || '').slice(0, 200),
      url: r.url,
      source: 'jobright',
      posted_at: null,
      posted_at_trusted: false,
      login_gated: true,
      not_fillable: false,
    });
  }
  return postings;
}

async function postToHelper(source, postings) {
  const res = await fetch(`${HELPER}/seek/results`, {
    method: 'POST',
    headers: { 'x-jobfill-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ source, postings }),
  });
  if (!res.ok) throw new Error(`POST /seek/results HTTP ${res.status}`);
  console.log(`[seek-sidecar] ${source}: scraped ${postings.length}, posted`);
}

let ctx;
try {
  ctx = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false });

  // Each source is fully isolated (D-13): a throw anywhere in one source's
  // scrape-or-post path is logged and skipped, the other source still runs.
  if (toRun.includes('yc')) {
    try {
      const page = await ctx.newPage();
      const postings = await scrapeYC(page);
      await page.close();
      await postToHelper('yc', postings);
    } catch (e) {
      console.log(`[seek-sidecar] yc: scrape failed (${e.message}) — continuing`);
    }
  }

  if (toRun.includes('jobright')) {
    try {
      const page = await ctx.newPage();
      const postings = await scrapeJobright(page);
      await page.close();
      await postToHelper('jobright', postings);
    } catch (e) {
      console.log(`[seek-sidecar] jobright: scrape failed (${e.message}) — continuing`);
    }
  }
} finally {
  if (ctx) await ctx.close();
}

console.log('[seek-sidecar] done');
