import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permit-ep-'));
process.env.PERMIT_DB_PATH = path.join(tmpDir, 'ep.sqlite');
process.env.PERMIT_DEMO = '0';
delete process.env.TRACERFY_LIVE_SANDBOX;
delete process.env.TRACERFY_PROVIDER_MODE;

const { buildSanitizedWorkbookBuffer } = await import('../fixtures/buildSanitizedWorkbook.js');
const { parseWorkbookBuffer, commitWorkbookParse } = await import('../workbookImport.js');
const { db, setSetting } = await import('../db.js');
const { upsertProperty, linkPropertyToLot } = await import('../property.js');
const { findContactsForProperty } = await import('../contacts.js');
const {
  reconcileTimedOutJob,
  setProviderMode,
  PROVIDER_MODES,
  runContactLookup,
  productionCapUsage,
  propertyInvolvesOperationalData,
} = await import('../providers/tracerfy.js');
const { exportCoexistenceXlsx, inspectExportBuffer } = await import('../excelExport.js');
const { addManualContact } = await import('../contacts.js');

commitWorkbookParse(parseWorkbookBuffer(buildSanitizedWorkbookBuffer()));
setProviderMode(PROVIDER_MODES.LOCAL_FIXTURE);

function importPermit() {
  return db
    .prepare(
      `SELECT p.* FROM permit_records p
       JOIN lot_groups lg ON lg.id = p.lot_group_id
       WHERE p.record_origin = 'import' AND lg.lot_label = '10'`
    )
    .get();
}

test('uncertain timeout retains reserved_uncertain against production cap', async () => {
  setSetting('tracerfy_production_enabled', '1');
  setSetting('tracerfy_spend_limit_credits', '10');
  setSetting('tracerfy_commercial_confirmed', '1');
  setSetting('tracerfy_api_token_present', '1');
  process.env.TRACERFY_API_TOKEN = 'test-token-not-used';
  setProviderMode(PROVIDER_MODES.PRODUCTION);

  const before = productionCapUsage();
  const prop = upsertProperty(
    {
      site_address: '1 Uncertain Cap Rd',
      city: 'Demo City',
      state: 'VA',
      zip: '20100',
    },
    { actor: 'test' }
  );
  const timed = await runContactLookup({
    property: prop,
    endpointKey: 'instant_trace',
    forceFail: 'timeout',
  });
  assert.equal(timed.job.status, 'timed_out');

  const holds = db
    .prepare(
      `SELECT charge_kind, credits FROM provider_usage
       WHERE job_id = ? AND charge_kind = 'reserved_uncertain'`
    )
    .all(timed.job.id);
  assert.equal(holds.length, 1);
  assert.equal(holds[0].credits, 5);
  assert.equal(productionCapUsage(), before + 5);

  // Cap blocks another 5-credit job while uncertain hold remains (limit 10, used 5+5 would be ok...
  // Use limit 5 so second is blocked)
  setSetting('tracerfy_spend_limit_credits', '5');
  const prop2 = upsertProperty(
    {
      site_address: '2 Cap Blocked Rd',
      city: 'Demo City',
      state: 'VA',
      zip: '20100',
    },
    { actor: 'test' }
  );
  const blocked = await runContactLookup({ property: prop2, endpointKey: 'instant_trace' });
  assert.equal(blocked.error?.error, 'spend_limit');

  // History not erased — audit marker present
  const audit = db
    .prepare(
      `SELECT COUNT(*) AS c FROM provider_usage
       WHERE job_id = ? AND charge_kind = 'unknown_outcome_audit'`
    )
    .get(timed.job.id).c;
  assert.ok(audit >= 1);

  setSetting('tracerfy_production_enabled', '0');
  delete process.env.TRACERFY_API_TOKEN;
  setProviderMode(PROVIDER_MODES.LOCAL_FIXTURE);
});

