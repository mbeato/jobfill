import type { Database } from 'bun:sqlite';
import type { NormalizedPosting, SeekConfig, SourceName } from './types';

// Testable fetch-sweep orchestrator behind POST /seek (D-11). Per-source
// isolation (D-13): each of the four fetch sources runs in its OWN try/catch,
// never a single try/catch around the whole loop — one bad board/API must
// never abort the rest of the sweep. `deps` is dependency-injected so the
// unit test can pass stubs (mirrors the ats-adapters.test.ts stub-fetch
// convention); the route passes the real fetch* implementations.

export interface SourceResult {
  source: SourceName;
  fetched: number;
  upserted?: number;
  error?: string;
}

export interface SweepDeps {
  fetchGreenhouse: (tokens: string[]) => Promise<NormalizedPosting[]>;
  fetchLever: (tokens: string[]) => Promise<NormalizedPosting[]>;
  fetchAshby: (tokens: string[]) => Promise<NormalizedPosting[]>;
  fetchHNPostings: (opts?: { maxAgeDays?: number }) => Promise<NormalizedPosting[]>;
  upsertPosting: (db: Database, p: NormalizedPosting) => unknown;
}

export async function runSweep(db: Database, config: SeekConfig, deps: SweepDeps): Promise<SourceResult[]> {
  const results: SourceResult[] = [];

  const runOne = async (source: SourceName, enabled: boolean, fetcher: () => Promise<NormalizedPosting[]>) => {
    if (!enabled) return;
    try {
      const postings = await fetcher();
      let upserted = 0;
      for (const p of postings) {
        if (deps.upsertPosting(db, p)) upserted++;
      }
      results.push({ source, fetched: postings.length, upserted });
    } catch (err) {
      results.push({ source, fetched: 0, error: String((err as Error)?.message ?? err) });
    }
  };

  await runOne('greenhouse', config.greenhouse.enabled, () => deps.fetchGreenhouse(config.greenhouse.tokens));
  await runOne('lever', config.lever.enabled, () => deps.fetchLever(config.lever.tokens));
  await runOne('ashby', config.ashby.enabled, () => deps.fetchAshby(config.ashby.tokens));
  await runOne('hn', config.hn.enabled, () => deps.fetchHNPostings());

  return results;
}
