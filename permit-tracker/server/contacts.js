import { db } from './db.js';
import { runContactLookup, tracerfyConfig, reconcileTimedOutJob, PROVIDER_MODES } from './providers/tracerfy.js';
import { getProperty, propertyBelongsToPermit } from './property.js';

export const CONTACT_ROLES = [
  'property_owner',
  'owner_company',
  'applicant',
  'contractor',
  'developer',
  'architect_engineer',
  'agency_contact',
  'internal_assignee',
  'unknown_party',
];

export const CONTACT_STATUSES = ['candidate', 'confirmed', 'rejected', 'outdated', 'needs_review'];

export function listContacts({
  permitId,
  propertyId,
  lotGroupId,
  includeDemo = false,
  statuses = null,
} = {}) {
  let sql = `SELECT * FROM contacts WHERE 1=1`;
  const params = [];
  if (permitId) {
    sql += ' AND (permit_record_id = ? OR lot_group_id = (SELECT lot_group_id FROM permit_records WHERE id = ?))';
    params.push(Number(permitId), Number(permitId));
  }
  if (propertyId) {
    sql += ' AND property_id = ?';
    params.push(Number(propertyId));
  }
  if (lotGroupId) {
    sql += ' AND lot_group_id = ?';
    params.push(Number(lotGroupId));
  }
  if (!includeDemo) {
    sql += ` AND record_origin != 'sandbox_demo' AND record_origin != 'local_fixture'`;
  }
  if (statuses?.length) {
    sql += ` AND status IN (${statuses.map(() => '?').join(',')})`;
    params.push(...statuses);
  }
  sql += ` ORDER BY CASE status WHEN 'confirmed' THEN 0 WHEN 'candidate' THEN 1 WHEN 'needs_review' THEN 2 WHEN 'outdated' THEN 3 ELSE 4 END, id`;
  return db.prepare(sql).all(...params);
}

