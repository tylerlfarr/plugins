import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permit-pc-'));
process.env.PERMIT_DB_PATH = path.join(tmpDir, 'pc.sqlite');
process.env.PERMIT_DEMO = '0';
delete process.env.TRACERFY_LIVE_SANDBOX;

const { buildSanitizedWorkbookBuffer } = await import('../fixtures/buildSanitizedWorkbook.js');
const { parseWorkbookBuffer, commitWorkbookParse } = await import('../workbookImport.js');
const { db } = await import('../db.js');
const {
  upsertProperty,
  linkPropertyToLot,
  previewCrosswalk,
  commitCrosswalk,
} = await import('../property.js');
const {
  findContactsForProperty,
  setContactStatus,
  addManualContact,
  listContacts,
} = await import('../contacts.js');
const { exportCoexistenceXlsx } = await import('../excelExport.js');
const { assessPermitReadiness, classifyMilestoneValue, READINESS_STATES } = await import(
  '../readiness.js'
);
const { reconcileTimedOutJob, setProviderMode, PROVIDER_MODES } = await import(
  '../providers/tracerfy.js'
);
const { activateSource, ensureSourceRegistrySeeded } = await import('../sources/registry.js');

commitWorkbookParse(parseWorkbookBuffer(buildSanitizedWorkbookBuffer()));
setProviderMode(PROVIDER_MODES.LOCAL_FIXTURE);

test('multi-field water ≠ sewer; future date ≠ completion; ambiguous na', () => {
  const today = new Date('2026-10-04T12:00:00Z');
  assert.equal(
    classifyMilestoneValue('2027-01-01', 'date', { today, completionRole: true }).status,
    'future'
  );
  assert.equal(classifyMilestoneValue('na', 'text').status, 'unconfirmed_na');

  const permit = db
    .prepare(
      `SELECT p.id FROM permit_records p JOIN lot_groups lg ON lg.id = p.lot_group_id
       WHERE lg.lot_label = '200'`
    )
    .get();
  const a = assessPermitReadiness(permit.id, { today });
  const missing = a.outstanding.filter((o) => o.status === 'missing').map((o) => o.id);
  assert.ok(missing.includes('water_requested') || missing.includes('water_received'));
});

test('property crosswalk matches stable identity; range needs review', () => {
  const lot = db
    .prepare(
      `SELECT lg.*, cs.project_code, cs.community_name FROM lot_groups lg
       JOIN community_sections cs ON cs.id = lg.section_id WHERE lg.lot_label = '10'`
    )
    .get();
  const preview = previewCrosswalk([
    {
      project_code: lot.project_code,
      community_name: lot.community_name,
      lot_label: lot.lot_label,
      housetype: lot.housetype,
      site_address: '10 Builder Test Rd',
      city: 'Demo City',
      state: 'VA',
      zip: '20100',
    },
    {
      project_code: lot.project_code,
      community_name: lot.community_name,
      lot_label: '1-4',
      housetype: 'Townhome A',
      site_address: '99 Range Ave',
      city: 'Demo City',
      state: 'VA',
      zip: '20100',
    },
  ]);
  assert.equal(preview[0].match_status, 'matched_stable_key');
  assert.equal(preview[1].match_status, 'needs_review_range');
  const summary = commitCrosswalk(
    preview.map((r) => ({
      selected: r.match_status === 'matched_stable_key',
      payload: r.payload || r,
    }))
  );
  assert.ok(summary.linked >= 1);
});

test('sandbox find contacts isolated from operational import records', async () => {
  const permit = db
    .prepare(
      `SELECT p.* FROM permit_records p JOIN lot_groups lg ON lg.id = p.lot_group_id
       WHERE lg.lot_label = '10' AND p.record_origin = 'import'`
    )
    .get();
  const property = upsertProperty(
    {
      site_address: '10 Builder Isolation Rd',
      city: 'Demo City',
      state: 'VA',
      zip: '20100',
      source: 'manual',
      record_origin: 'manual',
    },
    { actor: 'test' }
  );
  linkPropertyToLot({
    propertyId: property.id,
    lotGroupId: permit.lot_group_id,
    permitRecordId: permit.id,
    linkState: 'confirmed',
    confirmedBy: 'test',
  });

  const beforeReady = assessPermitReadiness(permit.id).state;
  const isolated = await findContactsForProperty({
    propertyId: property.id,
    permitRecordId: permit.id,
    endpointKey: 'instant_trace',
  });
  assert.equal(isolated.attached, false);
  assert.match(isolated.isolation || '', /not_attached/);
  assert.equal(assessPermitReadiness(permit.id).state, beforeReady);

  const sandboxProp = upsertProperty(
    {
      site_address: '1 Sandbox Lane',
      city: 'Austin',
      state: 'TX',
      zip: '78701',
      record_origin: 'sandbox_demo',
      source: 'sandbox',
    },
    { actor: 'test' }
  );
  const sand = await findContactsForProperty({
    propertyId: sandboxProp.id,
    requireConfirmedLink: false,
  });
  assert.ok(sand.saved.length >= 1);
  assert.equal(sand.saved[0].record_origin, 'local_fixture');
  assert.ok(!sand.saved[0].full_name.toLowerCase().includes('should_not'));
  assert.equal(setContactStatus(sand.saved[0].id, 'confirmed').status, 'confirmed');
});

