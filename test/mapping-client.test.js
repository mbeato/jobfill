import { describe, it, expect, vi, afterEach } from 'vitest';
import { mapFields, MAP_TIMEOUT_MS } from '../extension/lib/mapping-client.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const FAKE_BODY = {
  system: [{ text: 'SYSTEM PROMPT' }],
  messages: [{ content: 'USER MESSAGE' }],
  output_config: { format: { schema: { type: 'object' } } },
};

const ARGS = {
  apiKey: 'sk-ant-test',
  profile: { contact: { email: 'you@example.com' } },
  fields: [],
  pageContext: { url: 'https://boards.greenhouse.io/x' },
  summary: null,
  library: null,
  helperToken: 'REDACTED-TOKEN',
};

function makeDeps(overrides = {}) {
  return {
    buildRequest: vi.fn().mockReturnValue(FAKE_BODY),
    callClaude: vi.fn().mockResolvedValue({ usage: { input_tokens: 1, output_tokens: 1 } }),
    parseMapping: vi.fn().mockReturnValue({ company: 'C', role: 'R', fields: [], skipped: [] }),
    costUSD: vi.fn().mockReturnValue(0.01),
    ...overrides,
  };
}

describe('mapFields', () => {
  it('returns the helper mapping on a 2xx response without calling callClaude', async () => {
    const helperMapping = { company: 'Helper Co', role: 'Engineer', fields: [], skipped: [] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(helperMapping), { status: 200 }));
    const deps = makeDeps({ fetch: fetchMock });

    const out = await mapFields(ARGS, deps);

    expect(out).toEqual({ mapping: helperMapping, cost: 0, source: 'helper' });
    expect(deps.callClaude).not.toHaveBeenCalled();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:7877/map');
    expect(init.headers['x-jobfill-token']).toBe(ARGS.helperToken);
    const sentBody = JSON.parse(init.body);
    expect(typeof sentBody.prompt).toBe('string');
    expect(sentBody.prompt).toBe('SYSTEM PROMPT\n\nUSER MESSAGE');
    expect(typeof sentBody.schema).toBe('object');
    expect(sentBody.schema).toEqual(FAKE_BODY.output_config.format.schema);
  });

  it('falls back to Haiku when the helper hangs past MAP_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const deps = makeDeps({ fetch: fetchMock });

    const pending = mapFields(ARGS, deps);
    await vi.advanceTimersByTimeAsync(MAP_TIMEOUT_MS);
    const out = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(deps.callClaude).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ mapping: { company: 'C', role: 'R', fields: [], skipped: [] }, cost: 0.01, source: 'haiku' });
  });

  it('falls back to Haiku on a non-2xx helper response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'down for maintenance' }), { status: 503 }));
    const deps = makeDeps({ fetch: fetchMock });

    const out = await mapFields(ARGS, deps);

    expect(deps.callClaude).toHaveBeenCalledTimes(1);
    expect(out.source).toBe('haiku');
  });

  it('falls back to Haiku when the helper returns 200 with a malformed mapping shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ company: 'C', fields: 'not-an-array' }), { status: 200 }),
    );
    const deps = makeDeps({ fetch: fetchMock });

    const out = await mapFields(ARGS, deps);

    expect(deps.callClaude).toHaveBeenCalledTimes(1);
    expect(out.source).toBe('haiku');
  });

  it('falls back to Haiku when the helper fetch rejects', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const deps = makeDeps({ fetch: fetchMock });

    const out = await mapFields(ARGS, deps);

    expect(deps.callClaude).toHaveBeenCalledTimes(1);
    expect(out.source).toBe('haiku');
  });
});
