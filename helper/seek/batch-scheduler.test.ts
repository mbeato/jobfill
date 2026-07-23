import { test, expect } from 'bun:test';
import { shouldFireBatchToday } from './batch-scheduler';
import type { LastRunState } from './runs';
import type { BatchConfig } from './types';

function batchConfig(overrides: Partial<BatchConfig> = {}): BatchConfig {
  return { enabled: true, cap: 10, hostAllowlist: [], ...overrides };
}

function now(): Date {
  return new Date();
}

const TODAY = new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0') + '-' + String(new Date().getDate()).padStart(2, '0');
const YESTERDAY = (() => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
})();

const SWEEP_OK_TODAY: LastRunState = { date: TODAY, status: 'ok', attempts: 1 };
const SWEEP_RETRIES_EXHAUSTED_TODAY: LastRunState = { date: TODAY, status: 'failed', attempts: 3 };
const SWEEP_RUNNING_TODAY: LastRunState = { date: TODAY, status: 'running', attempts: 1 };
const SWEEP_FAILED_UNDER_CAP_TODAY: LastRunState = { date: TODAY, status: 'failed', attempts: 2 };
const SWEEP_OK_YESTERDAY: LastRunState = { date: YESTERDAY, status: 'ok', attempts: 1 };

test('disabled batch config returns false regardless of sweep/lastBatchRun state', () => {
  expect(shouldFireBatchToday(now(), batchConfig({ enabled: false }), null, SWEEP_OK_TODAY)).toBe(false);
});

test('batch already ok today returns false', () => {
  const lastBatchRun: LastRunState = { date: TODAY, status: 'ok', attempts: 1 };
  expect(shouldFireBatchToday(now(), batchConfig(), lastBatchRun, SWEEP_OK_TODAY)).toBe(false);
});

test('batch failed today at the retry cap (attempts >= 3) returns false', () => {
  const lastBatchRun: LastRunState = { date: TODAY, status: 'failed', attempts: 3 };
  expect(shouldFireBatchToday(now(), batchConfig(), lastBatchRun, SWEEP_OK_TODAY)).toBe(false);
});

test('no lastSweepRun (sweep never ran) returns false — sweep has not settled', () => {
  expect(shouldFireBatchToday(now(), batchConfig(), null, null)).toBe(false);
});

test('lastSweepRun from a prior day returns false — today\'s sweep has not settled', () => {
  expect(shouldFireBatchToday(now(), batchConfig(), null, SWEEP_OK_YESTERDAY)).toBe(false);
});

test('sweep settled today via status ok and batch not yet run returns true', () => {
  expect(shouldFireBatchToday(now(), batchConfig(), null, SWEEP_OK_TODAY)).toBe(true);
});

test('sweep settled today via attempts >= 3 (retries exhausted, status failed) and batch not yet run returns true (D-05 decoupling from sweep success)', () => {
  expect(shouldFireBatchToday(now(), batchConfig(), null, SWEEP_RETRIES_EXHAUSTED_TODAY)).toBe(true);
});

test('sweep still running today (not settled) returns false', () => {
  expect(shouldFireBatchToday(now(), batchConfig(), null, SWEEP_RUNNING_TODAY)).toBe(false);
});

test('sweep failed today but under the retry cap (not settled) returns false', () => {
  expect(shouldFireBatchToday(now(), batchConfig(), null, SWEEP_FAILED_UNDER_CAP_TODAY)).toBe(false);
});

test('batch failed today under the retry cap, sweep settled today returns true (retry allowed)', () => {
  const lastBatchRun: LastRunState = { date: TODAY, status: 'failed', attempts: 1 };
  expect(shouldFireBatchToday(now(), batchConfig(), lastBatchRun, SWEEP_OK_TODAY)).toBe(true);
});

test('lastBatchRun from a prior day resets — new day fires again given a settled sweep', () => {
  const lastBatchRun: LastRunState = { date: YESTERDAY, status: 'ok', attempts: 1 };
  expect(shouldFireBatchToday(now(), batchConfig(), lastBatchRun, SWEEP_OK_TODAY)).toBe(true);
});
