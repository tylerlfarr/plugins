/**
 * Single-tenant workspace foundation for the pilot.
 *
 * One SQLite DB = one business. Membership tables exist so a future second
 * tenant cannot be bolted on silently; domain rows are not yet filtered by
 * workspace_id — see docs/workspace-pilot.md for the backfill contract.
 */

import { db, getSetting } from './db.js';

export const DEFAULT_ORG_KEY = 'default';

export function ensureWorkspaceTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_key TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      member_role TEXT NOT NULL DEFAULT 'operator',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (workspace_id, user_id)
    );
  `);
}

export function ensureDefaultWorkspace() {
  ensureWorkspaceTables();
  let ws = db.prepare(`SELECT * FROM workspaces WHERE org_key = ?`).get(DEFAULT_ORG_KEY);
  if (!ws) {
    const name = getSetting('business_name', '') || process.env.BUSINESS_NAME || 'Pilot workspace';
    const info = db
      .prepare(`INSERT INTO workspaces(org_key, display_name) VALUES (?, ?)`)
      .run(DEFAULT_ORG_KEY, name);
    ws = db.prepare(`SELECT * FROM workspaces WHERE id = ?`).get(Number(info.lastInsertRowid));
  } else {
    const business = getSetting('business_name', '');
    if (business && ws.display_name !== business) {
      db.prepare(`UPDATE workspaces SET display_name = ? WHERE id = ?`).run(business, ws.id);
      ws = db.prepare(`SELECT * FROM workspaces WHERE id = ?`).get(ws.id);
    }
  }
  return ws;
}

/** Enroll every existing user into the default workspace (pilot backfill). */
export function backfillWorkspaceMemberships() {
  const ws = ensureDefaultWorkspace();
  const users = db.prepare(`SELECT id, role FROM users`).all();
  const insert = db.prepare(
    `INSERT INTO workspace_members(workspace_id, user_id, member_role)
     VALUES (?, ?, ?)
     ON CONFLICT(workspace_id, user_id) DO NOTHING`
  );
  for (const u of users) {
    insert.run(ws.id, u.id, u.role === 'owner' ? 'owner' : 'operator');
  }
  return { workspaceId: ws.id, members: users.length };
}

export function ensureUserWorkspaceMembership(userId, memberRole = 'operator') {
  if (!userId) return null;
  const ws = ensureDefaultWorkspace();
  const role = memberRole === 'owner' ? 'owner' : 'operator';
  db.prepare(
    `INSERT INTO workspace_members(workspace_id, user_id, member_role)
     VALUES (?, ?, ?)
     ON CONFLICT(workspace_id, user_id) DO UPDATE SET member_role = excluded.member_role`
  ).run(ws.id, Number(userId), role);
  return getUserWorkspace(userId);
}

export function getUserWorkspace(userId) {
  if (!userId) return null;
  ensureWorkspaceTables();
  return (
    db
      .prepare(
        `SELECT w.id, w.org_key, w.display_name, m.member_role
         FROM workspace_members m
         JOIN workspaces w ON w.id = m.workspace_id
         WHERE m.user_id = ?
         ORDER BY w.id ASC
         LIMIT 1`
      )
      .get(Number(userId)) || null
  );
}

export function publicWorkspace(ws) {
  if (!ws) return null;
  return {
    id: ws.id,
    org_key: ws.org_key,
    display_name: ws.display_name,
    member_role: ws.member_role || null,
    isolation: 'single_db',
  };
}

/**
 * Attach workspace membership after attachAuth.
 * Missing membership is auto-healed (backfill) for pre-workspace users.
 */
export function attachWorkspace(req, _res, next) {
  if (req.user?.id) {
    let ws = getUserWorkspace(req.user.id);
    if (!ws) ws = ensureUserWorkspaceMembership(req.user.id, req.user.role);
    req.workspace = ws || null;
  }
  next();
}

/**
 * Incomplete masterfile / plan-tracker rows (read-only coordinator surface).
 * Missing date_approved (or empty) ⇒ incomplete; list exact empty date fields.
 */
export function listIncompleteMasterfileRows() {
  const rows = db
    .prepare(
      `SELECT id, house_type, product_name, counties, neighborhood,
              date_requested, date_ready, date_submitted, comments_received,
              date_resubmitted, date_approved, notes, source_row
       FROM plan_tracker_rows
       ORDER BY id`
    )
    .all();
  return rows
    .map((row) => {
      const missing = [];
      for (const key of [
        'date_requested',
        'date_ready',
        'date_submitted',
        'date_approved',
      ]) {
        if (row[key] == null || String(row[key]).trim() === '') missing.push(key);
      }
      return { ...row, missing, incomplete: missing.includes('date_approved') };
    })
    .filter((r) => r.incomplete);
}

/** Open revisions that still need a received revised permit (coordinator list). */
export function listOpenRevisions() {
  return db
    .prepare(
      `SELECT id, community_code, lot, revised_start_sheet, date_submitted,
              received_revised_permit, reason, comments, source_row
       FROM permit_revisions
       WHERE received_revised_permit IS NULL OR trim(received_revised_permit) = ''
       ORDER BY id`
    )
    .all();
}
