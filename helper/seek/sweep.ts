import type { Database } from 'bun:sqlite';
import type { NormalizedPosting, SeekConfig, SourceName } from './types';
import type { AtsFetchResult, TokenFetchError } from './ats-fetch';

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
  // D-03: count of per-token failures within this source (e.g. dead boards
  // among the ATS token list). Only set when > 0 so an all-healthy sweep's
  // result shape is unchanged. This is what makes a dead auto-added board
  // visible instead of silent (D-04 depends on the operator being able to see it).
  tokenErrors?: number;
  // First 5 entries only — the whole array is serialized into the `sweeps`
  // detail JSON and a 1000-board watchlist would otherwise write a
  // multi-megabyte blob.
  sampleTokenErrors?: TokenFetchError[];
}

export interface SweepDeps {
  fetchGreenhouse: (tokens: string[]) => Promise<AtsFetchResult>;
  fetchLever: (tokens: string[]) => Promise<AtsFetchResult>;
  fetchAshby: (tokens: string[]) => Promise<AtsFetchResult>;
  fetchHNPostings: (opts?: { maxAgeDays?: number }) => Promise<NormalizedPosting[]>;
  upsertPosting: (db: Database, p: NormalizedPosting) => unknown;
  // D-01/D-04 board lifecycle, injected so runSweep stays unit-testable
  // against a stub boards implementation (mirrors upsertPosting above).
  upsertBoard: (
    db: Database,
    input: { ats: string; token: string; source_of_discovery: string },
    blocklist?: string[],
  ) => unknown;
  recordBoardResult: (db: Database, ats: string, token: string, ok: boolean) => void;
  resolveEffectiveTokens: (db: Database, ats: string, configTokens: string[], blocklist?: string[]) => string[];
}

export async function runSweep(db: Database, config: SeekConfig, deps: SweepDeps): Promise<SourceResult[]> {
  const results: SourceResult[] = [];

  const runOne = async (
    source: SourceName,
    enabled: boolean,
    fetcher: () => Promise<NormalizedPosting[] | AtsFetchResult>,
    // D-04: when set, every token in this list gets its outcome recorded
    // against the boards lifecycle once the fetch succeeds. Recording lives
    // inside this same try/catch so a recording failure can't abort the
    // sweep, and a whole-source throw (caught below) skips recording
    // entirely rather than marking every board dead over one outage.
    tokens?: string[],
  ) => {
    if (!enabled) return;
    try {
      const raw = await fetcher();
      const { postings, errors } = Array.isArray(raw) ? { postings: raw, errors: [] as TokenFetchError[] } : raw;
      let upserted = 0;
      for (const p of postings) {
        if (deps.upsertPosting(db, p)) upserted++;
      }
      if (tokens) {
        const failed = new Set(errors.map(e => e.token));
        for (const token of tokens) {
          deps.recordBoardResult(db, source, token, !failed.has(token));
        }
      }
      const result: SourceResult = { source, fetched: postings.length, upserted };
      if (errors.length > 0) {
        result.tokenErrors = errors.length;
        result.sampleTokenErrors = errors.slice(0, 5);
      }
      results.push(result);
    } catch (err) {
      results.push({ source, fetched: 0, error: String((err as Error)?.message ?? err) });
    }
  };

  // D-01: effective token list = config tokens ∪ active boards − blocklist,
  // resolved fresh immediately before each fetcher call so a slug harvested
  // this morning is polled tonight with no restart.
  const ghTokens = deps.resolveEffectiveTokens(db, 'greenhouse', config.greenhouse.tokens, config.blocklist);
  await runOne('greenhouse', config.greenhouse.enabled, () => deps.fetchGreenhouse(ghTokens), ghTokens);

  const leverTokens = deps.resolveEffectiveTokens(db, 'lever', config.lever.tokens, config.blocklist);
  await runOne('lever', config.lever.enabled, () => deps.fetchLever(leverTokens), leverTokens);

  const ashbyTokens = deps.resolveEffectiveTokens(db, 'ashby', config.ashby.tokens, config.blocklist);
  await runOne('ashby', config.ashby.enabled, () => deps.fetchAshby(ashbyTokens), ashbyTokens);

  await runOne('hn', config.hn.enabled, () => deps.fetchHNPostings());

  return results;
}
