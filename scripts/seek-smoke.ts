// One-shot LIVE reachability check for the three external discovery sources
// this phase adds (SimplifyJobs, Getro, the YC batch directory). Run by hand:
//
//   bun scripts/seek-smoke.ts
//
// This is NOT part of `bun test helper` and is never run per sweep — the
// sweep itself is the ongoing live check under Phase 9's per-source
// isolation (a dead source there fails open, recorded, and the sweep keeps
// going). This script exists because a fully-mocked test suite stays green
// while an upstream endpoint moves or its schema drifts — fixtures prove the
// mapper, not the upstream. Manual, developer-invoked, no egress from the
// sweep/scheduler/batch path is affected by it either way (T-16-19).
//
// URLs are imported from the adapter modules, never re-declared here, so a
// URL change in the real adapter can't silently diverge from what this
// script checks (16-PATTERNS.md / plan 16-09 Task 3).

import { SIMPLIFY_URL } from '../helper/seek/simplify';
import { getroHost, parseNextData } from '../helper/seek/getro';
import { YC_API_URL } from '../helper/seek/ycdir';
import { loadSeekConfig } from '../helper/seek/config';

let anyFailed = false;

function pass(line: string) {
  console.log(`PASS ${line}`);
}

function fail(line: string) {
  console.log(`FAIL ${line}`);
  anyFailed = true;
}

async function checkSimplify(): Promise<void> {
  try {
    const res = await fetch(SIMPLIFY_URL);
    if (!res.ok) {
      fail(`SimplifyJobs — HTTP ${res.status} from ${SIMPLIFY_URL}`);
      return;
    }
    const entries = await res.json();
    if (!Array.isArray(entries)) {
      fail(`SimplifyJobs — response body is not an array`);
      return;
    }
    const activeVisible = entries.filter(
      (e) => (e as Record<string, unknown>)?.active === true && (e as Record<string, unknown>)?.is_visible === true,
    ).length;
    pass(`SimplifyJobs — ${entries.length} total entries, ${activeVisible} active+visible`);
  } catch (err) {
    fail(`SimplifyJobs — ${String((err as Error)?.message ?? err)}`);
  }
}

async function checkGetro(networks: { name: string; id: string; host?: string }[]): Promise<void> {
  if (networks.length === 0) {
    console.log('SKIP Getro — no networks configured in seek.config.json');
    return;
  }
  for (const network of networks) {
    const host = getroHost(network);
    try {
      const res = await fetch(`https://${host}/jobs`);
      if (!res.ok) {
        fail(`Getro ${host} — HTTP ${res.status}`);
        continue;
      }
      const html = await res.text();
      const data = parseNextData(html);
      const jobs = data?.props?.pageProps?.initialState?.jobs;
      if (!jobs || typeof jobs !== 'object') {
        fail(`Getro ${host} — no props.pageProps.initialState.jobs in __NEXT_DATA__`);
        continue;
      }
      pass(`Getro ${host} — reported job total ${jobs.total ?? '(unknown)'}`);
    } catch (err) {
      fail(`Getro ${host} — ${String((err as Error)?.message ?? err)}`);
    }
  }
}

async function checkYcDir(): Promise<void> {
  try {
    const res = await fetch(YC_API_URL);
    if (!res.ok) {
      fail(`YC directory — HTTP ${res.status} from ${YC_API_URL}`);
      return;
    }
    const body = (await res.json()) as { companies?: unknown[] };
    if (!Array.isArray(body.companies) || body.companies.length === 0) {
      fail(`YC directory — companies array missing or empty`);
      return;
    }
    const batches = new Set<string>();
    for (const c of body.companies) {
      const batch = String((c as Record<string, unknown> | null)?.batch ?? '').trim();
      if (batch) batches.add(batch);
    }
    pass(`YC directory — page 1 batch codes: ${[...batches].join(', ') || '(none found)'}`);
  } catch (err) {
    fail(`YC directory — ${String((err as Error)?.message ?? err)}`);
  }
}

const config = await loadSeekConfig();
await checkSimplify();
await checkGetro(config.getro.networks);
await checkYcDir();

if (anyFailed) {
  console.log('seek-smoke: one or more checks failed — see FAIL lines above');
  process.exit(1);
}
console.log('seek-smoke: all checks passed');
