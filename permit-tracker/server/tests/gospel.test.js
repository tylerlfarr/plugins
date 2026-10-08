/**
 * Optional live workbook tests — skipped when source xlsx is absent.
 * Offline integrity lives in integrity.test.js (sanitized fixtures).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbook-live-'));
process.env.PERMIT_DB_PATH = path.join(tmpDir, 'workbook.sqlite');

const { parseWorkbookBuffer, commitWorkbookParse } = await import('../workbookImport.js');
const { db } = await import('../db.js');

const SOURCE = '/cursor/stores/self/internal/Permit_Tracker_9.1.2026.xlsx';
const hasSource = fs.existsSync(SOURCE);

test('source workbook: 24 sections and multi-sheet import', { skip: !hasSource }, () => {
  const buf = fs.readFileSync(SOURCE);
  const parsed = parseWorkbookBuffer(buf);
  assert.equal(parsed.sheets.length, 8);
  assert.equal(parsed.permitTracker.sections.length, 24);
  assert.ok(parsed.permitTracker.rows.length > 50);
  assert.ok(parsed.mstIds.length > 10);
  const summary = commitWorkbookParse(parsed);
  assert.ok(summary.sections >= 20);
  assert.ok(summary.permits_created > 40);
  assert.ok(summary.archived_rows > 0);
  // No demo probe in import path
  const demo = db.prepare(`SELECT COUNT(*) AS c FROM permit_records WHERE record_origin = 'demo'`).get();
  assert.equal(demo.c, 0);
});

test('source workbook: duplicate import preserves app milestones', { skip: !hasSource }, () => {
  const buf = fs.readFileSync(SOURCE);
  const parsed = parseWorkbookBuffer(buf);
  commitWorkbookParse(parsed);
  const permit = db
    .prepare(
      `SELECT p.id FROM permit_records p
       JOIN lot_groups lg ON lg.id = p.lot_group_id
       WHERE lg.notes_raw LIKE '%ZNA2026-04510%' LIMIT 1`
    )
    .get();
  assert.ok(permit);
  db.prepare(
    `INSERT OR REPLACE INTO internal_milestones(permit_record_id, key, label, value, value_kind, edited_in_app)
     VALUES (?, 'user_keep', 'User Keep', 'preserve-me', 'text', 1)`
  ).run(permit.id);
  commitWorkbookParse(parsed);
  const kept = db
    .prepare(`SELECT value FROM internal_milestones WHERE permit_record_id = ? AND key = 'user_keep'`)
    .get(permit.id);
  assert.equal(kept.value, 'preserve-me');
});
