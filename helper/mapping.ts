import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

// Duplicated from server.ts's CLAUDE_BIN rather than imported, to avoid a
// circular import between server.ts (which imports mapViaCLI) and this module.
const CLAUDE_BIN = join(homedir(), '.local/bin/claude');

/**
 * Runs the mapping prompt through the headless claude CLI with a JSON schema,
 * returning the schema-conformant structured_output. Subscription-billed
 * (bare/API-key mode is never used, so no ANTHROPIC_API_KEY dependency).
 * Defaults to a 240s bound: large forms (30+ fields with several essay drafts)
 * routinely need past 60s, and the per-fill budget (10 min) comfortably absorbs
 * 4. A hung spawn still surfaces as an error instead of hanging the request
 * forever. The seek relevance path (a two-field verdict, none of that form-size
 * rationale) passes a much shorter bound via the `timeoutMs` parameter below —
 * under a bounded worker pool a hung call costs a worker slot, so scoring
 * would rather fail fast and retry next sweep (D-14). This is a parameter, not
 * a second spawn configuration, so D-10's one-function-one-behaviour rule
 * below is not reopened.
 */
// WR-05 (Phase 20 review): grace the stream read gets AFTER the spawn's own
// timeout has fired and SIGKILLed the child. SIGKILL closes the CHILD's pipe
// ends, but a grandchild that inherited them keeps the read open, so the reads
// can outlive the kill. 5s is well past the moment pipes close in the normal
// case and still bounds the pathological one.
const STREAM_GRACE_MS = 5_000;

/** `spawnFn` is injected only by tests, mirroring spawnBatchRunner's shape. */
export async function mapViaCLI(
  prompt: string,
  schema: object,
  timeoutMs: number = 240_000,
  spawnFn: typeof Bun.spawn = Bun.spawn,
): Promise<unknown> {
  const proc = spawnFn(
    [
      CLAUDE_BIN,
      '-p',
      prompt,
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(schema),
      // The prompt embeds untrusted scraped-page content, so this run must be
      // genuinely tool-less: --tools '' removes every built-in tool and
      // --allowedTools '' allowlists none. Never add a permission-mode bypass
      // here — it would neutralize both flags (verified: -p print mode returns
      // structured_output without any permission prompt under this combination).
      '--tools',
      '',
      '--allowedTools',
      '',
      // D-10: lean flag tier, shipped to BOTH callers (seek scoring and the
      // /map fill route) from this one function so there is never a second,
      // divergent spawn configuration to reason about. These strip project
      // instructions, settings sources and MCP config — context neither
      // caller can act on and neither wants bleeding into a structured-output
      // judgement. Measured 13,023 -> 617 input tokens (D-11), a 21x
      // reduction. `--bare` is rejected (D-12): it returns is_error: true
      // from a neutral cwd and would require a trusted cwd, which
      // `cwd: tmpdir()` below exists precisely to avoid.
      // `--exclude-dynamic-system-prompt-sections` is rejected (D-13): it
      // saved zero additional tokens and one observed run dropped the
      // schema-required `relevant` field.
      '--system-prompt',
      '',
      '--setting-sources',
      '',
      '--strict-mcp-config',
    ],
    {
      cwd: tmpdir(),
      stdout: 'pipe',
      stderr: 'pipe',
      // WR-05: the bound is the spawn's own, with SIGKILL. The previous
      // `setTimeout(() => proc.kill(), timeoutMs)` sent SIGTERM, which a process
      // may catch or ignore, and every await below it was unbounded — so an
      // ignored signal did not fail the call, it hung it forever. That is the
      // opposite of the fail-fast contract relevance.ts's 60s bound relies on,
      // and under the decide pool a hung call wedges Promise.all, leaves the
      // sweep `running`, and the single-flight gate then blocks every later
      // sweep until the helper restarts. SIGKILL cannot be ignored.
      // Matches spawnSidecar's shape in seek/job.ts.
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    },
  );

  // Second line of defence — see STREAM_GRACE_MS. The spawn timeout above kills
  // the child, but only bounding the reads makes this function itself bounded.
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let stdout: string;
  let stderr: string;
  try {
    [stdout, stderr] = await Promise.race([
      (async () => {
        const pair = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        await proc.exited;
        return pair;
      })(),
      new Promise<never>((_, reject) => {
        graceTimer = setTimeout(
          () => reject(new Error(`mapViaCLI timed out after ${timeoutMs}ms`)),
          timeoutMs + STREAM_GRACE_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(graceTimer);
    // No-op once the process has exited; on the timeout path it stops a child
    // that outlived its own kill from lingering after we stop reading it.
    try { proc.kill('SIGKILL'); } catch {}
  }

  let envelope: { is_error?: boolean; structured_output?: unknown } | null = null;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    envelope = null;
  }
  if (!envelope || envelope.is_error || !envelope.structured_output) {
    // A timeout kills the child, so stdout is empty and the parse fails — which
    // is reported as a bare `parse-error`, indistinguishable from the CLI
    // genuinely returning malformed output. Name the signal and the bound when
    // one is present, so an unattended batch run leaves a diagnosable trace.
    // Deliberately not asserted as "timed out": SIGKILL can also come from
    // elsewhere (an OOM kill), and this reports what was observed.
    const signal = (proc as { signalCode?: string | null }).signalCode;
    const killed = signal ? `, killed=${signal}, bound=${timeoutMs}ms` : '';
    throw new Error(
      `mapViaCLI failed (is_error=${envelope?.is_error ?? 'parse-error'}${killed}): ${stderr.slice(0, 300)}`,
    );
  }
  return envelope.structured_output;
}
