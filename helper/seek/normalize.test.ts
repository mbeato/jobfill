import { test, expect } from 'bun:test';
import { normalizeUrl } from './normalize';

test('query params and trailing slash are stripped so tracking-decorated variants collapse to one key', () => {
  const a = normalizeUrl('https://boards.greenhouse.io/acme/jobs/1/');
  const b = normalizeUrl('https://boards.greenhouse.io/acme/jobs/1?utm=x&ref=y');
  expect(a).toBe(b);
  expect(a).toBe('boards.greenhouse.io/acme/jobs/1');
});

test('host is lowercased', () => {
  expect(normalizeUrl('https://BOARDS.GREENHOUSE.IO/acme/jobs/1')).toBe('boards.greenhouse.io/acme/jobs/1');
});

test('a non-URL string returns the trimmed/sliced raw fallback without throwing', () => {
  expect(() => normalizeUrl('not a url')).not.toThrow();
  expect(normalizeUrl('  not a url  ')).toBe('not a url');
});

test('HN item permalinks keep their identity-bearing id param instead of collapsing to one key', () => {
  const a = normalizeUrl('https://news.ycombinator.com/item?id=48747987');
  const b = normalizeUrl('https://news.ycombinator.com/item?id=48748003');
  expect(a).toBe('news.ycombinator.com/item?id=48747987');
  expect(a).not.toBe(b);
});
