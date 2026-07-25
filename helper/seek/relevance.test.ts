import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { scoreRelevance, loadProfileSummary, DEFAULT_PROFILE_SUMMARY } from './relevance';
import { createSeekMetaTable } from './meta';
import { saveRelevanceProfile } from './criteria';
import type { PostingRow } from './postings';

function makeDb(): Database {
  const db = new Database(':memory:');
  createSeekMetaTable(db);
  return db;
}

function makePostingRow(overrides: Partial<PostingRow> = {}): PostingRow {
  return {
    id: 1,
    url: 'https://boards.greenhouse.io/acme/jobs/1',
    url_key: 'boards.greenhouse.io/acme/jobs/1',
    company: 'acme',
    title: 'Software Engineer',
    location: 'New York, NY',
    source: 'greenhouse',
    posted_at: null,
    posted_at_trusted: false,
    login_gated: false,
    not_fillable: false,
    low_confidence: false,
    fetched_at: '2026-07-22 00:00:00',
    created_at: '2026-07-22 00:00:00',
    ...overrides,
  };
}

test('scoreRelevance resolves {relevant: true, reason} when mapImpl returns that structured_output', async () => {
  const result = await scoreRelevance('profile summary', 'jd text', makePostingRow(), async () => ({
    relevant: true,
    reason: 'matches target stack and NY location',
  }));
  expect(result).toEqual({ relevant: true, reason: 'matches target stack and NY location' });
});

test('scoreRelevance resolves {relevant: false, reason} when mapImpl returns that structured_output', async () => {
  const result = await scoreRelevance('profile summary', 'jd text', makePostingRow(), async () => ({
    relevant: false,
    reason: 'requires 5+ years experience',
  }));
  expect(result).toEqual({ relevant: false, reason: 'requires 5+ years experience' });
});

test('scoreRelevance rethrows when mapImpl throws (CLI error/timeout) so the caller can hold (D-08)', async () => {
  const failing = async () => {
    throw new Error('mapViaCLI failed (is_error=true): timeout');
  };
  await expect(scoreRelevance('profile summary', 'jd text', makePostingRow(), failing)).rejects.toThrow(
    'mapViaCLI failed',
  );
});

test('scoreRelevance throws when mapImpl returns a malformed shape (missing relevant/reason)', async () => {
  const malformed = async () => ({ relevant: true }); // missing reason
  await expect(scoreRelevance('profile summary', 'jd text', makePostingRow(), malformed)).rejects.toThrow(
    'malformed verdict shape',
  );
});

test('scoreRelevance slices an overlong reason to 500 chars', async () => {
  const longReason = 'x'.repeat(600);
  const result = await scoreRelevance('profile summary', 'jd text', makePostingRow(), async () => ({
    relevant: true,
    reason: longReason,
  }));
  expect(result.reason.length).toBe(500);
});

test('loadProfileSummary returns the stored relevance_profile row text when present', async () => {
  const db = makeDb();
  saveRelevanceProfile(db, 'Target roles: backend engineer.');
  const text = await loadProfileSummary(db);
  expect(text).toBe('Target roles: backend engineer.');
});

test('loadProfileSummary returns DEFAULT_PROFILE_SUMMARY when no row exists', async () => {
  const db = makeDb();
  const text = await loadProfileSummary(db);
  expect(text).toBe(DEFAULT_PROFILE_SUMMARY);
});

test('loadProfileSummary returns DEFAULT_PROFILE_SUMMARY when the stored row is empty/whitespace', async () => {
  const db = makeDb();
  saveRelevanceProfile(db, '   \n  ');
  const text = await loadProfileSummary(db);
  expect(text).toBe(DEFAULT_PROFILE_SUMMARY);
});

test('empty jdText on a login-gated posting triggers trusted-side metadata-only guidance, not injected-looking jd content', async () => {
  let seenPrompt = '';
  const mapImpl = async (prompt: string) => {
    seenPrompt = prompt;
    return { relevant: true, reason: 'metadata fit' };
  };
  const posting = {
    id: 1, company: 'Acme', title: 'Founding Engineer', location: 'New York, NY',
    url: 'https://www.workatastartup.com/jobs/1', source: 'yc',
    posted_at: null, posted_at_trusted: false, login_gated: true, not_fillable: false,
    fetched_at: '', decision: null, decision_reason: null, decided_at: null,
  } as never;
  await scoreRelevance('profile', '', posting, mapImpl);
  expect(seenPrompt).toContain('login-gated source');
  expect(seenPrompt).toContain('Do NOT reject merely because the description is missing');
  // guidance sits before the untrusted DATA block, and the jd slot holds only the inert placeholder
  expect(seenPrompt.indexOf('login-gated source:')).toBeLessThan(seenPrompt.indexOf('=== POSTING DATA'));
  expect(seenPrompt).toContain('(not available — login-gated source)');
});

// WR-01: metadataOnly must key off posting.login_gated, not off jdText being
// empty — an ordinary (non-login-gated) fetch that legitimately returns ''
// must never be told "this posting comes from a login-gated source".
test('empty jdText on a non-login-gated posting gets a neutral placeholder, no login-gated guidance', async () => {
  let seenPrompt = '';
  const mapImpl = async (prompt: string) => {
    seenPrompt = prompt;
    return { relevant: true, reason: 'metadata fit' };
  };
  const posting = {
    id: 1, company: 'Acme', title: 'Founding Engineer', location: 'New York, NY',
    url: 'https://boards.greenhouse.io/acme/jobs/1', source: 'greenhouse',
    posted_at: null, posted_at_trusted: false, login_gated: false, not_fillable: false,
    fetched_at: '', decision: null, decision_reason: null, decided_at: null,
  } as never;
  await scoreRelevance('profile', '', posting, mapImpl);
  expect(seenPrompt).not.toContain('login-gated source');
  expect(seenPrompt).not.toContain('Do NOT reject merely because the description is missing');
  expect(seenPrompt).toContain('(job description was empty)');
});
