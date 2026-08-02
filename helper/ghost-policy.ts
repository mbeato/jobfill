// Per-lane ghost thresholds.
//
// A single global threshold has to be wrong somewhere: job boards differ enormously
// in how fast they answer, and the same number that correctly calls a seed-stage
// application dead will libel a large-company ATS application that was always going
// to take a month.
//
// Measured on this operator's own pipeline (2026-08-02, 103 submitted applications):
// every response from workatastartup arrived inside 10 days, and all four were
// interviews. The generic ATS lane had produced one response — a rejection — in the
// same window, which is normal: those pipelines routinely run three to six weeks.
//
// So the thresholds encode "how long is silence still uninformative here", not a
// uniform patience budget. Deliberately named constants rather than seek.config.json
// keys, keeping D-16's reasoning: this is a judgement about the job market baked into
// the tool, not a per-install preference, and a wrong value should be fixed for
// everyone rather than tuned per machine.

export const GHOST_DAYS_DEFAULT = 21;

export const GHOST_DAYS_BY_LANE: Readonly<Record<string, number>> = Object.freeze({
  // Founder-read inbox, small applicant pool, no résumé screen. Replies are fast or
  // never. Silence at ~12 days is real information.
  workatastartup: 12,

  // Large-company ATS pipelines. Recruiter screens, batch reviews and scheduled
  // rejection sweeps mean four weeks of silence is routine and says little.
  ashby: 28,
  greenhouse: 28,
  lever: 28,

  // Aggregators. The click-through lands on the employer's own ATS, so these behave
  // like the generic lane rather than like the aggregator.
  jobright: 28,
  simplify: 28,
});

/**
 * Classify an application URL into a lane. Host-based: the hosts below are
 * unambiguous, unlike free-text company or role fields.
 *
 * Returns 'other' for anything unrecognised, which maps to GHOST_DAYS_DEFAULT —
 * a new board therefore behaves exactly as it did before this existed.
 */
export function laneForUrl(url: string | null | undefined): string {
  const u = String(url ?? '').toLowerCase();
  if (!u) return 'other';
  if (u.includes('workatastartup.com')) return 'workatastartup';
  if (u.includes('ashbyhq.com')) return 'ashby';
  if (u.includes('greenhouse.io')) return 'greenhouse';
  if (u.includes('lever.co')) return 'lever';
  if (u.includes('jobright.ai')) return 'jobright';
  if (u.includes('simplify.jobs')) return 'simplify';
  return 'other';
}

/** Days of silence after which an `applied` row on this URL's board is ghosted. */
export function ghostDaysFor(url: string | null | undefined): number {
  return GHOST_DAYS_BY_LANE[laneForUrl(url)] ?? GHOST_DAYS_DEFAULT;
}
