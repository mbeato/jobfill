// HN Who's Hiring adapter (SEEK-02, SEEK-04). Finds the current month's thread via
// the Algolia API and heuristically parses comments into candidate NormalizedPostings.
// Zero LLM/API cost — pure regex/split heuristics only, mirroring answers.ts's
// defensive-string-function + try/catch-fallback style.

import type { NormalizedPosting } from './types';

const KNOWN_ATS_HOSTS = ['greenhouse.io', 'lever.co', 'ashbyhq.com'];
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
    const clean = String(text ?? '');
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
