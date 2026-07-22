// HN Who's Hiring adapter (SEEK-02, SEEK-04). Finds the current month's thread via
// the Algolia API and heuristically parses comments into candidate NormalizedPostings.
// Zero LLM/API cost — pure regex/split heuristics only, mirroring answers.ts's
// defensive-string-function + try/catch-fallback style.

import type { NormalizedPosting } from './types';

const KNOWN_ATS_HOSTS = ['greenhouse.io', 'lever.co', 'ashbyhq.com'];
// Hosts that sit behind a login wall (the sidecar's territory) — a comment
// linking one of these still gets stored, but flagged login_gated so it never
// enters the fillable pool via the HN path.
const LOGIN_GATED_HOSTS = ['workatastartup.com', 'jobright.ai'];
const JOBS_ISH = /jobs|careers|apply|greenhouse|lever|ashby/i;
const URL_RE = /https?:\/\/[^\s"'<>)]+/g;

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#x2F;/gi, '/')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Block-level tags are the only line-break signal in Algolia's comment HTML
// (there are no literal newlines), so they're turned into \n before the rest
// of the markup is stripped — otherwise "Company | Role | Location<p>body"
// would collapse onto one line and swallow the body into the first line.
function stripHtml(html: string): string {
  return decodeEntities(
    String(html ?? '')
      .replace(/<\/?(p|br)[^>]*>/gi, '\n')
      .replace(/<[^>]*>/g, ' '),
  )
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .join('\n');
}

export function parseHNComment(
  text: string,
): { company: string; role: string; location: string; confident: boolean } {
  try {
    const clean = stripHtml(text);
    const firstLine = clean.split('\n').find(l => l.length > 0) ?? '';
    const segments = firstLine.split('|').map(s => s.trim()).filter(Boolean);
    if (segments.length >= 3) {
      return { company: segments[0], role: segments[1], location: segments[2], confident: true };
    }
    // Best-effort: use whatever text precedes the first delimiter (or the whole
    // line) as a company guess; never throw, never return null (D-08).
    const company = (firstLine.split(/[,.;]/)[0] ?? '').trim().slice(0, 200);
    return { company, role: '', location: '', confident: false };
  } catch {
    return { company: '', role: '', location: '', confident: false };
  }
}

export function extractApplicationUrl(text: string): { url: string; fromComment: boolean } {
  try {
    // Algolia HTML-escapes hrefs (https:&#x2F;&#x2F;…) — decode before matching.
    const clean = decodeEntities(String(text ?? ''));
    const urls = clean.match(URL_RE) ?? [];
    if (urls.length === 0) return { url: '', fromComment: false };
    const known = urls.find(u => KNOWN_ATS_HOSTS.some(host => u.includes(host)));
    if (known) return { url: known, fromComment: true };
    const jobsish = urls.find(u => JOBS_ISH.test(u));
    if (jobsish) return { url: jobsish, fromComment: true };
    return { url: urls[0], fromComment: true };
  } catch {
    return { url: '', fromComment: false };
  }
}

interface AlgoliaSearchHit {
  objectID: string;
  title: string;
  created_at_i: number;
}

interface AlgoliaComment {
  id: number;
  text: string;
  created_at_i: number;
  author?: string;
}

const WHO_IS_HIRING_RE = /who is hiring/i;

/**
 * Finds the current month's "Ask HN: Who is hiring?" thread via the Algolia API
 * and returns its objectID. Throws a descriptive Error on a non-2xx response or
 * when no matching hit is found (Algolia results are already sorted by date).
 */
export async function findCurrentHNThread(fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(
    'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&query=hiring',
  );
  if (!res.ok) {
    throw new Error(`Algolia search_by_date failed: ${res.status}`);
  }
  const body = (await res.json()) as { hits?: AlgoliaSearchHit[] };
  const hit = (body.hits ?? []).find(h => WHO_IS_HIRING_RE.test(h.title ?? ''));
  if (!hit) {
    throw new Error('No "Who is hiring?" thread found in Algolia search results');
  }
  return hit.objectID;
}

/**
 * Fetches the current month's HN Who's Hiring thread, comment-level
 * freshness-filters it, and parses each surviving top-level comment into a
 * candidate NormalizedPosting (D-08/D-09). Throws on fetch/parse failure of
 * the Algolia request itself; the /seek route isolates per-source failure.
 */
export async function fetchHNPostings(
  opts: { maxAgeDays?: number } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<NormalizedPosting[]> {
  const maxAgeDays = opts.maxAgeDays ?? 45;
  const objectID = await findCurrentHNThread(fetchImpl);
  const res = await fetchImpl(`https://hn.algolia.com/api/v1/items/${objectID}`);
  if (!res.ok) {
    throw new Error(`Algolia items fetch failed: ${res.status}`);
  }
  const body = (await res.json()) as { children?: AlgoliaComment[] };
  const children = body.children ?? [];
  const cutoff = Date.now() / 1000 - maxAgeDays * 24 * 60 * 60;

  const postings: NormalizedPosting[] = [];
  for (const comment of children) {
    if (!comment || typeof comment.created_at_i !== 'number' || comment.created_at_i < cutoff) continue;
    const text = comment.text ?? '';
    const parsed = parseHNComment(text);
    const applyUrl = extractApplicationUrl(text);
    const permalink = `https://news.ycombinator.com/item?id=${comment.id}`;
    postings.push({
      company: parsed.company,
      title: parsed.role,
      location: parsed.location,
      url: applyUrl.fromComment ? applyUrl.url : permalink,
      source: 'hn',
      posted_at: new Date(comment.created_at_i * 1000).toISOString(),
      posted_at_trusted: true,
      login_gated: applyUrl.fromComment && LOGIN_GATED_HOSTS.some(host => applyUrl.url.includes(host)),
      // D-09: no recognizable apply link -> fall back to the (inert) HN
      // permalink and flag not_fillable so batch fill skips it.
      ...(applyUrl.fromComment ? {} : { not_fillable: true }),
      // D-08: non-conforming comment kept, but flagged low-confidence.
      ...(parsed.confident ? {} : { low_confidence: true }),
    });
  }
  return postings;
}
