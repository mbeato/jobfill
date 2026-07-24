// Getro VC-portfolio-board adapter (SEEK-08). A seed fund's portfolio is
// exactly the set of small companies the hand-curated watchlist misses — the
// "postings nobody else has seen yet" thesis this phase exists to serve.
//
// D-12: the funds named in the source todo (a16z, Sequoia, Initialized,
// Bessemer) actually run on Consider.co, not Getro; genuine Getro boards are
// smaller seed funds (Craft Ventures, Uncork Capital, Mercury Fund, HV
// Capital). This is a requirement-wording drift from SEEK-08's literal
// "Getro public JSON" text, flagged here for the milestone audit.
//
// D-13: Consider.co ships as a deliberate NON-delivery. Its boards are
// client-rendered SPAs (`window.__staticRouterHydrationData` only, no
// reachable JSON contract found within the time-boxed research effort) — no
// Consider adapter, stub, or scraper exists in this module or anywhere else
// in the phase.
//
// D-16: fetching uses plain Bun `fetch()` with no special headers and is
// never routed through the Playwright sidecar. The "403 to plain fetch"
// measured during discussion was a `curl` User-Agent artifact — Bun's native
// fetch() reaches these public boards with zero configuration. A blocked or
// failing network fails open: record the error, continue the sweep,
// contribute nothing that day.

import type { NormalizedPosting } from './types';
import { extractAtsToken } from './slug-harvest';

export interface GetroNetwork {
  name: string;
  // Numeric network ID (D-15), recorded for provenance and future API use —
  // the `/jobs` page scrape itself keys off `host`, not `id`.
  id: string;
  host?: string;
}

export interface GetroFetchResult {
  postings: NormalizedPosting[];
  errors: { network: string; error: string }[];
}

// Vanity-domain funds (jobs.craftventures.com, jobs.uncorkcapital.com) carry
// an explicit `host`; funds without one fall back to `<name>.getro.com`.
export function getroHost(n: GetroNetwork): string {
  return n.host ?? `${n.name}.getro.com`;
}

// The tag is a single well-known anchor — pulling in an HTML-parsing
// dependency would break the phase's no-new-deps constraint for what is
// otherwise a one-line extraction.
const NEXT_DATA_RE = /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s;

export function parseNextData(html: string): any {
  const m = String(html ?? '').match(NEXT_DATA_RE);
  if (!m) {
    throw new Error('parseNextData: no __NEXT_DATA__ script tag found');
  }
  return JSON.parse(m[1]);
}

export function normalizeGetroJob(raw: unknown): NormalizedPosting {
  const job = (raw ?? {}) as Record<string, any>;
  const locations = Array.isArray(job.locations) ? job.locations : [];
  const createdAt = Number(job.createdAt);
  return {
    company: String(job.organization?.name ?? ''),
    title: String(job.title ?? ''),
    location: locations.join(', '),
    url: String(job.url ?? ''),
    source: 'getro',
    // Unix seconds -> ms, only for a finite positive number (never fabricate
    // a date, D-07).
    posted_at: Number.isFinite(createdAt) && createdAt > 0 ? new Date(createdAt * 1000).toISOString() : null,
    // D-09's reasoning extends here: createdAt is when Getro's own crawler
    // indexed the posting from the company's career page, not the
    // employer's post time — the identical borrowed-authority problem.
    posted_at_trusted: false,
    login_gated: false,
  };
}

// Hard ceiling per network so a board reporting an absurd `total` cannot
// turn one sweep into thousands of requests.
export const MAX_GETRO_PAGES = 10;

// Bounded network concurrency — never all at once, same posture as the ATS
// token pool.
const GETRO_CONCURRENCY = 4;

export async function fetchGetroPage(
  host: string,
  page: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ jobs: unknown[]; total: number }> {
  const res = await fetchImpl(`https://${host}/jobs${page > 1 ? `?page=${page}` : ''}`);
  if (!res.ok) {
    throw new Error(`fetchGetro: ${host} page ${page} returned HTTP ${res.status}`);
  }
  const html = await res.text();
  const data = parseNextData(html);
  const jobs = data?.props?.pageProps?.initialState?.jobs?.found ?? [];
  const total = Number(data?.props?.pageProps?.initialState?.jobs?.total ?? 0);
  return { jobs, total };
}

export async function fetchGetro(
  networks: GetroNetwork[],
  fetchImpl: typeof fetch = fetch,
): Promise<GetroFetchResult> {
  const postings: NormalizedPosting[] = [];
  const errors: { network: string; error: string }[] = [];
  if (networks.length === 0) return { postings, errors };

  let i = 0;
  async function worker() {
    while (i < networks.length) {
      const network = networks[i++];
      const host = getroHost(network);
      try {
        // D-16 fail-open: this network's own try/catch never aborts its
        // siblings, exactly like Pitfall 4's boldstart case (one dead
        // tenant does not indict the platform).
        const first = await fetchGetroPage(host, 1, fetchImpl);
        const jobs: unknown[] = [...first.jobs];
        const pageSize = first.jobs.length;
        const pageCount = pageSize > 0 ? Math.min(Math.ceil(first.total / pageSize), MAX_GETRO_PAGES) : 1;
        for (let page = 2; page <= pageCount; page++) {
          const next = await fetchGetroPage(host, page, fetchImpl);
          jobs.push(...next.jobs);
        }
        for (const job of jobs) postings.push(normalizeGetroJob(job));
      } catch (err) {
        errors.push({ network: network.name, error: String((err as Error)?.message ?? err) });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(GETRO_CONCURRENCY, networks.length) }, () => worker()));

  return { postings, errors };
}

// D-14: a seed fund's portfolio is precisely the set of small companies the
// hand-curated watchlist misses, which is why VC boards harvest slugs and
// not only postings. Captured Getro job entries link straight at
// boards.greenhouse.io/<company>/jobs/<id>, so this is the highest-signal
// harvest in the phase. Identical contract to harvestSimplifyBoards: no
// database access, dedupe on ats+token preserving order.
export function harvestGetroBoards(postings: NormalizedPosting[]): { ats: string; token: string }[] {
  const seen = new Set<string>();
  const out: { ats: string; token: string }[] = [];
  for (const p of postings) {
    const harvested = extractAtsToken(p.url);
    if (!harvested) continue;
    const key = `${harvested.ats}:${harvested.token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(harvested);
  }
  return out;
}
