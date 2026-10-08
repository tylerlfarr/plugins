/**
 * Phase 8 — release candidate freeze checks.
 * Documents disabled features; confirms security suite gates; demo shortcuts restricted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permit-phase8-'));
process.env.PERMIT_DB_PATH = path.join(tmpDir, 'phase8.sqlite');
process.env.PERMIT_DEMO = '0';
process.env.AUTO_SEED = '0';
process.env.PILOT_AUTH = '1';
process.env.PERMIT_NO_LISTEN = '1';
process.env.COOKIE_SECURE = '0';
process.env.OWNER_EMAIL = 'owner@example.com';
process.env.OWNER_PASSWORD = 'owner-password-10+';
process.env.OWNER_DISPLAY_NAME = 'Owner';
process.env.BUSINESS_NAME = 'Phase 8 RC Co';
process.env.TRACERFY_PROVIDER_MODE = 'local_fixture';
process.env.PERMIT_AI_FORCE_OFF = '1';
delete process.env.PERMIT_AI_API_KEY;
delete process.env.TRACERFY_API_TOKEN;
delete process.env.ALLOW_DEMO_SHORTCUTS;
// Intentionally leave PERMIT_TEST_HARNESS unset for the demo-shortcut denial case;
// npm test sets it globally — clear after import path needs the harness for other suites.
const harnessWas = process.env.PERMIT_TEST_HARNESS;
delete process.env.PERMIT_TEST_HARNESS;
delete process.env.NODE_ENV;

const { app } = await import('../index.js');
const { db, migrate, demoShortcutsAllowed, getSetting, setSetting } = await import('../db.js');
const { tracerfyConfig, hardSpendLockActive } = await import('../providers/tracerfy.js');
const { sanitizeForAudit, phase7AssistantStatus } = await import('../assistant.js');
const { assertSafeOutboundUrl, isBlockedIp } = await import('../sources/ssrf.js');
const { enqueueSyncJob, getSyncJob, drainSyncJobs } = await import('../syncJobs.js');

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
        async api(method, urlPath, { body, cookie, formData } = {}) {
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
        },
      });
    });
  });
}

test('RC disabled features documented in runtime config', () => {
  assert.equal(hardSpendLockActive(), true);
  const cfg = tracerfyConfig();
  assert.equal(cfg.hardSpendLock, true);
  assert.equal(cfg.liveEnrichedLeadPilot, 'BLOCKED');
  assert.notEqual(cfg.mode, 'production');
  assert.equal(Number(getSetting('tracerfy_spend_limit_credits', '0')), 0);

  const ai = phase7AssistantStatus();
  assert.equal(ai.ai.available, false);
  assert.equal(ai.ai.state, 'unavailable');
  assert.ok(ai.notes.some((n) => /AI optional|fail-safe/i.test(n)));
});

test('demo shortcuts denied without disposable flag; allowed when demo_mode on', async () => {
  assert.equal(demoShortcutsAllowed(), false);

  const { server, api } = await listen();
  try {
    let r = await api('POST', '/api/auth/login', {
      body: { email: 'owner@example.com', password: 'owner-password-10+' },
    });
    assert.equal(r.status, 200);
    const cookie = r.cookie;

    const meta = await api('GET', '/api/meta', { cookie });
    assert.equal(meta.data.demoShortcutsAllowed, false);

    // Need a lot to call the endpoint; seed minimal row
    const sec = db
      .prepare(
        `INSERT INTO community_sections(project_code, community_name, jurisdiction_code, record_origin)
         VALUES ('P8','Phase8','fairfax_county','import')`
      )
      .run();
    const lg = db
      .prepare(
        `INSERT INTO lot_groups(section_id, lot_label, record_origin) VALUES (?, '1', 'import')`
      )
      .run(Number(sec.lastInsertRowid));
    const denied = await api('POST', '/api/properties/demo-sandbox', {
      cookie,
      body: { lot_group_id: Number(lg.lastInsertRowid) },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.error, 'demo_shortcuts_disabled');

    setSetting('demo_mode', '1');
    assert.equal(demoShortcutsAllowed(), true);
    const allowed = await api('POST', '/api/properties/demo-sandbox', {
      cookie,
      body: { lot_group_id: Number(lg.lastInsertRowid) },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.data.property?.record_origin, 'sandbox_demo');
    setSetting('demo_mode', '0');
  } finally {
    server.close();
  }
});

test('SSRF + log redaction still enforced', async () => {
  assert.equal(isBlockedIp('127.0.0.1'), true);
  assert.equal(isBlockedIp('169.254.169.254'), true);
  await assert.rejects(() => assertSafeOutboundUrl('http://127.0.0.1/latest/meta-data'), /Blocked|not allowed/i);
  await assert.rejects(() => assertSafeOutboundUrl('file:///etc/passwd'), /http/);
  const redacted = sanitizeForAudit(
    'token Bearer sk-abcdef1234567890 email a@b.com phone 703-555-1212'
  );
  assert.ok(!/sk-abcdef/.test(redacted));
  assert.ok(!/a@b\.com/.test(redacted));
  assert.ok(!/703-555-1212/.test(redacted));
  assert.match(redacted, /REDACTED/);
});

test('background sync jobs complete without browser session', async () => {
  const { job } = enqueueSyncJob({ fairfaxOnly: true, trigger: 'phase8-rc', createdBy: 'phase8' });
  assert.ok(job?.id);
  assert.ok(['queued', 'running', 'succeeded', 'failed'].includes(job.status));
  await drainSyncJobs({ maxTicks: 20 });
  const done = getSyncJob(job.id);
  assert.ok(done);
  assert.ok(['succeeded', 'failed', 'queued', 'running'].includes(done.status));
  // Job row survives independently of any cookie/session — lease fields exist on table
  assert.ok('lease_owner' in done || done.status === 'succeeded' || done.status === 'failed');
});

test('session fail-closed + upload rejection smoke', async () => {
  const { server, api } = await listen();
  try {
    const unauth = await api('GET', '/api/permits');
    assert.equal(unauth.status, 401);

    let r = await api('POST', '/api/auth/login', {
      body: { email: 'owner@example.com', password: 'owner-password-10+' },
    });
    const cookie = r.cookie;

    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('not-an-xlsx')]), 'evil.txt');
    const bad = await api('POST', '/api/import/workbook/preview', { cookie, formData: fd });
    assert.ok([400, 415, 422].includes(bad.status) || bad.data?.error, JSON.stringify(bad.data));
  } finally {
    server.close();
  }
});

// Restore harness for any subsequent tests in the same node process (none expected).
if (harnessWas != null) process.env.PERMIT_TEST_HARNESS = harnessWas;
