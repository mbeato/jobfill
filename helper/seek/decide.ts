import type { Database } from 'bun:sqlite';
import type { PostingRow } from './postings';
import type { QueueRow } from '../queue';
import type { BoardRow } from './boards';
import { JD_FETCHABLE_SOURCES } from './jd-fetch';

// The filter -> promote orchestrator (D-01 two-stage, D-08 held, D-12 cap,
// D-14 finality). Walks the to-decide backlog (oldest-fetched-first, per
// listPostingsToDecide's own query-enforced finality) through cheap metadata
// rules first, then — for survivors, gated by LLM_CAP — JD fetch, the YOE
// rule, and the LLM relevance pass. Mirrors sweep.ts's runOne per-item
// isolation, but split into two targeted try/catch blocks so a thrown
// posting can be attributed to the exact async stage that failed (D-08:
// held is a distinct, stricter state than the fill-flow's fail-open — a
// held posting is NEVER promoted).

// Read fresh on every call (not frozen at import) so a sweep-to-sweep env
// change — or a test setting process.env.SEEK_LLM_CAP before calling — takes
// effect without a process restart, mirroring config.ts's fresh-read style.
// WR-02: fail closed (not open) on a misconfigured env var — a non-numeric
// SEEK_LLM_CAP (e.g. a typo) must fall back to the safe default, not silently
// become NaN (every `>= NaN` comparison is false, so the cap would never trip).
export function LLM_CAP(): number {
  const n = Number(process.env.SEEK_LLM_CAP ?? 100);
  return Number.isFinite(n) && n >= 0 ? n : 100;
}

export interface DecideDeps {
  classifyMetadata: (posting: PostingRow) => { reject: boolean; reason?: string };
  classifyBoardGrace: (posting: PostingRow, board: BoardRow | null) => { reject: boolean; reason?: string };
  classifyYoe: (jdText: string) => { reject: boolean; reason?: string };
  fetchJD: (posting: PostingRow, fetchImpl?: typeof fetch) => Promise<string>;
  scoreRelevance: (
    profileSummary: string,
    jdText: string,
    posting: PostingRow,
    mapImpl?: (prompt: string, schema: object) => Promise<unknown>,
  ) => Promise<{ relevant: boolean; reason: string }>;
  loadProfileSummary: (path?: string) => Promise<string>;
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
  const profile = await deps.loadProfileSummary();
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
  };

  let llmCalls = 0;

  for (const p of postings) {
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

    const meta = deps.classifyMetadata(p);
    if (meta.reject) {
      deps.recordDecision(db, p.id, 'rejected', meta.reason ?? 'rules:unknown');
      counts.rulesRejected++;
      const criterion = criterionOf(meta.reason ?? '');
      if (criterion) counts.byCriterion[criterion]++;
      continue;
    }

    // D-12: the expensive stage (JD fetch + LLM) is capped per sweep.
    // Capped survivors are left unscored (decision stays NULL, no row
    // written) — indistinguishable from not-yet-reached, retried next sweep.
    if (llmCalls >= LLM_CAP()) {
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

      const yoe = deps.classifyYoe(jd);
      if (yoe.reject) {
        deps.recordDecision(db, p.id, 'rejected', 'rules:yoe');
        counts.rulesRejected++;
        counts.byCriterion.yoe++;
        continue;
      }
    }

    try {
      llmCalls++;
      const verdict = await deps.scoreRelevance(profile, jd, p);
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
    }
  }

  return counts;
}
