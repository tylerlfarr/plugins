#!/usr/bin/env node
/**
 * Live lookup plus controlled change-detection test (Fairfax).
 *
 * NOT an observed government status transition.
 * Demo/test-origin records use a real public ID but must never count as
 * workbook import / customer coverage.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffx-demo-'));
process.env.PERMIT_DB_PATH = path.join(tmp, 'demo.sqlite');
process.env.PERMIT_DEMO = '1';

const LIVE_ID = 'ALTC-2026-00970';

const { db, migrate, setSetting } = await import('../db.js');
const { syncPermitById, rebuildAttention } = await import('../sync.js');

migrate();
setSetting('stale_days', '14');
setSetting('demo_mode', '1');

// Demo/test origin — intentionally NOT import
const section = db
  .prepare(
    `INSERT INTO community_sections(
       project_code, community_name, jurisdiction_code, jurisdiction_source, jurisdiction_confirmed,
       authority_note, header_json, record_origin
     ) VALUES (
       'FFX-DEMO', 'Fairfax Controlled Test', 'fairfax_county', 'operator_confirmed', 1,
       'Demo/test fixture with public RECORDID — not from source workbook',
       '[]', 'demo'
     )`
  )
  .run();
const lot = db
  .prepare(
    `INSERT INTO lot_groups(section_id, lot_label, housetype, stable_key, notes_raw, record_origin)
     VALUES (?, 'DEMO', 'Alteration', 'ffx-demo||fairfax controlled test||demo||alteration', ?, 'demo')`
  )
  .run(section.lastInsertRowid, LIVE_ID);
const info = db
  .prepare(
    `INSERT INTO permit_records(
       lot_group_id, primary_official_id, jurisdiction_code, jurisdiction_source,
       jurisdiction_confirmed, authority_note, internal_status, next_action, next_action_due, record_origin
     ) VALUES (?, ?, 'fairfax_county', 'operator_confirmed', 1,
               'Demo/test origin — excluded from operational coverage',
               'watching', 'Morning check', '2026-10-01', 'demo')`
  )
  .run(lot.lastInsertRowid, LIVE_ID);
db.prepare(
  `INSERT INTO official_ids(permit_record_id, official_id, id_prefix, jurisdiction_guess, is_primary)
   VALUES (?, ?, 'ALTC', 'fairfax_county', 1)`
).run(info.lastInsertRowid, LIVE_ID);
db.prepare(
  `INSERT INTO internal_milestones(permit_record_id, key, label, value, value_kind, source)
   VALUES (?, 'coordinator_note', 'Coordinator note', 'Must survive live sync', 'text', 'ui')`
).run(info.lastInsertRowid);

let permit = db.prepare(`SELECT * FROM permit_records WHERE id = ?`).get(info.lastInsertRowid);

console.log('=== Live lookup (demo/test origin) ===');
const liveLookup = await syncPermitById(permit.id, { allowSynthetic: true });
permit = db.prepare(`SELECT * FROM permit_records WHERE id = ?`).get(permit.id);
const noteAfter = db
  .prepare(
    `SELECT value FROM internal_milestones WHERE permit_record_id = ? AND key = 'coordinator_note'`
  )
  .get(permit.id);

console.log('=== Controlled change-detection test (injected local status — NOT a government transition) ===');
db.prepare(
  `UPDATE permit_records SET official_status = 'in_review', source_native_status = 'In Review' WHERE id = ?`
).run(permit.id);
permit = db.prepare(`SELECT * FROM permit_records WHERE id = ?`).get(permit.id);
const controlled = await syncPermitById(permit.id, { allowSynthetic: true });

rebuildAttention();
const attention = db
  .prepare(
    `SELECT kind, message FROM attention_events
     WHERE permit_record_id = ? AND resolved_at IS NULL AND acknowledged = 0`
  )
  .all(permit.id);

const final = db.prepare(`SELECT * FROM permit_records WHERE id = ?`).get(permit.id);
const proof = {
  label: 'Live lookup plus controlled change-detection test',
  notObservedGovernmentTransition: true,
  recordOrigin: final.record_origin,
  excludedFromOperationalCoverage: final.record_origin !== 'import',
  liveId: LIVE_ID,
  liveLookup: {
    outcome: liveLookup.outcome,
    mode: liveLookup.mode,
    baseline: liveLookup.baseline,
    officialStatusAfter: db.prepare('SELECT official_status, source_native_status FROM permit_records WHERE id = ?').get(final.id),
  },
  controlledChangeDetectionTest: {
    injectedLocalStatus: 'in_review',
    note: 'Local official_status flipped before re-query to exercise change-detection — not an observed AHJ transition',
    outcome: controlled.outcome,
    mode: controlled.mode,
  },
  internalPreserved: noteAfter?.value === 'Must survive live sync',
  readiness: final.readiness_state,
  attention,
  eliminatesWhenActivatedOnImportRecords: [
    'Manual Fairfax PLUS lookup for linked RECORDIDs',
    'Hand-copying Issued/status into a side tracker',
  ],
};

const out = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'docs',
  'automation-demo.json'
);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(proof, null, 2));
console.log(JSON.stringify(proof, null, 2));
console.log('Wrote', out);
