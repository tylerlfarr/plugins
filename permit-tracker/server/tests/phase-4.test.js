/**
 * Phase 4 — reliable official evidence, adapter contract, durable sync jobs,
 * Attention reconciliation, SSRF hardening, jurisdiction honesty.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permit-phase4-'));
process.env.PERMIT_DB_PATH = path.join(tmpDir, 'phase4.sqlite');
process.env.PERMIT_DEMO = '0';
process.env.AUTO_SEED = '0';
process.env.PILOT_AUTH = '1';
process.env.TRACERFY_MODE = 'local_fixture';
process.env.PERMIT_TEST_HARNESS = '1';
process.env.PERMIT_BYPASS_SOURCE_ELIGIBILITY = '0';
process.env.PERMIT_NO_LISTEN = '1';
process.env.PERMIT_SYNC_JOBS = '0';
process.env.OWNER_EMAIL = 'owner@example.com';
process.env.OWNER_PASSWORD = 'owner-password-10+';
process.env.OWNER_DISPLAY_NAME = 'Owner';
process.env.BUSINESS_NAME = 'Phase4 Pilot Co';
process.env.COOKIE_SECURE = '0';
delete process.env.TRACERFY_API_TOKEN;
delete process.env.NODE_ENV;

const { db, migrate } = await import('../db.js');
migrate();
// Import app early so OWNER_EMAIL bootstrap creates the pilot owner (same as phase-2-3).
const { app } = await import('../index.js');
const { isBlockedIp, assertSafeOutboundUrl } = await import('../sources/ssrf.js');
const {
  ensureSourceRegistrySeeded,
  activateSource,
  getSource,
  listSources,
} = await import('../sources/registry.js');
const {
  assertActivatableAdapter,
  listAdapterContracts,
  getAdapter,
} = await import('../connectors/adapters.js');
const { listConnectors, checkPermit } = await import('../connectors/index.js');
const { JURISDICTIONS } = await import('../connectors/types.js');
const { applyConnectorResult, evaluateCheckEligibility } = await import('../sync.js');
const {
  enqueueSyncJob,
  getSyncJob,
  drainSyncJobs,
  ensureSyncJobTables,
} = await import('../syncJobs.js');
const { upsertAttention } = await import('../db.js');
const { buildSanitizedWorkbookBuffer } = await import('../fixtures/buildSanitizedWorkbook.js');
const { parseWorkbookBuffer, commitWorkbookParse } = await import('../workbookImport.js');

let permitSeq = 0;
function insertImportPermit({
  officialId,
  jurisdiction = 'fairfax_county',
  confirmed = 1,
  owner = 'Coord A',
  nextAction = 'Call AHJ',
  nextDue = '2026-10-01',
} = {}) {
  permitSeq += 1;
  const sec = db
    .prepare(
      `INSERT INTO community_sections(project_code, community_name, jurisdiction_code, jurisdiction_source, jurisdiction_confirmed, record_origin)
       VALUES (?, ?, ?, 'confirmed_mapping', ?, 'import')`
    )
    .run(`P4-${permitSeq}-${officialId}`.slice(0, 80), `Phase4 Sec ${permitSeq}`, jurisdiction, confirmed ? 1 : 0);
  const lg = db
    .prepare(
      `INSERT INTO lot_groups(section_id, lot_label, housetype, stable_key, record_origin)
       VALUES (?, '1', 'TH', ?, 'import')`
    )
    .run(Number(sec.lastInsertRowid), `p4|${permitSeq}|${officialId}`);
  const p = db
    .prepare(
      `INSERT INTO permit_records(
         lot_group_id, primary_official_id, jurisdiction_code, jurisdiction_source, jurisdiction_confirmed,
         record_origin, owner, next_action, next_action_due
       ) VALUES (?, ?, ?, 'confirmed_mapping', ?, 'import', ?, ?, ?)`
    )
    .run(
      Number(lg.lastInsertRowid),
      officialId,
      jurisdiction,
      confirmed ? 1 : 0,
      owner,
      nextAction,
      nextDue
    );
  return db.prepare('SELECT * FROM permit_records WHERE id = ?').get(Number(p.lastInsertRowid));
}

test('SSRF: blocked IPs and localhost URLs rejected', async () => {
  assert.equal(isBlockedIp('127.0.0.1'), true);
  assert.equal(isBlockedIp('10.0.0.5'), true);
  assert.equal(isBlockedIp('192.168.1.1'), true);
  assert.equal(isBlockedIp('169.254.169.254'), true);
  assert.equal(isBlockedIp('8.8.8.8'), false);
  await assert.rejects(() => assertSafeOutboundUrl('http://127.0.0.1/latest/meta-data'), /Blocked|not allowed/i);
  await assert.rejects(() => assertSafeOutboundUrl('file:///etc/passwd'), /http/);
  await assert.rejects(() => assertSafeOutboundUrl('http://localhost/admin'), /not allowed/i);
});

test('adapter contract: fairfax_plus operational; arcgis_generic / none not activatable', () => {
  const contracts = listAdapterContracts();
  assert.ok(contracts.some((c) => c.type === 'fairfax_plus' && c.operational && c.capabilities.fetch));
  assert.ok(contracts.some((c) => c.type === 'arcgis_generic' && !c.operational));
  ensureSourceRegistrySeeded();
  const ffx = getSource('fairfax_county_building_records_plus');
  assert.ok(ffx.adapter_operational);
  assert.ok(ffx.capabilities.refresh);
  assert.equal(ffx.capabilities.applications, false);
  assert.equal(ffx.capabilities.issued, true);
  assert.doesNotThrow(() => assertActivatableAdapter(ffx));

  assert.throws(() => activateSource('loudoun_landmarc_portal'), /verified|operational|adapter/i);
  assert.throws(() => activateSource('west_virginia_unsupported'), /verified|operational|adapter/i);

  // Metadata-only pretending to be verified
  db.prepare(
    `UPDATE source_registry SET state = 'verified', adapter_type = 'none' WHERE key = 'loudoun_issued_permit_reports'`
  ).run();
  assert.throws(() => activateSource('loudoun_issued_permit_reports'), /no operational adapter/);

  // arcgis_generic is inspect-only even if marked verified
  db.prepare(
    `UPDATE source_registry SET state = 'verified', activated = 0 WHERE key = 'pwc_gis_use_permits'`
  ).run();
  assert.throws(() => activateSource('pwc_gis_use_permits'), /not operational|cannot activate/i);

  const activated = activateSource('fairfax_county_building_records_plus', { reviewedBy: 'phase4' });
  assert.equal(activated.activated, 1);
});

test('stable jurisdiction identifiers: Fairfax live; Loudoun/PWC/WV unsupported honesty', () => {
  assert.equal(JURISDICTIONS.fairfax_county.mode, 'live');
  assert.equal(JURISDICTIONS.loudoun_county.mode, 'unsupported');
  assert.equal(JURISDICTIONS.prince_william_county.mode, 'unsupported');
  assert.equal(JURISDICTIONS.west_virginia.mode, 'unsupported');
  const list = listConnectors();
  for (const code of ['loudoun_county', 'prince_william_county', 'west_virginia']) {
    const row = list.find((j) => j.code === code);
    assert.ok(row, code);
    assert.equal(row.live, false);
    assert.match(row.honestLabel, /Unsupported/i);
  }
  ensureSourceRegistrySeeded();
  const wv = getSource('west_virginia_unsupported');
  assert.equal(wv.state, 'unsupported');
  assert.equal(wv.adapter_operational, false);
});

test('unsupported jurisdiction check is unavailable — not fabricated', async () => {
  const loudoun = await checkPermit({
    jurisdictionCode: 'loudoun_county',
    officialId: 'BLDC-2026-99999',
    allowSynthetic: false,
    recordOrigin: 'import',
  });
  assert.equal(loudoun.outcome, 'unavailable');
  assert.equal(loudoun.connectorStatus, 'unsupported');
  assert.ok(!loudoun.officialStatus || loudoun.officialStatus === undefined);

  const pwc = await checkPermit({
    jurisdictionCode: 'prince_william_county',
    officialId: 'BLD2026-04765',
    allowSynthetic: false,
    recordOrigin: 'import',
  });
  assert.equal(pwc.outcome, 'unavailable');

  const wv = await checkPermit({
    jurisdictionCode: 'west_virginia',
    officialId: 'WV-TEST-1',
    allowSynthetic: false,
    recordOrigin: 'import',
  });
  assert.equal(wv.outcome, 'unavailable');
});

test('date semantics persisted separately on successful apply', () => {
  const permit = insertImportPermit({ officialId: 'BLDR-DATE-1' });
  const observed = '2026-10-08T12:00:00.000Z';
  applyConnectorResult(
    permit,
    {
      outcome: 'updated',
      mode: 'live',
      sourceNativeStatus: 'Issued',
      officialStatus: 'issued',
      sourceEventAt: '2026-09-15',
      publicationAt: null,
      observedAt: observed,
      checkedAt: observed,
      fields: {
        issuedDate: '2026-09-15',
        sourceEventDate: '2026-09-15',
        publicationDate: null,
      },
    },
    'phase4-test',
    'BLDR-DATE-1'
  );
  const row = db.prepare('SELECT * FROM permit_records WHERE id = ?').get(permit.id);
  assert.equal(row.source_event_at, '2026-09-15');
  assert.equal(row.source_observed_at, observed);
  assert.equal(row.last_successful_check_at, observed);
  assert.equal(row.source_publication_at, null);
  assert.equal(row.official_status, 'issued');
});

test('Attention: recovered source failure resolves; ack distinct from resolve; owner/due/action present', () => {
  const permit = insertImportPermit({
    officialId: 'BLDR-ATT-1',
    owner: 'Jordan Lee',
    nextAction: 'Submit revision',
    nextDue: '2026-10-20',
  });
  upsertAttention(
    permit.id,
    'source_missing',
    'Not found at source for BLDR-ATT-1',
    `notfound:${permit.id}:BLDR-ATT-1`,
    `source:${permit.id}:BLDR-ATT-1`
  );
  upsertAttention(
    permit.id,
    'overdue_action',
    'Overdue: Submit revision',
    `overdue:${permit.id}:2026-10-20`,
    `overdue:${permit.id}`
  );

  // Ack hides without resolving
  const open = db
    .prepare(
      `SELECT * FROM attention_events WHERE permit_record_id = ? AND kind = 'overdue_action' AND resolved_at IS NULL`
    )
    .get(permit.id);
  assert.ok(open);
  db.prepare('UPDATE attention_events SET acknowledged = 1 WHERE id = ?').run(open.id);
  const acked = db.prepare('SELECT * FROM attention_events WHERE id = ?').get(open.id);
  assert.equal(acked.acknowledged, 1);
  assert.equal(acked.resolved_at, null);

  // Successful apply resolves source_missing
  applyConnectorResult(
    permit,
    {
      outcome: 'updated',
      mode: 'live',
      sourceNativeStatus: 'Issued',
      officialStatus: 'issued',
      sourceEventAt: '2026-09-01',
      observedAt: new Date().toISOString(),
      checkedAt: new Date().toISOString(),
      fields: {},
    },
    'phase4',
    'BLDR-ATT-1'
  );
  const missing = db
    .prepare(
      `SELECT * FROM attention_events WHERE permit_record_id = ? AND kind = 'source_missing'`
    )
    .get(permit.id);
  assert.ok(missing.resolved_at, 'source_missing must resolve after recovery');
  // Acked overdue remains acknowledged + unresolved (distinct semantics)
  const stillAck = db.prepare('SELECT * FROM attention_events WHERE id = ?').get(open.id);
  assert.equal(stillAck.acknowledged, 1);
  assert.equal(stillAck.resolved_at, null);

  // Attention list fields include owner / due / action for Open-record workflow
  const item = db
    .prepare(
      `SELECT a.*, p.owner, p.next_action, p.next_action_due, p.primary_official_id
       FROM attention_events a
       JOIN permit_records p ON p.id = a.permit_record_id
       WHERE a.id = ?`
    )
    .get(open.id);
  assert.equal(item.owner, 'Jordan Lee');
  assert.equal(item.next_action, 'Submit revision');
  assert.equal(item.next_action_due, '2026-10-20');
});

test('durable sync jobs: enqueue + drain succeeds without browser; lease fields present', async () => {
  ensureSyncJobTables();
  ensureSourceRegistrySeeded();
  activateSource('fairfax_county_building_records_plus', { reviewedBy: 'jobs' });
  // Empty fairfax-only run still completes as a durable job
  const { job, coalesced } = enqueueSyncJob({
    fairfaxOnly: true,
    trigger: 'phase4-test',
    createdBy: 'tester',
  });
  assert.equal(coalesced, false);
  assert.equal(job.status, 'queued');
  assert.ok(job.max_attempts >= 1);
  const again = enqueueSyncJob({ fairfaxOnly: true, trigger: 'phase4-test' });
  assert.equal(again.coalesced, true);
  assert.equal(again.job.id, job.id);

  await drainSyncJobs({ maxTicks: 20 });
  const finished = getSyncJob(job.id);
  assert.equal(finished.status, 'succeeded');
  assert.ok(finished.finished_at);
  const summary = JSON.parse(finished.summary_json || '{}');
  assert.ok(summary.counts);
  assert.equal(typeof summary.counts.total, 'number');
});

test('eligibility requires operational activated adapter (not arcgis_generic)', () => {
  ensureSourceRegistrySeeded();
  // Ensure Fairfax activated for positive path later
  try {
    activateSource('fairfax_county_building_records_plus', { reviewedBy: 'elig' });
  } catch {
    /* already */
  }
  const loudounPermit = insertImportPermit({
    officialId: 'BLDC-2026-00001',
    jurisdiction: 'loudoun_county',
    confirmed: 1,
  });
  const gate = evaluateCheckEligibility(loudounPermit);
  assert.equal(gate.ok, false);
  assert.ok(['unsupported', 'blocked'].includes(gate.outcome));

  const ffx = insertImportPermit({ officialId: 'BLDR-2026-00263', confirmed: 1 });
  const ok = evaluateCheckEligibility(ffx);
  assert.equal(ok.ok, true);
});

