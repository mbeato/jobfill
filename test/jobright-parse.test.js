import { test, expect } from 'vitest';
import { parseJobrightCard, isNoise } from '../scripts/lib/jobright-parse.mjs';

// The line stack Jobright actually renders, in the order the sidecar's comment
// documents: noise header, title, company, industry, geo, type, salary, mode.
const card = (lead = []) => ({
  url: 'https://jobright.ai/jobs/info/abc123',
  allLines: [
    '6 hours ago',
    ...lead,
    'Backend Engineer - AI',
    'Acme Robotics',
    'Artificial Intelligence',
    'San Mateo, CA',
    'Full-time',
    '$120K - $160K',
    'Remote',
    'Entry level',
  ],
});

// ---------------------------------------------------------------------------
// The regression. `/alumni/i` never matched the singular form Jobright renders,
// so the badge became the title and every field shifted by one.
// ---------------------------------------------------------------------------

test('the singular "alumnus" badge is noise, not a title', () => {
  expect(isNoise('1 school alumnus works here')).toBe(true);
  const r = parseJobrightCard(card(['1 school alumnus works here']));
  expect(r.title).toBe('Backend Engineer - AI');
  expect(r.company).toBe('Acme Robotics');
});

test('the plural and the Latin feminine forms are noise too', () => {
  for (const badge of ['3 school alumni work here', '1 school alumna works here', '2 alumnae work here']) {
    expect(isNoise(badge)).toBe(true);
  }
});

test('filter chips above the title are noise — they reached the db as a company', () => {
  expect(isNoise('Python Required')).toBe(true);
  expect(isNoise('Go Required')).toBe(true);
  const r = parseJobrightCard(card(['Python Required']));
  expect(r.title).toBe('Backend Engineer - AI');
  expect(r.company).toBe('Acme Robotics');
});

test('several stacked noise lines still leave the right title', () => {
  const r = parseJobrightCard(card(['1 school alumnus works here', 'Python Required', 'Early Applicant', 'Good match', '87%']));
  expect(r.title).toBe('Backend Engineer - AI');
  expect(r.company).toBe('Acme Robotics');
});

// ---------------------------------------------------------------------------
// The fields that were already right must stay right.
// ---------------------------------------------------------------------------

test('a clean card parses title, company, location and the ago line', () => {
  const r = parseJobrightCard(card());
  expect(r).toMatchObject({
    url: 'https://jobright.ai/jobs/info/abc123',
    title: 'Backend Engineer - AI',
    company: 'Acme Robotics',
    location: 'San Mateo, CA',
    agoLine: '6 hours ago',
  });
});

test('location falls back to a remote/US line when there is no "City, ST"', () => {
  const c = card();
  c.allLines = c.allLines.filter(l => l !== 'San Mateo, CA');
  expect(parseJobrightCard(c).location).toBe('Remote');
});

test('the ago line is still captured even though it is filtered out of the fields', () => {
  const r = parseJobrightCard(card(['1 school alumnus works here']));
  expect(r.agoLine).toBe('6 hours ago');
  expect(r.title).not.toMatch(/ago/i);
});

// ---------------------------------------------------------------------------
// Drop rather than corrupt. A mis-assigned row cost two permanent
// llm:not-relevant rejections and one submitted application with a wrong CRM
// record; an absent row costs one posting that the next sweep re-fetches.
// ---------------------------------------------------------------------------

test('a card whose title is still noise after filtering is dropped, not emitted', () => {
  const r = parseJobrightCard({ url: 'https://jobright.ai/jobs/info/x', allLines: ['4 hours ago', 'Early Applicant'] });
  expect(r).toBeNull();
});

// No length-based guard, and this test pins that decision: the live db holds
// titles up to 140 characters with 412 over 80, so any bound tight enough to
// catch sentence-shaped UI copy also drops real jobs.
test('a long but legitimate title is kept', () => {
  const long = 'Credit Model Development Quantitative Analyst 1 - HELOC & Residential Mortgage - See description';
  const r = parseJobrightCard({ url: 'https://jobright.ai/jobs/info/x', allLines: [long, 'Acme'] });
  expect(r.title).toBe(long);
});

test('a card with no url or no lines is dropped without throwing', () => {
  expect(parseJobrightCard({ url: '', allLines: ['Backend Engineer'] })).toBeNull();
  expect(parseJobrightCard({ url: 'https://x', allLines: [] })).toBeNull();
  expect(parseJobrightCard(null)).toBeNull();
  expect(parseJobrightCard({})).toBeNull();
});

test('blank and whitespace-only lines do not shift the field assignment', () => {
  const r = parseJobrightCard({
    url: 'https://jobright.ai/jobs/info/x',
    allLines: ['', '   ', '2 days ago', '1 school alumnus works here', 'Full-Stack Engineer', 'Globex'],
  });
  expect(r.title).toBe('Full-Stack Engineer');
  expect(r.company).toBe('Globex');
});

// A real title must never be mistaken for noise — the false-positive direction.
// Every string below is a REAL title from the live postings table; each one was
// dropped by a looser draft of these patterns.
test('legitimate titles that merely contain noise-ish words survive', () => {
  for (const t of [
    'Senior Alumni Relations Manager',
    'Interconnection Manager, Network Strategy Americas',
    'Connections Planning Director',
    'Junior Software Developer - Active TS/SCI with Poly Required',
    'Junior Trader (DV Equities) - Mandarin & English Fluency Required',
    'AI Trainer - Automotive Expertise Required',
    'Ubuntu Sales Engineer (English/Spanish Required)',
  ]) {
    expect(isNoise(t), t).toBe(false);
  }
});

test('the chip pattern still catches the single-token form that reached the db', () => {
  for (const chip of ['Python Required', 'Go Required', 'React Required', 'C++ Required', 'Node.js Required']) {
    expect(isNoise(chip), chip).toBe(true);
  }
});
