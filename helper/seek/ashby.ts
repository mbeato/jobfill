// Ashby public-board adapter. Mirrors mapViaCLI's throw-on-failure contract
// (helper/mapping.ts): fetchAshby throws a descriptive Error on non-2xx or
// parse failure — the /seek route (Plan 04) catches per-source so one bad board
// never taints the sweep (D-13).

import type { NormalizedPosting } from './types';

/**
 * Pure mapper: raw Ashby job -> NormalizedPosting. Never throws — a missing
 * nested field (e.g. absent location) falls back to '' (mirrors answers.ts's
 * defensive try/catch style).
 */
export function normalizeAshbyJob(raw: unknown, token: string): NormalizedPosting {
  const job = (raw ?? {}) as Record<string, any>;
  return {
    company: token,
    title: String(job.title ?? ''),
    location: String(job.location ?? ''),
    url: String(job.jobUrl ?? ''),
    source: 'ashby',
    // D-07: Ashby's publishedAt is a genuine publish timestamp — trusted.
    posted_at: job.publishedAt ?? null,
    posted_at_trusted: true,
    login_gated: false,
  };
}

export async function fetchAshby(
  tokens: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<NormalizedPosting[]> {
  const postings: NormalizedPosting[] = [];
  for (const token of tokens) {
    const res = await fetchImpl(`https://api.ashbyhq.com/posting-api/job-board/${token}`);
    if (!res.ok) {
      throw new Error(`fetchAshby: ${token} returned HTTP ${res.status}`);
    }
    let body: { jobs?: unknown[] };
    try {
      body = (await res.json()) as { jobs?: unknown[] };
    } catch (err) {
      throw new Error(`fetchAshby: ${token} returned unparseable JSON (${err})`);
    }
    for (const job of body.jobs ?? []) {
      postings.push(normalizeAshbyJob(job, token));
    }
  }
  return postings;
}
