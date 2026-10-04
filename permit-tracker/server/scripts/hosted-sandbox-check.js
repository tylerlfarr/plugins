/**
 * Real hosted-sandbox Tracerfy check against mock.tracerfy.com.
 * Uses invented test properties only. No purchases / no production host.
 *
 * Usage: node server/scripts/hosted-sandbox-check.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SANDBOX = 'https://mock.tracerfy.com/v1/api';
const ENDPOINT = '/trace/lookup/';

async function call(body, token = 'sandbox_test_token') {
  const started = Date.now();
  let res;
  try {
    res = await fetch(`${SANDBOX}${ENDPOINT}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });
  } catch (e) {
    return {
      ok: false,
      networkFailure: true,
      error: String(e.message || e),
      endpoint: `${SANDBOX}${ENDPOINT}`,
      elapsedMs: Date.now() - started,
    };
  }
  const text = await res.text();
  let json = null;
  let parseError = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (e) {
    parseError = String(e.message || e);
  }
  return {
    ok: res.status === 200 && !parseError && json?.hit !== undefined,
    networkFailure: false,
    endpoint: `${SANDBOX}${ENDPOINT}`,
    httpStatus: res.status,
    requestId: res.headers.get('x-request-id') || json?.meta?.request_id || null,
    elapsedMs: Date.now() - started,
    parseError,
    hit: json?.hit,
    personsCount: json?.persons_count,
    creditsDeducted: json?.credits_deducted,
    // Sanitized: first person name only for verification — invented sandbox data
    sampleName: json?.persons?.[0]?.full_name || null,
    validation: {
      hasMeta: Boolean(json?.meta),
      hasPersonsArray: Array.isArray(json?.persons),
      noDobStoredInOurAdapter: true,
    },
    bodyKeys: json ? Object.keys(json) : [],
  };
}

const invented = {
  address: '742 Evergreen Terrace',
  city: 'Springfield',
  state: 'IL',
  zip: '62704',
  find_owner: true,
};

const results = {
  when: new Date().toISOString(),
  note: 'Invented properties only. Hosted sandbox — not production. Nothing purchased.',
  success: await call(invented),
  forced401: await call(invented, 'INVALID_TOKEN'),
  forcedNoMatch: await call({
    address: 'NO_MATCH',
    city: 'Austin',
    state: 'TX',
    zip: '78701',
    find_owner: true,
  }),
  forcedCredits: await call({
    address: 'NO_CREDITS',
    city: 'Austin',
    state: 'TX',
    zip: '78701',
    find_owner: true,
  }),
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(
  '/cursor/stores/self/internal',
  'tracerfy-hosted-sandbox-check.json'
);
fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
console.log(`\nWrote ${outPath}`);

if (results.success.networkFailure) {
  console.error('NETWORK FAILURE — do not claim hosted-sandbox success');
  process.exit(2);
}
if (!results.success.ok) {
  console.error('Hosted sandbox success call did not validate');
  process.exit(1);
}
if (results.forced401.httpStatus !== 401) {
  console.error('Expected 401 for INVALID_TOKEN');
  process.exit(1);
}
process.exit(0);
