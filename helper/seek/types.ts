// Phase 9 Discovery contracts. This file is the single source of truth for the
// posting shape (SEEK-04) and the source config shape (SEEK-05) — every fetch
// adapter, the HN parser, the Playwright sidecar, and the /seek route import
// these types directly instead of re-deriving the shape.

// `ycdir` (SEEK-09/D-17) is the public YC batch directory slug-harvest source —
// deliberately separate from the existing login-gated `yc` Work-at-a-Startup
// sidecar source below, so a stale sidecar login cannot break slug discovery.
// D-13: Consider.co is intentionally NOT added here — it was dropped from this
// phase, and an unreachable source value would be dead surface.
export type SourceName = 'greenhouse' | 'lever' | 'ashby' | 'hn' | 'yc' | 'jobright' | 'simplify' | 'getro' | 'ycdir';

export interface NormalizedPosting {
  company: string;
  title: string;
  location: string;
  // The original fillable http(s) URL — NOT the dedup key (see normalize.ts).
  url: string;
  source: SourceName;
  // Nullable: no fabricated dates (D-07). Paired with posted_at_trusted so
  // downstream freshness filtering only applies where the source is trustworthy.
  posted_at: string | null;
  posted_at_trusted: boolean;
  login_gated: boolean;
  // HN permalink fallback when no application link was found in the comment (D-09).
  not_fillable?: boolean;
  // Non-conforming HN comment that didn't match the expected first-line shape (D-08).
  low_confidence?: boolean;
}

// The Playwright sidecar -> POST /seek/results body.
export interface SeekResultsPayload {
  source: SourceName;
  postings: NormalizedPosting[];
}

// Source config contracts (D-02 committed JSON, D-03 plain shape).
export interface SourceConfig {
  enabled: boolean;
  tokens: string[];
}

// Daily cadence knobs (SCHED-01, D-04): operator-editable, fresh-read like every
// other seek.config.json section — fail-closed defaults if malformed.
export interface ScheduleConfig {
  enabled: boolean;
  targetHour: number;
}

// Batch-fill knobs (BATCH-03/04, D-14): operator-editable, fresh-read like every
// other seek.config.json section — fail-closed defaults if malformed. No
// targetHour — D-05 gates batch on sweep settlement, not a clock hour.
export interface BatchConfig {
  enabled: boolean;
  cap: number;
  hostAllowlist: string[];
}

export interface SeekConfig {
  greenhouse: SourceConfig;
  lever: SourceConfig;
  ashby: SourceConfig;
  hn: { enabled: boolean };
  yc: { enabled: boolean };
  jobright: { enabled: boolean };
  simplify: { enabled: boolean };
  // D-15: curated {name, id} pairs resolved once at execution time and
  // committed to seek.config.json, mirroring how the 286 ATS tokens already
  // work — never resolved at runtime, which would mean scraping a
  // Cloudflare-protected HTML page every sweep.
  getro: { enabled: boolean; networks: { name: string; id: string; host?: string }[] };
  ycdir: { enabled: boolean };
  // D-06: slugs the operator never wants polled again. Enforced at two independent
  // points — upsertBoard (insert time, never enters `boards`) and
  // resolveEffectiveTokens (load time, never reaches the effective token
  // list) — so a harvest cannot silently re-add a deliberately removed
  // company.
  blocklist: string[];
  schedule: ScheduleConfig;
  batch: BatchConfig;
}
