import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gospel-'));
process.env.PERMIT_DB_PATH = path.join(tmpDir, 'gospel.sqlite');

const {
  parseGospelBuffer,
  commitGospelParse,
  parseWorkbookDate,
  extractOfficialIds,
  isFairfaxShapedId,
} = await import('../gospelImport.js');
const { db } = await import('../db.js');
const { applyConnectorResult, syncPermitById } = await import('../sync.js');
const { exportCoexistenceXlsx } = await import('../excelExport.js');

const GOSPEL = '/cursor/stores/self/internal/Permit_Tracker_9.1.2026.xlsx';

test('section-aware gospel import detects ~24 headers and extracts IDs', () => {
  assert.ok(fs.existsSync(GOSPEL), 'gospel workbook must exist');
  const buf = fs.readFileSync(GOSPEL);
  const parsed = parseGospelBuffer(buf);
  assert.equal(parsed.permitTracker.sections.length, 24);
  assert.ok(parsed.permitTracker.rows.length > 50);
  assert.ok(parsed.mstIds.length > 10);
  const withIds = parsed.permitTracker.rows.filter((r) => r.official_ids.length);
  assert.ok(withIds.length >= 5);
  const summary = commitGospelParse(parsed);
  assert.ok(summary.sections >= 20);
  assert.ok(summary.permits_created > 40);
  assert.ok(summary.official_ids >= 10);
});

test('duplicate import updates without wiping internal milestones', () => {
  const buf = fs.readFileSync(GOSPEL);
  const parsed = parseGospelBuffer(buf);
  commitGospelParse(parsed);
  const permit = db
    .prepare(
      `SELECT p.id FROM permit_records p
       JOIN lot_groups lg ON lg.id = p.lot_group_id
       WHERE lg.notes_raw LIKE '%ZNA2026-04510%' LIMIT 1`
    )
    .get();
  assert.ok(permit);
  db.prepare(
    `INSERT OR REPLACE INTO internal_milestones(permit_record_id, key, label, value, value_kind)
     VALUES (?, 'user_keep', 'User Keep', 'preserve-me', 'text')`
  ).run(permit.id);
  // second import
  commitGospelParse(parsed);
  const kept = db
    .prepare(`SELECT value FROM internal_milestones WHERE permit_record_id = ? AND key = 'user_keep'`)
    .get(permit.id);
  assert.equal(kept.value, 'preserve-me');
});

test('date parsing excel-ish and text status', () => {
  assert.equal(parseWorkbookDate('4/6/26').kind, 'date');
  assert.equal(parseWorkbookDate('4/6/26').value, '2026-04-06');
  assert.equal(parseWorkbookDate('APPLY').kind, 'text');
  assert.equal(parseWorkbookDate('not-a-date-xx').kind, 'text');
});

test('ID extraction and Fairfax shape', () => {
  const ids = extractOfficialIds('ZNA2026-04510 / BLD2026-04765 and BLDC-2026-013456');
  assert.ok(ids.includes('ZNA2026-04510'));
  assert.ok(ids.includes('BLD2026-04765'));
  assert.ok(ids.includes('BLDC-2026-013456'));
  assert.equal(isFairfaxShapedId('BLDC-2026-013456'), true);
  assert.equal(isFairfaxShapedId('BLD2026-04765'), false);
  assert.equal(isFairfaxShapedId('ALTC-2026-00970'), true);
});

test('connector does not overwrite internal milestones; failed check safe', async () => {
  const permit = db.prepare(`SELECT * FROM permit_records WHERE primary_official_id = 'ALTC-2026-00970'`).get();
  if (!permit) {
    // ensure probe exists
    const section = db
      .prepare(
        `INSERT INTO community_sections(project_code, community_name, jurisdiction_code, header_json)
         VALUES ('FFX-DEMO', 'Fairfax Live Probe', 'fairfax_county', '[]')`
      )
      .run();
    const lot = db
      .prepare(
        `INSERT INTO lot_groups(section_id, lot_label, housetype, notes_raw) VALUES (?, 'PROBE', 'Live connector probe', 'ALTC-2026-00970')`
      )
      .run(section.lastInsertRowid);
    const pr = db
      .prepare(
        `INSERT INTO permit_records(lot_group_id, primary_official_id, jurisdiction_code) VALUES (?, 'ALTC-2026-00970', 'fairfax_county')`
      )
      .run(lot.lastInsertRowid);
    db.prepare(
      `INSERT INTO internal_milestones(permit_record_id, key, label, value, value_kind)
       VALUES (?, 'internal_note_probe', 'Internal probe note', 'Must survive Fairfax sync', 'text')`
    ).run(pr.lastInsertRowid);
  }
  const p = db.prepare(`SELECT * FROM permit_records WHERE primary_official_id = 'ALTC-2026-00970'`).get();
  applyConnectorResult(p, {
    outcome: 'updated',
    mode: 'live',
    sourceNativeStatus: 'Issued',
    officialStatus: 'issued',
    fields: { issuedDate: '2026-09-28', sourceUrl: 'https://example.test/ffx' },
    checkedAt: new Date().toISOString(),
  });
  const mile = db
    .prepare(
      `SELECT value FROM internal_milestones WHERE permit_record_id = ? AND key = 'internal_note_probe'`
    )
    .get(p.id);
  assert.equal(mile.value, 'Must survive Fairfax sync');

  const before = db.prepare('SELECT official_status FROM permit_records WHERE id = ?').get(p.id);
  const fail = await syncPermitById(p.id, { forceFail: true });
  assert.equal(fail.outcome, 'failed');
  const after = db.prepare('SELECT official_status, last_check_outcome FROM permit_records WHERE id = ?').get(p.id);
  assert.equal(after.official_status, before.official_status);
  assert.equal(after.last_check_outcome, 'failed');
});

test('coexistence export builds workbook', () => {
  const buf = exportCoexistenceXlsx();
  assert.ok(Buffer.isBuffer(buf) || buf instanceof Uint8Array);
  assert.ok(buf.length > 1000);
});