export function addManualContact(fields, { actor = 'ui' } = {}) {
  const role = CONTACT_ROLES.includes(fields.role) ? fields.role : 'unknown_party';
  // Internal assignees are labeled distinctly from property owners / external parties
  const notes =
    role === 'internal_assignee'
      ? `${fields.notes || ''} | INTERNAL_ASSIGNEE — not a property owner/external party`.trim()
      : fields.notes || `added by ${actor}`;
  const info = db
    .prepare(
      `INSERT INTO contacts(
         property_id, permit_record_id, lot_group_id, role, full_name, company, phone, email,
         mailing_address, provider, provider_source, retrieved_at, validation_state, status,
         restriction_flags_json, phone_candidates_json, email_candidates_json, record_origin, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      fields.property_id || null,
      fields.permit_record_id || null,
      fields.lot_group_id || null,
      role,
      fields.full_name || '',
      fields.company || '',
      fields.phone || '',
      fields.email || '',
      fields.mailing_address || '',
      fields.provider || 'manual',
      fields.provider_source || 'user_entered',
      fields.validation_state || 'user_confirmed',
      fields.status || 'confirmed',
      JSON.stringify(fields.restriction_flags || []),
      JSON.stringify(fields.phone_candidates || []),
      JSON.stringify(fields.email_candidates || []),
      fields.record_origin || 'manual',
      notes
    );
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(Number(info.lastInsertRowid));
}

export function setContactStatus(id, status, { reason = '', actor = 'ui' } = {}) {
  if (!CONTACT_STATUSES.includes(status)) throw new Error(`Invalid status ${status}`);
  const row = db.prepare('SELECT * FROM contacts WHERE id = ?').get(Number(id));
  if (!row) throw new Error('Contact not found');
  db.prepare(
    `UPDATE contacts SET status = ?, rejected_reason = ?, validation_state = ?,
     notes = TRIM(notes || ?), updated_at = datetime('now') WHERE id = ?`
  ).run(
    status,
    status === 'rejected' ? reason : row.rejected_reason,
    status === 'confirmed' ? 'user_confirmed' : row.validation_state,
    ` | ${actor}:${status}${reason ? `:${reason}` : ''}`,
    id
  );
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(Number(id));
}

function rejectedFingerprints(propertyId) {
  return new Set(
    db
      .prepare(
        `SELECT lower(full_name) || '|' || lower(COALESCE(phone,'')) || '|' || lower(COALESCE(email,'')) AS fp
         FROM contacts WHERE property_id = ? AND status = 'rejected'`
      )
      .all(propertyId)
      .map((r) => r.fp)
  );
}

function contactFingerprint(c) {
  return `${String(c.full_name || '').toLowerCase()}|${String(c.phone || '').toLowerCase()}|${String(c.email || '').toLowerCase()}`;
}

/**
 * Find contacts for a property.
 * - Fixture/hosted_sandbox results never attach to operational workbook records.
 * - Production candidates may attach to confirmed operational property links.
 * - Provider provenance is server-controlled (never client override).
 * - Rejected candidates are preserved and not resurrected on repeat lookup.
 */
export async function findContactsForProperty({
  propertyId,
  permitRecordId = null,
  endpointKey = 'instant_trace',
  forceFail = null,
  requireConfirmedLink = true,
} = {}) {
  const property = getProperty(propertyId);
  if (!property) throw new Error('Property not found');

  const permit = permitRecordId
    ? db.prepare('SELECT * FROM permit_records WHERE id = ?').get(Number(permitRecordId))
    : null;

  // Permit attachment requires explicit, validated, confirmed association.
  // Do NOT implicitly select latest lot link when permitRecordId is absent.
  let lotGroupId = null;
  if (permitRecordId) {
    const belonging = propertyBelongsToPermit(propertyId, permitRecordId);
    if (!belonging.ok) {
      throw new Error(belonging.error || 'Property is not linked to the selected lot/permit');
    }
    if (requireConfirmedLink && belonging.link_state !== 'confirmed') {
      throw new Error(
        `Property link must be confirmed before Find contacts (current: ${belonging.link_state})`
      );
    }
    lotGroupId = permit?.lot_group_id || belonging.link?.lot_group_id || null;
  }

  const result = await runContactLookup({
    property,
    permitRecordId,
    lotGroupId,
    endpointKey,
    forceFail,
  });

  if (result.blocked || result.error || result.inFlight) {
    return {
      ...result,
      saved: [],
      attached: false,
      readinessUnchanged: true,
      provider: tracerfyConfig(),
    };
  }

  const cfg = tracerfyConfig();
  const isDemoMode =
    cfg.mode === PROVIDER_MODES.LOCAL_FIXTURE || cfg.mode === PROVIDER_MODES.HOSTED_SANDBOX;
  const operationalImport =
    permit?.record_origin === 'import' ||
    (lotGroupId &&
      db.prepare(`SELECT record_origin FROM lot_groups WHERE id = ?`).get(lotGroupId)?.record_origin ===
        'import');

  // Fixture/sandbox never attach to operational records. Production may attach to confirmed links.
  // Dedicated sandbox_demo properties may receive fixture/sandbox attaches for UI demos.
  let mayAttach = false;
  let isolation = null;
  if (!result.contacts?.length) {
    mayAttach = false;
  } else if (isDemoMode) {
    if (property.record_origin === 'sandbox_demo' && !operationalImport) {
      mayAttach = true;
    } else if (property.record_origin === 'sandbox_demo' && !permit) {
      mayAttach = true;
    } else if (operationalImport || permit?.record_origin === 'import') {
      mayAttach = false;
      isolation = `${cfg.mode}_results_not_attached_to_operational_workbook_record`;
    } else if (property.record_origin === 'sandbox_demo') {
      mayAttach = true;
    } else {
      mayAttach = false;
      isolation = `${cfg.mode}_results_not_attached_without_sandbox_demo_property`;
    }
  } else if (cfg.mode === PROVIDER_MODES.PRODUCTION) {
    mayAttach = true; // production candidates attach to confirmed operational links
  }

  const rejected = rejectedFingerprints(propertyId);
  const saved = [];
  if (mayAttach && result.contacts?.length) {
    for (const c of result.contacts) {
      if (c._cachedContactId) {
        // Already persisted from prior job — return as-is, do not duplicate
        const existing = db.prepare('SELECT * FROM contacts WHERE id = ?').get(c._cachedContactId);
        if (existing && existing.status !== 'rejected') saved.push(existing);
        continue;
      }
      const fp = contactFingerprint(c);
      if (rejected.has(fp)) {
        // Preserve rejection — do not resurrect
        continue;
      }
      const existingSame = db
        .prepare(
          `SELECT * FROM contacts WHERE property_id = ? AND lower(full_name)=lower(?) AND lower(COALESCE(phone,''))=lower(?) AND lower(COALESCE(email,''))=lower(?) AND status != 'rejected'`
        )
        .get(propertyId, c.full_name || '', c.phone || '', c.email || '');
      if (existingSame) {
        saved.push(existingSame);
        continue;
      }
      const origin =
        cfg.mode === PROVIDER_MODES.LOCAL_FIXTURE
          ? 'local_fixture'
          : cfg.mode === PROVIDER_MODES.HOSTED_SANDBOX
            ? 'sandbox_demo'
            : 'provider';
      const source =
        cfg.mode === PROVIDER_MODES.LOCAL_FIXTURE
          ? 'local_fixture'
          : cfg.mode === PROVIDER_MODES.HOSTED_SANDBOX
            ? 'hosted_sandbox'
            : 'tracerfy_live';
      const row = addManualContact(
        {
          property_id: propertyId,
          permit_record_id: permitRecordId,
          lot_group_id: lotGroupId,
          role: c.role,
          full_name: c.full_name,
          company: c.company,
          phone: c.phone,
          email: c.email,
          mailing_address: c.mailing_address,
          provider: 'tracerfy',
          provider_source: source,
          restriction_flags: c.restriction_flags,
          phone_candidates: c.phone_candidates,
          email_candidates: c.email_candidates,
          record_origin: origin,
          status: 'candidate',
          validation_state: 'provider_returned',
          notes:
            origin !== 'provider'
              ? `${String(cfg.mode).toUpperCase()} DEMO CONTACT — not operational`
              : '',
        },
        { actor: 'provider' }
      );
      db.prepare(
        `UPDATE contacts SET validation_state = 'provider_returned', retrieved_at = datetime('now') WHERE id = ?`
      ).run(row.id);
      saved.push(db.prepare('SELECT * FROM contacts WHERE id = ?').get(row.id));
    }
  }

  return {
    ...result,
    saved,
    attached: saved.length > 0,
    isolation,
    provider: cfg,
    readinessUnchanged: true,
    searchedAddress: {
      site_address: property.site_address,
      city: property.city,
      state: property.state,
      zip: property.zip,
      parcel_apn: property.parcel_apn,
      parcel_jurisdiction: property.parcel_jurisdiction,
    },
  };
}

export function contactsReviewNeededCount() {
  return db
    .prepare(
      `SELECT COUNT(*) AS c FROM contacts
       WHERE status IN ('candidate','needs_review')
         AND record_origin NOT IN ('sandbox_demo','local_fixture')`
    )
    .get().c;
}

export function contactsAvailableLotCount() {
  return db
    .prepare(
      `SELECT COUNT(DISTINCT lot_group_id) AS c FROM contacts
       WHERE status IN ('candidate','confirmed') AND lot_group_id IS NOT NULL
         AND record_origin NOT IN ('sandbox_demo','local_fixture')`
    )
    .get().c;
}

export { reconcileTimedOutJob, tracerfyConfig, PROVIDER_MODES };
