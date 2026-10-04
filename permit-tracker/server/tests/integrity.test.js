import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import XLSX from 'xlsx';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permit-integrity-'));
process.env.PERMIT_DB_PATH = path.join(tmpDir, 'integrity.sqlite');
process.env.PERMIT_DEMO = '0';

const { buildSanitizedWorkbookBuffer } = await import('../fixtures/buildSanitizedWorkbook.js');
const {
  parseWorkbookBuffer,
  commitWorkbookParse,
  parseWorkbookDate,
  extractOfficialIds,
  isFairfaxShapedId,
} = await import('../workbookImport.js');
const { suggestJurisdictionFromId } = await import('../ids.js');
const { db, setSetting, recordChange } = await import('../db.js');
const {
  applyConnectorResult,
  syncPermitById,
  rebuildAttention,
  getSchedulePreview,
} = await import('../sync.js');
const { checkPermit } = await import('../connectors/index.js');
const { exportCoexistenceXlsx } = await import('../excelExport.js');

function importFixture() {
  const buf = buildSanitizedWorkbookBuffer();
  const parsed = parseWorkbookBuffer(buf);
  const summary = commitWorkbookParse(parsed);
  return { buf, parsed, summary };
}

test('sanitized fixture parses 8 sheets and two sections', () => {
  const { parsed, summary } = importFixture();
  assert.equal(parsed.sheets.length, 8);
  assert.equal(parsed.permitTracker.sections.length, 2);
  assert.ok(summary.permits_created >= 4);
  assert.ok(summary.archived_rows > 0);
  assert.ok(summary.mst_ids >= 2);
  // Multi-record: ZNA + BLD on same lot → 2 permit records
  const multi = db
    .prepare(
      `SELECT COUNT(*) AS c FROM permit_records p
       JOIN lot_groups lg ON lg.id = p.lot_group_id
       WHERE lg.lot_label = '1-4' AND p.record_origin = 'import'`
    )
    .get();
  assert.equal(multi.c, 2);
  // Lot range preserved
  const range = db.prepare(`SELECT lot_label FROM lot_groups WHERE lot_label = '96-100'`).get();
  assert.ok(range);
});

test('utility geography suggests AHJ; BLDC ambiguous without confirmation', () => {
  const pwc = db
    .prepare(
      `SELECT jurisdiction_code, jurisdiction_confirmed, jurisdiction_source FROM permit_records
       WHERE primary_official_id = 'ZNA2026-04510'`
    )
    .get();
  assert.equal(pwc.jurisdiction_code, 'prince_william_county');
  assert.equal(pwc.jurisdiction_confirmed, 0);
  assert.match(pwc.jurisdiction_source, /suggestion/);

  const bldc = suggestJurisdictionFromId('BLDC-2026-040694');
  assert.equal(bldc.confidence, 'ambiguous');

  // Section LoCo Water suggests Loudoun — not operator-confirmed
  const loudoun = db
    .prepare(
      `SELECT jurisdiction_code, jurisdiction_confirmed, jurisdiction_source FROM permit_records
       WHERE primary_official_id = 'BLDC-2026-040694'`
    )
    .get();
  assert.equal(loudoun.jurisdiction_code, 'loudoun_county');
  assert.equal(loudoun.jurisdiction_confirmed, 0);
});

