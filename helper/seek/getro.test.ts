import { test, expect, describe } from 'bun:test';
import { parseNextData, normalizeGetroJob, fetchGetroPage, fetchGetro, MAX_GETRO_PAGES, type GetroNetwork } from './getro';

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

function stubFetch(handler: (url: string) => Response): typeof fetch {
  return (async (url: unknown) => handler(String(url))) as unknown as typeof fetch;
}

describe('fetchGetroPage', () => {
  test('throws on a non-2xx stub', async () => {
    const stub = stubFetch(() => new Response('', { status: 500 }));
    await expect(fetchGetroPage('bad.getro.com', 1, stub)).rejects.toThrow();
  });
});

describe('fetchGetro', () => {
  test('isolates a failing network — resolves with postings from the healthy network only and one error naming the failing network', async () => {
    const networks: GetroNetwork[] = [
      { name: 'good', id: '1', host: 'good.getro.com' },
      { name: 'bad', id: '2', host: 'bad.getro.com' },
    ];
    const stub = stubFetch((url) =>
      url.includes('good.getro.com')
        ? new Response(nextDataHtml([TAILSCALE_JOB], 1), { status: 200 })
        : new Response('', { status: 500 }),
    );
    const result = await fetchGetro(networks, stub);
    expect(result.postings.length).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].network).toBe('bad');
  });

  test('isolates a network whose HTML has no __NEXT_DATA__ blob', async () => {
    const networks: GetroNetwork[] = [
      { name: 'good', id: '1', host: 'good.getro.com' },
      { name: 'noblob', id: '3', host: 'noblob.getro.com' },
    ];
    const stub = stubFetch((url) =>
      url.includes('good.getro.com')
        ? new Response(nextDataHtml([TAILSCALE_JOB], 1), { status: 200 })
        : new Response('<html><body>no blob here</body></html>', { status: 200 }),
    );
    const result = await fetchGetro(networks, stub);
    expect(result.postings.length).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].network).toBe('noblob');
  });

  test('paginates within the reported total, one request per page', async () => {
    const calls: string[] = [];
    const stub = stubFetch((url) => {
      calls.push(url);
      return new Response(nextDataHtml([TAILSCALE_JOB, TAILSCALE_JOB], 5), { status: 200 });
    });
    const result = await fetchGetro([{ name: 'x', id: '1', host: 'x.getro.com' }], stub);
    // ceil(5 / 2) = 3 pages
    expect(calls.length).toBe(3);
    expect(result.postings.length).toBe(6);
  });

  test('never requests page 11 when total is absurdly large', async () => {
    const calls: string[] = [];
    const stub = stubFetch((url) => {
      calls.push(url);
      return new Response(nextDataHtml([TAILSCALE_JOB, TAILSCALE_JOB], 100000), { status: 200 });
    });
    await fetchGetro([{ name: 'x', id: '1', host: 'x.getro.com' }], stub);
    expect(calls.length).toBe(MAX_GETRO_PAGES);
    expect(calls.some((u) => u.includes('page=11'))).toBe(false);
  });
});
