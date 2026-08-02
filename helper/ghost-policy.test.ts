import { test, expect } from 'bun:test';
import { laneForUrl, ghostDaysFor, GHOST_DAYS_DEFAULT, GHOST_DAYS_BY_LANE } from './ghost-policy';
import { deriveGhost } from './applications';

const NOW = new Date('2026-08-02T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400000).toISOString().replace('T', ' ').slice(0, 19);
const applied = (url: string | null | undefined, days: number) =>
  deriveGhost({ status: 'applied', status_changed_at: daysAgo(days), url }, NOW);

test('lanes are classified by host', () => {
  expect(laneForUrl('https://www.workatastartup.com/jobs/100285')).toBe('workatastartup');
  expect(laneForUrl('https://jobs.ashbyhq.com/clera/abc/application')).toBe('ashby');
  expect(laneForUrl('https://boards.greenhouse.io/acme/jobs/1')).toBe('greenhouse');
  expect(laneForUrl('https://jobs.lever.co/acme/1')).toBe('lever');
  expect(laneForUrl('https://jobright.ai/jobs/info/abc')).toBe('jobright');
});

test('an unknown board falls back to the previous global default, so nothing changes for it', () => {
  expect(laneForUrl('https://careers.example.com/1')).toBe('other');
  expect(ghostDaysFor('https://careers.example.com/1')).toBe(GHOST_DAYS_DEFAULT);
  expect(ghostDaysFor(null)).toBe(GHOST_DAYS_DEFAULT);
  expect(ghostDaysFor('')).toBe(GHOST_DAYS_DEFAULT);
  expect(ghostDaysFor(undefined)).toBe(GHOST_DAYS_DEFAULT);
});

test('THE POINT: at 14 days a workatastartup row is ghosted and an ATS row is not', () => {
  const was = applied('https://www.workatastartup.com/jobs/1', 14);
  const ats = applied('https://jobs.ashbyhq.com/acme/x/application', 14);

  expect(was.ghosted).toBe(true); // every observed reply here arrived inside 10 days
  expect(ats.ghosted).toBe(false); // ATS pipelines routinely run 3-6 weeks

  expect(was.ghost_after_days).toBe(12);
  expect(ats.ghost_after_days).toBe(28);
});

test('each lane ghosts exactly at its own threshold, not before', () => {
  for (const [lane, threshold] of Object.entries(GHOST_DAYS_BY_LANE)) {
    const url =
      lane === 'workatastartup' ? 'https://www.workatastartup.com/j/1'
      : lane === 'ashby' ? 'https://jobs.ashbyhq.com/a/b/application'
      : lane === 'greenhouse' ? 'https://boards.greenhouse.io/a/jobs/1'
      : lane === 'lever' ? 'https://jobs.lever.co/a/1'
      : lane === 'jobright' ? 'https://jobright.ai/jobs/info/1'
      : 'https://simplify.jobs/p/1';
    expect(applied(url, threshold - 1).ghosted).toBe(false);
    expect(applied(url, threshold).ghosted).toBe(true);
    expect(applied(url, threshold).lane).toBe(lane);
  }
});

test('lane thresholds never override the status rule — only applied rows ghost', () => {
  const old = daysAgo(90);
  for (const status of ['unsubmitted', 'replied', 'interviewing', 'offer', 'rejected']) {
    const r = deriveGhost({ status, status_changed_at: old, url: 'https://www.workatastartup.com/j/1' }, NOW);
    expect(r.ghosted).toBe(false);
  }
  expect(deriveGhost({ status: 'applied', status_changed_at: old, url: 'https://www.workatastartup.com/j/1' }, NOW).ghosted).toBe(true);
});

test('a row with no url behaves exactly as before this feature existed', () => {
  expect(applied(undefined, GHOST_DAYS_DEFAULT - 1).ghosted).toBe(false);
  expect(applied(undefined, GHOST_DAYS_DEFAULT).ghosted).toBe(true);
});

test('ghost_after_days is surfaced so the UI can explain the decision', () => {
  const r = applied('https://jobs.ashbyhq.com/a/b/application', 5);
  expect(r).toMatchObject({ ghosted: false, days_silent: 5, ghost_after_days: 28, lane: 'ashby' });
});
