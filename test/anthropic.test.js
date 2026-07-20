import { describe, it, expect, vi, afterEach } from 'vitest';
import { callClaude, costUSD, MODEL } from '../extension/lib/anthropic.js';

afterEach(() => vi.restoreAllMocks());

describe('callClaude', () => {
  it('POSTs with browser-access headers and returns parsed JSON', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 }),
    );
    const body = { model: MODEL, messages: [] };
    const out = await callClaude('sk-ant-test', body);
    expect(out.id).toBe('msg_1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('sk-ant-test');
    expect(init.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    expect(JSON.parse(init.body).model).toBe(MODEL);
  });

  it('throws a readable error on 4xx without retrying', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 }),
    );
    await expect(callClaude('bad', {})).rejects.toThrow(/401.*invalid x-api-key/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries once on 529 then succeeds', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 529 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'msg_2' }), { status: 200 }));
    const out = await callClaude('k', {}, { retryDelayMs: 1 });
    expect(out.id).toBe('msg_2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('costUSD', () => {
  it('prices input/output/cache tokens', () => {
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    };
    // 1 + 5 + 1.25 + 0.10
    expect(costUSD(usage)).toBeCloseTo(7.35, 2);
    expect(costUSD(undefined)).toBe(0);
  });
});
