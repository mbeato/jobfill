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
    }),
  );
  const config = await loadSeekConfig(path);
  expect(config.greenhouse).toEqual({ enabled: true, tokens: ['acme', 'beta'] });
  expect(config.ashby).toEqual({ enabled: true, tokens: ['gamma'] });
  expect(config.hn).toEqual({ enabled: true });
  expect(config.jobright).toEqual({ enabled: true });
});

test('a missing path returns the all-disabled default without throwing', async () => {
  const config = await loadSeekConfig('/nonexistent/path/seek.config.json');
  expect(config.greenhouse).toEqual({ enabled: false, tokens: [] });
  expect(config.lever).toEqual({ enabled: false, tokens: [] });
  expect(config.ashby).toEqual({ enabled: false, tokens: [] });
  expect(config.hn).toEqual({ enabled: false });
  expect(config.yc).toEqual({ enabled: false });
  expect(config.jobright).toEqual({ enabled: false });
});

test('malformed/garbage-typed config is coerced to safe values, not propagated raw', async () => {
  const path = fixturePath('malformed');
  await Bun.write(
    path,
    JSON.stringify({
      greenhouse: { enabled: 'yes', tokens: 'not-an-array' },
      lever: { enabled: true, tokens: [1, 2, 'valid-token'] },
    }),
  );
  const config = await loadSeekConfig(path);
  expect(config.greenhouse).toEqual({ enabled: true, tokens: [] });
  expect(config.lever).toEqual({ enabled: true, tokens: ['valid-token'] });
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
