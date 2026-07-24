import { test, expect } from 'bun:test';
import { extractAtsToken } from './slug-harvest';

const CASES: { url: string; expected: ReturnType<typeof extractAtsToken> }[] = [
  {
    url: 'https://job-boards.greenhouse.io/applytotruebuilt/jobs/4588866004',
    expected: { ats: 'greenhouse', token: 'applytotruebuilt' },
  },
  {
    url: 'https://boards.greenhouse.io/spacex/jobs/8393626002',
    expected: { ats: 'greenhouse', token: 'spacex' },
  },
  {
    url: 'https://job-boards.eu.greenhouse.io/agency/jobs/4754242101',
    expected: { ats: 'greenhouse', token: 'agency' },
  },
  {
    url: 'https://boards.greenhouse.io/embed/job_app?token=6099883',
    expected: null,
  },
  {
    url: 'https://jobs.lever.co/commercearchitects/ec4bd3b5-1234-5678-9abc-def012345678/apply',
    expected: { ats: 'lever', token: 'commercearchitects' },
  },
  {
    url: 'https://jobs.ashbyhq.com/magical/2c4734af-1234-5678-9abc-def012345678',
    expected: { ats: 'ashby', token: 'magical' },
  },
  {
    url: 'https://jobs.smartrecruiters.com/Company/123',
    expected: null,
  },
  {
    url: 'https://ngc.wd1.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/1',
    expected: null,
  },
  { url: '', expected: null },
  { url: 'not a url', expected: null },
  { url: 'javascript:alert(1)', expected: null },
  { url: 'https://boards.greenhouse.io/', expected: null },
];

for (const { url, expected } of CASES) {
  test(`extractAtsToken(${JSON.stringify(url)}) -> ${JSON.stringify(expected)}`, () => {
    expect(extractAtsToken(url)).toEqual(expected);
  });
}

test('extractAtsToken never throws on garbage input', () => {
  expect(() => extractAtsToken(null as unknown as string)).not.toThrow();
  expect(extractAtsToken(null as unknown as string)).toBeNull();
  expect(() => extractAtsToken(undefined as unknown as string)).not.toThrow();
  expect(extractAtsToken(undefined as unknown as string)).toBeNull();
});

test('extractAtsToken lowercases the host before matching but preserves token case', () => {
  expect(extractAtsToken('https://BOARDS.GREENHOUSE.IO/SpaceX/jobs/1')).toEqual({
    ats: 'greenhouse',
    token: 'SpaceX',
  });
});
