// The single operational readout (D-08): launchctl state, a live helper ping,
// and the last sweep's outcome from GET /sweeps — one place to look when
// something seems off.

import { execSync } from 'node:child_process';

const HELPER = 'http://127.0.0.1:7877';
const TOKEN = process.env.JOBFILL_TOKEN ?? 'REDACTED-TOKEN';
const LABEL = 'com.jobfill.helper';

console.log('[agent-status] launchd:');
try {
  const output = execSync(`launchctl print gui/${process.getuid()}/${LABEL}`).toString();
  console.log(
    output
      .split('\n')
      .filter(line => /state|pid|last exit/i.test(line))
      .map(line => `  ${line.trim()}`)
      .join('\n') || '  (loaded, no state/pid/last-exit lines found)',
  );
} catch {
  console.log('  not loaded (run bun run agent:install)');
}

console.log('[agent-status] helper ping:');
try {
  const res = await fetch(`${HELPER}/sweeps?limit=1`, { headers: { 'x-jobfill-token': TOKEN } });
  if (!res.ok) {
    console.log(`  helper responded with HTTP ${res.status}`);
  } else {
    const [row] = await res.json();
    if (!row) {
      console.log('  helper responding, no sweeps recorded yet');
    } else {
      const headline = row.detail?.headline;
      console.log(`  last sweep: started ${row.started_at}, trigger ${row.trigger}, status ${row.status}`);
      if (headline) {
        console.log(
          `  headline: fetched ${headline.fetched}, queued ${headline.queued}, held ${headline.held}, rejected ${headline.rejected}`,
        );
      }
    }
  }
} catch {
  console.log('  helper not responding on :7877');
}

console.log('[agent-status] note: the LaunchAgent only runs while the operator is logged in (locked screen is fine, logged-out is not)');
