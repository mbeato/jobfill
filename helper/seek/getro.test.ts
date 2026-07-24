import { test, expect, describe } from 'bun:test';
import { parseNextData, normalizeGetroJob } from './getro';

// Captured live shape (jobs.uncorkcapital.com/jobs, 2026-07-24) — see
// 16-RESEARCH.md Pattern 1. id=87473113, Tailscale.
const TAILSCALE_JOB = {
  id: 87473113,
  organization: { name: 'Tailscale', slug: 'tailscale', id: 21967 },
  title: 'Sales Development Representative (Outbound)',
  url: 'https://boards.greenhouse.io/tailscale/jobs/4717966005',
  locations: ['Vancouver, BC, Canada'],
  createdAt: 1784902046,
  source: 'career_page',
  workMode: 'on_site',
};

function nextDataHtml(jobs: unknown[], total: number, networkId = 247, label = 'uncorkcapital') {
  const blob = {
    props: {
      pageProps: {
        network: { id: networkId, label },
        initialState: { jobs: { found: jobs, total } },
      },
    },
  };
  return `<html><head></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(blob)}</script></body></html>`;
}

describe('parseNextData', () => {
  test('parses the fixture blob', () => {
    const data = parseNextData(nextDataHtml([TAILSCALE_JOB], 729));
    expect(data.props.pageProps.network.id).toBe(247);
    expect(data.props.pageProps.initialState.jobs.total).toBe(729);
  });

  test('throws on HTML with no __NEXT_DATA__ blob', () => {
    expect(() => parseNextData('<html><body>nope</body></html>')).toThrow();
  });

  test('throws on a blob containing invalid JSON', () => {
    const html = '<script id="__NEXT_DATA__" type="application/json">{not valid json</script>';
    expect(() => parseNextData(html)).toThrow();
  });
});

describe('normalizeGetroJob', () => {
  test('maps organization.name to company, title, url and the joined location', () => {
    const p = normalizeGetroJob(TAILSCALE_JOB);
    expect(p.company).toBe('Tailscale');
    expect(p.title).toBe('Sales Development Representative (Outbound)');
    expect(p.url).toBe('https://boards.greenhouse.io/tailscale/jobs/4717966005');
    expect(p.location).toBe('Vancouver, BC, Canada');
  });

  test('converts createdAt unix seconds to the ISO of createdAt * 1000', () => {
    const p = normalizeGetroJob(TAILSCALE_JOB);
    expect(p.posted_at).toBe(new Date(1784902046 * 1000).toISOString());
  });

  test('yields source getro and posted_at_trusted false', () => {
    const p = normalizeGetroJob(TAILSCALE_JOB);
    expect(p.source).toBe('getro');
    expect(p.posted_at_trusted).toBe(false);
  });

  test('tolerates a missing organization, missing locations and a null createdAt without throwing', () => {
    expect(() => normalizeGetroJob({})).not.toThrow();
    const p = normalizeGetroJob({ createdAt: null });
    expect(p.company).toBe('');
    expect(p.location).toBe('');
    expect(p.posted_at).toBeNull();
  });
});
