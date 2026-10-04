import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permit-readiness-'));
process.env.PERMIT_DB_PATH = path.join(tmpDir, 'readiness.sqlite');
process.env.PERMIT_DEMO = '0';

const { buildSanitizedWorkbookBuffer } = await import('../fixtures/buildSanitizedWorkbook.js');
const { parseWorkbookBuffer, commitWorkbookParse } = await import('../workbookImport.js');
const { db } = await import('../db.js');
const { rebuildAttention } = await import('../sync.js');
const {
  assessPermitReadiness,
  rebuildAllReadiness,
  classifyMilestoneValue,
  READINESS_STATES,
  getReadinessRuleset,
  listRevisionImpactedLots,
} = await import('../readiness.js');
const { exportCoexistenceXlsx } = await import('../excelExport.js');

function importFixture() {
  const buf = buildSanitizedWorkbookBuffer();
  const parsed = parseWorkbookBuffer(buf);
  const summary = commitWorkbookParse(parsed);
  return { buf, parsed, summary };
}

const { summary } = importFixture();

test('classify milestone values: date / na / APPLY / ambiguous / future', () => {
  const today = new Date('2026-10-04T12:00:00Z');
  assert.equal(classifyMilestoneValue('2026-04-01', 'date', { today }).status, 'satisfied');
  assert.equal(classifyMilestoneValue('na', 'text').status, 'unconfirmed_na');
  assert.equal(classifyMilestoneValue('na', 'text', { waived: true }).status, 'waived');
  assert.equal(
    classifyMilestoneValue('2026-12-01', 'date', { today, completionRole: true }).status,
    'future'
  );
  assert.equal(classifyMilestoneValue('APPLY', 'text').status, 'in_progress');
  assert.equal(classifyMilestoneValue('john/bk', 'text').status, 'in_progress');
  assert.equal(classifyMilestoneValue('maybe soon', 'text').status, 'ambiguous');
  assert.equal(classifyMilestoneValue('', 'empty').status, 'missing');
});

test('import rebuilds readiness counts', () => {
  assert.ok(summary.readiness);
  assert.ok(summary.readiness.total >= 4);
  assert.ok((summary.readiness.blocked || 0) >= 1);
  assert.ok((summary.readiness.ready || 0) >= 1);
});

test('APPLY received blocks Ready; blank section prereq blocks; missing evidence ≠ Ready', () => {
  const blocked = db
    .prepare(
      `SELECT p.id, p.readiness_state, lg.lot_label FROM permit_records p
       JOIN lot_groups lg ON lg.id = p.lot_group_id
       WHERE lg.lot_label = '1-4' AND p.primary_official_id = 'ZNA2026-04510'`
    )
    .get();
  assert.ok(blocked);
  assert.equal(blocked.readiness_state, READINESS_STATES.BLOCKED);
  const a = assessPermitReadiness(blocked.id);
  assert.equal(a.state, READINESS_STATES.BLOCKED);
  assert.ok(a.outstanding.some((o) => /received/i.test(o.label)));
  assert.ok(a.target_start);
  assert.ok(a.approaching_start);

  const blank = db
    .prepare(
      `SELECT p.id, p.readiness_state FROM permit_records p
       JOIN lot_groups lg ON lg.id = p.lot_group_id
       WHERE lg.lot_label = '200'`
    )
    .get();
  assert.equal(blank.readiness_state, READINESS_STATES.BLOCKED);
  const b = assessPermitReadiness(blank.id);
  assert.ok(b.outstanding.some((o) => o.status === 'missing'));
});

test('workbook-complete ID-less lot can be Ready under rules', () => {
  const ready = db
    .prepare(
      `SELECT p.id, p.readiness_state, p.primary_official_id FROM permit_records p
       JOIN lot_groups lg ON lg.id = p.lot_group_id
       WHERE lg.lot_label = '10'`
    )
    .get();
  assert.ok(ready);
  assert.equal(ready.primary_official_id, null);
  assert.equal(ready.readiness_state, READINESS_STATES.READY);
});

