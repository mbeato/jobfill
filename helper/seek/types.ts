// Phase 9 Discovery contracts. This file is the single source of truth for the
// posting shape (SEEK-04) and the source config shape (SEEK-05) — every fetch
// adapter, the HN parser, the Playwright sidecar, and the /seek route import
// these types directly instead of re-deriving the shape.

export type SourceName = 'greenhouse' | 'lever' | 'ashby' | 'hn' | 'yc' | 'jobright';

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

// Daily cadence knobs (SCHED-01, D-04): the operator-editable, fresh-read like every
// other seek.config.json section — fail-closed defaults if malformed.
export interface ScheduleConfig {
  enabled: boolean;
  targetHour: number;
}

export interface SeekConfig {
  greenhouse: SourceConfig;
  lever: SourceConfig;
  ashby: SourceConfig;
  hn: { enabled: boolean };
  yc: { enabled: boolean };
  jobright: { enabled: boolean };
  schedule: ScheduleConfig;
}
