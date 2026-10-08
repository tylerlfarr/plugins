/**
 * Replaceable Tracerfy adapter.
 *
 * Docs evaluated (Oct 2026): https://www.tracerfy.com/skip-tracing-api-documentation/
 * - Instant Trace: POST /v1/api/trace/lookup/ — 5 credits/hit, 0 on miss
 * - APN Instant: POST /v1/api/trace/parcel/lookup/ — 5 credits/hit
 * - Auth: Authorization: Bearer <token>
 * - Hosted sandbox: https://mock.tracerfy.com/v1/api/ (free fake data; any non-empty token)
 * - Production: https://tracerfy.com/v1/api/ — DISABLED until credentials + spend limit + commercial confirmation
 * - Response header X-Request-Id; body meta.request_id
 *
 * Modes (explicit, never silent switch):
 *   local_fixture  — fabricated offline responses
 *   hosted_sandbox — real network to mock.tracerfy.com; failures stay failures
 *   production     — real network to tracerfy.com when all gates pass
 *
 * We keep only project-contact fields (name/company/phone/email/mailing/DNC flags).
 * Relatives, DOB, and unrelated history are dropped before storage.
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

export const PROVIDER_MODES = Object.freeze({
  LOCAL_FIXTURE: 'local_fixture',
  HOSTED_SANDBOX: 'hosted_sandbox',
  PRODUCTION: 'production',
});

/** Phase 6 hard spend lock — production off, spend cap 0 unless explicitly unlocked. */
export function hardSpendLockActive() {
  if (process.env.TRACERFY_HARD_SPEND_LOCK === '0') return false;
  return getSetting('tracerfy_hard_spend_lock', '1') !== '0';
}

export function tracerfyConfig() {
  const hardLock = hardSpendLockActive();
  const requested =
    getSetting('tracerfy_provider_mode', '') ||
    process.env.TRACERFY_PROVIDER_MODE ||
    PROVIDER_MODES.LOCAL_FIXTURE;
  const productionGates =
    !hardLock &&
    getSetting('tracerfy_production_enabled', '0') === '1' &&
    Boolean(process.env.TRACERFY_API_TOKEN || getSetting('tracerfy_api_token_present', '0') === '1') &&
    Boolean(getSetting('tracerfy_spend_limit_credits', '')) &&
    Number(getSetting('tracerfy_spend_limit_credits', '0') || 0) > 0 &&
    getSetting('tracerfy_commercial_confirmed', '0') === '1';

  let mode = requested;
  if (hardLock && requested === PROVIDER_MODES.PRODUCTION) {
    mode = 'not_configured';
  } else if (requested === PROVIDER_MODES.PRODUCTION && !productionGates) {
    mode = 'not_configured';
  }
  // Legacy env: TRACERFY_LIVE_SANDBOX=1 selects hosted sandbox when mode unset/fixture
  if (
    !getSetting('tracerfy_provider_mode', '') &&
    process.env.TRACERFY_LIVE_SANDBOX === '1' &&
    requested === PROVIDER_MODES.LOCAL_FIXTURE
  ) {
    mode = PROVIDER_MODES.HOSTED_SANDBOX;
  }

  const spendLimitCredits = hardLock
    ? 0
    : Number(getSetting('tracerfy_spend_limit_credits', '0') || 0);

  return {
    mode,
    requestedMode: requested,
    productionEnabled: productionGates && mode === PROVIDER_MODES.PRODUCTION,
    productionGatesOk: productionGates,
    hardSpendLock: hardLock,
    liveEnrichedLeadPilot: hardLock || !productionGates ? 'BLOCKED' : 'gated',
    sandboxBase: SANDBOX_BASE,
    productionBase: PROD_BASE,
    spendLimitCredits,
    tokenPresent: Boolean(process.env.TRACERFY_API_TOKEN || getSetting('tracerfy_api_token_present', '0') === '1'),
    commercialConfirmed: getSetting('tracerfy_commercial_confirmed', '0') === '1',
    endpoints: TRACERFY_ENDPOINTS,
    pricingNote:
      'Pay-as-you-go ≈ $0.02/credit. Instant Trace / APN Instant = 5 credits/hit ($0.10), 0 on miss. Hosted sandbox free. Fixture/sandbox billable cost is always $0.',
    rightsUnresolved:
      'Display/storage/export rights for contact data under Tracerfy terms not fully resolved from public pages — treat as operator legal review before any production export of provider contacts. Live enriched-lead pilot BLOCKED until separate rights/budget approval.',
    modes: Object.values(PROVIDER_MODES),
  };
}