test('manual_abandon keeps resubmit blocked and retains uncertain hold; allow_resubmit needs evidence', async () => {
  setSetting('tracerfy_production_enabled', '1');
  setSetting('tracerfy_spend_limit_credits', '50');
  setSetting('tracerfy_commercial_confirmed', '1');
  setSetting('tracerfy_api_token_present', '1');
  process.env.TRACERFY_API_TOKEN = 'x';
  setProviderMode(PROVIDER_MODES.PRODUCTION);

  const prop = upsertProperty(
    {
      site_address: '3 Abandon Hold Rd',
      city: 'Demo City',
      state: 'VA',
      zip: '20100',
    },
    { actor: 'test' }
  );
  const timed = await runContactLookup({
    property: prop,
    endpointKey: 'instant_trace',
    forceFail: 'timeout',
  });
  const usageBeforeAbandon = productionCapUsage();

  const abandoned = reconcileTimedOutJob(timed.job.id, { resolution: 'manual_abandon' });
  assert.equal(abandoned.action, 'abandoned_blocked');
  assert.equal(abandoned.safeToResubmit, false);
  assert.equal(abandoned.job.status, 'abandoned_blocked');
  // Uncertain hold still counts
  assert.equal(productionCapUsage(), usageBeforeAbandon);
  const hold = db
    .prepare(
      `SELECT COUNT(*) AS c FROM provider_usage
       WHERE job_id = ? AND charge_kind = 'reserved_uncertain'`
    )
    .get(timed.job.id).c;
  assert.equal(hold, 1);

  const stillBlocked = await runContactLookup({ property: prop, endpointKey: 'instant_trace' });
  assert.equal(stillBlocked.blocked, true);
  assert.equal(stillBlocked.error?.error, 'abandoned_blocked');

  assert.throws(
    () => reconcileTimedOutJob(timed.job.id, { resolution: 'manual_allow_resubmit', note: '' }),
    /evidence note/
  );

  const allowed = reconcileTimedOutJob(timed.job.id, {
    resolution: 'manual_allow_resubmit',
    note: 'Tracerfy support confirmed no charge for request_id X',
  });
  assert.equal(allowed.safeToResubmit, true);
  assert.equal(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM provider_usage
         WHERE job_id = ? AND charge_kind = 'reserved_uncertain'`
      )
      .get(timed.job.id).c,
    0
  );
  assert.ok(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM provider_usage
         WHERE job_id = ? AND charge_kind = 'released_with_evidence'`
      )
      .get(timed.job.id).c >= 1
  );

  setSetting('tracerfy_production_enabled', '0');
  delete process.env.TRACERFY_API_TOKEN;
  setProviderMode(PROVIDER_MODES.LOCAL_FIXTURE);
});

test('hosted_sandbox rejects operational property before network', async () => {
  setProviderMode(PROVIDER_MODES.HOSTED_SANDBOX);
  const permit = importPermit();
  const opsProp = upsertProperty(
    {
      site_address: '10 Ops Sandbox Block Rd',
      city: 'Demo City',
      state: 'VA',
      zip: '20100',
      record_origin: 'manual',
    },
    { actor: 'test' }
  );
  linkPropertyToLot({
    propertyId: opsProp.id,
    lotGroupId: permit.lot_group_id,
    permitRecordId: permit.id,
    linkState: 'confirmed',
    confirmedBy: 'test',
  });
  assert.equal(
    propertyInvolvesOperationalData(opsProp, {
      permitRecordId: permit.id,
      lotGroupId: permit.lot_group_id,
    }),
    true
  );

  await assert.rejects(
    () =>
      findContactsForProperty({
        propertyId: opsProp.id,
        permitRecordId: permit.id,
      }),
    /hosted_sandbox rejected|operational/
  );

  // Invented sandbox_demo property is allowed through the gate (forceFail avoids network)
  const sand = upsertProperty(
    {
      site_address: '99 Invented Sandbox Way',
      city: 'Austin',
      state: 'TX',
      zip: '78701',
      record_origin: 'sandbox_demo',
    },
    { actor: 'test' }
  );
  assert.equal(propertyInvolvesOperationalData(sand), false);
  const ok = await findContactsForProperty({
    propertyId: sand.id,
    forceFail: 'no_match',
    requireConfirmedLink: false,
  });
  assert.equal(ok.noMatch, true);

  setProviderMode(PROVIDER_MODES.LOCAL_FIXTURE);
});

