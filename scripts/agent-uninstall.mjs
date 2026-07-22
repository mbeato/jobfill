// Bootouts the LaunchAgent (tolerating "not loaded") and removes the rendered
// plist. The committed template under scripts/launchd/ is untouched.

import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const LABEL = 'com.jobfill.helper';
const PLIST_PATH = join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);

try {
  execSync(`launchctl bootout gui/${process.getuid()}/${LABEL}`, { stdio: 'inherit' });
  console.log(`[agent-uninstall] bootout ${LABEL}`);
} catch {
  console.log(`[agent-uninstall] ${LABEL} was not loaded`);
}

if (existsSync(PLIST_PATH)) {
  rmSync(PLIST_PATH);
  console.log(`[agent-uninstall] removed ${PLIST_PATH}`);
} else {
  console.log(`[agent-uninstall] no rendered plist to remove`);
}
