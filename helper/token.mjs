import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Per-install helper token. Precedence: JOBFILL_TOKEN env var, then the
// trimmed contents of TOKEN_FILE, then generate-and-persist a fresh one.
// Plain ESM (not TypeScript) because it is imported by both helper/server.ts
// (bun) and the scripts/*.mjs CLIs (node), and node cannot import .ts.

const HERE = dirname(fileURLToPath(import.meta.url));

export const TOKEN_FILE = join(HERE, '..', '.jobfill-token');

export function resolveToken({ file = TOKEN_FILE } = {}) {
  const envToken = process.env.JOBFILL_TOKEN;
  if (typeof envToken === 'string' && envToken.trim() !== '') {
    return envToken.trim();
  }

  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing !== '') return existing;
  }

  // Exclusive create, not a plain write. resolveToken() is called at module-load
  // time by helper/server.ts and by all seven scripts/*.mjs CLIs independently, so
  // on a genuinely fresh install two processes can both see the file missing (e.g.
  // the launchd helper's first boot racing an operator's first `npm run seek`).
  // With a plain write both generate different tokens and the loser keeps its own
  // orphaned value for its whole process lifetime, 403ing against the helper until
  // restarted. 'wx' makes exactly one process the winner; everyone else reads it.
  const generated = randomBytes(16).toString('hex');
  try {
    writeFileSync(file, generated, { mode: 0o600, flag: 'wx' });
    return generated;
  } catch (e) {
    if (e.code === 'EEXIST') {
      const winner = readFileSync(file, 'utf8').trim();
      if (winner !== '') return winner;
      // Raced against a writer that has created but not yet filled the file.
      // Overwrite rather than return empty — an empty token authorises nothing.
      writeFileSync(file, generated, { mode: 0o600 });
      return generated;
    }
    throw e;
  }
}
