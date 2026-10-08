/**
 * Phase 6 — Contacts, rights, cost preview, and permitted Opportunities handoff.
 *
 * Hard spend lock: production Tracerfy disabled; spend cap 0; fixture/sandbox only.
 * Live enriched-lead pilot remains BLOCKED until separate rights/budget approval.
 *
 * Never equate applicant / contractor / owner / borrower.
 * Never invent borrower identity from a permitted property.
 */
import { db, getSetting, setSetting } from './db.js';
import { upsertProperty } from './property.js';
import {
  CONTACT_ROLES,
  findContactsForProperty,
  listContacts,
  setContactStatus,
} from './contacts.js';
import {
  TRACERFY_ENDPOINTS,
  PROVIDER_MODES,
  tracerfyConfig,
  requestFingerprint,
  productionCapUsage,
  hardSpendLockActive,
} from './providers/tracerfy.js';

/** Roles that may be sought for relationship / coordination handoff. */
export const SOUGHT_ROLES = Object.freeze([
  'property_owner',
  'owner_company',
  'applicant',
  'contractor',
  'developer',
  'architect_engineer',
  'agency_contact',
  'unknown_party',
]);

/** Explicitly rejected as auto-equated roles from permit/property evidence. */
export const FORBIDDEN_SOUGHT_ROLES = Object.freeze([
  'borrower',
  'mortgage_borrower',
  'mortgagor',
  'loan_applicant',
  'homeowner_financing',
  'buyer',
]);

export const SUPPRESSION_CHANNELS = Object.freeze(['email', 'phone', 'sms', 'mail']);

export const ROLE_NON_EQUIVALENCE_NOTE =
  'Applicant, contractor, property owner, owner company, developer, and borrower are distinct roles. ' +
  'A permitted property does not identify a mortgage borrower or someone seeking financing. ' +
  'Never auto-equate these roles.';

export function ensurePhase6HardSpendLock() {
  // Production stays off; spend cap stays 0 under Phase 6 hard lock.
  if (getSetting('tracerfy_hard_spend_lock', '1') !== '0') {
    setSetting('tracerfy_production_enabled', '0');
    setSetting('tracerfy_spend_limit_credits', '0');
    if (getSetting('tracerfy_provider_mode', '') === PROVIDER_MODES.PRODUCTION) {
      setSetting('tracerfy_provider_mode', PROVIDER_MODES.LOCAL_FIXTURE);
    }
  }
}

export function normalizeSoughtRole(raw) {
  const role = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (!role) {
    return { ok: false, error: 'sought_role_required', detail: 'Ask which role is sought before any contact lookup.' };
  }
  if (FORBIDDEN_SOUGHT_ROLES.includes(role)) {
    return {
      ok: false,
      error: 'forbidden_sought_role',
      detail:
        `Role "${role}" is not allowed as a sought contact role. ` +
        ROLE_NON_EQUIVALENCE_NOTE +
        ' Homeowner financing prospecting needs separate targeting and compliance approval.',
    };
  }
  if (!SOUGHT_ROLES.includes(role)) {
    return {
      ok: false,
      error: 'invalid_sought_role',
      detail: `Unknown sought role "${role}". Allowed: ${SOUGHT_ROLES.join(', ')}. ${ROLE_NON_EQUIVALENCE_NOTE}`,
    };
  }
  if (role === 'internal_assignee') {
    return {
      ok: false,
      error: 'invalid_sought_role',
      detail: 'internal_assignee is for manual staff assignment — not a provider lookup target.',
    };
  }
  return { ok: true, role };
}

export function normalizeChannelValue(channel, value) {
  const ch = String(channel || '').toLowerCase();
  let v = String(value || '').trim().toLowerCase();
  if (!v) return null;
  if (ch === 'phone' || ch === 'sms') {
    v = v.replace(/[^\d+]/g, '');
    if (v.startsWith('+1') && v.length === 12) v = v.slice(2);
    if (v.length === 11 && v.startsWith('1')) v = v.slice(1);
  }
  if (ch === 'email') {
    v = v.replace(/\s+/g, '');
  }
  if (ch === 'mail') {
    v = v.replace(/\s+/g, ' ');
  }
  return v || null;
}

export function listSuppressions({ channel = null, propertyId = null } = {}) {
  let sql = `SELECT * FROM contact_suppressions WHERE 1=1`;
  const params = [];
  if (channel) {
    sql += ' AND channel = ?';
    params.push(channel);
  }
  if (propertyId != null) {
    sql += ' AND (property_id IS NULL OR property_id = ?)';
    params.push(Number(propertyId));
  }
  sql += ' ORDER BY id DESC';
  return db.prepare(sql).all(...params);
}

