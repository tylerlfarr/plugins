/**
 * Disposable-data private-trial rehearsal (HTTP).
 * Spawns the app twice against the same DB to prove restart persistence.
 *
 * Usage (from permit-tracker/):
 *   node server/scripts/private-trial-e2e.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSanitizedWorkbookBuffer } from '../fixtures/buildSanitizedWorkbook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '../..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permit-e2e-'));
const dbPath = path.join(tmpDir, 'trial.sqlite');
const port = 4311 + Math.floor(Math.random() * 200);
const ownerEmail = 'owner@example.com';
const ownerPassword = 'owner-password-10+';
const operatorEmail = 'operator@example.com';
const operatorPassword = 'operator-pass-10+';

const results = [];
function log(step, ok, detail = '') {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ` — ${detail}` : ''}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function startServer({ includeOwnerBootstrap = true } = {}) {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PILOT_AUTH: '1',
    AUTO_SEED: '0',
    COOKIE_SECURE: '0',
    PERMIT_DB_PATH: dbPath,
    LISTEN_HOST: '127.0.0.1',
    PORT: String(port),
    TRACERFY_MODE: 'local_fixture',
    PERMIT_TEST_HARNESS: '1',
  };
  delete env.TRACERFY_API_TOKEN;
  if (includeOwnerBootstrap) {
    env.OWNER_EMAIL = ownerEmail;
    env.OWNER_PASSWORD = ownerPassword;
    env.OWNER_DISPLAY_NAME = 'Owner';
    env.BUSINESS_NAME = 'Disposable E2E Co';
  } else {
    delete env.OWNER_EMAIL;
    delete env.OWNER_PASSWORD;
    delete env.OWNER_DISPLAY_NAME;
  }
  const child = spawn('node', ['server/index.js'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => {
    output += d.toString();
  });
  child.stderr.on('data', (d) => {
    output += d.toString();
  });
  return { child, getOutput: () => output };
}

async function waitReady(base, attempts = 50) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`);
      const data = await res.json();
      if (data.ok) return data;
    } catch {
      /* retry */
    }
    await sleep(150);
  }
  throw new Error('server did not become healthy');
}

function cookieFrom(res) {
  const list = res.headers.getSetCookie?.() || [];
  return list.map((c) => c.split(';')[0]).join('; ');
}

