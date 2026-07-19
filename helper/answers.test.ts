import { test, expect } from 'bun:test';
import { normalizeQuestion, tokenOverlap, matchLibrary, selectFewShot, groupByQuestion, type AnswerRow } from './answers';

test('normalizeQuestion strips punctuation, lowercases, collapses whitespace', () => {
  expect(normalizeQuestion('Why do you want to work here?')).toBe('why do you want to work here');
});

test('tokenOverlap: identical normalized strings === 1', () => {
  expect(tokenOverlap('a b c', 'a b c')).toBe(1);
});

test('tokenOverlap: fully disjoint token sets === 0', () => {
  expect(tokenOverlap('a b c', 'd e f')).toBe(0);
});

test('tokenOverlap: Jaccard of partial overlap', () => {
  // {a,b,c,d} vs {a,b,e,f} -> intersection 2, union 6 -> 1/3
  expect(tokenOverlap('a b c d', 'a b e f')).toBeCloseTo(1 / 3, 5);
});

function row(over: Partial<AnswerRow>): AnswerRow {
  return {
    id: 1,
    question: 'question',
    question_key: 'question key',
    answer: 'answer',
    pinned: 0,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

test('matchLibrary returns a reuse candidate at/above the 0.6 threshold', () => {
  const rows: AnswerRow[] = [
    row({ id: 1, question: 'Why do you want to work here?', question_key: normalizeQuestion('Why do you want to work here?'), answer: 'i like the mission' }),
  ];
  const result = matchLibrary(['why do you want to work here?'], rows);
  expect(result).toEqual([{ question: 'Why do you want to work here?', answer: 'i like the mission' }]);
});

test('matchLibrary does NOT match a below-0.6 near miss', () => {
  // question_key tokens: why,do,you,want,to,work,here (7)
  // page tokens:         why,do,you,want,to,join,us   (7)
  // intersection 5, union 9 -> 5/9 ≈ 0.556 < 0.6
  const rows: AnswerRow[] = [
    row({ id: 1, question_key: 'why do you want to work here', answer: 'banked answer' }),
  ];
  const result = matchLibrary(['why do you want to join us'], rows);
  expect(result).toEqual([]);
});

test('matchLibrary picks pinned over more-recent unpinned as the match', () => {
  const rows: AnswerRow[] = [
    row({ id: 1, question: 'unpinned newer', question_key: 'alpha bravo charlie', answer: 'newer', pinned: 0, created_at: '2026-01-05' }),
    row({ id: 2, question: 'pinned older', question_key: 'alpha bravo charlie', answer: 'older-pinned', pinned: 1, created_at: '2026-01-01' }),
  ];
  const result = matchLibrary(['alpha bravo charlie'], rows);
  expect(result).toEqual([{ question: 'pinned older', answer: 'older-pinned' }]);
});

test('groupByQuestion: pinned older row beats unpinned newer row as best', () => {
  const rows: AnswerRow[] = [
    row({ id: 10, question: 'newer unpinned', question_key: 'why do you want to work here', pinned: 0, created_at: '2026-01-10' }),
    row({ id: 11, question: 'older pinned', question_key: 'why do you want to work here', pinned: 1, created_at: '2026-01-01' }),
  ];
  const groups = groupByQuestion(rows);
  expect(groups.length).toBe(1);
  expect(groups[0].best.id).toBe(11);
  expect(groups[0].versions.map(v => v.id)).toEqual([10]);
});

test('groupByQuestion: fuzzy-distinct questions produce separate groups', () => {
  const rows: AnswerRow[] = [
    row({ id: 1, question_key: 'alpha bravo charlie' }),
    row({ id: 2, question_key: 'delta echo foxtrot' }),
  ];
  const groups = groupByQuestion(rows);
  expect(groups.length).toBe(2);
});

test('selectFewShot returns at most n, pinned first, one per fuzzy group', () => {
  const rows: AnswerRow[] = [
    row({ id: 1, question: 'Q1', question_key: 'alpha bravo charlie', pinned: 0, created_at: '2026-01-01' }),
    row({ id: 2, question: 'Q2', question_key: 'delta echo foxtrot', pinned: 1, created_at: '2026-01-02' }),
    row({ id: 3, question: 'Q3', question_key: 'golf hotel india', pinned: 0, created_at: '2026-01-03' }),
    row({ id: 4, question: 'Q4', question_key: 'juliet kilo lima', pinned: 0, created_at: '2026-01-04' }),
    row({ id: 5, question: 'Q5', question_key: 'mike november oscar', pinned: 1, created_at: '2026-01-05' }),
    row({ id: 6, question: 'Q6', question_key: 'papa quebec romeo', pinned: 0, created_at: '2026-01-06' }),
  ];
  const result = selectFewShot(rows, 5);
  expect(result.length).toBeLessThanOrEqual(5);
  expect(result[0]).toEqual({ question: 'Q5', answer: 'answer' });
  expect(result[1]).toEqual({ question: 'Q2', answer: 'answer' });
  const questions = result.map(r => r.question);
  expect(new Set(questions).size).toBe(questions.length);
});
