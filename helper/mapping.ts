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
export async function mapViaCLI(prompt: string, schema: object, timeoutMs: number = 240_000): Promise<unknown> {
  const proc = Bun.spawn(
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
    { cwd: tmpdir(), stdout: 'pipe', stderr: 'pipe' },
  );
  const timeout = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  clearTimeout(timeout);

  let envelope: { is_error?: boolean; structured_output?: unknown } | null = null;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    envelope = null;
  }
  if (!envelope || envelope.is_error || !envelope.structured_output) {
    throw new Error(
      `mapViaCLI failed (is_error=${envelope?.is_error ?? 'parse-error'}): ${stderr.slice(0, 300)}`,
    );
  }
  return envelope.structured_output;
}
