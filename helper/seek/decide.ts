import type { Database } from 'bun:sqlite';
import type { PostingRow } from './postings';
import type { QueueRow } from '../queue';
import type { BoardRow } from './boards';
import type { CompiledCriteria } from './criteria';
import { JD_FETCHABLE_SOURCES } from './jd-fetch';

// The filter -> promote orchestrator (D-01 two-stage, D-08 held, D-12 cap,
// D-14 finality). Walks the to-decide backlog (source-interleaved, per
// listPostingsToDecide's own query-enforced finality) through cheap metadata
// rules first, then — for survivors, gated by LLM_CAP — JD fetch, the YOE
// rule, and the LLM relevance pass. Mirrors sweep.ts's runOne per-item
// isolation, but split into two targeted try/catch blocks so a thrown
// posting can be attributed to the exact async stage that failed (D-08:
// held is a distinct, stricter state than the fill-flow's fail-open — a
// held posting is NEVER promoted).
//
// D-04 (Phase 20): the walk is a bounded worker pool sized by
// DECIDE_CONCURRENCY(), not a serial for loop — cheap rules still run for
// the whole backlog per 17-D-04, and the pool bound is also the JD-fetch
// bound (D-05). Per-posting verdicts are unchanged (each still depends only
// on the posting, the criteria snapshot, the board map and the profile),
// but WHICH postings win the last few cap slots now depends on completion
// order, so FilterCounts stops being reproducible run-to-run once the cap
// binds — bit-identity is not claimed (D-08's accepted consequence).

// Read fresh on every call (not frozen at import) so a sweep-to-sweep env
// change — or a test setting process.env.SEEK_LLM_CAP before calling — takes
// effect without a process restart, mirroring config.ts's fresh-read style.
// WR-02: fail closed (not open) on a misconfigured env var — a non-numeric
// SEEK_LLM_CAP (e.g. a typo) must fall back to the safe default, not silently
// become NaN (every `>= NaN` comparison is false, so the cap would never trip).
//
// D-16/D-17/D-18 (Phase 20 plan 05): raised from 100 to 800, backed by a real
// measured sweep at SEEK_DECIDE_CONCURRENCY=8 against a copy of the live
// jobfill.db (2026-07-26) — not derived from arithmetic (D-17). That sweep
// made 189 real scoreRelevance calls in 127.6s of decide-stage wall clock:
// 0.675s effective seconds per scored posting once concurrency-8 parallelism
// is accounted for, projecting to ~540s (9 min) decide wall clock at this
// cap, ~630s (10.5 min) total including the ~90s fetch stage — comfortably
// inside the unattended 07:00 scheduling window, which has no hard deadline
// and 3 retry attempts. The same sweep fully drained the day's real backlog
// (328 postings claimed a cap slot; 0 left unscored), so 800 carries ~2.4x
// headroom over that measured steady-state survivor count. D-16: the budget
// stays a call count, not a wall-clock budget — a count is what keeps this
// function's own reader tests and the cap-never-exceeded invariant
// (decide.test.ts's D-09 checks) assertable; a wall-clock budget would make
// every test time-dependent and every sweep irreproducible. Consequence
// (D-18): once a sweep's survivors fit under 800, `unscored` stops being the
// normal condition and becomes a signal that something is wrong.
export function LLM_CAP(): number {
  const n = Number(process.env.SEEK_LLM_CAP ?? 800);
  return Number.isFinite(n) && n >= 0 ? n : 800;
}

// D-06: read fresh on every call (not frozen at import), mirroring LLM_CAP()
// above, so a test can set the env var without a process restart. Fail
// closed (WR-02) to the default 8 on any non-finite value. The guard here is
// `>= 1`, not LLM_CAP's `>= 0`: a cap of 0 is a meaningful configuration
// (score nothing), but a concurrency of 0 spawns zero workers and would
// silently no-op the entire decide stage — the exact failure class WR-02
// exists to prevent. No upper clamp, for the same reason SEEK_LLM_CAP has
// none: this is operator-tuning env config at the operator's own trust
// level, and clamping it would defeat the "find the real ceiling by turning
// a knob on a live sweep" purpose it exists for.
//
// A separate constant from ats-fetch.ts's ATS_CONCURRENCY = 6 (D-06): that
// one is politeness toward HTTP hosts, this one is staying under the
// Anthropic subscription's rate limit — conflating them would make tuning
// either silently move the other. Default 8, not the handoff's 8-12 upper
// end: that measurement used trivial prompts, and a real relevance call
// carries the full profile plus a JD bounded at 12,000 chars, so
// token-per-minute limits may bind where the trivial-prompt test could not
// see them — the env override is how the real ceiling gets found on a live
// sweep.
export function DECIDE_CONCURRENCY(): number {
  const n = Number(process.env.SEEK_DECIDE_CONCURRENCY ?? 8);
  return Number.isFinite(n) && n >= 1 ? n : 8;
}

