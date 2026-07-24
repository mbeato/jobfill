// Greenhouse public-board adapter. Per-token failures are collected, never
// thrown (D-03/D-05): fetchGreenhouse runs a bounded worker pool over the
// token list and returns { postings, errors } — one bad board can no longer
// abort the rest of the sweep.

import type { NormalizedPosting } from './types';
import { runTokenPool, ATS_CONCURRENCY, type AtsFetchResult } from './ats-fetch';

/**
 * Pure mapper: raw Greenhouse job -> NormalizedPosting. Never throws — a missing
 * nested field (e.g. absent location) falls back to '' (mirrors answers.ts's
 * defensive try/catch style).
 */
export function normalizeGreenhouseJob(raw: unknown, token: string): NormalizedPosting {
  const job = (raw ?? {}) as Record<string, any>;
  return {
    company: token,
    title: String(job.title ?? ''),
    location: String(job.location?.name ?? ''),
    url: String(job.absolute_url ?? ''),
    source: 'greenhouse',
    // D-07: Greenhouse's updated_at is a modification time, not a creation time —
    // never trusted for freshness filtering.
    posted_at: job.updated_at ?? null,
    posted_at_trusted: false,
    login_gated: false,
  };
}

export async function fetchGreenhouse(
  tokens: string[],
  fetchImpl: typeof fetch = fetch,
  concurrency: number = ATS_CONCURRENCY,
): Promise<AtsFetchResult> {
  return runTokenPool(
    tokens,
    async (token) => {
      const res = await fetchImpl(
        `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`,
      );
      if (!res.ok) {
        throw new Error(`fetchGreenhouse: ${token} returned HTTP ${res.status}`);
      }
      let body: { jobs?: unknown[] };
      try {
        body = (await res.json()) as { jobs?: unknown[] };
      } catch (err) {
        throw new Error(`fetchGreenhouse: ${token} returned unparseable JSON (${err})`);
      }
      return (body.jobs ?? []).map((job) => normalizeGreenhouseJob(job, token));
    },
    concurrency,
  );
}