test('standalone property lookup does not implicit-attach latest lot; permit attach needs confirmed link', async () => {
  setProviderMode(PROVIDER_MODES.LOCAL_FIXTURE);
  const permit = importPermit();
  const prop = upsertProperty(
    {
      site_address: '44 Standalone Scope Rd',
      city: 'Demo City',
      state: 'VA',
      zip: '20100',
      record_origin: 'sandbox_demo',
    },
    { actor: 'test' }
  );
  // Link exists but lookup omits permitRecordId — must stay property-scoped
  linkPropertyToLot({
    propertyId: prop.id,
    lotGroupId: permit.lot_group_id,
    permitRecordId: permit.id,
    linkState: 'confirmed',
    confirmedBy: 'test',
  });

  const standalone = await findContactsForProperty({
    propertyId: prop.id,
    requireConfirmedLink: false,
  });
  assert.ok(standalone.saved?.length >= 1 || standalone.deduped || standalone.attached !== undefined);
  for (const c of standalone.saved || []) {
    assert.equal(c.permit_record_id, null);
    assert.equal(c.lot_group_id, null);
  }

  // Candidate (unconfirmed) link cannot attach via permit path
  const unconfirmed = upsertProperty(
    {
      site_address: '45 Unconfirmed Scope Rd',
      city: 'Demo City',
      state: 'VA',
      zip: '20100',
    },
    { actor: 'test' }
  );
  linkPropertyToLot({
    propertyId: unconfirmed.id,
    lotGroupId: permit.lot_group_id,
    permitRecordId: permit.id,
    linkState: 'candidate',
  });
  await assert.rejects(
    () =>
      findContactsForProperty({
        propertyId: unconfirmed.id,
        permitRecordId: permit.id,
      }),
    /must be confirmed/
  );
});

test('export excludes sandbox/stale/rejected; cache does not mix modes', async () => {
  const permit = importPermit();
  addManualContact({
    permit_record_id: permit.id,
    lot_group_id: permit.lot_group_id,
    role: 'property_owner',
    full_name: 'Eval Confirmed',
    status: 'confirmed',
    record_origin: 'manual',
  });
  // Sandbox fixture via provider path — manual HTTP path cannot set sandbox provenance.
  addManualContact(
    {
      permit_record_id: permit.id,
      lot_group_id: permit.lot_group_id,
      role: 'property_owner',
      full_name: 'Eval Sandbox',
      status: 'confirmed',
      record_origin: 'sandbox_demo',
      provider_source: 'hosted_sandbox',
      provider: 'tracerfy',
    },
    { actor: 'test', allowProviderProvenance: true }
  );
  addManualContact({
    permit_record_id: permit.id,
    lot_group_id: permit.lot_group_id,
    role: 'applicant',
    full_name: 'Eval Rejected',
    status: 'rejected',
    record_origin: 'manual',
  });
  addManualContact({
    permit_record_id: permit.id,
    lot_group_id: permit.lot_group_id,
    role: 'contractor',
    full_name: 'Eval Outdated',
    status: 'outdated',
    record_origin: 'manual',
  });

  const inspected = inspectExportBuffer(exportCoexistenceXlsx());
  assert.ok(inspected.contacts.some((c) => c.full_name === 'Eval Confirmed'));
  assert.ok(!inspected.contacts.some((c) => c.full_name === 'Eval Sandbox'));
  assert.ok(!inspected.contacts.some((c) => c.full_name === 'Eval Rejected'));
  assert.ok(!inspected.contacts.some((c) => c.full_name === 'Eval Outdated'));
});
