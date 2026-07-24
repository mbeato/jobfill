import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createBoardsTable, upsertBoard } from './boards';

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
