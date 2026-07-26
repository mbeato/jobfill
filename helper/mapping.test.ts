import { test, expect } from 'bun:test';
import { tmpdir } from 'node:os';
import { mapViaCLI } from './mapping';

// IN-01 (Phase 20 review): mapping.ts had no test file, so the lean flag tier
// (D-10) and the timeoutMs plumbing (D-14) shipped untested — on the seek
// scoring path AND the /map fill route that fills real ATS forms. `spawnFn` is
// injected exactly as spawnBatchRunner's tests inject theirs; nothing here ever
// runs the real claude CLI.

const enc = new TextEncoder();
const closedStream = (s: string) =>
  new ReadableStream({ start(c) { c.enqueue(enc.encode(s)); c.close(); } });
// Never closes and never errors — models a grandchild holding the pipe open
// after the child itself has been killed.
const openForeverStream = () => new ReadableStream({ start() {} });

function makeSpawn(opts: { stdout?: string; stderr?: string; hang?: boolean } = {}) {
  const captured: { args: string[]; opts: Record<string, unknown>; kills: string[] } =
    { args: [], opts: {}, kills: [] };
  const fn = ((args: string[], o: Record<string, unknown>) => {
    captured.args = args;
    captured.opts = o;
    return {
      stdout: opts.hang ? openForeverStream() : closedStream(opts.stdout ?? ''),
      stderr: opts.hang ? openForeverStream() : closedStream(opts.stderr ?? ''),
      exited: opts.hang ? new Promise(() => {}) : Promise.resolve(0),
      kill: (sig?: string) => { captured.kills.push(String(sig ?? 'default')); },
    } as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn;
  return { fn, captured };
}

const okEnvelope = JSON.stringify({ is_error: false, structured_output: { relevant: true, reason: 'fits' } });

test('the tool-disabling pair is passed as adjacent flag/empty-value pairs', async () => {
  const s = makeSpawn({ stdout: okEnvelope });
  await mapViaCLI('p', { type: 'object' }, 1000, s.fn);
  // Asserted as flag-then-value, not mere presence: '--tools' followed by
  // anything other than '' would not disable tools, and a bare includes() check
  // would pass anyway.
  expect(s.captured.args[s.captured.args.indexOf('--tools') + 1]).toBe('');
  expect(s.captured.args[s.captured.args.indexOf('--allowedTools') + 1]).toBe('');
});

test('the D-10 lean tier ships, and the two rejected flags do not', async () => {
  const s = makeSpawn({ stdout: okEnvelope });
  await mapViaCLI('p', { type: 'object' }, 1000, s.fn);
  expect(s.captured.args[s.captured.args.indexOf('--system-prompt') + 1]).toBe('');
  expect(s.captured.args[s.captured.args.indexOf('--setting-sources') + 1]).toBe('');
  expect(s.captured.args).toContain('--strict-mcp-config');
  // D-12 and D-13 rejected these on measured evidence. Both would be one-line
  // additions here, so pin them.
  expect(s.captured.args).not.toContain('--bare');
  expect(s.captured.args).not.toContain('--exclude-dynamic-system-prompt-sections');
});

test('runs from tmpdir — both callers embed untrusted scraped content', async () => {
  const s = makeSpawn({ stdout: okEnvelope });
  await mapViaCLI('p', { type: 'object' }, 1000, s.fn);
  expect(s.captured.opts.cwd).toBe(tmpdir());
});

test('the prompt and schema reach the CLI', async () => {
  const s = makeSpawn({ stdout: okEnvelope });
  const schema = { type: 'object', required: ['relevant'] };
  await mapViaCLI('THE PROMPT', schema, 1000, s.fn);
  expect(s.captured.args[s.captured.args.indexOf('-p') + 1]).toBe('THE PROMPT');
  expect(s.captured.args[s.captured.args.indexOf('--json-schema') + 1]).toBe(JSON.stringify(schema));
});

test('D-14: the fill path keeps 240s by default and the seek path can shorten it', async () => {
  const def = makeSpawn({ stdout: okEnvelope });
  await mapViaCLI('p', {}, undefined, def.fn);
  expect(def.captured.opts.timeout).toBe(240_000);

  const short = makeSpawn({ stdout: okEnvelope });
  await mapViaCLI('p', {}, 60_000, short.fn);
  expect(short.captured.opts.timeout).toBe(60_000);
});

test('WR-05: the bound is the spawn\'s own and the signal is SIGKILL, not an ignorable SIGTERM', async () => {
  const s = makeSpawn({ stdout: okEnvelope });
  await mapViaCLI('p', {}, 1234, s.fn);
  expect(s.captured.opts.timeout).toBe(1234);
  expect(s.captured.opts.killSignal).toBe('SIGKILL');
});

test('returns structured_output on a well-formed envelope', async () => {
  const s = makeSpawn({ stdout: okEnvelope });
  await expect(mapViaCLI('p', {}, 1000, s.fn)).resolves.toEqual({ relevant: true, reason: 'fits' });
});

test('throws on is_error, on a missing structured_output, and on unparseable stdout', async () => {
  const errored = makeSpawn({ stdout: JSON.stringify({ is_error: true }), stderr: 'Not logged in' });
  await expect(mapViaCLI('p', {}, 1000, errored.fn)).rejects.toThrow('Not logged in');

  const noOutput = makeSpawn({ stdout: JSON.stringify({ is_error: false }) });
  await expect(mapViaCLI('p', {}, 1000, noOutput.fn)).rejects.toThrow('mapViaCLI failed');

  const garbage = makeSpawn({ stdout: 'not json at all' });
  await expect(mapViaCLI('p', {}, 1000, garbage.fn)).rejects.toThrow('parse-error');
});

// The WR-05 regression guard, and the reason this file exists. Before the fix a
// spawn whose pipes never closed hung this function forever: kill() sent an
// ignorable SIGTERM and every await was unbounded. Under the decide pool that
// wedges Promise.all, leaves the sweep `running`, and the single-flight gate
// then blocks every later sweep until the helper restarts.
// Slow by construction: it must outlast timeoutMs + STREAM_GRACE_MS (5s), so it
// carries its own bun-test timeout rather than the 5s default.
test('a spawn whose streams never close REJECTS rather than hanging forever', async () => {
  const s = makeSpawn({ hang: true });
  const started = Date.now();
  await expect(mapViaCLI('p', {}, 50, s.fn)).rejects.toThrow('timed out after 50ms');
  // Bounded by the grace, not by the caller giving up.
  expect(Date.now() - started).toBeLessThan(9_000);
  // And the stranded child is signalled rather than left running.
  expect(s.captured.kills).toContain('SIGKILL');
}, 12_000);
