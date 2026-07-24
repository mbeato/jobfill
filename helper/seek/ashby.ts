// Ashby public-board adapter. Per-token failures are collected, never thrown
// (D-03/D-05): fetchAshby runs a bounded worker pool over the token list and
// returns { postings, errors } — one bad board can no longer abort the rest
// of the sweep.

import type { NormalizedPosting } from './types';
import { runTokenPool, ATS_CONCURRENCY, type AtsFetchResult } from './ats-fetch';

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
  concurrency: number = ATS_CONCURRENCY,
): Promise<AtsFetchResult> {
  return runTokenPool(
    tokens,
    async (token) => {
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
      return (body.jobs ?? []).map((job) => normalizeAshbyJob(job, token));
    },
    concurrency,
  );
}
