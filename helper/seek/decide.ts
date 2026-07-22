import type { Database } from 'bun:sqlite';
import type { PostingRow } from './postings';
import type { QueueRow } from '../queue';

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
export function LLM_CAP(): number {
  return Number(process.env.SEEK_LLM_CAP ?? 100);
}

export interface DecideDeps {
  classifyMetadata: (posting: PostingRow) => { reject: boolean; reason?: string };
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
}

export interface FilterCounts {
  toDecide: number;
  rulesRejected: number;
  llmRejected: number;
  queued: number;
  held: number;
  deduped: number;
  unscored: number;
  byCriterion: { title: number; location: number; stale: number; yoe: number; llm: number };
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

  const counts: FilterCounts = {
    toDecide: postings.length,
    rulesRejected: 0,
    llmRejected: 0,
    queued: 0,
    held: 0,
    deduped: 0,
    unscored: 0,
    byCriterion: { title: 0, location: 0, stale: 0, yoe: 0, llm: 0 },
  };

  let llmCalls = 0;

  for (const p of postings) {
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

    // D-10: login-gated sources (YC/Jobright) have no reachable JD — fetching
    // would fail every sweep and strand the posting in a permanent held loop.
    // Score them on metadata alone: an EMPTY jd triggers relevance.ts's
    // trusted-side metadata-only guidance. (Guidance text must never ride in
    // the jd slot — the prompt's injection rule makes the model ignore it.)
    // The YOE rule needs JD text, so it is skipped; seniority stays covered
    // by the title rule + LLM.
    let jd: string;
    if (p.login_gated) {
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
