/**
 * Phase 2 / 3: workspace membership, authz on admin writes, no-lot / multi-permit,
 * zero-row import reject, incomplete masterfile surface, preview actor bind.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import XLSX from 'xlsx';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permit-p23-'));
process.env.PERMIT_DB_PATH = path.join(tmpDir, 'phase23.sqlite');
process.env.PERMIT_DEMO = '0';
process.env.AUTO_SEED = '0';
process.env.PILOT_AUTH = '1';
process.env.PERMIT_NO_LISTEN = '1';
process.env.COOKIE_SECURE = '0';
process.env.OWNER_EMAIL = 'owner@example.com';
process.env.OWNER_PASSWORD = 'owner-password-10+';
process.env.OWNER_DISPLAY_NAME = 'Owner';
process.env.BUSINESS_NAME = 'Phase23 Pilot Co';
process.env.TRACERFY_MODE = 'local_fixture';
process.env.PERMIT_TEST_HARNESS = '1';
process.env.PERMIT_BYPASS_SOURCE_ELIGIBILITY = '1';
delete process.env.TRACERFY_API_TOKEN;
delete process.env.NODE_ENV;

const { app } = await import('../index.js');
const { db, migrate } = await import('../db.js');
const { buildSanitizedWorkbookBuffer } = await import('../fixtures/buildSanitizedWorkbook.js');
const { parseWorkbookBuffer, assertRecognizedWorkbook, commitWorkbookParse } = await import(
  '../workbookImport.js'
);
const { getUserWorkspace, listIncompleteMasterfileRows } = await import('../workspace.js');

migrate();

function listen() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const base = `http://127.0.0.1:${port}`;
      resolve({
        server,
        base,
        async request(method, urlPath, { body, headers = {}, cookie, rawBody, formData } = {}) {
          const opts = {
            method,
            headers: {
              ...(cookie ? { Cookie: cookie } : {}),
              ...headers,
            },
          };
          if (formData) {
            opts.body = formData;
          } else if (rawBody !== undefined) {
            opts.body = rawBody;
          } else if (body !== undefined) {
            opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json';
            opts.body = JSON.stringify(body);
          }
          const res = await fetch(`${base}${urlPath}`, opts);
          const setCookie = res.headers.getSetCookie?.() || [];
          const text = await res.text();
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }
          return { status: res.status, data, setCookie, headers: res.headers };
        },
      });
    });
  });
}

function cookieFrom(setCookie) {
  return setCookie.map((c) => c.split(';')[0]).join('; ');
}

async function ownerSession(client) {
  const login = await client.request('POST', '/api/auth/login', {
    body: { email: 'owner@example.com', password: 'owner-password-10+' },
    headers: { 'X-Requested-With': 'PermitLedger', Origin: client.base },
  });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  return cookieFrom(login.setCookie);
}

let opSeq = 0;
async function operatorSession(client, ownerCookie) {
  opSeq += 1;
  const email = `op.phase23.${opSeq}@example.com`;
  const password = 'operator-pass-10+';
  const created = await client.request('POST', '/api/auth/users', {
    body: {
      email,
      password,
      displayName: `Op Phase23 ${opSeq}`,
      role: 'operator',
    },
    cookie: ownerCookie,
    headers: { 'X-Requested-With': 'PermitLedger', Origin: client.base },
  });
  assert.ok([200, 201].includes(created.status), JSON.stringify(created.data));
  const login = await client.request('POST', '/api/auth/login', {
    body: { email, password },
    headers: { 'X-Requested-With': 'PermitLedger', Origin: client.base },
  });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  return { cookie: cookieFrom(login.setCookie), email };
}

test('workspace: owner and operator enrolled in default single-tenant workspace', async () => {
  const client = await listen();
  try {
    const ownerCookie = await ownerSession(client);
    const meta = await client.request('GET', '/api/meta', { cookie: ownerCookie });
    assert.equal(meta.status, 200);
    assert.equal(meta.data.workspaceIsolation, 'single_db');
    assert.equal(meta.data.workspace?.org_key, 'default');
    assert.equal(meta.data.authUser?.workspace?.org_key, 'default');

    const ws = await client.request('GET', '/api/workspace', { cookie: ownerCookie });
    assert.equal(ws.status, 200);
    assert.equal(ws.data.isolation, 'single_db');
    assert.match(String(ws.data.note || ''), /one database file/i);

    const { cookie: opCookie, email: opEmail } = await operatorSession(client, ownerCookie);
    const opMeta = await client.request('GET', '/api/meta', { cookie: opCookie });
    assert.equal(opMeta.status, 200);
    assert.equal(opMeta.data.authUser.role, 'operator');
    assert.equal(opMeta.data.authUser.workspace?.org_key, 'default');

    const ownerRow = db.prepare(`SELECT id FROM users WHERE email = ?`).get('owner@example.com');
    const opRow = db.prepare(`SELECT id FROM users WHERE email = ?`).get(opEmail);
    assert.ok(getUserWorkspace(ownerRow.id));
    assert.ok(getUserWorkspace(opRow.id));
    assert.equal(getUserWorkspace(ownerRow.id).id, getUserWorkspace(opRow.id).id);
  } finally {
    client.server.close();
  }
});

test('authz: unauthenticated blocked on permit/export; operator denied readiness PUT; owner allowed', async () => {
  const client = await listen();
  try {
    const deniedPermit = await client.request('GET', '/api/permits/1');
    assert.equal(deniedPermit.status, 401);
    const deniedExport = await client.request('GET', '/api/export.xlsx');
    assert.equal(deniedExport.status, 401);
    const deniedSync = await client.request('POST', '/api/sync', {
      body: {},
      headers: { 'X-Requested-With': 'PermitLedger', Origin: client.base },
    });
    assert.equal(deniedSync.status, 401);

    const ownerCookie = await ownerSession(client);
    const { cookie: opCookie } = await operatorSession(client, ownerCookie);

    const opPut = await client.request('PUT', '/api/readiness/rules', {
      body: { approachingStartDays: 99 },
      cookie: opCookie,
      headers: { 'X-Requested-With': 'PermitLedger', Origin: client.base },
    });
    assert.equal(opPut.status, 403, JSON.stringify(opPut.data));

    const opRebuild = await client.request('POST', '/api/readiness/rebuild', {
      body: {},
      cookie: opCookie,
      headers: { 'X-Requested-With': 'PermitLedger', Origin: client.base },
    });
    assert.equal(opRebuild.status, 403);

    const ownerPut = await client.request('PUT', '/api/readiness/rules', {
      body: { approachingStartDays: 33 },
      cookie: ownerCookie,
      headers: { 'X-Requested-With': 'PermitLedger', Origin: client.base },
    });
    assert.equal(ownerPut.status, 200, JSON.stringify(ownerPut.data));
    assert.equal(ownerPut.data.ruleset.approachingStartDays, 33);

    // Operator can still read rules and hit permit list (full-org peer)
    const rules = await client.request('GET', '/api/readiness/rules', { cookie: opCookie });
    assert.equal(rules.status, 200);
    const permits = await client.request('GET', '/api/permits', { cookie: opCookie });
    assert.equal(permits.status, 200);
  } finally {
    client.server.close();
  }
});

test('no-lot + multi-permit: import persists (no lot) sentinel and shared lot_group', () => {
  const buf = buildSanitizedWorkbookBuffer();
  const parsed = parseWorkbookBuffer(buf);
  assertRecognizedWorkbook(parsed, 'sanitized.xlsx');

  const noLotRows = parsed.permitTracker.rows.filter((r) => r.lot_label === '(no lot)');
  assert.ok(noLotRows.length >= 1, 'expected at least one (no lot) row');
  assert.ok(noLotRows.some((r) => r.primary_official_id === 'ALTC-2026-88001'));

  const multi = parsed.permitTracker.rows.filter((r) => r.lot_label === '88' && r.is_multi);
  assert.equal(multi.length, 2);
  assert.deepEqual(
    multi.map((r) => r.primary_official_id).sort(),
    ['ALTC-2026-88011', 'ALTC-2026-88012']
  );
  assert.equal(multi[0].stable_key, multi[1].stable_key);

  const summary = commitWorkbookParse(parsed, { changedBy: 'phase23.test' });
  assert.ok(summary.sections_skipped_empty >= 1, 'empty trailing section skipped');

  const noLotDb = db
    .prepare(
      `SELECT p.id, p.primary_official_id, lg.lot_label, lg.id AS lot_id
       FROM permit_records p
       JOIN lot_groups lg ON lg.id = p.lot_group_id
       WHERE lg.lot_label = '(no lot)' AND p.primary_official_id = 'ALTC-2026-88001'`
    )
    .get();
  assert.ok(noLotDb, 'persisted no-lot permit');
  assert.equal(noLotDb.lot_label, '(no lot)');

  const multiDb = db
    .prepare(
      `SELECT p.primary_official_id, p.lot_group_id
       FROM permit_records p
       JOIN lot_groups lg ON lg.id = p.lot_group_id
       WHERE lg.lot_label = '88' AND p.primary_official_id LIKE 'ALTC-2026-8801%'
       ORDER BY p.primary_official_id`
    )
    .all();
  assert.equal(multiDb.length, 2);
  assert.equal(multiDb[0].lot_group_id, multiDb[1].lot_group_id);
});

test('zero recognized rows rejected with readable code', () => {
  const wb = XLSX.utils.book_new();
  const pt = [
    ['Proj ID', 'Lot', 'Housetype', 'Permit Release', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ['EMPTY1', 'ID', '', 'Release', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(pt), 'Permit Tracker');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const parsed = parseWorkbookBuffer(buf);
  assert.equal(parsed.permitTracker.rows.length, 0);
  assert.throws(
    () => assertRecognizedWorkbook(parsed, 'empty-sections.xlsx'),
    (err) => err.code === 'zero_recognized_rows'
  );
});

test('incomplete masterfile listed on Attention with exact missing fields', async () => {
  const buf = buildSanitizedWorkbookBuffer();
  const parsed = parseWorkbookBuffer(buf);
  commitWorkbookParse(parsed, { changedBy: 'phase23.mf' });

  const incomplete = listIncompleteMasterfileRows();
  assert.ok(incomplete.length >= 1);
  assert.ok(incomplete.every((r) => r.incomplete));
  assert.ok(incomplete.some((r) => (r.missing || []).includes('date_approved')));

  const client = await listen();
  try {
    const cookie = await ownerSession(client);
    const att = await client.request('GET', '/api/attention', { cookie });
    assert.equal(att.status, 200);
    assert.ok(Array.isArray(att.data.incompleteMasterfile));
    assert.ok(att.data.incompleteMasterfile.length >= 1);
    assert.ok(Array.isArray(att.data.openRevisions));
    assert.ok(att.data.openRevisions.length >= 1);
    assert.ok(Array.isArray(att.data.revisionImpacted));
  } finally {
    client.server.close();
  }
});

test('preview commit binds actor — other user cannot commit foreign previewId', async () => {
  const client = await listen();
  try {
    const ownerCookie = await ownerSession(client);
    const { cookie: opCookie } = await operatorSession(client, ownerCookie);
    const buf = buildSanitizedWorkbookBuffer();

    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'sanitized.xlsx');
    const preview = await client.request('POST', '/api/import/workbook/preview', {
      formData: fd,
      cookie: ownerCookie,
      headers: { 'X-Requested-With': 'PermitLedger', Origin: client.base },
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    assert.ok(preview.data.previewId);

    const commitFd = new FormData();
    commitFd.append('previewId', preview.data.previewId);
    const denied = await client.request('POST', '/api/import/workbook/commit', {
      formData: commitFd,
      cookie: opCookie,
      headers: { 'X-Requested-With': 'PermitLedger', Origin: client.base },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.code, 'preview_actor_mismatch');

    // Owner can still commit after re-preview
    const fd2 = new FormData();
    fd2.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'sanitized.xlsx');
    const preview2 = await client.request('POST', '/api/import/workbook/preview', {
      formData: fd2,
      cookie: ownerCookie,
      headers: { 'X-Requested-With': 'PermitLedger', Origin: client.base },
    });
    const commitFd2 = new FormData();
    commitFd2.append('previewId', preview2.data.previewId);
    const ok = await client.request('POST', '/api/import/workbook/commit', {
      formData: commitFd2,
      cookie: ownerCookie,
      headers: { 'X-Requested-With': 'PermitLedger', Origin: client.base },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
  } finally {
    client.server.close();
  }
});
