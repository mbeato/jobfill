import { buildRequest as buildRequestReal, parseMapping as parseMappingReal } from './prompt.js';
import { callClaude as callClaudeReal, costUSD as costUSDReal } from './anthropic.js';

const HELPER = 'http://127.0.0.1:7877';

// Larger than helperFetch's default 10s (background.js) — the helper spawns a CLI for /map,
// which needs a real chance to finish before falling open to the direct Haiku API (Pitfall 4).
export const MAP_TIMEOUT_MS = 25000;

// Helper-first mapping call, fail-open to the direct Haiku API within MAP_TIMEOUT_MS.
// Builds ONE request via buildRequest and reuses it for both paths — prompt.js stays the
// single source of truth for mapping instructions and the output schema.
export async function mapFields(
  { apiKey, profile, fields, pageContext, summary, library, helperToken },
  deps = {},
) {
  const doFetch = deps.fetch || fetch;
  const doCallClaude = deps.callClaude || callClaudeReal;
  const doBuildRequest = deps.buildRequest || buildRequestReal;
  const doParseMapping = deps.parseMapping || parseMappingReal;
  const doCostUSD = deps.costUSD || costUSDReal;

  const body = doBuildRequest(profile, fields, pageContext, summary, library);
  const prompt = `${body.system[0].text}\n\n${body.messages[0].content}`;
  const schema = body.output_config.format.schema;

  try {
    const mapping = await helperMap(doFetch, prompt, schema, helperToken);
    return { mapping, cost: 0, source: 'helper' };
  } catch {
    const response = await doCallClaude(apiKey, body);
    const mapping = doParseMapping(response);
    return { mapping, cost: doCostUSD(response.usage), source: 'haiku' };
  }
}

async function helperMap(doFetch, prompt, schema, helperToken) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), MAP_TIMEOUT_MS);
  try {
    const res = await doFetch(`${HELPER}/map`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jobfill-token': helperToken },
      body: JSON.stringify({ prompt, schema }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`helper /map ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}
