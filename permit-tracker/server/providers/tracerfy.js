/**
 * Replaceable Tracerfy adapter.
 *
 * Docs evaluated (Oct 2026):
 * - Instant Trace: POST /v1/api/trace/lookup/ — 5 credits/hit, 0 on miss
 * - APN Instant: POST /v1/api/trace/parcel/lookup/ — 5 credits/hit
 * - Auth: Authorization: Bearer <token>
 * - Sandbox: https://mock.tracerfy.com/v1/api/ (free fake data)
 * - Production: https://tracerfy.com/v1/api/ — DISABLED until credentials + spend limit + commercial confirmation
 * - Pricing: $0.02/credit → Instant Trace ≈ $0.10/hit
 *
 * We keep only project-contact fields (name/company/phone/email/mailing/DNC flags).
 * Relatives, DOB, and unrelated history are dropped.
 */

import crypto from 'node:crypto';
import { db, getSetting, setSetting } from '../db.js';

export const TRACERFY_ENDPOINTS = Object.freeze({
  instant_trace: {
    path: '/trace/lookup/',
    estimatedCredits: 5,
    effectiveUsdPerHit: 0.1,
    description: 'Synchronous owner/person lookup by address (5 credits/hit, 0 on miss)',
  },
  apn_instant: {
    path: '/trace/parcel/lookup/',
    estimatedCredits: 5,
    effectiveUsdPerHit: 0.1,
    description: 'Synchronous parcel/APN lookup (5 credits/hit, 0 on miss)',
  },
});

const SANDBOX_BASE = 'https://mock.tracerfy.com/v1/api';
const PROD_BASE = 'https://tracerfy.com/v1/api';

export function tracerfyConfig() {
  const productionEnabled =
    getSetting('tracerfy_production_enabled', '0') === '1' &&
    Boolean(getSetting('tracerfy_api_token', '')) &&
    Boolean(getSetting('tracerfy_spend_limit_credits', '')) &&
    getSetting('tracerfy_commercial_confirmed', '0') === '1';
  return {
    mode: productionEnabled ? 'production' : 'sandbox',
    productionEnabled,
    sandboxBase: SANDBOX_BASE,
    productionBase: PROD_BASE,
    spendLimitCredits: Number(getSetting('tracerfy_spend_limit_credits', '0') || 0),
    tokenPresent: Boolean(getSetting('tracerfy_api_token', '')),
    commercialConfirmed: getSetting('tracerfy_commercial_confirmed', '0') === '1',
    endpoints: TRACERFY_ENDPOINTS,
    pricingNote:
      'Pay-as-you-go ≈ $0.02/credit. Instant Trace / APN Instant = 5 credits/hit ($0.10), 0 on miss. Sandbox free.',
    rightsUnresolved:
      'Display/storage/export rights for contact data under Tracerfy terms not fully resolved from public pages — treat as operator legal review before any production export of provider contacts.',
  };
}

export function requestFingerprint(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 40);
}

/** Fabricated sandbox response — unmistakable demo labels. Never for operational workbook attach without demo origin. */
export function fabricateSandboxResponse(input) {
  const addr = input.address || '100 Demo Sandbox Way';
  return {
    address: addr,
    city: input.city || 'Demo City',
    state: input.state || 'VA',
    zip: input.zip || '20100',
    find_owner: true,
    hit: true,
    persons_count: 1,
    credits_deducted: 0,
    persons: [
      {
        first_name: 'SANDBOX',
        last_name: 'DEMO-OWNER',
        full_name: 'SANDBOX DEMO-OWNER',
        property_owner: true,
        litigator: false,
        mailing_address: {
          street: addr,
          city: input.city || 'Demo City',
          state: input.state || 'VA',
          zip: input.zip || '20100',
        },
        phones: [
          {
            number: '5550100199',
            type: 'Mobile',
            dnc: false,
            tcpa: false,
            carrier: 'SANDBOX-CARRIER',
            rank: 1,
          },
        ],
        emails: [{ email: 'sandbox.demo-owner@example.invalid', rank: 1 }],
        // Intentionally present in provider payload — stripped before storage
        dob: '1970-01',
        relatives: [{ name: 'SHOULD_NOT_STORE' }],
      },
    ],
    meta: {
      request_id: `sandbox_${requestFingerprint(input).slice(0, 12)}`,
      timestamp: new Date().toISOString(),
      api_version: 'sandbox-local',
      demo_label: 'FABRICATED_SANDBOX_RESPONSE',
    },
  };
}

