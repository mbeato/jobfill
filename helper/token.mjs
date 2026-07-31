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

// Announce a token the moment it is minted, so a first-time user is told what to
// do with it instead of having to know that a dotfile appeared. Printed ONCE, by
// whichever process wins the exclusive create — never on subsequent reads.
//
// The token itself is printed only to an interactive terminal. Under launchd the
// helper's stdout is redirected to ~/Library/Logs/jobfill/stdout.log, which is
// mode 644 — writing the secret there would hand it to any other user on the
// machine, which is precisely the exposure the 0600 mode on the token file exists
// to prevent. Non-TTY callers get a pointer to the file instead of its contents.
function announceNewToken(file, token) {
  if (process.env.JOBFILL_QUIET_TOKEN === '1') return;
  if (process.stdout.isTTY) {
    process.stdout.write(
      `\njobfill: generated a per-install helper token\n\n    ${token}\n\n` +
        `Paste it into the extension's options page (chrome://extensions -> jobfill ->\n` +
        `Details -> Extension options -> Helper token), then Save.\n` +
        `Stored at ${file} (mode 0600). Keep it out of version control.\n\n`,
    );
  } else {
    process.stdout.write(
      `jobfill: generated a per-install helper token at ${file} (mode 0600). ` +
        `Run \`cat ${file}\` in a terminal to read it — not printing it here, ` +
        `because this output may be a world-readable log file.\n`,
    );
  }
}

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
    announceNewToken(file, generated);
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
