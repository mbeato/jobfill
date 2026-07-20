import type { Database } from 'bun:sqlite';

// Widget-failure evidence capture (D-06, D-07). Mirrors the answers-table pattern:
// server.ts owns the applications-table coupling and passes a resolver in, keeping
// this module unit-testable against a bare `new Database(':memory:')`.

export interface FailureRow {
  id: number;
  application_id: number | null;
  url: string;
  field_label: string;
  mapped_value: string;
  status: string;
  widget_kind: string;
  outer_html: string;
  options_seen: string[] | null;
  list_resolved_via_aria: boolean | null;
  created_at: string;
}

export interface FailureRecordInput {
  id?: string;
  label?: string;
  mappedValue?: string;
  status?: string;
  widgetKind?: string | null;
  outerHTML?: string;
  optionsSeen?: string[] | null;
  listResolvedViaAria?: boolean | null;
}

const MAX_OUTER_HTML = 8000;
// WR-04: the persistence boundary defends itself regardless of caller — bound every
// text column and the batch size so one pathological POST can't bloat the db.
const MAX_TEXT = 2000;
const MAX_OPTIONS = 20;
const MAX_OPTION_LEN = 200;
const MAX_RECORDS = 50;

// The trust boundary is the POST body, not the extension — reject statuses outside
// the known triage set so arbitrary strings never reach the store (CR-01).
const VALID_STATUSES = new Set(['verify', 'needs_manual', 'error', 'didnt_stick', 'not_found', 'stale']);

export function createFailuresTable(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER,
    url TEXT DEFAULT '',
    field_label TEXT DEFAULT '',
    mapped_value TEXT DEFAULT '',
    status TEXT NOT NULL,
    widget_kind TEXT DEFAULT '',
    outer_html TEXT DEFAULT '',
    options_seen TEXT DEFAULT '',
    list_resolved_via_aria INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
}

export function insertFailures(
  db: Database,
  url: string,
  records: FailureRecordInput[],
  resolveApplicationId: (url: string) => number | null,
): { saved: number } {
  const applicationId = resolveApplicationId(url);
  let saved = 0;
  for (const r of (Array.isArray(records) ? records : []).slice(0, MAX_RECORDS)) {
    const status = String(r?.status ?? '').trim();
    if (!VALID_STATUSES.has(status)) continue;
    const optionsSeenArr = Array.isArray(r?.optionsSeen)
      ? r.optionsSeen.slice(0, MAX_OPTIONS).map(o => String(o ?? '').slice(0, MAX_OPTION_LEN))
      : null;
    const optionsSeen = optionsSeenArr && optionsSeenArr.length ? JSON.stringify(optionsSeenArr) : '';
    const listResolvedViaAria = r?.listResolvedViaAria === true ? 1 : r?.listResolvedViaAria === false ? 0 : null;
    db.query(
      `INSERT INTO failures (application_id, url, field_label, mapped_value, status, widget_kind, outer_html, options_seen, list_resolved_via_aria)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      applicationId,
      String(url ?? '').slice(0, MAX_TEXT),
      String(r?.label ?? '').slice(0, MAX_TEXT),
      String(r?.mappedValue ?? '').slice(0, MAX_TEXT),
      status,
      String(r?.widgetKind ?? ''),
      String(r?.outerHTML ?? '').slice(0, MAX_OUTER_HTML),
      optionsSeen,
      listResolvedViaAria,
    );
    saved++;
  }
  return { saved };
}

export function listFailures(db: Database): FailureRow[] {
  const rows = db.query('SELECT * FROM failures ORDER BY created_at DESC, id DESC').all() as (Omit<
    FailureRow,
    'options_seen' | 'list_resolved_via_aria'
  > & { options_seen: string; list_resolved_via_aria: number | null })[];
  return rows.map(row => ({
    ...row,
    options_seen: (() => {
      if (!row.options_seen) return null;
      try {
        const parsed = JSON.parse(row.options_seen);
        return Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    })(),
    list_resolved_via_aria: row.list_resolved_via_aria === 1 ? true : row.list_resolved_via_aria === 0 ? false : null,
  }));
}