export function mapPersonsToContactFields(response) {
  const persons = response?.persons || [];
  return persons.map((p) => {
    const phones = Array.isArray(p.phones) ? p.phones : [];
    const emails = Array.isArray(p.emails) ? p.emails : [];
    const primaryPhone = phones.find((x) => x.rank === 1) || phones[0] || {};
    const primaryEmail = emails.find((x) => x.rank === 1) || emails[0] || {};
    const flags = [];
    for (const ph of phones) {
      if (ph.dnc) flags.push(`dnc:${ph.number}`);
      if (ph.tcpa) flags.push(`tcpa:${ph.number}`);
    }
    if (p.litigator) flags.push('litigator');
    if (p.deceased) flags.push('deceased');
    const mailing = p.mailing_address
      ? [p.mailing_address.street, p.mailing_address.city, p.mailing_address.state, p.mailing_address.zip]
          .filter(Boolean)
          .join(', ')
      : '';
    return {
      role: p.property_owner ? 'property_owner' : 'unknown_party',
      full_name: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' '),
      company: p.company || '',
      phone: primaryPhone.number || '',
      email: primaryEmail.email || '',
      mailing_address: mailing,
      restriction_flags: flags,
      // Explicitly omit dob/relatives/age
    };
  });
}

async function httpJson(url, { token, body, signal }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, headers: Object.fromEntries(res.headers.entries()) };
}

/**
 * Run a contact lookup job. Production is hard-disabled unless all gates pass.
 * Duplicate fingerprint while job is open → returns existing job (no blind rebill).
 */
