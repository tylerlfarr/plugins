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

function addColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

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
      jurisdiction_code TEXT NOT NULL DEFAULT 'unresolved',
      jurisdiction_source TEXT NOT NULL DEFAULT 'unresolved',
      jurisdiction_confirmed INTEGER NOT NULL DEFAULT 0,
      permit_time_note TEXT DEFAULT '',
      header_json TEXT NOT NULL DEFAULT '[]',
      source_sheet TEXT NOT NULL DEFAULT 'Permit Tracker',
      source_header_row INTEGER,
      record_origin TEXT NOT NULL DEFAULT 'import',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_code, community_name, source_sheet)
    );

    CREATE TABLE IF NOT EXISTS lot_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      section_id INTEGER NOT NULL REFERENCES community_sections(id) ON DELETE CASCADE,
      lot_label TEXT NOT NULL,
      housetype TEXT DEFAULT '',
      stable_key TEXT NOT NULL DEFAULT '',
      source_row INTEGER,
      notes_raw TEXT DEFAULT '',
      record_origin TEXT NOT NULL DEFAULT 'import',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(section_id, lot_label, housetype)
    );

    CREATE TABLE IF NOT EXISTS permit_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lot_group_id INTEGER NOT NULL REFERENCES lot_groups(id) ON DELETE CASCADE,
      primary_official_id TEXT,
      jurisdiction_code TEXT NOT NULL DEFAULT 'unresolved',
      jurisdiction_source TEXT NOT NULL DEFAULT 'unresolved',
      jurisdiction_confirmed INTEGER NOT NULL DEFAULT 0,
      permit_kind TEXT DEFAULT 'building',
      source_native_status TEXT DEFAULT '',
      official_status TEXT DEFAULT 'unknown',
      internal_status TEXT NOT NULL DEFAULT 'watching',
      readiness_state TEXT NOT NULL DEFAULT 'unknown_stale',
      owner TEXT DEFAULT '',
      next_action TEXT DEFAULT '',
      next_action_due TEXT,
      source_url TEXT DEFAULT '',
      last_checked_at TEXT,
      last_successful_check_at TEXT,
      last_check_outcome TEXT DEFAULT 'never',
      last_check_error TEXT DEFAULT '',
      official_last_changed_at TEXT,
      progress_anchor_at TEXT,
      baseline_snapshot_at TEXT,
      record_origin TEXT NOT NULL DEFAULT 'import',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

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
      source TEXT NOT NULL DEFAULT 'import',
      edited_in_app INTEGER NOT NULL DEFAULT 0,
      last_import_value TEXT,
      UNIQUE(permit_record_id, key)
    );

    CREATE TABLE IF NOT EXISTS official_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      permit_record_id INTEGER NOT NULL REFERENCES permit_records(id) ON DELETE CASCADE,
      official_id TEXT,
      payload_json TEXT NOT NULL,
      mode TEXT NOT NULL,
      outcome TEXT NOT NULL,
      is_baseline INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS import_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      permit_record_id INTEGER REFERENCES permit_records(id) ON DELETE CASCADE,
      field TEXT NOT NULL,
      previous_import_value TEXT,
      app_value TEXT,
      incoming_value TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      resolution TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS attention_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      permit_record_id INTEGER REFERENCES permit_records(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      condition_key TEXT,
      acknowledged INTEGER NOT NULL DEFAULT 0,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS check_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      trigger TEXT NOT NULL DEFAULT 'manual',
      scope TEXT NOT NULL DEFAULT 'linked',
      total INTEGER NOT NULL DEFAULT 0,
      updated INTEGER NOT NULL DEFAULT 0,
      no_change INTEGER NOT NULL DEFAULT 0,
      not_found INTEGER NOT NULL DEFAULT 0,
      unavailable INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      skipped_demo INTEGER NOT NULL DEFAULT 0,
      summary_json TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS schedule_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      interval_minutes INTEGER NOT NULL DEFAULT 360,
      timeout_ms INTEGER NOT NULL DEFAULT 15000,
      max_retries INTEGER NOT NULL DEFAULT 2,
      backoff_ms INTEGER NOT NULL DEFAULT 2000,
      last_preview_at TEXT,
      notes TEXT DEFAULT 'Local schedule preview only — does not send digests'
    );

    CREATE TABLE IF NOT EXISTS import_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS archived_sheet_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sheet_name TEXT NOT NULL,
      source_row INTEGER,
      payload_json TEXT NOT NULL,
      imported_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS source_registry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      jurisdiction_code TEXT NOT NULL,
      agency TEXT NOT NULL DEFAULT '',
      record_types TEXT NOT NULL DEFAULT '',
      official_url TEXT NOT NULL DEFAULT '',
      endpoint TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL DEFAULT '',
      adapter_type TEXT NOT NULL DEFAULT 'none',
      available_fields_json TEXT NOT NULL DEFAULT '{}',
      auth_access TEXT NOT NULL DEFAULT '',
      refresh_frequency TEXT NOT NULL DEFAULT 'unknown',
      state TEXT NOT NULL DEFAULT 'discovered',
      coverage_limitations TEXT NOT NULL DEFAULT '',
      evidence TEXT NOT NULL DEFAULT '',
      last_verified_at TEXT,
      reusable INTEGER NOT NULL DEFAULT 1,
      activated INTEGER NOT NULL DEFAULT 0,
      activated_at TEXT,
      activated_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS discovery_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jurisdiction_code TEXT,
      url TEXT NOT NULL,
      result_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'discovered',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS idless_match_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      permit_record_id INTEGER REFERENCES permit_records(id) ON DELETE CASCADE,
      strategy TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      confidence TEXT NOT NULL DEFAULT 'low',
      status TEXT NOT NULL DEFAULT 'needs_review',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS readiness_assessments (
      permit_record_id INTEGER PRIMARY KEY REFERENCES permit_records(id) ON DELETE CASCADE,
      state TEXT NOT NULL,
      target_start TEXT,
      days_to_start INTEGER,
      summary TEXT NOT NULL DEFAULT '',
      outstanding_json TEXT NOT NULL DEFAULT '[]',
      satisfied_json TEXT NOT NULL DEFAULT '[]',
      gaps_json TEXT NOT NULL DEFAULT '[]',
      informational_json TEXT NOT NULL DEFAULT '[]',
      ruleset_key TEXT NOT NULL DEFAULT 'default_workbook_v1',
      assessed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS properties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_address TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT '',
      zip TEXT NOT NULL DEFAULT '',
      parcel_apn TEXT NOT NULL DEFAULT '',
      parcel_jurisdiction TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual',
      match_state TEXT NOT NULL DEFAULT 'unmatched',
      record_origin TEXT NOT NULL DEFAULT 'manual',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS property_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      lot_group_id INTEGER REFERENCES lot_groups(id) ON DELETE CASCADE,
      permit_record_id INTEGER REFERENCES permit_records(id) ON DELETE SET NULL,
      link_state TEXT NOT NULL DEFAULT 'candidate',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      confirmed_by TEXT,
      confirmed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(property_id, lot_group_id)
    );

    CREATE TABLE IF NOT EXISTS property_confirmations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS property_crosswalk_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_code TEXT,
      community_name TEXT,
      lot_label TEXT,
      housetype TEXT,
      site_address TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      parcel_apn TEXT,
      parcel_jurisdiction TEXT,
      match_status TEXT NOT NULL DEFAULT 'unmatched',
      lot_group_id INTEGER REFERENCES lot_groups(id) ON DELETE SET NULL,
      property_id INTEGER REFERENCES properties(id) ON DELETE SET NULL,
      source_row INTEGER,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER REFERENCES properties(id) ON DELETE CASCADE,
      permit_record_id INTEGER REFERENCES permit_records(id) ON DELETE SET NULL,
      lot_group_id INTEGER REFERENCES lot_groups(id) ON DELETE SET NULL,
      role TEXT NOT NULL DEFAULT 'property_owner',
      full_name TEXT NOT NULL DEFAULT '',
      company TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      mailing_address TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT '',
      provider_source TEXT NOT NULL DEFAULT '',
      retrieved_at TEXT,
      validation_state TEXT NOT NULL DEFAULT 'provider_returned',
      status TEXT NOT NULL DEFAULT 'candidate',
      restriction_flags_json TEXT NOT NULL DEFAULT '[]',
      record_origin TEXT NOT NULL DEFAULT 'manual',
      notes TEXT NOT NULL DEFAULT '',
      rejected_reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS contact_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL DEFAULT 'tracerfy',
      mode TEXT NOT NULL DEFAULT 'sandbox',
      property_id INTEGER REFERENCES properties(id) ON DELETE SET NULL,
      permit_record_id INTEGER REFERENCES permit_records(id) ON DELETE SET NULL,
      lot_group_id INTEGER REFERENCES lot_groups(id) ON DELETE SET NULL,
      request_fingerprint TEXT NOT NULL,
      endpoint TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued',
      estimated_credits INTEGER NOT NULL DEFAULT 0,
      actual_credits INTEGER NOT NULL DEFAULT 0,
      request_json TEXT NOT NULL DEFAULT '{}',
      response_json TEXT NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT '',
      external_request_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS milestone_waivers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      permit_record_id INTEGER NOT NULL REFERENCES permit_records(id) ON DELETE CASCADE,
      milestone_key TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      waived_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(permit_record_id, milestone_key)
    );

    CREATE TABLE IF NOT EXISTS applicability_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      community_section_id INTEGER REFERENCES community_sections(id) ON DELETE CASCADE,
      lot_group_id INTEGER REFERENCES lot_groups(id) ON DELETE CASCADE,
      feature_key TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'needs_confirmation',
      notes TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS plan_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lot_group_id INTEGER NOT NULL REFERENCES lot_groups(id) ON DELETE CASCADE,
      plan_tracker_row_id INTEGER REFERENCES plan_tracker_rows(id) ON DELETE SET NULL,
      product_name TEXT,
      counties TEXT,
      housetype TEXT,
      link_state TEXT NOT NULL DEFAULT 'candidate',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      confirmed_by TEXT,
      confirmed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(lot_group_id, product_name, counties, housetype)
    );

    CREATE TABLE IF NOT EXISTS provider_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      mode TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      credits INTEGER NOT NULL DEFAULT 0,
      job_id INTEGER REFERENCES contact_jobs(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Additive migrations for existing DBs
  addColumn('community_sections', 'jurisdiction_source', "jurisdiction_source TEXT NOT NULL DEFAULT 'unresolved'");
  addColumn('community_sections', 'jurisdiction_confirmed', 'jurisdiction_confirmed INTEGER NOT NULL DEFAULT 0');
  addColumn('community_sections', 'record_origin', "record_origin TEXT NOT NULL DEFAULT 'import'");
  addColumn('lot_groups', 'stable_key', "stable_key TEXT NOT NULL DEFAULT ''");
  addColumn('lot_groups', 'record_origin', "record_origin TEXT NOT NULL DEFAULT 'import'");
  addColumn('permit_records', 'jurisdiction_source', "jurisdiction_source TEXT NOT NULL DEFAULT 'unresolved'");
  addColumn('permit_records', 'jurisdiction_confirmed', 'jurisdiction_confirmed INTEGER NOT NULL DEFAULT 0');
  addColumn('permit_records', 'readiness_state', "readiness_state TEXT NOT NULL DEFAULT 'unknown_stale'");
  addColumn('permit_records', 'progress_anchor_at', 'progress_anchor_at TEXT');
  addColumn('permit_records', 'baseline_snapshot_at', 'baseline_snapshot_at TEXT');
  addColumn('permit_records', 'record_origin', "record_origin TEXT NOT NULL DEFAULT 'import'");
  addColumn('permit_records', 'authority_note', "authority_note TEXT NOT NULL DEFAULT ''");
  addColumn('community_sections', 'authority_note', "authority_note TEXT NOT NULL DEFAULT ''");
  addColumn('internal_milestones', 'source', "source TEXT NOT NULL DEFAULT 'import'");
  addColumn('internal_milestones', 'edited_in_app', 'edited_in_app INTEGER NOT NULL DEFAULT 0');
  addColumn('internal_milestones', 'last_import_value', 'last_import_value TEXT');
  addColumn('official_snapshots', 'is_baseline', 'is_baseline INTEGER NOT NULL DEFAULT 0');
  addColumn('attention_events', 'condition_key', 'condition_key TEXT');
  addColumn('attention_events', 'resolved_at', 'resolved_at TEXT');

  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_lot_stable ON lot_groups(stable_key) WHERE stable_key != ''`);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_permit_lot_official
      ON permit_records(lot_group_id, primary_official_id)
      WHERE primary_official_id IS NOT NULL AND primary_official_id != ''
  `);

  if (!db.prepare("SELECT value FROM settings WHERE key = 'stale_days'").get()) {
    db.prepare(
      "INSERT INTO settings(key, value) VALUES ('stale_days', '14'), ('current_user', 'demo.user'), ('demo_mode', '0')"
    ).run();
  }
  if (!db.prepare('SELECT id FROM schedule_config WHERE id = 1').get()) {
    db.prepare(
      `INSERT INTO schedule_config(id, enabled, interval_minutes, timeout_ms, max_retries, backoff_ms)
       VALUES (1, 0, 360, 15000, 2, 2000)`
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

export function isDemoMode() {
  return getSetting('demo_mode', '0') === '1' || process.env.PERMIT_DEMO === '1';
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

export function upsertAttention(permitId, kind, message, dedupeKey, conditionKey = null) {
  db.prepare(
    `INSERT INTO attention_events(permit_record_id, kind, message, dedupe_key, condition_key, resolved_at, acknowledged)
     VALUES (?, ?, ?, ?, ?, NULL, 0)
     ON CONFLICT(dedupe_key) DO UPDATE SET
       message = excluded.message,
       condition_key = excluded.condition_key,
       resolved_at = NULL,
       acknowledged = CASE
         WHEN attention_events.resolved_at IS NOT NULL THEN 0
         ELSE attention_events.acknowledged
       END`
  ).run(permitId, kind, message, dedupeKey, conditionKey);
}

export function resolveAttentionByCondition(conditionKey) {
  db.prepare(
    `UPDATE attention_events SET resolved_at = datetime('now')
     WHERE condition_key = ? AND resolved_at IS NULL`
  ).run(conditionKey);
}

migrate();
