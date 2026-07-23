import { Database } from 'bun:sqlite';
import { mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { normalizeQuestion, matchLibrary, selectFewShot, groupByQuestion, type AnswerRow } from './answers';
import { createFailuresTable, insertFailures, listFailures, type FailureRecordInput } from './failures';
import { createQueueTable, insertQueueEntry, updateQueueStatus, listQueue, InvalidQueueStatusError } from './queue';
import { mapViaCLI } from './mapping';
import { normalizeUrl } from './seek/normalize';
import { createPostingsTable, upsertPosting, listPostings, recordDecision, listPostingsToDecide } from './seek/postings';
import { loadSeekConfig } from './seek/config';
import { fetchGreenhouse } from './seek/greenhouse';
import { fetchLever } from './seek/lever';
import { fetchAshby } from './seek/ashby';
import { fetchHNPostings } from './seek/hn';
import type { SourceName } from './seek/types';
import { classifyMetadata, classifyYoe } from './seek/filter';
import { fetchJD } from './seek/jd-fetch';
import { scoreRelevance, loadProfileSummary } from './seek/relevance';
import { promotePosting } from './seek/promote';
import {
  createSweepsTable,
  reconcileInterruptedSweeps,
  listSweeps,
  getSweepById,
  getRunningSweep,
  getLastRunState,
} from './seek/runs';
import { beginSweep, runSweepJob, spawnSidecar, SweepAlreadyRunningError, type JobDeps } from './seek/job';
import { shouldFireToday } from './seek/scheduler';
import {
  createBatchRunsTable,
  reconcileInterruptedBatchRuns,
  getFreshRunningBatch,
  listBatchRuns,
  getBatchRunById,
  getRunningBatch,
  finishBatchRun,
  touchBatchHeartbeat,
  getLastBatchRunState,
  BATCH_STATUSES,
  InvalidBatchStatusError,
} from './seek/batch';
import { shouldFireBatchToday } from './seek/batch-scheduler';
import { beginBatch, spawnBatchRunner, BatchAlreadyRunningError, SweepInProgressError } from './seek/batch-job';

const PORT = 7877;
const HERE = dirname(fileURLToPath(import.meta.url));
const RESUME_DIR = join(homedir(), 'resume');
const BASE_TEX = join(RESUME_DIR, 'resume.tex');
const BULLET_POOL = join(homedir(), '.claude/projects/-Users-you-resume/memory/resume_bullet_pool.md');
const ROUNDS_DIR = join(RESUME_DIR, 'rounds');
const CLAUDE_BIN = join(homedir(), '.local/bin/claude');
const PDFLATEX = '/Library/TeX/texbin/pdflatex';

const db = new Database(join(HERE, 'jobfill.db'));
db.run(`CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL,
  role TEXT DEFAULT '',
  url TEXT DEFAULT '',
  status TEXT DEFAULT 'applied',
  notes TEXT DEFAULT '',
  resume_path TEXT DEFAULT '',
  cost_usd REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
)`);
try {
  db.run(`ALTER TABLE applications ADD COLUMN summary TEXT DEFAULT ''`);
} catch {}
try {
  db.run(`ALTER TABLE applications ADD COLUMN tailor_state TEXT DEFAULT ''`);
} catch {}
try {
  db.run(`ALTER TABLE applications ADD COLUMN tailor_message TEXT DEFAULT ''`);
} catch {}

db.run(`CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER,
  url TEXT DEFAULT '',
  question TEXT NOT NULL,
  question_key TEXT NOT NULL,
  answer TEXT NOT NULL,
  pinned INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
)`);

createFailuresTable(db);
createQueueTable(db);
createPostingsTable(db);
createSweepsTable(db);
createBatchRunsTable(db);

// Live-DB migrations (idempotent, re-run safe): both createQueueTable and
// createPostingsTable's CREATE TABLE IF NOT EXISTS strings already include
// these columns for a fresh database, but the live jobfill.db predates them —
// ALTER-guard each column exactly like the applications summary/tailor_state
// blocks above (T-10-09).
try {
  db.run(`ALTER TABLE postings ADD COLUMN decision TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE postings ADD COLUMN decision_reason TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE postings ADD COLUMN decided_at TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE queue ADD COLUMN url_key TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE queue ADD COLUMN login_gated INTEGER DEFAULT 0`);
} catch {}
try {
  db.run(`ALTER TABLE queue ADD COLUMN not_fillable INTEGER DEFAULT 0`);
} catch {}
try {
  db.run(`ALTER TABLE queue ADD COLUMN low_confidence INTEGER DEFAULT 0`);
} catch {}

// D-11 backfill: existing queue rows (inserted via insertQueueEntry(db, url),
// no url_key) must be dedupe-protected before the UNIQUE index below is
// created. Oldest-id-wins on a normalizeUrl collision — the redundant newer
// duplicate is left with a NULL url_key (never deleted, WR-05) so the index
// creation can never fail on a pre-existing internal duplicate.
{
  const legacy = db.query('SELECT id, url FROM queue WHERE url_key IS NULL ORDER BY id ASC').all() as {
    id: number;
    url: string;
  }[];
  // Seed `seen` with url_keys already persisted from a prior boot (not just
  // this run's in-memory set) — otherwise a re-boot re-attempts backfilling a
  // permanently-NULL collision-duplicate row into a key an earlier boot
  // already assigned to another row, violating the UNIQUE index created below.
  const seen = new Set(
    (db.query('SELECT url_key FROM queue WHERE url_key IS NOT NULL').all() as { url_key: string }[]).map(
      r => r.url_key,
    ),
  );
  for (const row of legacy) {
    const key = normalizeUrl(row.url);
    if (key && !seen.has(key)) {
      db.run('UPDATE queue SET url_key = ? WHERE id = ?', [key, row.id]);
      seen.add(key);
    }
  }
}

// FULL UNIQUE index — must match queue.ts's fresh-create `url_key TEXT UNIQUE`
// column constraint, because insertQueueEntryFromPosting's bare
// `ON CONFLICT(url_key)` target does not match a partial index (SQLite throws
// "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint").
// NULL url_keys (oldest-wins collision dupes) are still safe: SQLite treats
// NULLs as distinct in unique indexes, so no partial WHERE is needed.
db.run('DROP INDEX IF EXISTS idx_queue_url_key');
db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_url_key_full ON queue(url_key)');

// D-15 last-sweep summary store: a tiny key/value table, one JSON row.
db.run('CREATE TABLE IF NOT EXISTS seek_meta (key TEXT PRIMARY KEY, value TEXT)');

// RESEARCH Pattern 5: any sweeps row still 'running' when the process starts
// back up can only mean the prior process crashed mid-sweep — flip it to
// 'failed' before any route or scheduler tick can act, so a crash can never
// permanently wedge the single-flight lock (T-11-03-02).
reconcileInterruptedSweeps(db);

// batch_runs gets its own crash reconciliation (heartbeat-gated, unlike
// sweeps — the batch process is detached and survives helper restarts,
// D-06). A 'running' row with a fresh heartbeat is a live detached run and
// must never be touched here.
reconcileInterruptedBatchRuns(db);

// D-04: a queue row stranded at 'filling' when the process starts back up
// can only mean a mid-fill crash — but only reconcile it when no live batch
// run exists (getFreshRunningBatch heartbeat-gate), so a genuinely live
// detached batch's in-flight row is never wrongly flipped. A raw query is
// safe here: HUMAN_STATUSES (reviewed/submitted) can never legally coexist
// with 'filling' at startup.
if (getFreshRunningBatch(db) === null) {
  db.run(`UPDATE queue SET status = 'failed', error = 'run interrupted' WHERE status = 'filling'`);
}

// Shared secret with the extension (must match HELPER_TOKEN in extension/background.js).
// No CORS headers are served: cross-origin pages can neither read responses nor pass
// preflight, so only the extension (token) and the same-origin dashboard get through.
// JOBFILL_TOKEN env overrides the committed fallback everywhere it appears
// (here, scripts/seek.mjs, scripts/seek-sidecar.mjs) so rotation is one export.
const TOKEN = process.env.JOBFILL_TOKEN ?? 'REDACTED-TOKEN';

// Only the login-gated sidecar sources may POST /seek/results — the fetch
// sources (greenhouse/lever/ashby/hn) are swept in-process via POST /seek and
// never cross this boundary. login_gated is re-asserted server-side in the
// handler: the "all YC/Jobright postings are login_gated" invariant (Phase 12
// reads this flag to decide what never to auto-fill) must hold at the
// persistence boundary regardless of what the client sent.
const GATED_SOURCES: Set<SourceName> = new Set(['yc', 'jobright']);

// The single dependency-injection contract runSweepJob needs — assembled
// once from the real fetch/filter/promote implementations already imported
// above, plus the helper-owned sidecar spawn. Both POST /sweep and the
// scheduler tick pass this same object into the same runSweepJob (SCHED-02:
// identical code path by construction).
const jobDeps: JobDeps = {
  fetchGreenhouse,
  fetchLever,
  fetchAshby,
  fetchHNPostings,
  upsertPosting,
  classifyMetadata,
  classifyYoe,
  fetchJD,
  scoreRelevance,
  loadProfileSummary,
  promotePosting,
  recordDecision,
  listPostingsToDecide,
  spawnSidecar,
};

// Anacron-style ~15-min tick (SCHED-01/04): loads the schedule config fresh,
// checks shouldFireToday against the last recorded run, and — if due — runs
// exactly the same beginSweep + runSweepJob path POST /sweep uses. Wrapped
// defensively (T-11-03-05): this function must never throw to the event
// loop, or a bad tick would crash the whole helper process.
async function checkSchedule() {
  const cfg = await loadSeekConfig();
  const last = getLastRunState(db);
  if (!shouldFireToday(new Date(), cfg.schedule, last)) return;
  try {
    const { runId } = beginSweep(db, 'scheduled');
    await runSweepJob(db, cfg, jobDeps, runId);
  } catch (e) {
    console.error('[scheduler] tick:', String((e as Error)?.message ?? e));
  }
}

// D-05: batch's own daily fire-check on the same tick, gated on today's sweep
// having settled (shouldFireBatchToday) rather than a clock hour. Unlike
// checkSchedule, batch is a spawned detached process (D-06) — beginBatch
// creates the run row synchronously, then spawnBatchRunner fires-and-forgets;
// this function must not await the batch itself. Wrapped defensively for the
// same reason as checkSchedule: a bad tick must never crash the helper.
async function checkBatchSchedule() {
  // Clear heartbeat-stale 'running' batch rows before the lock inside
  // beginBatch is consulted — reconciliation otherwise only ran at helper
  // startup, so a batch-runner that died without PATCHing would wedge batch
  // scheduling indefinitely. Idempotent; a fresh-heartbeat run is untouched.
  reconcileInterruptedBatchRuns(db);
  const cfg = await loadSeekConfig();
  if (!shouldFireBatchToday(new Date(), cfg.batch, getLastBatchRunState(db), getLastRunState(db))) return;
  try {
    const { runId } = beginBatch(db, 'scheduled');
    spawnBatchRunner(runId);
  } catch (e) {
    console.error('[scheduler] batch tick:', String((e as Error)?.message ?? e));
  }
}

function authorized(req: Request): boolean {
  if (req.headers.get('x-jobfill-token') === TOKEN) return true;
  const origin = req.headers.get('origin');
  return !origin || origin === `http://127.0.0.1:${PORT}` || origin === `http://localhost:${PORT}`;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'unknown';
}

function parseSummary(stored: string): string[] | null {
  try {
    const arr = JSON.parse(stored);
    return Array.isArray(arr) && arr.length ? arr : null;
  } catch {
    return null;
  }
}

async function tailor(body: { company: string; role: string; jd: string; url?: string }) {
  if (!body.jd || body.jd.length < 200) throw new Error('Job description too short to tailor against.');
  const slug = slugify(body.company || '');
  const outDir = join(ROUNDS_DIR, slug);
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const texName = `resume_${slug}_${stamp}.tex`;
  const texPath = join(outDir, texName);
  const jdPath = join(outDir, `jd_${stamp}.md`);
  const summaryPath = join(outDir, `summary_${stamp}.json`);
  await Bun.write(jdPath, `# ${body.role} @ ${body.company}\n${body.url ?? ''}\n\n${body.jd}`);

  const prompt = `You are tailoring the operator Example's resume for one specific job application.

Read these files:
- Base resume (LaTeX): ${BASE_TEX}
- Bullet pool (approved alternate bullets): ${BULLET_POOL}
- Job description: ${jdPath}

Write the tailored resume to exactly this path: ${texPath}

Also write a summary file to exactly this path: ${summaryPath}
Its shape must be exactly: { "company": string, "role": string, "summary": string[] }
- "company" and "role": infer from the job description file. Use "" if undeterminable.
- "summary": up to 3 lines, honest minimum — only real changes, no padding. Each line pairs the change made with the JD reason that drove it, e.g. "led with distributed-systems bullets — JD emphasizes scale". If the base resume already fits with minimal changes, return a single line like "minimal changes — base resume already fits this JD".

Hard rules:
- Facts come ONLY from the base resume and the bullet pool. Never invent or inflate metrics, titles, dates, or technologies. Every number must be interview-defensible.
- Tailor by SELECTING and REORDERING: swap in bullet-pool variants that better match the job description, reorder bullets and the skills lists to lead with what the JD emphasizes. Do not rewrite facts.
- Keep the base resume's LaTeX preamble, commands, and structure exactly. The result must compile with pdflatex and stay one page.
- Bullets marked with warning symbols in the pool need re-verification — do not use them.
- Write exactly two files: the .tex and the summary_<stamp>.json. No commentary, no other files.`;

  const proc = Bun.spawn(
    [CLAUDE_BIN, '-p', prompt, '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Write,Edit,Glob,Grep'],
    { cwd: RESUME_DIR, stdout: 'pipe', stderr: 'pipe' },
  );
  const timeout = setTimeout(() => proc.kill(), 6 * 60 * 1000);
  const exit = await proc.exited;
  clearTimeout(timeout);
  if (!existsSync(texPath)) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`Tailoring produced no .tex (claude exit ${exit}): ${err.slice(0, 300)}`);
  }

  for (let pass = 0; pass < 2; pass++) {
    const latex = Bun.spawn(
      [PDFLATEX, '-interaction=nonstopmode', `-output-directory=${outDir}`, texPath],
      { cwd: outDir, stdout: 'pipe', stderr: 'pipe' },
    );
    const latexTimeout = setTimeout(() => latex.kill(), 60 * 1000);
    await latex.exited;
    clearTimeout(latexTimeout);
  }
  const pdfName = texName.replace(/\.tex$/, '.pdf');
  let pdfPath = join(outDir, pdfName);
  if (!existsSync(pdfPath)) throw new Error('pdflatex did not produce a PDF — check the tailored .tex for LaTeX errors.');

  let parsed: { company?: string; role?: string; summary?: string[] } | null = null;
  if (existsSync(summaryPath)) {
    try {
      const raw = JSON.parse(await Bun.file(summaryPath).text());
      if (raw && typeof raw === 'object') parsed = raw;
    } catch {}
  }

  let effectiveSlug = slug;
  if (parsed?.company) {
    const newSlug = slugify(parsed.company);
    const newDir = join(ROUNDS_DIR, newSlug);
    if (newSlug !== slug && !existsSync(newDir)) {
      renameSync(outDir, newDir);
      effectiveSlug = newSlug;
      pdfPath = join(newDir, pdfName);
    }
  }

  const pdfBytes = await Bun.file(pdfPath).arrayBuffer();
  return {
    name: `resume_${effectiveSlug}.pdf`,
    path: pdfPath,
    b64: Buffer.from(pdfBytes).toString('base64'),
    mime: 'application/pdf',
    // WR-08: the CLI may write a bare string ("minimal changes") despite the prompt —
    // consumers .map() over this, so only ever return an array or null.
    summary: Array.isArray(parsed?.summary) ? parsed.summary : null,
    company: parsed?.company || body.company || '',
    role: parsed?.role || body.role || '',
  };
}

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  idleTimeout: 0,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204 });

    try {
      if (pathname !== '/health' && !authorized(req)) return json({ error: 'forbidden' }, 403);
      if (pathname === '/health') {
        return json({ ok: true, latex: existsSync(PDFLATEX), claude: existsSync(CLAUDE_BIN) });
      }
      if (pathname === '/' && req.method === 'GET') {
        return new Response(Bun.file(join(HERE, 'dashboard.html')), { headers: { 'content-type': 'text/html' } });
      }
      if (pathname === '/applications' && req.method === 'GET') {
        const rows = db.query('SELECT * FROM applications ORDER BY created_at DESC').all() as { url: string; summary: string }[];
        const mapped = rows.map(row => ({ ...row, summary: parseSummary(row.summary) }));
        const urlParam = new URL(req.url).searchParams.get('url');
        if (urlParam === null) return json(mapped);
        const target = normalizeUrl(urlParam);
        return json(mapped.filter(row => normalizeUrl(row.url) === target));
      }
      if (pathname === '/applications' && req.method === 'POST') {
        const b = await req.json();
        const row = db
          .query(
            `INSERT INTO applications (company, role, url, resume_path, cost_usd, summary, tailor_state, tailor_message)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
          )
          .get(
            b.company ?? 'unknown',
            b.role ?? '',
            b.url ?? '',
            b.resume_path ?? '',
            b.cost_usd ?? 0,
            Array.isArray(b.summary) && b.summary.length ? JSON.stringify(b.summary) : '',
            b.tailor_state ?? '',
            b.tailor_message ?? '',
          );
        return json(row, 201);
      }
      const patch = pathname.match(/^\/applications\/(\d+)$/);
      if (patch && req.method === 'PATCH') {
        const b = await req.json();
        const fields: string[] = [];
        const vals: unknown[] = [];
        for (const k of ['status', 'notes'] as const) {
          if (k in b) {
            fields.push(`${k} = ?`);
            vals.push(b[k]);
          }
        }
        if (!fields.length) return json({ error: 'nothing to update' }, 400);
        db.query(`UPDATE applications SET ${fields.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(
          ...vals,
          Number(patch[1]),
        );
        return json(db.query('SELECT * FROM applications WHERE id = ?').get(Number(patch[1])));
      }
      if (pathname === '/answers' && req.method === 'GET') {
        const rows = db.query('SELECT * FROM answers ORDER BY created_at DESC, id DESC').all() as AnswerRow[];
        return json(groupByQuestion(rows));
      }
      const answersPatch = pathname.match(/^\/answers\/(\d+)$/);
      if (answersPatch && req.method === 'PATCH') {
        const b = await req.json();
        const fields: string[] = [];
        const vals: unknown[] = [];
        for (const k of ['answer', 'pinned'] as const) {
          if (k in b) {
            fields.push(`${k} = ?`);
            vals.push(b[k]);
          }
        }
        if (!fields.length) return json({ error: 'nothing to update' }, 400);
        db.query(`UPDATE answers SET ${fields.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(
          ...vals,
          Number(answersPatch[1]),
        );
        return json(db.query('SELECT * FROM answers WHERE id = ?').get(Number(answersPatch[1])));
      }
      if (answersPatch && req.method === 'DELETE') {
        db.query('DELETE FROM answers WHERE id = ?').run(Number(answersPatch[1]));
        return json({ ok: true });
      }
      if (pathname === '/answers' && req.method === 'POST') {
        const b = await req.json();
        const target = normalizeUrl(b.url ?? '');
        const appRows = db.query('SELECT id, url FROM applications ORDER BY created_at DESC, id DESC').all() as {
          id: number;
          url: string;
        }[];
        const applicationId = appRows.find(row => normalizeUrl(row.url) === target)?.id ?? null;

        let banked = 0;
        for (const a of Array.isArray(b.answers) ? b.answers : []) {
          const question = String(a?.question ?? '').trim();
          const answer = String(a?.answer ?? '').trim();
          if (!question || !answer) continue;
          const questionKey = normalizeQuestion(question);
          const existing = (db.query('SELECT * FROM answers WHERE question_key = ?').all(questionKey) as { id: number; url: string }[]).find(
            row => normalizeUrl(row.url) === target,
          );
          if (existing) {
            db.query(`UPDATE answers SET answer = ?, updated_at = datetime('now') WHERE id = ?`).run(answer, existing.id);
          } else {
            db.query(
              `INSERT INTO answers (application_id, url, question, question_key, answer) VALUES (?, ?, ?, ?, ?)`,
            ).run(applicationId, b.url ?? '', question, questionKey, answer);
          }
          banked++;
        }
        return json({ banked }, 201);
      }
      if (pathname === '/answers/match' && req.method === 'GET') {
        const questionsParam = new URL(req.url).searchParams.get('questions');
        let questions: string[] = [];
        try {
          const parsed = JSON.parse(questionsParam ?? '[]');
          if (Array.isArray(parsed)) questions = parsed.filter(q => typeof q === 'string');
        } catch {}
        const rows = db.query('SELECT * FROM answers ORDER BY created_at DESC, id DESC').all() as AnswerRow[];
        return json({ reuse: matchLibrary(questions, rows), examples: selectFewShot(rows, 5) });
      }
      if (pathname === '/failures' && req.method === 'GET') {
        return json(listFailures(db));
      }
      if (pathname === '/failures' && req.method === 'POST') {
        const b = await req.json();
        const url = b.url ?? '';
        const resolveApplicationId = (u: string) => {
          const target = normalizeUrl(u);
          const appRows = db.query('SELECT id, url FROM applications ORDER BY created_at DESC, id DESC').all() as {
            id: number;
            url: string;
          }[];
          return appRows.find(row => normalizeUrl(row.url) === target)?.id ?? null;
        };
        const records = (Array.isArray(b.records) ? b.records : []) as FailureRecordInput[];
        return json(insertFailures(db, url, records, resolveApplicationId), 201);
      }
      if (pathname === '/queue' && req.method === 'GET') {
        return json(listQueue(db));
      }
      if (pathname === '/queue' && req.method === 'POST') {
        const b = await req.json();
        if (!b.url) return json({ error: 'url required' }, 400);
        // Persistence-boundary allowlist: this url is later rendered as an anchor and
        // passed to chrome.tabs.query/create by the trigger — never store a non-http(s) scheme.
        if (!/^https?:\/\//i.test(String(b.url))) return json({ error: 'url must be http(s)' }, 400);
        return json(insertQueueEntry(db, b.url), 201);
      }
      const queuePatch = pathname.match(/^\/queue\/(\d+)$/);
      if (queuePatch && req.method === 'PATCH') {
        const b = await req.json();
        try {
          return json(updateQueueStatus(db, Number(queuePatch[1]), b));
        } catch (e) {
          if (e instanceof InvalidQueueStatusError) return json({ error: e.message }, 400);
          throw e;
        }
      }
      if (pathname === '/sweep' && req.method === 'POST') {
        const running = getRunningSweep(db);
        if (running) return json({ error: 'sweep already running', runId: running.id }, 409);
        let runId: number;
        try {
          ({ runId } = beginSweep(db, 'manual'));
        } catch (e) {
          if (e instanceof SweepAlreadyRunningError) return json({ error: e.message, runId: e.runId }, 409);
          throw e;
        }
        // Fire-and-poll (D-10): the job runs in the background — this route
        // returns immediately with the run id, it never holds the request
        // open for the sweep's duration. The .catch prevents an unhandled
        // rejection from crashing the process (T-11-03-05).
        runSweepJob(db, await loadSeekConfig(), jobDeps, runId).catch(e =>
          console.error('[sweep] background job failed:', e),
        );
        return json({ id: runId }, 202);
      }
      if (pathname === '/sweeps' && req.method === 'GET') {
        const limitParam = Number(new URL(req.url).searchParams.get('limit'));
        const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 20;
        const rows = listSweeps(db, limit).map(r => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
        return json(rows);
      }
      const sweepById = pathname.match(/^\/sweeps\/(\d+)$/);
      if (sweepById && req.method === 'GET') {
        const row = getSweepById(db, Number(sweepById[1]));
        if (!row) return json({ error: 'not found' }, 404);
        return json({ ...row, detail: row.detail ? JSON.parse(row.detail) : null });
      }
      if (pathname === '/batch' && req.method === 'POST') {
        const runningSweep = getRunningSweep(db);
        if (runningSweep) return json({ error: 'sweep running', runId: runningSweep.id }, 409);
        // Same stale-lock clearing as checkBatchSchedule: a dead detached
        // run must not 409 every manual trigger until a helper restart.
        reconcileInterruptedBatchRuns(db);
        const runningBatch = getRunningBatch(db);
        if (runningBatch) return json({ error: 'batch already running', runId: runningBatch.id }, 409);
        let runId: number;
        try {
          ({ runId } = beginBatch(db, 'manual'));
        } catch (e) {
          if (e instanceof SweepInProgressError) return json({ error: 'sweep running', runId: e.runId }, 409);
          if (e instanceof BatchAlreadyRunningError) return json({ error: 'batch already running', runId: e.runId }, 409);
          throw e;
        }
        // Fire-and-forget (D-06): the detached batch-runner process owns the
        // rest of the run and reports back over PATCH /batch-runs/:id — this
        // route returns immediately with the run id, same shape as POST /sweep.
        spawnBatchRunner(runId);
        return json({ id: runId }, 202);
      }
      if (pathname === '/batch-runs' && req.method === 'GET') {
        const limitParam = Number(new URL(req.url).searchParams.get('limit'));
        const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 20;
        const rows = listBatchRuns(db, limit).map(r => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
        return json(rows);
      }
      const batchRunById = pathname.match(/^\/batch-runs\/(\d+)$/);
      if (batchRunById && req.method === 'GET') {
        const row = getBatchRunById(db, Number(batchRunById[1]));
        if (!row) return json({ error: 'not found' }, 404);
        return json({ ...row, detail: row.detail ? JSON.parse(row.detail) : null });
      }
      if (batchRunById && req.method === 'PATCH') {
        const id = Number(batchRunById[1]);
        const b = await req.json();
        if (b.heartbeat === true) {
          touchBatchHeartbeat(db, id);
          const row = getBatchRunById(db, id);
          if (!row) return json({ error: 'not found' }, 404);
          return json({ ...row, detail: row.detail ? JSON.parse(row.detail) : null });
        }
        try {
          const row = finishBatchRun(db, id, b.status, b.detail);
          if (!row) return json({ error: 'not found' }, 404);
          return json({ ...row, detail: row.detail ? JSON.parse(row.detail) : null });
        } catch (e) {
          if (e instanceof InvalidBatchStatusError) return json({ error: e.message }, 400);
          throw e;
        }
      }
      if (pathname === '/seek/last' && req.method === 'GET') {
        const row = db.query('SELECT value FROM seek_meta WHERE key = ?').get('last_sweep') as { value: string } | null;
        return json(row ? JSON.parse(row.value) : null);
      }
      if (pathname === '/postings' && req.method === 'GET') {
        return json(listPostings(db));
      }
      const postingPromote = pathname.match(/^\/postings\/(\d+)\/promote$/);
      if (postingPromote && req.method === 'POST') {
        const id = Number(postingPromote[1]);
        const posting = db.query('SELECT * FROM postings WHERE id = ?').get(id) as
          | (Record<string, unknown> & { id: number; url: string; company: string; title: string; login_gated: number; not_fillable: number })
          | null;
        if (!posting) return json({ error: 'not found' }, 404);
        const result = promotePosting(db, {
          id: posting.id,
          url: posting.url as string,
          url_key: posting.url_key as string,
          company: posting.company as string,
          title: posting.title as string,
          location: posting.location as string,
          source: posting.source as string,
          posted_at: (posting.posted_at as string | null) ?? null,
          posted_at_trusted: posting.posted_at_trusted === 1,
          login_gated: posting.login_gated === 1,
          not_fillable: posting.not_fillable === 1,
          low_confidence: posting.low_confidence === 1,
          decision: (posting.decision as string | null) ?? null,
          decision_reason: (posting.decision_reason as string | null) ?? null,
          decided_at: (posting.decided_at as string | null) ?? null,
          fetched_at: posting.fetched_at as string,
          created_at: posting.created_at as string,
        });
        if (result.promoted) {
          recordDecision(db, id, 'queued', 'queued: manual');
          return json(result.queueRow);
        }
        return json({ promoted: false, reason: result.reason });
      }
      if (pathname === '/seek/results' && req.method === 'POST') {
        const b = await req.json();
        const source = b?.source;
        if (!GATED_SOURCES.has(source)) return json({ error: 'invalid source' }, 400);
        // Cap how many rows one request can write to the staging table.
        const postings = (Array.isArray(b?.postings) ? b.postings : []).slice(0, 5000);
        let upserted = 0;
        for (const p of postings) {
          if (upsertPosting(db, { ...p, source, login_gated: true })) upserted++;
        }
        return json({ source, upserted });
      }
      if (pathname === '/tailor' && req.method === 'POST') {
        return json(await tailor(await req.json()));
      }
      if (pathname === '/map' && req.method === 'POST') {
        const b = await req.json();
        if (typeof b.prompt !== 'string' || !b.prompt) return json({ error: 'prompt required' }, 400);
        if (typeof b.schema !== 'object' || !b.schema) return json({ error: 'schema required' }, 400);
        return json(await mapViaCLI(b.prompt, b.schema));
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String((e as Error).message ?? e) }, 500);
    }
  },
});

console.log(`jobfill helper on http://127.0.0.1:${PORT} (dashboard at /)`);

// ~15-min anacron tick (SCHED-01/04). An immediate invocation on startup
// means a RunAtLoad start past the target hour catches up right away instead
// of waiting up to 15 minutes for the first interval fire.
setInterval(() => {
  checkSchedule().catch(e => console.error('[scheduler]', e));
  checkBatchSchedule().catch(e => console.error('[scheduler]', e));
}, 15 * 60 * 1000);
checkSchedule().catch(e => console.error('[scheduler]', e));
checkBatchSchedule().catch(e => console.error('[scheduler]', e));
