import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

// Duplicated from server.ts's CLAUDE_BIN rather than imported, to avoid a
// circular import between server.ts (which imports mapViaCLI) and this module.
const CLAUDE_BIN = join(homedir(), '.local/bin/claude');

/**
 * Runs the mapping prompt through the headless claude CLI with a JSON schema,
 * returning the schema-conformant structured_output. Subscription-billed
 * (bare/API-key mode is never used, so no ANTHROPIC_API_KEY dependency).
 * Bounded to ~60s so a slow or hung CLI spawn surfaces as an error instead
 * of hanging the request forever.
 */
export async function mapViaCLI(prompt: string, schema: object): Promise<unknown> {
  const proc = Bun.spawn(
    [
      CLAUDE_BIN,
      '-p',
      prompt,
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(schema),
      '--permission-mode',
      'bypassPermissions',
      '--allowedTools',
      '',
    ],
    { cwd: tmpdir(), stdout: 'pipe', stderr: 'pipe' },
  );
  const timeout = setTimeout(() => proc.kill(), 60 * 1000);
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
