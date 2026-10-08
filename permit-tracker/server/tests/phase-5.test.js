/**
 * Phase 5 — workbook-free discovery + private opportunity qualification.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permit-phase5-'));
process.env.PERMIT_DB_PATH = path.join(tmpDir, 'phase5.sqlite');
process.env.PERMIT_DEMO = '0';
process.env.AUTO_SEED = '0';
process.env.PILOT_AUTH = '1';
process.env.TRACERFY_MODE = 'local_fixture';
process.env.PERMIT_TEST_HARNESS = '1';
process.env.PERMIT_BYPASS_SOURCE_ELIGIBILITY = '0';
process.env.PERMIT_NO_LISTEN = '1';
process.env.PERMIT_SYNC_JOBS = '0';
process.env.PERMIT_FAIRFAX_DISCOVER_FIXTURE = '1';
process.env.OWNER_EMAIL = 'owner@example.com';
process.env.OWNER_PASSWORD = 'owner-password-10+';
process.env.OWNER_DISPLAY_NAME = 'Owner';
process.env.BUSINESS_NAME = 'Phase5 Pilot Co';
process.env.COOKIE_SECURE = '0';
delete process.env.TRACERFY_API_TOKEN;
delete process.env.NODE_ENV;

const { db, migrate } = await import('../db.js');
migrate();
const { app } = await import('../index.js');
const {
  getDiscoveryCoverage,
  searchOpportunities,
  saveOpportunities,
  listOpportunities,
  updateOpportunity,
  linkOpportunityToProject,
  saveSearch,
  markSearchReviewed,
  runSavedSearch,
  proposeGroups,
  reviewGroupLink,
  exportOpportunitiesXlsx,
  MATCH_RULES,
  OPPORTUNITY_DISPOSITIONS,
} = await import('../opportunities.js');
const { getAdapter } = await import('../connectors/adapters.js');
const { discoverFairfaxPermits } = await import('../connectors/fairfax.js');

function insertImportPermit(officialId = 'BLDR-2026-01000') {
  const sec = db
    .prepare(
      `INSERT INTO community_sections(project_code, community_name, jurisdiction_code, jurisdiction_source, jurisdiction_confirmed, record_origin)
       VALUES (?, 'Phase5 Sec', 'fairfax_county', 'confirmed_mapping', 1, 'import')`
    )
    .run(`P5-${officialId}`);
  const lg = db
    .prepare(
      `INSERT INTO lot_groups(section_id, lot_label, housetype, stable_key, record_origin)
       VALUES (?, '1', 'TH', ?, 'import')`
    )
    .run(Number(sec.lastInsertRowid), `p5|${officialId}`);
  const p = db
    .prepare(
      `INSERT INTO permit_records(
         lot_group_id, primary_official_id, jurisdiction_code, jurisdiction_source, jurisdiction_confirmed,
         record_origin, owner, next_action
       ) VALUES (?, ?, 'fairfax_county', 'confirmed_mapping', 1, 'import', 'LO', 'Review')`
    )
    .run(Number(lg.lastInsertRowid), officialId);
  return db.prepare('SELECT * FROM permit_records WHERE id = ?').get(Number(p.lastInsertRowid));
}

test('coverage shown before search; issued-not-early-intent; transparent rules', () => {
  const cov = getDiscoveryCoverage();
  assert.equal(cov.shown_before_search, true);
  assert.ok(cov.sources.some((s) => s.jurisdiction_code === 'fairfax_county' && s.status === 'supported'));
  assert.ok(cov.sources.some((s) => s.jurisdiction_code === 'loudoun_county' && s.status === 'unsupported'));
  const ffx = cov.sources.find((s) => s.jurisdiction_code === 'fairfax_county');
  assert.match(ffx.intent_fit, /not suitable for pre-application early-intent/i);
  assert.ok(MATCH_RULES.some((r) => r.id === 'no_protected_trait_inference'));
  assert.ok(OPPORTUNITY_DISPOSITIONS.includes('follow_up'));
  assert.equal(getAdapter('fairfax_plus')?.capabilities.discover, true);
  assert.equal(typeof getAdapter('fairfax_plus').discover, 'function');
});

test('discovery ≠ known-ID: blank workspace finds fixture activity', async () => {
  const permits = db.prepare(`SELECT COUNT(*) AS c FROM permit_records`).get().c;
  assert.equal(permits, 0, 'blank workspace');
  const empty = await searchOpportunities({});
  assert.equal(empty.status, 'failed');
  assert.equal(empty.error, 'criteria_required');

  const unsupported = await searchOpportunities({
    jurisdiction_code: 'loudoun_county',
    app_type_alias: 'Residential',
  });
  assert.equal(unsupported.status, 'unsupported');
  assert.equal(unsupported.results.length, 0);

  const hit = await searchOpportunities({
    jurisdiction_code: 'fairfax_county',
    app_type_alias: 'Residential',
    issued_from: '2026-09-01',
    issued_to: '2026-09-30',
  });
  assert.ok(['ok', 'partial'].includes(hit.status), hit.status);
  assert.ok(hit.results.length >= 2);
  assert.ok(hit.results.every((r) => r.intent_label === 'issued_activity'));
  assert.ok(hit.results.every((r) => r.companyEvidence == null));
  assert.ok(hit.results[0].match_reasons.some((m) => m.rule === 'app_type_alias_contains'));
});

test('save/dedupe, pipeline follow-up, link without inventing lot, export', async () => {
  const search = await searchOpportunities({
    app_type_alias: 'Residential',
    issued_from: '2026-09-01',
    issued_to: '2026-09-30',
  });
  const first = saveOpportunities(search.results);
  assert.ok(first.saved.length >= 2);
  const again = saveOpportunities(search.results);
  assert.equal(again.saved.length, 0);
  assert.ok(again.deduped.length >= 2);

  const list = listOpportunities();
  const opp = list[0];
  const updated = updateOpportunity(opp.id, {
    disposition: 'follow_up',
    assignee: 'LO Pilot',
    reason: 'Builder relationship — issued residential activity',
    next_action: 'Research GC / developer publicly',
    next_action_due: '2026-10-15',
  });
  assert.equal(updated.disposition, 'follow_up');
  assert.equal(updated.assignee, 'LO Pilot');

  await assert.rejects(
    async () => linkOpportunityToProject(opp.id, { permitRecordId: 999999 }),
    /not found|invent/i
  );
  const permit = insertImportPermit('BLDR-2026-01000');
  const linked = linkOpportunityToProject(opp.id, { permitRecordId: permit.id });
  assert.equal(linked.linked_permit_record_id, permit.id);
  assert.equal(linked.linked_lot_group_id, permit.lot_group_id);

  const buf = exportOpportunitiesXlsx({ ids: [opp.id] });
  assert.ok(Buffer.isBuffer(buf) || buf instanceof Uint8Array);
  assert.ok(buf.byteLength > 100);
});

test('dynamic search watermark + static list; grouping reversible', async () => {
  const dyn = saveSearch({
    name: 'Res Sept',
    kind: 'dynamic',
    criteria: {
      app_type_alias: 'Residential',
      issued_from: '2026-09-01',
      issued_to: '2026-09-30',
    },
    actor: 'owner',
  });
  markSearchReviewed(dyn.id);
  const ran = await runSavedSearch(dyn.id);
  assert.ok(ran.search?.last_reviewed_at);
  assert.ok(Array.isArray(ran.results));

  const all = listOpportunities();
  const staticSave = saveSearch({
    name: 'Static picks',
    kind: 'static_list',
    criteria: { official_ids: all.slice(0, 2).map((o) => o.official_id) },
  });
  const staticRun = await runSavedSearch(staticSave.id);
  assert.match(staticRun.message || '', /Static/i);

  const ids = all.map((o) => o.id);
  const proposed = proposeGroups({ opportunityIds: ids });
  assert.ok(proposed.groups.length >= 1, 'same parcel/address should group');
  const g = proposed.groups[0];
  assert.equal(g.link_status, 'proposed');
  const reviewed = reviewGroupLink(g.id, { status: 'reviewed' });
  assert.equal(reviewed.link_status, 'reviewed');
  const unlinked = reviewGroupLink(g.id, { status: 'unlinked' });
  assert.equal(unlinked.link_status, 'unlinked');
  const after = listOpportunities().filter((o) => o.group_id === g.id);
  assert.equal(after.length, 0);
});

test('discoverFairfaxPermits page cap ≤50', async () => {
  const r = await discoverFairfaxPermits({
    appTypeAlias: 'Residential',
    resultRecordCount: 200,
  });
  assert.equal(r.outcome, 'ok');
  assert.ok(r.features.length <= 50);
});

test('HTTP Gate 5: blank → search → save → follow-up → export', async () => {
  // Fresh-ish: wipe opportunities only; keep import permit from prior test
  db.exec('DELETE FROM opportunities');
  db.exec('DELETE FROM opportunity_groups');
  db.exec('DELETE FROM opportunity_searches');

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
      raw: text,
      headers: res.headers,
    };
  }

  try {
    let r = await api('POST', '/api/auth/login', {
      body: { email: 'owner@example.com', password: 'owner-password-10+' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const cookie = r.cookie;

    r = await api('GET', '/api/opportunities/coverage', { cookie });
    assert.equal(r.status, 200);
    assert.equal(r.data.shown_before_search, true);

    r = await api('POST', '/api/opportunities/search', {
      cookie,
      body: {
        app_type_alias: 'Residential',
        issued_from: '2026-09-01',
        issued_to: '2026-09-30',
      },
    });
    assert.equal(r.status, 200);
    assert.ok(['ok', 'partial', 'zero'].includes(r.data.status));
    assert.ok((r.data.results || []).length >= 1);

    r = await api('POST', '/api/opportunities/save', {
      cookie,
      body: { candidates: r.data.results },
    });
    assert.equal(r.status, 200);
    assert.ok(r.data.saved.length >= 1);
    const id = r.data.saved[0].id;

    r = await api('PATCH', `/api/opportunities/${id}`, {
      cookie,
      body: {
        disposition: 'follow_up',
        assignee: 'HTTP LO',
        next_action: 'Public research',
        next_action_due: '2026-10-20',
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.item.disposition, 'follow_up');

    const exp = await fetch(
      `${base}/api/opportunities-export.xlsx?selectedIds=${id}`,
      {
        headers: {
          Cookie: cookie,
          'X-Requested-With': 'PermitLedger',
          Origin: base,
        },
      }
    );
    assert.equal(exp.status, 200);
    assert.match(exp.headers.get('content-type') || '', /spreadsheetml/);
    assert.equal(exp.headers.get('x-opportunity-export-selected-count'), '1');
    const buf = Buffer.from(await exp.arrayBuffer());
    assert.ok(buf.length > 80);
  } finally {
    server.close();
  }
});

test('optional live Fairfax discover sample (network)', async (t) => {
  if (process.env.PERMIT_SKIP_LIVE === '1') {
    t.skip('PERMIT_SKIP_LIVE=1');
    return;
  }
  // Temporarily disable fixture for one live probe
  const prev = process.env.PERMIT_FAIRFAX_DISCOVER_FIXTURE;
  process.env.PERMIT_FAIRFAX_DISCOVER_FIXTURE = '0';
  try {
    const live = await discoverFairfaxPermits({
      appTypeAlias: 'Residential',
      issuedFrom: '2026-09-01',
      issuedTo: '2026-09-30',
      resultRecordCount: 5,
    });
    if (live.outcome === 'unavailable' || live.outcome === 'failed') {
      t.skip(`network/live unavailable: ${live.error || live.outcome}`);
      return;
    }
    assert.equal(live.outcome, 'ok');
    assert.ok(live.features.length <= 5);
    if (live.features.length) {
      assert.ok(live.features[0].officialId);
    }
  } finally {
    process.env.PERMIT_FAIRFAX_DISCOVER_FIXTURE = prev;
  }
});
