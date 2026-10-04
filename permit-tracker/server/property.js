import { db, recordChange, getSetting } from './db.js';
import { stableLotKey } from './ids.js';

export function getProperty(id) {
  return db.prepare('SELECT * FROM properties WHERE id = ?').get(Number(id));
}

export function listPropertiesForPermit(permitId) {
  return db
    .prepare(
      `SELECT pr.*, pl.link_state, pl.id AS link_id, pl.confirmed_by, pl.confirmed_at, pl.evidence_json
       FROM property_links pl
       JOIN properties pr ON pr.id = pl.property_id
       WHERE pl.permit_record_id = ? OR pl.lot_group_id = (
         SELECT lot_group_id FROM permit_records WHERE id = ?
       )
       ORDER BY pl.id`
    )
    .all(Number(permitId), Number(permitId));
}

export function listPropertiesForLot(lotGroupId) {
  return db
    .prepare(
      `SELECT pr.*, pl.link_state, pl.id AS link_id, pl.confirmed_by, pl.confirmed_at
       FROM property_links pl
       JOIN properties pr ON pr.id = pl.property_id
       WHERE pl.lot_group_id = ?
       ORDER BY pl.id`
    )
    .all(Number(lotGroupId));
}

export function upsertProperty(fields, { actor = 'ui' } = {}) {
  const {
    id,
    site_address = '',
    city = '',
    state = '',
    zip = '',
    parcel_apn = '',
    parcel_jurisdiction = '',
    source = 'manual',
    match_state = 'manual',
    record_origin = 'manual',
    notes = '',
  } = fields || {};
  if (id) {
    const prev = getProperty(id);
    db.prepare(
      `UPDATE properties SET site_address=?, city=?, state=?, zip=?, parcel_apn=?,
       parcel_jurisdiction=?, source=?, match_state=?, notes=?, updated_at=datetime('now')
       WHERE id=?`
    ).run(
      site_address,
      city,
      state,
      zip,
      parcel_apn,
      parcel_jurisdiction,
      source,
      match_state,
      notes,
      id
    );
    db.prepare(
      `INSERT INTO property_confirmations(property_id, action, actor, detail)
       VALUES (?, 'updated', ?, ?)`
    ).run(id, actor, JSON.stringify({ before: prev, after: fields }));
    return getProperty(id);
  }
  const info = db
    .prepare(
      `INSERT INTO properties(site_address, city, state, zip, parcel_apn, parcel_jurisdiction,
         source, match_state, record_origin, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      site_address,
      city,
      state,
      zip,
      parcel_apn,
      parcel_jurisdiction,
      source,
      match_state,
      record_origin,
      notes
    );
  const propertyId = Number(info.lastInsertRowid);
  db.prepare(
    `INSERT INTO property_confirmations(property_id, action, actor, detail)
     VALUES (?, 'created', ?, ?)`
  ).run(propertyId, actor, 'property created');
  return getProperty(propertyId);
}

export function linkPropertyToLot({
  propertyId,
  lotGroupId,
  permitRecordId = null,
  linkState = 'candidate',
  evidence = {},
  confirmedBy = null,
}) {
  const confirmedAt = linkState === 'confirmed' ? new Date().toISOString() : null;
  db.prepare(
    `INSERT INTO property_links(property_id, lot_group_id, permit_record_id, link_state, evidence_json, confirmed_by, confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(property_id, lot_group_id) DO UPDATE SET
       permit_record_id = COALESCE(excluded.permit_record_id, property_links.permit_record_id),
       link_state = excluded.link_state,
       evidence_json = excluded.evidence_json,
       confirmed_by = excluded.confirmed_by,
       confirmed_at = excluded.confirmed_at`
  ).run(
    propertyId,
    lotGroupId,
    permitRecordId,
    linkState,
    JSON.stringify(evidence || {}),
    confirmedBy,
    confirmedAt
  );
  if (linkState === 'confirmed') {
    db.prepare(
      `INSERT INTO property_confirmations(property_id, action, actor, detail)
       VALUES (?, 'confirmed_link', ?, ?)`
    ).run(propertyId, confirmedBy || 'ui', `lot_group ${lotGroupId}`);
    db.prepare(`UPDATE properties SET match_state = 'confirmed', updated_at = datetime('now') WHERE id = ?`).run(
      propertyId
    );
  }
  return listPropertiesForLot(lotGroupId);
}

export function confirmationHistory(propertyId) {
  return db
    .prepare(
      `SELECT * FROM property_confirmations WHERE property_id = ? ORDER BY id DESC LIMIT 50`
    )
    .all(Number(propertyId));
}

/**
 * Preview crosswalk CSV/JSON rows against stable community/lot identities.
 * Never invents one address for an entire lot range without evidence.
 */
export function previewCrosswalk(rows) {
  const results = [];
  for (const [i, row] of (rows || []).entries()) {
    const project_code = String(row.project_code || row.projectCode || '').trim();
    const community_name = String(row.community_name || row.communityName || '').trim();
    const lot_label = String(row.lot_label || row.lotLabel || row.lot || '').trim();
    const housetype = String(row.housetype || row.house_type || '').trim();
    const site_address = String(row.site_address || row.address || '').trim();
    const city = String(row.city || '').trim();
    const state = String(row.state || 'VA').trim();
    const zip = String(row.zip || row.zip_code || '').trim();
    const parcel_apn = String(row.parcel_apn || row.apn || row.parcel || '').trim();
    const parcel_jurisdiction = String(row.parcel_jurisdiction || row.county || '').trim();

    let match_status = 'unmatched';
    let lot_group_id = null;
    let candidates = [];

    if (project_code && lot_label) {
      const key = stableLotKey(project_code, community_name || project_code, lot_label, housetype);
      const byKey = db.prepare(`SELECT * FROM lot_groups WHERE stable_key = ?`).get(key);
      if (byKey) {
        lot_group_id = byKey.id;
        match_status = 'matched_stable_key';
        candidates = [byKey];
      } else {
        candidates = db
          .prepare(
            `SELECT lg.*, cs.project_code, cs.community_name
             FROM lot_groups lg
             JOIN community_sections cs ON cs.id = lg.section_id
             WHERE UPPER(cs.project_code) = UPPER(?)
               AND LOWER(lg.lot_label) = LOWER(?)
             ORDER BY lg.id`
          )
          .all(project_code, lot_label);
        if (candidates.length === 1) {
          lot_group_id = candidates[0].id;
          match_status = 'matched_project_lot';
        } else if (candidates.length > 1) {
          match_status = 'ambiguous';
        }
      }
    }

    // Range labels cannot receive a single owner/address without explicit evidence flag
    const looksRange = /\d+\s*-\s*\d+/.test(lot_label) || /lots?\s+/i.test(lot_label);
    if (looksRange && match_status.startsWith('matched') && !row.allow_range_address) {
      match_status = 'needs_review_range';
    }

    results.push({
      source_row: row.source_row ?? i + 1,
      project_code,
      community_name,
      lot_label,
      housetype,
      site_address,
      city,
      state,
      zip,
      parcel_apn,
      parcel_jurisdiction,
      match_status,
      lot_group_id,
      candidate_count: candidates.length,
      payload: row,
    });
  }
  return results;
}

export function commitCrosswalk(previewRows, { actor = 'ui', onlyStatuses = null } = {}) {
  const allowed = onlyStatuses || [
    'matched_stable_key',
    'matched_project_lot',
    'needs_review_range',
  ];
  let linked = 0;
  let created = 0;
  const tx = db.transaction(() => {
    for (const row of previewRows || []) {
      if (!allowed.includes(row.match_status)) {
        db.prepare(
          `INSERT INTO property_crosswalk_rows(
             project_code, community_name, lot_label, housetype, site_address, city, state, zip,
             parcel_apn, parcel_jurisdiction, match_status, lot_group_id, source_row, payload_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          row.project_code,
          row.community_name,
          row.lot_label,
          row.housetype,
          row.site_address,
          row.city,
          row.state,
          row.zip,
          row.parcel_apn,
          row.parcel_jurisdiction,
          row.match_status,
          row.lot_group_id,
          row.source_row,
          JSON.stringify(row.payload || {})
        );
        continue;
      }
      if (!row.lot_group_id || !row.site_address) continue;
      if (row.match_status === 'needs_review_range' && !row.payload?.allow_range_address) {
        db.prepare(
          `INSERT INTO property_crosswalk_rows(
             project_code, community_name, lot_label, housetype, site_address, city, state, zip,
             parcel_apn, parcel_jurisdiction, match_status, lot_group_id, source_row, payload_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          row.project_code,
          row.community_name,
          row.lot_label,
          row.housetype,
          row.site_address,
          row.city,
          row.state,
          row.zip,
          row.parcel_apn,
          row.parcel_jurisdiction,
          row.match_status,
          row.lot_group_id,
          row.source_row,
          JSON.stringify(row.payload || {})
        );
        continue;
      }
      const property = upsertProperty(
        {
          site_address: row.site_address,
          city: row.city,
          state: row.state,
          zip: row.zip,
          parcel_apn: row.parcel_apn,
          parcel_jurisdiction: row.parcel_jurisdiction,
          source: 'crosswalk_import',
          match_state: 'candidate',
          record_origin: 'crosswalk',
        },
        { actor }
      );
      created += 1;
      const permit = db
        .prepare(
          `SELECT id FROM permit_records WHERE lot_group_id = ? AND record_origin = 'import' ORDER BY id LIMIT 1`
        )
        .get(row.lot_group_id);
      linkPropertyToLot({
        propertyId: property.id,
        lotGroupId: row.lot_group_id,
        permitRecordId: permit?.id || null,
        linkState: 'candidate',
        evidence: {
          match_status: row.match_status,
          source_row: row.source_row,
          project_code: row.project_code,
          lot_label: row.lot_label,
        },
        confirmedBy: null,
      });
      linked += 1;
      db.prepare(
        `INSERT INTO property_crosswalk_rows(
           project_code, community_name, lot_label, housetype, site_address, city, state, zip,
           parcel_apn, parcel_jurisdiction, match_status, lot_group_id, property_id, source_row, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        row.project_code,
        row.community_name,
        row.lot_label,
        row.housetype,
        row.site_address,
        row.city,
        row.state,
        row.zip,
        row.parcel_apn,
        row.parcel_jurisdiction,
        'linked_candidate',
        row.lot_group_id,
        property.id,
        row.source_row,
        JSON.stringify(row.payload || {})
      );
    }
  });
  tx();
  return { created, linked };
}

export function missingPropertyLotCount() {
  return db
    .prepare(
      `SELECT COUNT(*) AS c FROM lot_groups lg
       WHERE lg.record_origin = 'import'
         AND NOT EXISTS (
           SELECT 1 FROM property_links pl
           WHERE pl.lot_group_id = lg.id AND pl.link_state IN ('candidate','confirmed')
         )`
    )
    .get().c;
}
