/**
 * Phase 6 — Contacts, rights, cost preview, suppression, Opportunities handoff.
 * Hard spend lock: production disabled, spend cap 0, fixture/sandbox only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permit-phase6-'));
process.env.PERMIT_DB_PATH = path.join(tmpDir, 'phase6.sqlite');
process.env.PERMIT_DEMO = '0';
process.env.AUTO_SEED = '0';
process.env.PILOT_AUTH = '1';
process.env.TRACERFY_PROVIDER_MODE = 'local_fixture';
process.env.PERMIT_TEST_HARNESS = '1';
process.env.PERMIT_BYPASS_SOURCE_ELIGIBILITY = '0';
process.env.PERMIT_NO_LISTEN = '1';
process.env.PERMIT_SYNC_JOBS = '0';
process.env.PERMIT_FAIRFAX_DISCOVER_FIXTURE = '1';
process.env.OWNER_EMAIL = 'owner@example.com';
process.env.OWNER_PASSWORD = 'owner-password-10+';
process.env.OWNER_DISPLAY_NAME = 'Owner';
process.env.BUSINESS_NAME = 'Phase6 Pilot Co';
process.env.COOKIE_SECURE = '0';
delete process.env.TRACERFY_API_TOKEN;
delete process.env.TRACERFY_HARD_SPEND_LOCK;
delete process.env.NODE_ENV;

const { db, migrate, setSetting, getSetting } = await import('../db.js');
migrate();
setSetting('tracerfy_hard_spend_lock', '1');
setSetting('tracerfy_production_enabled', '0');
setSetting('tracerfy_spend_limit_credits', '0');

const { app } = await import('../index.js');
const {
  previewContactLookupCost,
  handoffOpportunitiesToContactReview,
  suppressContactChannel,
  listSuppressions,
  phase6RightsStatus,
  normalizeSoughtRole,
  FORBIDDEN_SOUGHT_ROLES,
  SOUGHT_ROLES,
} = await import('../contactHandoff.js');
const {
  findContactsForProperty,
  setContactStatus,
  listContacts,
  addManualContact,
} = await import('../contacts.js');
const { upsertProperty } = await import('../property.js');
const {
  setProviderMode,
  PROVIDER_MODES,
  runContactLookup,
  tracerfyConfig,
  hardSpendLockActive,
  productionCapUsage,
} = await import('../providers/tracerfy.js');
const { exportCoexistenceXlsx, inspectExportBuffer } = await import('../excelExport.js');
const { createServer } = await import('node:http');

setProviderMode(PROVIDER_MODES.LOCAL_FIXTURE);

async function withServer(fn) {
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  async function api(method, urlPath, body) {
    const res = await fetch(`${base}${urlPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'PermitLedger',
        Origin: base,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: method === 'GET' || body == null ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.getSetCookie?.() || [];
    if (setCookie.length) {
      cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
    }
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, cookie };
  }
  try {
    return await fn({ base, api });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('hard spend lock: production blocked, spend cap 0, live pilot BLOCKED', () => {
  assert.equal(hardSpendLockActive(), true);
  assert.equal(getSetting('tracerfy_spend_limit_credits', 'x'), '0');
  const cfg = tracerfyConfig();
  assert.equal(cfg.hardSpendLock, true);
  assert.equal(cfg.spendLimitCredits, 0);
  assert.equal(cfg.liveEnrichedLeadPilot, 'BLOCKED');
  assert.notEqual(cfg.mode, PROVIDER_MODES.PRODUCTION);

  setProviderMode(PROVIDER_MODES.PRODUCTION);
  const blocked = tracerfyConfig();
  assert.equal(blocked.mode, 'not_configured');
  assert.equal(blocked.productionEnabled, false);

  const rights = phase6RightsStatus();
  assert.equal(rights.liveEnrichedLeadPilot, 'BLOCKED');
  assert.deepEqual(rights.excludedFields.includes('relatives'), true);
  assert.deepEqual(rights.excludedFields.includes('ssn'), true);
  setProviderMode(PROVIDER_MODES.LOCAL_FIXTURE);
});

test('sought role required; never equate borrower / wrong role', async () => {
  for (const bad of FORBIDDEN_SOUGHT_ROLES) {
    const n = normalizeSoughtRole(bad);
    assert.equal(n.ok, false, bad);
    assert.equal(n.error, 'forbidden_sought_role');
  }
  assert.equal(normalizeSoughtRole('').ok, false);
  assert.equal(normalizeSoughtRole('developer').ok, true);
  assert.ok(SOUGHT_ROLES.includes('contractor'));
  assert.ok(!SOUGHT_ROLES.includes('borrower'));

  const prop = upsertProperty(
    {
      site_address: '100 Role Test Way',
      city: 'Fairfax',
      state: 'VA',
      zip: '22030',
      record_origin: 'sandbox_demo',
    },
    { actor: 'test' }
  );

  await assert.rejects(
    () => findContactsForProperty({ propertyId: prop.id, requireConfirmedLink: false }),
    /sought_role required/
  );
  await assert.rejects(
    () =>
      findContactsForProperty({
        propertyId: prop.id,
        soughtRole: 'borrower',
        requireConfirmedLink: false,
      }),
    /Forbidden sought role|borrower/
  );
  assert.throws(
    () =>
      addManualContact({
        property_id: prop.id,
        role: 'borrower',
        full_name: 'Should Fail',
      }),
    /Borrower/
  );
});

test('fixture cost preview is zero; purchase path shows budget', () => {
  const preview = previewContactLookupCost({
    targets: [
      { propertyId: 1, address: '1 A St' },
      { propertyId: 1, address: '1 A St' }, // dup
      { propertyId: 2, address: '2 B St' },
    ],
    soughtRole: 'developer',
    endpointKey: 'instant_trace',
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.deduplicatedTargetCount, 2);
  assert.equal(preview.rawTargetCount, 3);
  assert.equal(preview.maxEstimatedCredits, 0);
  assert.equal(preview.maxEstimatedUsd, 0);
  assert.equal(preview.fixtureCostZero, true);
  assert.equal(preview.liveEnrichmentBlocked, true);
  assert.equal(preview.liveEnrichmentStatus, 'BLOCKED');
  assert.equal(preview.purchaseAllowed, true); // fixture allowed
  assert.equal(preview.availableBudgetCredits, 0);
  assert.equal(preview.providerMode, PROVIDER_MODES.LOCAL_FIXTURE);
});

test('fixture lookup actual credits 0; stores match evidence + sought role', async () => {
  const prop = upsertProperty(
    {
      site_address: '200 Evidence Lane',
      city: 'Fairfax',
      state: 'VA',
      zip: '22030',
      record_origin: 'sandbox_demo',
    },
    { actor: 'test' }
  );
  const result = await findContactsForProperty({
    propertyId: prop.id,
    soughtRole: 'developer',
    requireConfirmedLink: false,
  });
  assert.equal(result.actualCredits, 0);
  assert.equal(result.soughtRole, 'developer');
  assert.ok(result.saved.length >= 1);
  const c = result.saved[0];
  assert.equal(c.sought_role, 'developer');
  assert.equal(c.role, 'developer'); // assigned to sought role for review
  const evidence = JSON.parse(c.match_evidence_json || '{}');
  assert.equal(evidence.sought_role, 'developer');
  assert.ok(evidence.retrieval_date);
  assert.equal(evidence.candidate_status, 'candidate');
  assert.ok(evidence.provider);
});

test('reject and channel suppress do not silently reaccept; export honors suppression', async () => {
  const prop = upsertProperty(
    {
      site_address: '300 Suppress Rd',
      city: 'Fairfax',
      state: 'VA',
      zip: '22030',
      record_origin: 'sandbox_demo',
    },
    { actor: 'test' }
  );
  const first = await findContactsForProperty({
    propertyId: prop.id,
    soughtRole: 'property_owner',
    requireConfirmedLink: false,
  });
  assert.ok(first.saved.length >= 1);
  const contact = first.saved[0];
  setContactStatus(contact.id, 'rejected', { reason: 'wrong_party', actor: 'test' });

  // Cached/deduped job must not resurrect rejected
  const again = await findContactsForProperty({
    propertyId: prop.id,
    soughtRole: 'property_owner',
    requireConfirmedLink: false,
  });
  assert.equal(again.deduped, true);
  const live = listContacts({ propertyId: prop.id, includeDemo: true });
  assert.ok(!live.some((c) => c.status === 'candidate' && c.full_name === contact.full_name));

  // Channel suppression on a manual contact path
  const manual = addManualContact({
    property_id: prop.id,
    role: 'contractor',
    full_name: 'Suppress Me',
    email: 'suppress.me@example.invalid',
    phone: '5550199999',
    status: 'confirmed',
  });
  suppressContactChannel(
    { channel: 'email', value: manual.email, reason: 'do_not_contact', propertyId: prop.id },
    { actor: 'test' }
  );
  const afterSup = listContacts({ propertyId: prop.id, includeDemo: true }).find((c) => c.id === manual.id);
  assert.equal(afterSup.status, 'rejected');

  // Relookup with new fingerprint (different sought role → new job) still skips suppressed email
  const relookup = await findContactsForProperty({
    propertyId: prop.id,
    soughtRole: 'contractor',
    requireConfirmedLink: false,
    forceFail: null,
  });
  // Force a fresh attach attempt by fabricating via forceFail no_match then manual re-add simulation:
  // suppressedSkipped should catch fixture person if email matches — fixture uses sandbox.demo-owner@example.invalid
  suppressContactChannel(
    {
      channel: 'email',
      value: 'sandbox.demo-owner@example.invalid',
      reason: 'global_dnc',
      propertyId: null,
    },
    { actor: 'test' }
  );
  // Clear prior succeeded job fingerprint by using apn endpoint needing parcel — use new property
  const prop2 = upsertProperty(
    {
      site_address: '301 Suppress Rd',
      city: 'Fairfax',
      state: 'VA',
      zip: '22030',
      record_origin: 'sandbox_demo',
    },
    { actor: 'test' }
  );
  const blockedAttach = await findContactsForProperty({
    propertyId: prop2.id,
    soughtRole: 'property_owner',
    requireConfirmedLink: false,
  });
  assert.ok(
    (blockedAttach.suppressedSkipped || []).length >= 1 || blockedAttach.saved.length === 0,
    'suppressed email must not attach'
  );
  assert.ok(!blockedAttach.saved.some((c) => (c.email || '').toLowerCase() === 'sandbox.demo-owner@example.invalid'));

  const suppressions = listSuppressions({ channel: 'email' });
  assert.ok(suppressions.some((s) => s.value_normalized.includes('suppress.me@example.invalid')));
});

test('ambiguous property skipped in opportunity handoff; fixture handoff cost 0', async () => {
  // Clear workspace suppressions so prior DNC rows do not block fixture attach in this case
  db.exec(`DELETE FROM contact_suppressions WHERE value_normalized LIKE '%sandbox.demo-owner%'`);

  db.prepare(
    `INSERT INTO opportunities(
       official_id, activity_summary, address, city, state, zip, parcel, dedupe_key, disposition
     ) VALUES (?, 'Synthetic range', '100-110 Ambiguous Range Way', 'Fairfax', 'VA', '22030', '', ?, 'qualified')`
  ).run('SYN-AMB-1', `syn-amb-1-${Date.now()}`);
  db.prepare(
    `INSERT INTO opportunities(
       official_id, activity_summary, address, city, state, zip, parcel, dedupe_key, disposition
     ) VALUES (?, 'Clear site', '500 Clear Builder Rd', 'Fairfax', 'VA', '22030', 'P-500', ?, 'qualified')`
  ).run('SYN-CLR-1', `syn-clr-1-${Date.now()}`);

  const amb = db
    .prepare(`SELECT id FROM opportunities WHERE address LIKE '%Range%' ORDER BY id DESC LIMIT 1`)
    .get();
  const clear = db
    .prepare(`SELECT id FROM opportunities WHERE address LIKE '500 Clear%' ORDER BY id DESC LIMIT 1`)
    .get();

  const dry = await handoffOpportunitiesToContactReview({
    opportunityIds: [amb.id, clear.id],
    soughtRole: 'developer',
    dryRun: true,
  });
  assert.equal(dry.ok, true);
  assert.ok(dry.ambiguous.some((a) => a.reason === 'ambiguous_property_identity'));
  assert.equal(dry.preview.maxEstimatedUsd, 0);
  assert.equal(dry.preview.liveEnrichmentStatus, 'BLOCKED');
  assert.equal(dry.preview.purchaseAllowed, true);

  const run = await handoffOpportunitiesToContactReview({
    opportunityIds: [clear.id],
    soughtRole: 'developer',
    dryRun: false,
  });
  assert.equal(run.ok, true);
  assert.equal(run.totalActualCredits, 0);
  assert.equal(run.liveEnrichmentStatus, 'BLOCKED');
  assert.ok(run.results[0].saved.length >= 1);
  assert.equal(run.results[0].soughtRole, 'developer');
  assert.ok(!String(run.results[0].saved[0].role).includes('borrower'));
});

test('concurrent budget reservation serializes under production unlock', async () => {
  setSetting('tracerfy_hard_spend_lock', '0');
  setSetting('tracerfy_production_enabled', '1');
  setSetting('tracerfy_spend_limit_credits', '5');
  setSetting('tracerfy_commercial_confirmed', '1');
  setSetting('tracerfy_api_token_present', '1');
  process.env.TRACERFY_API_TOKEN = 'test-concurrent';
  setProviderMode(PROVIDER_MODES.PRODUCTION);

  const props = [1, 2].map((i) =>
    upsertProperty(
      {
        site_address: `${i} Concurrent Cap Ave`,
        city: 'Fairfax',
        state: 'VA',
        zip: '22030',
      },
      { actor: 'test' }
    )
  );

  // Hold the full 5-credit cap with an uncertain timeout reservation, then race a second lookup.
  const held = await runContactLookup({
    property: props[0],
    endpointKey: 'instant_trace',
    forceFail: 'timeout',
  });
  assert.equal(held.job.status, 'timed_out');
  assert.equal(productionCapUsage(), 5);

  const raced = await Promise.all([
    runContactLookup({ property: props[1], endpointKey: 'instant_trace', forceFail: 'no_match' }),
    runContactLookup({
      property: upsertProperty(
        {
          site_address: '3 Concurrent Cap Ave',
          city: 'Fairfax',
          state: 'VA',
          zip: '22030',
        },
        { actor: 'test' }
      ),
      endpointKey: 'instant_trace',
      forceFail: 'no_match',
    }),
  ]);
  assert.ok(
    raced.every((r) => r.error?.error === 'spend_limit' || r.error?.reason === 'spend_limit'),
    'both concurrent lookups must hit spend_limit while cap is fully reserved'
  );

  setSetting('tracerfy_production_enabled', '0');
  setSetting('tracerfy_hard_spend_lock', '1');
  setSetting('tracerfy_spend_limit_credits', '0');
  delete process.env.TRACERFY_API_TOKEN;
  setProviderMode(PROVIDER_MODES.LOCAL_FIXTURE);
});

test('HTTP: cost-preview + handoff + rights; auth on', async () => {
  await withServer(async ({ api }) => {
    const login = await api('POST', '/api/auth/login', {
      email: 'owner@example.com',
      password: 'owner-password-10+',
    });
    assert.equal(login.status, 200, JSON.stringify(login.data));

    const rights = await api('GET', '/api/contacts/rights');
    assert.equal(rights.status, 200);
    assert.equal(rights.data.liveEnrichedLeadPilot, 'BLOCKED');

    const preview = await api('POST', '/api/contacts/cost-preview', {
      opportunityIds: [1, 1, 2],
      sought_role: 'contractor',
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.data.maxEstimatedUsd, 0);
    assert.equal(preview.data.liveEnrichmentStatus, 'BLOCKED');

    const badRole = await api('POST', '/api/contacts/cost-preview', {
      opportunityIds: [1],
      sought_role: 'borrower',
    });
    assert.equal(badRole.status, 400);

    const clear = db
      .prepare(`SELECT id FROM opportunities WHERE address LIKE '500 Clear%' ORDER BY id DESC LIMIT 1`)
      .get();
    if (clear) {
      const handoff = await api('POST', '/api/opportunities/contact-handoff', {
        opportunityIds: [clear.id],
        sought_role: 'developer',
        dryRun: true,
      });
      assert.equal(handoff.status, 200);
      assert.equal(handoff.data.preview.fixtureCostZero, true);
    }
  });
});

test('export excludes suppressed and fixture contacts', () => {
  const buf = exportCoexistenceXlsx({ statuses: ['confirmed', 'candidate'] });
  const inspected = inspectExportBuffer(buf);
  const emails = (inspected.contacts || []).map((c) => String(c.email || '').toLowerCase());
  assert.ok(!emails.includes('suppress.me@example.invalid'));
  assert.ok(!emails.includes('sandbox.demo-owner@example.invalid'));
});
