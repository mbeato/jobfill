import { Database } from 'bun:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

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

// Shared secret with the extension (must match HELPER_TOKEN in extension/background.js).
// No CORS headers are served: cross-origin pages can neither read responses nor pass
// preflight, so only the extension (token) and the same-origin dashboard get through.
const TOKEN = 'REDACTED-TOKEN';

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

function normalizeUrl(u: string): string {
  const raw = String(u ?? '').trim().slice(0, 300);
  try {
    const parsed = new URL(raw);
    const path = parsed.pathname.replace(/\/$/, '');
    return `${parsed.host.toLowerCase()}${path}`;
  } catch {
    return raw;
  }
}

async function tailor(body: { company: string; role: string; jd: string; url?: string }) {
  if (!body.jd || body.jd.length < 200) throw new Error('Job description too short to tailor against.');
  const slug = slugify(body.company);
  const outDir = join(ROUNDS_DIR, slug);
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const texName = `resume_${slug}_${stamp}.tex`;
  const texPath = join(outDir, texName);
  const jdPath = join(outDir, `jd_${stamp}.md`);
  await Bun.write(jdPath, `# ${body.role} @ ${body.company}\n${body.url ?? ''}\n\n${body.jd}`);

  const prompt = `You are tailoring the operator Example's resume for one specific job application.

Read these files:
- Base resume (LaTeX): ${BASE_TEX}
- Bullet pool (approved alternate bullets): ${BULLET_POOL}
- Job description: ${jdPath}

Write the tailored resume to exactly this path: ${texPath}

Hard rules:
- Facts come ONLY from the base resume and the bullet pool. Never invent or inflate metrics, titles, dates, or technologies. Every number must be interview-defensible.
- Tailor by SELECTING and REORDERING: swap in bullet-pool variants that better match the job description, reorder bullets and the skills lists to lead with what the JD emphasizes. Do not rewrite facts.
- Keep the base resume's LaTeX preamble, commands, and structure exactly. The result must compile with pdflatex and stay one page.
- Bullets marked with warning symbols in the pool need re-verification — do not use them.
- Write only the .tex file. No commentary, no other files.`;

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
  const pdfPath = texPath.replace(/\.tex$/, '.pdf');
  if (!existsSync(pdfPath)) throw new Error('pdflatex did not produce a PDF — check the tailored .tex for LaTeX errors.');

  const pdfBytes = await Bun.file(pdfPath).arrayBuffer();
  return {
    name: `resume_${slug}.pdf`,
    path: pdfPath,
    b64: Buffer.from(pdfBytes).toString('base64'),
    mime: 'application/pdf',
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
            `INSERT INTO applications (company, role, url, resume_path, cost_usd, summary)
             VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
          )
          .get(
            b.company ?? 'unknown',
            b.role ?? '',
            b.url ?? '',
            b.resume_path ?? '',
            b.cost_usd ?? 0,
            Array.isArray(b.summary) && b.summary.length ? JSON.stringify(b.summary) : '',
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
      if (pathname === '/tailor' && req.method === 'POST') {
        return json(await tailor(await req.json()));
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String((e as Error).message ?? e) }, 500);
    }
  },
});

console.log(`jobfill helper on http://127.0.0.1:${PORT} (dashboard at /)`);
