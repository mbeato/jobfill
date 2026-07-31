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

  const generated = randomBytes(16).toString('hex');
  writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}
