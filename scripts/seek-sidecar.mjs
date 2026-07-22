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
//
// First-time login: node scripts/seek-sidecar.mjs --login
// Opens both YC Work at a Startup and Jobright in the headed persistent
// profile and waits (no timeout) for the operator to log into both, then press Enter
// in this terminal to finish. This mode never scrapes or POSTs — it only
// persists the login session into .runner-profile.

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = 'http://127.0.0.1:7877';
const TOKEN = process.env.JOBFILL_TOKEN ?? 'REDACTED-TOKEN';
const PROFILE_DIR = join(ROOT, '.runner-profile');

const args = process.argv.slice(2);
const loginMode = args.includes('--login');
const sourceFlag = args.indexOf('--source');
let onlySource = null;
if (sourceFlag !== -1) {
  onlySource = args[sourceFlag + 1];
  if (!onlySource || !['yc', 'jobright'].includes(onlySource)) {
    console.error('usage: node scripts/seek-sidecar.mjs [--source yc|jobright]');
    process.exit(1);
  }
}

// --login: first-time auth only. Opens both sites in the headed persistent
// profile and waits indefinitely for the operator to log in — it never scrapes or
// POSTs (that would run right now, logged-out, and just close on him mid-login,
// which is the exact bug this mode fixes). Session persists via the profile
// dir itself; closing the context flushes it before exit.
if (loginMode) {
  const loginCtx = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false });
  await (await loginCtx.newPage()).goto('https://www.workatastartup.com', { waitUntil: 'domcontentloaded' });
  await (await loginCtx.newPage()).goto('https://jobright.ai/', { waitUntil: 'domcontentloaded' });
  console.log('[seek-sidecar] log into both YC Work at a Startup and Jobright in the windows that just opened.');
  console.log('[seek-sidecar] once logged into both, come back here and press Enter to finish.');
  await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', resolve);
  });
  await loginCtx.close();
  console.log('[seek-sidecar] session saved to .runner-profile — done');
  process.exit(0);
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
// no public API and no stable contract — selectors were live-DOM-tuned
// 2026-07-22 (the 09-05 checkpoint's anticipated tuning pass). Zero listings
// found is not an error; it just posts an empty array.
//
// YC: /jobs lists role cards. The job anchor's own text is the title; the
// enclosing card also carries a /companies/ anchor whose text is
// "Company (Batch)•tagline"; the meta line starts with the employment type
// and mashes location + role category together — good enough location signal
// for the rules/LLM without further splitting.
async function scrapeYC(page) {
  await page.goto('https://www.workatastartup.com/jobs', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const raw = await page.evaluate(() => {
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/jobs/"]')) {
      if (!/\/jobs\/\d+/.test(a.href) || seen.has(a.href)) continue;
      const title = (a.innerText || '').trim();
      if (!title) continue;
      let node = a.parentElement;
      let card = null;
      for (let i = 0; i < 8 && node; i++) {
        if (node.querySelector('a[href*="/companies/"]')) {
          card = node;
          break;
        }
        node = node.parentElement;
      }
      const companyRaw = card ? (card.querySelector('a[href*="/companies/"]').innerText || '') : '';
      const company = companyRaw
        .split('•')[0]
        .replace(/\s*\([^)]*\)\s*$/, '')
        .trim();
      const lines = card ? (card.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean) : [];
      const metaLine = lines.find((l) => /^(full-?time|contract|internship|intern|part-?time)/i.test(l)) || '';
      const location = metaLine.replace(/^(full-?time|contract|internship|intern|part-?time)/i, '').trim();
      seen.add(a.href);
      out.push({ url: a.href, company, title, location });
    }
    return out;
  });
  const postings = [];
  for (const r of raw) {
    if (!r.url || !r.company) continue;
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

// Jobright: /jobs/recommend cards (`a[href*="/jobs/info"]`, closest
// [class*="job-card"]). Card text is a line stack: a noise header ("6 hours
// ago", alumni, early-applicant), then title, company, industry, geo
// ("San Mateo, CA"), employment type, salary, work mode, level. The "N
// <unit>s ago" line is a source timestamp — parsed into posted_at with
// posted_at_trusted so the D-01 freshness rule applies to Jobright.
function parseAgo(agoLine, now) {
  const m = /(\d+)\s*(minute|hour|day|week)s?\s+ago/i.exec(agoLine || '');
  if (!m) return null;
  const unitMs = { minute: 60e3, hour: 3600e3, day: 86400e3, week: 604800e3 }[m[2].toLowerCase()];
  return new Date(now - parseInt(m[1], 10) * unitMs).toISOString();
}

async function scrapeJobright(page) {
  await page.goto('https://jobright.ai/jobs/recommend', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  const raw = await page.evaluate(() => {
    const NOISE = [
      /\bago$/i,
      /alumni/i,
      /early applicant/i,
      /^good match$/i,
      /^\d+%$/,
      /^\/$/,
      /^why this job/i,
      /^no h1b$/i,
      /^growth opportunities$/i,
    ];
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/jobs/info"]')) {
      if (!a.href || seen.has(a.href)) continue;
      seen.add(a.href);
      const card = a.closest('[class*="job-card"]') || a.parentElement || a;
      const allLines = (card.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
      const agoLine = allLines.find((l) => /\bago$/i.test(l)) || '';
      const lines = allLines.filter((l) => !NOISE.some((re) => re.test(l)));
      out.push({
        url: a.href,
        title: lines[0] || '',
        company: lines[1] || '',
        location:
          lines.find((l) => /,\s*[A-Z]{2}\b/.test(l)) ||
          lines.find((l) => /\b(remote|united states)\b/i.test(l)) ||
          '',
        agoLine,
      });
    }
    return out;
  });
  const now = Date.now();
  const postings = [];
  for (const r of raw) {
    if (!r.url || !r.title) continue;
    const postedAt = parseAgo(r.agoLine, now);
    postings.push({
      company: (r.company || 'Unknown').slice(0, 200),
      title: r.title.slice(0, 200),
      location: (r.location || '').slice(0, 200),
      url: r.url,
      source: 'jobright',
      posted_at: postedAt,
      posted_at_trusted: postedAt !== null,
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

// --headless: scrape without opening windows (login must already be saved).
const headless = args.includes('--headless');

let ctx;
try {
  ctx = await chromium.launchPersistentContext(PROFILE_DIR, { headless });

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
