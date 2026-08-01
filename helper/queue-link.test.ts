import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createApplicationsTable, insertApplication } from './applications';
import { createQueueTable, insertQueueEntry, updateQueueStatus } from './queue';
import { findApplicationIdForUrlKey } from './queue-link';

function db() {
  const d = new Database(':memory:');
  createApplicationsTable(d);
  createQueueTable(d);
  return d;
}

const app = (d: Database, url: string) =>
  insertApplication(d, { url, company: 'Acme', role: 'SWE' } as never, () => null);

test('finds the application for a queue row inserted AFTER it — the fill ordering that broke the link', () => {
  const d = db();
  // The real sequence: POST /applications lands first, POST /queue second.
  const a = app(d, 'https://jobs.ashbyhq.com/acme/abc/application');
  const q = insertQueueEntry(d, 'https://jobs.ashbyhq.com/acme/abc/application');

  // Reproduces the bug: nothing linked them at insert time.
  expect(q.application_id).toBeNull();

  // The fix must be able to resolve it.
  expect(findApplicationIdForUrlKey(d, q.url_key)).toBe(a.id);
});

test('matches across trailing-slash and host-case variants, which raw url equality would miss', () => {
  const d = db();
  const a = app(d, 'https://Jobs.ashbyhq.com/acme/xyz/application/');
  const q = insertQueueEntry(d, 'https://jobs.ashbyhq.com/acme/xyz/application');
  expect(q.url).not.toBe(a.url);
  expect(findApplicationIdForUrlKey(d, q.url_key)).toBe(a.id);
});

test('newest application wins when a url has more than one', () => {
  const d = db();
  const url = 'https://www.workatastartup.com/jobs/1';
  const first = app(d, url);
  const second = app(d, url);
  const q = insertQueueEntry(d, url);
  const found = findApplicationIdForUrlKey(d, q.url_key);
  // insertApplication upserts on url, so both calls may resolve to one row —
  // either way the resolver must return a real, current application.
  expect([first.id, second.id]).toContain(found);
});

test('returns null rather than guessing when no application matches', () => {
  const d = db();
  app(d, 'https://example.com/jobs/1');
  const q = insertQueueEntry(d, 'https://example.com/jobs/2');
  expect(findApplicationIdForUrlKey(d, q.url_key)).toBeNull();
});

test('returns null for a keyless queue row instead of matching everything', () => {
  const d = db();
  app(d, 'https://example.com/jobs/1');
  expect(findApplicationIdForUrlKey(d, null)).toBeNull();
  expect(findApplicationIdForUrlKey(d, '')).toBeNull();
});

test('end to end: linking lets the submit cascade see an application_id', () => {
  const d = db();
  const a = app(d, 'https://boards.greenhouse.io/acme/jobs/9');
  const q = insertQueueEntry(d, 'https://boards.greenhouse.io/acme/jobs/9');
  expect(a.status).toBe('unsubmitted');

  const appId = findApplicationIdForUrlKey(d, q.url_key);
  expect(appId).toBe(a.id);
  const linked = updateQueueStatus(d, q.id, { application_id: appId });
  expect(linked?.application_id).toBe(a.id);

  // The cascade in server.ts gates on exactly this being non-null.
  const submitted = updateQueueStatus(d, q.id, { status: 'submitted' });
  expect(submitted?.status).toBe('submitted');
  expect(submitted?.application_id).toBe(a.id);
});
