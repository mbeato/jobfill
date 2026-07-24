import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

// Shared lexical containment check: is `full` (an already-resolve()'d path)
// rooted under `root`? Both safeDocPath (read side) and safeOutDir (write
// side, CR-01) call this so the traversal defense lives in exactly one place.
function containedUnder(full: string, root: string): boolean {
  return full.startsWith(resolve(root) + '/');
}

// Pure path-traversal guard, generalized from the GET /queue/:id/resume route
// (server.ts:641-659). Kept in its own module (not server.ts) so it stays
// importable by a test without triggering server.ts's Bun.serve() side effect
// on import. Four checks, in order: resolve -> assert-under-root -> extension
// allowlist -> existence. This is the single reusable traversal defense the
// wave-2 doc-serving routes call.
export function safeDocPath(candidate: string, root: string, ext: string): string | null {
  const full = resolve(candidate);
  if (!containedUnder(full, root)) return null;
  if (!full.endsWith(ext)) return null;
  if (!existsSync(full)) return null;
  // WR-03: resolve() only normalizes the path string — it does not dereference
  // symlinks. Re-check containment against the REAL (symlink-resolved) path so a
  // file under root that is itself a symlink pointing outside root can't pass.
  // realpathSync only throws for a path that doesn't exist, and existsSync just
  // confirmed `full` exists, so this is not expected to throw in practice —
  // still guarded defensively (return null, never let it escape as a 500).
  try {
    const realFull = realpathSync(full);
    const realRoot = realpathSync(resolve(root));
    if (!realFull.startsWith(realRoot + '/')) return null;
  } catch {
    return null;
  }
  return full;
}

// CR-01: write-path containment guard. The three on-demand generators
// (generateCoverLetter/generateBrief/generateEmail) derive their output
// directory from applications.resume_path, which is untrusted past the POST
// /applications body (T-13-01 — "the trust boundary is the POST body, not the
// extension"), and use it directly as an mkdirSync/Bun.write/pdflatex
// -output-directory root. This must never resolve outside `root` (ROUNDS_DIR).
// Throws rather than returning null, mirroring the "no tailored resume for
// this application" guard the generators already throw — the global route
// catch surfaces it as a 4xx/5xx-style error message the same way.
export function safeOutDir(candidateDir: string, root: string): string {
  const full = resolve(candidateDir);
  if (!containedUnder(full, root)) {
    throw new Error('refusing to write outside the rounds directory');
  }
  return full;
}
