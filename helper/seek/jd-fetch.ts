// JD-fetch adapter (D-01): fetches a posting's job-description text on demand
// at filter time, per source, deriving the source's own detail endpoint from
// the posting's stored url/company rather than ever fetching posting.url
// directly. Mirrors the source adapters' throw-on-failure contract
// (helper/mapping.ts, helper/seek/greenhouse.ts): fetchJD throws a descriptive
// Error on non-2xx or parse failure — the filter/decide stage (Plan 06) catches
// per-posting and applies D-08 held-for-retry semantics.

import type { PostingRow } from './postings';

// SSRF guard (T-10-06): every constructed endpoint is checked against this
// hardcoded allowlist before fetchImpl is invoked. Endpoints are always built
// from source + token/id, never from an arbitrary posting.url.
const ALLOWED_HOSTS = new Set([
  'boards-api.greenhouse.io',
  'api.lever.co',
  'api.ashbyhq.com',
  'hn.algolia.com',
]);

// Bounds the returned JD text so an oversized posting can't bloat the
// downstream LLM prompt (T-10-04).
const MAX_JD_LENGTH = 12000;

export function assertAllowedHost(url: string): void {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error(`fetchJD: could not parse URL ${url}`);
  }
  if (!ALLOWED_HOSTS.has(hostname)) {
    throw new Error(`fetchJD: refusing to fetch disallowed host ${hostname}`);
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#x2F;/gi, '/')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Handles both literal HTML (Ashby's descriptionHtml, HN comment text) and
// entity-encoded HTML (Greenhouse's `content` field double-escapes its tags,
// e.g. "&lt;h2&gt;" for a literal <h2> — confirmed via a live sample). Decoding
// entities before stripping tags is a no-op-safe order for sources whose tags
// are already literal.
function stripHtml(html: string): string {
  const decoded = decodeEntities(String(html ?? ''));
  return decoded
    .replace(/<\/?(p|br|li|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function bound(text: string): string {
  return text.slice(0, MAX_JD_LENGTH);
}

// Greenhouse's absolute_url is either the default boards.greenhouse.io path
// (…/jobs/{id}) or a company-domain proxy that carries the id as a `gh_jid`
// query param instead (e.g. stripe.com/jobs/search?gh_jid=7954688 — confirmed
// via a live sample; the plan's "trailing path segment" assumption alone
// would miss this real-world shape) — handle both.
function extractGreenhouseId(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`fetchJD: could not parse greenhouse url ${url}`);
  }
  const fromQuery = parsed.searchParams.get('gh_jid');
  if (fromQuery) return fromQuery;
  const match = parsed.pathname.match(/(\d+)\/?$/);
  if (match) return match[1];
  throw new Error(`fetchJD: could not extract greenhouse job id from ${url}`);
}

async function fetchGreenhouseJD(posting: PostingRow, fetchImpl: typeof fetch): Promise<string> {
  const id = extractGreenhouseId(posting.url);
  const url = `https://boards-api.greenhouse.io/v1/boards/${posting.company}/jobs/${id}?content=true`;
  assertAllowedHost(url);
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`fetchJD: greenhouse ${posting.company}/${id} returned HTTP ${res.status}`);
  }
  let body: { content?: string };
  try {
    body = (await res.json()) as { content?: string };
  } catch (err) {
    throw new Error(`fetchJD: greenhouse ${posting.company}/${id} returned unparseable JSON (${err})`);
  }
  return bound(stripHtml(body.content ?? ''));
}

// Lever's public hostedUrl shape is …/{company}/{id} (optionally …/{id}/apply);
// the detail API takes the same company/id pair.
function extractLeverId(url: string): { company: string; id: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`fetchJD: could not parse lever url ${url}`);
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`fetchJD: could not extract lever company/id from ${url}`);
  }
  return { company: parts[0], id: parts[1] };
}

async function fetchLeverJD(posting: PostingRow, fetchImpl: typeof fetch): Promise<string> {
  const { company, id } = extractLeverId(posting.url);
  const url = `https://api.lever.co/v0/postings/${company}/${id}?mode=json`;
  assertAllowedHost(url);
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`fetchJD: lever ${company}/${id} returned HTTP ${res.status}`);
  }
  let body: { descriptionPlain?: string; description?: string };
  try {
    body = (await res.json()) as { descriptionPlain?: string; description?: string };
  } catch (err) {
    throw new Error(`fetchJD: lever ${company}/${id} returned unparseable JSON (${err})`);
  }
  const text = body.descriptionPlain || stripHtml(body.description ?? '');
  return bound(text);
}

