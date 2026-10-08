import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permit-use-'));
process.env.PERMIT_DB_PATH = path.join(tmpDir, 'use.sqlite');
process.env.PERMIT_DEMO = '0';

const {
  classifyFromOfficialLabel,
  classifyFairfaxPermitType,
  computeEffectiveUse,
  applyOfficialUseToPermit,
  setManualUseOverride,
  USE_CLASSES,
  USE_SOURCES,
} = await import('../useClassification.js');
const { db, migrate } = await import('../db.js');
const { applyConnectorResult } = await import('../sync.js');
const { exportCoexistenceXlsx } = await import('../excelExport.js');
const XLSX = (await import('xlsx')).default;

migrate();

let seedSeq = 0;
function seedPermit() {
  seedSeq += 1;
  const code = `T${seedSeq}`;
  const sec = db
    .prepare(
      `INSERT INTO community_sections(project_code, community_name, jurisdiction_code, record_origin)
       VALUES (?,'Test Community','fairfax_county','import')`
    )
    .run(code);
  const lot = db
    .prepare(
      `INSERT INTO lot_groups(section_id, lot_label, housetype, stable_key, record_origin)
       VALUES (?, '1', 'TH', ?, 'import')`
    )
    .run(Number(sec.lastInsertRowid), `${code}||test||1||th`);
  const p = db
    .prepare(
      `INSERT INTO permit_records(lot_group_id, primary_official_id, jurisdiction_code, record_origin, permit_kind)
       VALUES (?, ?, 'fairfax_county', 'import', 'building')`
    )
    .run(Number(lot.lastInsertRowid), `BLD2026-${String(seedSeq).padStart(5, '0')}`);
  return db.prepare('SELECT * FROM permit_records WHERE id = ?').get(Number(p.lastInsertRowid));
}

test('official label mapping: explicit use words only; ID prefixes → unknown', () => {
  assert.equal(classifyFromOfficialLabel('Residential New Building').use, USE_CLASSES.RESIDENTIAL);
  assert.equal(classifyFromOfficialLabel('Commercial Alteration').use, USE_CLASSES.COMMERCIAL);
  assert.equal(classifyFromOfficialLabel('Mixed-Use Development').use, USE_CLASSES.MIXED_USE);
  assert.equal(classifyFromOfficialLabel('Mixed Occupancy').use, USE_CLASSES.MIXED_USE);
  // Work-type only / ambiguous
  assert.equal(classifyFromOfficialLabel('Building Permit').use, USE_CLASSES.UNKNOWN);
  assert.equal(classifyFromOfficialLabel('Alteration').use, USE_CLASSES.UNKNOWN);
  assert.equal(classifyFromOfficialLabel('Electrical').use, USE_CLASSES.UNKNOWN);
  // Must NOT infer from ID-like strings
  assert.equal(classifyFromOfficialLabel('BLD2026-00001').use, USE_CLASSES.UNKNOWN);
  assert.equal(classifyFromOfficialLabel('BLDC-2026-1').use, USE_CLASSES.UNKNOWN);
  assert.equal(classifyFromOfficialLabel('COMM-99').use, USE_CLASSES.UNKNOWN);
  assert.equal(classifyFromOfficialLabel('').use, USE_CLASSES.UNKNOWN);
  assert.equal(classifyFairfaxPermitType('Single-Family Dwelling').use, USE_CLASSES.RESIDENTIAL);
});

test('unreliable → unknown; manual override preserved across official sync', () => {
  const permit = seedPermit();
  assert.equal(permit.use_classification, 'unknown');

  applyOfficialUseToPermit(db, permit.id, 'Building Permit');
  let row = db.prepare('SELECT * FROM permit_records WHERE id = ?').get(permit.id);
  assert.equal(row.use_classification, USE_CLASSES.UNKNOWN);
  assert.equal(row.use_classification_source, USE_SOURCES.UNKNOWN_DEFAULT);
  assert.equal(row.use_classification_official_label, 'Building Permit');

  setManualUseOverride(db, permit.id, 'residential', { actor: 'ops.user' });
  row = db.prepare('SELECT * FROM permit_records WHERE id = ?').get(permit.id);
  assert.equal(row.use_classification, USE_CLASSES.RESIDENTIAL);
  assert.equal(row.use_classification_source, USE_SOURCES.MANUAL_OVERRIDE);
  assert.equal(row.use_classification_manual, 'residential');

  // Later sync with commercial official label — manual override wins
  applyOfficialUseToPermit(db, permit.id, 'Commercial Tenant Fit-Out');
  row = db.prepare('SELECT * FROM permit_records WHERE id = ?').get(permit.id);
  assert.equal(row.use_classification, USE_CLASSES.RESIDENTIAL);
  assert.equal(row.use_classification_source, USE_SOURCES.MANUAL_OVERRIDE);
  assert.equal(row.use_classification_official, USE_CLASSES.COMMERCIAL);
  assert.equal(row.use_classification_official_label, 'Commercial Tenant Fit-Out');

  // Clear override → falls back to official
  setManualUseOverride(db, permit.id, '', { actor: 'ops.user' });
  row = db.prepare('SELECT * FROM permit_records WHERE id = ?').get(permit.id);
  assert.equal(row.use_classification, USE_CLASSES.COMMERCIAL);
  assert.equal(row.use_classification_source, USE_SOURCES.OFFICIAL_LABEL);
  assert.equal(row.use_classification_manual, null);
});

