import { db, getSetting, recordChange, upsertAttention } from './db.js';
import { checkPermit } from './connectors/index.js';

const OFFICIAL_DATE_FIELDS = [
  ['submittedDate', 'submitted_date'],
  ['approvedDate', 'approved_date'],
  ['issuedDate', 'issued_date'],
];

/**
 * Apply connector result. Never touches internal_milestones, notes_raw, owner, next_action.
 */
export function applyConnectorResult(permit, result, changedBy = 'connector') {
  const now = result.checkedAt || new Date().toISOString();

  db.prepare(
    `INSERT INTO official_snapshots(permit_record_id, official_id, payload_json, mode, outcome, checked_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    permit.id,
    permit.primary_official_id,
    JSON.stringify(result),
    result.mode || 'unknown',
    result.outcome || 'failed',
    now
  );

  if (result.ambiguous) {
    db.prepare(
      `INSERT INTO match_reviews(jurisdiction_code, candidate_official_id, reason, payload_json)
       VALUES (?, ?, ?, ?)`
    ).run(
      permit.jurisdiction_code,
      permit.primary_official_id,
      'Ambiguous official ID match',
      JSON.stringify(result.candidates || [])
    );
    db.prepare(
      `UPDATE permit_records SET last_checked_at = ?, last_check_outcome = 'failed',
       last_check_error = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(now, result.error || 'ambiguous', permit.id);
    return { outcome: 'failed', reason: 'ambiguous', mode: result.mode };
  }

  if (['not_found', 'unavailable', 'failed'].includes(result.outcome)) {
    db.prepare(
      `UPDATE permit_records SET last_checked_at = ?, last_check_outcome = ?, last_check_error = ?,
       updated_at = datetime('now') WHERE id = ?`
    ).run(now, result.outcome, result.error || '', permit.id);
    if (result.outcome !== 'not_found') {
      upsertAttention(
        permit.id,
        'source_error',
        `Source check ${result.outcome}: ${result.error || result.outcome}`,
        `source:${permit.id}:${result.outcome}:${(result.error || '').slice(0, 40)}`
      );
    }
    return { outcome: result.outcome, mode: result.mode };
  }

  let changed = false;
  const sets = [
    'last_checked_at = ?',
    'last_successful_check_at = ?',
    "last_check_error = ''",
    "updated_at = datetime('now')",
  ];
  const params = [now, now];

  const native = result.sourceNativeStatus ?? '';
  if (String(permit.source_native_status || '') !== String(native)) {
    recordChange(permit.id, 'source_native_status', permit.source_native_status, native, changedBy, 'connector');
    sets.push('source_native_status = ?');
    params.push(native);
    changed = true;
  }

  if (result.officialStatus && String(permit.official_status || '') !== String(result.officialStatus)) {
    recordChange(permit.id, 'official_status', permit.official_status, result.officialStatus, changedBy, 'connector');
    sets.push('official_status = ?');
    params.push(result.officialStatus);
    sets.push('official_last_changed_at = ?');
    params.push(now);
    changed = true;
    upsertAttention(
      permit.id,
      'status_change',
      `Official status: ${permit.official_status || '—'} → ${result.officialStatus}`,
      `status:${permit.id}:${permit.official_status}->${result.officialStatus}`
    );
  }

  const fields = result.fields || {};
  // Store official dates as milestones with official_ prefix? Keep on permit via source_url only;
  // dates go to field_changes + optional internal? Spec: official snapshot separate.
  // Persist issued/approved/submitted onto dedicated columns via milestones labeled official_*? 
  // Simplest: update source_url and record date field changes as official_* fields in field_changes only,
  // and also store as milestones with key official_issued_date etc. WITHOUT overwriting internal_* keys.
  for (const [src, col] of OFFICIAL_DATE_FIELDS) {
    const incoming = fields[src];
    if (incoming == null || incoming === '') continue;
    const key = `official_${col}`;
    const existing = db
      .prepare(`SELECT value FROM internal_milestones WHERE permit_record_id = ? AND key = ?`)
      .get(permit.id, key);
    // Use a separate table-like namespace: official_* milestones are connector-owned
    if (!existing) {
      db.prepare(
        `INSERT INTO internal_milestones(permit_record_id, key, label, value, value_kind)
         VALUES (?, ?, ?, ?, 'date')`
      ).run(permit.id, key, `Official ${col}`, incoming);
      recordChange(permit.id, key, '', incoming, changedBy, 'connector');
      changed = true;
    } else if (String(existing.value) !== String(incoming)) {
      recordChange(permit.id, key, existing.value, incoming, changedBy, 'connector');
      db.prepare(
        `UPDATE internal_milestones SET value = ? WHERE permit_record_id = ? AND key = ?`
      ).run(incoming, permit.id, key);
      changed = true;
    }
  }

  if (fields.sourceUrl && String(permit.source_url || '') !== String(fields.sourceUrl)) {
    recordChange(permit.id, 'source_url', permit.source_url, fields.sourceUrl, changedBy, 'connector');
    sets.push('source_url = ?');
    params.push(fields.sourceUrl);
    changed = true;
  }

  const outcome = changed ? 'updated' : 'no_change';
  sets.push('last_check_outcome = ?');
  params.push(outcome);
  params.push(permit.id);
  db.prepare(`UPDATE permit_records SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return { outcome, mode: result.mode, fieldAvailability: result.fieldAvailability };
}

export async function syncPermitById(id, { forceFail = false, officialId } = {}) {
  const permit = db.prepare('SELECT * FROM permit_records WHERE id = ?').get(id);
  if (!permit) throw new Error('Permit not found');
  const oid = officialId || permit.primary_official_id;
  if (!oid) {
    db.prepare(
      `UPDATE permit_records SET last_checked_at = datetime('now'), last_check_outcome = 'failed',
       last_check_error = 'No official ID', updated_at = datetime('now') WHERE id = ?`
    ).run(id);
    return { outcome: 'failed', error: 'No official ID' };
  }
  const result = await checkPermit({
    jurisdictionCode: permit.jurisdiction_code,
    officialId: oid,
    forceFail,
  });
  return applyConnectorResult(permit, result, getSetting('current_user', 'demo.user'));
}

export async function syncAllLinked({ fairfaxOnly = false } = {}) {
  let rows;
  if (fairfaxOnly) {
    rows = db
      .prepare(
        `SELECT DISTINCT p.id, oi.official_id
         FROM permit_records p
         JOIN official_ids oi ON oi.permit_record_id = p.id
         WHERE oi.official_id GLOB '[A-Z][A-Z][A-Z][A-Z]-*'
            OR p.jurisdiction_code = 'fairfax_county'
         ORDER BY p.id`
      )
      .all();
    // Also include Fairfax-shaped from mst_reference_ids not yet on permits — sync attached IDs only for now
  } else {
    rows = db
      .prepare(
        `SELECT id, primary_official_id AS official_id FROM permit_records
         WHERE primary_official_id IS NOT NULL AND primary_official_id != ''
         ORDER BY id`
      )
      .all();
  }

  const results = [];
  const seen = new Set();
  for (const row of rows) {
    const key = `${row.id}:${row.official_id || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // eslint-disable-next-line no-await-in-loop
    results.push({
      id: row.id,
      official_id: row.official_id,
      ...(await syncPermitById(row.id, { officialId: row.official_id })),
    });
  }
  return results;
}

export function rebuildAttention() {
  const staleDays = Number(getSetting('stale_days', '14'));
  const today = new Date();
  const isoToday = today.toISOString().slice(0, 10);

  const permits = db
    .prepare(
      `SELECT p.*, lg.lot_label, cs.community_name, cs.project_code
       FROM permit_records p
       JOIN lot_groups lg ON lg.id = p.lot_group_id
       JOIN community_sections cs ON cs.id = lg.section_id`
    )
    .all();

  for (const p of permits) {
    if (p.next_action_due && p.next_action_due < isoToday && p.internal_status !== 'done') {
      upsertAttention(
        p.id,
        'overdue_action',
        `Overdue: ${p.next_action || 'action'} (due ${p.next_action_due})`,
        `overdue:${p.id}:${p.next_action_due}`
      );
    }
    if (['failed', 'unavailable'].includes(p.last_check_outcome)) {
      upsertAttention(
        p.id,
        'source_error',
        `Last check ${p.last_check_outcome}: ${p.last_check_error || ''}`,
        `lasterr:${p.id}:${p.last_check_outcome}`
      );
    }
    const anchor = p.official_last_changed_at || p.last_successful_check_at || p.updated_at;
    if (anchor && p.primary_official_id) {
      const ageDays = (today - new Date(anchor)) / (86400 * 1000);
      if (ageDays >= staleDays && !['closed', 'cancelled', 'issued'].includes(p.official_status)) {
        upsertAttention(
          p.id,
          'stalled',
          `Synced permit stalled ~${Math.floor(ageDays)} days (threshold ${staleDays})`,
          `stale:${p.id}:${staleDays}`
        );
      }
    }
  }
}
