// SimplifyJobs New-Grad-Positions adapter (SEEK-07). A single GET of the
// `listings.json` feed, filtered to live entries, mapped into the shared
// NormalizedPosting shape.
//
// D-07: only New-Grad-Positions is polled, never Summer2026-Internships — the
// internships repo would add 197 more slugs but every posting it contributes
// is one the operator rejects on review, at LLM-relevance spend per sweep.
//
// D-08: every active && is_visible listing becomes a NormalizedPosting
// regardless of apply-URL host. Only ~26% of active listings land on
// greenhouse/lever/ashby (job-boards.greenhouse.io/boards.greenhouse.io/
// jobs.ashbyhq.com/jobs.lever.co); the rest are SmartRecruiters, Workday,
// Apple, ByteDance, Rippling and similar. `batch.hostAllowlist` already stops
// unattended fill from touching anything outside greenhouse/lever/ashby, so
// narrowing discovery here would only hide good roles from manual review.

import type { NormalizedPosting } from './types';

// Verified live 2026-07-24: HTTP 200, ~12 MB, 17,646-entry JSON array (NOT
// wrapped in an object). The `dev` branch path 404s — `main` is the live file.
export const SIMPLIFY_URL =
  'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/main/.github/scripts/listings.json';

// Verified field names/types against a 2,000-entry sample, 2026-07-24 — no
// field was ever missing across the sample. No `terms` field exists in this
// dataset (it may exist only in the out-of-scope Summer-Internships repo).
export interface SimplifyListing {
  source: string;
  category: string;
  company_name: string;
  id: string;
  title: string;
  active: boolean;
  date_updated: number;
  date_posted: number;
  url: string;
  locations: string[];
  company_url: string;
  is_visible: boolean;
  sponsorship: string;
  degrees: string[];
}

/**
 * Pure mapper: raw SimplifyJobs listing -> NormalizedPosting. Never throws —
 * mirrors normalizeGreenhouseJob's defensive `(raw ?? {})` + `String(x ?? '')`
 * fallback style.
 */
export function normalizeSimplifyListing(raw: unknown): NormalizedPosting {
  const listing = (raw ?? {}) as Record<string, any>;

  const locations = listing.locations;
  const location = Array.isArray(locations) ? locations.join(', ') : '';

  // date_posted is Unix SECONDS, not milliseconds (Pitfall 5) — unlike
  // Lever's createdAt, which IS milliseconds. Only convert a finite positive
  // number; never fabricate a date (D-07 of Phase 9).
  const datePosted = listing.date_posted;
  const postedAt =
    typeof datePosted === 'number' && Number.isFinite(datePosted) && datePosted > 0
      ? new Date(datePosted * 1000).toISOString()
      : null;

  return {
    // No per-request token exists for this adapter — company_url points at
    // simplify.jobs/c/<slug>, not the employer, so company_name is the only
    // usable company signal.
    company: String(listing.company_name ?? ''),
    title: String(listing.title ?? ''),
    location,
    // The apply URL. upsertPosting's http(s) scheme allowlist is the gate
    // that rejects anything non-http(s) — do not silently rewrite it here.
    url: String(listing.url ?? ''),
    source: 'simplify',
    posted_at: postedAt,
    // D-09: date_posted is Simplify's index time, not the employer's post
    // time — store it honestly, flag it untrusted. Phase 17's first-seen
    // aging is the correct freshness clock for this source.
    posted_at_trusted: false,
    login_gated: false,
  };
}

/**
 * Single GET of SIMPLIFY_URL, filtered to active && is_visible entries and
 * mapped through normalizeSimplifyListing. Throws a descriptive Error on
 * non-2xx or unparseable JSON — this is one request, not a per-token loop, so
 * D-03's per-token isolation doesn't apply; runSweep's existing per-source
 * runOne try/catch isolates a whole-source failure (D-13 of Phase 9).
 *
 * A single ~12 MB res.json() is deliberate and measured: 17,646 entries parse
 * sub-second in Bun, and the parsed array is GC-eligible once this function
 * returns — no streaming-JSON dependency needed for this payload size.
 */
export async function fetchSimplify(fetchImpl: typeof fetch = fetch): Promise<NormalizedPosting[]> {
  const res = await fetchImpl(SIMPLIFY_URL);
  if (!res.ok) {
    throw new Error(`fetchSimplify: HTTP ${res.status}`);
  }
  let entries: unknown;
  try {
    entries = await res.json();
  } catch (err) {
    throw new Error(`fetchSimplify: unparseable JSON (${err})`);
  }
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((e) => (e as Record<string, any>)?.active === true && (e as Record<string, any>)?.is_visible === true)
    .map(normalizeSimplifyListing);
}
