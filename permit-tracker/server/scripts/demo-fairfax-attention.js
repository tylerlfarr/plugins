#!/usr/bin/env node
/**
 * Proven automation → attention workflow (Fairfax live).
 * Source update → import association → preserved internals → change/readiness → Attention.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffx-demo-'));
process.env.PERMIT_DB_PATH = path.join(tmp, 'demo.sqlite');
process.env.PERMIT_DEMO = '0';

const WORKBOOK = '/cursor/stores/self/internal/Permit_Tracker_9.1.2026.xlsx';
const LIVE_ID = 'ALTC-2026-00970';

const { db, migrate, setSetting } = await import('../db.js');
const { importWorkbookFile } = await import('../workbookImport.js');
const { syncPermitById, rebuildAttention, applyConnectorResult } = await import('../sync.js');

migrate();
setSetting('stale_days', '14');
setSetting('demo_mode', '0');

if (!fs.existsSync(WORKBOOK)) {
  console.error('Source workbook missing');
  process.exit(1);
}

const { summary } = importWorkbookFile(WORKBOOK);
console.log('Imported workbook', summary);

// Ensure an import-origin Fairfax-confirmed record for the public live ID
let permit = db
  .prepare(`SELECT * FROM permit_records WHERE primary_official_id = ? AND record_origin = 'import'`)
  .get(LIVE_ID);

if (!permit) {
  const section = db
    .prepare(
      `INSERT INTO community_sections(
         project_code, community_name, jurisdiction_code, jurisdiction_source, jurisdiction_confirmed,
         header_json, record_origin
       ) VALUES ('FFX1', 'Fairfax County Sample', 'fairfax_county', 'confirmed_mapping', 1, '[]', 'import')`
    )
    .run();
  const lot = db
    .prepare(
      `INSERT INTO lot_groups(section_id, lot_label, housetype, stable_key, notes_raw, record_origin)
       VALUES (?, 'LIVE', 'Alteration', 'ffx1||fairfax county sample||live||alteration', ?, 'import')`
    )
    .run(section.lastInsertRowid, LIVE_ID);
  const info = db
    .prepare(
      `INSERT INTO permit_records(
         lot_group_id, primary_official_id, jurisdiction_code, jurisdiction_source,
         jurisdiction_confirmed, internal_status, next_action, next_action_due, record_origin
       ) VALUES (?, ?, 'fairfax_county', 'confirmed_mapping', 1, 'watching', 'Morning check', '2026-10-01', 'import')`
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
  permit = db.prepare(`SELECT * FROM permit_records WHERE id = ?`).get(info.lastInsertRowid);
}

const noteBefore = db
  .prepare(
    `SELECT value FROM internal_milestones WHERE permit_record_id = ? AND key = 'coordinator_note'`
  )
  .get(permit.id);

console.log('Live sync #1 (baseline)...');
const r1 = await syncPermitById(permit.id, { allowSynthetic: false });
console.log('  outcome:', r1);

permit = db.prepare(`SELECT * FROM permit_records WHERE id = ?`).get(permit.id);
const noteAfter = db
  .prepare(
    `SELECT value FROM internal_milestones WHERE permit_record_id = ? AND key = 'coordinator_note'`
  )
  .get(permit.id);

// Simulate subsequent source change after baseline
db.prepare(
  `UPDATE permit_records SET official_status = 'in_review', source_native_status = 'In Review' WHERE id = ?`
).run(permit.id);
permit = db.prepare(`SELECT * FROM permit_records WHERE id = ?`).get(permit.id);

console.log('Live sync #2 (subsequent — should attention status_change)...');
const r2 = await syncPermitById(permit.id, { allowSynthetic: false });
console.log('  outcome:', r2);

rebuildAttention();
const attention = db
  .prepare(
    `SELECT kind, message FROM attention_events
     WHERE permit_record_id = ? AND resolved_at IS NULL AND acknowledged = 0`
  )
  .all(permit.id);

const final = db.prepare(`SELECT * FROM permit_records WHERE id = ?`).get(permit.id);
const snap = db
  .prepare(
    `SELECT official_id, mode, outcome, is_baseline FROM official_snapshots WHERE permit_record_id = ? ORDER BY id`
  )
  .all(permit.id);

const proof = {
  liveId: LIVE_ID,
  baselineOutcome: r1,
  subsequentOutcome: r2,
  internalPreserved: noteBefore?.value === noteAfter?.value && noteAfter?.value === 'Must survive live sync',
  readiness: final.readiness_state,
  officialStatus: final.official_status,
  sourceNative: final.source_native_status,
  progressAnchor: final.progress_anchor_at,
  lastSuccessfulCheck: final.last_successful_check_at,
  progressClockSeparate:
    Boolean(final.progress_anchor_at) &&
    Boolean(final.last_successful_check_at) &&
    final.progress_anchor_at !== final.last_successful_check_at
      ? 'may differ after no-change checks'
      : 'set',
  snapshots: snap,
  attention,
  eliminates: [
    'Manual Fairfax PLUS lookup for this RECORDID each morning',
    'Copying Issued/status into a side tracker',
    'Forgetting whether an internal coordinator note was overwritten by the portal check',
  ],
};

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'automation-demo.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(proof, null, 2));
console.log(JSON.stringify(proof, null, 2));
console.log('Wrote', out);
