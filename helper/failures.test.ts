import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createFailuresTable, insertFailures, listFailures, type FailureRecordInput } from './failures';

function makeDb(): Database {
  const db = new Database(':memory:');
  createFailuresTable(db);
  return db;
}

const noApp = () => null;

test('createFailuresTable creates a table that supports insert+select', () => {
  const db = makeDb();
  db.run(`INSERT INTO failures (status) VALUES ('verify')`);
  const rows = db.query('SELECT * FROM failures').all();
  expect(rows.length).toBe(1);
});

test('insertFailures + listFailures round-trip: saved count, newest first, combobox state intact', () => {
  const db = makeDb();
  const records: FailureRecordInput[] = [
    {
      id: 'frame1:field1',
      label: 'Country',
      mappedValue: 'United States',
      status: 'verify',
      widgetKind: 'combobox',
      outerHTML: '<div>combobox</div>',
      optionsSeen: ['United States', 'Canada'],
      listResolvedViaAria: true,
    },
    {
      id: 'frame1:field2',
      label: 'State',
      mappedValue: 'NY',
      status: 'needs_manual',
      widgetKind: 'select',
      outerHTML: '<select></select>',
      optionsSeen: ['NY', 'CA'],
      listResolvedViaAria: false,
    },
  ];
  const result = insertFailures(db, 'https://boards.greenhouse.io/acme/jobs/1', records, noApp);
  expect(result).toEqual({ saved: 2 });

  const rows = listFailures(db);
  expect(rows.length).toBe(2);
  // newest first -> last-inserted (State) comes first
  expect(rows[0].field_label).toBe('State');
  expect(rows[0].options_seen).toEqual(['NY', 'CA']);
  expect(rows[0].list_resolved_via_aria).toBe(false);
  expect(rows[1].field_label).toBe('Country');
  expect(rows[1].options_seen).toEqual(['United States', 'Canada']);
  expect(rows[1].list_resolved_via_aria).toBe(true);
  expect(rows[1].mapped_value).toBe('United States');
  expect(rows[1].widget_kind).toBe('combobox');
});

test('application_id resolves via the passed resolver, and null when resolver returns null', () => {
  const db = makeDb();
  insertFailures(db, 'https://acme.com/apply', [{ status: 'error' }], () => 42);
  insertFailures(db, 'https://other.com/apply', [{ status: 'error' }], () => null);
  const rows = listFailures(db);
  const resolved = rows.find(r => r.url === 'https://acme.com/apply');
  const unresolved = rows.find(r => r.url === 'https://other.com/apply');
  expect(resolved?.application_id).toBe(42);
  expect(unresolved?.application_id).toBeNull();
});

test('optionsSeen null / listResolvedViaAria null store as \'\' / NULL and list back as null', () => {
  const db = makeDb();
  insertFailures(db, 'https://x.com', [{ status: 'error', optionsSeen: null, listResolvedViaAria: null }], noApp);
  const [row] = listFailures(db);
  expect(row.options_seen).toBeNull();
  expect(row.list_resolved_via_aria).toBeNull();
});

test('outer_html longer than 8000 chars is capped at 8000', () => {
  const db = makeDb();
  const long = 'x'.repeat(9000);
  insertFailures(db, 'https://x.com', [{ status: 'error', outerHTML: long }], noApp);
  const [row] = listFailures(db);
  expect(row.outer_html.length).toBe(8000);
});

test('a record with a status outside the known triage set is rejected (CR-01)', () => {
  const db = makeDb();
  const result = insertFailures(
    db,
    'https://x.com',
    [{ status: 'x"><img src=x onerror=alert(1)>', label: 'evil' }, { status: 'didnt_stick', label: 'kept' }],
    noApp,
  );
  expect(result).toEqual({ saved: 1 });
  const rows = listFailures(db);
  expect(rows.length).toBe(1);
  expect(rows[0].status).toBe('didnt_stick');
});

test('a record missing status is skipped; a stray id field is ignored (not stored)', () => {
  const db = makeDb();
  const result = insertFailures(
    db,
    'https://x.com',
    [{ label: 'no status here' } as FailureRecordInput, { id: 'frame1:should-be-ignored', status: 'verify', label: 'kept' }],
    noApp,
  );
  expect(result).toEqual({ saved: 1 });
  const rows = listFailures(db);
  expect(rows.length).toBe(1);
  expect(rows[0].field_label).toBe('kept');
  expect((rows[0] as any).id).not.toBe('frame1:should-be-ignored');
});
