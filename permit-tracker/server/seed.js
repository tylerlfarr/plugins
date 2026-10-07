import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { db, migrate, setSetting } from './db.js';
import { rebuildAttention } from './sync.js';
import { importWorkbookFile } from './workbookImport.js';

migrate();

const SOURCE_WORKBOOK_CANDIDATES = [
  process.env.SOURCE_WORKBOOK_XLSX,
  process.env.GOSPEL_XLSX,
  '/cursor/stores/self/internal/Permit_Tracker_9.1.2026.xlsx',
  '/cursor/stores/bc-01a10831-bc67-7d55-83fd-6645d7e3c6b1/internal/Permit_Tracker_9.1.2026.xlsx',
  '/home/ubuntu/.cursor/projects/workspace/uploads/Permit_Tracker_9.1.2026_48a1.xlsx',
].filter(Boolean);

function reset() {
  db.exec(`
    DELETE FROM attention_events;
    DELETE FROM match_reviews;
    DELETE FROM import_conflicts;
    DELETE FROM field_changes;
    DELETE FROM official_snapshots;
    DELETE FROM official_ids;
    DELETE FROM internal_milestones;
    DELETE FROM permit_records;
    DELETE FROM lot_groups;
    DELETE FROM community_sections;
    DELETE FROM permit_revisions;
    DELETE FROM plan_tracker_rows;
    DELETE FROM mst_reference_ids;
    DELETE FROM archived_sheet_rows;
    DELETE FROM saved_filters;
    DELETE FROM import_runs;
    DELETE FROM import_commit_keys;
    DELETE FROM check_runs;
  `);
}

/**
 * Isolated Fairfax live probe — demo/fixture only.
 * Never mixed into import-origin coverage or customer exports when demo_mode is off.
 */
function ensureFairfaxProbe() {
  let section = db
    .prepare(
      `SELECT id FROM community_sections WHERE project_code = 'FFX-DEMO' AND community_name = 'Fairfax Live Probe'`
    )
    .get();
  if (!section) {
    const info = db
      .prepare(
        `INSERT INTO community_sections(
           project_code, community_name, jurisdiction_code, jurisdiction_source, jurisdiction_confirmed,
           permit_time_note, header_json, record_origin
         ) VALUES (
           'FFX-DEMO', 'Fairfax Live Probe', 'fairfax_county', 'confirmed_mapping', 1,
           'demo overlay — not from source workbook rows', '[]', 'demo'
         )`
      )
      .run();
    section = { id: Number(info.lastInsertRowid) };
  }
  let lot = db
    .prepare(
      `SELECT id FROM lot_groups WHERE section_id = ? AND lot_label = 'PROBE' AND housetype = 'Live connector probe'`
    )
    .get(section.id);
  if (!lot) {
    const info = db
      .prepare(
        `INSERT INTO lot_groups(section_id, lot_label, housetype, stable_key, notes_raw, record_origin)
         VALUES (?, 'PROBE', 'Live connector probe', 'ffx-demo||fairfax live probe||probe||live connector probe',
                 'ALTC-2026-00970 (public Fairfax RECORDID for connector tests)', 'demo')`
      )
      .run(section.id);
    lot = { id: Number(info.lastInsertRowid) };
  }
  let permit = db
    .prepare(
      `SELECT id FROM permit_records WHERE lot_group_id = ? AND primary_official_id = 'ALTC-2026-00970'`
    )
    .get(lot.id);
  if (!permit) {
    const info = db
      .prepare(
        `INSERT INTO permit_records(
           lot_group_id, primary_official_id, jurisdiction_code, jurisdiction_source,
           jurisdiction_confirmed, internal_status, owner, next_action, next_action_due, record_origin
         ) VALUES (?, 'ALTC-2026-00970', 'fairfax_county', 'confirmed_mapping', 1,
                   'watching', 'demo.user', 'Morning check', '2026-10-01', 'demo')`
      )
      .run(lot.id);
    permit = { id: Number(info.lastInsertRowid) };
    db.prepare(
      `INSERT INTO official_ids(permit_record_id, official_id, id_prefix, jurisdiction_guess, is_primary)
       VALUES (?, 'ALTC-2026-00970', 'ALTC', 'fairfax_county', 1)`
    ).run(permit.id);
    db.prepare(
      `INSERT INTO internal_milestones(permit_record_id, key, label, value, value_kind, source)
       VALUES (?, 'internal_note_probe', 'Internal probe note', 'Must survive Fairfax sync', 'text', 'ui')`
    ).run(permit.id);
  }
}

export function seed({ preferWorkbook = true, includeDemoProbe = false } = {}) {
  reset();
  setSetting('stale_days', '14');
  setSetting('current_user', 'demo.user');
  const wantDemo =
    includeDemoProbe ||
    process.env.PERMIT_DEMO === '1' ||
    process.argv.includes('--demo');
  setSetting('demo_mode', wantDemo ? '1' : '0');

  let usedWorkbook = null;
  if (preferWorkbook) {
    for (const p of SOURCE_WORKBOOK_CANDIDATES) {
      if (p && fs.existsSync(p)) {
        usedWorkbook = p;
        break;
      }
    }
  }

  if (usedWorkbook) {
    const { summary } = importWorkbookFile(usedWorkbook, usedWorkbook.split('/').pop());
    if (wantDemo) ensureFairfaxProbe();
    db.prepare(
      `INSERT INTO saved_filters(name, definition) VALUES
       ('Needs follow-up', ?),
       ('Has official ID', ?),
       ('Fairfax-shaped IDs', ?),
       ('Residential use', ?),
       ('Use unknown (needs review)', ?)`
    ).run(
      JSON.stringify({ internal_status: 'needs_followup' }),
      JSON.stringify({ has_official_id: true }),
      JSON.stringify({ fairfax_shaped: true }),
      JSON.stringify({ use_classification: 'residential' }),
      JSON.stringify({ use_classification: 'unknown' })
    );
    rebuildAttention();
    console.log('Seeded from source workbook:', usedWorkbook, summary, wantDemo ? '(+demo probe)' : '');
    return { mode: 'workbook', path: usedWorkbook, summary, demoProbe: wantDemo };
  }

  if (wantDemo) {
    ensureFairfaxProbe();
    rebuildAttention();
    console.log('Seeded Fairfax demo probe only (source workbook not found).');
    return { mode: 'demo', demoProbe: true };
  }

  console.log('Empty seed — no source workbook and demo probe not requested.');
  return { mode: 'empty', demoProbe: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seed();
}
