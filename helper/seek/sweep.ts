import type { Database } from 'bun:sqlite';
import type { NormalizedPosting, SeekConfig, SourceName } from './types';
import type { AtsFetchResult, TokenFetchError } from './ats-fetch';
import { harvestSimplifyBoards } from './simplify';
import { harvestGetroBoards } from './getro';
import { shouldRunYcDir } from './ycdir';
import { readSeekMeta, writeSeekMeta } from './meta';
import { backfillSeedBoards } from './boards';
import { seedCriteriaOnce } from './criteria';

// D-10 one-time gate key for the backdated seed backfill (see the prologue in
// runSweep below). Its own module-local constant, not shared with 'ycdir_last_run',
// because it gates a one-time migration rather than a periodic cadence.
const SEED_BACKFILL_KEY = 'seed_backfill_v1';

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
  // D-11/D-14: count of board rows this source's slug harvest added this
  // sweep. Only set when > 0, mirroring tokenErrors, so a source with no
  // harvest step (or nothing new to add) keeps the pre-phase result shape.
  boardsAdded?: number;
}

export interface SweepDeps {
  fetchGreenhouse: (tokens: string[]) => Promise<AtsFetchResult>;
  fetchLever: (tokens: string[]) => Promise<AtsFetchResult>;
  fetchAshby: (tokens: string[]) => Promise<AtsFetchResult>;
  fetchHNPostings: (opts?: { maxAgeDays?: number }) => Promise<NormalizedPosting[]>;
  fetchSimplify: () => Promise<NormalizedPosting[]>;
  fetchGetro: (
    networks: { name: string; id: string; host?: string }[],
  ) => Promise<{ postings: NormalizedPosting[]; errors: { network: string; error: string }[] }>;
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
  // D-17/D-19: slug-only harvest, no postings. `args.db`/`args.blocklist` are
  // the only pieces ycdir.ts's real harvestYcDirectory needs beyond its own
  // fetch/upsertBoard wiring, which the caller building the real deps object
  // (plan 16-09) closes over.
  harvestYcDirectory: (args: {
    db: Database;
    blocklist: string[];
  }) => Promise<{ companies: number; probed: number; added: number; errors: unknown[] }>;
}

