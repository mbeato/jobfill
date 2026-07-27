import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readVocabulary, VOCABULARY_FIELDS, VOCABULARY_LIMIT } from './vocabulary';
import { MAX_TERM_LENGTH } from './criteria';

function makeDb(rows: { title?: string | null; location?: string | null }[]): Database {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE postings (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, location TEXT)`);
  for (const r of rows) {
    db.query('INSERT INTO postings (title, location) VALUES (?, ?)').run(r.title ?? null, r.location ?? null);
  }
  return db;
}

test('returns distinct values ordered by frequency, most common first', () => {
  const db = makeDb([
    { title: 'Software Engineer' },
    { title: 'Software Engineer' },
    { title: 'Software Engineer' },
    { title: 'Product Manager' },
    { title: 'Product Manager' },
    { title: 'Recruiter' },
  ]);
  expect(readVocabulary(db, 'title')).toEqual([
    { value: 'Software Engineer', count: 3 },
    { value: 'Product Manager', count: 2 },
    { value: 'Recruiter', count: 1 },
  ]);
});

test('folds case and surrounding whitespace into one entry', () => {
  const db = makeDb([
    { location: 'New York, NY' },
    { location: 'new york, ny' },
    { location: '  New York, NY  ' },
  ]);
  const vocab = readVocabulary(db, 'location');
  expect(vocab.length).toBe(1);
  expect(vocab[0].count).toBe(3);
  expect(vocab[0].value.toLowerCase()).toBe('new york, ny');
});

test('skips null, empty and whitespace-only values', () => {
  const db = makeDb([{ location: null }, { location: '' }, { location: '   ' }, { location: 'Remote' }]);
  expect(readVocabulary(db, 'location')).toEqual([{ value: 'Remote', count: 1 }]);
});

// A suggestion the user cannot actually save is a dead end — validateCriteria
// rejects any term over MAX_TERM_LENGTH, so such a value is never offered.
test('omits values longer than MAX_TERM_LENGTH, because they could never be saved as a term', () => {
  const long = 'x'.repeat(MAX_TERM_LENGTH + 1);
  const db = makeDb([{ title: long }, { title: long }, { title: 'Software Engineer' }]);
  expect(readVocabulary(db, 'title')).toEqual([{ value: 'Software Engineer', count: 1 }]);
});

test('a value exactly at MAX_TERM_LENGTH is still offered', () => {
  const exact = 'x'.repeat(MAX_TERM_LENGTH);
  const db = makeDb([{ title: exact }]);
  expect(readVocabulary(db, 'title')).toEqual([{ value: exact, count: 1 }]);
});

test('caps the result at VOCABULARY_LIMIT', () => {
  const db = makeDb(Array.from({ length: VOCABULARY_LIMIT + 25 }, (_, i) => ({ title: `Role ${i}` })));
  expect(readVocabulary(db, 'title').length).toBe(VOCABULARY_LIMIT);
});

// The field name reaches a column position in the SQL, so it is resolved
// through a fixed map rather than interpolated — the same allowlist-before-use
// posture as upsertBoard's BOARDS_ATS check.
test('an unknown field returns an empty list and never interpolates into the SQL', () => {
  const db = makeDb([{ title: 'Software Engineer' }]);
  expect(readVocabulary(db, 'title UNION SELECT 1,2')).toEqual([]);
  expect(readVocabulary(db, 'url')).toEqual([]);
  expect(readVocabulary(db, '')).toEqual([]);
});

test('VOCABULARY_FIELDS is exactly the two fields the criteria rules match on', () => {
  expect([...VOCABULARY_FIELDS].sort()).toEqual(['location', 'title']);
});

test('an explicit limit is honoured and clamped to VOCABULARY_LIMIT', () => {
  const db = makeDb(Array.from({ length: 40 }, (_, i) => ({ title: `Role ${i}` })));
  expect(readVocabulary(db, 'title', 10).length).toBe(10);
  expect(readVocabulary(db, 'title', 9999).length).toBe(40);
  expect(readVocabulary(db, 'title', 0).length).toBe(VOCABULARY_LIMIT > 40 ? 40 : VOCABULARY_LIMIT);
  expect(readVocabulary(db, 'title', -5).length).toBe(VOCABULARY_LIMIT > 40 ? 40 : VOCABULARY_LIMIT);
});

test('a missing postings table degrades to an empty list rather than throwing', () => {
  const db = new Database(':memory:');
  expect(() => readVocabulary(db, 'title')).not.toThrow();
  expect(readVocabulary(db, 'title')).toEqual([]);
});
