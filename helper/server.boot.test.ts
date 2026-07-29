import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// server.ts is the one module no other test loads: it calls Bun.serve() at import
// time, so nothing imports it, and 632 passing tests therefore said nothing about
// whether it can even be evaluated. Twice in one session a missing import shipped
// green here and only surfaced as a launchd crash-loop — `storePostingJD is not
// defined`, then `resolveJDFetch`. Both are module-level ReferenceErrors that any
// evaluation of this file would have caught.
//
// Evaluated in a SUBPROCESS against a throwaway db (JOBFILL_DB), because
// importing it in-process would bind port 7877 and fight the running helper.
//
// EADDRINUSE is a PASS: reaching the listen call means every import resolved and
// every module-level statement ran. The failure this guards against is the
// process dying BEFORE that with a Reference/TypeError.
test('helper/server.ts evaluates end-to-end without a module-level Reference/TypeError', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobfill-boot-'));
  try {
    const proc = Bun.spawn(['bun', join(dirname(fileURLToPath(import.meta.url)), 'server.ts')], {
      env: { ...process.env, JOBFILL_DB: join(dir, 'smoke.db') },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    // Give module evaluation time to finish, then stop it either way — this test
    // must never leave a stray server bound.
    await Bun.sleep(3000);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    proc.kill();

    const booted = stdout.includes('jobfill helper on');
    const portTaken = /EADDRINUSE|address already in use/i.test(stderr);
    expect(stderr).not.toMatch(/ReferenceError|TypeError|is not defined/);
    expect(booted || portTaken).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
