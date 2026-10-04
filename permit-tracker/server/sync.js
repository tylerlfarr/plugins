import { db, getSetting, recordChange, upsertAttention } from './db.js';
import { checkPermit } from './connectors/index.js';

const OFFICIAL_DATE_FIELDS = [
  ['submittedDate', 'submitted_date'],
  ['approvedDate', 'approved_date'],
  ['issuedDate', 'issued_date'],
  ['expirationDate', 'expiration_date'],
];

/**
 * Apply a connector result without touching internal notes/milestones/owner/next_action.
 * Predicted dates are never written from connectors.
 */
export function applyConnectorResult(permit, result, changedBy = 'connector') {
  const now = result.checkedAt || new Date().toISOString();

  if (result.ambiguous) {
    db.prepare(
      `INSERT INTO match_reviews(jurisdiction_code, candidate_official_id, reason, payload_json)
       VALUES (?, ?, ?, ?)`
    ).run(
      permit.jurisdiction_code,
      permit.official_id,
      'Ambiguous official ID match',
      JSON.stringify(result.candidates || [])
    );
    db.prepare(
      `UPDATE permits SET last_checked_at = ?, last_check_outcome = 'failed',
       last_check_error = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(now, result.error || 'ambiguous match', permit.id);
    return { outcome: 'failed', reason: 'ambiguous', mode: result.mode };
  }

  if (result.outcome === 'not_found' || result.outcome === 'unavailable' || result.outcome === 'failed') {
    db.prepare(
      `UPDATE permits SET last_checked_at = ?, last_check_outcome = ?, last_check_error = ?,
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
  for (const [src, col] of OFFICIAL_DATE_FIELDS) {
    const incoming = fields[src];
    if (incoming == null || incoming === '') continue;
    if (String(permit[col] || '') !== String(incoming)) {
      recordChange(permit.id, col, permit[col], incoming, changedBy, 'connector');
      sets.push(`${col} = ?`);
      params.push(incoming);
      changed = true;
    }
  }

  if (fields.sourceUrl && String(permit.source_url || '') !== String(fields.sourceUrl)) {
    recordChange(permit.id, 'source_url', permit.source_url, fields.sourceUrl, changedBy, 'connector');
    sets.push('source_url = ?');
    params.push(fields.sourceUrl);
    changed = true;
  }

  if (fields.permitType && String(permit.permit_type || '') !== String(fields.permitType)) {
    recordChange(permit.id, 'permit_type', permit.permit_type, fields.permitType, changedBy, 'connector');
    sets.push('permit_type = ?');
    params.push(fields.permitType);
    changed = true;
  }

  const outcome = changed ? 'updated' : 'no_change';
  sets.push('last_check_outcome = ?');
  params.push(outcome);
  params.push(permit.id);
  db.prepare(`UPDATE permits SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return { outcome, mode: result.mode };
}

export async function syncPermitById(id, { forceFail = false } = {}) {
  const permit = db.prepare('SELECT * FROM permits WHERE id = ?').get(id);
  if (!permit) throw new Error('Permit not found');
  if (!permit.official_id) {
    db.prepare(
      `UPDATE permits SET last_checked_at = datetime('now'), last_check_outcome = 'failed',
       last_check_error = 'No official ID', updated_at = datetime('now') WHERE id = ?`
    ).run(id);
    return { outcome: 'failed', error: 'No official ID' };
  }
  const result = await checkPermit({
    jurisdictionCode: permit.jurisdiction_code,
    officialId: permit.official_id,
    forceFail,
  });
  return applyConnectorResult(permit, result, getSetting('current_user', 'demo.user'));
}

export async function syncAllLinked() {
  const rows = db
    .prepare(
      `SELECT id FROM permits WHERE official_id IS NOT NULL AND official_id != '' ORDER BY id`
    )
    .all();
  const results = [];
  for (const row of rows) {
    // sequential to be gentle on public APIs
    // eslint-disable-next-line no-await-in-loop
    results.push({ id: row.id, ...(await syncPermitById(row.id)) });
  }
  return results;
}

export function rebuildAttention() {
  const staleDays = Number(getSetting('stale_days', '14'));
  const today = new Date();
  const isoToday = today.toISOString().slice(0, 10);

  const permits = db
    .prepare(
      `SELECT p.*, l.lot_number, pr.name AS project_name, c.name AS community_name
       FROM permits p
       JOIN lots l ON l.id = p.lot_id
       JOIN projects pr ON pr.id = l.project_id
       JOIN communities c ON c.id = pr.community_id`
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
    if (p.expiration_date) {
      const exp = new Date(p.expiration_date);
      const days = (exp - today) / (86400 * 1000);
      if (days >= 0 && days <= 30) {
        upsertAttention(
          p.id,
          'upcoming_expiration',
          `Expires ${p.expiration_date}`,
          `exp:${p.id}:${p.expiration_date}`
        );
      }
    }
    const anchor = p.official_last_changed_at || p.updated_at || p.created_at;
    if (anchor) {
      const ageDays = (today - new Date(anchor)) / (86400 * 1000);
      if (ageDays >= staleDays && !['closed', 'cancelled', 'issued'].includes(p.official_status)) {
        upsertAttention(
          p.id,
          'no_movement',
          `No official movement for ~${Math.floor(ageDays)} days (threshold ${staleDays})`,
          `stale:${p.id}:${staleDays}`
        );
      }
    }
  }
}
