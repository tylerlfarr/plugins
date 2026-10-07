/**
 * Workflow acceptance — conflict versioning, draft-safe partial PATCH,
 * Attention source-failure resolution, import rejection, selected export,
 * preview→commit session. Asserts persisted values, not only status codes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  classifyFieldDiffs,
  buildPatchFromDecisions,
  dirtyPermitPatch,
} from '../../client/src/draftMerge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

function cookieFrom(res) {
  return (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
}

async function waitHealth(base) {
  for (let i = 0; i < 80; i += 1) {
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

async function withServer(extraEnv, fn) {
  const dbPath = path.join(os.tmpdir(), `wfa-${Date.now()}-${Math.random()}.sqlite`);
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ok */
  }
  const port = 4600 + Math.floor(Math.random() * 200);
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
      PERMIT_BYPASS_SOURCE_ELIGIBILITY: '0',
      PERMIT_TEST_HARNESS: '1',
      ...extraEnv,
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitHealth(base);
    await fn(base, dbPath);
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
  assert.equal(r.status, 200);
  const cookie = r.cookie;
  const { buildSanitizedWorkbookBuffer } = await import('../fixtures/buildSanitizedWorkbook.js');
  const fd = new FormData();
  fd.append('file', new Blob([buildSanitizedWorkbookBuffer()]), 'sanitized.xlsx');
  r = await api(base, 'POST', '/api/import/workbook/commit', { cookie, formData: fd });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return cookie;
}

test('draftMerge: dirty-only patch and conflict decisions preserve server fields', () => {
  const base = { owner: '', internal_status: 'watching', next_action: '', next_action_due: null };
  const draft = { ...base, next_action: 'Call AHJ' };
  const server = { ...base, owner: 'QA Coordinator', internal_status: 'needs_followup' };
  const diffs = classifyFieldDiffs(base, draft, server);
  const statuses = Object.fromEntries(diffs.map((d) => [d.key, d.status]));
  assert.equal(statuses.next_action, 'draft_only');
  assert.equal(statuses.owner, 'server_only');
  assert.equal(statuses.internal_status, 'server_only');
  const patch = buildPatchFromDecisions(diffs, {}, server);
  assert.equal(patch.next_action, 'Call AHJ');
  assert.equal(patch.owner, undefined);
  assert.equal(patch.internal_status, undefined);

  const both = classifyFieldDiffs(
    base,
    { ...draft, owner: 'Draft Owner' },
    { ...server, owner: 'QA Coordinator' }
  );
  assert.equal(both.find((r) => r.key === 'owner')?.status, 'conflict');
  assert.throws(() => buildPatchFromDecisions(both, {}, server));
  const chosen = buildPatchFromDecisions(both, { owner: 'draft' }, server);
  assert.equal(chosen.owner, 'Draft Owner');
  assert.equal(chosen.next_action, 'Call AHJ');

  const dirty = dirtyPermitPatch(
    { ...server, next_action: 'Only this' },
    server
  );
  assert.deepEqual(Object.keys(dirty), ['next_action']);
});

