import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createBoardsTable,
  upsertBoard,
  recordBoardResult,
  listActiveBoards,
  resolveEffectiveTokens,
  DEAD_AFTER,
  DEAD_RECHECK_DAYS,
} from './boards';

function makeDb(): Database {
  const db = new Database(':memory:');
  createBoardsTable(db);
  return db;
}

test('upsertBoard inserts a row with the requested ats/token/source', () => {
  const db = makeDb();
  const row = upsertBoard(db, { ats: 'greenhouse', token: 'acme', source_of_discovery: 'simplify' });
  expect(row?.ats).toBe('greenhouse');
  expect(row?.token).toBe('acme');
  expect(row?.source_of_discovery).toBe('simplify');
});

test('a second upsert of the same (ats, token) leaves exactly one row and bumps updated_at', () => {
  const db = makeDb();
  const first = upsertBoard(db, { ats: 'greenhouse', token: 'acme', source_of_discovery: 'simplify' });
  db.query(`UPDATE boards SET updated_at = '2020-01-01 00:00:00' WHERE id = ?`).run(first!.id);
  const second = upsertBoard(db, { ats: 'greenhouse', token: 'acme', source_of_discovery: 'getro' });
  const rows = db.query('SELECT * FROM boards').all();
  expect(rows.length).toBe(1);
  expect(second!.updated_at).not.toBe('2020-01-01 00:00:00');
});

test('first_seen_at survives re-discovery even with a different source_of_discovery', () => {
  const db = makeDb();
  const first = upsertBoard(db, { ats: 'greenhouse', token: 'acme', source_of_discovery: 'simplify' });
  // Backdate first_seen_at via a direct UPDATE first, so a silent overwrite cannot pass.
  db.query(`UPDATE boards SET first_seen_at = '2020-01-01 00:00:00' WHERE id = ?`).run(first!.id);
  const second = upsertBoard(db, { ats: 'greenhouse', token: 'acme', source_of_discovery: 'getro' });
  expect(second!.first_seen_at).toBe('2020-01-01 00:00:00');
  expect(second!.source_of_discovery).toBe('simplify');
});

test('upsertBoard rejects out-of-enum ats/source (enum guard)', () => {
  const db = makeDb();
  expect(upsertBoard(db, { ats: 'workday', token: 'acme', source_of_discovery: 'simplify' })).toBeNull();
  expect(upsertBoard(db, { ats: 'greenhouse', token: 'acme', source_of_discovery: 'attacker' })).toBeNull();
  const rows = db.query('SELECT * FROM boards').all();
  expect(rows.length).toBe(0);
});

test('upsertBoard rejects malformed tokens', () => {
  const db = makeDb();
  expect(upsertBoard(db, { ats: 'greenhouse', token: 'foo/bar', source_of_discovery: 'simplify' })).toBeNull();
  expect(upsertBoard(db, { ats: 'greenhouse', token: '../etc', source_of_discovery: 'simplify' })).toBeNull();
  expect(upsertBoard(db, { ats: 'greenhouse', token: '', source_of_discovery: 'simplify' })).toBeNull();
  expect(upsertBoard(db, { ats: 'greenhouse', token: 'x'.repeat(200), source_of_discovery: 'simplify' })).toBeNull();
  const rows = db.query('SELECT * FROM boards').all();
  expect(rows.length).toBe(0);
});

test('upsertBoard refuses a blocklisted token, exact and differing case', () => {
  const db = makeDb();
  expect(upsertBoard(db, { ats: 'greenhouse', token: 'acme', source_of_discovery: 'simplify' }, ['acme'])).toBeNull();
  expect(upsertBoard(db, { ats: 'greenhouse', token: 'ACME', source_of_discovery: 'simplify' }, ['acme'])).toBeNull();
  const rows = db.query('SELECT * FROM boards').all();
  expect(rows.length).toBe(0);
});

test('four failures leave dead_since NULL and the board in listActiveBoards', () => {
  const db = makeDb();
  upsertBoard(db, { ats: 'greenhouse', token: 'dead', source_of_discovery: 'simplify' });
  for (let i = 0; i < DEAD_AFTER - 1; i++) recordBoardResult(db, 'greenhouse', 'dead', false);
  const tokens = listActiveBoards(db, 'greenhouse').map(r => r.token);
  expect(tokens).toContain('dead');
});