export function isSuppressed({ channel, value, propertyId = null }) {
  const normalized = normalizeChannelValue(channel, value);
  if (!normalized) return false;
  const rows = db
    .prepare(
      `SELECT * FROM contact_suppressions
       WHERE channel = ? AND value_normalized = ?
         AND (property_id IS NULL OR property_id = ?)`
    )
    .all(channel, normalized, propertyId == null ? -1 : Number(propertyId));
  return rows.length > 0 ? rows[0] : null;
}

export function suppressContactChannel(
  { channel, value, reason = '', propertyId = null, opportunityId = null, fullName = '' },
  { actor = 'ui' } = {}
) {
  if (!SUPPRESSION_CHANNELS.includes(channel)) {
    throw new Error(`Invalid suppression channel ${channel}`);
  }
  const normalized = normalizeChannelValue(channel, value);
  if (!normalized) throw new Error('Suppression value required');
  if (!reason || !String(reason).trim()) throw new Error('Suppression reason required');

  const propertyIdKey = propertyId ? Number(propertyId) : 0;
  db.prepare(
    `INSERT INTO contact_suppressions(
       channel, value_normalized, full_name, reason, scope, property_id, opportunity_id, property_id_key, created_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel, value_normalized, scope, property_id_key) DO UPDATE SET
       reason = excluded.reason,
       full_name = excluded.full_name,
       opportunity_id = COALESCE(excluded.opportunity_id, contact_suppressions.opportunity_id),
       created_by = excluded.created_by,
       created_at = datetime('now')`
  ).run(
    channel,
    normalized,
    fullName || '',
    String(reason).trim(),
    propertyId ? 'property' : 'workspace',
    propertyId ? Number(propertyId) : null,
    opportunityId ? Number(opportunityId) : null,
    propertyIdKey,
    actor
  );

  // Mark matching live contacts as rejected so export/review honor suppression.
  const contacts = db
    .prepare(
      `SELECT * FROM contacts WHERE
         (? = 'email' AND lower(email) = ?)
         OR (? IN ('phone','sms') AND replace(replace(replace(phone,'-',''),' ',''),'+','') LIKE '%' || ?)
         OR (? = 'mail' AND lower(mailing_address) = ?)`
    )
    .all(channel, normalized, channel, normalized, channel, normalized);

  for (const c of contacts) {
    if (c.status === 'rejected') continue;
    if (propertyId && Number(c.property_id) !== Number(propertyId)) continue;
    setContactStatus(c.id, 'rejected', {
      reason: `suppressed:${channel}:${reason}`,
      actor,
    });
  }

  return listSuppressions({ channel }).find((s) => s.value_normalized === normalized);
}

/**
 * Reject / suppress must not silently reaccept on relookup or re-import.
 */
export function contactBlockedByPriorDecision(propertyId, contactFields) {
  const fp = `${String(contactFields.full_name || '').toLowerCase()}|${String(contactFields.phone || '').toLowerCase()}|${String(contactFields.email || '').toLowerCase()}`;
  const rejected = db
    .prepare(
      `SELECT id, status, rejected_reason FROM contacts
       WHERE property_id = ? AND status = 'rejected'
         AND lower(full_name) || '|' || lower(COALESCE(phone,'')) || '|' || lower(COALESCE(email,'')) = ?`
    )
    .get(Number(propertyId), fp);
  if (rejected) {
    return { blocked: true, reason: 'prior_rejection', contactId: rejected.id, detail: rejected.rejected_reason };
  }
  for (const ch of ['email', 'phone', 'sms', 'mail']) {
    const val =
      ch === 'email'
        ? contactFields.email
        : ch === 'mail'
          ? contactFields.mailing_address
          : contactFields.phone;
    const hit = isSuppressed({ channel: ch === 'sms' ? 'phone' : ch, value: val, propertyId });
    // Also check sms channel explicitly for phone numbers
    const hitSms =
      (ch === 'phone' || ch === 'sms') &&
      isSuppressed({ channel: 'sms', value: contactFields.phone, propertyId });
    if (hit || hitSms) {
      return {
        blocked: true,
        reason: 'channel_suppression',
        suppression: hit || hitSms,
      };
    }
  }
  return { blocked: false };
}

function endpointMeta(endpointKey = 'instant_trace') {
  const ep = TRACERFY_ENDPOINTS[endpointKey];
  if (!ep) throw new Error(`Unknown endpoint ${endpointKey}`);
  return ep;
}

/**
 * Cost preview BEFORE any purchase path.
 * Fixture/sandbox estimated billable cost is always zero.
 */
