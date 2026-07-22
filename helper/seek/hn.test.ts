import { test, expect } from 'bun:test';
import { parseHNComment, extractApplicationUrl } from './hn';

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