test('connector apply updates official use; use ≠ work type; export columns', () => {
  const permit = seedPermit();
  applyConnectorResult(
    permit,
    {
      outcome: 'updated',
      mode: 'live',
      sourceNativeStatus: 'Issued',
      officialStatus: 'issued',
      fields: { permitType: 'Residential Addition', issuedDate: '2026-01-01' },
      checkedAt: new Date().toISOString(),
    },
    'connector',
    permit.primary_official_id
  );
  const row = db.prepare('SELECT * FROM permit_records WHERE id = ?').get(permit.id);
  assert.equal(row.use_classification, USE_CLASSES.RESIDENTIAL);
  assert.equal(row.use_classification_official_label, 'Residential Addition');
  assert.equal(row.permit_kind, 'building'); // work type unchanged / separate

  // Owner name / zoning-like noise must not drive classification when passed as label
  applyOfficialUseToPermit(db, permit.id, 'Smith Family Trust');
  const unknown = db.prepare('SELECT use_classification FROM permit_records WHERE id = ?').get(permit.id);
  // After clearing? applyOfficial with unknown label — if manual cleared, becomes unknown
  // Manual was cleared in previous test on different permit. This permit has residential from connector.
  // Applying 'Smith Family Trust' → official unknown; no manual → effective unknown
  assert.equal(unknown.use_classification, USE_CLASSES.UNKNOWN);

  const buf = exportCoexistenceXlsx();
  const wb = XLSX.read(buf, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Permit Tracker Export'] || {});
  assert.ok(rows.length >= 1);
  assert.ok('use_classification' in rows[0]);
  assert.ok('use_classification_source' in rows[0]);
  assert.ok('use_classification_official_label' in rows[0]);
  assert.ok('work_type_permit_kind' in rows[0]);
});

test('computeEffectiveUse precedence: manual > official > import > unknown', () => {
  assert.equal(
    computeEffectiveUse({
      officialUse: 'commercial',
      officialLabel: 'Commercial',
      manualUse: 'residential',
    }).use_classification,
    'residential'
  );
  assert.equal(
    computeEffectiveUse({ officialUse: 'commercial', officialLabel: 'Commercial' }).use_classification,
    'commercial'
  );
  assert.equal(
    computeEffectiveUse({ importUse: 'mixed_use' }).use_classification,
    'mixed_use'
  );
  assert.equal(computeEffectiveUse({}).use_classification, 'unknown');
});

test('export + list filters combine use with jurisdiction/status', () => {
  const a = seedPermit();
  const b = seedPermit();
  applyOfficialUseToPermit(db, a.id, 'Residential New Building');
  applyOfficialUseToPermit(db, b.id, 'Commercial Alteration');
  db.prepare(`UPDATE permit_records SET internal_status = 'needs_followup' WHERE id = ?`).run(a.id);

  const residential = db
    .prepare(
      `SELECT id FROM permit_records
       WHERE use_classification = ? AND jurisdiction_code = ? AND record_origin = 'import'`
    )
    .all('residential', 'fairfax_county');
  assert.ok(residential.some((r) => r.id === a.id));
  assert.ok(!residential.some((r) => r.id === b.id));

  const buf = exportCoexistenceXlsx({
    filters: {
      use_classification: 'residential',
      jurisdiction_code: 'fairfax_county',
      internal_status: 'needs_followup',
    },
  });
  const wb = XLSX.read(buf, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Permit Tracker Export'] || {});
  assert.ok(rows.every((r) => r.use_classification === 'residential'));
  assert.ok(rows.every((r) => r.internal_status === 'needs_followup'));
  assert.ok(rows.some((r) => r.primary_official_id === a.primary_official_id));
  assert.ok(!rows.some((r) => r.primary_official_id === b.primary_official_id));
});
