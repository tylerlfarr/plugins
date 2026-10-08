/**
 * Evaluation-addendum regressions: stale writes, source eligibility, export scope,
 * Fairfax ambiguity, empty export headers, workbook availability signal.
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

async function withServer(envExtra, fn) {
  const dbPath = path.join(os.tmpdir(), `eval-addendum-${Date.now()}-${Math.random()}.sqlite`);
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ok */
  }
  const port = 4300 + Math.floor(Math.random() * 200);
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
      // Enforce eligibility in these tests unless overridden
      PERMIT_BYPASS_SOURCE_ELIGIBILITY: '0',
      PERMIT_TEST_HARNESS: '1',
      ...envExtra,
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
      ...(formData
        ? {}
        : body !== undefined
          ? { 'Content-Type': 'application/json' }
          : {}),
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

test('stale detail Save cannot reverse bulk update (409)', async () => {
  await withServer({ PERMIT_BYPASS_SOURCE_ELIGIBILITY: '1' }, async (base) => {
    let r = await api(base, 'POST', '/api/auth/login', {
      body: { email: 'owner@example.com', password: 'owner-password-10+' },
    });
    const cookie = r.cookie;
    const { buildSanitizedWorkbookBuffer } = await import('../fixtures/buildSanitizedWorkbook.js');
    const buf = buildSanitizedWorkbookBuffer();
    const fd = new FormData();
    fd.append('file', new Blob([buf]), 'sanitized.xlsx');
    r = await api(base, 'POST', '/api/import/workbook/commit', { cookie, formData: fd });
    assert.equal(r.status, 200);

    r = await api(base, 'GET', '/api/permits', { cookie });
    const permit = (r.data.permits || []).find((p) => p.primary_official_id);
    assert.ok(permit);
    const detail = await api(base, 'GET', `/api/permits/${permit.id}`, { cookie });
    const staleVersion = detail.data.permit.row_version ?? 1;

    const bulk = await api(base, 'POST', '/api/permits/bulk', {
      cookie,
      body: {
        ids: [permit.id],
        patch: { internal_status: 'needs_followup', owner: 'QA bulk owner' },
      },
    });
    assert.equal(bulk.status, 200);
    assert.ok(bulk.data.changed >= 1);
    assert.ok(Number(bulk.data.permits[0].row_version) > Number(staleVersion));

    const stale = await api(base, 'PATCH', `/api/permits/${permit.id}`, {
      cookie,
      body: {
        internal_status: 'watching',
        owner: 'stale form',
        expected_row_version: staleVersion,
      },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error, 'stale_write');
    assert.equal(stale.data.permit.internal_status, 'needs_followup');
    assert.equal(stale.data.permit.owner, 'QA bulk owner');

    const fresh = await api(base, 'GET', `/api/permits/${permit.id}`, { cookie });
    const ok = await api(base, 'PATCH', `/api/permits/${permit.id}`, {
      cookie,
      body: {
        next_action: 'Call AHJ',
        expected_row_version: fresh.data.permit.row_version,
      },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.permit.internal_status, 'needs_followup');
    assert.equal(ok.data.permit.next_action, 'Call AHJ');
  });
});

test('source eligibility blocks live check until activated + confirmed', async () => {
  await withServer({}, async (base) => {
    let r = await api(base, 'POST', '/api/auth/login', {
      body: { email: 'owner@example.com', password: 'owner-password-10+' },
    });
    const cookie = r.cookie;
    const { buildSanitizedWorkbookBuffer } = await import('../fixtures/buildSanitizedWorkbook.js');
    const fd = new FormData();
    fd.append('file', new Blob([buildSanitizedWorkbookBuffer()]), 'sanitized.xlsx');
    await api(base, 'POST', '/api/import/workbook/commit', { cookie, formData: fd });

    r = await api(base, 'GET', '/api/permits?jurisdiction_code=fairfax_county', { cookie });
    const ffx = (r.data.permits || [])[0];
    assert.ok(ffx, 'fairfax sample present');
    assert.equal(ffx.jurisdiction_confirmed, 0);

    const blocked = await api(base, 'POST', `/api/sync/${ffx.id}`, { cookie, body: {} });
    assert.equal(blocked.status, 200);
    assert.equal(blocked.data.result.outcome, 'blocked');
    assert.match(blocked.data.result.error || '', /confirm|activated|Jurisdiction/i);

    // Confirm alone (source not activated) → still blocked
    let detail = await api(base, 'GET', `/api/permits/${ffx.id}`, { cookie });
    await api(base, 'PATCH', `/api/permits/${ffx.id}`, {
      cookie,
      body: {
        jurisdiction_confirmed: true,
        expected_row_version: detail.data.permit.row_version,
      },
    });
    const stillBlocked = await api(base, 'POST', `/api/sync/${ffx.id}`, { cookie, body: {} });
    assert.equal(stillBlocked.data.result.outcome, 'blocked');
    assert.match(stillBlocked.data.result.error || '', /not activated/i);

    const act = await api(base, 'POST', '/api/sources/fairfax_county_building_records_plus/activate', {
      cookie,
      body: { reviewedBy: 'eval.test' },
    });
    assert.equal(act.status, 200, JSON.stringify(act.data));

    const live = await api(base, 'POST', `/api/sync/${ffx.id}`, { cookie, body: {} });
    assert.ok(
      ['updated', 'no_change', 'not_found'].includes(live.data.result.outcome),
      JSON.stringify(live.data.result)
    );
    assert.equal(live.data.result.mode, 'live');
  });
});

test('export filter scopes Attention; empty export keeps headers; permit_record_id present', async () => {
  await withServer({ PERMIT_BYPASS_SOURCE_ELIGIBILITY: '1' }, async (base) => {
    let r = await api(base, 'POST', '/api/auth/login', {
      body: { email: 'owner@example.com', password: 'owner-password-10+' },
    });
    const cookie = r.cookie;
    const emptyRes = await fetch(`${base}/api/export.xlsx`, {
      headers: { Cookie: cookie, 'X-Requested-With': 'PermitLedger', Origin: base },
    });
    const emptyBuf = Buffer.from(await emptyRes.arrayBuffer());
    const { inspectExportBuffer } = await import('../excelExport.js');
    const emptyInsp = inspectExportBuffer(emptyBuf);
    assert.ok(emptyInsp.sheetNames.includes('Permit Tracker Export'));
    assert.ok(emptyInsp.emptyPermitHeaders || emptyInsp.permits.length === 0);

    const { buildSanitizedWorkbookBuffer } = await import('../fixtures/buildSanitizedWorkbook.js');
    const fd = new FormData();
    fd.append('file', new Blob([buildSanitizedWorkbookBuffer()]), 'sanitized.xlsx');
    await api(base, 'POST', '/api/import/workbook/commit', { cookie, formData: fd });

    const list = await api(base, 'GET', '/api/permits?use_classification=unknown', { cookie });
    const unknownIds = new Set((list.data.permits || []).map((p) => p.id));
    const expRes = await fetch(`${base}/api/export.xlsx?use_classification=unknown`, {
      headers: { Cookie: cookie, 'X-Requested-With': 'PermitLedger', Origin: base },
    });
    const insp = inspectExportBuffer(Buffer.from(await expRes.arrayBuffer()));
    assert.equal(insp.permits.length, unknownIds.size);
    assert.ok(insp.permits.every((p) => unknownIds.has(p.id) && Number.isFinite(p.id)));
    assert.ok(insp.sheetNames.some((n) => n.includes('workbook')));
  });
});

test('bare Fairfax county input is ambiguous; Fairfax County resolves', async () => {
  const { connectLocation } = await import('../sources/connectLocation.js');
  const amb = await connectLocation({ state: 'VA', county: 'Fairfax', record_type: 'building' });
  assert.equal(amb.ambiguousFairfax, true);
  assert.match((amb.namedLimits || []).join(' '), /ambiguous/i);

  const ok = await connectLocation({
    state: 'VA',
    county: 'Fairfax County',
    record_type: 'building',
  });
  assert.equal(ok.ambiguousFairfax, false);
  assert.equal(ok.input.jurisdiction_code, 'fairfax_county');
});

test('meta reports store workbook availability false when unset', async () => {
  await withServer({ SOURCE_WORKBOOK_XLSX: '', GOSPEL_XLSX: '' }, async (base) => {
    let r = await api(base, 'POST', '/api/auth/login', {
      body: { email: 'owner@example.com', password: 'owner-password-10+' },
    });
    const meta = await api(base, 'GET', '/api/meta', { cookie: r.cookie });
    assert.equal(meta.data.storeWorkbookAvailable, false);
    assert.equal(meta.data.simulateFailureEnabled, false);
  });
});