test('the fifth failure sets dead_since and drops the board out of listActiveBoards', () => {
  const db = makeDb();
  upsertBoard(db, { ats: 'greenhouse', token: 'dead', source_of_discovery: 'simplify' });
  for (let i = 0; i < DEAD_AFTER; i++) recordBoardResult(db, 'greenhouse', 'dead', false);
  const tokens = listActiveBoards(db, 'greenhouse').map(r => r.token);
  expect(tokens).not.toContain('dead');
});

test('a subsequent success clears dead_since, zeroes consecutive_failures and sets last_ok_at', () => {
  const db = makeDb();
  upsertBoard(db, { ats: 'greenhouse', token: 'dead', source_of_discovery: 'simplify' });
  for (let i = 0; i < DEAD_AFTER; i++) recordBoardResult(db, 'greenhouse', 'dead', false);
  recordBoardResult(db, 'greenhouse', 'dead', true);
  const row = db.query('SELECT * FROM boards WHERE ats = ? AND token = ?').get('greenhouse', 'dead') as any;
  expect(row.dead_since).toBeNull();
  expect(row.consecutive_failures).toBe(0);
  expect(row.last_ok_at).not.toBeNull();
});

test('a dead board reappears in listActiveBoards once dead_since is old enough (re-check), and a further failure pushes it forward again', () => {
  const db = makeDb();
  upsertBoard(db, { ats: 'greenhouse', token: 'dead', source_of_discovery: 'simplify' });
  for (let i = 0; i < DEAD_AFTER; i++) recordBoardResult(db, 'greenhouse', 'dead', false);
  db.query(
    `UPDATE boards SET dead_since = datetime('now', '-${DEAD_RECHECK_DAYS + 1} days') WHERE ats = ? AND token = ?`,
  ).run('greenhouse', 'dead');
  expect(listActiveBoards(db, 'greenhouse').map(r => r.token)).toContain('dead');
  recordBoardResult(db, 'greenhouse', 'dead', false);
  expect(listActiveBoards(db, 'greenhouse').map(r => r.token)).not.toContain('dead');
});

test('recordBoardResult on an unknown (ats, token) does not throw and inserts nothing', () => {
  const db = makeDb();
  expect(() => recordBoardResult(db, 'greenhouse', 'never-inserted', false)).not.toThrow();
  const rows = db.query('SELECT * FROM boards').all();
  expect(rows.length).toBe(0);
});

test('resolveEffectiveTokens is config tokens union active boards rows, minus blocklist', () => {
  const db = makeDb();
  upsertBoard(db, { ats: 'greenhouse', token: 'beta', source_of_discovery: 'simplify' });
  upsertBoard(db, { ats: 'greenhouse', token: 'gamma', source_of_discovery: 'getro' });
  expect(resolveEffectiveTokens(db, 'greenhouse', ['acme', 'beta'], [])).toEqual(['acme', 'beta', 'gamma']);
});

test('resolveEffectiveTokens excludes a dead board token and enforces the blocklist at both insert and resolution time', () => {
  const db = makeDb();
  // dead board's token is absent from the resolved list
  upsertBoard(db, { ats: 'greenhouse', token: 'deadboard', source_of_discovery: 'simplify' });
  for (let i = 0; i < DEAD_AFTER; i++) recordBoardResult(db, 'greenhouse', 'deadboard', false);
  expect(resolveEffectiveTokens(db, 'greenhouse', [], [])).not.toContain('deadboard');

  // a blocklisted token is absent even from the config seed AND when it exists as a
  // boards row (D-06 bites at both insert time and resolution time)
  const blocklist = ['acme'];
  expect(upsertBoard(db, { ats: 'greenhouse', token: 'acme', source_of_discovery: 'simplify' }, blocklist)).toBeNull();
  expect(resolveEffectiveTokens(db, 'greenhouse', ['acme'], blocklist)).toEqual([]);
});
