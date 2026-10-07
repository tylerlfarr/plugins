/**
 * Data-loss acceptance baseline — eligibility bypass OFF.
 * Reproduces: missing version reject, milestone/import stale collision,
 * jurisdiction confirm invalidation, ALTC q vs export parity, fixture reconcile.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

function cookieFrom(res) {
  return (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
}

async function waitHealth(base) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const h = await (await fetch(`${base}/api/health`)).json();
      if (h.ok) return h;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('health timeout');
}

async function withServer(fn) {
  const dbPath = path.join(os.tmpdir(), `dla-${Date.now()}-${Math.random()}.sqlite`);
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ok */
  }
  const port = 4500 + Math.floor(Math.random() * 200);
  const child = spawn('node', ['server/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PILOT_AUTH: '1',
      AUTO_SEED: '0',
      COOKIE_SECURE: '0',
      PERMIT_DB_PATH: dbPath,
      OWNER_EMAIL: 'owner@example.com',
      OWNER_PASSWORD: 'owner-password-10+',
      LISTEN_HOST: '127.0.0.1',
      PORT: String(port),
      TRACERFY_MODE: 'local_fixture',
      // Acceptance: bypass must stay off
      PERMIT_BYPASS_SOURCE_ELIGIBILITY: '0',
      PERMIT_TEST_HARNESS: '1',
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitHealth(base);
    await fn(base);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ok */
    }
  }
}

