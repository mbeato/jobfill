// The observed-value vocabulary behind the criteria editor's term inputs.
//
// The four criteria term lists are the user's own vocabulary, not a closed
// enum, so this exists to SUGGEST rather than to constrain — every input built
// on it must still accept free text. What it answers is the question a raw
// textarea could not: "what titles and locations does this database actually
// contain?" Without it there is nothing to populate a combobox from.
//
// Read-only, and deliberately tolerant: a vocabulary is a convenience, so every
// failure path here degrades to an empty list (the input falls back to plain
// free-text entry) rather than breaking the criteria editor, which is
// safety-critical. Same fail-open direction as D-06.

import type { Database } from 'bun:sqlite';
import { MAX_TERM_LENGTH } from './criteria';

// `field` reaches a column position in the SQL below, so it is resolved through
// this fixed map and never interpolated from caller input — the same
// allowlist-before-use posture as upsertBoard's BOARDS_ATS/BOARDS_SOURCES
// checks. Bun's parameter binding cannot parameterize an identifier, which is
// exactly why the map is the guard.
const FIELD_COLUMNS: Record<string, string> = {
  title: 'title',
  location: 'location',
};

export const VOCABULARY_FIELDS = new Set(Object.keys(FIELD_COLUMNS));

// A ceiling on response size, not on the user. 46,071 live postings carry
// 33,208 distinct titles and 5,876 distinct locations, so the whole set is far
// too large to ship to the browser; the top 500 by frequency covers the values
// a term list would plausibly want while keeping the payload small enough to
// filter client-side with no second request per keystroke.
export const VOCABULARY_LIMIT = 500;

export interface VocabularyEntry {
  value: string;
  count: number;
}

export function readVocabulary(db: Database, field: string, limit: number = VOCABULARY_LIMIT): VocabularyEntry[] {
  const column = FIELD_COLUMNS[field];
  if (!column) return [];
  const capped = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), VOCABULARY_LIMIT) : VOCABULARY_LIMIT;
  try {
    const rows = db
      .query(
        // Grouped case-insensitively because compileTerms compiles every rule
        // with the `i` flag — "New York, NY" and "new york, ny" are the same
        // term to the filter, so offering both as separate suggestions would be
        // noise. min() picks one deterministic surface spelling; which case
        // wins is cosmetic for the same reason.
        //
        // The length bound keeps validateCriteria's MAX_TERM_LENGTH rejection
        // unreachable from a suggestion: an offered value that cannot be saved
        // is a dead end.
        `SELECT min(trim(${column})) AS value, count(*) AS count
           FROM postings
          WHERE ${column} IS NOT NULL
            AND trim(${column}) <> ''
            AND length(trim(${column})) <= ?
          GROUP BY lower(trim(${column}))
          ORDER BY count DESC, value ASC
          LIMIT ?`,
      )
      .all(MAX_TERM_LENGTH, capped) as { value: string; count: number }[];
    return rows.map(r => ({ value: r.value, count: Number(r.count) }));
  } catch {
    // No postings table yet (a fresh install before the first sweep), or any
    // other read failure — suggestions are optional, the editor is not.
    return [];
  }
}
