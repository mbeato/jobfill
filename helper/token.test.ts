import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveToken } from './token.mjs';

const ORIGINAL_ENV = process.env.JOBFILL_TOKEN;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.JOBFILL_TOKEN;
  else process.env.JOBFILL_TOKEN = ORIGINAL_ENV;
});

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'jobfill-token-'));
  return join(dir, '.jobfill-token');
}

test('JOBFILL_TOKEN set in the environment is returned verbatim and the filesystem is untouched', () => {
  process.env.JOBFILL_TOKEN = 'env-token-value';
  const file = tmpFile();
  const result = resolveToken({ file });
  expect(result).toBe('env-token-value');
  expect(() => statSync(file)).toThrow();
});

test('no env var and no token file creates the file and returns a freshly generated token', () => {
  delete process.env.JOBFILL_TOKEN;
  const file = tmpFile();
  const result = resolveToken({ file });
  expect(result).toMatch(/^[0-9a-f]{32}$/);
  expect(readFileSync(file, 'utf8').trim()).toBe(result);
});

test('two successive generations in different empty directories differ', () => {
  delete process.env.JOBFILL_TOKEN;
  const a = resolveToken({ file: tmpFile() });
  const b = resolveToken({ file: tmpFile() });
  expect(a).toMatch(/^[0-9a-f]{32}$/);
  expect(b).toMatch(/^[0-9a-f]{32}$/);
  expect(a).not.toBe(b);
});

test('no env var and an existing token file returns the trimmed contents and does not rewrite the file', () => {
  delete process.env.JOBFILL_TOKEN;
  const file = tmpFile();
  writeFileSync(file, '  existing-token-value  \n');
  const before = statSync(file).mtimeMs;
  const result = resolveToken({ file });
  expect(result).toBe('existing-token-value');
  expect(statSync(file).mtimeMs).toBe(before);
});

test('the created token file has mode 0600', () => {
  delete process.env.JOBFILL_TOKEN;
  const file = tmpFile();
  resolveToken({ file });
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test('a token file containing only whitespace is treated as absent and regenerated', () => {
  delete process.env.JOBFILL_TOKEN;
  const file = tmpFile();
  writeFileSync(file, '   \n\t  ');
  const result = resolveToken({ file });
  expect(result).toMatch(/^[0-9a-f]{32}$/);
  expect(readFileSync(file, 'utf8').trim()).toBe(result);
});
