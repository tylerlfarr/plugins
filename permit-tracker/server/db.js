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

    CREATE TABLE IF NOT EXISTS communities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      jurisdiction_code TEXT NOT NULL,
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      code TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(community_id, name)
    );

    CREATE TABLE IF NOT EXISTS lots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      lot_number TEXT NOT NULL,
      address TEXT DEFAULT '',
      parcel_id TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, lot_number)
    );

    CREATE TABLE IF NOT EXISTS permits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lot_id INTEGER NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
      jurisdiction_code TEXT NOT NULL,
      official_id TEXT,
      permit_type TEXT NOT NULL DEFAULT 'Building',
      source_native_status TEXT DEFAULT '',
      official_status TEXT DEFAULT 'unknown',
      internal_status TEXT NOT NULL DEFAULT 'watching',
      submitted_date TEXT,
      approved_date TEXT,
      issued_date TEXT,
      revision_date TEXT,
      construction_start_date TEXT,
      expiration_date TEXT,
      predicted_issue_date TEXT,
      owner TEXT DEFAULT '',
      notes TEXT DEFAULT '',
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

    CREATE UNIQUE INDEX IF NOT EXISTS idx_permits_jurisdiction_official
      ON permits(jurisdiction_code, official_id)
      WHERE official_id IS NOT NULL AND official_id != '';

    CREATE TABLE IF NOT EXISTS change_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      permit_id INTEGER NOT NULL REFERENCES permits(id) ON DELETE CASCADE,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      changed_by TEXT NOT NULL DEFAULT 'system',
      source TEXT NOT NULL DEFAULT 'ui',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS saved_filters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      definition TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS import_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      mapping_json TEXT NOT NULL,
      preview_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS match_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jurisdiction_code TEXT NOT NULL,
      candidate_official_id TEXT,
      reason TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS attention_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      permit_id INTEGER NOT NULL REFERENCES permits(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      acknowledged INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const staleDays = db.prepare("SELECT value FROM settings WHERE key = 'stale_days'").get();
  if (!staleDays) {
    db.prepare("INSERT INTO settings(key, value) VALUES ('stale_days', '14'), ('current_user', 'demo.user')").run();
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
    `INSERT INTO change_history(permit_id, field, old_value, new_value, changed_by, source)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(permitId, field, String(ov), String(nv), changedBy, source);
  return true;
}

export function upsertAttention(permitId, kind, message, dedupeKey) {
  db.prepare(
    `INSERT INTO attention_events(permit_id, kind, message, dedupe_key)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(dedupe_key) DO UPDATE SET
       message = excluded.message,
       acknowledged = 0`
  ).run(permitId, kind, message, dedupeKey);
}

migrate();
