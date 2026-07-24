// Lever public-board adapter. Per-token failures are collected, never thrown
// (D-03/D-05): fetchLever runs a bounded worker pool over the token list and
// returns { postings, errors } — one bad board can no longer abort the rest
// of the sweep.

import type { NormalizedPosting } from './types';
import { runTokenPool, ATS_CONCURRENCY, type AtsFetchResult } from './ats-fetch';

/**
 * Pure mapper: raw Lever posting -> NormalizedPosting. Never throws — a missing
 * nested field (e.g. absent categories.location) falls back to '' (mirrors
 * answers.ts's defensive try/catch style).
 */
export function normalizeLeverPosting(raw: unknown, company: string): NormalizedPosting {
  const posting = (raw ?? {}) as Record<string, any>;
  const createdAt = posting.createdAt;
  return {
    company,
    title: String(posting.text ?? ''),
    location: String(posting.categories?.location ?? ''),
    url: String(posting.hostedUrl ?? ''),
    source: 'lever',
    // D-07: Lever's createdAt is a real posting-creation timestamp — trusted.
    posted_at: typeof createdAt === 'number' ? new Date(createdAt).toISOString() : null,
    posted_at_trusted: true,
    login_gated: false,
  };
}

export async function fetchLever(
  tokens: string[],
  fetchImpl: typeof fetch = fetch,
  concurrency: number = ATS_CONCURRENCY,
): Promise<AtsFetchResult> {
  return runTokenPool(
    tokens,
    async (company) => {
      const res = await fetchImpl(`https://api.lever.co/v0/postings/${company}?mode=json`);
      if (!res.ok) {
        throw new Error(`fetchLever: ${company} returned HTTP ${res.status}`);
      }
      let body: unknown[];
      try {
        const parsed = await res.json();
        body = Array.isArray(parsed) ? parsed : [];
      } catch (err) {
        throw new Error(`fetchLever: ${company} returned unparseable JSON (${err})`);
      }
      return body.map((raw) => normalizeLeverPosting(raw, company));
    },
    concurrency,
  );
}
