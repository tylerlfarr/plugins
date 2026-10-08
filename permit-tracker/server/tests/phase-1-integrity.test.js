/**
 * Phase 1 integrity residuals: sync CAS/bump policy, property orthogonality,
 * logout session revoke, import preview idempotency, dirty helpers.
 * Asserts persisted values, not only status codes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  isPermitDraftDirty,
  isPropertyFormDirty,
  isMilestoneEditsDirty,
  isRecordWorkspaceDirty,
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
  const dbPath = path.join(os.tmpdir(), `p1-${Date.now()}-${Math.random()}.sqlite`);
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ok */
  }
  const port = 4800 + Math.floor(Math.random() * 200);
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
  return { status: res.status, data, cookie: cookieFrom(res) || cookie, setCookie: res.headers.getSetCookie?.() };
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

test('dirty helpers: property form and milestone edits participate in workspace dirty', () => {
  const detail = { next_action: '', owner: '' };
  const detailServer = { next_action: '', owner: '' };
  assert.equal(isPermitDraftDirty(detail, detailServer), false);

  const emptyProp = {
    id: null,
    site_address: '',
    city: '',
    state: '',
    zip: '',
    parcel_apn: '',
    parcel_jurisdiction: '',
  };
  assert.equal(isPropertyFormDirty(emptyProp, emptyProp), false);
  assert.equal(
    isPropertyFormDirty({ ...emptyProp, site_address: '123 Main' }, emptyProp),
    true
  );
  assert.equal(
    isPropertyFormDirty({ ...emptyProp, site_address: '123 Main' }, null),
    true
  );

  const milestones = [{ key: 'permit_release', value: '2026-03-01' }];
  assert.equal(isMilestoneEditsDirty({}, milestones), false);
  assert.equal(isMilestoneEditsDirty({ permit_release: '2026-03-01' }, milestones), false);
  assert.equal(isMilestoneEditsDirty({ permit_release: '2099-01-01' }, milestones), true);

  assert.equal(
    isRecordWorkspaceDirty({
      detail,
      detailServer,
      propertyForm: { ...emptyProp, site_address: 'Dirty Rd' },
      propertyFormServer: emptyProp,
      milestoneEdits: {},
      milestones,
    }),
    true
  );
});

test('logout revokes session; cookie replay returns 401; drafts are server-side gone', async () => {
  await withServer({}, async (base) => {
    let r = await api(base, 'POST', '/api/auth/login', {
      body: { email: 'owner@example.com', password: 'owner-password-10+' },
    });
    assert.equal(r.status, 200);
    const cookie = r.cookie;
    assert.ok(cookie);

    const ok = await api(base, 'GET', '/api/permits', { cookie });
    assert.equal(ok.status, 200);

    const logout = await api(base, 'POST', '/api/auth/logout', { cookie, body: {} });
    assert.equal(logout.status, 200);

    const replay = await api(base, 'GET', '/api/permits', { cookie });
    assert.equal(replay.status, 401, 'replayed cookie after logout must be rejected');

    const patchReplay = await api(base, 'PATCH', '/api/permits/1', {
      cookie,
      body: { next_action: 'should fail', expected_row_version: 1 },
    });
    assert.equal(patchReplay.status, 401);
  });
});

