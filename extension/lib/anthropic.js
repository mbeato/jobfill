export const MODEL = 'claude-sonnet-5';

// Sticker $/MTok (intro pricing through 2026-08-31 is lower; this over-estimates slightly)
const IN = 3, OUT = 15, CACHE_WRITE = IN * 1.25, CACHE_READ = IN * 0.1;

const RETRYABLE = new Set([429, 500, 529]);

export async function callClaude(apiKey, body, { retryDelayMs = 2000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    if (attempt === 0 && RETRYABLE.has(res.status)) {
      await new Promise(r => setTimeout(r, retryDelayMs));
      continue;
    }
    const err = await res.json().catch(() => ({}));
    throw new Error(`Anthropic API ${res.status}: ${err.error?.message || res.statusText}`);
  }
}

export function costUSD(usage) {
  if (!usage) return 0;
  return (
    (usage.input_tokens ?? 0) * IN +
    (usage.output_tokens ?? 0) * OUT +
    (usage.cache_creation_input_tokens ?? 0) * CACHE_WRITE +
    (usage.cache_read_input_tokens ?? 0) * CACHE_READ
  ) / 1e6;
}