// D-19: a run of consecutive failures with no success between them trips the
// breaker (see the claim helper inside runFilterPromote for the full
// reasoning).
//
// WR-01 (Phase 20 review): this counts 5 *waves*, not 5 calls — the effective
// threshold is BREAKER_THRESHOLD * DECIDE_CONCURRENCY(), derived once per
// sweep in runFilterPromote's prologue. Under the serial loop each failure was
// its own data point: five attempts were issued one after another, each
// observed to fail before the next went out. Under an N-worker pool up to N
// calls are in flight at once and no success can possibly interleave among
// them, so a single transient event — a rate-limit burst, or a wave of the 60s
// relevance.ts timeouts expiring together — registers as N consecutive
// failures and would trip the latched breaker on its first wave, abandoning
// the rest of the budget. Multiplying by the pool width keeps "5 consecutive
// failures" meaning what it meant serially (five successive waves of
// evidence), and leaves concurrency-1 behaviour — and every test pinned to it
// — byte-identical. The cost of waiting for that evidence is bounded and
// small: at most 5 * 8 = 40 wasted slots at the shipped default, 5% of the
// 800-call budget.
const BREAKER_THRESHOLD = 5;

export interface DecideDeps {
  loadCriteria: (db: Database) => CompiledCriteria;
  classifyMetadata: (posting: PostingRow, criteria: CompiledCriteria) => { reject: boolean; reason?: string };
  classifyBoardGrace: (posting: PostingRow, board: BoardRow | null) => { reject: boolean; reason?: string };
  classifyYoe: (jdText: string, criteria: CompiledCriteria) => { reject: boolean; reason?: string };
  fetchJD: (posting: PostingRow, fetchImpl?: typeof fetch) => Promise<string>;
  scoreRelevance: (
    profileSummary: string,
    jdText: string,
    posting: PostingRow,
    mapImpl?: (prompt: string, schema: object) => Promise<unknown>,
  ) => Promise<{ relevant: boolean; reason: string }>;
  loadProfileSummary: (db: Database) => Promise<string>;
  promotePosting: (db: Database, posting: PostingRow) => { promoted: boolean; queueRow?: QueueRow; reason?: string };
  recordDecision: (db: Database, id: number, decision: string, reason: string) => PostingRow | null;
  listPostingsToDecide: (db: Database, limit?: number) => PostingRow[];
  listAllBoards: (db: Database) => BoardRow[];
}

export interface FilterCounts {
  toDecide: number;
  rulesRejected: number;
  llmRejected: number;
  queued: number;
  held: number;
  deduped: number;
  unscored: number;
  byCriterion: { title: number; location: number; stale: number; yoe: number; llm: number; grace: number };
  llmBreakerTripped: boolean;
}

// Maps a `rules:<x>` / `llm:not-relevant` decision_reason prefix onto its
// byCriterion bucket (filter.ts's REASON_* constants).
function criterionOf(reason: string): keyof FilterCounts['byCriterion'] | null {
  if (reason === 'rules:title') return 'title';
  if (reason === 'rules:location') return 'location';
  if (reason === 'rules:stale') return 'stale';
  if (reason === 'rules:yoe') return 'yoe';
  return null;
}

/**
 * Runs one filter->promote sweep over the to-decide backlog. Metadata rules
 * run for every posting regardless of the LLM cap (cheap, grinds down the
 * backlog); only the JD-fetch+LLM stage is gated by LLM_CAP. Returns the
 * per-decision counts (with byCriterion breakdown) the sweep/dashboard
 * consume.
 */