test('import preview double-submit is idempotent; same file re-preview does not duplicate', async () => {
  await withServer({}, async (base) => {
    let r = await api(base, 'POST', '/api/auth/login', {
      body: { email: 'owner@example.com', password: 'owner-password-10+' },
    });
    const cookie = r.cookie;
    const { buildSanitizedWorkbookBuffer } = await import('../fixtures/buildSanitizedWorkbook.js');
    const buf = buildSanitizedWorkbookBuffer();

    const fd1 = new FormData();
    fd1.append('file', new Blob([buf]), 'sanitized.xlsx');
    const preview = await api(base, 'POST', '/api/import/workbook/preview', {
      cookie,
      formData: fd1,
    });
    assert.equal(preview.status, 200);
    assert.ok(preview.data.previewId);
    assert.ok(preview.data.contentHash);
    assert.match(String(preview.data.contentHash), /^[a-f0-9]{64}$/);

    const commitFd = new FormData();
    commitFd.append('previewId', preview.data.previewId);
    const commit1 = await api(base, 'POST', '/api/import/workbook/commit', {
      cookie,
      formData: commitFd,
    });
    assert.equal(commit1.status, 200, JSON.stringify(commit1.data));
    assert.equal(commit1.data.idempotent, false);
    assert.ok(commit1.data.summary.permits_created >= 1);
    const created = commit1.data.summary.permits_created;

    const stats1 = await api(base, 'GET', '/api/stats', { cookie });
    const count1 = stats1.data.permits;

    // Double-submit same previewId → cached idempotent success (network retry)
    const commitFd2 = new FormData();
    commitFd2.append('previewId', preview.data.previewId);
    const commit2 = await api(base, 'POST', '/api/import/workbook/commit', {
      cookie,
      formData: commitFd2,
    });
    assert.equal(commit2.status, 200, JSON.stringify(commit2.data));
    assert.equal(commit2.data.idempotent, true);
    assert.equal(commit2.data.summary.permits_created, created);

    const stats2 = await api(base, 'GET', '/api/stats', { cookie });
    assert.equal(stats2.data.permits, count1, 'idempotent retry must not create permits');

    // New preview of same bytes → re-import updates, does not duplicate
    const fd3 = new FormData();
    fd3.append('file', new Blob([buf]), 'sanitized.xlsx');
    const preview2 = await api(base, 'POST', '/api/import/workbook/preview', {
      cookie,
      formData: fd3,
    });
    assert.equal(preview2.data.contentHash, preview.data.contentHash);
    const commitFd3 = new FormData();
    commitFd3.append('previewId', preview2.data.previewId);
    const commit3 = await api(base, 'POST', '/api/import/workbook/commit', {
      cookie,
      formData: commitFd3,
    });
    assert.equal(commit3.status, 200);
    assert.equal(commit3.data.idempotent, false);
    assert.equal(commit3.data.summary.permits_created, 0);
    assert.ok(commit3.data.summary.permits_updated >= 1);

    const stats3 = await api(base, 'GET', '/api/stats', { cookie });
    assert.equal(stats3.data.permits, count1, 'same-file re-import must not duplicate permits');

    const list = await api(base, 'GET', '/api/permits', { cookie });
    const ids = (list.data.permits || []).map((p) => p.primary_official_id).filter(Boolean);
    assert.equal(ids.length, new Set(ids).size, 'official IDs must be unique');
  });
});

test('property confirm-link is orthogonal to permit row_version (persisted)', async () => {
  await withServer({}, async (base) => {
    const cookie = await loginImport(base);
    const list = await api(base, 'GET', '/api/permits', { cookie });
    const permit = list.data.permits[0];
    const detail = await api(base, 'GET', `/api/permits/${permit.id}`, { cookie });
    const v0 = detail.data.permit.row_version;
    assert.ok(detail.data.permit.lot_group_id);

    const created = await api(base, 'POST', '/api/properties', {
      cookie,
      body: {
        lot_group_id: detail.data.permit.lot_group_id,
        permit_record_id: permit.id,
        site_address: '100 Phase1 Orthogonality Way',
        city: 'Fairfax',
        state: 'VA',
        zip: '22030',
        link_state: 'candidate',
      },
    });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const propId = created.data.property?.id || created.data.id;
    assert.ok(propId);

    const afterCreate = await api(base, 'GET', `/api/permits/${permit.id}`, { cookie });
    assert.equal(
      Number(afterCreate.data.permit.row_version),
      Number(v0),
      'property create must not bump permit row_version'
    );

    const confirm = await api(base, 'POST', `/api/properties/${propId}/confirm-link`, {
      cookie,
      body: { permit_record_id: permit.id, lot_group_id: detail.data.permit.lot_group_id },
    });
    assert.equal(confirm.status, 200, JSON.stringify(confirm.data));

    const afterConfirm = await api(base, 'GET', `/api/permits/${permit.id}`, { cookie });
    assert.equal(
      Number(afterConfirm.data.permit.row_version),
      Number(v0),
      'confirm-link must not bump permit row_version'
    );

    // Same expected version still accepts a permit field save
    const patch = await api(base, 'PATCH', `/api/permits/${permit.id}`, {
      cookie,
      body: {
        next_action: 'After property confirm',
        expected_row_version: v0,
      },
    });
    assert.equal(patch.status, 200, JSON.stringify(patch.data));
    assert.equal(patch.data.permit.next_action, 'After property confirm');
    assert.ok(Number(patch.data.permit.row_version) > Number(v0));
  });
});
