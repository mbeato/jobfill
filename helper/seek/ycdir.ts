import type { Database } from 'bun:sqlite';
import type { upsertBoard } from './boards';

// YC batch-directory slug harvester (SEEK-09, D-17). This source produces
// board slugs ONLY and NEVER postings — the resulting Greenhouse/Lever/Ashby
// polls (triggered by the slugs this module writes into `boards`) produce the
// actual, login-free, batch-fillable postings. Deliberately separate from the
// existing login-gated `yc` (Work at a Startup) sidecar source: welding the
// two together would mean a stale sidecar login breaks slug discovery too.
//
// `api.ycombinator.com/v0.1/companies` is a plain, public, unauthenticated
// REST endpoint verified live 2026-07-24 — no API key, no search-index
// credential, no auth header, no rate limiting observed across 8 rapid
// requests. A bogus `?batch=` returns an empty list with HTTP 200, not an
// error. The discussion-phase third-party search-index credential path that
// was assumed necessary is a dead end (HTTP 403) and is NOT used here.

export const YC_API_URL = 'https://api.ycombinator.com/v0.1/companies';

// Hard ceiling so a malformed/absurd totalPages can never walk the whole
// ~6,100-company directory for a single batch.
export const MAX_YC_PAGES = 20;

export interface YcCompany {
  name: string;
  slug: string;
  website: string;
  batch: string;
}

export async function fetchNewestBatches(fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const res = await fetchImpl(YC_API_URL);
  if (!res.ok) {
    throw new Error(`fetchYcDirectory: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { companies?: { batch?: unknown }[] };
  // The API's default (unfiltered) sort is recency-biased, so the distinct
  // batch codes seen on page 1 alone are the newest batches — no hardcoded
  // batch-naming convention needed.
  const seen = new Set<string>();
  const batches: string[] = [];
  for (const c of body.companies ?? []) {
    const batch = String((c as Record<string, unknown> | null)?.batch ?? '').trim();
    if (!batch || seen.has(batch)) continue;
    seen.add(batch);
    batches.push(batch);
  }
  return batches;
}

export async function fetchBatchCompanies(
  batch: string,
  fetchImpl: typeof fetch = fetch,
): Promise<YcCompany[]> {
  const out: YcCompany[] = [];
  let page = 1;
  // `batch` comes from the API response (fetchNewestBatches) — external input,
  // so it is percent-encoded before being interpolated into the query string.
  const encodedBatch = encodeURIComponent(batch);
  while (page <= MAX_YC_PAGES) {
    const res = await fetchImpl(`${YC_API_URL}?batch=${encodedBatch}&page=${page}`);
    if (!res.ok) {
      throw new Error(`fetchYcDirectory: batch ${batch} page ${page} returned HTTP ${res.status}`);
    }
    const body = (await res.json()) as { companies?: unknown[]; totalPages?: unknown };
    for (const raw of body.companies ?? []) {
      const c = (raw ?? {}) as Record<string, unknown>;
      out.push({
        name: String(c.name ?? ''),
        slug: String(c.slug ?? ''),
        website: String(c.website ?? ''),
        batch: String(c.batch ?? ''),
      });
    }
    const totalPages = Number(body.totalPages ?? 1);
    if (page >= totalPages) break;
    page++;
  }
  return out;
}

// Candidate charset gate (T-16-03 SSRF-lite control, not cosmetics): these
// strings are later interpolated into an outbound ATS request path. This is
// intentionally stricter than boards.ts's own TOKEN_RE (lowercase only, no
// dots/underscores, 2-64 chars) so every survivor is guaranteed to also pass
// upsertBoard's own token gate — a rejected candidate here never wastes a
// probe or a later insert attempt.
const CANDIDATE_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

// Pure, no I/O (D-18). Candidate 1 is the company's own YC-normalized slug
// (already exactly the shape ATS tokens take in the wild). Candidate 2 is
// derived from the website's hostname (strip a leading www., take the label
// before the first dot). The raw `website` value itself is never returned,
// logged, or interpolated anywhere — only this derived short label is.
export function deriveCandidateSlugs(company: Partial<YcCompany>): string[] {
  const raw: string[] = [];

  const slug = String(company.slug ?? '').trim().toLowerCase();
  if (slug) raw.push(slug);

  const website = String(company.website ?? '').trim();
  if (website) {
    try {
      const host = new URL(website).hostname.toLowerCase().replace(/^www\./, '');
      const label = host.split('.')[0] ?? '';
      if (label) raw.push(label);
    } catch {
      // Malformed/garbage website — contributes nothing, never throws.
    }
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of raw) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (CANDIDATE_RE.test(candidate)) out.push(candidate);
  }
  return out;
}

// Hardcoded per-ATS host+path templates (T-16-03): only `candidate` — already
// charset-gated — is interpolated, as a single path segment. Never construct
// a probe URL from `company.website`'s full value.
const ATS_PROBE_TEMPLATES: { ats: 'greenhouse' | 'lever' | 'ashby'; url: (candidate: string) => string }[] = [
  { ats: 'greenhouse', url: candidate => `https://boards-api.greenhouse.io/v1/boards/${candidate}/jobs` },
  { ats: 'lever', url: candidate => `https://api.lever.co/v0/postings/${candidate}?mode=json` },
  { ats: 'ashby', url: candidate => `https://api.ashbyhq.com/posting-api/job-board/${candidate}` },
];

// D-18: the 2xx IS the verification — there is no separate pre-insert probe
// code path, and no careers-page crawling (rejected as the most brittle and
// most crawler-looking option). Every fetch is individually try/caught so a
// network error on one ATS never prevents the other two being tried.
export async function probeAts(
  candidate: string,
  fetchImpl: typeof fetch = fetch,
): Promise<'greenhouse' | 'lever' | 'ashby' | null> {
  // Re-assert the charset gate here too (T-16-03): this guard must hold even
  // if a future caller bypasses deriveCandidateSlugs. Zero fetches are issued
  // for a candidate that fails it.
  if (!CANDIDATE_RE.test(candidate)) return null;

  for (const { ats, url } of ATS_PROBE_TEMPLATES) {
    try {
      const res = await fetchImpl(url(candidate));
      if (res.ok) return ats;
    } catch {
      // isolated per-ATS — try the next template
    }
  }
  return null;
}

// D-19: YC batches drop ~2x/year, so daily probing of hundreds of companies
// is waste; a weekly tick needs no new scheduler, still catches mid-batch
// additions, and spreads the probe burst. Pure, no I/O, no system clock read
// — mirrors scheduler.ts's shouldFireToday, injected-clock style.
export const YCDIR_INTERVAL_DAYS = 7;

export function shouldRunYcDir(now: Date, lastRunIso: string | null): boolean {
  if (!lastRunIso) return true;
  const last = new Date(lastRunIso);
  if (Number.isNaN(last.getTime())) return true;
  return now.getTime() - last.getTime() >= YCDIR_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
}

// Bounded-concurrency probe pool (mirrors ats-fetch.ts's runTokenPool cursor
// shape; not reused directly since that pool's return type is coupled to the
// posting shape and this pool never produces one — D-17 slug-only).
async function runCompanyPool(
  companies: YcCompany[],
  perCompany: (company: YcCompany) => Promise<void>,
  concurrency: number,
): Promise<void> {
  let i = 0;
  async function worker() {
    while (i < companies.length) {
      const company = companies[i++];
      await perCompany(company);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, companies.length) }, () => worker()));
}

