// Renders the committed LaunchAgent plist template with a dynamically-resolved
// absolute bun path (never a hardcoded guess — this machine has two separate
// bun installs, see 11-RESEARCH Pitfall 1) and bootstraps it via the modern
// launchctl verb. The rendered plist lands outside the repo (~/Library/
// LaunchAgents) and is never committed — only the .template is.

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = process.cwd(); // run via `bun run agent:install` from repo root
const HOME = homedir();
const BUN_ABS_PATH = execSync('command -v bun').toString().trim(); // resolved, not guessed
const BUN_DIR = BUN_ABS_PATH.replace(/\/bun$/, '');
const LABEL = 'com.jobfill.helper';
const PLIST_PATH = join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);

mkdirSync(join(HOME, 'Library', 'Logs', 'jobfill'), { recursive: true });

const template = readFileSync(join(REPO_ROOT, 'scripts/launchd/com.jobfill.helper.plist.template'), 'utf8');
const rendered = template
  .replaceAll('{{BUN_ABS_PATH}}', BUN_ABS_PATH)
  .replaceAll('{{BUN_DIR}}', BUN_DIR)
  .replaceAll('{{REPO_ROOT}}', REPO_ROOT)
  .replaceAll('{{HOME}}', HOME);

writeFileSync(PLIST_PATH, rendered);
execSync(`launchctl bootstrap gui/${process.getuid()} "${PLIST_PATH}"`, { stdio: 'inherit' });
console.log(`[agent-install] bootstrapped ${LABEL} using bun at ${BUN_ABS_PATH}`);
