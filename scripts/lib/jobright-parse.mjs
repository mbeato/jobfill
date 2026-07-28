// Pure line-stack parser for Jobright's /jobs/recommend cards.
//
// Extracted from seek-sidecar.mjs's page.evaluate so it can be tested: the
// browser side now returns only the raw text lines, and every field decision
// happens here.
//
// The card is a line stack — noise header, then title, company, industry, geo,
// employment type, salary, work mode, level. Field assignment is POSITIONAL
// (title = first surviving line, company = second), so a single unfiltered
// noise line shifts every field by one. That is not hypothetical: `/alumni/i`
// did not match the singular "1 school alumnus works here", so 14 of 77
// Jobright rows landed with the noise line as `title` and the real role as
// `company`. Two of those were then permanently rejected as llm:not-relevant
// for having a nonsense title (Phase 9 D-14 — a rejection never revives), one
// was submitted with a corrupted CRM record, and because the title-based
// seniority and non-engineering rules read that same field, they were bypassed
// entirely for those rows.
//
// So: match noise generously, and refuse to emit a card whose title still
// looks like noise. Dropping a card costs one posting; mis-assigning its
// fields costs a permanent wrong decision.

export const NOISE = [
  /\bago$/i,
  // The badge, not the word. The original /alumni/i missed the singular form
  // Jobright renders ("1 school alumnus works here"), but a bare /\balumn/
  // over-corrects: "Senior Alumni Relations Manager" is a real title in the
  // live db. Both patterns below key on badge STRUCTURE — a leading count, or
  // the trailing "works here" — so neither can swallow a job title.
  /^\d+\b.*\balumn/i,
  /\bwork(s)? here$/i,
  /early applicant/i,
  /^good match$/i,
  /^\d+%$/,
  /^\/$/,
  /^why this job/i,
  /^no h1b$/i,
  /^growth opportunities$/i,
  // Filter chips render above the title exactly like the alumnus badge:
  // "Python Required", "Go Required" both reached the db as a company. Matched
  // as ONE token plus the word, never a bare /required$/ — swept against the
  // 46,752-title corpus, that looser form drops 7 real jobs including "Junior
  // Software Developer - Active TS/SCI with Poly Required", a target role.
  /^[\w+#./-]{1,15}\s+required$/i,
];

export function isNoise(line) {
  return NOISE.some(re => re.test(line));
}

/**
 * @param {{url: string, allLines: string[]}} card
 * @returns {{url, title, company, location, agoLine} | null} null when the card
 *   cannot be parsed into a plausible title — see the header note on why
 *   dropping beats guessing.
 */
export function parseJobrightCard(card) {
  const url = card?.url;
  const allLines = (card?.allLines ?? []).map(s => String(s ?? '').trim()).filter(Boolean);
  if (!url || !allLines.length) return null;

  const agoLine = allLines.find(l => /\bago$/i.test(l)) || '';
  const lines = allLines.filter(l => !isNoise(l));

  const title = lines[0] || '';
  // The guard the original lacked: if a known noise line still leads the stack,
  // every field below it is shifted and the row is worse than absent.
  //
  // Deliberately no length heuristic here. It looks tempting — the observed bad
  // lines are all sentence-shaped — but the live db has titles up to 140 chars
  // and 412 postings over 80, so any bound that catches UI copy also drops real
  // jobs. An unrecognised noise line is caught by adding a pattern above, not by
  // guessing at shape.
  if (!title || isNoise(title)) return null;

  return {
    url,
    title,
    company: lines[1] || '',
    location:
      lines.find(l => /,\s*[A-Z]{2}\b/.test(l)) ||
      lines.find(l => /\b(remote|united states)\b/i.test(l)) ||
      '',
    agoLine,
  };
}
