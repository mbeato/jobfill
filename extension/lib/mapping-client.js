import { buildRequest as buildRequestReal, parseMapping as parseMappingReal } from './prompt.js';
import { callClaude as callClaudeReal, costUSD as costUSDReal } from './anthropic.js';

const HELPER = 'http://127.0.0.1:7877';

// Must OUTLIVE the server's own CLI budget (mapViaCLI kills the claude spawn at
// 240s and returns a definitive success/error) — a shorter client window abandons
// helper mappings that were about to succeed and prematurely burns the direct-API
// fallback. 270s = server's 240s cap + spawn/transfer headroom.
export const MAP_TIMEOUT_MS = 270000;

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
  } catch (helperErr) {
    // Direct-API fallback only makes sense with a key. Without one, surface the
    // helper failure itself — "invalid x-api-key" on a keyless setup buries the
    // real cause (helper down/slow/errored).
    if (!apiKey) {
      throw new Error(`helper mapping failed (${String(helperErr?.message || helperErr)}) and no API key is set for direct fallback`);
    }
    try {
      const response = await doCallClaude(apiKey, body);
      const mapping = doParseMapping(response);
      return { mapping, cost: doCostUSD(response.usage), source: 'haiku' };
    } catch (apiErr) {
      throw new Error(`mapping failed on both paths — helper: ${String(helperErr?.message || helperErr)}; direct API: ${String(apiErr?.message || apiErr)}`);
    }
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
    const mapping = await res.json();
    // Shape check here, inside the try that falls back to Haiku: schema conformance is
    // otherwise delegated entirely to the CLI, and a malformed 200 would only blow up
    // later in enforceIdentity — after the fallback window is gone.
    if (!mapping || !Array.isArray(mapping.fields) || !Array.isArray(mapping.skipped)) {
      throw new Error('helper /map returned a malformed mapping');
    }
    return mapping;
  } finally {
    clearTimeout(t);
  }
}
