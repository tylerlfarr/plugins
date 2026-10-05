/**
 * Private-trial hardening: auth fail-closed, CSRF/origin, login throttle, health split, roles.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permit-harden-'));
process.env.PERMIT_DB_PATH = path.join(tmpDir, 'harden.sqlite');
process.env.PERMIT_DEMO = '0';
process.env.AUTO_SEED = '0';
process.env.PILOT_AUTH = '1';
process.env.PERMIT_NO_LISTEN = '1';
process.env.COOKIE_SECURE = '0';
process.env.OWNER_EMAIL = 'owner@example.com';
process.env.OWNER_PASSWORD = 'owner-password-10+';
process.env.OWNER_DISPLAY_NAME = 'Owner';
process.env.BUSINESS_NAME = 'Harden Trial Co';
process.env.TRACERFY_MODE = 'local_fixture';
delete process.env.TRACERFY_API_TOKEN;
delete process.env.NODE_ENV; // auth forced by PILOT_AUTH=1

const { app } = await import('../index.js');
const { db, migrate, getDbPath } = await import('../db.js');
const { _resetLoginThrottleForTests, authEnabled, protectStateChange } = await import('../auth.js');
const { buildSanitizedWorkbookBuffer } = await import('../fixtures/buildSanitizedWorkbook.js');

migrate();
assert.equal(authEnabled(), true);
assert.ok(fs.existsSync(getDbPath()));

function listen() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const base = `http://127.0.0.1:${port}`;
      resolve({
        server,
        base,
        port,
        async request(method, urlPath, { body, headers = {}, cookie } = {}) {
          const res = await fetch(`${base}${urlPath}`, {
            method,
            headers: {
              ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
              ...(cookie ? { Cookie: cookie } : {}),
              ...headers,
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
          });
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
    headers: {
      'X-Requested-With': 'PermitLedger',
      Origin: client.base,
    },
  });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  return cookieFrom(login.setCookie);
}

test('public health is minimal; details require owner', async () => {
  const client = await listen();
  try {
    const health = await client.request('GET', '/api/health');
    assert.ok([200, 503].includes(health.status));
    assert.equal(health.data.ok, true);
    assert.equal(typeof health.data.ready, 'boolean');
    assert.equal(health.data.service, 'permit-ledger');
    assert.equal(health.data.dbPath, undefined);
    assert.equal(health.data.frontendBuilt, undefined);
    assert.equal(health.data.diagnostic, undefined);

    const denied = await client.request('GET', '/api/health/details');
    assert.equal(denied.status, 401);

    const cookie = await ownerSession(client);
    const details = await client.request('GET', '/api/health/details', { cookie });
    assert.equal(details.status, 200);
    assert.equal(details.data.dbPath, getDbPath());
    assert.equal(typeof details.data.frontendBuilt, 'boolean');
    assert.equal(details.data.auth, true);
  } finally {
    client.server.close();
  }
});

test('unauthenticated API is closed; same-origin owner workflows work', async () => {
  const client = await listen();
  try {
    const meta = await client.request('GET', '/api/meta');
    assert.equal(meta.status, 401);

    const cookie = await ownerSession(client);
    const metaOk = await client.request('GET', '/api/meta', { cookie });
    assert.equal(metaOk.status, 200);

    const buf = buildSanitizedWorkbookBuffer();
    const form = new FormData();
    form.append('file', new Blob([buf]), 'sanitized.xlsx');
    const previewRes = await fetch(`${client.base}/api/import/workbook/preview`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'X-Requested-With': 'PermitLedger',
        Origin: client.base,
      },
      body: form,
    });
    assert.equal(previewRes.status, 200);
    const preview = await previewRes.json();
    assert.ok(preview.sectionCount >= 1);
  } finally {
    client.server.close();
  }
});

test('cross-origin state change rejected even with X-Requested-With', async () => {
  const client = await listen();
  try {
    const cookie = await ownerSession(client);
    const evil = await client.request('POST', '/api/auth/logout', {
      body: {},
      cookie,
      headers: {
        'X-Requested-With': 'PermitLedger',
        Origin: 'https://evil.example',
      },
    });
    assert.equal(evil.status, 403);
    assert.match(String(evil.data.error || ''), /cross-origin/i);

    const same = await client.request('POST', '/api/settings', {
      body: { business_name: 'Same Origin Co' },
      cookie,
      headers: {
        'X-Requested-With': 'PermitLedger',
        Origin: client.base,
      },
    });
    assert.equal(same.status, 200, JSON.stringify(same.data));
  } finally {
    client.server.close();
  }
});

test('operator cannot invite; owner can; invite accept creates operator', async () => {
  const client = await listen();
  try {
    const ownerCookie = await ownerSession(client);
    const invite = await client.request('POST', '/api/auth/invite', {
      body: { email: 'operator@example.com', role: 'operator' },
      cookie: ownerCookie,
      headers: { 'X-Requested-With': 'PermitLedger', Origin: client.base },
    });
    assert.equal(invite.status, 200, JSON.stringify(invite.data));
    assert.ok(invite.data.invite_token);

    const accept = await client.request('POST', '/api/auth/accept-invite', {
      body: {
        token: invite.data.invite_token,
        password: 'operator-pass-10+',
        displayName: 'Op',
      },
      headers: { 'X-Requested-With': 'PermitLedger', Origin: client.base },
    });
    assert.equal(accept.status, 200, JSON.stringify(accept.data));
    assert.equal(accept.data.user.role, 'operator');
    const opCookie = cookieFrom(accept.setCookie);

    const deniedInvite = await client.request('POST', '/api/auth/invite', {
      body: { email: 'other@example.com', role: 'operator' },
      cookie: opCookie,
      headers: { 'X-Requested-With': 'PermitLedger', Origin: client.base },
    });
    assert.equal(deniedInvite.status, 403);

    const deniedDetails = await client.request('GET', '/api/health/details', { cookie: opCookie });
    assert.equal(deniedDetails.status, 403);
  } finally {
    client.server.close();
  }
});

test('login throttling bounds repeated failures', async () => {
  _resetLoginThrottleForTests();
  const client = await listen();
  try {
    let last;
    for (let i = 0; i < 10; i += 1) {
      last = await client.request('POST', '/api/auth/login', {
        body: { email: 'owner@example.com', password: 'wrong-password!!' },
        headers: { 'X-Requested-With': 'PermitLedger', Origin: client.base },
      });
      assert.equal(last.status, 401);
    }
    const throttled = await client.request('POST', '/api/auth/login', {
      body: { email: 'owner@example.com', password: 'wrong-password!!' },
      headers: { 'X-Requested-With': 'PermitLedger', Origin: client.base },
    });
    assert.equal(throttled.status, 429);
    _resetLoginThrottleForTests();
    const ok = await client.request('POST', '/api/auth/login', {
      body: { email: 'owner@example.com', password: 'owner-password-10+' },
      headers: { 'X-Requested-With': 'PermitLedger', Origin: client.base },
    });
    assert.equal(ok.status, 200);
  } finally {
    client.server.close();
    _resetLoginThrottleForTests();
  }
});

test('protectStateChange unit: xhr alone does not authorize foreign Origin', () => {
  const calls = [];
  const res = {
    status(code) {
      calls.push(['status', code]);
      return this;
    },
    json(body) {
      calls.push(['json', body]);
      return body;
    },
  };
  let nextCalled = false;
  protectStateChange(
    {
      method: 'POST',
      headers: {
        origin: 'https://attacker.test',
        host: '127.0.0.1:4173',
        'x-requested-with': 'PermitLedger',
        'content-type': 'application/json',
      },
    },
    res,
    () => {
      nextCalled = true;
    }
  );
  assert.equal(nextCalled, false);
  assert.deepEqual(calls[0], ['status', 403]);
});
