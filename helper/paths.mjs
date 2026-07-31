import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

// Portable path layer. Precedence per key: JOBFILL_<KEY> env var, then
// jobfill.config.json at the repo root, then a portable default derived from
// homedir() — never a literal path to one person's machine. Plain ESM (not
// TypeScript), same reason as helper/token.mjs: imported by both
// helper/server.ts (bun) and the scripts/*.mjs CLIs (node).

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');

export const CONFIG_FILE = join(REPO_ROOT, 'jobfill.config.json');

const PDFLATEX_CANDIDATES = ['/Library/TeX/texbin/pdflatex', '/usr/local/texlive/bin/pdflatex'];
const CLAUDE_BIN_CANDIDATES = [join(homedir(), '.local/bin/claude')];

// SCREAMING_SNAKE env var name for a camelCase key, e.g. baseTex -> BASE_TEX.
function envKey(key) {
  return `JOBFILL_${key.replace(/[A-Z]/g, (m) => `_${m}`).toUpperCase()}`;
}

// `~` and `~/...` expand against homedir(); anything else relative resolves
// against the repo root (not the cwd the process happened to be launched
// from), so a config value works the same whether jobfill is run from the
// repo root or from a launchd agent's default cwd.
function expandAndResolve(value) {
  if (typeof value !== 'string' || value === '') return value;
  let expanded = value;
  if (expanded === '~') expanded = homedir();
  else if (expanded.startsWith('~/')) expanded = join(homedir(), expanded.slice(2));
  return isAbsolute(expanded) ? expanded : resolve(REPO_ROOT, expanded);
}

// First existing candidate, or the bare binary name so a `pdflatex`/`claude`
// on PATH still resolves — /health's existsSync check reports the truth,
// this never throws when nothing is found.
function probeBinary(candidates, bareName) {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return bareName;
}

export function resolvePaths({ file = CONFIG_FILE } = {}) {
  const warnings = [];
  let fileConfig = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fileConfig = parsed;
      else warnings.push(`${file} did not contain a JSON object — ignored, using defaults.`);
    } catch (err) {
      warnings.push(`${file} is malformed JSON and was ignored: ${err.message}`);
    }
  }

  function pick(key, fallback) {
    const env = process.env[envKey(key)];
    if (typeof env === 'string' && env.trim() !== '') return expandAndResolve(env.trim());
    const fromFile = fileConfig[key];
    if (typeof fromFile === 'string' && fromFile.trim() !== '') return expandAndResolve(fromFile);
    return fallback;
  }

  const resumeDir = pick('resumeDir', join(homedir(), 'resume'));
  const baseTex = pick('baseTex', join(resumeDir, 'resume.tex'));
  const roundsDir = pick('roundsDir', join(resumeDir, 'rounds'));
  const memoryDir = pick('memoryDir', join(resumeDir, 'memory'));
  const bulletPool = pick('bulletPool', join(memoryDir, 'resume_bullet_pool.md'));
  const profileMd = pick('profileMd', join(memoryDir, 'user_profile.md'));
  const noInflateMd = pick('noInflateMd', join(memoryDir, 'feedback_no_inflated_metrics.md'));
  const dropConcMd = pick('dropConcMd', join(memoryDir, 'feedback_drop_concentrations.md'));
  const voiceProfile = pick('voiceProfile', join(memoryDir, 'voice_profile.md'));
  const userProfile = pick('userProfile', join(memoryDir, 'user_profile.md'));
  const interviewGaps = pick('interviewGaps', join(memoryDir, 'interview_gaps.md'));
  const noInflatedMetrics = pick('noInflatedMetrics', join(memoryDir, 'feedback_no_inflated_metrics.md'));
  const claudeBin = pick('claudeBin', probeBinary(CLAUDE_BIN_CANDIDATES, 'claude'));
  const pdflatex = pick('pdflatex', probeBinary(PDFLATEX_CANDIDATES, 'pdflatex'));

  return {
    resumeDir,
    baseTex,
    roundsDir,
    memoryDir,
    bulletPool,
    profileMd,
    noInflateMd,
    dropConcMd,
    voiceProfile,
    userProfile,
    interviewGaps,
    noInflatedMetrics,
    claudeBin,
    pdflatex,
    warnings,
  };
}
