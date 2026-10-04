import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permit-test-'));
process.env.PERMIT_DB_PATH = path.join(tmpDir, 'test.sqlite');

const { parseWorkbook, suggestMapping, validateMappedRows, commitImport, buildSampleWorkbook } =
  await import('../excel.js');
const { db } = await import('../db.js');
const { seed } = await import('../seed.js');

test('sample workbook maps and preserves notes on duplicate import', () => {
  seed();
  const buf = buildSampleWorkbook();
  const parsed = parseWorkbook(Buffer.from(buf));
  const mapping = suggestMapping(parsed.headers);
  assert.equal(mapping.community, 'Community');
  assert.equal(mapping.official_id, 'Permit ID');
  const preview = validateMappedRows(parsed.rows, mapping);
  assert.ok(preview.every((p) => p.ok));

  const first = commitImport(preview);
  assert.ok(first.created + first.updated >= 1);

  // mutate note then re-import blank notes should not wipe (sample has notes filled — change DB note first)
  const permit = db
    .prepare(`SELECT * FROM permits WHERE official_id = 'HOU-DEMO-55001'`)
    .get();
  assert.ok(permit);
  db.prepare(`UPDATE permits SET notes = ? WHERE id = ?`).run(
    'User-entered note must survive blank cells',
    permit.id
  );

  // Build a second import with blank notes for that ID
  const rows = parsed.rows.map((r) => ({ ...r }));
  const noteHeader = mapping.notes;
  for (const r of rows) {
    if (String(r[mapping.official_id]) === 'HOU-DEMO-55001') r[noteHeader] = '';
  }
  const preview2 = validateMappedRows(rows, mapping);
  const second = commitImport(preview2);
  assert.ok(second.updated >= 1);
  const after = db.prepare(`SELECT notes FROM permits WHERE id = ?`).get(permit.id);
  assert.equal(after.notes, 'User-entered note must survive blank cells');
});

test('date parsing accepts m/d/yyyy and rejects garbage', () => {
  const mapping = {
    community: 'Community',
    project: 'Project',
    lot_number: 'Lot',
    jurisdiction_code: 'Jurisdiction',
    submitted_date: 'Submitted',
  };
  const rows = [
    {
      Community: 'X',
      Project: 'Y',
      Lot: '1',
      Jurisdiction: 'fairfax_county',
      Submitted: '3/15/2026',
    },
    {
      Community: 'X',
      Project: 'Y',
      Lot: '2',
      Jurisdiction: 'fairfax_county',
      Submitted: 'not-a-date',
    },
  ];
  const preview = validateMappedRows(rows, mapping);
  assert.equal(preview[0].ok, true);
  assert.equal(preview[0].mapped.submitted_date, '2026-03-15');
  assert.equal(preview[1].ok, false);
});

test('ambiguous official id without jurisdiction fails validation', () => {
  const mapping = {
    community: 'Community',
    project: 'Project',
    lot_number: 'Lot',
    jurisdiction_code: 'Jurisdiction',
    official_id: 'Permit ID',
  };
  const preview = validateMappedRows(
    [{ Community: 'A', Project: 'B', Lot: '1', Jurisdiction: '', 'Permit ID': 'X-1' }],
    mapping
  );
  assert.equal(preview[0].ok, false);
});
