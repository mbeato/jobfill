import type { Database } from 'bun:sqlite';

// Lifted from helper/server.ts's inline `seek_meta` DDL/writes so sweep.ts can
// use the same key/value table in `:memory:` tests without importing the
// server. Behavior is identical to what already shipped — this is a
// DI-friendly home for it, not a redesign.

export function createSeekMetaTable(db: Database): void {
  db.run('CREATE TABLE IF NOT EXISTS seek_meta (key TEXT PRIMARY KEY, value TEXT)');
}

export function readSeekMeta(db: Database, key: string): string | null {
  const row = db.query('SELECT value FROM seek_meta WHERE key = ?').get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function writeSeekMeta(db: Database, key: string, value: string): void {
  db.run('INSERT OR REPLACE INTO seek_meta(key, value) VALUES (?, ?)', [key, value]);
}