export async function runContactLookup({
  property,
  permitRecordId = null,
  lotGroupId = null,
  endpointKey = 'instant_trace',
  forceFail = null,
  useLocalFabrication = true,
} = {}) {
  const cfg = tracerfyConfig();
  const endpoint = TRACERFY_ENDPOINTS[endpointKey];
  if (!endpoint) throw new Error(`Unknown endpoint ${endpointKey}`);

  const input =
    endpointKey === 'apn_instant'
      ? {
          parcel_id: property.parcel_apn,
          county: property.parcel_jurisdiction || property.city,
          state: property.state || 'VA',
        }
      : {
          address: property.site_address,
          city: property.city,
          state: property.state || 'VA',
          zip: property.zip,
          find_owner: true,
        };

  if (endpointKey === 'instant_trace' && !input.address) {
    throw new Error('site_address required for instant_trace');
  }
  if (endpointKey === 'apn_instant' && !input.parcel_id) {
    throw new Error('parcel_apn required for apn_instant');
  }

  const fingerprint = requestFingerprint({
    endpointKey,
    mode: cfg.mode,
    property_id: property.id,
    input,
  });

  const existing = db
    .prepare(
      `SELECT * FROM contact_jobs
       WHERE request_fingerprint = ? AND status IN ('queued','running','succeeded')
       ORDER BY id DESC LIMIT 1`
    )
    .get(fingerprint);
  if (existing && existing.status === 'succeeded') {
    return { job: existing, deduped: true };
  }
  if (existing && ['queued', 'running'].includes(existing.status)) {
    return { job: existing, deduped: true, inFlight: true };
  }

  const info = db
    .prepare(
      `INSERT INTO contact_jobs(
         provider, mode, property_id, permit_record_id, lot_group_id, request_fingerprint,
         endpoint, status, estimated_credits, request_json, attempts)
       VALUES ('tracerfy', ?, ?, ?, ?, ?, ?, 'queued', ?, ?, 0)`
    )
    .run(
      cfg.mode,
      property.id,
      permitRecordId,
      lotGroupId,
      fingerprint,
      endpoint.path,
      endpoint.estimatedCredits,
      JSON.stringify(input)
    );
  const jobId = Number(info.lastInsertRowid);

  db.prepare(`UPDATE contact_jobs SET status = 'running', attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?`).run(
    jobId
  );

  // Simulated provider outcomes for offline tests
  if (forceFail === 'insufficient_credits') {
    const err = {
      status: 402,
      error: 'Insufficient credits. Instant trace requires 5 credits per lookup. You have 0 credits.',
    };
    db.prepare(
      `UPDATE contact_jobs SET status='failed', error=?, response_json=?, finished_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
    ).run(err.error, JSON.stringify(err), jobId);
    return { job: db.prepare('SELECT * FROM contact_jobs WHERE id = ?').get(jobId), error: err };
  }
  if (forceFail === 'rate_limit') {
    const err = { status: 429, error: 'Rate limit exceeded. Max 500 lookups per minute.', lookups_in_window: 500 };
    db.prepare(
      `UPDATE contact_jobs SET status='failed', error=?, response_json=?, finished_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
    ).run(err.error, JSON.stringify(err), jobId);
    return { job: db.prepare('SELECT * FROM contact_jobs WHERE id = ?').get(jobId), error: err };
  }
  if (forceFail === 'timeout') {
    db.prepare(
      `UPDATE contact_jobs SET status='timed_out', error=?, finished_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
    ).run('Lookup timed out — reconcile before resubmit', jobId);
    return {
      job: db.prepare('SELECT * FROM contact_jobs WHERE id = ?').get(jobId),
      error: { status: 504, error: 'timeout' },
      reconcileBeforeResubmit: true,
    };
  }
  if (forceFail === 'no_match') {
    const resp = {
      hit: false,
      persons_count: 0,
      credits_deducted: 0,
      meta: { demo_label: 'FABRICATED_SANDBOX_NO_MATCH' },
    };
    db.prepare(
      `UPDATE contact_jobs SET status='succeeded', actual_credits=0, response_json=?, finished_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
    ).run(JSON.stringify(resp), jobId);
    return { job: db.prepare('SELECT * FROM contact_jobs WHERE id = ?').get(jobId), contacts: [], noMatch: true };
  }

  let response;
  let actualCredits = 0;
  if (cfg.mode === 'sandbox' && useLocalFabrication) {
    // Local fabrication keeps CI offline; optional live mock.tracerfy.com when TRACERFY_LIVE_SANDBOX=1
    if (process.env.TRACERFY_LIVE_SANDBOX === '1') {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const remote = await httpJson(`${SANDBOX_BASE}${endpoint.path}`, {
          token: getSetting('tracerfy_api_token', 'sandbox-token'),
          body: input,
          signal: controller.signal,
        });
        clearTimeout(timer);
        response = remote.json;
        actualCredits = Number(response.credits_deducted || 0);
      } catch {
        response = fabricateSandboxResponse(input);
        actualCredits = 0;
      }
    } else {
      response = fabricateSandboxResponse(input);
      actualCredits = 0;
    }
  } else if (cfg.mode === 'production') {
    // Spend limit gate
    const used = db
      .prepare(
        `SELECT COALESCE(SUM(credits),0) AS c FROM provider_usage WHERE provider='tracerfy' AND mode='production'`
      )
      .get().c;
    if (used + endpoint.estimatedCredits > cfg.spendLimitCredits) {
      db.prepare(
        `UPDATE contact_jobs SET status='failed', error=?, finished_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
      ).run('Spend limit would be exceeded', jobId);
      return {
        job: db.prepare('SELECT * FROM contact_jobs WHERE id = ?').get(jobId),
        error: { status: 402, error: 'spend_limit' },
      };
    }
    const token = getSetting('tracerfy_api_token', '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const remote = await httpJson(`${PROD_BASE}${endpoint.path}`, {
        token,
        body: input,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (remote.status === 402 || remote.status === 429) {
        db.prepare(
          `UPDATE contact_jobs SET status='failed', error=?, response_json=?, finished_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
        ).run(remote.json.error || String(remote.status), JSON.stringify(remote.json), jobId);
        return {
          job: db.prepare('SELECT * FROM contact_jobs WHERE id = ?').get(jobId),
          error: remote.json,
        };
      }
      response = remote.json;
      actualCredits = Number(response.credits_deducted || 0);
    } catch (e) {
      clearTimeout(timer);
      db.prepare(
        `UPDATE contact_jobs SET status='timed_out', error=?, finished_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
      ).run(String(e.message || e), jobId);
      return {
        job: db.prepare('SELECT * FROM contact_jobs WHERE id = ?').get(jobId),
        error: { status: 504, error: 'timeout' },
        reconcileBeforeResubmit: true,
      };
    }
  } else {
    // Production requested but gates incomplete
    db.prepare(
      `UPDATE contact_jobs SET status='failed', error=?, finished_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
    ).run(
      'Production Tracerfy disabled — need token + spend limit + commercial-use confirmation',
      jobId
    );
    return {
      job: db.prepare('SELECT * FROM contact_jobs WHERE id = ?').get(jobId),
      error: { status: 403, error: 'production_disabled' },
    };
  }

  const contacts = mapPersonsToContactFields(response);
  db.prepare(
    `UPDATE contact_jobs SET status='succeeded', actual_credits=?, response_json=?,
     external_request_id=?, finished_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
  ).run(
    actualCredits,
    JSON.stringify(response),
    response?.meta?.request_id || null,
    jobId
  );
  db.prepare(
    `INSERT INTO provider_usage(provider, mode, endpoint, credits, job_id) VALUES ('tracerfy', ?, ?, ?, ?)`
  ).run(cfg.mode, endpoint.path, actualCredits, jobId);

  return {
    job: db.prepare('SELECT * FROM contact_jobs WHERE id = ?').get(jobId),
    contacts,
    responseMeta: response?.meta || {},
    estimatedCredits: endpoint.estimatedCredits,
    actualCredits,
  };
}

export function reconcileTimedOutJob(jobId) {
  const job = db.prepare('SELECT * FROM contact_jobs WHERE id = ?').get(Number(jobId));
  if (!job) throw new Error('Job not found');
  if (job.status !== 'timed_out') return { job, action: 'noop' };
  // Mark reconciled — caller may resubmit with new fingerprint attempt only after this
  db.prepare(
    `UPDATE contact_jobs SET status='reconciled_timeout', updated_at=datetime('now'),
     error = error || ' | reconciled — safe to resubmit' WHERE id = ?`
  ).run(job.id);
  return { job: db.prepare('SELECT * FROM contact_jobs WHERE id = ?').get(job.id), action: 'reconciled' };
}
