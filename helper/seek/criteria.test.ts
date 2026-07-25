import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSeekMetaTable } from './meta';
import {
  compileTerms,
  compileCriteria,
  defaultCriteria,
  readCriteria,
  saveCriteria,
  readRelevanceProfile,
  saveRelevanceProfile,
  toCriteria,
  validateCriteria,
  MAX_PROFILE_CHARS,
} from './criteria';

function makeDb(): Database {
  const db = new Database(':memory:');
  createSeekMetaTable(db);
  return db;
}

// --- D-06 fail open: the load-bearing group. Behavioral, not source greps. ---

test('compileTerms returns null (rule is off) for an empty term list', () => {
  expect(compileTerms([], 'word')).toBeNull();
});

test('compileTerms returns null (rule is off) for a list of only blank/whitespace terms', () => {
  expect(compileTerms(['  ', ''], 'word')).toBeNull();
});

test('compileCriteria: an empty locationTerms list yields locationRe null while other rules stay compiled', () => {
  const c = { ...defaultCriteria(), locationTerms: [] };
  const compiled = compileCriteria(c);
  expect(compiled.locationRe).toBeNull();
  expect(compiled.seniorityRe).not.toBeNull();
  expect(compiled.nonEngineeringRe).not.toBeNull();
  expect(compiled.workModeOnlyRe).not.toBeNull();
});

test('readCriteria: an empty stored locationTerms list survives the read boundary, not replaced by the default list', () => {
  const db = makeDb();
  db.query("INSERT INTO seek_meta(key, value) VALUES ('criteria', ?)").run(JSON.stringify({ locationTerms: [] }));
  const criteria = readCriteria(db);
  expect(criteria.locationTerms).toEqual([]);
});

// --- CFG-04 hostile input ---

test('a 100,000-character term is dropped before it ever reaches compileTerms', () => {
  const hostile = 'x'.repeat(100_000);
  const criteria = toCriteria({ seniorityTerms: [hostile] });
  expect(criteria.seniorityTerms).toEqual([]);
  expect(compileTerms(criteria.seniorityTerms, 'word')).toBeNull();
});

test('a 200-entry term list is clamped to 50 on read and rejected at the write boundary', () => {
  const overlong = Array.from({ length: 200 }, (_, i) => `term${i}`);
  const criteria = toCriteria({ seniorityTerms: overlong });
  expect(criteria.seniorityTerms.length).toBe(50);

  const result = validateCriteria({ ...defaultCriteria(), seniorityTerms: overlong });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBe('too many terms — max 50');
});

test('catastrophic-backtracking-shaped terms compile without throwing and match only their literal text', () => {
  const hostileTerms = ['(a+)+$', '(x|x)*y', '[', '\\', '.*'];
  const re = compileTerms(hostileTerms, 'word');
  expect(re).not.toBeNull();
  expect(re!.test('(a+)+$')).toBe(true);
  expect(re!.test('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!')).toBe(false);
  expect(re!.test('some unrelated sentence')).toBe(false);
});

test('a 10,000-character relevance profile is truncated to MAX_PROFILE_CHARS on save', () => {
  const db = makeDb();
  saveRelevanceProfile(db, 'x'.repeat(10_000));
  const stored = readRelevanceProfile(db);
  expect(stored).not.toBeNull();
  expect(stored!.length).toBe(MAX_PROFILE_CHARS);
  expect(stored!.length).toBe(4000);
});

// --- Coercion and round-trip ---

test('readCriteria on an empty DB (no row) returns defaultCriteria()', () => {
  const db = makeDb();
  expect(readCriteria(db)).toEqual(defaultCriteria());
});

test('readCriteria on a row holding invalid JSON returns defaultCriteria() and does not throw', () => {
  const db = makeDb();
  db.query("INSERT INTO seek_meta(key, value) VALUES ('criteria', 'not valid json{{{')").run();
  expect(() => readCriteria(db)).not.toThrow();
  expect(readCriteria(db)).toEqual(defaultCriteria());
});

test('saveCriteria then readCriteria round-trips every field, including yoeThreshold null and staffLeadBuiltins false', () => {
  const db = makeDb();
  const criteria = {
    ...defaultCriteria(),
    locationTerms: ['new york', 'remote'],
    staffLeadBuiltins: false,
    yoeThreshold: null,
    maxStaleDays: 3,
  };
  saveCriteria(db, criteria);
  expect(readCriteria(db)).toEqual(criteria);
});

test('saveCriteria then readCriteria round-trips a non-null yoeThreshold', () => {
  const db = makeDb();
  const criteria = { ...defaultCriteria(), yoeThreshold: 5 };
  saveCriteria(db, criteria);
  expect(readCriteria(db).yoeThreshold).toBe(5);
});

test('readRelevanceProfile on an empty DB returns null', () => {
  const db = makeDb();
  expect(readRelevanceProfile(db)).toBeNull();
});

test('compileTerms whole mode matches only the full string, not a substring', () => {
  const re = compileTerms(['hybrid'], 'whole');
  expect(re!.test('hybrid')).toBe(true);
  expect(re!.test('hybrid, nyc')).toBe(false);
});