export async function runFilterPromote(db: Database, deps: DecideDeps): Promise<FilterCounts> {
  const profile = await deps.loadProfileSummary(db);
  // D-05/CFG-01: criteria are loaded and compiled exactly once per sweep,
  // mirroring the board Map load immediately below — never re-read or
  // re-compiled per posting. This snapshot is taken here, in the prologue,
  // so a settings save that lands mid-sweep takes effect on the NEXT sweep,
  // not the one already in flight; this is the one place in the code where
  // that snapshot-per-sweep semantics is observable. This same once-per-sweep
  // shape is what makes it safe for concurrent pool workers (D-04) to share
  // profile, criteria and boardByKey read-only below — no worker may re-fetch
  // or recompute any of them.
  const criteria = deps.loadCriteria(db);
  const postings = deps.listPostingsToDecide(db);

  // D-13: boards are loaded once per sweep, mirroring the single up-front
  // listPostingsToDecide call above — no per-posting query on the hot path.
  // Keyed exact-case (mirrors boards.UNIQUE(ats, token)'s own case-sensitive
  // uniqueness): lower-casing here would turn WR-01's harmless "no grace"
  // fail-open into a wrong suppression, the strictly worse failure.
  const boards = deps.listAllBoards(db);
  const boardByKey = new Map<string, BoardRow>(boards.map(b => [`${b.ats}:${b.token}`, b]));

  const counts: FilterCounts = {
    toDecide: postings.length,
    rulesRejected: 0,
    llmRejected: 0,
    queued: 0,
    held: 0,
    deduped: 0,
    unscored: 0,
    byCriterion: { title: 0, location: 0, stale: 0, yoe: 0, llm: 0, grace: 0 },
    llmBreakerTripped: false,
  };

  // D-06/WR-01: both are read exactly once per sweep, here in the prologue
  // alongside the profile/criteria/board snapshots — the pool width and the
  // breaker threshold derived from it must not drift mid-sweep, and neither
  // belongs on the per-posting hot path.
  const concurrency = DECIDE_CONCURRENCY();
  const breakerThreshold = BREAKER_THRESHOLD * concurrency;

  let llmCalls = 0;
  let consecutiveLlmFailures = 0;

  // D-07: the cap is claimed before the work, via a read-check-increment
  // with no `await` between the three steps. This is atomic for free on
  // JS's single-threaded event loop precisely BECAUSE nothing suspends
  // inside it — the absence of any `await` between the read, the check and
  // the increment IS the entire guarantee, and adding one would silently
  // reintroduce the race.
  //
  // D-20: a claimed slot is never released on failure. Releasing would let
  // a systematic failure loop indefinitely against the API; the breaker
  // below, not slot recycling, is the answer to wasted slots.
  //
  // D-19 (conflict resolved against 17-D-04): the breaker stops CLAIMING,
  // not DRAINING — tripping it only makes this return false. Workers keep
  // consuming the cursor and applying the cheap rules for the whole backlog
  // (17-D-04's whole-backlog cheap-rule contract is unaffected), so a
  // breaker-skipped posting is counted in counts.unscored and left decision
  // NULL, exactly like a capped-out posting — never `held`, which would
  // corrupt the held-for-retry signal.
  function claimLlmSlot(): boolean {
    if (counts.llmBreakerTripped) return false;
    if (llmCalls >= LLM_CAP()) return false;
    llmCalls++;
    return true;
  }

  // D-04: the pool cursor shape from ats-fetch.ts's runTokenPool, following
  // ycdir.ts's runCompanyPool more closely — copied inline rather than
  // imported, since this loop body writes decisions and mutates shared
  // counters directly rather than accumulating a return array. Every
  // `continue` below continues this `while` exactly as it continued the
  // `for` loop it replaces, so the body needed no restructuring — this is
  // what keeps D-04's diff minimal.
  let i = 0;
  async function worker() {
    while (i < postings.length) {
      const p = postings[i++];
      try {
        // D-13: grace runs as its own step before classifyMetadata. D-11 fail-open
        // on a join miss: `?? null` covers Map.get's `undefined` so a posting whose
        // (source, company) matches no board row proceeds to classifyMetadata
        // instead of being suppressed.
        const board = boardByKey.get(`${p.source}:${p.company}`) ?? null;
        const grace = deps.classifyBoardGrace(p, board);
        if (grace.reject) {
          // D-07/D-14: this rejection is permanent and never reconsidered, because
          // upsertPosting's ON CONFLICT deliberately omits decision/decision_reason/
          // decided_at. Accepted cost (D-07): a genuinely fresh posting on a
          // brand-new board is discarded, since a first poll cannot distinguish a
          // 3-hour-old listing from a 2-year-old one — bounded to one poll per
          // board by the 48-hour window.
          deps.recordDecision(db, p.id, 'rejected', grace.reason ?? 'rules:board-grace');
          counts.rulesRejected++;
          counts.byCriterion.grace++;
          continue;
        }

        const meta = deps.classifyMetadata(p, criteria);
        if (meta.reject) {
          deps.recordDecision(db, p.id, 'rejected', meta.reason ?? 'rules:unknown');
          counts.rulesRejected++;
          const criterion = criterionOf(meta.reason ?? '');
          if (criterion) counts.byCriterion[criterion]++;
          continue;
        }

        // D-12/D-07: the expensive stage (JD fetch + LLM) is capped per sweep,
        // claimed before the work so concurrent workers cannot overshoot it.
        // Capped/breaker-skipped survivors are left unscored (decision stays
        // NULL, no row written) — indistinguishable from not-yet-reached,
        // retried next sweep.
        if (!claimLlmSlot()) {
          counts.unscored++;
          continue;
        }

        // D-10: sources with no reachable JD are scored on metadata alone — an
        // EMPTY jd triggers relevance.ts's trusted-side metadata-only guidance.
        // (Guidance text must never ride in the jd slot — the prompt's injection
        // rule makes the model ignore it.) The YOE rule needs JD text, so it is
        // skipped; seniority stays covered by the title rule + LLM.
        //
        // Two disjoint reasons a JD is unreachable, both structural (never
        // transient), so neither may be left to the held-for-retry path below:
        //   1. login_gated (YC/Jobright) — fetching would fail every sweep.
        //   2. the source has no fetchJD branch at all (simplify/getro): their
        //      apply URLs point at arbitrary third-party hosts that ALLOWED_HOSTS
        //      refuses as an SSRF control, so fetchJD throws `unsupported source`
        //      forever. Observed live: 73 of 81 drained simplify postings were
        //      stranded in held:jd-fetch-error before this branch existed.
        //
        // Deliberately source-structural rather than error-based: a greenhouse
        // JD fetch that 404s IS transient and must keep its D-08 held-for-retry
        // semantics, so it must not be swept into metadata-only scoring.
        let jd: string;
        if (p.login_gated || !JD_FETCHABLE_SOURCES.has(p.source)) {
          jd = '';
        } else {
          try {
            jd = await deps.fetchJD(p);
          } catch {
            deps.recordDecision(db, p.id, 'held', 'held:jd-fetch-error');
            counts.held++;
            continue;
          }

          const yoe = deps.classifyYoe(jd, criteria);
          if (yoe.reject) {
            deps.recordDecision(db, p.id, 'rejected', 'rules:yoe');
            counts.rulesRejected++;
            counts.byCriterion.yoe++;
            continue;
          }
        }

        try {
          const verdict = await deps.scoreRelevance(profile, jd, p);
          // D-19: any successful verdict — relevant or not — means the LLM
          // channel worked, so the consecutive-failure streak resets.
          consecutiveLlmFailures = 0;
          if (verdict.relevant) {
            const promo = deps.promotePosting(db, p);
            if (promo.promoted) {
              deps.recordDecision(db, p.id, 'queued', `llm:relevant — ${verdict.reason}`);
              counts.queued++;
            } else {
              deps.recordDecision(db, p.id, 'rejected', promo.reason ?? 'dedupe:queue');
              counts.deduped++;
            }
          } else {
            deps.recordDecision(db, p.id, 'rejected', `llm:not-relevant — ${verdict.reason}`);
            counts.llmRejected++;
            counts.byCriterion.llm++;
          }
        } catch {
          deps.recordDecision(db, p.id, 'held', 'held:llm-error');
          counts.held++;
          // D-19: a run of breakerThreshold consecutive scoring failures
          // with no success between them trips the breaker — see the claim
          // helper above for the full reasoning and D-20's no-release rule
          // this preserves.
          consecutiveLlmFailures++;
          if (consecutiveLlmFailures >= breakerThreshold) {
            counts.llmBreakerTripped = true;
          }
        }
      } catch {
        // The pool's own outer catch, mirroring ats-fetch.ts's never-rethrow
        // posture. The two targeted catches above already isolate fetchJD
        // and scoreRelevance with their own held:* attribution; this one
        // exists only to cover a synchronous recordDecision/promotePosting
        // throw, so one bad posting can never abort the pool. Deliberately
        // uncounted in FilterCounts: a throw here is a code defect, not an
        // examined verdict for this posting (unlike held/rejected/queued),
        // so folding it into any existing bucket would misrepresent what
        // was actually decided for it.
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, postings.length) }, () => worker()));

  return counts;
}