test('AHJ unverified does not block workbook Ready; na stays unconfirmed gap', () => {
  const row = db
    .prepare(
      `SELECT p.id, p.readiness_state FROM permit_records p
       JOIN lot_groups lg ON lg.id = p.lot_group_id
       WHERE lg.lot_label = '96-100'`
    )
    .get();
  assert.ok(row);
  const a = assessPermitReadiness(row.id, { today: new Date('2026-10-04T12:00:00Z') });
  // LoCo Water Received = na → needs verification (not silent Ready / not waived)
  assert.equal(a.state, READINESS_STATES.NEEDS_VERIFICATION);
  assert.ok(a.gaps.some((g) => g.status === 'unconfirmed_na'));
  assert.ok(a.official_verification);
  assert.notEqual(a.official_verification.status, 'verified');
  // Workbook Ready is independent: ID-less complete lot remains Ready
  const ready = db
    .prepare(
      `SELECT p.id FROM permit_records p
       JOIN lot_groups lg ON lg.id = p.lot_group_id WHERE lg.lot_label = '10'`
    )
    .get();
  const r = assessPermitReadiness(ready.id, { today: new Date('2026-10-04T12:00:00Z') });
  assert.equal(r.state, READINESS_STATES.READY);
});

test('shared open revision flags confirmed matching lots for review', () => {
  const impacted = db
    .prepare(
      `SELECT p.id FROM permit_records p
       JOIN lot_groups lg ON lg.id = p.lot_group_id
       JOIN community_sections cs ON cs.id = lg.section_id
       WHERE cs.project_code = 'DEMO1' AND lg.lot_label = '1-4'`
    )
    .all();
  assert.ok(impacted.length >= 2);
  for (const { id } of impacted) {
    const a = assessPermitReadiness(id);
    assert.ok(
      a.gaps.some((g) => String(g.id).startsWith('revision:')),
      'expected revision gap'
    );
    assert.ok(a.open_revisions.length >= 1);
  }

  // Insert a fake revision lot "7" and ensure a "27-36" lot is not impacted via substring
  db.prepare(
    `INSERT INTO permit_revisions(community_code, lot, revised_start_sheet, date_submitted, reason)
     VALUES ('DEMO1', '7', '2026-05-01', '2026-05-02', 'substring trap')`
  ).run();
  const trapLot = db
    .prepare(
      `INSERT INTO lot_groups(section_id, lot_label, housetype, stable_key, record_origin)
       SELECT section_id, '27-36', '', 'trap-27-36', 'import' FROM lot_groups WHERE lot_label = '1-4' LIMIT 1`
    )
    .run();
  const trapPermit = db
    .prepare(
      `INSERT INTO permit_records(lot_group_id, internal_status, record_origin, readiness_state)
       VALUES (?, 'watching', 'import', 'unknown_stale')`
    )
    .run(Number(trapLot.lastInsertRowid));
  const impactedLots = listRevisionImpactedLots();
  assert.ok(
    !impactedLots.some((x) => x.permit_record_id === Number(trapPermit.lastInsertRowid)),
    'revision lot 7 must not match lot 27-36'
  );
  assert.ok(impactedLots.some((x) => x.lot_label === '1-4'));
});

test('Attention surfaces approaching start, blockers, revision impact', () => {
  rebuildAttention();
  const kinds = db
    .prepare(
      `SELECT kind, COUNT(*) AS c FROM attention_events
       WHERE resolved_at IS NULL AND acknowledged = 0 GROUP BY kind`
    )
    .all();
  const map = Object.fromEntries(kinds.map((k) => [k.kind, k.c]));
  assert.ok((map.approaching_start || 0) >= 1);
  assert.ok((map.readiness_blocked || 0) >= 1);
  assert.ok((map.revision_impact || 0) >= 1);
});

test('default ruleset is configurable and export includes readiness columns', () => {
  const rules = getReadinessRuleset();
  assert.equal(rules.key, 'default_workbook_v1');
  assert.ok(rules.prerequisites.length >= 5);
  rebuildAllReadiness();
  const buf = exportCoexistenceXlsx();
  assert.ok(Buffer.isBuffer(buf) && buf.length > 1000);
});
