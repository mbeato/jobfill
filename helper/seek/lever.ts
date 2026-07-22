// Lever public-board adapter. Mirrors mapViaCLI's throw-on-failure contract
// (helper/mapping.ts): fetchLever throws a descriptive Error on non-2xx or
// parse failure — the /seek route (Plan 04) catches per-source so one bad board
// never taints the sweep (D-13).

import type { NormalizedPosting } from './types';

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
): Promise<NormalizedPosting[]> {
  const postings: NormalizedPosting[] = [];
  for (const company of tokens) {
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
    for (const raw of body) {
      postings.push(normalizeLeverPosting(raw, company));
    }
  }
  return postings;
}
