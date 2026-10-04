import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permit-sync-'));
process.env.PERMIT_DB_PATH = path.join(tmpDir, 'sync.sqlite');

const { db } = await import('../db.js');
const { seed } = await import('../seed.js');
const { applyConnectorResult } = await import('../sync.js');
const { syncPermitById } = await import('../sync.js');

test('connector does not overwrite notes or construction start', () => {
  seed();
  const permit = db.prepare(`SELECT * FROM permits WHERE official_id = 'HOU-DEMO-55001'`).get();
  db.prepare(`UPDATE permits SET notes = ?, construction_start_date = ? WHERE id = ?`).run(
    'Keep me',
    '2026-05-01',
    permit.id
  );
  const fresh = db.prepare('SELECT * FROM permits WHERE id = ?').get(permit.id);
  applyConnectorResult(fresh, {
    outcome: 'updated',
    mode: 'synthetic',
    sourceNativeStatus: 'Sold / Issued',
    officialStatus: 'issued',
    fields: {
      issuedDate: '2026-04-05',
      sourceUrl: 'https://example.test',
    },
    checkedAt: new Date().toISOString(),
  });
  const after = db.prepare('SELECT * FROM permits WHERE id = ?').get(permit.id);
  assert.equal(after.notes, 'Keep me');
  assert.equal(after.construction_start_date, '2026-05-01');
  assert.equal(after.source_url, 'https://example.test');
});

test('failed source check records outcome without inventing dates', async () => {
  seed();
  const permit = db.prepare(`SELECT * FROM permits WHERE official_id = 'HOU-DEMO-55002'`).get();
  const beforeIssued = permit.issued_date;
  const result = await syncPermitById(permit.id, { forceFail: true });
  assert.equal(result.outcome, 'failed');
  const after = db.prepare('SELECT * FROM permits WHERE id = ?').get(permit.id);
  assert.equal(after.last_check_outcome, 'failed');
  assert.equal(after.issued_date, beforeIssued);
});

test('live Fairfax check updates public record when reachable', async () => {
  seed();
  const permit = db.prepare(`SELECT * FROM permits WHERE official_id = 'ALTC-2026-00970'`).get();
  const result = await syncPermitById(permit.id);
  assert.ok(['updated', 'no_change', 'unavailable', 'failed', 'not_found'].includes(result.outcome));
  if (result.outcome === 'updated' || result.outcome === 'no_change') {
    const after = db.prepare('SELECT * FROM permits WHERE id = ?').get(permit.id);
    assert.ok(after.last_successful_check_at);
    assert.ok(after.source_native_status || after.official_status);
    assert.match(after.notes, /Internal note must survive sync/);
  }
});