export async function runSweep(
  db: Database,
  config: SeekConfig,
  deps: SweepDeps,
  now: Date = new Date(),
): Promise<SourceResult[]> {
  const results: SourceResult[] = [];

  // Seed sync prologue — keeps "in seek.config.json" and "in boards" the same
  // set, permanently, and MUST run before the first deps.resolveEffectiveTokens
  // call below. That ordering is structural, not incidental: it is what
  // guarantees the D-10 backdated backfill can never race an ordinary sync that
  // would stamp a config token with datetime('now').
  //
  // (1) D-06: this runs on EVERY sweep, not as a one-time migration — a token
  //     the operator hand-adds to seek.config.json tomorrow automatically gets
  //     first_seen_at = datetime('now') and correctly enters grace, no special
  //     case needed.
  // (2) D-10: the FIRST pass instead backdates via the one-time backfill call
  //     below, because stamping the 286 already-established config tokens
  //     with datetime('now')
  //     would place every already-staged posting inside the 48h grace delta and
  //     mass-suppress the entire next sweep.
  // (3) Ordering requirement: the backfill must precede any ordinary sync,
  //     which is exactly why both live here, adjacent, rather than split
  //     across files.
  // (4) D-06 accepted consequence: removing a token from seek.config.json no
  //     longer removes it from polling, because its row persists in `boards`
  //     and resolveEffectiveTokens unions active board rows; the blocklist
  //     remains the single removal mechanism (Phase 16 D-06). Do not invent a
  //     second removal path.
  //
  // D-05 side benefit, and its precise limit: seed tokens now have rows, so
  // recordBoardResult records their outcomes and a permanently-404ing seed
  // entry becomes dead-markable and visible. It does NOT stop being polled,
  // because resolveEffectiveTokens adds config tokens unconditionally before
  // it unions active boards — removal still requires a config or blocklist edit.
  //
  // D-13: the criteria seed must precede anything that reads criteria, so it
  // runs first in this same prologue, before the board seed sync below.
  // runSweepJob calls runSweep before runFilterPromote, so this placement is
  // what makes the first post-deploy sweep read the operator's values rather than the
  // D-14 generic defaults.
  try {
    // Reuses this try/catch rather than adding a second one — a seed failure
    // must not fail the sweep; the gate's own one-time key handles retry.
    seedCriteriaOnce(db);

    const tokenMap: Record<string, string[]> = {
      greenhouse: config.greenhouse.tokens,
      lever: config.lever.tokens,
      ashby: config.ashby.tokens,
    };
    if (readSeekMeta(db, SEED_BACKFILL_KEY) === null) {
      backfillSeedBoards(db, tokenMap, config.blocklist);
      // Written only on success — a thrown backfill retries on the next
      // sweep instead of burning the one-time window (mirrors the ycdir
      // gate's "written only on success" posture below).
      writeSeekMeta(db, SEED_BACKFILL_KEY, new Date().toISOString());
    } else {
      for (const [ats, tokens] of Object.entries(tokenMap)) {
        for (const token of tokens) {
          deps.upsertBoard(db, { ats, token, source_of_discovery: 'seed' }, config.blocklist);
        }
      }
    }
  } catch {
    // Sync failure degrades silently, matching the harvest loop's posture —
    // never fails a sweep or marks a source failed.
  }

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
    // D-11/D-14: when set, run over the fetched postings to derive
    // {ats, token} slug candidates and write each into `boards`. Its own
    // inner try/catch means a harvest failure degrades to "postings still
    // upserted, no slugs added," never to a failed source.
    harvest?: (postings: NormalizedPosting[]) => { ats: string; token: string }[],
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
      if (harvest) {
        try {
          let boardsAdded = 0;
          for (const b of harvest(postings)) {
            if (deps.upsertBoard(db, { ats: b.ats, token: b.token, source_of_discovery: source }, config.blocklist) != null) {
              boardsAdded++;
            }
          }
          if (boardsAdded > 0) result.boardsAdded = boardsAdded;
        } catch {
          // Harvest failure degrades silently — the postings above are
          // already upserted; no slugs added this sweep.
        }
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

  // D-11: SimplifyJobs is both a posting source and a slug harvester.
  await runOne(
    'simplify',
    config.simplify.enabled,
    () => deps.fetchSimplify(),
    undefined,
    postings => harvestSimplifyBoards(postings),
  );

  // D-14: Getro networks are both a posting source and a slug harvester.
  // fetchGetro's errors are keyed by `network`, not `token` — remapped at
  // this boundary so runOne's tokenErrors/sampleTokenErrors stay one shape.
  await runOne(
    'getro',
    config.getro.enabled,
    async () => {
      const { postings, errors } = await deps.fetchGetro(config.getro.networks);
      return { postings, errors: errors.map(e => ({ token: e.network, error: e.error })) };
    },
    undefined,
    postings => harvestGetroBoards(postings),
  );

  // D-17/D-19: ycdir produces board slugs only, never postings, so it does
  // NOT go through runOne's upsertPosting loop. The weekly gate is ticked
  // inside this existing sweep — no new scheduler, no new launchd job.
  if (config.ycdir.enabled) {
    const lastRun = readSeekMeta(db, 'ycdir_last_run');
    if (shouldRunYcDir(now, lastRun)) {
      try {
        const harvest = await deps.harvestYcDirectory({ db, blocklist: config.blocklist });
        // Written only on success — a failed run retries next sweep instead
        // of burning the week.
        writeSeekMeta(db, 'ycdir_last_run', now.toISOString());
        const result: SourceResult = { source: 'ycdir', fetched: 0 };
        if (harvest.added > 0) result.boardsAdded = harvest.added;
        if (harvest.errors.length > 0) result.tokenErrors = harvest.errors.length;
        results.push(result);
      } catch (err) {
        results.push({ source: 'ycdir', fetched: 0, error: String((err as Error)?.message ?? err) });
      }
    }
  }

  return results;
}