export function previewContactLookupCost({
  targets = [],
  endpointKey = 'instant_trace',
  soughtRole = null,
} = {}) {
  ensurePhase6HardSpendLock();
  const roleCheck = normalizeSoughtRole(soughtRole);
  if (!roleCheck.ok) return { ok: false, ...roleCheck };

  const cfg = tracerfyConfig();
  const ep = endpointMeta(endpointKey);
  const hardLock = hardSpendLockActive();

  // Deduplicate by property identity / fingerprint
  const seen = new Map();
  const deduped = [];
  for (const t of targets) {
    const key =
      t.fingerprint ||
      requestFingerprint({
        endpointKey,
        property_id: t.propertyId || null,
        opportunity_id: t.opportunityId || null,
        address: t.address || '',
        parcel: t.parcel || '',
        sought_role: roleCheck.role,
      });
    if (seen.has(key)) continue;
    seen.set(key, true);
    deduped.push({ ...t, fingerprint: key });
  }

  const isFixtureOrSandbox =
    cfg.mode === PROVIDER_MODES.LOCAL_FIXTURE || cfg.mode === PROVIDER_MODES.HOSTED_SANDBOX;
  const perHitCredits = isFixtureOrSandbox ? 0 : ep.estimatedCredits;
  const maxEstimatedCredits = deduped.length * perHitCredits;
  const maxEstimatedUsd = isFixtureOrSandbox ? 0 : Number((maxEstimatedCredits * 0.02).toFixed(4));

  const spendLimit = hardLock ? 0 : Number(cfg.spendLimitCredits || 0);
  const used = cfg.mode === PROVIDER_MODES.PRODUCTION ? productionCapUsage() : 0;
  const availableBudgetCredits = Math.max(0, spendLimit - used);

  const liveEnrichmentBlocked =
    hardLock ||
    cfg.mode !== PROVIDER_MODES.PRODUCTION ||
    !cfg.productionEnabled ||
    spendLimit <= 0;

  const wouldExceed =
    !isFixtureOrSandbox && maxEstimatedCredits > availableBudgetCredits;

  return {
    ok: true,
    soughtRole: roleCheck.role,
    roleNote: ROLE_NON_EQUIVALENCE_NOTE,
    deduplicatedTargetCount: deduped.length,
    rawTargetCount: targets.length,
    targets: deduped,
    endpoint: endpointKey,
    endpointDescription: ep.description,
    providerMode: cfg.mode,
    requestedMode: cfg.requestedMode,
    maxEstimatedCredits,
    maxEstimatedUsd,
    availableBudgetCredits,
    spendLimitCredits: spendLimit,
    hardSpendLock: hardLock,
    fixtureCostZero: isFixtureOrSandbox,
    liveEnrichmentBlocked,
    liveEnrichmentStatus: liveEnrichmentBlocked ? 'BLOCKED' : 'allowed',
    liveEnrichmentBlockReason: liveEnrichmentBlocked
      ? 'Live enriched-lead pilot blocked until separate rights/budget approval. Phase 6 hard spend lock: production disabled, spend cap 0, fixture/sandbox only.'
      : null,
    wouldExceedBudget: wouldExceed,
    purchaseAllowed: isFixtureOrSandbox && !wouldExceed,
    rightsUnresolved: cfg.rightsUnresolved,
  };
}

/**
 * Prepare a sandbox_demo property from an opportunity for fixture contact review.
 * Does not invent borrower identity. Address/parcel only from public activity evidence.
 */
export function propertyFromOpportunity(opportunity, { actor = 'ui' } = {}) {
  if (!opportunity) throw new Error('Opportunity required');
  if (!opportunity.address && !opportunity.parcel) {
    throw new Error(
      'Opportunity has no address or parcel — cannot prepare contact review without property evidence'
    );
  }
  const prop = upsertProperty(
    {
      site_address: opportunity.address || '',
      city: opportunity.city || '',
      state: opportunity.state || 'VA',
      zip: opportunity.zip || '',
      parcel_apn: opportunity.parcel || '',
      parcel_jurisdiction: opportunity.jurisdiction_code || 'fairfax_county',
      record_origin: 'sandbox_demo',
      match_state: 'candidate',
      notes: `Opportunity contact-review property for ${opportunity.official_id} — not a borrower identity`,
    },
    { actor }
  );
  // Mark origin explicitly sandbox_demo even if upsert reused an identity
  db.prepare(
    `UPDATE properties SET record_origin = 'sandbox_demo',
       notes = TRIM(COALESCE(notes,'') || ?) WHERE id = ?`
  ).run(
    ` | opp:${opportunity.id}:${opportunity.official_id}`,
    prop.id
  );
  return db.prepare('SELECT * FROM properties WHERE id = ?').get(prop.id);
}

