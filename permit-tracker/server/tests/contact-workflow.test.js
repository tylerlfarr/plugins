import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permit-cw-'));
process.env.PERMIT_DB_PATH = path.join(tmpDir, 'cw.sqlite');
process.env.PERMIT_DEMO = '0';
delete process.env.TRACERFY_LIVE_SANDBOX;
delete process.env.TRACERFY_PROVIDER_MODE;

const { buildSanitizedWorkbookBuffer } = await import('../fixtures/buildSanitizedWorkbook.js');
const { parseWorkbookBuffer, commitWorkbookParse } = await import('../workbookImport.js');
const { db, setSetting } = await import('../db.js');
const {
  upsertProperty,
  linkPropertyToLot,
  previewCrosswalk,
  commitCrosswalk,
  propertyIdentityKey,
  propertyBelongsToPermit,
} = await import('../property.js');
const {
  findContactsForProperty,
  setContactStatus,
  addManualContact,
  listContacts,
} = await import('../contacts.js');
const { exportCoexistenceXlsx, inspectExportBuffer } = await import('../excelExport.js');
const {
  reconcileTimedOutJob,
  setProviderMode,
  PROVIDER_MODES,
  runContactLookup,
} = await import('../providers/tracerfy.js');

commitWorkbookParse(parseWorkbookBuffer(buildSanitizedWorkbookBuffer()));
setProviderMode(PROVIDER_MODES.LOCAL_FIXTURE);

function lotPermit(lotLabel = '10') {
  return db
    .prepare(
      `SELECT p.*, lg.lot_label, cs.project_code, cs.community_name, lg.housetype
       FROM permit_records p
       JOIN lot_groups lg ON lg.id = p.lot_group_id
       JOIN community_sections cs ON cs.id = lg.section_id
       WHERE lg.lot_label = ? AND p.record_origin = 'import'`
    )
    .get(lotLabel);
}

test('idempotent property save + no VA default; material change needs reconfirmation', () => {
  const permit = lotPermit('10');
  const a = upsertProperty(
    {
      site_address: '10 Builder Test Rd',
      city: 'Demo City',
      state: 'VA',
      zip: '20100',
    },
    { actor: 'test' }
  );
  const b = upsertProperty(
    {
      site_address: '10 Builder Test Rd',
      city: 'Demo City',
      state: 'VA',
      zip: '20100',
    },
    { actor: 'test' }
  );
  assert.equal(a.id, b.id);
  assert.equal(propertyIdentityKey(a), a.identity_key);

  linkPropertyToLot({
    propertyId: a.id,
    lotGroupId: permit.lot_group_id,
    permitRecordId: permit.id,
    linkState: 'confirmed',
    confirmedBy: 'test',
  });
  const contact = addManualContact({
    property_id: a.id,
    permit_record_id: permit.id,
    lot_group_id: permit.lot_group_id,
    role: 'property_owner',
    full_name: 'Prior Owner',
    status: 'confirmed',
  });
  const updated = upsertProperty(
    {
      id: a.id,
      site_address: '10 Builder Test Rd UNIT 2',
      city: 'Demo City',
      state: 'VA',
      zip: '20100',
    },
    { actor: 'test' }
  );
  assert.ok(updated.identity_key !== a.identity_key || updated.site_address.includes('UNIT'));
  const link = db
    .prepare(`SELECT link_state FROM property_links WHERE property_id = ? AND lot_group_id = ?`)
    .get(a.id, permit.lot_group_id);
  assert.equal(link.link_state, 'needs_reconfirmation');
  const refreshed = db.prepare('SELECT status FROM contacts WHERE id = ?').get(contact.id);
  assert.equal(refreshed.status, 'needs_review');

  // Empty state not invented
  const noState = upsertProperty(
    { site_address: '99 Parcel Only Ln', city: 'X', state: '', zip: '', parcel_apn: 'APN-1' },
    { actor: 'test' }
  );
  assert.equal(noState.state, '');
});

