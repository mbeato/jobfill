import { test, expect } from 'bun:test';
import { hostAllowed, selectEligible, classifyReviewFlags } from './batch-eligibility';
import type { QueueRow } from '../queue';
import type { BatchConfig } from './types';

const ALLOWLIST = ['greenhouse.io', 'lever.co', 'ashbyhq.com'];

function batchConfig(overrides: Partial<BatchConfig> = {}): BatchConfig {
  return { enabled: true, cap: 10, hostAllowlist: ALLOWLIST, ...overrides };
}

let nextId = 1;
function row(overrides: Partial<QueueRow> = {}): QueueRow {
  return {
    id: nextId++,
    url: 'https://boards.greenhouse.io/acme/jobs/1',
    status: 'queued',
    company: 'Acme',
    role: 'Fullstack SWE',
    application_id: null,
    results_summary: '',
    error: '',
    url_key: null,
    login_gated: 0,
    not_fillable: 0,
    low_confidence: 0,
    created_at: '2026-07-23T00:00:00.000Z',
    updated_at: '2026-07-23T00:00:00.000Z',
    ...overrides,
  };
}

// hostAllowed

test('hostAllowed accepts a subdomain match', () => {
  expect(hostAllowed('https://boards.greenhouse.io/acme/jobs/1', ALLOWLIST)).toBe(true);
});

test('hostAllowed accepts an exact allowlist entry among several', () => {
  expect(hostAllowed('https://jobs.lever.co/acme/x', ALLOWLIST)).toBe(true);
});

test('hostAllowed rejects a host not on the allowlist', () => {
  expect(hostAllowed('https://acme.workday.com/job/1', ALLOWLIST)).toBe(false);
});

test('hostAllowed rejects an unparseable URL without throwing', () => {
  expect(hostAllowed('not-a-url', ALLOWLIST)).toBe(false);
});

test('hostAllowed rejects the substring-prefix bypass (evilgreenhouse.io)', () => {
  expect(hostAllowed('https://evilgreenhouse.io/x', ['greenhouse.io'])).toBe(false);
});

test('hostAllowed rejects the suffix-append bypass (greenhouse.io.attacker.com)', () => {
  expect(hostAllowed('https://greenhouse.io.attacker.com/x', ['greenhouse.io'])).toBe(false);
});

// selectEligible

test('selectEligible skips a login_gated row with reason login-gated', () => {
  const rows = [row({ login_gated: 1 })];
  const result = selectEligible(rows, batchConfig());
  expect(result.skipped).toEqual([
    { queueId: rows[0].id, company: 'Acme', role: 'Fullstack SWE', url: rows[0].url, reason: 'login-gated' },
  ]);
  expect(result.toFill).toEqual([]);
});

test('selectEligible skips a not_fillable row with reason not-fillable', () => {
  const rows = [row({ not_fillable: 1 })];
  const result = selectEligible(rows, batchConfig());
  expect(result.skipped[0].reason).toBe('not-fillable');
});

test('selectEligible skips an off-allowlist host with reason unsupported-host', () => {
  const rows = [row({ url: 'https://acme.workday.com/job/1' })];
  const result = selectEligible(rows, batchConfig());
  expect(result.skipped[0].reason).toBe('unsupported-host');
});

test('selectEligible only considers queued-status rows — others are neither toFill nor skipped', () => {
  const rows = [
    row({ status: 'filling' }),
    row({ status: 'filled' }),
    row({ status: 'failed' }),
    row({ status: 'reviewed' }),
    row({ status: 'submitted' }),
  ];
  const result = selectEligible(rows, batchConfig());
  expect(result.toFill).toEqual([]);
  expect(result.skipped).toEqual([]);
});

test('selectEligible preserves newest-first input order in toFill', () => {
  const rows = [row({ company: 'Newest' }), row({ company: 'Middle' }), row({ company: 'Oldest' })];
  const result = selectEligible(rows, batchConfig({ cap: 10 }));
  expect(result.toFill.map(c => c.company)).toEqual(['Newest', 'Middle', 'Oldest']);
});

test('selectEligible caps the fill set by headroom, deferring the rest (neither toFill nor skipped)', () => {
  const rows = [row(), row(), row(), row()];
  // backlog 0, cap 2 -> headroom 2
  const result = selectEligible(rows, batchConfig({ cap: 2 }));
  expect(result.toFill.length).toBe(2);
  expect(result.skipped.length).toBe(0);
  expect(result.capReached).toBe(true);
  expect(result.headroom).toBe(2);
  expect(result.backlog).toBe(0);
});

test('selectEligible with backlog >= cap returns toFill empty and capReached true', () => {
  const rows = [row({ status: 'filled' }), row({ status: 'reviewed' }), row()];
  const result = selectEligible(rows, batchConfig({ cap: 2 }));
  expect(result.backlog).toBe(2);
  expect(result.headroom).toBe(0);
  expect(result.toFill).toEqual([]);
  expect(result.capReached).toBe(true);
});

test('selectEligible with headroom 0 and no eligible candidates has capReached false', () => {
  const rows = [row({ status: 'filled' }), row({ status: 'reviewed' })];
  const result = selectEligible(rows, batchConfig({ cap: 2 }));
  expect(result.headroom).toBe(0);
  expect(result.toFill).toEqual([]);
  expect(result.capReached).toBe(false);
});

// classifyReviewFlags

test('classifyReviewFlags flags a stuck===false field even when its status is filled', () => {
  const summary = JSON.stringify([{ id: 'a', label: 'Email', status: 'filled', stuck: false }]);
  expect(classifyReviewFlags(summary)).toEqual({ flagged: true, flaggedCount: 1 });
});

test('classifyReviewFlags flags a review-worthy status', () => {
  const summary = JSON.stringify([{ id: 'a', label: 'Resume', status: 'verify' }]);
  expect(classifyReviewFlags(summary).flagged).toBe(true);
});

test('classifyReviewFlags returns flagged:false for an all-clean summary', () => {
  const summary = JSON.stringify([
    { id: 'a', label: 'Email', status: 'filled', stuck: true },
    { id: 'b', label: 'Name', status: 'filled' },
  ]);
  expect(classifyReviewFlags(summary)).toEqual({ flagged: false, flaggedCount: 0 });
});

test('classifyReviewFlags returns flagged:true on malformed JSON (fail-safe)', () => {
  expect(classifyReviewFlags('{not json')).toEqual({ flagged: true, flaggedCount: 0 });
});

test('classifyReviewFlags returns flagged:true on non-array JSON (fail-safe)', () => {
  expect(classifyReviewFlags(JSON.stringify({ oops: true }))).toEqual({ flagged: true, flaggedCount: 0 });
});

test('classifyReviewFlags returns flagged:false for an empty array', () => {
  expect(classifyReviewFlags('[]')).toEqual({ flagged: false, flaggedCount: 0 });
});
