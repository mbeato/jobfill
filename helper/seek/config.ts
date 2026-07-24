import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { BatchConfig, ScheduleConfig, SeekConfig, SourceConfig } from './types';

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

// D-15: getro.networks is a curated {name, id, host?} list — a malformed
// entry (wrong type, missing name/id) is dropped rather than coerced into a
// half-valid network, mirroring toSourceConfig's string-only tokens filter.
function toGetroConfig(x: unknown): { enabled: boolean; networks: { name: string; id: string; host?: string }[] } {
  const obj = x as { enabled?: unknown; networks?: unknown } | undefined;
  const raw = Array.isArray(obj?.networks) ? (obj!.networks as unknown[]) : [];
  const networks = raw
    .map((entry) => {
      if (typeof entry !== 'object' || entry === null) return null;
      const e = entry as { name?: unknown; id?: unknown; host?: unknown };
      const name = String(e.name ?? '').trim();
      const id = String(e.id ?? '').trim();
      if (!name || !id) return null;
      const host = typeof e.host === 'string' && e.host.trim() ? e.host.trim() : undefined;
      return host ? { name, id, host } : { name, id };
    })
    .filter((n): n is { name: string; id: string; host?: string } => n !== null);
  return { enabled: Boolean(obj?.enabled), networks };
}

// D-06: blocklist is a flat array of slugs — anything not an array coerces
// to empty; non-string/empty entries are dropped, strings are trimmed.
function toStringArray(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  return x
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

const DEFAULT_TARGET_HOUR = 7;

// T-11-01-01: fail-closed numeric coercion (mirrors decide.ts's LLM_CAP) — a
// malformed targetHour (non-numeric or outside 0..23) must never wedge the
// scheduler; it silently falls back to the safe default instead.
function toScheduleConfig(x: unknown): ScheduleConfig {
  const obj = x as { enabled?: unknown; targetHour?: unknown } | undefined;
  const n = Number(obj?.targetHour);
  const targetHour = Number.isFinite(n) && n >= 0 && n <= 23 ? n : DEFAULT_TARGET_HOUR;
  return { enabled: Boolean(obj?.enabled), targetHour };
}

const DEFAULT_BATCH_CAP = 10;

// T-12-01-01: fail-closed numeric coercion (mirrors toScheduleConfig's
// targetHour guard) — a malformed cap must never wedge the batch run; it
// falls back to the safe default instead. hostAllowlist mirrors
// toSourceConfig's string-only array filter.
function toBatchConfig(x: unknown): BatchConfig {
  const obj = x as { enabled?: unknown; cap?: unknown; hostAllowlist?: unknown } | undefined;
  const n = Number(obj?.cap);
  const cap = Number.isFinite(n) && n >= 0 ? n : DEFAULT_BATCH_CAP;
  const hostAllowlist = Array.isArray(obj?.hostAllowlist)
    ? (obj!.hostAllowlist as unknown[]).filter((t): t is string => typeof t === 'string')
    : [];
  return { enabled: Boolean(obj?.enabled), cap, hostAllowlist };
}

function defaultConfig(): SeekConfig {
  return {
    greenhouse: { enabled: false, tokens: [] },
    lever: { enabled: false, tokens: [] },
    ashby: { enabled: false, tokens: [] },
    hn: { enabled: false },
    yc: { enabled: false },
    jobright: { enabled: false },
    simplify: { enabled: false },
    getro: { enabled: false, networks: [] },
    ycdir: { enabled: false },
    blocklist: [],
    schedule: { enabled: false, targetHour: DEFAULT_TARGET_HOUR },
    batch: { enabled: false, cap: DEFAULT_BATCH_CAP, hostAllowlist: [] },
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
      simplify: toEnabledOnly(parsed?.simplify),
      getro: toGetroConfig(parsed?.getro),
      ycdir: toEnabledOnly(parsed?.ycdir),
      blocklist: toStringArray(parsed?.blocklist),
      schedule: toScheduleConfig(parsed?.schedule),
      batch: toBatchConfig(parsed?.batch),
    };
  } catch {
    return defaultConfig();
  }
}
