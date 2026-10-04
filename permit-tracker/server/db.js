import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
const dbPath = process.env.PERMIT_DB_PATH || path.join(dataDir, 'permit-tracker.sqlite');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS community_sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_code TEXT NOT NULL,
      community_name TEXT NOT NULL,
      jurisdiction_code TEXT NOT NULL DEFAULT 'unknown',
      permit_time_note TEXT DEFAULT '',
      header_json TEXT NOT NULL DEFAULT '[]',
      source_sheet TEXT NOT NULL DEFAULT 'Permit Tracker',
      source_header_row INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_code, community_name, source_sheet)
    );

    CREATE TABLE IF NOT EXISTS lot_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      section_id INTEGER NOT NULL REFERENCES community_sections(id) ON DELETE CASCADE,
      lot_label TEXT NOT NULL,
      housetype TEXT DEFAULT '',
      source_row INTEGER,
      notes_raw TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(section_id, lot_label, housetype)
    );

    CREATE TABLE IF NOT EXISTS permit_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lot_group_id INTEGER NOT NULL REFERENCES lot_groups(id) ON DELETE CASCADE,
      primary_official_id TEXT,
      jurisdiction_code TEXT NOT NULL DEFAULT 'unknown',
      permit_kind TEXT DEFAULT 'building',
      source_native_status TEXT DEFAULT '',
      official_status TEXT DEFAULT 'unknown',
      internal_status TEXT NOT NULL DEFAULT 'watching',
      owner TEXT DEFAULT '',
      next_action TEXT DEFAULT '',
      next_action_due TEXT,
      source_url TEXT DEFAULT '',
      last_checked_at TEXT,
      last_successful_check_at TEXT,
      last_check_outcome TEXT DEFAULT 'never',
      last_check_error TEXT DEFAULT '',
      official_last_changed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_permit_dup_key
      ON permit_records(lot_group_id, primary_official_id)
      WHERE primary_official_id IS NOT NULL AND primary_official_id != '';

    CREATE TABLE IF NOT EXISTS official_ids (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      permit_record_id INTEGER NOT NULL REFERENCES permit_records(id) ON DELETE CASCADE,
      official_id TEXT NOT NULL,
      id_prefix TEXT,
      jurisdiction_guess TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      extracted_from TEXT DEFAULT 'notes',
      UNIQUE(permit_record_id, official_id)
    );

    CREATE TABLE IF NOT EXISTS internal_milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      permit_record_id INTEGER NOT NULL REFERENCES permit_records(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      label TEXT NOT NULL,
      value TEXT,
      value_kind TEXT NOT NULL DEFAULT 'text',
      UNIQUE(permit_record_id, key)
    );

    CREATE TABLE IF NOT EXISTS official_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      permit_record_id INTEGER NOT NULL REFERENCES permit_records(id) ON DELETE CASCADE,
      official_id TEXT,
      payload_json TEXT NOT NULL,
      mode TEXT NOT NULL,
      outcome TEXT NOT NULL,
      checked_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS field_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      permit_record_id INTEGER NOT NULL REFERENCES permit_records(id) ON DELETE CASCADE,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      changed_by TEXT NOT NULL DEFAULT 'system',
      source TEXT NOT NULL DEFAULT 'ui',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS plan_tracker_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      house_type TEXT,
      product_name TEXT,
      counties TEXT,
      neighborhood TEXT,
      date_requested TEXT,
      date_ready TEXT,
      date_submitted TEXT,
      comments_received TEXT,
      date_resubmitted TEXT,
      date_approved TEXT,
      notes TEXT,
      official_ids_json TEXT DEFAULT '[]',
      source_row INTEGER
    );

    CREATE TABLE IF NOT EXISTS permit_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      community_code TEXT,
      lot TEXT,
      revised_start_sheet TEXT,
      date_submitted TEXT,
      received_revised_permit TEXT,
      reason TEXT,
      comments TEXT,
      source_row INTEGER
    );

    CREATE TABLE IF NOT EXISTS mst_reference_ids (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jurisdiction_hint TEXT,
      product_or_context TEXT,
      official_id TEXT NOT NULL,
      cell_text TEXT,
      source_row INTEGER,
      source_col TEXT
    );

    CREATE TABLE IF NOT EXISTS saved_filters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      definition TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS match_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jurisdiction_code TEXT,
      candidate_official_id TEXT,
      reason TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS attention_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      permit_record_id INTEGER REFERENCES permit_records(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      acknowledged INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS import_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  if (!db.prepare("SELECT value FROM settings WHERE key = 'stale_days'").get()) {
    db.prepare(
      "INSERT INTO settings(key, value) VALUES ('stale_days', '14'), ('current_user', 'demo.user')"
    ).run();
  }
}

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

export function recordChange(permitId, field, oldValue, newValue, changedBy, source) {
  const ov = oldValue ?? '';
  const nv = newValue ?? '';
  if (String(ov) === String(nv)) return false;
  db.prepare(
    `INSERT INTO field_changes(permit_record_id, field, old_value, new_value, changed_by, source)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(permitId, field, String(ov), String(nv), changedBy, source);
  return true;
}

export function upsertAttention(permitId, kind, message, dedupeKey) {
  db.prepare(
    `INSERT INTO attention_events(permit_record_id, kind, message, dedupe_key)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(dedupe_key) DO UPDATE SET message = excluded.message, acknowledged = 0`
  ).run(permitId, kind, message, dedupeKey);
}

migrate();