test('take_incoming bumps version; stale save after resolve is 409 and does not reverse', async () => {
  await withServer({ PERMIT_BYPASS_SOURCE_ELIGIBILITY: '1' }, async (base) => {
    const cookie = await loginImport(base);
    let r = await api(base, 'GET', '/api/permits', { cookie });
    const permit = (r.data.permits || []).find((p) => p.primary_official_id?.startsWith('BLDR'));
    assert.ok(permit, 'BLDR sample');

    let detail = await api(base, 'GET', `/api/permits/${permit.id}`, { cookie });
    const ms = (detail.data.milestones || []).find((m) => m.key && !String(m.key).startsWith('official_'));
    assert.ok(ms, 'editable milestone');

    // App-edit a milestone
    r = await api(base, 'PATCH', `/api/permits/${permit.id}`, {
      cookie,
      body: {
        milestones: [{ key: ms.key, value: '2099-01-15', label: ms.label }],
        expected_row_version: detail.data.permit.row_version,
      },
    });
    assert.equal(r.status, 200);
    const vAfterEdit = r.data.permit.row_version;

    // Re-import fixture → pending conflict (incoming original date vs app edit)
    const { buildSanitizedWorkbookBuffer } = await import('../fixtures/buildSanitizedWorkbook.js');
    const fd = new FormData();
    fd.append('file', new Blob([buildSanitizedWorkbookBuffer()]), 'sanitized.xlsx');
    r = await api(base, 'POST', '/api/import/workbook/commit', { cookie, formData: fd });
    assert.equal(r.status, 200);
    assert.ok((r.data.summary?.conflicts || 0) >= 1);

    const conflicts = await api(base, 'GET', '/api/conflicts', { cookie });
    const conflict = (conflicts.data.conflicts || []).find((c) => c.permit_record_id === permit.id);
    assert.ok(conflict, 'pending conflict');

    detail = await api(base, 'GET', `/api/permits/${permit.id}`, { cookie });
    const vBeforeResolve = detail.data.permit.row_version;
    assert.ok(Number(vBeforeResolve) >= Number(vAfterEdit));

    // Resolve take_incoming with version
    const resolve = await api(base, 'POST', `/api/conflicts/${conflict.id}/resolve`, {
      cookie,
      body: {
        resolution: 'take_incoming',
        expected_row_version: vBeforeResolve,
      },
    });
    assert.equal(resolve.status, 200, JSON.stringify(resolve.data));
    assert.ok(Number(resolve.data.row_version) > Number(vBeforeResolve));
    assert.equal(String(resolve.data.milestone?.value), String(conflict.incoming_value));

    // Stale save with pre-resolve version must 409 and not reverse milestone
    const stale = await api(base, 'PATCH', `/api/permits/${permit.id}`, {
      cookie,
      body: {
        milestones: [{ key: ms.key, value: '2099-01-15' }],
        expected_row_version: vBeforeResolve,
      },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error, 'stale_write');

    const after = await api(base, 'GET', `/api/permits/${permit.id}`, { cookie });
    const persisted = (after.data.milestones || []).find((m) => m.key === ms.key);
    assert.equal(String(persisted.value), String(conflict.incoming_value));
    assert.equal(Number(after.data.permit.row_version), Number(resolve.data.row_version));
  });
});

test('simultaneous conflict decisions: second loses with no partial apply', async () => {
  await withServer({ PERMIT_BYPASS_SOURCE_ELIGIBILITY: '1' }, async (base) => {
    const cookie = await loginImport(base);
    let r = await api(base, 'GET', '/api/permits', { cookie });
    const permit = (r.data.permits || []).find((p) => p.primary_official_id?.startsWith('BLDR'));
    let detail = await api(base, 'GET', `/api/permits/${permit.id}`, { cookie });
    const milestones = (detail.data.milestones || []).filter(
      (m) => m.key && !String(m.key).startsWith('official_')
    );
    assert.ok(milestones.length >= 2);

    // Edit two milestones so re-import can create two conflicts
    r = await api(base, 'PATCH', `/api/permits/${permit.id}`, {
      cookie,
      body: {
        milestones: [
          { key: milestones[0].key, value: '2099-02-01' },
          { key: milestones[1].key, value: '2099-03-01' },
        ],
        expected_row_version: detail.data.permit.row_version,
      },
    });
    assert.equal(r.status, 200);

    const { buildSanitizedWorkbookBuffer } = await import('../fixtures/buildSanitizedWorkbook.js');
    const fd = new FormData();
    fd.append('file', new Blob([buildSanitizedWorkbookBuffer()]), 'sanitized.xlsx');
    await api(base, 'POST', '/api/import/workbook/commit', { cookie, formData: fd });

    const conflicts = await api(base, 'GET', '/api/conflicts', { cookie });
    const mine = (conflicts.data.conflicts || []).filter((c) => c.permit_record_id === permit.id);
    assert.ok(mine.length >= 2, `expected >=2 conflicts, got ${mine.length}`);

    detail = await api(base, 'GET', `/api/permits/${permit.id}`, { cookie });
    const v = detail.data.permit.row_version;

    const first = await api(base, 'POST', `/api/conflicts/${mine[0].id}/resolve`, {
      cookie,
      body: { resolution: 'keep_app', expected_row_version: v },
    });
    assert.equal(first.status, 200);

    const second = await api(base, 'POST', `/api/conflicts/${mine[1].id}/resolve`, {
      cookie,
      body: { resolution: 'take_incoming', expected_row_version: v },
    });
    assert.equal(second.status, 409);
    assert.equal(second.data.error, 'stale_write');

    // Second conflict still pending; milestone for losing request unchanged from app edit
    const still = await api(base, 'GET', '/api/conflicts', { cookie });
    const remaining = (still.data.conflicts || []).find((c) => c.id === mine[1].id);
    assert.ok(remaining, 'losing conflict still pending');

    const after = await api(base, 'GET', `/api/permits/${permit.id}`, { cookie });
    const m1 = (after.data.milestones || []).find((m) => m.key === mine[1].field);
    assert.equal(String(m1.value), '2099-03-01');
  });
});

test('partial PATCH after bulk preserves newer owner/status (server dirty-field semantics)', async () => {
  await withServer({}, async (base) => {
    const cookie = await loginImport(base);
    let r = await api(base, 'GET', '/api/permits', { cookie });
    const permit = r.data.permits[0];
    const detail = await api(base, 'GET', `/api/permits/${permit.id}`, { cookie });
    const staleV = detail.data.permit.row_version;

    await api(base, 'POST', '/api/permits/bulk', {
      cookie,
      body: {
        ids: [permit.id],
        patch: { owner: 'QA Coordinator', internal_status: 'needs_followup' },
      },
    });

    // Correct client behavior after reconcile: only send dirty next_action with fresh version
    const fresh = await api(base, 'GET', `/api/permits/${permit.id}`, { cookie });
    const ok = await api(base, 'PATCH', `/api/permits/${permit.id}`, {
      cookie,
      body: {
        next_action: 'Recovered draft action',
        expected_row_version: fresh.data.permit.row_version,
      },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.permit.next_action, 'Recovered draft action');
    assert.equal(ok.data.permit.owner, 'QA Coordinator');
    assert.equal(ok.data.permit.internal_status, 'needs_followup');

    // Full-form stale overwrite still blocked
    const bad = await api(base, 'PATCH', `/api/permits/${permit.id}`, {
      cookie,
      body: {
        owner: '',
        internal_status: 'watching',
        next_action: 'Recovered draft action',
        expected_row_version: staleV,
      },
    });
    assert.equal(bad.status, 409);
    const persisted = await api(base, 'GET', `/api/permits/${permit.id}`, { cookie });
    assert.equal(persisted.data.permit.owner, 'QA Coordinator');
    assert.equal(persisted.data.permit.internal_status, 'needs_followup');
  });
});

test('source failure Attention resolves after ID replacement + successful path clear', async () => {
  await withServer({ PERMIT_BYPASS_SOURCE_ELIGIBILITY: '1' }, async (base) => {
    const cookie = await loginImport(base);
    let r = await api(base, 'GET', '/api/permits?q=BLDR-2026-00263', { cookie });
    const permit = (r.data.permits || [])[0];
    assert.ok(permit);

    // Force a not_found Attention via direct upsert through sync with bad ID
    let detail = await api(base, 'GET', `/api/permits/${permit.id}`, { cookie });
    await api(base, 'PATCH', `/api/permits/${permit.id}`, {
      cookie,
      body: {
        primary_official_id: 'BLDR-2026-999999',
        expected_row_version: detail.data.permit.row_version,
      },
    });

    // Activate + confirm for check (bypass on → still need confirm for honesty in other paths)
    await api(base, 'POST', '/api/sources/fairfax_county_building_records_plus/activate', {
      cookie,
      body: { reviewedBy: 'wfa' },
    });
    detail = await api(base, 'GET', `/api/permits/${permit.id}`, { cookie });
    await api(base, 'PATCH', `/api/permits/${permit.id}`, {
      cookie,
      body: {
        jurisdiction_code: 'fairfax_county',
        jurisdiction_confirmed: true,
        expected_row_version: detail.data.permit.row_version,
      },
    });

    const badCheck = await api(base, 'POST', `/api/sync/${permit.id}`, { cookie, body: {} });
    assert.equal(badCheck.data.result?.outcome, 'not_found');

    let att = await api(base, 'GET', '/api/attention', { cookie });
    assert.ok(
      (att.data.items || []).some(
        (a) => a.permit_record_id === permit.id && a.kind === 'source_missing'
      ),
      'not_found attention present'
    );

    // Restore correct ID — obsolete source failures resolve on ID replacement
    detail = await api(base, 'GET', `/api/permits/${permit.id}`, { cookie });
    await api(base, 'PATCH', `/api/permits/${permit.id}`, {
      cookie,
      body: {
        primary_official_id: 'BLDR-2026-00263',
        expected_row_version: detail.data.permit.row_version,
      },
    });

    att = await api(base, 'GET', '/api/attention', { cookie });
    assert.equal(
      (att.data.items || []).filter(
        (a) => a.permit_record_id === permit.id && a.kind === 'source_missing'
      ).length,
      0,
      'source_missing cleared after ID replacement'
    );
  });
});

test('malformed / unsupported uploads rejected with no mutations; preview commit uses session', async () => {
  await withServer({}, async (base) => {
    let r = await api(base, 'POST', '/api/auth/login', {
      body: { email: 'owner@example.com', password: 'owner-password-10+' },
    });
    const cookie = r.cookie;

    const before = await api(base, 'GET', '/api/stats', { cookie });
    assert.equal(before.data.permits, 0);

    const badTxt = new FormData();
    badTxt.append('file', new Blob(['not an excel file']), 'unsupported.txt');
    r = await api(base, 'POST', '/api/import/workbook/preview', { cookie, formData: badTxt });
    assert.equal(r.status, 400);
    assert.match(String(r.data.error || ''), /Unsupported|Unrecognized|Could not/i);

    const badXlsx = new FormData();
    badXlsx.append('file', new Blob(['PK fake']), 'malformed.xlsx');
    r = await api(base, 'POST', '/api/import/workbook/preview', { cookie, formData: badXlsx });
    assert.equal(r.status, 400);

    const afterBad = await api(base, 'GET', '/api/stats', { cookie });
    assert.equal(afterBad.data.permits, 0);

    const { buildSanitizedWorkbookBuffer } = await import('../fixtures/buildSanitizedWorkbook.js');
    const fd = new FormData();
    fd.append('file', new Blob([buildSanitizedWorkbookBuffer()]), 'sanitized.xlsx');
    const preview = await api(base, 'POST', '/api/import/workbook/preview', {
      cookie,
      formData: fd,
    });
    assert.equal(preview.status, 200);
    assert.ok(preview.data.previewId);
    assert.ok(preview.data.sectionCount >= 1);

    const commitFd = new FormData();
    commitFd.append('previewId', preview.data.previewId);
    const commit = await api(base, 'POST', '/api/import/workbook/commit', {
      cookie,
      formData: commitFd,
    });
    assert.equal(commit.status, 200);
    assert.equal(commit.data.changedBy, 'owner@example.com');
    assert.ok(commit.data.summary.permits_created >= 1);

    const stats = await api(base, 'GET', '/api/stats', { cookie });
    assert.ok(stats.data.permits >= 1);
  });
});

test('export selected ignores filters and returns selected count', async () => {
  await withServer({}, async (base) => {
    const cookie = await loginImport(base);
    const list = await api(base, 'GET', '/api/permits', { cookie });
    const fairfax = (list.data.permits || []).find((p) => p.jurisdiction_code === 'fairfax_county');
    const altc = (list.data.permits || []).find((p) => String(p.primary_official_id || '').startsWith('ALTC'));
    assert.ok(fairfax && altc && fairfax.id !== altc.id);

    // Filter would exclude fairfax if q=ALTC, but selected export ignores q
    const res = await fetch(
      `${base}/api/export.xlsx?selectedIds=${fairfax.id}&q=ALTC`,
      {
        headers: { Cookie: cookie, 'X-Requested-With': 'PermitLedger', Origin: base },
      }
    );
    assert.equal(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    const { inspectExportBuffer } = await import('../excelExport.js');
    const insp = inspectExportBuffer(buf);
    const ids = new Set(insp.permits.map((p) => p.id));
    assert.ok(ids.has(fairfax.id), 'selected fairfax exported despite ALTC filter');
    assert.equal(insp.permits.length, 1);
  });
});