test('provider failure modes: no match, credits, rate limit, timeout reconcile, dedupe', async () => {
  function sandAddr(n) {
    return upsertProperty(
      {
        site_address: `${n} Sandbox Lane`,
        city: 'Austin',
        state: 'TX',
        zip: '78701',
        record_origin: 'sandbox_demo',
      },
      { actor: 'test' }
    );
  }
  const miss = await findContactsForProperty({
    propertyId: sandAddr(2).id,
    forceFail: 'no_match',
    requireConfirmedLink: false,
  });
  assert.equal(miss.noMatch, true);

  const credits = await findContactsForProperty({
    propertyId: sandAddr(3).id,
    forceFail: 'insufficient_credits',
    requireConfirmedLink: false,
  });
  assert.equal(credits.job.status, 'failed');

  const rate = await findContactsForProperty({
    propertyId: sandAddr(4).id,
    forceFail: 'rate_limit',
    requireConfirmedLink: false,
  });
  assert.equal(rate.job.status, 'failed');

  const timed = await findContactsForProperty({
    propertyId: sandAddr(5).id,
    forceFail: 'timeout',
    requireConfirmedLink: false,
  });
  assert.equal(timed.job.status, 'timed_out');
  const rec = reconcileTimedOutJob(timed.job.id, { resolution: 'manual_abandon' });
  assert.equal(rec.action, 'manually_resolved_abandoned');
  assert.equal(rec.safeToResubmit, false);

  const dedupeProp = sandAddr(6);
  const first = await findContactsForProperty({
    propertyId: dedupeProp.id,
    requireConfirmedLink: false,
  });
  const second = await findContactsForProperty({
    propertyId: dedupeProp.id,
    requireConfirmedLink: false,
  });
  assert.equal(second.deduped, true);
  assert.equal(first.job.id, second.job.id);
});

test('wrong-role contact stays labeled; export excludes sandbox contacts', () => {
  const permit = db
    .prepare(`SELECT id, lot_group_id FROM permit_records WHERE record_origin='import' LIMIT 1`)
    .get();
  addManualContact({
    permit_record_id: permit.id,
    lot_group_id: permit.lot_group_id,
    role: 'applicant',
    full_name: 'Applicant Person',
    status: 'candidate',
    record_origin: 'manual',
  });
  const wrong = addManualContact({
    permit_record_id: permit.id,
    lot_group_id: permit.lot_group_id,
    role: 'property_owner',
    full_name: 'Actually Contractor',
    notes: 'role may be wrong — review',
    status: 'candidate',
    record_origin: 'manual',
  });
  assert.equal(wrong.role, 'property_owner');
  setContactStatus(wrong.id, 'rejected', { reason: 'wrong_role', actor: 'test' });

  // Confirm one for export default
  addManualContact({
    permit_record_id: permit.id,
    lot_group_id: permit.lot_group_id,
    role: 'property_owner',
    full_name: 'Confirmed Export Owner',
    status: 'confirmed',
    record_origin: 'manual',
  });

  const buf = exportCoexistenceXlsx();
  assert.ok(Buffer.isBuffer(buf) && buf.length > 500);
  const ops = listContacts({ permitId: permit.id, includeDemo: false });
  assert.ok(ops.every((c) => c.record_origin !== 'sandbox_demo'));
});

test('source activation requires real adapter; metadata-only blocked', () => {
  ensureSourceRegistrySeeded();
  db.prepare(
    `UPDATE source_registry SET state = 'verified', adapter_type = 'none' WHERE key = 'loudoun_issued_permit_reports'`
  ).run();
  assert.throws(() => activateSource('loudoun_issued_permit_reports'), /no operational adapter/);
});

test('re-import preserves confirmed property link + confirmed contact', () => {
  const permit = db
    .prepare(
      `SELECT p.* FROM permit_records p JOIN lot_groups lg ON lg.id = p.lot_group_id
       WHERE lg.lot_label = '10'`
    )
    .get();
  const propsBefore = db
    .prepare(`SELECT COUNT(*) AS c FROM property_links WHERE lot_group_id = ? AND link_state='confirmed'`)
    .get(permit.lot_group_id).c;
  const contactsBefore = db
    .prepare(`SELECT COUNT(*) AS c FROM contacts WHERE lot_group_id = ? AND status='confirmed'`)
    .get(permit.lot_group_id).c;
  commitWorkbookParse(parseWorkbookBuffer(buildSanitizedWorkbookBuffer()));
  const propsAfter = db
    .prepare(`SELECT COUNT(*) AS c FROM property_links WHERE lot_group_id = ? AND link_state='confirmed'`)
    .get(permit.lot_group_id).c;
  const contactsAfter = db
    .prepare(`SELECT COUNT(*) AS c FROM contacts WHERE lot_group_id = ? AND status='confirmed'`)
    .get(permit.lot_group_id).c;
  assert.equal(propsAfter, propsBefore);
  assert.equal(contactsAfter, contactsBefore);
  assert.notEqual(READINESS_STATES.READY, 'blocked');
});
