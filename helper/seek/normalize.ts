// The one authoritative URL canonicalizer (copied verbatim from helper/server.ts
// lines 89-98). It returns a host+path DEDUP KEY — scheme and query string are
// dropped — it is NOT a fillable URL. server.ts keeps its own copy for now;
// Plan 04 refactors server.ts to import this one.

export function normalizeUrl(u: string): string {
  const raw = String(u ?? '').trim().slice(0, 300);
  try {
    const parsed = new URL(raw);
    const path = parsed.pathname.replace(/\/$/, '');
    return `${parsed.host.toLowerCase()}${path}`;
  } catch {
    return raw;
  }
}
