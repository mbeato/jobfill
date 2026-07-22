import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { SeekConfig, SourceConfig } from './types';

// Fresh-read source config reader (D-02/D-03/D-05 SEEK-05): seek.config.json is
// committed at the repo root and read FRESH on every call — no caching, no
// require() — so an edit takes effect on the next sweep with no restart. A
// missing or malformed file never throws; it falls back to an all-disabled
// default so a bad edit can't crash the sweep (T-09-01-03).

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const DEFAULT_PATH = join(REPO_ROOT, 'seek.config.json');

function toSourceConfig(x: unknown): SourceConfig {
  const obj = x as { enabled?: unknown; tokens?: unknown } | undefined;
  return {
    enabled: Boolean(obj?.enabled),
    tokens: Array.isArray(obj?.tokens) ? (obj!.tokens as unknown[]).filter((t): t is string => typeof t === 'string') : [],
  };
}

function toEnabledOnly(x: unknown): { enabled: boolean } {
  const obj = x as { enabled?: unknown } | undefined;
  return { enabled: Boolean(obj?.enabled) };
}

function defaultConfig(): SeekConfig {
  return {
    greenhouse: { enabled: false, tokens: [] },
    lever: { enabled: false, tokens: [] },
    ashby: { enabled: false, tokens: [] },
    hn: { enabled: false },
    yc: { enabled: false },
    jobright: { enabled: false },
  };
}

export async function loadSeekConfig(path?: string): Promise<SeekConfig> {
  try {
    const parsed = await Bun.file(path ?? DEFAULT_PATH).json();
    return {
      greenhouse: toSourceConfig(parsed?.greenhouse),
      lever: toSourceConfig(parsed?.lever),
      ashby: toSourceConfig(parsed?.ashby),
      hn: toEnabledOnly(parsed?.hn),
      yc: toEnabledOnly(parsed?.yc),
      jobright: toEnabledOnly(parsed?.jobright),
    };
  } catch {
    return defaultConfig();
  }
}