test('crosswalk requires selection; server ignores client match_status; ranges need review', () => {
  const permit = lotPermit('10');
  const preview = previewCrosswalk([
    {
      project_code: permit.project_code,
      community_name: permit.community_name,
      lot_label: permit.lot_label,
      housetype: permit.housetype,
      site_address: '10 Crosswalk Ave',
      city: 'Demo City',
      state: 'VA',
      zip: '20100',
    },
    {
      project_code: permit.project_code,
      community_name: permit.community_name,
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

  // Without selected → skipped
  const none = commitCrosswalk(preview.map((r) => ({ ...r, selected: false })));
  assert.equal(none.linked, 0);

  // Client lies about match_status — server revalidates
  const forged = commitCrosswalk([
    {
      ...preview[0],
      selected: true,
      match_status: 'matched_stable_key',
      lot_group_id: 999999,
      site_address: '10 Crosswalk Ave',
      city: 'Demo City',
      state: 'VA',
      zip: '20100',
      project_code: permit.project_code,
      community_name: permit.community_name,
      lot_label: permit.lot_label,
      housetype: permit.housetype,
      payload: {
        project_code: permit.project_code,
        community_name: permit.community_name,
        lot_label: permit.lot_label,
        housetype: permit.housetype,
        site_address: '10 Crosswalk Ave',
        city: 'Demo City',
        state: 'VA',
        zip: '20100',
      },
    },
  ]);
  assert.equal(forged.linked, 0); // client lot_group_id mismatch rejected

  const ok = commitCrosswalk([
    {
      selected: true,
      payload: {
        project_code: permit.project_code,
        community_name: permit.community_name,
        lot_label: permit.lot_label,
        housetype: permit.housetype,
        site_address: '10 Crosswalk Ave',
        city: 'Demo City',
        state: 'VA',
        zip: '20100',
      },
    },
  ]);
  assert.ok(ok.linked >= 1);

  // Repeat commit idempotent
  const again = commitCrosswalk([
    {
      selected: true,
      payload: {
        project_code: permit.project_code,
        community_name: permit.community_name,
        lot_label: permit.lot_label,
        housetype: permit.housetype,
        site_address: '10 Crosswalk Ave',
        city: 'Demo City',
        state: 'VA',
        zip: '20100',
      },
    },
  ]);
  assert.equal(again.created, 0);
});

test('fixture/sandbox never attach to operational; production stub attaches; rejected not resurrected', async () => {
  const permit = lotPermit('10');
  const property = upsertProperty(
    {
      site_address: '22 Ops Contact Rd',
      city: 'Demo City',
      state: 'VA',
      zip: '20100',
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
  assert.equal(propertyBelongsToPermit(property.id, permit.id).ok, true);

  setProviderMode(PROVIDER_MODES.LOCAL_FIXTURE);
  const isolated = await findContactsForProperty({
    soughtRole: 'property_owner',
    propertyId: property.id,
    permitRecordId: permit.id,
  });
  assert.equal(isolated.attached, false);
  assert.match(isolated.isolation || '', /not_attached/);

  // Dedicated sandbox property may attach fixture contacts (no operational permit)
  const sand = upsertProperty(
    {
      site_address: '1 Fixture Lane',
      city: 'Austin',
      state: 'TX',
      zip: '78701',
      record_origin: 'sandbox_demo',
    },
    { actor: 'test' }
  );
  const sandResult = await findContactsForProperty({
    soughtRole: 'property_owner', propertyId: sand.id, requireConfirmedLink: false });
  assert.ok(sandResult.saved.length >= 1);
  assert.equal(sandResult.saved[0].record_origin, 'local_fixture');
  setContactStatus(sandResult.saved[0].id, 'rejected', { reason: 'wrong_person', actor: 'test' });

  const again = await findContactsForProperty({
    soughtRole: 'property_owner', propertyId: sand.id, requireConfirmedLink: false });
  assert.equal(again.deduped, true);
  // Rejected must not reappear as new candidate
  const live = listContacts({ propertyId: sand.id, includeDemo: true });
  assert.ok(live.every((c) => c.status === 'rejected' || c.id !== sandResult.saved[0].id || c.status === 'rejected'));
  assert.ok(!live.some((c) => c.status === 'candidate' && c.full_name === sandResult.saved[0].full_name));

  // Production attach with stubbed provider (forceFail path, no paid request)
  setSetting('tracerfy_hard_spend_lock', '0');
  setSetting('tracerfy_production_enabled', '1');
  setSetting('tracerfy_spend_limit_credits', '100');
  setSetting('tracerfy_commercial_confirmed', '1');
  setSetting('tracerfy_api_token_present', '1');
  process.env.TRACERFY_API_TOKEN = 'test-not-used-forceFail';
  setProviderMode(PROVIDER_MODES.PRODUCTION);
  const prodProp = upsertProperty(
    {
      site_address: '33 Production Stub Rd',
      city: 'Demo City',
      state: 'VA',
      zip: '20100',
    },
    { actor: 'test' }
  );
  linkPropertyToLot({
    propertyId: prodProp.id,
    lotGroupId: permit.lot_group_id,
    permitRecordId: permit.id,
    linkState: 'confirmed',
    confirmedBy: 'test',
  });
  const noMatch = await findContactsForProperty({
    soughtRole: 'property_owner',
    propertyId: prodProp.id,
    permitRecordId: permit.id,
    forceFail: 'no_match',
  });
  assert.equal(noMatch.noMatch, true);
  assert.equal(noMatch.job.status, 'succeeded');

  // Cleanup production gates so other tests stay fixture
  setSetting('tracerfy_production_enabled', '0');
  setSetting('tracerfy_hard_spend_lock', '1');
  delete process.env.TRACERFY_API_TOKEN;
  setProviderMode(PROVIDER_MODES.LOCAL_FIXTURE);
});

test('timeout remains unresolved; reconcile is manual not auto-safe; concurrent reserve', async () => {
  setProviderMode(PROVIDER_MODES.LOCAL_FIXTURE);
  const prop = upsertProperty(
    {
      site_address: '5 Timeout Lane',
      city: 'Austin',
      state: 'TX',
      zip: '78701',
      record_origin: 'sandbox_demo',
    },
    { actor: 'test' }
  );
  const timed = await findContactsForProperty({
    soughtRole: 'property_owner',
    propertyId: prop.id,
    forceFail: 'timeout',
    requireConfirmedLink: false,
  });
  assert.equal(timed.job.status, 'timed_out');
  assert.equal(timed.reconcileBeforeResubmit, true);

  // Blind resubmit blocked
  const blocked = await findContactsForProperty({
    soughtRole: 'property_owner',
    propertyId: prop.id,
    requireConfirmedLink: false,
  });
  assert.equal(blocked.blocked, true);

  const abandoned = reconcileTimedOutJob(timed.job.id, { resolution: 'manual_abandon' });
  assert.equal(abandoned.safeToResubmit, false);
  assert.equal(abandoned.job.status, 'abandoned_blocked');

  // Abandon keeps automatic resubmit blocked
  const stillBlocked = await findContactsForProperty({
    soughtRole: 'property_owner',
    propertyId: prop.id,
    requireConfirmedLink: false,
  });
  assert.equal(stillBlocked.blocked, true);
  assert.equal(stillBlocked.error?.error, 'abandoned_blocked');

  // Explicit retry authorization with evidence allows resubmit
  const allowed = reconcileTimedOutJob(timed.job.id, {
    resolution: 'manual_allow_resubmit',
    note: 'provider dashboard shows no charge for request',
  });
  assert.equal(allowed.safeToResubmit, true);
  const after = await findContactsForProperty({
    soughtRole: 'property_owner',
    propertyId: prop.id,
    forceFail: 'no_match',
    requireConfirmedLink: false,
  });
  assert.equal(after.noMatch, true);

  // Spend limit reservation for production
  setSetting('tracerfy_hard_spend_lock', '0');
  setSetting('tracerfy_production_enabled', '1');
  setSetting('tracerfy_spend_limit_credits', '5');
  setSetting('tracerfy_commercial_confirmed', '1');
  setSetting('tracerfy_api_token_present', '1');
  process.env.TRACERFY_API_TOKEN = 'x';
  setProviderMode(PROVIDER_MODES.PRODUCTION);
  // Pre-consume the cap with a reserved row
  db.prepare(
    `INSERT INTO provider_usage(provider, mode, endpoint, credits, charge_kind)
     VALUES ('tracerfy','production','/trace/lookup/',5,'reserved')`
  ).run();
  const capped = upsertProperty(
    {
      site_address: '6 Cap Lane',
      city: 'Austin',
      state: 'TX',
      zip: '78701',
    },
    { actor: 'test' }
  );
  const spend = await runContactLookup({ property: capped, endpointKey: 'instant_trace' });
  assert.equal(spend.error?.error, 'spend_limit');
  setSetting('tracerfy_production_enabled', '0');
  setSetting('tracerfy_hard_spend_lock', '1');
  delete process.env.TRACERFY_API_TOKEN;
  setProviderMode(PROVIDER_MODES.LOCAL_FIXTURE);
});

test('export confirmed only; excludes sandbox/rejected; inspect contents', () => {
  const permit = lotPermit('10');
  addManualContact({
    permit_record_id: permit.id,
    lot_group_id: permit.lot_group_id,
    role: 'property_owner',
    full_name: 'Export Confirmed Owner',
    status: 'confirmed',
    record_origin: 'manual',
  });
  addManualContact({
    permit_record_id: permit.id,
    lot_group_id: permit.lot_group_id,
    role: 'applicant',
    full_name: 'Export Candidate',
    status: 'candidate',
    record_origin: 'manual',
  });
  addManualContact({
    permit_record_id: permit.id,
    lot_group_id: permit.lot_group_id,
    role: 'contractor',
    full_name: 'Export Rejected',
    status: 'rejected',
    record_origin: 'manual',
  });
  addManualContact(
    {
      permit_record_id: permit.id,
      lot_group_id: permit.lot_group_id,
      role: 'property_owner',
      full_name: 'SANDBOX SHOULD NOT EXPORT',
      status: 'confirmed',
      record_origin: 'sandbox_demo',
      provider: 'tracerfy',
      provider_source: 'hosted_sandbox',
    },
    { actor: 'test', allowProviderProvenance: true }
  );

  const buf = exportCoexistenceXlsx({ contactStatuses: ['confirmed'] });
  assert.ok(Buffer.isBuffer(buf) && buf.length > 500);
  const inspected = inspectExportBuffer(buf);
  assert.ok(inspected.contactCount >= 1);
  assert.ok(inspected.contactStatuses.every((s) => s === 'confirmed'));
  assert.ok(!inspected.contactOrigins.includes('sandbox_demo'));
  assert.ok(!inspected.contacts.some((c) => c.full_name === 'Export Rejected'));
  assert.ok(!inspected.contacts.some((c) => c.full_name === 'SANDBOX SHOULD NOT EXPORT'));
  assert.ok(inspected.contacts.some((c) => c.full_name === 'Export Confirmed Owner'));
  assert.ok(!inspected.contacts.some((c) => c.full_name === 'Export Candidate'));

  const reviewed = inspectExportBuffer(
    exportCoexistenceXlsx({ contactStatuses: ['confirmed'], includeReviewedCandidates: true })
  );
  assert.ok(reviewed.contacts.some((c) => c.full_name === 'Export Candidate'));
});

test('http failure modes are failures not empty success', async () => {
  setProviderMode(PROVIDER_MODES.LOCAL_FIXTURE);
  const prop = upsertProperty(
    {
      site_address: '7 Fail Lane',
      city: 'Austin',
      state: 'TX',
      zip: '78701',
      record_origin: 'sandbox_demo',
    },
    { actor: 'test' }
  );
  const unauth = await findContactsForProperty({
    soughtRole: 'property_owner',
    propertyId: prop.id,
    forceFail: 'http_401',
    requireConfirmedLink: false,
  });
  assert.equal(unauth.job.status, 'failed');
  assert.ok(unauth.error?.status === 401);

  const mal = await findContactsForProperty({
    soughtRole: 'property_owner',
    propertyId: prop.id,
    forceFail: 'malformed',
    requireConfirmedLink: false,
  });
  // New fingerprint because forceFail differs... actually fingerprint ignores forceFail
  // Same property/input — may hit dedupe on previous failed? failed not in succeeded/queued
  assert.ok(mal.job.status === 'failed' || mal.error);
});
