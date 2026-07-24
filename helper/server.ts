import { Database } from 'bun:sqlite';
import { mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { normalizeQuestion, matchLibrary, selectFewShot, groupByQuestion, type AnswerRow } from './answers';
import { createFailuresTable, insertFailures, listFailures, type FailureRecordInput } from './failures';
import { createQueueTable, insertQueueEntry, updateQueueStatus, deleteQueueEntry, listQueue, InvalidQueueStatusError } from './queue';
import { createApplicationsTable, insertApplication, updateApplicationStatus, deriveGhost, promoteUnsubmittedToApplied, InvalidApplicationStatusError } from './applications';
// safeDocPath lives in its own module (not inline here) so it stays importable
// by a test without triggering this file's Bun.serve() side effect on import.
// Re-exported so it reads as "exported from server.ts" per the phase 15 plan.
import { safeDocPath, safeOutDir } from './docpath';
export { safeDocPath };
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
import { beginBatch, spawnBatchRunner, spawnFillRunner, BatchAlreadyRunningError, SweepInProgressError } from './seek/batch-job';

const PORT = 7877;
const HERE = dirname(fileURLToPath(import.meta.url));
const RESUME_DIR = join(homedir(), 'resume');
const BASE_TEX = join(RESUME_DIR, 'resume.tex');
const BULLET_POOL = join(homedir(), '.claude/projects/-Users-you-resume/memory/resume_bullet_pool.md');
const ROUNDS_DIR = join(RESUME_DIR, 'rounds');
const CLAUDE_BIN = join(homedir(), '.local/bin/claude');
const PDFLATEX = '/Library/TeX/texbin/pdflatex';
// Phase 15: memory-file inputs for the on-demand doc generators (cover letter,
// interview-prep brief, follow-up email). Same construction as BULLET_POOL.
const VOICE_PROFILE = join(homedir(), '.claude/projects/-Users-you-resume/memory/voice_profile.md');
const USER_PROFILE = join(homedir(), '.claude/projects/-Users-you-resume/memory/user_profile.md');
const INTERVIEW_GAPS = join(homedir(), '.claude/projects/-Users-you-resume/memory/interview_gaps.md');
const NO_INFLATED_METRICS = join(homedir(), '.claude/projects/-Users-you-resume/memory/feedback_no_inflated_metrics.md');

const db = new Database(join(HERE, 'jobfill.db'));
// Fresh-create DDL lives in applications.ts so the module and its :memory: tests
// own the full column set (incl. status_changed_at); the live jobfill.db predates
// several columns and gets them via the ALTER guards below (dual pattern, same as
// url_key at queue.ts:103 + server.ts:113).
createApplicationsTable(db);
try {
  db.run(`ALTER TABLE applications ADD COLUMN summary TEXT DEFAULT ''`);
} catch {}
try {
  db.run(`ALTER TABLE applications ADD COLUMN tailor_state TEXT DEFAULT ''`);
} catch {}
try {
  db.run(`ALTER TABLE applications ADD COLUMN tailor_message TEXT DEFAULT ''`);
} catch {}
try {
  db.run(`ALTER TABLE applications ADD COLUMN status_changed_at TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE applications ADD COLUMN jd TEXT DEFAULT ''`);
} catch {}
try {
  db.run(`ALTER TABLE applications ADD COLUMN cover_letter_path TEXT DEFAULT ''`);
} catch {}
try {
  db.run(`ALTER TABLE applications ADD COLUMN brief_path TEXT DEFAULT ''`);
} catch {}
try {
  db.run(`ALTER TABLE applications ADD COLUMN email_path TEXT DEFAULT ''`);
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
try {
  db.run(`ALTER TABLE queue ADD COLUMN resume_name TEXT DEFAULT ''`);
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

// D-20 clock seed (idempotent, every boot): existing application rows predate the
// status_changed_at column — seed it from created_at wherever NULL so nothing
// badges on day one and the 21-day ghost mark arrives honestly. Only ever fills
// NULLs; never rewrites a status (D-19).
db.run(`UPDATE applications SET status_changed_at = created_at WHERE status_changed_at IS NULL`);

// D-18 link backfill (idempotent, every boot): queue rows inserted before the
// queue<->application link existed carry a NULL application_id. Link each to the
// NEWEST application whose normalizeUrl(url) matches the row's already-normalized
// url_key (newest-wins mirrors D-03 latest-fill-wins). No match => skip. This writes
// only queue.application_id — it never touches applications.status (D-19) — and
// self-heals on every boot because it reads only NULL application_id rows (D-21).
{
  const unlinked = db.query('SELECT id, url_key FROM queue WHERE application_id IS NULL AND url_key IS NOT NULL').all() as {
    id: number;
    url_key: string;
  }[];
  const apps = db.query('SELECT id, url FROM applications ORDER BY created_at DESC, id DESC').all() as {
    id: number;
    url: string;
  }[];
  for (const row of unlinked) {
    const appId = apps.find(a => normalizeUrl(a.url) === row.url_key)?.id ?? null;
    if (appId !== null) updateQueueStatus(db, row.id, { application_id: appId });
  }
}

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
    const spawn = spawnBatchRunner(runId);
    if (!spawn.spawned) {
      // Nothing will ever heartbeat or finish this row — record the failure
      // now, or the dead 'running' row wedges the single-flight lock until
      // heartbeat-stale reconciliation catches it.
      finishBatchRun(db, runId, 'failed', {
        headline: { filled: 0, skipped: 0, failed: 0 },
        stop_reason: 'interrupted',
        skipped: [],
        failed: [],
        filled: [],
        error: spawn.error,
      });
      console.error('[scheduler] batch spawn failed:', spawn.error);
    }
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
- Bullet pool (approved alternate bullets + tailoring cheat sheet): ${BULLET_POOL}
- the operator's profile/context (all experiences incl. ones not on the base resume): ${join(homedir(), '.claude/projects/-Users-you-resume/memory/user_profile.md')}
- Resume rules (MUST honor): ${join(homedir(), '.claude/projects/-Users-you-resume/memory/feedback_no_inflated_metrics.md')} and ${join(homedir(), '.claude/projects/-Users-you-resume/memory/feedback_drop_concentrations.md')}
- Job description: ${jdPath}

Write the tailored resume to exactly this path: ${texPath}

Also write a summary file to exactly this path: ${summaryPath}
Its shape must be exactly: { "company": string, "role": string, "summary": string[] }
- "company" and "role": infer from the job description file. Use "" if undeterminable.
- "summary": up to 3 lines, honest minimum — only real changes, no padding. Each line pairs the change made with the JD reason that drove it, e.g. "led with distributed-systems bullets — JD emphasizes scale". If the base resume already fits with minimal changes, return a single line like "minimal changes — base resume already fits this JD".

Hard rules:
- Facts come ONLY from the base resume and the bullet pool. Never invent or inflate metrics, titles, dates, or technologies. Every number must be interview-defensible.
- Tailor by SELECTING and REORDERING: swap in bullet-pool variants that better match the job description, reorder bullets and the skills lists to lead with what the JD emphasizes. Do not rewrite facts.
- ATS KEYWORD MIRRORING (researched, see docs/ats-research.md): recruiter retrieval on Greenhouse/Lever/Ashby is literal keyword SEARCH over parsed fields — there is no ranking score to beat. Where a bullet or skills entry truthfully describes the same technology or practice the JD names, use the JD's EXACT vocabulary ("Kubernetes" not "k8s", their phrasing of "CI/CD"). For JD-named technologies with a common acronym, write the spelled-out form with the acronym once — "Infrastructure as Code (IaC)" — since either form may be searched. Reorder the skills lists to mirror the JD's own ordering. NEVER add a skill or term the base resume and bullet pool don't already substantiate — mirroring adjusts spelling and order of true things, it never imports new claims.
- HUMAN SKIM: the real gate is a ~7-second recruiter scan. Under each experience entry, lead with the bullet most relevant to this JD. Never sacrifice scannability for keyword coverage — stuffing reads as spam and there is no algorithm it would help.
- Job titles are facts: never alter the operator's actual titles to match the target role. Contract work keeps its "(Contract)" label; dates stay month-year.
- Use the bullet pool's "Tailoring cheat sheet" to route JD keywords to the right experiences/projects. You MAY swap the second experience entry or a project entry for a pool-documented alternative (e.g. DocReserve founding-engineer for startup/early-stage/healthcare JDs, Vibecode for AI-agent JDs) when the cheat sheet clearly favors it — using only pool-approved bullets and the dates/titles from the profile file. Never swap out the VertikalX entry.
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
    // Attachment name is deliberately suffix-free: recruiters see this filename,
    // and the slug is 'unknown' whenever tailoring ran before mapping resolved
    // the company. The on-disk archive path (rounds/<slug>/<name>_<date>.pdf)
    // keeps the full provenance.
    name: 'resume.pdf',
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

// Phase 15: on-demand document generation (cover letter, interview-prep brief,
// follow-up email). Shared primitives factored from tailor()'s spawn/timeout/
// existence-check and two-pass pdflatex logic — tailor() itself is left untouched.

interface GenAppRow {
  id: number;
  company: string;
  role: string;
  url: string;
  jd: string;
  resume_path: string;
  tailor_state: string;
}

// Spawn CLAUDE_BIN exactly as tailor() does (array-form argv, never a shell
// string) and existence-check the expected output file afterward — claude -p
// can exit 0 without writing anything, so the exit code alone is not trusted.
async function runClaudeGen(prompt: string, expectPath: string, timeoutMs = 6 * 60 * 1000): Promise<void> {
  const proc = Bun.spawn(
    [CLAUDE_BIN, '-p', prompt, '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Write,Edit,Glob,Grep'],
    { cwd: RESUME_DIR, stdout: 'pipe', stderr: 'pipe' },
  );
  const timeout = setTimeout(() => proc.kill(), timeoutMs);
  const exit = await proc.exited;
  clearTimeout(timeout);
  if (!existsSync(expectPath)) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`Generation produced no output (claude exit ${exit}): ${err.slice(0, 300)}`);
  }
}

// Two-pass pdflatex compile, identical to tailor()'s (server.ts:384-395).
async function compilePdf(texPath: string, outDir: string): Promise<string> {
  for (let pass = 0; pass < 2; pass++) {
    const latex = Bun.spawn(
      [PDFLATEX, '-interaction=nonstopmode', `-output-directory=${outDir}`, texPath],
      { cwd: outDir, stdout: 'pipe', stderr: 'pipe' },
    );
    const latexTimeout = setTimeout(() => latex.kill(), 60 * 1000);
    await latex.exited;
    clearTimeout(latexTimeout);
  }
  const pdfPath = texPath.replace(/\.tex$/, '.pdf');
  if (!existsSync(pdfPath)) throw new Error('pdflatex did not produce a PDF — check the generated .tex for LaTeX errors.');
  return pdfPath;
}

// DOC-01/D-01/D-11: cover letter, PDF via LaTeX -> pdflatex, built from the
// application's ALREADY-TAILORED resume. Never builds a letter on a resume
// that doesn't exist (D-11's honest-input contract).
async function generateCoverLetter(app: GenAppRow): Promise<string> {
  if (app.tailor_state !== 'ran' || !app.resume_path) {
    throw new Error('no tailored resume for this application — tailor the resume first');
  }
  const outDir = safeOutDir(dirname(app.resume_path), ROUNDS_DIR);
  const slug = outDir.split('/').pop() || 'unknown';
  const stamp = new Date().toISOString().slice(0, 10);
  const tailoredTexPath = app.resume_path.replace(/\.pdf$/, '.tex');
  const jdPath = join(outDir, `jd_${stamp}.md`);
  const texPath = join(outDir, `CoverLetter_${slug}_${stamp}.tex`);
  await Bun.write(jdPath, `# ${app.role} @ ${app.company}\n${app.url ?? ''}\n\n${app.jd}`);

  const prompt = `You are writing a cover letter for the operator Example, in his own voice, for one specific job application.

Read these files:
- Base resume (LaTeX, for the letterhead/fonts/preamble to reuse): ${BASE_TEX}
- the operator's tailored resume for THIS application (LaTeX, the facts to draw on): ${tailoredTexPath}
- Bullet pool (approved alternate bullets): ${BULLET_POOL}
- the operator's profile/context (all real experiences, incl. ones not on the resume): ${USER_PROFILE}
- voice_profile.md — the operator's real writing voice, read it fully, the letter must sound like him: ${VOICE_PROFILE}
- Resume rules (MUST honor): ${NO_INFLATED_METRICS}
- Job description: ${jdPath}

Write the cover letter to exactly this path: ${texPath}

Hard rules:
- Facts come ONLY from the tailored resume, the bullet pool, and the operator's profile/context. Never invent or inflate metrics, titles, dates, or technologies — every claim must be interview-defensible.
- Voice: lowercase by default (including "i"), short 1-2 sentence paragraphs, no corporate buzzwords ("synergy", "leverage", "circle back"), no performative enthusiasm, no em-dash, no parenthetical asides/tells, minimal end-of-sentence punctuation. Match voice_profile.md's patterns exactly.
- Sign the letter as "max", never "the operator Example" or "Example". No "Dear Hiring Manager", no "Best regards".
- Reuse the base resume's LaTeX document class, preamble, and fonts (${BASE_TEX}) so the letter's letterhead matches the resume visually. Keep it to one page.
- Write exactly one file: the .tex above. No commentary, no other files.`;

  await runClaudeGen(prompt, texPath);
  return compilePdf(texPath, outDir);
}

// DOC-03/D-02: interview-prep brief, PDF via the same pdflatex pipeline,
// freer-form Q&A + gap-coverage shape (the operator-facing internal prep, not outbound
// prose — voice loading is not required here per D-13's discretion).
async function generateBrief(app: GenAppRow): Promise<string> {
  if (!app.jd || app.jd.length < 200) {
    throw new Error('job description too short to generate an interview-prep brief against');
  }
  const outDir = app.resume_path ? safeOutDir(dirname(app.resume_path), ROUNDS_DIR) : join(ROUNDS_DIR, slugify(app.company));
  mkdirSync(outDir, { recursive: true });
  const slug = outDir.split('/').pop() || 'unknown';
  const stamp = new Date().toISOString().slice(0, 10);
  const jdPath = join(outDir, `jd_${stamp}.md`);
  const texPath = join(outDir, `Brief_${slug}_${stamp}.tex`);
  await Bun.write(jdPath, `# ${app.role} @ ${app.company}\n${app.url ?? ''}\n\n${app.jd}`);

  const prompt = `You are preparing the operator Example for an interview at one specific company, based on a job description.

Read these files:
- Base resume (LaTeX, for the preamble/fonts to reuse): ${BASE_TEX}
- Job description: ${jdPath}
- the operator's recorded interview gaps (areas he has struggled to answer well before): ${INTERVIEW_GAPS}
- the operator's profile/context (all real experiences, incl. ones not on the resume): ${USER_PROFILE}
- Bullet pool (approved alternate bullets, for concrete talking points): ${BULLET_POOL}

Write the brief to exactly this path: ${texPath}

The brief is for the operator's own eyes before the interview — freer-form than a resume. Include:
1. A "likely questions" section: 5-8 questions this specific job description makes likely (tech stack, domain, seniority level), each with a short bullet-point answer outline drawn from the operator's real experience.
2. A "gap coverage" section: for each gap recorded in the interview-gaps file, one short paragraph on how the operator could address it if it comes up in this interview, grounded in his real background.

Hard rules:
- Facts come ONLY from the resume, the bullet pool, the operator's profile/context, and the recorded gaps. Never invent or inflate metrics, titles, dates, or technologies — every claim must be interview-defensible.
- Reuse the base resume's LaTeX document class, preamble, and fonts (${BASE_TEX}) so the brief compiles cleanly with pdflatex. This is internal prep, not outbound prose — plain, direct language is fine.
- Write exactly one file: the .tex above. No commentary, no other files.`;

  await runClaudeGen(prompt, texPath);
  return compilePdf(texPath, outDir);
}

// DOC-02/D-03/D-08/D-09/D-10: follow-up email, plain .md text (never a PDF —
// it's a draft to paste into Gmail, not a document to file).
async function generateEmail(app: GenAppRow): Promise<string> {
  if (!app.jd || app.jd.length < 200) {
    throw new Error('job description too short to generate a follow-up email against');
  }
  const outDir = app.resume_path ? safeOutDir(dirname(app.resume_path), ROUNDS_DIR) : join(ROUNDS_DIR, slugify(app.company));
  mkdirSync(outDir, { recursive: true });
  const slug = outDir.split('/').pop() || 'unknown';
  const stamp = new Date().toISOString().slice(0, 10);
  const jdPath = join(outDir, `jd_${stamp}.md`);
  const mdPath = join(outDir, `FollowUp_${slug}_${stamp}.md`);
  await Bun.write(jdPath, `# ${app.role} @ ${app.company}\n${app.url ?? ''}\n\n${app.jd}`);

  const prompt = `You are writing a short follow-up email for the operator Example, in his own voice, to send after applying for one specific job. This is NOT a post-interview thank-you.

Read these files:
- voice_profile.md — the operator's real writing voice, read it fully, the email must sound like him: ${VOICE_PROFILE}
- the operator's profile/context (all real experiences, incl. ones not on the resume): ${USER_PROFILE}
- Resume rules (MUST honor): ${NO_INFLATED_METRICS}
- Job description: ${jdPath}

Write the email to exactly this path: ${mdPath}, as plain text (no LaTeX, no markdown headers).

Content:
- A short statement-of-interest follow-up sent after applying to ${app.role} at ${app.company} — reaffirming interest, NOT a thank-you for an interview.
- Draw on the company, the role, and exactly ONE concrete hook from the job description (a specific responsibility or technology) that shows genuine fit. One hook, not keyword-mining.
- 3-5 lines total. Short paragraphs, context-then-ask.

Hard rules:
- Facts come ONLY from the operator's profile/context and the job description. Never invent or inflate metrics, titles, dates, or technologies — every claim must be interview-defensible.
- Voice: lowercase by default (including "i"), no corporate buzzwords, no performative enthusiasm, no em-dash, no parenthetical asides/tells, minimal end-of-sentence punctuation. Match voice_profile.md's patterns exactly.
- Sign as "max", never "the operator Example" or "Example". No "Dear Hiring Manager", no "Best regards".
- Write exactly one file: the .md above. No commentary, no other files.`;

  await runClaudeGen(prompt, mdPath);
  return mdPath;
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
        // D-08: explicit jd-free column list — SELECT * would silently ship the
        // multi-KB jd column into the list payload refetched on every load/patch.
        const rows = db
          .query(
            `SELECT id, company, role, url, status, notes, resume_path, cost_usd, summary,
                    tailor_state, tailor_message,
                    cover_letter_path,
                    brief_path,
                    email_path,
                    status_changed_at, created_at, updated_at
             FROM applications ORDER BY created_at DESC`
          )
          .all() as {
          url: string;
          summary: string;
          status: string;
          status_changed_at: string | null;
        }[];
        // D-14: attach derived ghosted + days_silent per row (nothing stored).
        const mapped = rows.map(row => ({ ...row, summary: parseSummary(row.summary), ...deriveGhost(row) }));
        const urlParam = new URL(req.url).searchParams.get('url');
        if (urlParam === null) return json(mapped);
        const target = normalizeUrl(urlParam);
        return json(mapped.filter(row => normalizeUrl(row.url) === target));
      }
      if (pathname === '/applications' && req.method === 'POST') {
        const b = await req.json();
        // D-02: prefer the explicit queue_id from the extension; else fall back to a
        // normalizeUrl match against queue.url_key (already normalized + UNIQUE-indexed,
        // cheaper than re-normalizing every queue.url) — same resolution shape as
        // /answers (:496-501) and /failures (:539-546).
        const resolveQueueId = (url: string): number | null => {
          const target = normalizeUrl(url);
          if (!target) return null;
          const rows = db.query('SELECT id, url_key FROM queue ORDER BY created_at DESC, id DESC').all() as {
            id: number;
            url_key: string | null;
          }[];
          return rows.find(r => r.url_key === target)?.id ?? null;
        };
        // WR-01: an explicit queue_id is only trusted when the target row's url_key
        // actually equals normalizeUrl(b.url) — the exact-equality the resolveQueueId
        // fallback already enforces. A stale/wrong/spoofed id therefore can no longer
        // cross-link this application onto an unrelated queue row (defense-in-depth at
        // the same-origin/token boundary the phase brief flagged).
        const target = normalizeUrl(b.url ?? '');
        const explicit = Number(b.queue_id);
        let queueId: number | null = null;
        if (Number.isInteger(explicit) && explicit > 0 && target) {
          const q = db.query('SELECT url_key FROM queue WHERE id = ?').get(explicit) as { url_key: string | null } | null;
          if (q && q.url_key === target) queueId = explicit;
        }
        if (queueId === null) queueId = resolveQueueId(b.url ?? '');
        try {
          // insertApplication defaults the new row to PRE_SUBMIT_STATUS (D-06).
          const row = insertApplication(db, b, resolveQueueId);
          // D-02/D-03: write the queue<->application link (latest fill wins; the
          // orphaned earlier application row is left untouched as history).
          if (queueId !== null) updateQueueStatus(db, queueId, { application_id: row.id });
          return json(row, 201);
        } catch (e) {
          if (e instanceof InvalidApplicationStatusError) return json({ error: e.message }, 400);
          throw e;
        }
      }
      // D-07: on-demand lazy-load route for a single row's jd, kept out of the
      // list payload above. Parameterized id lookup — never string-concatenated.
      const jdMatch = pathname.match(/^\/applications\/(\d+)\/jd$/);
      if (jdMatch && req.method === 'GET') {
        const row = db.query('SELECT jd FROM applications WHERE id = ?').get(Number(jdMatch[1])) as { jd: string } | null;
        if (!row) return json({ error: 'not found' }, 404);
        return json({ jd: row.jd ?? '' });
      }
      const patch = pathname.match(/^\/applications\/(\d+)$/);
      if (patch && req.method === 'PATCH') {
        const b = await req.json();
        try {
          // Delegates the ['status','notes'] whitelist, enum allowlist, D-11
          // conditional status_changed_at bump, and D-12 unconditional updated_at.
          const row = updateApplicationStatus(db, Number(patch[1]), b);
          if (!row) return json({ error: 'not found' }, 404);
          return json(row);
        } catch (e) {
          if (e instanceof InvalidApplicationStatusError) return json({ error: e.message }, 400);
          throw e;
        }
      }
      // POST /applications/:id/generate/:doctype — the ONLY entry point to the
      // three on-demand document generators (DOC-05: explicit-click only, never
      // called from any sweep/batch/fill path). T-15-01: every generation input
      // (company/role/url/jd/resume_path/tailor_state) is resolved server-side
      // from the applications row keyed by id — the request body never supplies
      // a path or slug. No per-route try/catch: a thrown generator error surfaces
      // as a 500 with its message via the global wrapper below.
      const genMatch = pathname.match(/^\/applications\/(\d+)\/generate\/([^/]+)$/);
      if (genMatch && req.method === 'POST') {
        const doctype = genMatch[2];
        if (doctype !== 'cover-letter' && doctype !== 'brief' && doctype !== 'email') {
          return json({ error: 'invalid doc type' }, 400);
        }
        const id = Number(genMatch[1]);
        const app = db
          .query('SELECT id, company, role, url, jd, resume_path, tailor_state FROM applications WHERE id = ?')
          .get(id) as GenAppRow | null;
        if (!app) return json({ error: 'not found' }, 404);

        let producedPath: string;
        let column: 'cover_letter_path' | 'brief_path' | 'email_path';
        if (doctype === 'cover-letter') {
          producedPath = await generateCoverLetter(app);
          column = 'cover_letter_path';
        } else if (doctype === 'brief') {
          producedPath = await generateBrief(app);
          column = 'brief_path';
        } else {
          producedPath = await generateEmail(app);
          column = 'email_path';
        }

        // column is one of the three literals selected above — never derived
        // from the request body or path param, so this is not a SQL-injection surface.
        db.query(`UPDATE applications SET ${column} = ?, updated_at = datetime('now') WHERE id = ?`).run(
          producedPath,
          id,
        );
        const updated = db
          .query(
            `SELECT id, company, role, url, status, notes, resume_path, cost_usd, summary,
                    tailor_state, tailor_message, cover_letter_path, brief_path, email_path,
                    status_changed_at, created_at, updated_at
             FROM applications WHERE id = ?`,
          )
          .get(id);
        return json(updated);
      }

      // GET /applications/:id/doc/:doctype — D-06: streams a generated
      // cover-letter or brief PDF inline so it's reachable in one click from
      // the applications tab, mirroring GET /queue/:id/resume. T-15-03
      // (LOAD-BEARING): the served root is ROUNDS_DIR, not RESUME_DIR — a
      // RESUME_DIR root would also accept the base resume tree, wider than
      // this route's intent. safeDocPath does resolve -> assert-under-root ->
      // extension check -> existence check; any failure streams nothing.
      const docMatch = pathname.match(/^\/applications\/(\d+)\/doc\/([^/]+)$/);
      if (docMatch && req.method === 'GET') {
        const doctype = docMatch[2];
        if (doctype !== 'cover-letter' && doctype !== 'brief') {
          return json({ error: 'invalid doc type' }, 400);
        }
        const row = db
          .query('SELECT cover_letter_path, brief_path FROM applications WHERE id = ?')
          .get(Number(docMatch[1])) as { cover_letter_path: string; brief_path: string } | null;
        if (!row) return json({ error: 'not found' }, 404);
        const candidate = doctype === 'cover-letter' ? row.cover_letter_path : row.brief_path;
        if (!candidate) return json({ error: 'document not generated yet' }, 404);
        const full = safeDocPath(candidate, ROUNDS_DIR, '.pdf');
        if (!full) return json({ error: 'document file not found on disk' }, 404);
        return new Response(Bun.file(full), {
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': `inline; filename="${full.split('/').pop()}"`,
            // WR-01: doctype/date-stamped filenames collide on same-day regeneration
            // (same URL serves the overwritten PDF) — no-store so a browser never
            // reuses a cached response from before the regeneration.
            'cache-control': 'no-store',
          },
        });
      }

      // GET /applications/:id/email — D-07: the follow-up email draft served
      // back inline as JSON for the read-back box, reusing the JD toggle
      // pattern verbatim. T-15-04: safeDocPath runs BEFORE the file read, so
      // an out-of-ROUNDS_DIR path is never opened.
      const emailMatch = pathname.match(/^\/applications\/(\d+)\/email$/);
      if (emailMatch && req.method === 'GET') {
        const row = db.query('SELECT email_path FROM applications WHERE id = ?').get(Number(emailMatch[1])) as
          | { email_path: string }
          | null;
        if (!row) return json({ error: 'not found' }, 404);
        if (!row.email_path) return json({ email: '' });
        const full = safeDocPath(row.email_path, ROUNDS_DIR, '.md');
        if (!full) return json({ error: 'document file not found on disk' }, 404);
        const text = await Bun.file(full).text();
        // WR-01: same same-day-regeneration staleness risk as the PDF route above —
        // no-store so a re-fetch after regenerating always gets the fresh draft.
        return new Response(JSON.stringify({ email: text }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        });
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
      // GET /profile — serve profile.local.json (source of truth on disk) so any
      // browser's copy of the extension can self-seed instead of requiring a
      // manual options-page import per browser.
      if (pathname === '/profile' && req.method === 'GET') {
        const profilePath = join(HERE, '..', 'profile.local.json');
        if (!existsSync(profilePath)) return json({ error: 'profile.local.json not found' }, 404);
        return json(JSON.parse(await Bun.file(profilePath).text()));
      }
      // GET /queue/:id/resume — stream the PDF that was attached to this row's fill
      // so the operator can review the actual content before submitting. Resolution mirrors
      // the resume_name backfill: latest tailored application for the row's url,
      // else the static base resume. Path containment: only .pdf files under
      // ~/resume/ are ever served — resume_path is our own tailor output, but the
      // guard makes traversal impossible regardless of what the DB holds.
      const queueResume = pathname.match(/^\/queue\/(\d+)\/resume$/);
      if (queueResume && req.method === 'GET') {
        const row = db.query('SELECT url FROM queue WHERE id = ?').get(Number(queueResume[1])) as { url: string } | null;
        if (!row) return json({ error: 'queue row not found' }, 404);
        const app = db
          .query(`SELECT resume_path FROM applications WHERE url = ? AND tailor_state = 'ran' AND resume_path != '' ORDER BY id DESC`)
          .get(row.url) as { resume_path: string } | null;
        const candidate = app?.resume_path || join(RESUME_DIR, 'resume.pdf');
        const full = resolve(candidate);
        if (!full.startsWith(resolve(RESUME_DIR) + '/') || !full.endsWith('.pdf') || !existsSync(full)) {
          return json({ error: 'resume file not found on disk' }, 404);
        }
        return new Response(Bun.file(full), {
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': `inline; filename="${full.split('/').pop()}"`,
          },
        });
      }
      // POST /fill/:id — spawn a Playwright single fill for one queued row via
      // the runner protocol, so filling never depends on which browser the
      // dashboard is open in (the runner browser carries its own extension +
      // API key). Guards return honest 4xx instead of silent no-ops; runner.mjs
      // itself enforces queued-only + single-instance on top of these.
      const fillSpawn = pathname.match(/^\/fill\/(\d+)$/);
      if (fillSpawn && req.method === 'POST') {
        const row = db.query('SELECT * FROM queue WHERE id = ?').get(Number(fillSpawn[1])) as
          | { id: number; status: string; login_gated: number; not_fillable: number }
          | null;
        if (!row) return json({ error: 'queue row not found' }, 404);
        if (row.status !== 'queued') {
          return json({ error: `row is '${row.status}' — the runner fills queued rows only. Re-queue it first if you want a fresh fill.` }, 409);
        }
        if (row.login_gated) {
          return json({ error: 'login-gated posting — fill it from the extension popup in your signed-in browser (the runner browser has no logins).' }, 400);
        }
        if (row.not_fillable) return json({ error: 'row is flagged not fillable' }, 400);
        const sweepNow = getRunningSweep(db);
        if (sweepNow) return json({ error: 'sweep running', runId: sweepNow.id }, 409);
        reconcileInterruptedBatchRuns(db);
        const batchNow = getRunningBatch(db);
        if (batchNow) return json({ error: 'batch already running', runId: batchNow.id }, 409);
        const spawn = spawnFillRunner(row.id);
        if (!spawn.spawned) return json({ error: `runner spawn failed: ${spawn.error}` }, 500);
        // Fire-and-forget: the row's status (queued -> filling -> filled) is the
        // result channel. If the runner browser is already open (profile lock),
        // the spawn exits without touching the row — surfaced as a hint here.
        return json({ started: true, queueId: row.id, note: "watch the row status — if it stays 'queued', the runner browser is already open (close it or review pending tabs first)." });
      }
      const queuePatch = pathname.match(/^\/queue\/(\d+)$/);
      if (queuePatch && req.method === 'PATCH') {
        const b = await req.json();
        try {
          // WR-03: capture the pre-patch status so the cascade gates on the submit
          // TRANSITION, not merely the resulting state — otherwise a later non-status
          // patch (e.g. a runner writing results_summary/error) that leaves the row at
          // 'submitted' would re-fire and clobber a human-regressed application.
          const before = db.query('SELECT status FROM queue WHERE id = ?').get(Number(queuePatch[1])) as
            | { status: string }
            | null;
          const row = updateQueueStatus(db, Number(queuePatch[1]), b);
          // D-07: react to the human markSubmitted() click — when THIS patch actually
          // MOVED the row into 'submitted' (gated on the RETURNED row, never b.status, so a
          // WR-05-refused regression triggers nothing; and on before?.status !== 'submitted'
          // so only the transition fires) and the row links an application, promote that
          // application off its pre-submit status in the same round trip. The cascade
          // constructs NO 'submitted' status (D-02) — markSubmitted() stays the sole
          // producer; promoteUnsubmittedToApplied only ever writes 'applied' onto an
          // already-'unsubmitted' row and is idempotent for a re-submitted row.
          if (row && row.status === 'submitted' && before?.status !== 'submitted' && row.application_id) {
            promoteUnsubmittedToApplied(db, row.application_id);
          }
          return json(row);
        } catch (e) {
          if (e instanceof InvalidQueueStatusError) return json({ error: e.message }, 400);
          throw e;
        }
      }
      if (queuePatch && req.method === 'DELETE') {
        const result = deleteQueueEntry(db, Number(queuePatch[1]));
        if (!result.deleted) {
          return json({ error: result.reason }, result.reason === 'not found' ? 404 : 409);
        }
        return json({ deleted: true });
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
        const spawn = spawnBatchRunner(runId);
        if (!spawn.spawned) {
          // Same as checkBatchSchedule: an unrecorded spawn failure would
          // orphan the 'running' row. Still return the run id — the caller's
          // poll sees the 'failed' row immediately.
          finishBatchRun(db, runId, 'failed', {
            headline: { filled: 0, skipped: 0, failed: 0 },
            stop_reason: 'interrupted',
            skipped: [],
            failed: [],
            filled: [],
            error: spawn.error,
          });
          console.error('[batch] spawn failed:', spawn.error);
        }
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