export function getOpportunity(id) {
  return db.prepare('SELECT * FROM opportunities WHERE id = ?').get(Number(id));
}

/**
 * Opportunities → contact review handoff (fixture only under hard lock).
 */
export async function handoffOpportunitiesToContactReview({
  opportunityIds = [],
  soughtRole,
  endpointKey = 'instant_trace',
  dryRun = true,
  actor = 'ui',
} = {}) {
  ensurePhase6HardSpendLock();
  const ids = [...new Set((opportunityIds || []).map(Number).filter(Boolean))];
  if (!ids.length) {
    return { ok: false, error: 'opportunity_ids_required' };
  }

  const opps = ids.map(getOpportunity).filter(Boolean);
  if (opps.length !== ids.length) {
    return { ok: false, error: 'opportunity_not_found', detail: 'One or more opportunity ids missing' };
  }

  const ambiguous = [];
  const targets = [];
  for (const o of opps) {
    const hasAddr = Boolean(String(o.address || '').trim());
    const hasParcel = Boolean(String(o.parcel || '').trim());
    if (!hasAddr && !hasParcel) {
      ambiguous.push({
        opportunityId: o.id,
        officialId: o.official_id,
        reason: 'missing_address_and_parcel',
      });
      continue;
    }
    // Ambiguous when address is only a range / multi-unit without parcel
    if (hasAddr && /[-–]|thru|through|\//i.test(o.address) && !hasParcel) {
      ambiguous.push({
        opportunityId: o.id,
        officialId: o.official_id,
        reason: 'ambiguous_property_identity',
        detail: 'Address looks like a range/multi without parcel — confirm property before lookup',
      });
      continue;
    }
    targets.push({
      opportunityId: o.id,
      officialId: o.official_id,
      address: o.address,
      parcel: o.parcel,
      city: o.city,
      state: o.state,
      zip: o.zip,
    });
  }

  const preview = previewContactLookupCost({
    targets,
    endpointKey,
    soughtRole,
  });
  if (!preview.ok) {
    return { ...preview, ambiguous };
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview,
      ambiguous,
      borrowerNote:
        'Handoff prepares property-role contact review only. It does not invent a borrower or financing applicant.',
      nextStep: preview.purchaseAllowed
        ? 'Confirm with dryRun=false to run fixture contact lookup for non-ambiguous targets.'
        : 'Live purchase path blocked — fixture/sandbox only under hard spend lock.',
    };
  }

  if (!preview.purchaseAllowed) {
    return {
      ok: false,
      error: 'live_enrichment_blocked',
      preview,
      ambiguous,
      status: 'BLOCKED',
      detail: preview.liveEnrichmentBlockReason,
    };
  }

  const results = [];
  for (const t of preview.targets) {
    const opp = getOpportunity(t.opportunityId);
    const property = propertyFromOpportunity(opp, { actor });
    const findResult = await findContactsForProperty({
      propertyId: property.id,
      permitRecordId: null,
      endpointKey,
      soughtRole: preview.soughtRole,
      opportunityId: opp.id,
      requireConfirmedLink: false,
    });
    results.push({
      opportunityId: opp.id,
      officialId: opp.official_id,
      propertyId: property.id,
      soughtRole: preview.soughtRole,
      saved: findResult.saved || [],
      job: findResult.job,
      deduped: findResult.deduped || false,
      actualCredits: findResult.actualCredits ?? 0,
      blocked: findResult.blocked || false,
      isolation: findResult.isolation || null,
      error: findResult.error || null,
    });
  }

  return {
    ok: true,
    dryRun: false,
    preview,
    ambiguous,
    results,
    totalActualCredits: results.reduce((s, r) => s + Number(r.actualCredits || 0), 0),
    liveEnrichmentStatus: 'BLOCKED',
    borrowerNote:
      'Candidates are role-tagged for review only. Property ownership ≠ borrower identity.',
  };
}

export function phase6RightsStatus() {
  ensurePhase6HardSpendLock();
  const cfg = tracerfyConfig();
  return {
    phase: 6,
    hardSpendLock: hardSpendLockActive(),
    productionEnabled: false,
    spendLimitCredits: 0,
    providerMode: cfg.mode,
    liveEnrichedLeadPilot: 'BLOCKED',
    fixtureSandboxAllowed: true,
    outreachDialerSmsEmail: 'disabled',
    rightsUnresolved: cfg.rightsUnresolved,
    roleNonEquivalence: ROLE_NON_EQUIVALENCE_NOTE,
    excludedFields: ['relatives', 'dob', 'age', 'financial_risk', 'ssn', 'borrower_application'],
  };
}

export { CONTACT_ROLES, listContacts, tracerfyConfig, PROVIDER_MODES };
