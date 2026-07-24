// Shared bounded-concurrency worker pool for the ATS adapters (D-03/D-05).
// Written once here rather than duplicated in greenhouse.ts/lever.ts/ashby.ts.
// A per-token failure is recorded and the pool keeps going — no watchlist size
// cap (D-05), so this is the only rate control against each ATS host and must
// not be removed.

import type { NormalizedPosting } from './types';

export interface TokenFetchError {
  token: string;
  error: string;
}

export interface AtsFetchResult {
  postings: NormalizedPosting[];
  errors: TokenFetchError[];
}

// 6 keeps well under practical per-host connection limits while turning a
// 1000-token sequential sweep into a bounded pool (D-05).
export const ATS_CONCURRENCY = 6;

export async function runTokenPool(
  tokens: string[],
  perToken: (token: string) => Promise<NormalizedPosting[]>,
  concurrency: number = ATS_CONCURRENCY,
): Promise<AtsFetchResult> {
  const postings: NormalizedPosting[] = [];
  const errors: TokenFetchError[] = [];
  if (tokens.length === 0) return { postings, errors };

  let i = 0;
  async function worker() {
    while (i < tokens.length) {
      const token = tokens[i++];
      try {
        const result = await perToken(token);
        postings.push(...result);
      } catch (err) {
        // D-03: a worker never rethrows — one bad token is isolated to its own
        // recorded error and the pool moves on to the next token.
        errors.push({ token, error: String((err as Error)?.message ?? err) });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, tokens.length) }, () => worker()),
  );

  return { postings, errors };
}
