import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Pure path-traversal guard, generalized from the GET /queue/:id/resume route
// (server.ts:641-659). Kept in its own module (not server.ts) so it stays
// importable by a test without triggering server.ts's Bun.serve() side effect
// on import. Four checks, in order: resolve -> assert-under-root -> extension
// allowlist -> existence. This is the single reusable traversal defense the
// wave-2 doc-serving routes call.
export function safeDocPath(candidate: string, root: string, ext: string): string | null {
  const full = resolve(candidate);
  if (!full.startsWith(resolve(root) + '/')) return null;
  if (!full.endsWith(ext)) return null;
  if (!existsSync(full)) return null;
  return full;
}