const HARVEST_CONCURRENCY = 6;

// Orchestrator: fetchNewestBatches -> first `maxBatches` codes -> fetchBatchCompanies
// for each -> derive + probe candidates per company through a bounded pool -> on the
// first confirmed ATS for a company, records it with source_of_discovery 'ycdir' and
// stops probing that company's remaining candidates. This function writes ONLY to
// the board-slug table (D-17) — it must never build or persist a job-posting record.
export async function harvestYcDirectory(deps: {
  db: Database;
  fetchImpl?: typeof fetch;
  upsertBoard: typeof upsertBoard;
  blocklist?: string[];
  maxBatches?: number;
}): Promise<{ companies: number; probed: number; added: number; errors: { company: string; error: string }[] }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const blocklist = deps.blocklist ?? [];
  const maxBatches = deps.maxBatches ?? 2;
  const errors: { company: string; error: string }[] = [];
  let probed = 0;
  let added = 0;

  const batches = (await fetchNewestBatches(fetchImpl)).slice(0, maxBatches);

  const companies: YcCompany[] = [];
  for (const batch of batches) {
    try {
      companies.push(...(await fetchBatchCompanies(batch, fetchImpl)));
    } catch (err) {
      errors.push({ company: `batch:${batch}`, error: String((err as Error)?.message ?? err) });
    }
  }

  await runCompanyPool(
    companies,
    async company => {
      const label = company.name || company.slug || 'unknown';
      try {
        const candidates = deriveCandidateSlugs(company);
        for (const candidate of candidates) {
          probed++;
          const ats = await probeAts(candidate, fetchImpl);
          if (ats) {
            const row = deps.upsertBoard(deps.db, { ats, token: candidate, source_of_discovery: 'ycdir' }, blocklist);
            if (row) added++;
            break; // D-18: first confirmed ATS wins, stop probing remaining candidates
          }
        }
      } catch (err) {
        errors.push({ company: label, error: String((err as Error)?.message ?? err) });
      }
    },
    HARVEST_CONCURRENCY,
  );

  return { companies: companies.length, probed, added, errors };
}