test('stable identity: first ID on existing shell is attach, not duplicate project', () => {
  const shell = db
    .prepare(
      `SELECT p.* FROM permit_records p
       JOIN lot_groups lg ON lg.id = p.lot_group_id
       WHERE lg.lot_label = '10' AND (p.primary_official_id IS NULL OR p.primary_official_id = '')`
    )
    .get();
  assert.ok(shell);
  const beforeCount = db.prepare(`SELECT COUNT(*) AS c FROM permit_records`).get().c;

  // Re-import with ID added to lot 10
  const buf = buildSanitizedWorkbookBuffer();
  const wb = XLSX.read(buf, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Permit Tracker'], { header: 1, defval: null });
  // Find lot 10 row and add ID
  for (const row of rows) {
    if (String(row[1]) === '10') {
      row[18] = 'BLD2026-09999';
    }
  }
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  wb.Sheets['Permit Tracker'] = sheet;
  const next = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  commitWorkbookParse(parseWorkbookBuffer(next));

  const after = db.prepare(`SELECT * FROM permit_records WHERE id = ?`).get(shell.id);
  assert.equal(after.primary_official_id, 'BLD2026-09999');
  const afterCount = db.prepare(`SELECT COUNT(*) AS c FROM permit_records`).get().c;
  // Should not create an extra shell for lot 10
  assert.ok(afterCount <= beforeCount + 1);
});

test('blank import does not wipe milestones; 3-way conflict when app-edited', () => {
  const permit = db
    .prepare(`SELECT id FROM permit_records WHERE primary_official_id = 'ZNA2026-04510'`)
    .get();
  assert.ok(permit);
  const mile = db
    .prepare(`SELECT * FROM internal_milestones WHERE permit_record_id = ? LIMIT 1`)
    .get(permit.id);
  assert.ok(mile);

  // App edit
  db.prepare(
    `UPDATE internal_milestones SET value = 'app-edited', edited_in_app = 1 WHERE id = ?`
  ).run(mile.id);

  // Re-import same fixture (incoming differs from app, prev import differs)
  const { parsed } = importFixture();
  // importFixture already committed once at start — commit again for conflict path
  commitWorkbookParse(parsed);

  const conflicts = db
    .prepare(`SELECT * FROM import_conflicts WHERE permit_record_id = ? AND status = 'pending'`)
    .all(permit.id);
  assert.ok(conflicts.length >= 1);

  const kept = db.prepare(`SELECT value FROM internal_milestones WHERE id = ?`).get(mile.id);
  assert.equal(kept.value, 'app-edited');
});

test('live miss/outage does not fall back to synthetic for import records', async () => {
  const permit = db
    .prepare(`SELECT * FROM permit_records WHERE primary_official_id = 'BLDC-2026-040694'`)
    .get();
  // Loudoun unsupported → unavailable, not synthetic update
  const result = await checkPermit({
    jurisdictionCode: 'loudoun_county',
    officialId: permit.primary_official_id,
    allowSynthetic: false,
    recordOrigin: 'import',
  });
  assert.equal(result.outcome, 'unavailable');
  assert.notEqual(result.mode, 'synthetic');

  const applied = applyConnectorResult(permit, {
    outcome: 'updated',
    mode: 'synthetic',
    sourceNativeStatus: 'FAKE',
    officialStatus: 'issued',
    fields: {},
    checkedAt: new Date().toISOString(),
  });
  assert.equal(applied.outcome, 'unavailable');
  assert.equal(applied.reason, 'synthetic_blocked');
  const after = db.prepare(`SELECT official_status FROM permit_records WHERE id = ?`).get(permit.id);
  assert.notEqual(after.official_status, 'issued');
});

test('baseline first success does not create status_change attention; subsequent does', () => {
  // Fresh permit
  const section = db
    .prepare(
      `INSERT INTO community_sections(project_code, community_name, jurisdiction_code, jurisdiction_source, jurisdiction_confirmed, header_json, record_origin)
       VALUES ('T','Test','fairfax_county','confirmed_mapping',1,'[]','import')`
    )
    .run();
  const lot = db
    .prepare(
      `INSERT INTO lot_groups(section_id, lot_label, housetype, stable_key, record_origin)
       VALUES (?, 'T1', 'H', 't||test||t1||h', 'import')`
    )
    .run(section.lastInsertRowid);
  const pr = db
    .prepare(
      `INSERT INTO permit_records(lot_group_id, primary_official_id, jurisdiction_code, jurisdiction_source, jurisdiction_confirmed, record_origin)
       VALUES (?, 'ALTC-2099-00001', 'fairfax_county', 'confirmed_mapping', 1, 'import')`
    )
    .run(lot.lastInsertRowid);
  const permit = db.prepare(`SELECT * FROM permit_records WHERE id = ?`).get(pr.lastInsertRowid);

  applyConnectorResult(permit, {
    outcome: 'updated',
    mode: 'live',
    sourceNativeStatus: 'Issued',
    officialStatus: 'issued',
    fields: { issuedDate: '2026-01-01' },
    checkedAt: new Date().toISOString(),
  });
  const baselineAlerts = db
    .prepare(
      `SELECT * FROM attention_events WHERE permit_record_id = ? AND kind = 'status_change' AND resolved_at IS NULL`
    )
    .all(permit.id);
  assert.equal(baselineAlerts.length, 0);

  const refreshed = db.prepare(`SELECT * FROM permit_records WHERE id = ?`).get(permit.id);
  assert.ok(refreshed.baseline_snapshot_at);
  const anchor1 = refreshed.progress_anchor_at;

  // Successful no-change check must not reset progress clock
  applyConnectorResult(refreshed, {
    outcome: 'no_change',
    mode: 'live',
    sourceNativeStatus: 'Issued',
    officialStatus: 'issued',
    fields: { issuedDate: '2026-01-01' },
    checkedAt: new Date().toISOString(),
  });
  const afterCheck = db.prepare(`SELECT * FROM permit_records WHERE id = ?`).get(permit.id);
  assert.equal(afterCheck.progress_anchor_at, anchor1);

  // Subsequent status change → attention
  applyConnectorResult(afterCheck, {
    outcome: 'updated',
    mode: 'live',
    sourceNativeStatus: 'Closed',
    officialStatus: 'closed',
    fields: {},
    checkedAt: new Date().toISOString(),
  });
  const changeAlerts = db
    .prepare(
      `SELECT * FROM attention_events WHERE permit_record_id = ? AND kind = 'status_change' AND resolved_at IS NULL`
    )
    .all(permit.id);
  assert.ok(changeAlerts.length >= 1);
});

test('alert resolve + dedupe; schedule preview local only', async () => {
  const { upsertAttention, resolveAttentionByCondition } = await import('../db.js');
  const permit = db.prepare(`SELECT id FROM permit_records WHERE record_origin = 'import' LIMIT 1`).get();
  upsertAttention(permit.id, 'check_failed', 'temp fail', 'dedupe-test-1', 'cond-test-1');
  upsertAttention(permit.id, 'check_failed', 'temp fail again', 'dedupe-test-1', 'cond-test-1');
  const count = db
    .prepare(`SELECT COUNT(*) AS c FROM attention_events WHERE dedupe_key = 'dedupe-test-1'`)
    .get().c;
  assert.equal(count, 1);
  resolveAttentionByCondition('cond-test-1');
  const resolved = db
    .prepare(`SELECT resolved_at FROM attention_events WHERE dedupe_key = 'dedupe-test-1'`)
    .get();
  assert.ok(resolved.resolved_at);

  setSetting('stale_days', '14');
  rebuildAttention();
  const preview = getSchedulePreview();
  assert.ok(preview.digestPreview.subject.includes('not sent'));
  assert.ok(preview.digestPreview.note.includes('No email'));
});

test('date parsing and ID helpers', () => {
  assert.equal(parseWorkbookDate('4/6/26').value, '2026-04-06');
  assert.equal(parseWorkbookDate('APPLY').kind, 'text');
  const ids = extractOfficialIds('ZNA2026-04510 / BLDC-2026-013456');
  assert.ok(ids.includes('ZNA2026-04510'));
  assert.equal(isFairfaxShapedId('ALTC-2026-00970'), true);
  assert.equal(isFairfaxShapedId('BLD2026-04765'), false);
});

test('structured export excludes demo and read-backs', () => {
  // Add demo record
  const section = db
    .prepare(
      `INSERT INTO community_sections(project_code, community_name, jurisdiction_code, header_json, record_origin)
       VALUES ('FFX-DEMO','Probe','fairfax_county','[]','demo')`
    )
    .run();
  const lot = db
    .prepare(
      `INSERT INTO lot_groups(section_id, lot_label, housetype, stable_key, record_origin)
       VALUES (?, 'PROBE', 'x', 'demo-key', 'demo')`
    )
    .run(section.lastInsertRowid);
  db.prepare(
    `INSERT INTO permit_records(lot_group_id, primary_official_id, jurisdiction_code, record_origin)
     VALUES (?, 'ALTC-DEMO-1', 'fairfax_county', 'demo')`
  ).run(lot.lastInsertRowid);

  const buf = exportCoexistenceXlsx();
  assert.ok(buf.length > 500);
  const wb = XLSX.read(buf, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Permit Tracker Export']);
  assert.ok(!rows.some((r) => String(r.primary_official_id || '').includes('DEMO')));
});

test('forceFail on import record does not invent synthetic status', async () => {
  const permit = db
    .prepare(
      `SELECT * FROM permit_records WHERE primary_official_id = 'ZNA2026-04510' AND record_origin = 'import'`
    )
    .get();
  const before = permit.official_status;
  const fail = await syncPermitById(permit.id, { forceFail: true, allowSynthetic: false });
  assert.equal(fail.outcome, 'failed');
  const after = db.prepare(`SELECT official_status FROM permit_records WHERE id = ?`).get(permit.id);
  assert.equal(after.official_status, before);
});