// Ashby's job-board list endpoint (the same one fetchAshby already calls)
// embeds each job's descriptionHtml directly — there is no separate per-job
// detail endpoint (confirmed via a live sample against a real board).
function extractAshbyJobId(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`fetchJD: could not parse ashby url ${url}`);
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 1) {
    throw new Error(`fetchJD: could not extract ashby job id from ${url}`);
  }
  return parts[parts.length - 1];
}

async function fetchAshbyJD(posting: PostingRow, fetchImpl: typeof fetch): Promise<string> {
  const jobId = extractAshbyJobId(posting.url);
  const url = `https://api.ashbyhq.com/posting-api/job-board/${posting.company}`;
  assertAllowedHost(url);
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`fetchJD: ashby ${posting.company} returned HTTP ${res.status}`);
  }
  let body: { jobs?: Array<{ id?: string; descriptionHtml?: string }> };
  try {
    body = (await res.json()) as { jobs?: Array<{ id?: string; descriptionHtml?: string }> };
  } catch (err) {
    throw new Error(`fetchJD: ashby ${posting.company} returned unparseable JSON (${err})`);
  }
  const job = (body.jobs ?? []).find(j => j.id === jobId);
  if (!job) {
    throw new Error(`fetchJD: ashby ${posting.company} job ${jobId} not found in board listing`);
  }
  return bound(stripHtml(job.descriptionHtml ?? ''));
}

const HN_ITEM_RE = /news\.ycombinator\.com\/item\?id=(\d+)/;

async function fetchHNJD(posting: PostingRow, fetchImpl: typeof fetch): Promise<string> {
  const match = posting.url.match(HN_ITEM_RE);
  if (!match) {
    // Fillable external apply link — the originating comment id isn't
    // retained on the posting, so there's nothing to refetch. Fall back to a
    // metadata-only summary so the posting still gets an LLM verdict instead
    // of being perpetually held (D-01 discretion).
    return bound(`${posting.company} ${posting.title} ${posting.location}`.trim());
  }
  const id = match[1];
  const url = `https://hn.algolia.com/api/v1/items/${id}`;
  assertAllowedHost(url);
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`fetchJD: hn item ${id} returned HTTP ${res.status}`);
  }
  let body: { text?: string };
  try {
    body = (await res.json()) as { text?: string };
  } catch (err) {
    throw new Error(`fetchJD: hn item ${id} returned unparseable JSON (${err})`);
  }
  return bound(stripHtml(body.text ?? ''));
}

/**
 * Fetches JD text for a metadata-surviving posting from its source's own API,
 * through the hardcoded ALLOWED_HOSTS allowlist. Throws a descriptive Error on
 * hard failure (non-2xx, unparseable JSON, unextractable id) — the caller
 * converts this to D-08 held state. HN fillable-external-link postings never
 * hit the network; they return a metadata fallback string instead.
 */
// The sources fetchJD's switch below can actually serve. MUST stay in lockstep
// with that switch — jd-fetch.test.ts asserts both directions, because this
// codebase has already been bitten once by two parallel source lists drifting
// (SourceName vs VALID_SOURCES, phase 16 D-01).
//
// Aggregator sources (simplify, getro) are deliberately absent: their apply
// URLs point at arbitrary third-party hosts (SmartRecruiters, Workday, Apple),
// which ALLOWED_HOSTS refuses by design as an SSRF control. decide.ts reads
// this set to route those postings to metadata-only scoring instead of
// stranding them in a permanent held loop.
export const JD_FETCHABLE_SOURCES: ReadonlySet<string> = new Set([
  'greenhouse',
  'lever',
  'ashby',
  'hn',
]);

export async function fetchJD(posting: PostingRow, fetchImpl: typeof fetch = fetch): Promise<string> {
  switch (posting.source) {
    case 'greenhouse':
      return fetchGreenhouseJD(posting, fetchImpl);
    case 'lever':
      return fetchLeverJD(posting, fetchImpl);
    case 'ashby':
      return fetchAshbyJD(posting, fetchImpl);
    case 'hn':
      return fetchHNJD(posting, fetchImpl);
    default:
      throw new Error(`fetchJD: unsupported source ${posting.source}`);
  }
}
