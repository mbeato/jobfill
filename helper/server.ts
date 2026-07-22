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
import { createPostingsTable, upsertPosting, recordDecision, listPostingsToDecide } from './seek/postings';
import { loadSeekConfig } from './seek/config';
import { runSweep } from './seek/sweep';
import { fetchGreenhouse } from './seek/greenhouse';
import { fetchLever } from './seek/lever';
import { fetchAshby } from './seek/ashby';
import { fetchHNPostings } from './seek/hn';
import type { SourceName } from './seek/types';
import { classifyMetadata, classifyYoe } from './seek/filter';
import { fetchJD } from './seek/jd-fetch';
import { scoreRelevance, loadProfileSummary } from './seek/relevance';
import { promotePosting } from './seek/promote';
import { runFilterPromote } from './seek/decide';

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

// Partial UNIQUE index: covers every backfilled row, exempts only the rare
// oldest-wins collision-duplicate rows intentionally left NULL above.
db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_url_key ON queue(url_key) WHERE url_key IS NOT NULL');

// D-15 last-sweep summary store: a tiny key/value table, one JSON row.
db.run('CREATE TABLE IF NOT EXISTS seek_meta (key TEXT PRIMARY KEY, value TEXT)');

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
      if (pathname === '/seek' && req.method === 'POST') {
        const config = await loadSeekConfig();
        const fetchResults = await runSweep(db, config, {
          fetchGreenhouse,
          fetchLever,
          fetchAshby,
          fetchHNPostings,
          upsertPosting,
        });
        // D-09 escape hatch: ?filter=0 skips the filter->promote stage entirely
        // (discovery-only debugging). The prior last-sweep summary is preserved.
        const noFilter = new URL(req.url).searchParams.get('filter') === '0';
        if (noFilter) return json({ fetch: fetchResults, filter: null });

        const filterCounts = await runFilterPromote(db, {
          classifyMetadata,
          classifyYoe,
          fetchJD,
          scoreRelevance,
          loadProfileSummary,
          promotePosting,
          recordDecision,
          listPostingsToDecide,
        });
        const fetchedTotal = fetchResults.reduce((sum, r) => sum + (r.fetched ?? 0), 0);
        // D-15: rejected folds in deduped (decide.ts stores dedupe rejections as
        // decision='rejected' too, matching how /postings groups them) — deduped
        // is also carried separately for the dashboard's expandable breakdown.
        const lastSweep = {
          at: new Date().toISOString(),
          fetched: fetchedTotal || filterCounts.toDecide,
          rejected: filterCounts.rulesRejected + filterCounts.llmRejected + filterCounts.deduped,
          deduped: filterCounts.deduped,
          held: filterCounts.held,
          queued: filterCounts.queued,
          byCriterion: filterCounts.byCriterion,
        };
        db.run('INSERT OR REPLACE INTO seek_meta(key, value) VALUES (?, ?)', ['last_sweep', JSON.stringify(lastSweep)]);
        return json({ fetch: fetchResults, filter: filterCounts });
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
