/**
 * Phase 8 local hosted-journey analogue.
 * Separate owner + operator cookie contexts against a disposable SQLite DB.
 *
 * Covers: login → import preview/commit → re-import conflict → assignment → edit →
 * Fairfax check → property review → opportunity search → fixture contact review →
 * action queue (Attention) → exact export. Restarts prove persistence.
 *
 * Usage (from permit-tracker/):
 *   node server/scripts/phase-8-rc-journey.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSanitizedWorkbookBuffer } from '../fixtures/buildSanitizedWorkbook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '../..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permit-p8-rc-'));
const dbPath = path.join(tmpDir, 'rc.sqlite');
const port = 4411 + Math.floor(Math.random() * 200);
const ownerEmail = 'owner.rc@example.com';
const ownerPassword = 'owner-rc-password-10+';
const operatorEmail = 'operator.rc@example.com';
const operatorPassword = 'operator-rc-pass-10+';

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
    TRACERFY_PROVIDER_MODE: 'local_fixture',
    PERMIT_AI_FORCE_OFF: '1',
    // RC host: no harness / no demo shortcuts unless owner enables demo_mode
    PERMIT_DEMO: '0',
    PERMIT_TEST_HARNESS: '0',
    ALLOW_DEMO_SHORTCUTS: '0',
  };
  delete env.TRACERFY_API_TOKEN;
  delete env.PERMIT_AI_API_KEY;
  delete env.SOURCE_WORKBOOK_XLSX;
  if (includeOwnerBootstrap) {
    env.OWNER_EMAIL = ownerEmail;
    env.OWNER_PASSWORD = ownerPassword;
    env.OWNER_DISPLAY_NAME = 'RC Owner';
    env.BUSINESS_NAME = 'Phase 8 RC Disposable';
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

async function waitReady(base, attempts = 60) {
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
  return { status: res.status, data, cookie: cookieFrom(res) || cookie, res };
}

async function runJourney() {
  const base = `http://127.0.0.1:${port}`;
  const { child, getOutput } = startServer({ includeOwnerBootstrap: true });
  try {
    const health = await waitReady(base);
    log(
      'health + release',
      health.ok === true && Boolean(health.release?.gitShaShort),
      health.release?.gitShaShort || ''
    );

    // —— Owner session (cookie A) ——
    const ownerLogin = await api(base, 'POST', '/api/auth/login', {
      body: { email: ownerEmail, password: ownerPassword },
    });
    log('owner login', ownerLogin.status === 200 && ownerLogin.data.user?.role === 'owner');
    const ownerCookie = ownerLogin.cookie;

    const meta = await api(base, 'GET', '/api/meta', { cookie: ownerCookie });
    log(
      'demo shortcuts off on RC host',
      meta.data.demoShortcutsAllowed === false,
      `demoShortcutsAllowed=${meta.data.demoShortcutsAllowed}`
    );

    const created = await api(base, 'POST', '/api/auth/users', {
      cookie: ownerCookie,
      body: {
        email: operatorEmail,
        password: operatorPassword,
        displayName: 'RC Operator',
        role: 'operator',
      },
    });
    log('owner create operator', created.status === 201 || created.status === 200);

    // —— Operator session (cookie B — separate context) ——
    const opLogin = await api(base, 'POST', '/api/auth/login', {
      body: { email: operatorEmail, password: operatorPassword },
    });
    log('operator login (separate cookie)', opLogin.status === 200 && opLogin.data.user?.role === 'operator');
    const opCookie = opLogin.cookie;
    log(
      'owner/operator cookies differ',
      Boolean(ownerCookie) && Boolean(opCookie) && ownerCookie !== opCookie
    );

    const opDenied = await api(base, 'POST', '/api/auth/users', {
      cookie: opCookie,
      body: { email: 'x@example.com', password: 'xxxxx-pass-10+' },
    });
    log('operator cannot create users', opDenied.status === 403);

    // Import as operator (preview + commit)
    const buf = buildSanitizedWorkbookBuffer();
    const previewFd = new FormData();
    previewFd.append('file', new Blob([buf]), 'sanitized.xlsx');
    const preview = await api(base, 'POST', '/api/import/workbook/preview', {
      cookie: opCookie,
      formData: previewFd,
    });
    log('operator import preview', preview.status === 200 && preview.data.sectionCount >= 1);

    const commitFd = new FormData();
    commitFd.append('file', new Blob([buf]), 'sanitized.xlsx');
    const commit = await api(base, 'POST', '/api/import/workbook/commit', {
      cookie: opCookie,
      formData: commitFd,
    });
    log(
      'operator import commit',
      commit.status === 200 && (commit.data.summary?.permits_created || 0) >= 1,
      JSON.stringify(commit.data.summary || {})
    );

    const permits = await api(base, 'GET', '/api/permits', { cookie: opCookie });
    const first =
      (permits.data.permits || []).find((p) => p.primary_official_id?.startsWith('BLDR')) ||
      permits.data.permits?.[0];
    log('list permits', Boolean(first), `n=${permits.data.permits?.length || 0}`);
    if (!first) throw new Error('no permits');

    // Edit milestone then re-import → conflict
    let detail = await api(base, 'GET', `/api/permits/${first.id}`, { cookie: opCookie });
    const ms = (detail.data.milestones || []).find(
      (m) => m.key && !String(m.key).startsWith('official_')
    );
    const edit = await api(base, 'PATCH', `/api/permits/${first.id}`, {
      cookie: opCookie,
      body: {
        owner: 'RC Operator',
        next_action: 'Follow Fairfax issued check',
        next_action_due: '2026-10-20',
        milestones: ms
          ? [{ key: ms.key, value: '2099-01-15', label: ms.label }]
          : [{ key: 'rc_keep', label: 'RC Keep', value: 'survive-conflict' }],
        expected_row_version: detail.data.permit?.row_version ?? 1,
      },
    });
    log(
      'assignment + edit',
      edit.status === 200 && edit.data.permit?.owner === 'RC Operator',
      edit.status !== 200 ? JSON.stringify(edit.data).slice(0, 180) : ''
    );

    const reFd = new FormData();
    reFd.append('file', new Blob([buf]), 'sanitized.xlsx');
    const reimport = await api(base, 'POST', '/api/import/workbook/commit', {
      cookie: opCookie,
      formData: reFd,
    });
    const conflictCount = reimport.data.summary?.conflicts || 0;
    log('re-import conflict surfaced', reimport.status === 200 && conflictCount >= 1, `conflicts=${conflictCount}`);

    const conflicts = await api(base, 'GET', '/api/conflicts', { cookie: opCookie });
    const conflict = (conflicts.data.conflicts || []).find((c) => c.permit_record_id === first.id);
    log('pending conflict listed', Boolean(conflict), conflict ? `id=${conflict.id}` : 'none');

    if (conflict) {
      detail = await api(base, 'GET', `/api/permits/${first.id}`, { cookie: opCookie });
      const resolved = await api(base, 'POST', `/api/conflicts/${conflict.id}/resolve`, {
        cookie: opCookie,
        body: {
          resolution: 'keep_app',
          expected_row_version: detail.data.permit.row_version,
        },
      });
      log('conflict resolve keep_app', resolved.status === 200);
    }

    // Fairfax check (may be not_found / unavailable / updated — never fake success)
    const sync = await api(base, 'POST', `/api/sync/${first.id}`, {
      cookie: opCookie,
      body: {},
    });
    const outcome = sync.data?.result?.outcome || sync.data?.outcome;
    log(
      'Fairfax/permit check outcome',
      sync.status === 200 && Boolean(outcome),
      String(outcome || JSON.stringify(sync.data).slice(0, 160))
    );

    // Property review — confirm a real (non-demo) property attachment path via manual upsert
    detail = await api(base, 'GET', `/api/permits/${first.id}`, { cookie: opCookie });
    const propCreate = await api(base, 'POST', '/api/properties', {
      cookie: opCookie,
      body: {
        lot_group_id: first.lot_group_id,
        permit_record_id: first.id,
        site_address: '500 RC Review Lane',
        city: 'Fairfax',
        state: 'VA',
        zip: '22030',
        link_state: 'confirmed',
        record_origin: 'manual',
      },
    });
    log(
      'property review (manual confirmed)',
      propCreate.status === 200 && propCreate.data.property?.id,
      `property=${propCreate.data.property?.id}`
    );

    // Demo-sandbox must stay blocked on RC host
    const demoBlocked = await api(base, 'POST', '/api/properties/demo-sandbox', {
      cookie: opCookie,
      body: { lot_group_id: first.lot_group_id, permit_record_id: first.id },
    });
    log('demo-sandbox blocked on RC', demoBlocked.status === 403);

    // Opportunity search (issued-layer; fixture when live unavailable)
    const cov = await api(base, 'GET', '/api/opportunities/coverage', { cookie: opCookie });
    log('opportunity coverage ack surface', cov.status === 200);

    const search = await api(base, 'POST', '/api/opportunities/search', {
      cookie: opCookie,
      body: {
        app_type_alias: 'Residential',
        issued_from: '2026-09-01',
        issued_to: '2026-09-30',
      },
    });
    log(
      'opportunity search',
      search.status === 200 && ['ok', 'partial', 'zero'].includes(search.data.status),
      `status=${search.data.status} n=${(search.data.results || []).length}`
    );

    let oppId = null;
    if ((search.data.results || []).length) {
      const saved = await api(base, 'POST', '/api/opportunities/save', {
        cookie: opCookie,
        body: { candidates: search.data.results.slice(0, 2) },
      });
      oppId = saved.data.saved?.[0]?.id;
      log('opportunity save', saved.status === 200 && Boolean(oppId), `id=${oppId}`);
    } else {
      log('opportunity save skipped', true, 'zero results');
    }

    // Fixture contact review via opportunity handoff (not live Tracerfy)
    if (oppId) {
      const handoffPreview = await api(base, 'POST', '/api/opportunities/contact-handoff', {
        cookie: opCookie,
        body: {
          opportunityIds: [oppId],
          sought_role: 'developer',
          dryRun: true,
        },
      });
      log(
        'fixture contact handoff preview $0',
        handoffPreview.status === 200 &&
          (handoffPreview.data.preview?.fixtureCostZero === true ||
            handoffPreview.data.ok === true),
        JSON.stringify(handoffPreview.data.preview || handoffPreview.data).slice(0, 180)
      );
      const handoff = await api(base, 'POST', '/api/opportunities/contact-handoff', {
        cookie: opCookie,
        body: {
          opportunityIds: [oppId],
          sought_role: 'developer',
          dryRun: false,
          confirm: true,
        },
      });
      log(
        'fixture contact review handoff',
        handoff.status === 200 || handoff.status === 403,
        `status=${handoff.status} live=${handoff.data.liveEnrichedLeadPilot || handoff.data.error || 'ok'}`
      );
    }

    // Action queue = Attention
    const attention = await api(base, 'GET', '/api/attention', { cookie: opCookie });
    log('action queue (Attention)', attention.status === 200, `n=${attention.data.items?.length ?? 0}`);
    if (attention.data.items?.[0]) {
      const ack = await api(base, 'POST', `/api/attention/${attention.data.items[0].id}/ack`, {
        cookie: opCookie,
        body: {},
      });
      log('attention ack', ack.status === 200);
    } else {
      log('attention ack skipped', true, 'no open items');
    }

    // Exact export parity spot-check (operator cookie)
    const listAll = await api(base, 'GET', '/api/permits', { cookie: opCookie });
    const listIds = new Set((listAll.data.permits || []).map((p) => p.id));
    const expRes = await fetch(`${base}/api/export.xlsx`, {
      headers: { Cookie: opCookie, 'X-Requested-With': 'PermitLedger', Origin: base },
    });
    const expBuf = Buffer.from(await expRes.arrayBuffer());
    let exportOk = expRes.status === 200 && expBuf.length > 100;
    try {
      const { inspectExportBuffer } = await import('../excelExport.js');
      const inspected = inspectExportBuffer(expBuf);
      exportOk =
        exportOk &&
        inspected.permits.length === listIds.size &&
        inspected.permits.every((p) => listIds.has(p.id));
      log(
        'exact export parity',
        exportOk,
        `list=${listIds.size} exportRows=${inspected.permits.length}`
      );
    } catch (e) {
      log('exact export parity', false, String(e.message || e));
    }

    // Owner logout; operator session still independent
    const ownerOut = await api(base, 'POST', '/api/auth/logout', {
      cookie: ownerCookie,
      body: {},
    });
    log('owner logout', ownerOut.status === 200);
    const ownerReplay = await api(base, 'GET', '/api/permits', { cookie: ownerCookie });
    log('owner cookie revoked', ownerReplay.status === 401);
    const opStill = await api(base, 'GET', '/api/permits', { cookie: opCookie });
    log('operator session still valid after owner logout', opStill.status === 200);

    const marker = {
      permitId: first.id,
      owner: 'RC Operator',
      oppId,
      permitCount: listIds.size,
      releaseSha: health.release?.gitShaShort,
    };
    child.kill('SIGTERM');
    await sleep(600);
    return marker;
  } catch (e) {
    log('journey error', false, String(e.message || e));
    console.error(getOutput().slice(-4000));
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
  const { child, getOutput } = startServer({ includeOwnerBootstrap: false });
  try {
    await waitReady(base);
    const opLogin = await api(base, 'POST', '/api/auth/login', {
      body: { email: operatorEmail, password: operatorPassword },
    });
    log('restart operator login', opLogin.status === 200);
    const cookie = opLogin.cookie;
    const detail = await api(base, 'GET', `/api/permits/${marker.permitId}`, { cookie });
    log(
      'restart assignment persisted',
      detail.data.permit?.owner === marker.owner,
      detail.data.permit?.owner || 'missing'
    );
    const permits = await api(base, 'GET', '/api/permits', { cookie });
    log(
      'restart permits persisted',
      (permits.data.permits?.length || 0) >= marker.permitCount,
      `n=${permits.data.permits?.length || 0}`
    );
    child.kill('SIGTERM');
    await sleep(300);
  } catch (e) {
    log('restart error', false, String(e.message || e));
    console.error(getOutput().slice(-2000));
    try {
      child.kill('SIGKILL');
    } catch {
      /* */
    }
    throw e;
  }
}

const marker = await runJourney();
await runRestart(marker);

const failed = results.filter((r) => !r.ok);
const outPath = path.join(tmpDir, 'phase-8-rc-journey-results.json');
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      dbPath,
      releaseSha: marker.releaseSha,
      passed: results.filter((r) => r.ok).length,
      failed: failed.length,
      results,
    },
    null,
    2
  )
);
console.log('\n--- Phase 8 RC journey summary ---');
console.log(`db=${dbPath}`);
console.log(`resultsJson=${outPath}`);
console.log(`passed=${results.filter((r) => r.ok).length} failed=${failed.length}`);
if (failed.length) {
  for (const f of failed) console.log(`  FAIL ${f.step}: ${f.detail}`);
  process.exit(1);
}
process.exit(0);
