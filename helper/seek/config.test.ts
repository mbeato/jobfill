import { test, expect } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSeekConfig } from './config';

function fixturePath(name: string): string {
  return join(tmpdir(), `seek-config-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test('a well-formed config round-trips enabled flags and token arrays', async () => {
  const path = fixturePath('wellformed');
  await Bun.write(
    path,
    JSON.stringify({
      greenhouse: { enabled: true, tokens: ['acme', 'beta'] },
      lever: { enabled: false, tokens: [] },
      ashby: { enabled: true, tokens: ['gamma'] },
      hn: { enabled: true },
      yc: { enabled: false },
      jobright: { enabled: true },
      simplify: { enabled: true },
      getro: {
        enabled: true,
        networks: [
          { name: 'craftventures', id: '340', host: 'jobs.craftventures.com' },
          { name: 'mercuryfund', id: '1258' },
        ],
      },
      ycdir: { enabled: true },
      blocklist: ['badcompany'],
    }),
  );
  const config = await loadSeekConfig(path);
  expect(config.greenhouse).toEqual({ enabled: true, tokens: ['acme', 'beta'] });
  expect(config.ashby).toEqual({ enabled: true, tokens: ['gamma'] });
  expect(config.hn).toEqual({ enabled: true });
  expect(config.jobright).toEqual({ enabled: true });
  expect(config.simplify).toEqual({ enabled: true });
  expect(config.getro).toEqual({
    enabled: true,
    networks: [
      { name: 'craftventures', id: '340', host: 'jobs.craftventures.com' },
      { name: 'mercuryfund', id: '1258' },
    ],
  });
  expect(config.ycdir).toEqual({ enabled: true });
  expect(config.blocklist).toEqual(['badcompany']);
});

test('a missing path returns the all-disabled default without throwing', async () => {
  const config = await loadSeekConfig('/nonexistent/path/seek.config.json');
  expect(config.greenhouse).toEqual({ enabled: false, tokens: [] });
  expect(config.lever).toEqual({ enabled: false, tokens: [] });
  expect(config.ashby).toEqual({ enabled: false, tokens: [] });
  expect(config.hn).toEqual({ enabled: false });
  expect(config.yc).toEqual({ enabled: false });
  expect(config.jobright).toEqual({ enabled: false });
  expect(config.simplify).toEqual({ enabled: false });
  expect(config.getro).toEqual({ enabled: false, networks: [] });
  expect(config.ycdir).toEqual({ enabled: false });
  expect(config.blocklist).toEqual([]);
});

test('malformed/garbage-typed config is coerced to safe values, not propagated raw', async () => {
  const path = fixturePath('malformed');
  await Bun.write(
    path,
    JSON.stringify({
      greenhouse: { enabled: 'yes', tokens: 'not-an-array' },
      lever: { enabled: true, tokens: [1, 2, 'valid-token'] },
      getro: {
        enabled: true,
        networks: 'nope',
      },
      simplify: 'yes',
      blocklist: {},
    }),
  );
  const config = await loadSeekConfig(path);
  expect(config.greenhouse).toEqual({ enabled: true, tokens: [] });
  expect(config.lever).toEqual({ enabled: true, tokens: ['valid-token'] });
  expect(config.getro).toEqual({ enabled: true, networks: [] });
  expect(config.simplify).toEqual({ enabled: false });
  expect(config.blocklist).toEqual([]);
});

test('a getro.networks entry missing id drops that entry only, keeping valid siblings', async () => {
  const path = fixturePath('getro-partial');
  await Bun.write(
    path,
    JSON.stringify({
      getro: {
        enabled: true,
        networks: [
          { name: 'craftventures', id: '340' },
          { name: 'nomissing' },
          'a bare string',
          { name: 'uncorkcapital', id: '247', host: 'jobs.uncorkcapital.com' },
        ],
      },
    }),
  );
  const config = await loadSeekConfig(path);
  expect(config.getro).toEqual({
    enabled: true,
    networks: [
      { name: 'craftventures', id: '340' },
      { name: 'uncorkcapital', id: '247', host: 'jobs.uncorkcapital.com' },
    ],
  });
});

test('reading is fresh: editing the fixture between two calls returns the updated value', async () => {
  const path = fixturePath('fresh');
  await Bun.write(path, JSON.stringify({ greenhouse: { enabled: false, tokens: [] } }));
  const first = await loadSeekConfig(path);
  expect(first.greenhouse.enabled).toBe(false);
  await Bun.write(path, JSON.stringify({ greenhouse: { enabled: true, tokens: ['acme'] } }));
  const second = await loadSeekConfig(path);
  expect(second.greenhouse).toEqual({ enabled: true, tokens: ['acme'] });
});

test('reading is fresh: an edited blocklist takes effect on the next call with no restart', async () => {
  const path = fixturePath('fresh-blocklist');
  await Bun.write(path, JSON.stringify({ blocklist: [] }));
  const first = await loadSeekConfig(path);
  expect(first.blocklist).toEqual([]);
  await Bun.write(path, JSON.stringify({ blocklist: ['dropped-company'] }));
  const second = await loadSeekConfig(path);
  expect(second.blocklist).toEqual(['dropped-company']);
});

test('a well-formed schedule section round-trips enabled and targetHour', async () => {
  const path = fixturePath('schedule-wellformed');
  await Bun.write(path, JSON.stringify({ schedule: { enabled: true, targetHour: 9 } }));
  const config = await loadSeekConfig(path);
  expect(config.schedule).toEqual({ enabled: true, targetHour: 9 });
});

test('a missing schedule key defaults to disabled/targetHour 7', async () => {
  const path = fixturePath('schedule-missing');
  await Bun.write(path, JSON.stringify({ greenhouse: { enabled: true, tokens: [] } }));
  const config = await loadSeekConfig(path);
  expect(config.schedule).toEqual({ enabled: false, targetHour: 7 });
});

test('a non-numeric targetHour falls back to 7 (fail-closed), enabled still honored', async () => {
  const path = fixturePath('schedule-nan');
  await Bun.write(path, JSON.stringify({ schedule: { enabled: true, targetHour: 'nope' } }));
  const config = await loadSeekConfig(path);
  expect(config.schedule).toEqual({ enabled: true, targetHour: 7 });
});

test('an out-of-range targetHour falls back to 7', async () => {
  const path = fixturePath('schedule-outofrange');
  await Bun.write(path, JSON.stringify({ schedule: { enabled: true, targetHour: 25 } }));
  const config = await loadSeekConfig(path);
  expect(config.schedule).toEqual({ enabled: true, targetHour: 7 });
});

test('a missing/malformed config file still returns the default schedule section', async () => {
  const config = await loadSeekConfig('/nonexistent/path/seek.config.json');
  expect(config.schedule).toEqual({ enabled: false, targetHour: 7 });
});

test('a well-formed batch section round-trips enabled/cap/hostAllowlist', async () => {
  const path = fixturePath('batch-wellformed');
  await Bun.write(
    path,
    JSON.stringify({ batch: { enabled: true, cap: 25, hostAllowlist: ['greenhouse.io'] } }),
  );
  const config = await loadSeekConfig(path);
  expect(config.batch).toEqual({ enabled: true, cap: 25, hostAllowlist: ['greenhouse.io'] });
});

test('a missing batch key defaults to disabled/cap 10/empty hostAllowlist', async () => {
  const path = fixturePath('batch-missing');
  await Bun.write(path, JSON.stringify({ greenhouse: { enabled: true, tokens: [] } }));
  const config = await loadSeekConfig(path);
  expect(config.batch).toEqual({ enabled: false, cap: 10, hostAllowlist: [] });
});

test('a negative or non-numeric batch cap falls back to 10 (fail-closed)', async () => {
  const pathNeg = fixturePath('batch-cap-negative');
  await Bun.write(pathNeg, JSON.stringify({ batch: { cap: -3 } }));
  const configNeg = await loadSeekConfig(pathNeg);
  expect(configNeg.batch.cap).toBe(10);

  const pathNaN = fixturePath('batch-cap-nan');
  await Bun.write(pathNaN, JSON.stringify({ batch: { cap: 'x' } }));
  const configNaN = await loadSeekConfig(pathNaN);
  expect(configNaN.batch.cap).toBe(10);
});

test('batch hostAllowlist filters to string-only entries', async () => {
  const path = fixturePath('batch-hostallowlist');
  await Bun.write(path, JSON.stringify({ batch: { hostAllowlist: ['a', 5, null, 'b'] } }));
  const config = await loadSeekConfig(path);
  expect(config.batch.hostAllowlist).toEqual(['a', 'b']);
});

test('a missing/malformed config file still returns the default batch section', async () => {
  const config = await loadSeekConfig('/nonexistent/path/seek.config.json');
  expect(config.batch).toEqual({ enabled: false, cap: 10, hostAllowlist: [] });
});
