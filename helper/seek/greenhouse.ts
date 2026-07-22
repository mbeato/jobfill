// Greenhouse public-board adapter. Mirrors mapViaCLI's throw-on-failure contract
// (helper/mapping.ts): fetchGreenhouse throws a descriptive Error on non-2xx or
// parse failure — the /seek route (Plan 04) catches per-source so one bad board
// never taints the sweep (D-13).

import type { NormalizedPosting } from './types';

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
): Promise<NormalizedPosting[]> {
  const postings: NormalizedPosting[] = [];
  for (const token of tokens) {
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
    for (const job of body.jobs ?? []) {
      postings.push(normalizeGreenhouseJob(job, token));
    }
  }
  return postings;
}