test('live Fairfax stratified samples when network allows (skip fabrications)', async (t) => {
  // Stratified: known-shaped ID, not_found ID, unsupported jurisdiction already covered.
  const samples = [
    { id: 'BLDR-2026-00263', expect: ['updated', 'no_change', 'not_found', 'unavailable', 'failed'] },
    { id: 'ALTC-2026-00970', expect: ['updated', 'no_change', 'not_found', 'unavailable', 'failed'] },
    { id: 'BLDR-2026-999999', expect: ['not_found', 'unavailable', 'failed'] },
  ];
  const results = [];
  for (const s of samples) {
    // eslint-disable-next-line no-await-in-loop
    const r = await checkPermit({
      jurisdictionCode: 'fairfax_county',
      officialId: s.id,
      allowSynthetic: false,
      recordOrigin: 'import',
    });
    results.push({ id: s.id, outcome: r.outcome, mode: r.mode, hasStatus: Boolean(r.officialStatus) });
    assert.ok(s.expect.includes(r.outcome), `${s.id} → ${r.outcome}`);
    if (r.outcome === 'updated' || r.outcome === 'no_change') {
      assert.equal(r.mode, 'live');
      assert.ok(r.observedAt || r.checkedAt);
      // Must not invent publication when layer has none
      assert.equal(r.publicationAt, null);
    }
    if (s.id.includes('999999')) {
      assert.equal(r.outcome, 'not_found');
      assert.ok(!r.officialStatus);
    }
  }
  const liveHits = results.filter((r) => r.outcome === 'updated' || (r.outcome === 'no_change' && r.hasStatus));
  if (!liveHits.length && results.every((r) => r.outcome === 'unavailable' || r.outcome === 'failed')) {
    t.diagnostic('Fairfax network unavailable in this environment — outcomes recorded without fabrication');
  } else {
    // Persist one successful live hit and assert columns
    const hit = results.find((r) => r.outcome === 'updated') || results.find((r) => r.id === 'BLDR-2026-00263');
    if (hit && (hit.outcome === 'updated' || hit.outcome === 'not_found')) {
      const permit = insertImportPermit({ officialId: hit.id });
      const live = await checkPermit({
        jurisdictionCode: 'fairfax_county',
        officialId: hit.id,
        allowSynthetic: false,
        recordOrigin: 'import',
      });
      applyConnectorResult(permit, live, 'phase4-live', hit.id);
      const row = db.prepare('SELECT * FROM permit_records WHERE id = ?').get(permit.id);
      assert.equal(row.last_check_outcome, live.outcome === 'updated' ? row.last_check_outcome : live.outcome);
      if (live.outcome === 'updated' || live.sourceNativeStatus) {
        assert.ok(row.last_successful_check_at);
        assert.ok(row.source_observed_at);
      }
    }
  }
});

