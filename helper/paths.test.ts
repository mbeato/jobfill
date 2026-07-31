import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { resolvePaths } from './paths.mjs';

const ENV_KEYS = [
  'JOBFILL_RESUME_DIR',
  'JOBFILL_BASE_TEX',
  'JOBFILL_ROUNDS_DIR',
  'JOBFILL_MEMORY_DIR',
  'JOBFILL_BULLET_POOL',
  'JOBFILL_PROFILE_MD',
  'JOBFILL_NO_INFLATE_MD',
  'JOBFILL_DROP_CONC_MD',
  'JOBFILL_VOICE_PROFILE',
  'JOBFILL_USER_PROFILE',
  'JOBFILL_INTERVIEW_GAPS',
  'JOBFILL_NO_INFLATED_METRICS',
  'JOBFILL_CLAUDE_BIN',
  'JOBFILL_PDFLATEX',
];

const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) ORIGINAL_ENV[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
});

function missingConfigFile() {
  const dir = mkdtempSync(join(tmpdir(), 'jobfill-paths-'));
  return join(dir, 'jobfill.config.json');
}

test('with no config file and no env vars, resumeDir and baseTex default under the home directory', () => {
  const paths = resolvePaths({ file: missingConfigFile() });
  expect(paths.resumeDir).toBe(join(homedir(), 'resume'));
  expect(paths.baseTex).toBe(join(paths.resumeDir, 'resume.tex'));
});

test('with no config file and no env vars, memoryDir lives inside resumeDir, never a .claude/projects path', () => {
  const paths = resolvePaths({ file: missingConfigFile() });
  expect(paths.memoryDir).toBe(join(paths.resumeDir, 'memory'));
  expect(paths.memoryDir).not.toMatch(/\.claude[\\/]projects/);
});

test('a jobfill.config.json at the given path overrides a default it specifies and leaves the rest at defaults', () => {
  const file = missingConfigFile();
  writeFileSync(file, JSON.stringify({ resumeDir: '/tmp/custom-resume' }));
  const paths = resolvePaths({ file });
  expect(paths.resumeDir).toBe('/tmp/custom-resume');
  expect(paths.claudeBin).not.toBe('');
});

test('JOBFILL_RESUME_DIR in the environment overrides the config file, which overrides the default', () => {
  const file = missingConfigFile();
  writeFileSync(file, JSON.stringify({ resumeDir: '/tmp/from-config' }));
  process.env.JOBFILL_RESUME_DIR = '/tmp/from-env';
  const paths = resolvePaths({ file });
  expect(paths.resumeDir).toBe('/tmp/from-env');
});

test('a relative path in the config file resolves against the repo root, not the cwd', () => {
  const file = missingConfigFile();
  writeFileSync(file, JSON.stringify({ resumeDir: 'some/relative/dir' }));
  const originalCwd = process.cwd();
  const tmpCwd = mkdtempSync(join(tmpdir(), 'jobfill-paths-cwd-'));
  process.chdir(tmpCwd);
  let paths;
  try {
    paths = resolvePaths({ file });
  } finally {
    process.chdir(originalCwd);
  }
  expect(paths.resumeDir.endsWith(join('some', 'relative', 'dir'))).toBe(true);
  expect(paths.resumeDir).not.toBe(join(tmpCwd, 'some/relative/dir'));
});

test('pdflatex and claudeBin fall back to a bare binary name when no candidate path exists', () => {
  const paths = resolvePaths({ file: missingConfigFile() });
  expect(typeof paths.pdflatex).toBe('string');
  expect(paths.pdflatex.length).toBeGreaterThan(0);
  expect(typeof paths.claudeBin).toBe('string');
  expect(paths.claudeBin.length).toBeGreaterThan(0);
});

test('a malformed jobfill.config.json does not throw and returns defaults with a non-empty warnings array', () => {
  const file = missingConfigFile();
  writeFileSync(file, '{"resumeDir": "not/valid/json"');
  let paths;
  expect(() => {
    paths = resolvePaths({ file });
  }).not.toThrow();
  expect(paths.resumeDir).toBe(join(homedir(), 'resume'));
  expect(Array.isArray(paths.warnings)).toBe(true);
  expect(paths.warnings.length).toBeGreaterThan(0);
});

test('every documented key is present on the returned object', () => {
  const paths = resolvePaths({ file: missingConfigFile() });
  const keys = [
    'resumeDir', 'baseTex', 'roundsDir', 'memoryDir', 'bulletPool', 'profileMd',
    'noInflateMd', 'dropConcMd', 'voiceProfile', 'userProfile', 'interviewGaps',
    'noInflatedMetrics', 'claudeBin', 'pdflatex',
  ];
  for (const key of keys) expect(key in paths).toBe(true);
});

test('a ~/ prefixed config value expands against the home directory', () => {
  const file = missingConfigFile();
  writeFileSync(file, JSON.stringify({ resumeDir: '~/some-resume-dir' }));
  const paths = resolvePaths({ file });
  expect(paths.resumeDir).toBe(join(homedir(), 'some-resume-dir'));
});
