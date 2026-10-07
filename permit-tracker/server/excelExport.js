import XLSX from 'xlsx';
import { db } from './db.js';

/**
 * Structured coexistence export (not a proven round-trip).
 * Import-origin records only — fixtures/demo probes excluded.
 *
 * Contact package defaults to confirmed only. Pass includeReviewedCandidates
 * to also include reviewed candidates. Never includes rejected/outdated/sandbox/fixture.
 * Provider export eligibility is separate from having an API token.
 */
export function exportCoexistenceXlsx({
  contactStatuses = ['confirmed'],
  includeReviewedCandidates = false,
  filters = {},
} = {}) {
  const statuses = includeReviewedCandidates
    ? [...new Set([...contactStatuses, 'candidate'])]
    : contactStatuses;

  // Optional permit filters (same knobs as Permits view: use, jurisdiction, status, date-ish).
  let where = `p.record_origin = 'import'`;
  const params = [];
  if (filters.use_classification) {
    where += ' AND p.use_classification = ?';
    params.push(String(filters.use_classification));
  }
  if (filters.jurisdiction_code) {
    where += ' AND p.jurisdiction_code = ?';
    params.push(String(filters.jurisdiction_code));
  }
  if (filters.internal_status) {
    where += ' AND p.internal_status = ?';
    params.push(String(filters.internal_status));
  }
  if (filters.official_status) {
    where += ' AND p.official_status = ?';
    params.push(String(filters.official_status));
  }
  if (filters.readiness_state) {
    where += ' AND p.readiness_state = ?';
    params.push(String(filters.readiness_state));
  }
  if (filters.approaching_start === 'true' || filters.approaching_start === true) {
    where += ` AND ra.target_start IS NOT NULL AND ra.days_to_start IS NOT NULL
               AND ra.days_to_start >= 0 AND ra.days_to_start <= 45`;
  }

  const permitRows = db
    .prepare(
      `SELECT
         cs.project_code,
         cs.community_name,
         cs.jurisdiction_code AS section_jurisdiction,
         lg.lot_label,
         lg.housetype,
         lg.notes_raw,
         p.id AS permit_record_id,
         p.primary_official_id,
         p.jurisdiction_code,
         p.jurisdiction_source,
         p.jurisdiction_confirmed,
         p.readiness_state,
         ra.target_start,
         ra.days_to_start,
         ra.summary AS readiness_summary,
         ra.outstanding_json,
         ra.gaps_json,
         p.source_native_status,
         p.official_status,
         p.internal_status,
         p.permit_kind,
         p.use_classification,
         p.use_classification_official,
         p.use_classification_official_label,
         p.use_classification_source,
         p.use_classification_manual,
         p.owner,
         p.next_action,
         p.next_action_due,
         p.source_url,
         p.last_check_outcome,
         p.last_successful_check_at,
         p.progress_anchor_at,
         p.last_check_error,
         p.official_last_changed_at
       FROM permit_records p
       JOIN lot_groups lg ON lg.id = p.lot_group_id
       JOIN community_sections cs ON cs.id = lg.section_id
       LEFT JOIN readiness_assessments ra ON ra.permit_record_id = p.id
       WHERE ${where}
       ORDER BY cs.community_name, lg.lot_label, p.id`
    )
    .all(...params);

  const milestoneStmt = db.prepare(
    `SELECT key, label, value, value_kind FROM internal_milestones WHERE permit_record_id = ? ORDER BY key`
  );
  const idsStmt = db.prepare(
    `SELECT official_id, is_primary, jurisdiction_guess FROM official_ids WHERE permit_record_id = ? ORDER BY is_primary DESC, id`
  );

  const flat = permitRows.map((r) => {
    const milestones = milestoneStmt.all(r.permit_record_id);
    const ids = idsStmt.all(r.permit_record_id);
    const mileObj = {};
    for (const m of milestones) {
      mileObj[m.label || m.key] = m.value;
    }
    return {
      project_code: r.project_code,
      community_name: r.community_name,
      lot_label: r.lot_label,
      housetype: r.housetype,
      jurisdiction_code: r.jurisdiction_code,
      jurisdiction_source: r.jurisdiction_source,
      jurisdiction_confirmed: r.jurisdiction_confirmed,
      primary_official_id: r.primary_official_id,
      all_official_ids: ids.map((i) => i.official_id).join(' / '),
      readiness_state: r.readiness_state,
      target_start: r.target_start,
      days_to_start: r.days_to_start,
      readiness_summary: r.readiness_summary,
      outstanding_prereqs: (() => {
        try {
          return (JSON.parse(r.outstanding_json || '[]') || []).map((o) => o.label).join('; ');
        } catch {
          return '';
        }
      })(),
      verification_gaps: (() => {
        try {
          return (JSON.parse(r.gaps_json || '[]') || []).map((g) => g.label).join('; ');
        } catch {
          return '';
        }
      })(),
      source_native_status: r.source_native_status,
      official_status: r.official_status,
      internal_status: r.internal_status,
      work_type_permit_kind: r.permit_kind,
      use_classification: r.use_classification,
      use_classification_official: r.use_classification_official,
      use_classification_official_label: r.use_classification_official_label,
      use_classification_source: r.use_classification_source,
      use_classification_manual: r.use_classification_manual,
      owner: r.owner,
      next_action: r.next_action,
      next_action_due: r.next_action_due,
      notes_raw: r.notes_raw,
      source_url: r.source_url,
      last_check_outcome: r.last_check_outcome,
      last_successful_check_at: r.last_successful_check_at,
      progress_anchor_at: r.progress_anchor_at,
      last_check_error: r.last_check_error,
      ...mileObj,
    };
  });

  const attention = db
    .prepare(
      `SELECT a.kind, a.message, a.created_at, a.acknowledged, a.resolved_at,
              cs.community_name, lg.lot_label, p.primary_official_id, p.official_status
       FROM attention_events a
       LEFT JOIN permit_records p ON p.id = a.permit_record_id
       LEFT JOIN lot_groups lg ON lg.id = p.lot_group_id
       LEFT JOIN community_sections cs ON cs.id = lg.section_id
       WHERE a.acknowledged = 0 AND a.resolved_at IS NULL
         AND (p.id IS NULL OR p.record_origin = 'import')
       ORDER BY a.created_at DESC`
    )
    .all();

  const revisions = db.prepare('SELECT * FROM permit_revisions ORDER BY id').all();
  const masterfile = db.prepare('SELECT * FROM plan_tracker_rows ORDER BY id').all();
  const mst = db.prepare('SELECT * FROM mst_reference_ids ORDER BY id').all();

  const statusPlaceholders = statuses.map(() => '?').join(',');
  const contacts = db
    .prepare(
      `SELECT c.role, c.full_name, c.company, c.phone, c.email, c.mailing_address,
              c.provider, c.provider_source, c.retrieved_at, c.validation_state, c.status,
              c.restriction_flags_json, c.record_origin,
              pr.site_address, pr.city, pr.state, pr.zip, pr.parcel_apn,
              cs.project_code, cs.community_name, lg.lot_label
       FROM contacts c
       LEFT JOIN properties pr ON pr.id = c.property_id
       LEFT JOIN lot_groups lg ON lg.id = c.lot_group_id
       LEFT JOIN community_sections cs ON cs.id = lg.section_id
       WHERE c.record_origin NOT IN ('sandbox_demo','local_fixture')
         AND c.status IN (${statusPlaceholders})
         AND c.status NOT IN ('rejected','outdated')
         AND (c.provider_source IS NULL OR c.provider_source NOT IN ('hosted_sandbox','local_fixture','sandbox_fabricated'))
       ORDER BY c.id`
    )
    .all(...statuses);

  const properties = db
    .prepare(
      `SELECT pr.*, cs.project_code, cs.community_name, lg.lot_label, pl.link_state
       FROM properties pr
       LEFT JOIN property_links pl ON pl.property_id = pr.id
       LEFT JOIN lot_groups lg ON lg.id = pl.lot_group_id
       LEFT JOIN community_sections cs ON cs.id = lg.section_id
       WHERE pr.record_origin NOT IN ('sandbox_demo','local_fixture')
       ORDER BY pr.id`
    )
    .all();

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(flat), 'Permit Tracker Export');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(attention), 'Attention');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(revisions), 'Permit Revisions');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(masterfile), 'Masterfile Plan Tracker');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(mst), 'MST Reference IDs');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(properties), 'Properties');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(contacts), 'Contacts');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** Parse export buffer and return sheet row counts + contact statuses for verification. */
export function inspectExportBuffer(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const contacts = XLSX.utils.sheet_to_json(wb.Sheets.Contacts || {});
  const permitRows = XLSX.utils.sheet_to_json(wb.Sheets['Permit Tracker Export'] || {});
  const permits = permitRows.map((r) => ({
    id: Number(r.permit_record_id),
    use_classification: r.use_classification,
  }));
  return {
    sheetNames: wb.SheetNames,
    contactCount: contacts.length,
    contactStatuses: [...new Set(contacts.map((c) => c.status))],
    contactOrigins: [...new Set(contacts.map((c) => c.record_origin))],
    contacts,
    permits,
    propertyCount: XLSX.utils.sheet_to_json(wb.Sheets.Properties || {}).length,
  };
}
