import { test, expect } from 'bun:test';
import { parseHNComment, extractApplicationUrl, findCurrentHNThread, fetchHNPostings } from './hn';

test('a conforming "Company | Role | Location" first line parses confidently', () => {
  const text = 'Acme | Senior SWE | NYC (remote)<p>We build widgets.';
  const result = parseHNComment(text);
  expect(result).toEqual({ company: 'Acme', role: 'Senior SWE', location: 'NYC (remote)', confident: true });
});

test('a non-conforming comment (no pipe-delimited first line) is kept low-confidence, never dropped', () => {
  const text = 'Hey folks, we are building something cool and looking for engineers.';
  const result = parseHNComment(text);
  expect(result.confident).toBe(false);
  expect(result).not.toBeNull();
  expect(typeof result.company).toBe('string');
  expect(typeof result.role).toBe('string');
  expect(typeof result.location).toBe('string');
});

test('never throws on garbage input', () => {
  expect(() => parseHNComment(null as unknown as string)).not.toThrow();
  expect(() => parseHNComment(undefined as unknown as string)).not.toThrow();
  const result = parseHNComment(null as unknown as string);
  expect(result.confident).toBe(false);
});

test('HTML tags/entities are stripped before splitting on pipes', () => {
  const text = '<p>Acme &amp; Co | Senior SWE | NYC&#x2F;Remote</p>';
  const result = parseHNComment(text);
  expect(result.company).toBe('Acme & Co');
  expect(result.role).toBe('Senior SWE');
  expect(result.location).toBe('NYC/Remote');
  expect(result.confident).toBe(true);
});

test('extractApplicationUrl prefers a greenhouse.io link over a bare company homepage link in the same comment', () => {
  const text = 'Acme | SWE | NYC<p>Apply at <a href="https://acme.com">our site</a> or directly via <a href="https://boards.greenhouse.io/acme/jobs/123">greenhouse</a>.';
  const result = extractApplicationUrl(text);
  expect(result).toEqual({ url: 'https://boards.greenhouse.io/acme/jobs/123', fromComment: true });
});

test('extractApplicationUrl falls back to a jobs-ish URL when no known ATS domain is present', () => {
  const text = 'Acme | SWE | NYC<p>Apply here: <a href="https://acme.com/careers/123">careers page</a>.';
  const result = extractApplicationUrl(text);
  expect(result).toEqual({ url: 'https://acme.com/careers/123', fromComment: true });
});

test('extractApplicationUrl returns empty/false when the comment has no link at all', () => {
  const text = 'Acme | SWE | NYC<p>Email us at jobs@acme.com to apply.';
  const result = extractApplicationUrl(text);
  expect(result).toEqual({ url: '', fromComment: false });
});

// --- findCurrentHNThread / fetchHNPostings (Task 2: fetch + freshness + normalization) ---

function stubResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function stubFetch(searchBody: unknown, itemsBody: unknown) {
  return (async (url: string) => {
    if (String(url).includes('search_by_date')) return stubResponse(searchBody);
    if (String(url).includes('/items/')) return stubResponse(itemsBody);
    throw new Error(`unexpected url in stub: ${url}`);
  }) as unknown as typeof fetch;
}

test('findCurrentHNThread returns the objectID of the most recent who-is-hiring hit', async () => {
  const fetchImpl = stubFetch(
    { hits: [{ objectID: '123', title: 'Ask HN: Who is hiring? (July 2026)', created_at_i: 1782918081 }] },
    {},
  );
  const id = await findCurrentHNThread(fetchImpl);
  expect(id).toBe('123');
});

test('findCurrentHNThread throws when no who-is-hiring hit is present', async () => {
  const fetchImpl = stubFetch({ hits: [{ objectID: '999', title: 'Ask HN: Something else', created_at_i: 1 }] }, {});
  await expect(findCurrentHNThread(fetchImpl)).rejects.toThrow();
});

test('fetchHNPostings builds fillable, permalink-fallback, and freshness-filtered postings from thread children', async () => {
  const now = Math.floor(Date.now() / 1000);
  const fresh = now - 60 * 60; // 1 hour old
  const stale = now - 60 * 60 * 24 * 60; // 60 days old

  const searchBody = { hits: [{ objectID: '123', title: 'Ask HN: Who is hiring? (July 2026)', created_at_i: now }] };
  const itemsBody = {
    children: [
      {
        id: 111,
        author: 'acme_hr',
        created_at_i: fresh,
        text: 'Acme | SWE | NYC<p>Apply via <a href="https://boards.greenhouse.io/acme/1">greenhouse</a>.',
      },
      {
        id: 222,
        author: 'nolink_co',
        created_at_i: fresh,
        text: 'NoLink Co | SWE | NYC<p>Email us to apply, no link here.',
      },
      {
        id: 333,
        author: 'stale_co',
        created_at_i: stale,
        text: 'Stale Co | SWE | NYC<p>Apply via <a href="https://boards.greenhouse.io/stale/1">greenhouse</a>.',
      },
    ],
  };
  const fetchImpl = stubFetch(searchBody, itemsBody);

  const postings = await fetchHNPostings({ maxAgeDays: 45 }, fetchImpl);

  expect(postings.length).toBe(2);
  const fillable = postings.find(p => p.company === 'Acme');
  expect(fillable).toBeTruthy();
  expect(fillable!.url).toBe('https://boards.greenhouse.io/acme/1');
  expect(fillable!.source).toBe('hn');
  expect(fillable!.posted_at_trusted).toBe(true);
  expect(fillable!.not_fillable).toBeFalsy();
  expect(fillable!.low_confidence).toBeFalsy();

  const noLink = postings.find(p => p.company === 'NoLink Co');
  expect(noLink).toBeTruthy();
  expect(noLink!.url).toBe('https://news.ycombinator.com/item?id=222');
  expect(noLink!.not_fillable).toBe(true);

  expect(postings.find(p => p.company === 'Stale Co')).toBeUndefined();
});
