import { db } from './db.js';
import { runContactLookup, tracerfyConfig, reconcileTimedOutJob } from './providers/tracerfy.js';
import { getProperty } from './property.js';

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

export const CONTACT_STATUSES = ['candidate', 'confirmed', 'rejected', 'outdated'];

export function listContacts({ permitId, propertyId, lotGroupId, includeDemo = false } = {}) {
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
    sql += ` AND record_origin != 'sandbox_demo'`;
  }
  sql += ` ORDER BY CASE status WHEN 'confirmed' THEN 0 WHEN 'candidate' THEN 1 WHEN 'outdated' THEN 2 ELSE 3 END, id`;
  return db.prepare(sql).all(...params);
}

export function addManualContact(fields, { actor = 'ui' } = {}) {
  const role = CONTACT_ROLES.includes(fields.role) ? fields.role : 'unknown_party';
  const info = db
    .prepare(
      `INSERT INTO contacts(
         property_id, permit_record_id, lot_group_id, role, full_name, company, phone, email,
         mailing_address, provider, provider_source, retrieved_at, validation_state, status,
         restriction_flags_json, record_origin, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?)`
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
      'user_confirmed',
      fields.status || 'confirmed',
      JSON.stringify(fields.restriction_flags || []),
      fields.record_origin || 'manual',
      fields.notes || `added by ${actor}`
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

/**
 * Find contacts for a property. Sandbox results attach only when property/permit is demo/sandbox
 * OR when explicitly allowSandboxAttach is set for dedicated test properties.
 * Never mutates permit readiness/status.
 */
export async function findContactsForProperty({
  propertyId,
  permitRecordId = null,
  endpointKey = 'instant_trace',
  forceFail = null,
  allowSandboxAttach = false,
} = {}) {
  const property = getProperty(propertyId);
  if (!property) throw new Error('Property not found');

  const permit = permitRecordId
    ? db.prepare('SELECT * FROM permit_records WHERE id = ?').get(Number(permitRecordId))
    : null;
  const lotGroupId =
    permit?.lot_group_id ||
    db
      .prepare(`SELECT lot_group_id FROM property_links WHERE property_id = ? ORDER BY id DESC LIMIT 1`)
      .get(propertyId)?.lot_group_id ||
    null;

  const result = await runContactLookup({
    property,
    permitRecordId,
    lotGroupId,
    endpointKey,
    forceFail,
  });

  const cfg = tracerfyConfig();
  const operationalImport =
    permit?.record_origin === 'import' && property.record_origin !== 'sandbox_demo';
  const attachAsDemo = cfg.mode === 'sandbox' || property.record_origin === 'sandbox_demo';

  // Isolation: never attach sandbox contacts to operational workbook records unless explicitly allowed for a sandbox property
  const mayAttach =
    result.contacts?.length &&
    (!operationalImport || allowSandboxAttach) &&
    (attachAsDemo ? property.record_origin === 'sandbox_demo' || allowSandboxAttach || !permit : true) &&
    !(cfg.mode === 'sandbox' && operationalImport && !allowSandboxAttach);

  const saved = [];
  if (mayAttach && result.contacts?.length) {
    for (const c of result.contacts) {
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
          provider_source: cfg.mode === 'sandbox' ? 'sandbox_fabricated' : 'tracerfy_live',
          restriction_flags: c.restriction_flags,
          record_origin: cfg.mode === 'sandbox' ? 'sandbox_demo' : 'provider',
          status: 'candidate',
          notes: cfg.mode === 'sandbox' ? 'SANDBOX DEMO CONTACT — not operational' : '',
        },
        { actor: 'provider' }
      );
      // Force validation_state for provider returns
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
    isolation:
      cfg.mode === 'sandbox' && operationalImport && !allowSandboxAttach
        ? 'sandbox_results_not_attached_to_operational_workbook_record'
        : null,
    provider: cfg,
    readinessUnchanged: true,
  };
}

export function contactsReviewNeededCount() {
  return db
    .prepare(
      `SELECT COUNT(*) AS c FROM contacts
       WHERE status = 'candidate' AND record_origin != 'sandbox_demo'`
    )
    .get().c;
}

export function contactsAvailableLotCount() {
  return db
    .prepare(
      `SELECT COUNT(DISTINCT lot_group_id) AS c FROM contacts
       WHERE status IN ('candidate','confirmed') AND lot_group_id IS NOT NULL
         AND record_origin != 'sandbox_demo'`
    )
    .get().c;
}

export { reconcileTimedOutJob, tracerfyConfig };