async function api(base, method, urlPath, { body, cookie, formData } = {}) {
  const res = await fetch(`${base}${urlPath}`, {
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
  return { status: res.status, data, cookie: cookieFrom(res), res };
}

async function runSession() {
  const base = `http://127.0.0.1:${port}`;
  const { child, getOutput } = startServer({ includeOwnerBootstrap: true });
  try {
    const health = await waitReady(base);
    log(
      'process health + release id',
      health.ok === true && Boolean(health.release?.gitShaShort || health.release?.version),
      JSON.stringify(health)
    );

    const unauth = await api(base, 'GET', '/api/meta');
    log('API fail-closed without session', unauth.status === 401);

    const login = await api(base, 'POST', '/api/auth/login', {
      body: { email: ownerEmail, password: ownerPassword },
    });
    log('owner login', login.status === 200 && login.data.user?.role === 'owner');
    const ownerCookie = login.cookie;

    const details = await api(base, 'GET', '/api/health/details', { cookie: ownerCookie });
    log(
      'owner health details',
      details.status === 200 && details.data.dbPath === dbPath && details.data.auth === true
    );

    const created = await api(base, 'POST', '/api/auth/users', {
      cookie: ownerCookie,
      body: {
        email: operatorEmail,
        password: operatorPassword,
        displayName: 'Operator',
        role: 'operator',
      },
    });
    log(
      'owner create trial operator',
      created.status === 201 && created.data.user?.role === 'operator'
    );

    const opLogin = await api(base, 'POST', '/api/auth/login', {
      body: { email: operatorEmail, password: operatorPassword },
    });
    log('operator login', opLogin.status === 200 && opLogin.data.user?.role === 'operator');
    const opCookie = opLogin.cookie;

    const opCreateDenied = await api(base, 'POST', '/api/auth/users', {
      cookie: opCookie,
      body: { email: 'x@example.com', password: 'xxxxx-pass-10+' },
    });
    log('operator cannot create users', opCreateDenied.status === 403);

    const opActivateDenied = await api(
      base,
      'POST',
      '/api/sources/fairfax_county_building_records_plus/activate',
      { cookie: opCookie, body: { reviewedBy: 'op' } }
    );
    log('operator cannot activate sources', opActivateDenied.status === 403);

    const buf = buildSanitizedWorkbookBuffer();
    const previewFd = new FormData();
    previewFd.append('file', new Blob([buf]), 'sanitized.xlsx');
    const preview = await api(base, 'POST', '/api/import/workbook/preview', {
      cookie: ownerCookie,
      formData: previewFd,
    });
    log('workbook preview', preview.status === 200 && preview.data.sectionCount >= 1);

    const commitFd = new FormData();
    commitFd.append('file', new Blob([buf]), 'sanitized.xlsx');
    const commit = await api(base, 'POST', '/api/import/workbook/commit', {
      cookie: ownerCookie,
      formData: commitFd,
    });
    log(
      'workbook import',
      commit.status === 200 && (commit.data.summary?.permits_created || 0) >= 1,
      JSON.stringify(commit.data.summary || {})
    );

    const permits = await api(base, 'GET', '/api/permits', { cookie: ownerCookie });
    const first = permits.data.permits?.[0];
    log('list permits', permits.status === 200 && Boolean(first), `n=${permits.data.permits?.length || 0}`);
    if (!first) throw new Error('no permits after import');

    const milestoneKey = 'e2e_keep_me';
    const beforeEdit = await api(base, 'GET', `/api/permits/${first.id}`, { cookie: ownerCookie });
    const edited = await api(base, 'PATCH', `/api/permits/${first.id}`, {
      cookie: ownerCookie,
      body: {
        milestones: [{ key: milestoneKey, label: 'E2E Keep', value: 'survive-reimport' }],
        expected_row_version: beforeEdit.data.permit?.row_version ?? 1,
      },
    });
    log(
      'edit milestone',
      edited.status === 200,
      edited.status !== 200 ? JSON.stringify(edited.data).slice(0, 200) : ''
    );

    const reFd = new FormData();
    reFd.append('file', new Blob([buf]), 'sanitized.xlsx');
    await api(base, 'POST', '/api/import/workbook/commit', {
      cookie: ownerCookie,
      formData: reFd,
    });
    const detail = await api(base, 'GET', `/api/permits/${first.id}`, { cookie: ownerCookie });
    const kept = (detail.data.milestones || []).find((m) => m.key === milestoneKey);
    log(
      'milestone survives re-import',
      kept?.value === 'survive-reimport',
      kept ? JSON.stringify(kept) : 'missing'
    );

    for (const use of ['residential', 'commercial', 'unknown']) {
      const filtered = await api(base, 'GET', `/api/permits?use_classification=${use}`, {
        cookie: ownerCookie,
      });
      log(`filter use=${use}`, filtered.status === 200, `n=${filtered.data.permits?.length ?? 'err'}`);
    }

    const unknownList = await api(base, 'GET', '/api/permits?use_classification=unknown', {
      cookie: ownerCookie,
    });
    const unknownIds = new Set((unknownList.data.permits || []).map((p) => p.id));
    const expFiltered = await fetch(`${base}/api/export.xlsx?use_classification=unknown`, {
      headers: { Cookie: ownerCookie, 'X-Requested-With': 'PermitLedger', Origin: base },
    });
    const expFilteredBuf = Buffer.from(await expFiltered.arrayBuffer());
    try {
      const { inspectExportBuffer } = await import('../excelExport.js');
      const inspected = inspectExportBuffer(expFilteredBuf);
      const exportAgrees =
        inspected.permits.length === unknownIds.size &&
        inspected.permits.every((p) => unknownIds.has(p.id));
      log(
        'export agrees with use=unknown filter',
        exportAgrees,
        `list=${unknownIds.size} exportRows=${inspected.permits.length} contactOrigins=${(inspected.contactOrigins || []).join(',') || 'none'}`
      );
    } catch (e) {
      log('export agrees with use=unknown filter', false, String(e.message || e));
    }

    const sync = await api(base, 'POST', `/api/sync/${first.id}`, { cookie: ownerCookie, body: {} });
    const syncJson = JSON.stringify(sync.data?.result || sync.data).slice(0, 220);
    log('permit check returns outcome', sync.status === 200, syncJson);

    const demo = await api(base, 'POST', '/api/properties/demo-sandbox', {
      cookie: ownerCookie,
      body: { permit_record_id: first.id, lot_group_id: first.lot_group_id },
    });
    log(
      'invented demo property (confirmed)',
      demo.status === 200 && demo.data.property?.record_origin === 'sandbox_demo',
      `property=${demo.data.property?.id}`
    );

    const find = await api(base, 'POST', '/api/contacts/find', {
      cookie: ownerCookie,
      body: {
        property_id: demo.data.property?.id,
        permit_record_id: first.id,
      },
    });
    const contactRows = find.data.saved || find.data.contacts || [];
    log(
      'find contact demo visible',
      find.status === 200 && contactRows.length >= 1,
      JSON.stringify({
        n: contactRows.length,
        origins: contactRows.map((c) => c.record_origin),
        error: find.data.error,
      })
    );

    const contactId = contactRows[0]?.id;
    if (contactId) {
      const reject = await api(base, 'POST', `/api/contacts/${contactId}/status`, {
        cookie: ownerCookie,
        body: { status: 'rejected' },
      });
      log('contact reject', reject.status === 200);
    } else {
      log('contact reject', false, 'no contact id from find');
    }

    const expRes = await fetch(`${base}/api/export.xlsx`, {
      headers: { Cookie: ownerCookie, 'X-Requested-With': 'PermitLedger', Origin: base },
    });
    const expBuf = Buffer.from(await expRes.arrayBuffer());
    log('export workbook', expRes.status === 200 && expBuf.length > 100, `bytes=${expBuf.length}`);

    // Inspect export exclusion via in-process helper would need app import; spot-check API list exclude
    const listed = await api(base, 'GET', `/api/permits/${first.id}`, { cookie: ownerCookie });
    const origins = (listed.data.contacts || []).map((c) => c.record_origin);
    log(
      'detail contacts after reject',
      listed.status === 200,
      `origins=${origins.join(',') || 'none'}`
    );

    const attention = await api(base, 'GET', '/api/attention', { cookie: ownerCookie });
    log('attention list', attention.status === 200, `n=${attention.data.items?.length ?? 0}`);
    if (attention.data.items?.[0]) {
      const ack = await api(base, 'POST', `/api/attention/${attention.data.items[0].id}/ack`, {
        cookie: ownerCookie,
        body: {},
      });
      log('attention ack', ack.status === 200);
    } else {
      log('attention ack skipped', true, 'no open items');
    }

    const marker = {
      permitId: first.id,
      milestoneKey,
      propertyId: demo.data.property?.id,
      permitCount: permits.data.permits.length,
    };
    child.kill('SIGTERM');
    await sleep(600);
    return marker;
  } catch (e) {
    log('session error', false, String(e.message || e));
    console.error(getOutput());
    try {
      child.kill('SIGKILL');
    } catch {
      /* */
    }
    throw e;
  }
}

async function runRestart(marker) {
  const base = `http://127.0.0.1:${port}`;
  // Existing users — no OWNER_* bootstrap credentials required.
  const { child, getOutput } = startServer({ includeOwnerBootstrap: false });
  try {
    await waitReady(base);
    const login = await api(base, 'POST', '/api/auth/login', {
      body: { email: ownerEmail, password: ownerPassword },
    });
    log('restart owner login (no OWNER_* env)', login.status === 200);
    const cookie = login.cookie;

    const opLogin = await api(base, 'POST', '/api/auth/login', {
      body: { email: operatorEmail, password: operatorPassword },
    });
    log('restart operator login', opLogin.status === 200);

    const detail = await api(base, 'GET', `/api/permits/${marker.permitId}`, { cookie });
    const kept = (detail.data.milestones || []).find((m) => m.key === marker.milestoneKey);
    log('restart milestone persisted', kept?.value === 'survive-reimport', kept ? kept.value : 'missing');

    const permits = await api(base, 'GET', '/api/permits', { cookie });
    log(
      'restart permits persisted',
      (permits.data.permits?.length || 0) >= marker.permitCount,
      `n=${permits.data.permits?.length || 0}`
    );

    const propIds = (detail.data.properties || []).map((p) => p.id);
    log(
      'restart property persisted',
      !marker.propertyId || propIds.includes(marker.propertyId),
      `props=${propIds.join(',')}`
    );

    child.kill('SIGTERM');
    await sleep(300);
  } catch (e) {
    log('restart error', false, String(e.message || e));
    console.error(getOutput());
    try {
      child.kill('SIGKILL');
    } catch {
      /* */
    }
    throw e;
  }
}

const marker = await runSession();
await runRestart(marker);

const failed = results.filter((r) => !r.ok);
console.log('\n--- E2E summary ---');
console.log(`db=${dbPath}`);
console.log(`passed=${results.filter((r) => r.ok).length} failed=${failed.length}`);
if (failed.length) {
  for (const f of failed) console.log(`  FAIL ${f.step}: ${f.detail}`);
  process.exit(1);
}
process.exit(0);
