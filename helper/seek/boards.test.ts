import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createBoardsTable,
  upsertBoard,
  recordBoardResult,
  listActiveBoards,
  listAllBoards,
  resolveEffectiveTokens,
  backfillSeedBoards,
  SEED_BACKFILL_FIRST_SEEN,
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

test('listAllBoards on an empty table returns []', () => {
  const db = makeDb();
  expect(listAllBoards(db)).toEqual([]);
});

test('listAllBoards returns all rows ordered by token, across every ats value', () => {
  const db = makeDb();
  upsertBoard(db, { ats: 'ashby', token: 'zeta', source_of_discovery: 'simplify' });
  upsertBoard(db, { ats: 'greenhouse', token: 'alpha', source_of_discovery: 'simplify' });
  upsertBoard(db, { ats: 'lever', token: 'mid', source_of_discovery: 'getro' });
  const tokens = listAllBoards(db).map(r => r.token);
  expect(tokens).toEqual(['alpha', 'mid', 'zeta']);
});

test('listAllBoards includes a dead-marked board that listActiveBoards excludes', () => {
  const db = makeDb();
  upsertBoard(db, { ats: 'greenhouse', token: 'dead', source_of_discovery: 'simplify' });
  for (let i = 0; i < DEAD_AFTER; i++) recordBoardResult(db, 'greenhouse', 'dead', false);
  expect(listAllBoards(db).map(r => r.token)).toContain('dead');
  expect(listActiveBoards(db, 'greenhouse').map(r => r.token)).not.toContain('dead');
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

test('backfillSeedBoards inserts fresh seed tokens at the SENTINEL, never datetime(now)', () => {
  const db = makeDb();
  const written = backfillSeedBoards(db, { greenhouse: ['acme', 'beta'] });
  const rows = db.query('SELECT * FROM boards ORDER BY token').all() as any[];
  expect(rows.length).toBe(2);
  expect(rows[0].source_of_discovery).toBe('seed');
  expect(rows[0].first_seen_at).toBe(SEED_BACKFILL_FIRST_SEEN);
  expect(rows[1].first_seen_at).toBe(SEED_BACKFILL_FIRST_SEEN);
  expect(written).toBe(2);
  // D-10 proof (insert path)
  const bad = db
    .query(`SELECT COUNT(*) c FROM boards WHERE source_of_discovery='seed' AND first_seen_at <> '2020-01-01 00:00:00'`)
    .get() as { c: number };
  expect(bad.c).toBe(0);
});

test('backfillSeedBoards repairs an existing harvest-stamped row without re-attributing provenance', () => {
  const db = makeDb();
  const first = upsertBoard(db, { ats: 'greenhouse', token: 'acme', source_of_discovery: 'simplify' });
  db.query(`UPDATE boards SET first_seen_at = '2026-07-24 20:52:27' WHERE id = ?`).run(first!.id);
  recordBoardResult(db, 'greenhouse', 'acme', true); // give it last_ok_at to prove it survives
  const before = db.query('SELECT * FROM boards WHERE id = ?').get(first!.id) as any;

  backfillSeedBoards(db, { greenhouse: ['acme'] });

  const after = db.query('SELECT * FROM boards WHERE id = ?').get(first!.id) as any;
  expect(after.first_seen_at).toBe(SEED_BACKFILL_FIRST_SEEN);
  expect(after.source_of_discovery).toBe('simplify');
  expect(after.id).toBe(before.id);
  expect(after.last_ok_at).toBe(before.last_ok_at);
  expect(after.dead_since).toBe(before.dead_since);
  expect(after.consecutive_failures).toBe(before.consecutive_failures);
});

test('backfillSeedBoards is idempotent: a second identical call changes nothing', () => {
  const db = makeDb();
  backfillSeedBoards(db, { greenhouse: ['acme', 'beta'] });
  const before = db.query('SELECT * FROM boards ORDER BY token').all() as any[];
  backfillSeedBoards(db, { greenhouse: ['acme', 'beta'] });
  const after = db.query('SELECT * FROM boards ORDER BY token').all() as any[];
  expect(after.length).toBe(before.length);
  for (const row of after) expect(row.first_seen_at).toBe(SEED_BACKFILL_FIRST_SEEN);
});

test('backfillSeedBoards leaves a row for a token not in the supplied config lists untouched', () => {
  const db = makeDb();
  const other = upsertBoard(db, { ats: 'greenhouse', token: 'untouched', source_of_discovery: 'simplify' });
  db.query(`UPDATE boards SET first_seen_at = '2026-07-24 20:52:27' WHERE id = ?`).run(other!.id);
  backfillSeedBoards(db, { greenhouse: ['acme'] });
  const row = db.query('SELECT * FROM boards WHERE id = ?').get(other!.id) as any;
  expect(row.first_seen_at).toBe('2026-07-24 20:52:27');
});

test('backfillSeedBoards rejects a malformed token, a blocklisted token, an out-of-enum ats, and blank/non-string entries without throwing', () => {
  const db = makeDb();
  expect(() =>
    backfillSeedBoards(
      db,
      {
        greenhouse: ['bad/slug', 'acme', '', '   ', null as unknown as string, 'blocked'],
        workday: ['nope'],
      },
      ['blocked'],
    ),
  ).not.toThrow();
  const tokens = db.query('SELECT token FROM boards').all().map((r: any) => r.token);
  expect(tokens).toEqual(['acme']);
});

// ---------------------------------------------------------------------------
// 16-REVIEW WR-01: boards case-sensitivity.
//
// UNIQUE(ats, token) is case-sensitive but resolveEffectiveTokens dedupes
// case-insensitively, so a differently-cased harvest used to create a second
// row that the resolver then dropped — orphaned, never polled, and therefore
// never dead-marked ("Twitch" vs "twitch" in the live db during Phase 16).
//
// The fix folds the variant onto the existing row and KEEPS THE STORED CASE,
// rather than lowercasing tokens. Measured 2026-07-27 against the real APIs:
// greenhouse (`boards-api.greenhouse.io/v1/boards/<t>/jobs`) and ashby
// (`api.ashbyhq.com/posting-api/job-board/<t>`) answer 200 for any case, but
// LEVER IS CASE-SENSITIVE — `api.lever.co/v0/postings/agile-defense` is 200
// and `.../AGILE-DEFENSE` is 404. Lowercasing on write would have broken every
// Lever board whose slug carries a capital.
// ---------------------------------------------------------------------------

test('a differently-cased token folds onto the existing row instead of orphaning a second one', () => {
  const db = makeDb();
  const first = upsertBoard(db, { ats: 'lever', token: 'Agile-Defense', source_of_discovery: 'seed' });
  const second = upsertBoard(db, { ats: 'lever', token: 'agile-defense', source_of_discovery: 'simplify' });
  expect(db.query('SELECT count(*) AS n FROM boards').get()).toEqual({ n: 1 });
  expect(second!.id).toBe(first!.id);
});

test('folding a case variant preserves the stored case, because lever 404s on the wrong case', () => {
  const db = makeDb();
  upsertBoard(db, { ats: 'lever', token: 'Agile-Defense', source_of_discovery: 'seed' });
  const second = upsertBoard(db, { ats: 'lever', token: 'AGILE-DEFENSE', source_of_discovery: 'simplify' });
  expect(second!.token).toBe('Agile-Defense');
  expect(resolveEffectiveTokens(db, 'lever', [])).toEqual(['Agile-Defense']);
});

test('case folding is per-ats — the same token under two ATSes stays two rows', () => {
  const db = makeDb();
  upsertBoard(db, { ats: 'lever', token: 'acme', source_of_discovery: 'seed' });
  upsertBoard(db, { ats: 'ashby', token: 'ACME', source_of_discovery: 'seed' });
  expect(db.query('SELECT count(*) AS n FROM boards').get()).toEqual({ n: 2 });
});

test('recordBoardResult matches case-insensitively, so a variant-cased poll still dead-marks its row', () => {
  const db = makeDb();
  upsertBoard(db, { ats: 'ashby', token: 'KAYAK', source_of_discovery: 'seed' });
  for (let i = 0; i < DEAD_AFTER; i++) recordBoardResult(db, 'ashby', 'kayak', false);
  const row = db.query('SELECT * FROM boards').get() as any;
  expect(row.consecutive_failures).toBe(DEAD_AFTER);
  expect(row.dead_since).not.toBeNull();
});

test('backfillSeedBoards folds a case variant onto the existing row rather than adding a second', () => {
  const db = makeDb();
  upsertBoard(db, { ats: 'ashby', token: 'Vytalize', source_of_discovery: 'simplify' });
  backfillSeedBoards(db, { ashby: ['vytalize'] });
  const rows = db.query('SELECT token, first_seen_at FROM boards').all() as any[];
  expect(rows.length).toBe(1);
  expect(rows[0].token).toBe('Vytalize');
  expect(rows[0].first_seen_at).toBe(SEED_BACKFILL_FIRST_SEEN);
});

// ---------------------------------------------------------------------------
// Todo item 3: dead tokens in the curated seed 404 forever.
//
// The live db shows these ARE dead-marked (embed/Vytalize/checkout/mistral/
// morrishealthtech/mtesting each sat at 13 consecutive failures on 2026-07-27)
// — the todo's "never dead-marked" reading was wrong. The real defect is that
// resolveEffectiveTokens added every config token unconditionally, ahead of the
// listActiveBoards call, so dead-marking was simply ignored for them. Each
// failure then refreshed dead_since, so DEAD_RECHECK_DAYS never elapsed and
// they were polled every single sweep, forever.
// ---------------------------------------------------------------------------

test('a config token whose board is dead is dropped from the effective list', () => {
  const db = makeDb();
  upsertBoard(db, { ats: 'ashby', token: 'mistral', source_of_discovery: 'seed' });
  for (let i = 0; i < DEAD_AFTER; i++) recordBoardResult(db, 'ashby', 'mistral', false);
  expect(resolveEffectiveTokens(db, 'ashby', ['mistral', 'alive'])).toEqual(['alive']);
});

test('a dead config token comes back for one retry once DEAD_RECHECK_DAYS has elapsed', () => {
  const db = makeDb();
  upsertBoard(db, { ats: 'ashby', token: 'mistral', source_of_discovery: 'seed' });
  for (let i = 0; i < DEAD_AFTER; i++) recordBoardResult(db, 'ashby', 'mistral', false);
  db.query(`UPDATE boards SET dead_since = datetime('now', '-${DEAD_RECHECK_DAYS + 1} days')`).run();
  expect(resolveEffectiveTokens(db, 'ashby', ['mistral'])).toEqual(['mistral']);
});

test('D-06 fail-open: a config token with no boards row at all is still polled', () => {
  const db = makeDb();
  expect(resolveEffectiveTokens(db, 'greenhouse', ['brand-new'])).toEqual(['brand-new']);
});

test('the dead-config-token drop is case-insensitive and per-ats', () => {
  const db = makeDb();
  upsertBoard(db, { ats: 'ashby', token: 'Vytalize', source_of_discovery: 'seed' });
  for (let i = 0; i < DEAD_AFTER; i++) recordBoardResult(db, 'ashby', 'Vytalize', false);
  expect(resolveEffectiveTokens(db, 'ashby', ['vytalize'])).toEqual([]);
  // A live greenhouse board of the same name is unaffected.
  expect(resolveEffectiveTokens(db, 'greenhouse', ['vytalize'])).toEqual(['vytalize']);
});

// ---------------------------------------------------------------------------
// Todo item 5: boardsAdded double-counts.
//
// upsertBoard's ON CONFLICT DO UPDATE ... RETURNING * returns a row on update
// as well as on insert, so `!= null` counted re-discoveries as additions. Sweep
// #14 reported boardsAdded: 429 against 427 real rows — two boards harvested by
// both simplify and getro in the same sweep, counted once each way.
// ---------------------------------------------------------------------------

test('upsertBoard reports inserted=true only on a real insert', () => {
  const db = makeDb();
  expect(upsertBoard(db, { ats: 'greenhouse', token: 'acme', source_of_discovery: 'simplify' })!.inserted).toBe(true);
  expect(upsertBoard(db, { ats: 'greenhouse', token: 'acme', source_of_discovery: 'getro' })!.inserted).toBe(false);
  expect(upsertBoard(db, { ats: 'greenhouse', token: 'ACME', source_of_discovery: 'getro' })!.inserted).toBe(false);
});