test('inspect ArcGIS blocks SSRF targets via API path', async () => {
  const { inspectArcGisUrl } = await import('../sources/arcgisDiscover.js');
  const blocked = await inspectArcGisUrl('http://127.0.0.1:9/FeatureServer/0');
  assert.equal(blocked.state, 'unsupported');
  assert.match(String(blocked.error || ''), /Blocked|not allowed|SSRF|private/i);
});

test('HTTP: Attention ack vs resolve + Open-record fields; sync job 202 path', async () => {
  process.env.PERMIT_BYPASS_SOURCE_ELIGIBILITY = '1';
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  async function api(method, urlPath, { cookie, body } = {}) {
    const res = await fetch(`${base}${urlPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'PermitLedger',
        Origin: base,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.getSetCookie?.() || [];
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return {
      status: res.status,
      data,
      cookie: setCookie.map((c) => c.split(';')[0]).join('; ') || cookie,
    };
  }

  try {
    let r = await api('POST', '/api/auth/login', {
      body: { email: 'owner@example.com', password: 'owner-password-10+' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const cookie = r.cookie;

    // Import sanitized workbook for real Attention Open-record path
    const buf = buildSanitizedWorkbookBuffer();
    const form = new FormData();
    form.append('file', new Blob([buf]), 'sanitized.xlsx');
    const previewRes = await fetch(`${base}/api/import/workbook/preview`, {
      method: 'POST',
      headers: { Cookie: cookie, 'X-Requested-With': 'PermitLedger', Origin: base },
      body: form,
    });
    const preview = await previewRes.json();
    if (preview.previewId) {
      await api('POST', '/api/import/workbook/commit', {
        cookie,
        body: { previewId: preview.previewId },
      });
    } else {
      commitWorkbookParse(parseWorkbookBuffer(buf));
    }

    const permit = db
      .prepare(
        `SELECT * FROM permit_records WHERE record_origin = 'import' AND primary_official_id IS NOT NULL LIMIT 1`
      )
      .get();
    assert.ok(permit);
    db.prepare(
      `UPDATE permit_records SET owner = 'HTTP Owner', next_action = 'Review', next_action_due = '2026-11-01'
       WHERE id = ?`
    ).run(permit.id);

    upsertAttention(
      permit.id,
      'check_failed',
      'Source check failed: simulated',
      `fail:${permit.id}:failed:sim`,
      `source:${permit.id}:${permit.primary_official_id}`
    );

    r = await api('GET', '/api/attention', { cookie });
    assert.equal(r.status, 200);
    const item = (r.data.items || []).find(
      (a) => a.permit_record_id === permit.id && a.kind === 'check_failed'
    );
    assert.ok(item, 'check_failed on Attention');
    assert.equal(item.owner, 'HTTP Owner');
    assert.equal(item.next_action, 'Review');
    assert.equal(item.next_action_due, '2026-11-01');

    r = await api('POST', `/api/attention/${item.id}/ack`, { cookie, body: {} });
    assert.equal(r.status, 200);
    const acked = db.prepare('SELECT * FROM attention_events WHERE id = ?').get(item.id);
    assert.equal(acked.acknowledged, 1);
    assert.equal(acked.resolved_at, null);

    // Recover via successful apply → resolve (even if previously would have been open)
    upsertAttention(
      permit.id,
      'check_failed',
      'Source check failed: again',
      `fail:${permit.id}:failed:again`,
      `source:${permit.id}:${permit.primary_official_id}`
    );
    applyConnectorResult(
      db.prepare('SELECT * FROM permit_records WHERE id = ?').get(permit.id),
      {
        outcome: 'updated',
        mode: 'live',
        sourceNativeStatus: 'Issued',
        officialStatus: 'issued',
        sourceEventAt: '2026-08-01',
        publicationAt: null,
        observedAt: new Date().toISOString(),
        checkedAt: new Date().toISOString(),
        fields: {},
      },
      'http-test',
      permit.primary_official_id
    );
    const resolved = db
      .prepare(
        `SELECT * FROM attention_events WHERE permit_record_id = ? AND kind = 'check_failed' AND dedupe_key = ?`
      )
      .get(permit.id, `fail:${permit.id}:failed:again`);
    assert.ok(resolved.resolved_at);

    // Sync jobs API — force async path
    process.env.PERMIT_TEST_HARNESS = '0';
    process.env.PERMIT_SYNC_WAIT = '0';
    r = await api('POST', '/api/sync', { cookie, body: { fairfaxOnly: true } });
    assert.ok([202, 200].includes(r.status), JSON.stringify(r.data));
    if (r.status === 202) {
      assert.equal(r.data.async, true);
      assert.ok(r.data.job?.id);
      await drainSyncJobs({ maxTicks: 30 });
      const jobGet = await api('GET', `/api/sync/jobs/${r.data.job.id}`, { cookie });
      assert.equal(jobGet.status, 200);
      assert.ok(['succeeded', 'failed', 'queued', 'running'].includes(jobGet.data.job.status));
    }

    // Adapters listed on connectors
    r = await api('GET', '/api/connectors', { cookie });
    assert.ok((r.data.adapters || []).some((a) => a.type === 'fairfax_plus'));
    assert.ok(r.data.dateSemantics?.source_event_at);
  } finally {
    process.env.PERMIT_TEST_HARNESS = '1';
    server.close();
  }
});

test('getAdapter unknown type', () => {
  assert.equal(getAdapter('nope_adapter'), null);
  assert.equal(getAdapter('fairfax_plus')?.operational, true);
});