export function setProviderMode(mode) {
  if (!Object.values(PROVIDER_MODES).includes(mode)) {
    throw new Error(`Invalid provider mode ${mode}`);
  }
  setSetting('tracerfy_provider_mode', mode);
  return tracerfyConfig();
}

export function requestFingerprint(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 40);
}

/** Fabricated local-fixture response — unmistakable demo labels. */
export function fabricateSandboxResponse(input) {
  const addr = input.address || '100 Demo Sandbox Way';
  return {
    address: addr,
    city: input.city || 'Demo City',
    state: input.state || '',
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
          state: input.state || '',
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
        dob: '1970-01',
        relatives: [{ name: 'SHOULD_NOT_STORE' }],
      },
    ],
    meta: {
      request_id: `fixture_${requestFingerprint(input).slice(0, 12)}`,
      timestamp: new Date().toISOString(),
      api_version: 'local-fixture',
      demo_label: 'FABRICATED_LOCAL_FIXTURE_RESPONSE',
    },
  };
}

/** Strip unrelated personal fields before any storage/logging of job response body. */
export function sanitizeProviderResponseForStorage(response) {
  if (!response || typeof response !== 'object') return response;
  const persons = Array.isArray(response.persons)
    ? response.persons.map((p) => {
        const phones = Array.isArray(p.phones)
          ? p.phones.map((ph) => ({
              number: ph.number,
              type: ph.type,
              dnc: ph.dnc,
              tcpa: ph.tcpa,
              carrier: ph.carrier,
              rank: ph.rank,
            }))
          : [];
        const emails = Array.isArray(p.emails)
          ? p.emails.map((em) => ({ email: em.email, rank: em.rank }))
          : [];
        return {
          first_name: p.first_name,
          last_name: p.last_name,
          full_name: p.full_name,
          company: p.company,
          property_owner: p.property_owner,
          litigator: p.litigator,
          deceased: p.deceased,
          mailing_address: p.mailing_address,
          phones,
          emails,
          // intentionally omit dob, age, relatives, associates, etc.
        };
      })
    : undefined;
  return {
    address: response.address,
    city: response.city,
    state: response.state,
    zip: response.zip,
    find_owner: response.find_owner,
    hit: response.hit,
    persons_count: response.persons_count,
    credits_deducted: response.credits_deducted,
    persons,
    meta: response.meta,
    error: response.error,
    detail: response.detail,
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
      phone_candidates: phones.map((ph) => ({ number: ph.number, type: ph.type, rank: ph.rank, dnc: ph.dnc, tcpa: ph.tcpa })),
      email_candidates: emails.map((em) => ({ email: em.email, rank: em.rank })),
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
  let parseError = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (e) {
    parseError = String(e.message || e);
    json = { raw: text.slice(0, 500) };
  }
  const headers = Object.fromEntries(res.headers.entries());
  return { status: res.status, json, headers, parseError, textLength: text.length };
}

function productionToken() {
  // Server-side env preferred — never return token value to clients
  return process.env.TRACERFY_API_TOKEN || '';
}

/** Charge kinds that count against the production spend cap. */
const CAP_CHARGE_KINDS = ['reserved', 'reserved_uncertain', 'actual'];

function usageSum(mode, chargeKinds = null) {
  let sql = `SELECT COALESCE(SUM(credits),0) AS c FROM provider_usage WHERE provider='tracerfy' AND mode=?`;
  const params = [mode];
  if (chargeKinds?.length) {
    sql += ` AND charge_kind IN (${chargeKinds.map(() => '?').join(',')})`;
    params.push(...chargeKinds);
  }
  return db.prepare(sql).get(...params).c;
}

export function productionCapUsage() {
  return usageSum(PROVIDER_MODES.PRODUCTION, CAP_CHARGE_KINDS);
}

/**
 * Atomic credit reservation so concurrent jobs cannot race past the cap.
 * Fixture/sandbox: simulated reservation only; billable cost remains zero.
 */
function reserveCredits({ mode, endpoint, estimated, jobId }) {
  const run = db.transaction(() => {
    if (mode !== PROVIDER_MODES.PRODUCTION) {
      db.prepare(
        `INSERT INTO provider_usage(provider, mode, endpoint, credits, job_id, charge_kind)
         VALUES ('tracerfy', ?, ?, ?, ?, 'reserved_simulated')`
      ).run(mode, endpoint, estimated, jobId);
      return { reserved: estimated, chargeKind: 'reserved_simulated', billable: 0 };
    }
    if (hardSpendLockActive()) {
      return { blocked: true, reason: 'hard_spend_lock', reserved: 0, spendLimit: 0 };
    }
    const spendLimit = Number(getSetting('tracerfy_spend_limit_credits', '0') || 0);
    const reserved = productionCapUsage();
    if (reserved + estimated > spendLimit) {
      return { blocked: true, reason: 'spend_limit', reserved, spendLimit };
    }
    db.prepare(
      `INSERT INTO provider_usage(provider, mode, endpoint, credits, job_id, charge_kind)
       VALUES ('tracerfy', ?, ?, ?, ?, 'reserved')`
    ).run(PROVIDER_MODES.PRODUCTION, endpoint, estimated, jobId);
    return { reserved: estimated, chargeKind: 'reserved', billable: estimated };
  });
  return run.immediate();
}

/**
 * Settle credits for a finished job.
 * Uncertain outcomes KEEP a conservative reservation (reserved_uncertain) that still
 * counts against the production cap until explicit reconciliation with evidence.
 * Never DELETE reservation history — convert / append audit rows only.
 */
function settleCredits({ jobId, mode, endpoint, actualCredits, unknown = false }) {
  if (unknown) {
    const open = db
      .prepare(
        `SELECT id, credits, charge_kind FROM provider_usage
         WHERE job_id = ? AND charge_kind IN ('reserved','reserved_simulated')`
      )
      .all(jobId);
    if (open.length) {
      for (const row of open) {
        const nextKind =
          row.charge_kind === 'reserved' ? 'reserved_uncertain' : 'reserved_uncertain_simulated';
        db.prepare(`UPDATE provider_usage SET charge_kind = ? WHERE id = ?`).run(nextKind, row.id);
      }
    } else {
      // No prior reservation row — still hold estimated against the cap when production
      const job = db.prepare('SELECT estimated_credits FROM contact_jobs WHERE id = ?').get(jobId);
      const hold = Number(job?.estimated_credits || 0);
      db.prepare(
        `INSERT INTO provider_usage(provider, mode, endpoint, credits, job_id, charge_kind)
         VALUES ('tracerfy', ?, ?, ?, ?, ?)`
      ).run(
        mode,
        endpoint,
        hold,
        jobId,
        mode === PROVIDER_MODES.PRODUCTION ? 'reserved_uncertain' : 'reserved_uncertain_simulated'
      );
    }
    // Append non-counting audit marker (history, not erase)
    db.prepare(
      `INSERT INTO provider_usage(provider, mode, endpoint, credits, job_id, charge_kind)
       VALUES ('tracerfy', ?, ?, 0, ?, 'unknown_outcome_audit')`
    ).run(mode, endpoint, jobId);
    return;
  }

  // Certain outcome: convert open reservations to settled (append release audit, zero out hold)
  const open = db
    .prepare(
      `SELECT id, credits, charge_kind FROM provider_usage
       WHERE job_id = ? AND charge_kind IN ('reserved','reserved_simulated','reserved_uncertain','reserved_uncertain_simulated')`
    )
    .all(jobId);
  for (const row of open) {
    // Append history: mark prior hold as settled_from_* without deleting the row's audit trail —
    // convert charge_kind so it no longer counts toward cap, keep credits for forensics.
    const settledKind =
      row.charge_kind.startsWith('reserved_uncertain')
        ? 'settled_from_uncertain'
        : 'settled_from_reserved';
    db.prepare(`UPDATE provider_usage SET charge_kind = ? WHERE id = ?`).run(settledKind, row.id);
  }

  const kind =
    mode === PROVIDER_MODES.PRODUCTION
      ? 'actual'
      : mode === PROVIDER_MODES.HOSTED_SANDBOX
        ? 'simulated_sandbox'
        : 'simulated_fixture';
  db.prepare(
    `INSERT INTO provider_usage(provider, mode, endpoint, credits, job_id, charge_kind)
     VALUES ('tracerfy', ?, ?, ?, ?, ?)`
  ).run(mode, endpoint, actualCredits, jobId, kind);
}

function appendReconcileAudit(jobId, mode, endpoint, chargeKind, note) {
  db.prepare(
    `INSERT INTO provider_usage(provider, mode, endpoint, credits, job_id, charge_kind)
     VALUES ('tracerfy', ?, ?, 0, ?, ?)`
  ).run(mode, endpoint || '', jobId, `${chargeKind}:${String(note || '').slice(0, 120)}`);
}

function failJob(jobId, error, responseJson = null, status = 'failed') {
  db.prepare(
    `UPDATE contact_jobs SET status=?, error=?, response_json=?, finished_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
  ).run(status, typeof error === 'string' ? error : JSON.stringify(error), JSON.stringify(responseJson || error), jobId);
  return db.prepare('SELECT * FROM contact_jobs WHERE id = ?').get(jobId);
}

/**
 * Cache reuse scoped to job mode + current property identity + originating lookup.
 * Excludes rejected/outdated/needs_review — old contacts needing review must not
 * become "current" merely because a new lookup succeeds.
 * Production jobs never reuse sandbox/fixture contacts.
 */
function loadCachedContactsForJob(job, property = null) {
  if (!job?.property_id) return [];
  if (property?.identity_key) {
    let reqIdentity = null;
    try {
      const req = JSON.parse(job.request_json || '{}');
      // Fingerprint input is stored; compare live property fields to request
      const liveAddr = String(property.site_address || '').trim().toLowerCase();
      const reqAddr = String(req.address || '').trim().toLowerCase();
      const liveParcel = String(property.parcel_apn || '').trim().toLowerCase();
      const reqParcel = String(req.parcel_id || '').trim().toLowerCase();
      if (req.address != null && liveAddr && reqAddr && liveAddr !== reqAddr) return [];
      if (req.parcel_id != null && liveParcel && reqParcel && liveParcel !== reqParcel) return [];
      reqIdentity = property.identity_key;
    } catch {
      /* keep going with property_id scope */
    }
    void reqIdentity;
  }
  const origins =
    job.mode === PROVIDER_MODES.PRODUCTION
      ? ['provider']
      : job.mode === PROVIDER_MODES.HOSTED_SANDBOX
        ? ['sandbox_demo']
        : ['local_fixture', 'sandbox_demo'];
  return db
    .prepare(
      `SELECT * FROM contacts
       WHERE property_id = ?
         AND provider = 'tracerfy'
         AND status NOT IN ('rejected','outdated','needs_review')
         AND record_origin IN (${origins.map(() => '?').join(',')})
       ORDER BY id`
    )
    .all(job.property_id, ...origins);
}

/**
 * True when a hosted-sandbox request would involve operational/imported data.
 * Only explicitly invented sandbox_demo properties (not tied to import lots/permits) are allowed.
 */
export function propertyInvolvesOperationalData(
  property,
  { permitRecordId = null, lotGroupId = null } = {}
) {
  if (!property) return true;

  if (permitRecordId) {
    const p = db.prepare(`SELECT record_origin FROM permit_records WHERE id = ?`).get(Number(permitRecordId));
    if (p?.record_origin === 'import') return true;
  }
  if (lotGroupId) {
    const lg = db.prepare(`SELECT record_origin FROM lot_groups WHERE id = ?`).get(Number(lotGroupId));
    if (lg?.record_origin === 'import') return true;
  }

  const importLink = db
    .prepare(
      `SELECT 1 AS ok
       FROM property_links pl
       JOIN lot_groups lg ON lg.id = pl.lot_group_id
       WHERE pl.property_id = ? AND lg.record_origin = 'import'
       LIMIT 1`
    )
    .get(property.id);
  if (importLink) return true;

  // Hosted sandbox verification requires explicitly invented sandbox_demo properties
  return property.record_origin !== 'sandbox_demo';
}

/**
 * Run a contact lookup job.
 * Duplicate fingerprint while open/succeeded → returns existing job + existing candidates (no rebill).
 * Timed-out jobs with uncertain outcomes block automatic resubmission until manual resolution.
 */
export async function runContactLookup({
  property,
  permitRecordId = null,
  lotGroupId = null,
  endpointKey = 'instant_trace',
  forceFail = null,
  soughtRole = '',
  opportunityId = null,
} = {}) {
  const cfg = tracerfyConfig();
  const endpoint = TRACERFY_ENDPOINTS[endpointKey];
  if (!endpoint) throw new Error(`Unknown endpoint ${endpointKey}`);

  if (cfg.mode === 'not_configured') {
    throw new Error(
      cfg.hardSpendLock
        ? 'Live Tracerfy production blocked by Phase 6 hard spend lock (production disabled, spend cap 0). Use local_fixture or hosted_sandbox only.'
        : 'Tracerfy production Not configured — need TRACERFY_API_TOKEN env, spend limit, commercial confirmation, and production_enabled=1. Use local_fixture or hosted_sandbox meanwhile.'
    );
  }

  // Hosted sandbox: reject operational/imported data BEFORE any network request
  if (cfg.mode === PROVIDER_MODES.HOSTED_SANDBOX) {
    if (propertyInvolvesOperationalData(property, { permitRecordId, lotGroupId })) {
      throw new Error(
        'hosted_sandbox rejected: operational/imported property data not allowed. Use an invented sandbox_demo property only.'
      );
    }
  }

  const input =
    endpointKey === 'apn_instant'
      ? {
          parcel_id: property.parcel_apn,
          county: property.parcel_jurisdiction || property.city,
          state: property.state || '',
        }
      : {
          address: property.site_address,
          city: property.city,
          state: property.state || '',
          zip: property.zip,
          find_owner: true,
        };

  if (endpointKey === 'instant_trace' && !input.address) {
    throw new Error('site_address required for instant_trace');
  }
  if (endpointKey === 'apn_instant' && !input.parcel_id) {
    throw new Error('parcel_apn required for apn_instant');
  }
  if (endpointKey === 'instant_trace' && !input.state) {
    // Do not invent Virginia — require explicit state
    throw new Error('state required for instant_trace (never defaulted)');
  }

  const fingerprint = requestFingerprint({
    endpointKey,
    mode: cfg.mode,
    property_id: property.id,
    identity_key: property.identity_key || '',
    sought_role: soughtRole || '',
    input,
  });

  // Block resubmit while timed_out / unresolved / abandoned_blocked jobs exist for this fingerprint
  const unresolved = db
    .prepare(
      `SELECT * FROM contact_jobs
       WHERE request_fingerprint = ?
         AND status IN ('timed_out','unresolved_timeout','abandoned_blocked')
       ORDER BY id DESC LIMIT 1`
    )
    .get(fingerprint);
  if (unresolved) {
    return {
      job: unresolved,
      blocked: true,
      reconcileBeforeResubmit: true,
      error: {
        status: 409,
        error:
          unresolved.status === 'abandoned_blocked' ? 'abandoned_blocked' : 'unresolved_timeout',
        detail:
          unresolved.status === 'abandoned_blocked'
            ? 'Prior lookup was abandoned — automatic resubmission remains blocked. Use explicit retry authorization (manual_allow_resubmit) with evidence.'
            : 'Prior lookup timed out with uncertain provider outcome. Resolve manually before resubmit — not safe to resubmit automatically.',
      },
    };
  }

  const existing = db
    .prepare(
      `SELECT * FROM contact_jobs
       WHERE request_fingerprint = ? AND status IN ('queued','running','succeeded')
       ORDER BY id DESC LIMIT 1`
    )
    .get(fingerprint);
  if (existing && existing.status === 'succeeded') {
    const cached = loadCachedContactsForJob(existing, property);
    let contacts = cached.map((c) => ({
      role: c.role,
      full_name: c.full_name,
      company: c.company,
      phone: c.phone,
      email: c.email,
      mailing_address: c.mailing_address,
      restriction_flags: JSON.parse(c.restriction_flags_json || '[]'),
      _cachedContactId: c.id,
    }));
    if (!contacts.length && existing.response_json) {
      try {
        contacts = mapPersonsToContactFields(JSON.parse(existing.response_json));
      } catch {
        contacts = [];
      }
    }
    return {
      job: existing,
      deduped: true,
      contacts,
      cached: true,
      estimatedCredits: 0,
      actualCredits: existing.actual_credits,
    };
  }
  if (existing && ['queued', 'running'].includes(existing.status)) {
    return { job: existing, deduped: true, inFlight: true, contacts: [], estimatedCredits: 0 };
  }

  const info = db
    .prepare(
      `INSERT INTO contact_jobs(
         provider, mode, property_id, permit_record_id, lot_group_id, request_fingerprint,
         endpoint, status, estimated_credits, reserved_credits, request_json, attempts,
         sought_role, opportunity_id)
       VALUES ('tracerfy', ?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, 0, ?, ?)`
    )
    .run(
      cfg.mode,
      property.id,
      permitRecordId,
      lotGroupId,
      fingerprint,
      endpoint.path,
      endpoint.estimatedCredits,
      JSON.stringify(input),
      soughtRole || '',
      opportunityId || null
    );
  const jobId = Number(info.lastInsertRowid);

  db.prepare(
    `UPDATE contact_jobs SET status = 'running', attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?`
  ).run(jobId);

  const reservation = reserveCredits({
    mode: cfg.mode,
    endpoint: endpoint.path,
    estimated: endpoint.estimatedCredits,
    jobId,
  });
  if (reservation.blocked) {
    const job = failJob(jobId, 'Spend limit would be exceeded (reserved + estimated)');
    return { job, error: { status: 402, error: 'spend_limit', ...reservation } };
  }
  db.prepare(`UPDATE contact_jobs SET reserved_credits = ?, updated_at = datetime('now') WHERE id = ?`).run(
    reservation.reserved || 0,
    jobId
  );

  // Simulated provider outcomes for offline tests
  if (forceFail === 'insufficient_credits') {
    const err = {
      status: 402,
      error: 'Insufficient credits. Instant trace requires 5 credits per lookup. You have 0 credits.',
    };
    settleCredits({ jobId, mode: cfg.mode, endpoint: endpoint.path, actualCredits: 0 });
    return { job: failJob(jobId, err.error, err), error: err };
  }
  if (forceFail === 'rate_limit') {
    const err = { status: 429, error: 'Rate limit exceeded. Max 500 lookups per minute.', lookups_in_window: 500 };
    settleCredits({ jobId, mode: cfg.mode, endpoint: endpoint.path, actualCredits: 0 });
    return { job: failJob(jobId, err.error, err), error: err };
  }
  if (forceFail === 'timeout') {
    settleCredits({ jobId, mode: cfg.mode, endpoint: endpoint.path, actualCredits: 0, unknown: true });
    const job = failJob(
      jobId,
      'Lookup timed out — outcome uncertain; manual resolution required before resubmit',
      { error: 'timeout' },
      'timed_out'
    );
    return {
      job,
      error: { status: 504, error: 'timeout' },
      reconcileBeforeResubmit: true,
    };
  }
  if (forceFail === 'no_match') {
    const resp = sanitizeProviderResponseForStorage({
      hit: false,
      persons_count: 0,
      credits_deducted: 0,
      meta: { demo_label: 'FABRICATED_LOCAL_FIXTURE_NO_MATCH' },
    });
    settleCredits({ jobId, mode: cfg.mode, endpoint: endpoint.path, actualCredits: 0 });
    db.prepare(
      `UPDATE contact_jobs SET status='succeeded', actual_credits=0, response_json=?, finished_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
    ).run(JSON.stringify(resp), jobId);
    return {
      job: db.prepare('SELECT * FROM contact_jobs WHERE id = ?').get(jobId),
      contacts: [],
      noMatch: true,
      estimatedCredits: endpoint.estimatedCredits,
      actualCredits: 0,
    };
  }
  if (forceFail === 'http_401' || forceFail === 'malformed') {
    const err =
      forceFail === 'http_401'
        ? { status: 401, detail: 'Authentication credentials were not provided.' }
        : { status: 200, parseError: true, detail: 'malformed JSON body' };
    settleCredits({ jobId, mode: cfg.mode, endpoint: endpoint.path, actualCredits: 0 });
    return { job: failJob(jobId, err.detail || 'provider_error', err), error: err };
  }

  let response;
  let actualCredits = 0;
  let externalRequestId = null;
  let httpStatus = 200;

  if (cfg.mode === PROVIDER_MODES.LOCAL_FIXTURE) {
    response = fabricateSandboxResponse(input);
    actualCredits = 0;
    externalRequestId = response.meta?.request_id || null;
  } else if (cfg.mode === PROVIDER_MODES.HOSTED_SANDBOX || cfg.mode === PROVIDER_MODES.PRODUCTION) {
    const base = cfg.mode === PROVIDER_MODES.PRODUCTION ? PROD_BASE : SANDBOX_BASE;
    const token =
      cfg.mode === PROVIDER_MODES.PRODUCTION
        ? productionToken()
        : process.env.TRACERFY_SANDBOX_TOKEN || 'sandbox_test_token';
    if (cfg.mode === PROVIDER_MODES.PRODUCTION && !token) {
      settleCredits({ jobId, mode: cfg.mode, endpoint: endpoint.path, actualCredits: 0 });
      return {
        job: failJob(jobId, 'Production Tracerfy Not configured — TRACERFY_API_TOKEN missing from environment'),
        error: { status: 403, error: 'not_configured' },
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.mode === PROVIDER_MODES.PRODUCTION ? 15000 : 10000);
    try {
      const remote = await httpJson(`${base}${endpoint.path}`, {
        token,
        body: input,
        signal: controller.signal,
      });
      clearTimeout(timer);
      httpStatus = remote.status;
      externalRequestId =
        remote.headers['x-request-id'] || remote.headers['X-Request-Id'] || remote.json?.meta?.request_id || null;

      if (remote.parseError) {
        settleCredits({ jobId, mode: cfg.mode, endpoint: endpoint.path, actualCredits: 0 });
        return {
          job: failJob(jobId, `Malformed JSON from provider (HTTP ${remote.status})`, {
            status: remote.status,
            parseError: remote.parseError,
            textLength: remote.textLength,
            request_id: externalRequestId,
          }),
          error: { status: remote.status, error: 'malformed_json', request_id: externalRequestId },
        };
      }

      if (remote.status === 401 || remote.status === 403) {
        settleCredits({ jobId, mode: cfg.mode, endpoint: endpoint.path, actualCredits: 0 });
        return {
          job: failJob(jobId, remote.json.detail || remote.json.error || `HTTP ${remote.status}`, {
            ...remote.json,
            request_id: externalRequestId,
          }),
          error: { status: remote.status, ...remote.json, request_id: externalRequestId },
        };
      }
      if (remote.status === 402 || remote.status === 429) {
        settleCredits({ jobId, mode: cfg.mode, endpoint: endpoint.path, actualCredits: 0 });
        return {
          job: failJob(jobId, remote.json.error || String(remote.status), {
            ...remote.json,
            request_id: externalRequestId,
          }),
          error: { status: remote.status, ...remote.json, request_id: externalRequestId },
        };
      }
      if (remote.status >= 500) {
        settleCredits({ jobId, mode: cfg.mode, endpoint: endpoint.path, actualCredits: 0 });
        return {
          job: failJob(jobId, remote.json.error || `HTTP ${remote.status}`, {
            ...remote.json,
            request_id: externalRequestId,
          }),
          error: { status: remote.status, error: 'provider_5xx', request_id: externalRequestId },
        };
      }
      if (remote.status !== 200) {
        settleCredits({ jobId, mode: cfg.mode, endpoint: endpoint.path, actualCredits: 0 });
        return {
          job: failJob(jobId, `Unexpected HTTP ${remote.status}`, {
            ...remote.json,
            request_id: externalRequestId,
          }),
          error: { status: remote.status, error: 'unexpected_status', request_id: externalRequestId },
        };
      }

      response = remote.json;
      actualCredits =
        cfg.mode === PROVIDER_MODES.PRODUCTION ? Number(response.credits_deducted || 0) : 0;
    } catch (e) {
      clearTimeout(timer);
      // Network/timeout — outcome uncertain; do NOT fabricate success
      settleCredits({ jobId, mode: cfg.mode, endpoint: endpoint.path, actualCredits: 0, unknown: true });
      const job = failJob(
        jobId,
        `Network/timeout contacting ${base}: ${String(e.message || e)} — outcome uncertain`,
        { error: 'timeout', base },
        'timed_out'
      );
      return {
        job,
        error: { status: 504, error: 'timeout', detail: String(e.message || e), base },
        reconcileBeforeResubmit: true,
      };
    }
  } else {
    settleCredits({ jobId, mode: cfg.mode, endpoint: endpoint.path, actualCredits: 0 });
    return {
      job: failJob(jobId, `Unknown provider mode ${cfg.mode}`),
      error: { status: 500, error: 'bad_mode' },
    };
  }

  const sanitized = sanitizeProviderResponseForStorage(response);
  const contacts = mapPersonsToContactFields(sanitized);
  settleCredits({ jobId, mode: cfg.mode, endpoint: endpoint.path, actualCredits });
  db.prepare(
    `UPDATE contact_jobs SET status='succeeded', actual_credits=?, response_json=?,
     external_request_id=?, reserved_credits=0, finished_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
  ).run(actualCredits, JSON.stringify(sanitized), externalRequestId || sanitized?.meta?.request_id || null, jobId);

  return {
    job: db.prepare('SELECT * FROM contact_jobs WHERE id = ?').get(jobId),
    contacts,
    responseMeta: sanitized?.meta || {},
    estimatedCredits: endpoint.estimatedCredits,
    actualCredits,
    httpStatus,
    externalRequestId: externalRequestId || sanitized?.meta?.request_id || null,
    noMatch: !contacts.length,
  };
}

/**
 * Manual resolution for timed-out / abandoned jobs.
 * - manual_abandon: keeps automatic resubmission blocked; does NOT release uncertain charge hold.
 * - manual_allow_resubmit: separate auditable action with evidence; releases uncertain hold only then.
 * Never erases provider_usage history (append/convert only).
 */
export function reconcileTimedOutJob(jobId, { resolution = 'manual_abandon', note = '' } = {}) {
  const job = db.prepare('SELECT * FROM contact_jobs WHERE id = ?').get(Number(jobId));
  if (!job) throw new Error('Job not found');
  if (!['timed_out', 'unresolved_timeout', 'abandoned_blocked'].includes(job.status)) {
    return { job, action: 'noop', note: 'Job is not in a timed-out/abandoned state' };
  }

  if (resolution === 'manual_abandon') {
    if (job.status === 'abandoned_blocked') {
      return {
        job,
        action: 'noop',
        safeToResubmit: false,
        note: 'Already abandoned — automatic resubmit remains blocked; uncertain charge hold retained.',
      };
    }
    db.prepare(
      `UPDATE contact_jobs SET status='abandoned_blocked', updated_at=datetime('now'),
       error = TRIM(COALESCE(error,'') || ?) WHERE id = ?`
    ).run(
      ` | abandoned_blocked — automatic resubmit blocked; uncertain charge hold retained. ${note}`.trim(),
      job.id
    );
    // Append audit only — do NOT release reserved_uncertain (still counts against cap)
    appendReconcileAudit(job.id, job.mode, job.endpoint, 'reconcile_abandon', note);
    return {
      job: db.prepare('SELECT * FROM contact_jobs WHERE id = ?').get(job.id),
      action: 'abandoned_blocked',
      safeToResubmit: false,
      note: 'Abandoned. Automatic resubmission remains blocked. Uncertain credit reservation still counts against the spend cap until explicit retry authorization with evidence.',
    };
  }

  if (resolution === 'manual_allow_resubmit') {
    if (!note || !String(note).trim()) {
      throw new Error(
        'manual_allow_resubmit requires evidence note — will not silently release an uncertain charge'
      );
    }
    db.prepare(
      `UPDATE contact_jobs SET status='manually_resolved_allow_resubmit', updated_at=datetime('now'),
       error = TRIM(COALESCE(error,'') || ?) WHERE id = ?`
    ).run(
      ` | allow_resubmit after operator evidence: ${note}`.trim(),
      job.id
    );
    // Convert uncertain holds so they no longer count toward cap — keep rows for history
    const holds = db
      .prepare(
        `SELECT id, charge_kind FROM provider_usage
         WHERE job_id = ? AND charge_kind IN ('reserved_uncertain','reserved_uncertain_simulated')`
      )
      .all(job.id);
    for (const row of holds) {
      db.prepare(`UPDATE provider_usage SET charge_kind = 'released_with_evidence' WHERE id = ?`).run(
        row.id
      );
    }
    appendReconcileAudit(job.id, job.mode, job.endpoint, 'reconcile_allow_resubmit', note);
    return {
      job: db.prepare('SELECT * FROM contact_jobs WHERE id = ?').get(job.id),
      action: 'manually_resolved_allow_resubmit',
      safeToResubmit: true,
      note: 'Operator provided evidence. Uncertain hold released with audit. Resubmit allowed.',
    };
  }

  throw new Error(`Unknown resolution ${resolution}`);
}