async function api(base, method, p, { body, cookie, formData } = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: {
      ...(formData ? {} : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      'X-Requested-With': 'PermitLedger',
      Origin: base,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: formData || (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, cookie: cookieFrom(res) || cookie };
}

async function loginImport(base) {
  let r = await api(base, 'POST', '/api/auth/login', {
    body: { email: 'owner@example.com', password: 'owner-password-10+' },
  });
  const cookie = r.cookie;
  const { buildSanitizedWorkbookBuffer } = await import('../fixtures/buildSanitizedWorkbook.js');
  const fd = new FormData();
  fd.append('file', new Blob([buildSanitizedWorkbookBuffer()]), 'sanitized.xlsx');
  r = await api(base, 'POST', '/api/import/workbook/commit', { cookie, formData: fd });
  assert.equal(r.status, 200);
  return cookie;
}

test('committed sanitized fixture matches builder (sections + Fairfax ID)', async () => {
  const { buildSanitizedWorkbookBuffer } = await import('../fixtures/buildSanitizedWorkbook.js');
  const { parseWorkbookBuffer } = await import('../workbookImport.js');
  const committedPath = path.join(root, 'server/fixtures/sanitized-source-workbook.xlsx');
  const committed = parseWorkbookBuffer(fs.readFileSync(committedPath));
  const generated = parseWorkbookBuffer(buildSanitizedWorkbookBuffer());
  assert.equal(committed.permitTracker.sections.length, generated.permitTracker.sections.length);
  assert.equal(committed.permitTracker.rows.length, generated.permitTracker.rows.length);
  const ids = (parsed) =>
    parsed.permitTracker.rows.flatMap((row) => row.official_ids || []).sort();
  assert.deepEqual(ids(committed), ids(generated));
  assert.ok(ids(generated).includes('BLDR-2026-00263'));
});

test('missing expected_row_version rejected; timestamp fallback gone', async () => {
  await withServer(async (base) => {
    const cookie = await loginImport(base);
    const list = await api(base, 'GET', '/api/permits', { cookie });
    const permit = list.data.permits[0];
    const missing = await api(base, 'PATCH', `/api/permits/${permit.id}`, {
      cookie,
      body: { owner: 'no-version', expected_updated_at: permit.updated_at },
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.data.error, 'expected_row_version_required');
  });
});

test('re-import bumps version; stale milestone Save returns 409', async () => {
  await withServer(async (base) => {
    const cookie = await loginImport(base);
    const list = await api(base, 'GET', '/api/permits', { cookie });
    const permit = list.data.permits.find((p) => p.primary_official_id) || list.data.permits[0];
    const detail = await api(base, 'GET', `/api/permits/${permit.id}`, { cookie });
    const v0 = detail.data.permit.row_version;

    const save1 = await api(base, 'PATCH', `/api/permits/${permit.id}`, {
      cookie,
      body: {
        milestones: [{ key: 'dla_keep', label: 'DLA', value: 'before-reimport' }],
        expected_row_version: v0,
      },
    });
    assert.equal(save1.status, 200);
    const v1 = save1.data.permit.row_version;
    assert.ok(Number(v1) > Number(v0));

    const { buildSanitizedWorkbookBuffer } = await import('../fixtures/buildSanitizedWorkbook.js');
    const fd = new FormData();
    fd.append('file', new Blob([buildSanitizedWorkbookBuffer()]), 'sanitized.xlsx');
    const re = await api(base, 'POST', '/api/import/workbook/commit', { cookie, formData: fd });
    assert.equal(re.status, 200);

    const after = await api(base, 'GET', `/api/permits/${permit.id}`, { cookie });
    assert.ok(Number(after.data.permit.row_version) > Number(v1));

    const stale = await api(base, 'PATCH', `/api/permits/${permit.id}`, {
      cookie,
      body: {
        milestones: [{ key: 'dla_keep', label: 'DLA', value: 'stale-overwrite' }],
        expected_row_version: v1,
      },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error, 'stale_write');
    const ms = (await api(base, 'GET', `/api/permits/${permit.id}`, { cookie })).data.milestones;
    const keep = ms.find((m) => m.key === 'dla_keep');
    assert.equal(keep?.value, 'before-reimport');
  });
});

test('jurisdiction change clears confirmation and blocks live check', async () => {
  await withServer(async (base) => {
    const cookie = await loginImport(base);
    const list = await api(base, 'GET', '/api/permits?jurisdiction_code=fairfax_county', { cookie });
    const ffx = list.data.permits[0];
    assert.ok(ffx);
    let detail = await api(base, 'GET', `/api/permits/${ffx.id}`, { cookie });
    await api(base, 'PATCH', `/api/permits/${ffx.id}`, {
      cookie,
      body: {
        jurisdiction_confirmed: true,
        expected_row_version: detail.data.permit.row_version,
      },
    });
    await api(base, 'POST', '/api/sources/fairfax_county_building_records_plus/activate', {
      cookie,
      body: { reviewedBy: 'dla' },
    });
    detail = await api(base, 'GET', `/api/permits/${ffx.id}`, { cookie });
    assert.equal(detail.data.permit.jurisdiction_confirmed, 1);

    const changed = await api(base, 'PATCH', `/api/permits/${ffx.id}`, {
      cookie,
      body: {
        jurisdiction_code: 'loudoun_county',
        jurisdiction_confirmed: true, // must be ignored when code changes
        expected_row_version: detail.data.permit.row_version,
      },
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.data.permit.jurisdiction_code, 'loudoun_county');
    assert.equal(changed.data.permit.jurisdiction_confirmed, 0);

    const check = await api(base, 'POST', `/api/sync/${ffx.id}`, { cookie, body: {} });
    assert.equal(check.data.result.outcome, 'blocked');
  });
});

test('ALTC search (q) list and export agree on exact IDs', async () => {
  await withServer(async (base) => {
    const cookie = await loginImport(base);
    const list = await api(base, 'GET', '/api/permits?q=ALTC', { cookie });
    const listIds = (list.data.permits || []).map((p) => p.id).sort((a, b) => a - b);
    assert.ok(listIds.length >= 1);
    assert.ok((list.data.permits || []).every((p) => String(p.primary_official_id || '').includes('ALTC')));

    const expRes = await fetch(`${base}/api/export.xlsx?q=ALTC`, {
      headers: { Cookie: cookie, 'X-Requested-With': 'PermitLedger', Origin: base },
    });
    assert.equal(expRes.status, 200);
    const { inspectExportBuffer } = await import('../excelExport.js');
    const insp = inspectExportBuffer(Buffer.from(await expRes.arrayBuffer()));
    const exportIds = insp.permits.map((p) => p.id).sort((a, b) => a - b);
    assert.deepEqual(exportIds, listIds);
    assert.ok(exportIds.every((id) => Number.isFinite(id)));
  });
});

test('production rejects eligibility bypass without test harness', async () => {
  const { assertPilotAuthConfig } = await import('../auth.js');
  const prev = {
    NODE_ENV: process.env.NODE_ENV,
    BYPASS: process.env.PERMIT_BYPASS_SOURCE_ELIGIBILITY,
    HARNESS: process.env.PERMIT_TEST_HARNESS,
    PILOT: process.env.PILOT_AUTH,
  };
  process.env.NODE_ENV = 'production';
  process.env.PERMIT_BYPASS_SOURCE_ELIGIBILITY = '1';
  delete process.env.PERMIT_TEST_HARNESS;
  process.env.PILOT_AUTH = '0'; // avoid owner bootstrap path after bypass check
  assert.throws(() => assertPilotAuthConfig(), /PERMIT_BYPASS_SOURCE_ELIGIBILITY/);
  process.env.NODE_ENV = prev.NODE_ENV;
  process.env.PERMIT_BYPASS_SOURCE_ELIGIBILITY = prev.BYPASS;
  if (prev.HARNESS == null) delete process.env.PERMIT_TEST_HARNESS;
  else process.env.PERMIT_TEST_HARNESS = prev.HARNESS;
  process.env.PILOT_AUTH = prev.PILOT;
});
