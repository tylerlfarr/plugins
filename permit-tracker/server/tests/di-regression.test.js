/**
 * DI-01 / DI-02 / DI-03 named regression map (Phase 0).
 *
 * Tip 0c7a52d already closed the Oct 7 P1 defects reported at 742a519.
 * These tests label the contracts so Gate 0 evidence stays findable.
 * Broader coverage lives in workflow-acceptance.test.js and
 * data-loss-acceptance.test.js — do not rewrite working product code.
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

async function withServer(fn) {
  const dbPath = path.join(os.tmpdir(), `di-reg-${Date.now()}-${Math.random()}.sqlite`);
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ok */
  }
  const port = 4700 + Math.floor(Math.random() * 200);
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
  assert.equal(r.status, 200);
  const cookie = r.cookie;
  const { buildSanitizedWorkbookBuffer } = await import('../fixtures/buildSanitizedWorkbook.js');
  const fd = new FormData();
  fd.append('file', new Blob([buildSanitizedWorkbookBuffer()]), 'sanitized.xlsx');
  r = await api(base, 'POST', '/api/import/workbook/commit', { cookie, formData: fd });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return cookie;
}

test('DI-01: dirty-only merge keeps server owner/status when draft only changes next_action', () => {
  const base = { owner: '', internal_status: 'watching', next_action: '' };
  const draft = { ...base, next_action: 'DI-01 draft action' };
  const server = { ...base, owner: 'QA Coordinator', internal_status: 'needs_followup' };
  const diffs = classifyFieldDiffs(base, draft, server);
  const patch = buildPatchFromDecisions(diffs, {}, server);
  assert.deepEqual(Object.keys(patch).sort(), ['next_action']);
  assert.equal(patch.next_action, 'DI-01 draft action');
  assert.equal(dirtyPermitPatch({ ...server, next_action: 'DI-01 draft action' }, server).next_action, 'DI-01 draft action');
  assert.equal(Object.keys(dirtyPermitPatch({ ...server, next_action: 'DI-01 draft action' }, server)).includes('owner'), false);
});

test('DI-01: partial PATCH after bulk does not reverse newer owner/status', async () => {
  await withServer(async (base) => {
    const cookie = await loginImport(base);
    let r = await api(base, 'GET', '/api/permits', { cookie });
    const permit = r.data.permits[0];
    const detail = await api(base, 'GET', `/api/permits/${permit.id}`, { cookie });

    await api(base, 'POST', '/api/permits/bulk', {
      cookie,
      body: {
        ids: [permit.id],
        patch: { owner: 'QA Coordinator', internal_status: 'needs_followup' },
      },
    });

    const fresh = await api(base, 'GET', `/api/permits/${permit.id}`, { cookie });
    const ok = await api(base, 'PATCH', `/api/permits/${permit.id}`, {
      cookie,
      body: {
        next_action: 'DI-01 recovered',
        expected_row_version: fresh.data.permit.row_version,
      },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.permit.next_action, 'DI-01 recovered');
    assert.equal(ok.data.permit.owner, 'QA Coordinator');
    assert.equal(ok.data.permit.internal_status, 'needs_followup');
  });
});

test('DI-02: take_incoming advances version; stale save is 409 and does not reverse', async () => {
  await withServer(async (base) => {
    const cookie = await loginImport(base);
    let r = await api(base, 'GET', '/api/permits', { cookie });
    const permit = (r.data.permits || []).find((p) => p.primary_official_id?.startsWith('BLDR'));
    assert.ok(permit);

    let detail = await api(base, 'GET', `/api/permits/${permit.id}`, { cookie });
    const ms = (detail.data.milestones || []).find((m) => m.key && !String(m.key).startsWith('official_'));
    assert.ok(ms);

    r = await api(base, 'PATCH', `/api/permits/${permit.id}`, {
      cookie,
      body: {
        milestones: [{ key: ms.key, value: '2099-01-15', label: ms.label }],
        expected_row_version: detail.data.permit.row_version,
      },
    });
    assert.equal(r.status, 200);

    const { buildSanitizedWorkbookBuffer } = await import('../fixtures/buildSanitizedWorkbook.js');
    const fd = new FormData();
    fd.append('file', new Blob([buildSanitizedWorkbookBuffer()]), 'sanitized.xlsx');
    r = await api(base, 'POST', '/api/import/workbook/commit', { cookie, formData: fd });
    assert.equal(r.status, 200);
    assert.ok((r.data.summary?.conflicts || 0) >= 1);

    const conflicts = await api(base, 'GET', '/api/conflicts', { cookie });
    const conflict = (conflicts.data.conflicts || []).find((c) => c.permit_record_id === permit.id);
    assert.ok(conflict);

    detail = await api(base, 'GET', `/api/permits/${permit.id}`, { cookie });
    const vBefore = detail.data.permit.row_version;
    const resolve = await api(base, 'POST', `/api/conflicts/${conflict.id}/resolve`, {
      cookie,
      body: { resolution: 'take_incoming', expected_row_version: vBefore },
    });
    assert.equal(resolve.status, 200);
    assert.ok(Number(resolve.data.row_version) > Number(vBefore));

    const stale = await api(base, 'PATCH', `/api/permits/${permit.id}`, {
      cookie,
      body: {
        milestones: [{ key: ms.key, value: '2099-01-15' }],
        expected_row_version: vBefore,
      },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error, 'stale_write');

    const after = await api(base, 'GET', `/api/permits/${permit.id}`, { cookie });
    const persisted = (after.data.milestones || []).find((m) => m.key === ms.key);
    assert.equal(String(persisted.value), String(conflict.incoming_value));
  });
});

test('DI-03: dirty draft detection is true for unsaved next_action (nav-guard contract input)', () => {
  const server = {
    owner: '',
    internal_status: 'watching',
    next_action: '',
    next_action_due: null,
    primary_official_id: 'BLDR-1',
    jurisdiction_code: 'fairfax_county',
    source_url: '',
    permit_kind: 'building',
    jurisdiction_confirmed: 0,
  };
  const draft = { ...server, next_action: 'QA UNSAVED NAVIGATION DRAFT' };
  assert.equal(isPermitDraftDirty(draft, server), true);
  assert.equal(isPermitDraftDirty(server, server), false);
});

test('DI-03: property form and in-progress milestone edits dirty the workspace guard', () => {
  const server = {
    owner: '',
    internal_status: 'watching',
    next_action: '',
    next_action_due: null,
    primary_official_id: 'BLDR-1',
    jurisdiction_code: 'fairfax_county',
    source_url: '',
    permit_kind: 'building',
    jurisdiction_confirmed: 0,
  };
  const propClean = {
    id: 1,
    site_address: '1 Main',
    city: 'Fairfax',
    state: 'VA',
    zip: '22030',
    parcel_apn: '',
    parcel_jurisdiction: '',
  };
  const propDirty = { ...propClean, site_address: '2 Changed' };
  assert.equal(isPropertyFormDirty(propDirty, propClean), true);
  const milestones = [{ key: 'permit_release', value: '2026-01-01' }];
  assert.equal(isMilestoneEditsDirty({ permit_release: 'typed-before-blur' }, milestones), true);
  assert.equal(
    isRecordWorkspaceDirty({
      detail: server,
      detailServer: server,
      propertyForm: propDirty,
      propertyFormServer: propClean,
      milestoneEdits: {},
      milestones,
    }),
    true
  );
});
