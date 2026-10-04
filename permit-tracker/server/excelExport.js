import XLSX from 'xlsx';
import { db } from './db.js';

/**
 * Coexistence export: reconciliable columns for morning meeting + workbook merge.
 */
export function exportCoexistenceXlsx() {
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
         p.source_native_status,
         p.official_status,
         p.internal_status,
         p.owner,
         p.next_action,
         p.next_action_due,
         p.source_url,
         p.last_check_outcome,
         p.last_successful_check_at,
         p.last_check_error,
         p.official_last_changed_at
       FROM permit_records p
       JOIN lot_groups lg ON lg.id = p.lot_group_id
       JOIN community_sections cs ON cs.id = lg.section_id
       ORDER BY cs.community_name, lg.lot_label, p.id`
    )
    .all();

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
      // keep official_* and workbook milestone labels
      mileObj[m.label || m.key] = m.value;
    }
    return {
      project_code: r.project_code,
      community_name: r.community_name,
      lot_label: r.lot_label,
      housetype: r.housetype,
      jurisdiction_code: r.jurisdiction_code,
      primary_official_id: r.primary_official_id,
      all_official_ids: ids.map((i) => i.official_id).join(' / '),
      source_native_status: r.source_native_status,
      official_status: r.official_status,
      internal_status: r.internal_status,
      owner: r.owner,
      next_action: r.next_action,
      next_action_due: r.next_action_due,
      notes_raw: r.notes_raw,
      source_url: r.source_url,
      last_check_outcome: r.last_check_outcome,
      last_successful_check_at: r.last_successful_check_at,
      last_check_error: r.last_check_error,
      ...mileObj,
    };
  });

  const attention = db
    .prepare(
      `SELECT a.kind, a.message, a.created_at, a.acknowledged,
              cs.community_name, lg.lot_label, p.primary_official_id, p.official_status
       FROM attention_events a
       LEFT JOIN permit_records p ON p.id = a.permit_record_id
       LEFT JOIN lot_groups lg ON lg.id = p.lot_group_id
       LEFT JOIN community_sections cs ON cs.id = lg.section_id
       WHERE a.acknowledged = 0
       ORDER BY a.created_at DESC`
    )
    .all();

  const revisions = db.prepare('SELECT * FROM permit_revisions ORDER BY id').all();
  const masterfile = db.prepare('SELECT * FROM plan_tracker_rows ORDER BY id').all();
  const mst = db.prepare('SELECT * FROM mst_reference_ids ORDER BY id').all();

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(flat), 'Permit Tracker Export');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(attention), 'Attention');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(revisions), 'Permit Revisions');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(masterfile), 'Masterfile Plan Tracker');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(mst), 'MST Reference IDs');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
