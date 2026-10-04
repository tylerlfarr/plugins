import crypto from 'node:crypto';
import { db, recordChange } from './db.js';
import { stableLotKey } from './ids.js';

export function propertyIdentityKey(fields) {
  const parts = [
    String(fields.site_address || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' '),
    String(fields.city || '')
      .trim()
      .toLowerCase(),
    String(fields.state || '')
      .trim()
      .toUpperCase(),
    String(fields.zip || '')
      .trim()
      .slice(0, 5),
    String(fields.parcel_apn || '')
      .trim()
      .toLowerCase(),
    String(fields.parcel_jurisdiction || '')
      .trim()
      .toLowerCase(),
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

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
       ORDER BY CASE pl.link_state WHEN 'confirmed' THEN 0 WHEN 'needs_reconfirmation' THEN 1 WHEN 'candidate' THEN 2 ELSE 3 END, pl.id`
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

export function propertyBelongsToPermit(propertyId, permitRecordId) {
  const permit = db.prepare('SELECT * FROM permit_records WHERE id = ?').get(Number(permitRecordId));
  if (!permit) return { ok: false, error: 'Permit not found' };
  const link = db
    .prepare(
      `SELECT * FROM property_links
       WHERE property_id = ?
         AND (permit_record_id = ? OR lot_group_id = ?)
       ORDER BY id DESC LIMIT 1`
    )
    .get(Number(propertyId), Number(permitRecordId), permit.lot_group_id);
  if (!link) {
    return { ok: false, error: 'Property is not linked to the selected lot/permit' };
  }
  return { ok: true, link, link_state: link.link_state, permit };
}

function materialIdentityChanged(prev, next) {
  if (!prev) return false;
  const keys = ['site_address', 'city', 'state', 'zip', 'parcel_apn', 'parcel_jurisdiction'];
  return keys.some(
    (k) =>
      String(prev[k] || '')
        .trim()
        .toLowerCase() !==
      String(next[k] || '')
        .trim()
        .toLowerCase()
  );
}

function markContactsNeedingReview(propertyId, reason) {
  db.prepare(
    `UPDATE contacts SET status = CASE WHEN status = 'rejected' THEN 'rejected' ELSE 'needs_review' END,
       notes = TRIM(notes || ?), updated_at = datetime('now')
     WHERE property_id = ? AND status IN ('candidate','confirmed','outdated','needs_review')`
  ).run(` | identity_change:${reason}`, propertyId);
}

export function upsertProperty(fields, { actor = 'ui' } = {}) {
  const {
    id,
    site_address = '',
    city = '',
    state = '', // never invent VA
    zip = '',
    parcel_apn = '',
    parcel_jurisdiction = '',
    source = 'manual',
    match_state = 'manual',
    record_origin = 'manual',
    notes = '',
  } = fields || {};

  const normalized = {
    site_address: String(site_address || '').trim(),
    city: String(city || '').trim(),
    state: String(state || '').trim().toUpperCase(),
    zip: String(zip || '').trim(),
    parcel_apn: String(parcel_apn || '').trim(),
    parcel_jurisdiction: String(parcel_jurisdiction || '').trim(),
  };
  if (!normalized.site_address && !normalized.parcel_apn) {
    throw new Error('site_address or parcel_apn required');
  }
  // Address OR jurisdiction-qualified parcel; never invent state for parcel-only when missing
  const identity_key = propertyIdentityKey(normalized);

  if (id) {
    const prev = getProperty(id);
    if (!prev) throw new Error('Property not found');
    const changed = materialIdentityChanged(prev, normalized);
    db.prepare(
      `UPDATE properties SET site_address=?, city=?, state=?, zip=?, parcel_apn=?,
       parcel_jurisdiction=?, source=?, match_state=?, notes=?, identity_key=?, updated_at=datetime('now')
       WHERE id=?`
    ).run(
      normalized.site_address,
      normalized.city,
      normalized.state,
      normalized.zip,
      normalized.parcel_apn,
      normalized.parcel_jurisdiction,
      source || prev.source,
      match_state || prev.match_state,
      notes,
      identity_key,
      id
    );
    if (changed) {
      // Require reconfirmation; preserve prior contacts as needing review (do not silently move)
      db.prepare(
        `UPDATE property_links SET link_state = 'needs_reconfirmation', confirmed_by = NULL, confirmed_at = NULL
         WHERE property_id = ? AND link_state = 'confirmed'`
      ).run(id);
      markContactsNeedingReview(id, 'material_identity_change');
      db.prepare(
        `INSERT INTO property_confirmations(property_id, action, actor, detail)
         VALUES (?, 'identity_changed_needs_reconfirmation', ?, ?)`
      ).run(id, actor, JSON.stringify({ before: prev, after: normalized }));
    } else {
      db.prepare(
        `INSERT INTO property_confirmations(property_id, action, actor, detail)
         VALUES (?, 'updated', ?, ?)`
      ).run(id, actor, JSON.stringify({ before: prev, after: normalized }));
    }
    return getProperty(id);
  }

  // Idempotent create by identity_key
  const existing = db.prepare(`SELECT * FROM properties WHERE identity_key = ?`).get(identity_key);
  if (existing) {
    db.prepare(
      `INSERT INTO property_confirmations(property_id, action, actor, detail)
       VALUES (?, 'idempotent_reuse', ?, ?)`
    ).run(existing.id, actor, 'same identity_key — no duplicate created');
    return existing;
  }

  const info = db
    .prepare(
      `INSERT INTO properties(site_address, city, state, zip, parcel_apn, parcel_jurisdiction,
         source, match_state, record_origin, notes, identity_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      normalized.site_address,
      normalized.city,
      normalized.state,
      normalized.zip,
      normalized.parcel_apn,
      normalized.parcel_jurisdiction,
      source,
      match_state,
      record_origin,
      notes,
      identity_key
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
  // Never choose most-recently-linked lot as implicit destination — lotGroupId required
  if (!lotGroupId) throw new Error('lot_group_id required for property link');
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
    .prepare(`SELECT * FROM property_confirmations WHERE property_id = ? ORDER BY id DESC LIMIT 50`)
    .all(Number(propertyId));
}

/**
 * Preview crosswalk CSV/JSON rows against stable community/lot identities.
 * Never invents one address for an entire lot range without evidence.
 * Never defaults unknown state to Virginia.
 */
export function previewCrosswalk(rows) {
  const results = [];
  for (const [i, row] of (rows || []).entries()) {
    const project_code = String(row.project_code || row.projectCode || '').trim();
    const community_name = String(row.community_name || row.communityName || row.community || row.project || '').trim();
    const lot_label = String(row.lot_label || row.lotLabel || row.lot || '').trim();
    const housetype = String(row.housetype || row.house_type || '').trim();
    const site_address = String(row.site_address || row.address || '').trim();
    const city = String(row.city || '').trim();
    const state = String(row.state || '').trim().toUpperCase(); // no VA default
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
    } else if (!site_address && !parcel_apn) {
      match_status = 'missing_input';
    }

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
      selected: false,
      payload: row,
    });
  }
  return results;
}

/**
 * Commit crosswalk — always re-runs server-side preview. Never trusts client match_status or lot IDs.
 * Only rows with selected=true (or confirmAll matched) are committed.
 */
export function commitCrosswalk(clientRows, { actor = 'ui', confirmSelectedOnly = true } = {}) {
  // Revalidate every row server-side
  const rawPayloads = (clientRows || []).map((r) => r.payload || r);
  const serverPreview = previewCrosswalk(rawPayloads);

  let linked = 0;
  let created = 0;
  let skipped = 0;
  const tx = db.transaction(() => {
    for (let i = 0; i < serverPreview.length; i++) {
      const row = serverPreview[i];
      const client = clientRows[i] || {};
      const selected = confirmSelectedOnly ? Boolean(client.selected) : true;

      const recordCrosswalk = (status, propertyId = null) => {
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
          status,
          row.lot_group_id,
          propertyId,
          row.source_row,
          JSON.stringify(row.payload || {})
        );
      };

      if (!selected) {
        recordCrosswalk(row.match_status);
        skipped += 1;
        continue;
      }

      // Client cannot force a different lot_group_id or match_status
      if (client.lot_group_id && Number(client.lot_group_id) !== Number(row.lot_group_id)) {
        recordCrosswalk('rejected_client_lot_mismatch');
        skipped += 1;
        continue;
      }

      const commitOk = ['matched_stable_key', 'matched_project_lot'].includes(row.match_status);
      const rangeOk =
        row.match_status === 'needs_review_range' &&
        (client.payload?.allow_range_address || client.allow_range_address);

      if (!commitOk && !rangeOk) {
        recordCrosswalk(row.match_status);
        skipped += 1;
        continue;
      }
      if (!row.lot_group_id || (!row.site_address && !row.parcel_apn)) {
        recordCrosswalk('missing_input');
        skipped += 1;
        continue;
      }

      const beforeCount = db.prepare(`SELECT COUNT(*) AS c FROM properties`).get().c;
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
      if (db.prepare(`SELECT COUNT(*) AS c FROM properties`).get().c > beforeCount) created += 1;

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
          server_revalidated: true,
        },
        confirmedBy: null,
      });
      linked += 1;
      recordCrosswalk('linked_candidate', property.id);
    }
  });
  tx();
  return { created, linked, skipped, preview: serverPreview };
}

export function missingPropertyLotCount() {
  return db
    .prepare(
      `SELECT COUNT(*) AS c FROM lot_groups lg
       WHERE lg.record_origin = 'import'
         AND NOT EXISTS (
           SELECT 1 FROM property_links pl
           WHERE pl.lot_group_id = lg.id AND pl.link_state IN ('candidate','confirmed','needs_reconfirmation')
         )`
    )
    .get().c;
}

export function missingPropertyQueue(limit = 50) {
  return db
    .prepare(
      `SELECT lg.id AS lot_group_id, lg.lot_label, lg.housetype, cs.project_code, cs.community_name,
              p.id AS permit_record_id, p.primary_official_id
       FROM lot_groups lg
       JOIN community_sections cs ON cs.id = lg.section_id
       LEFT JOIN permit_records p ON p.lot_group_id = lg.id AND p.record_origin = 'import'
       WHERE lg.record_origin = 'import'
         AND NOT EXISTS (
           SELECT 1 FROM property_links pl
           WHERE pl.lot_group_id = lg.id AND pl.link_state IN ('candidate','confirmed','needs_reconfirmation')
         )
       ORDER BY cs.community_name, lg.lot_label
       LIMIT ?`
    )
    .all(limit);
}

export function offerOfficialSiteAddressCandidate(permitId, { actor = 'ui' } = {}) {
  const snap = db
    .prepare(
      `SELECT * FROM official_snapshots WHERE permit_record_id = ? ORDER BY id DESC LIMIT 1`
    )
    .get(Number(permitId));
  if (!snap) return { offered: false, reason: 'no_official_snapshot' };
  let payload = {};
  try {
    payload = JSON.parse(snap.payload_json || '{}');
  } catch {
    payload = {};
  }
  const fields = payload.fields || {};
  const address =
    fields.address ||
    payload.siteAddress ||
    payload.site_address ||
    payload.address ||
    fields.ADDRESS_1 ||
    payload.raw?.ADDRESS_1 ||
    null;
  const parcel =
    fields.parcel ||
    payload.parcel ||
    payload.parcel_apn ||
    payload.raw?.APN ||
    null;
  if (!address && !parcel) {
    return { offered: false, reason: 'no_site_address_in_official_response' };
  }
  const permit = db.prepare('SELECT * FROM permit_records WHERE id = ?').get(Number(permitId));
  const property = upsertProperty(
    {
      site_address: address || '',
      city: payload.city || '',
      state: payload.state || '',
      zip: payload.zip || '',
      parcel_apn: parcel || '',
      parcel_jurisdiction: permit?.jurisdiction_code || '',
      source: 'official_connector',
      match_state: 'candidate',
      record_origin: 'official_offer',
      notes: 'Source-attributed official site address — review before confirm. Site ≠ owner mailing.',
    },
    { actor }
  );
  linkPropertyToLot({
    propertyId: property.id,
    lotGroupId: permit.lot_group_id,
    permitRecordId: permit.id,
    linkState: 'candidate',
    evidence: { source: 'official_snapshot', snapshot_id: snap.id },
  });
  return { offered: true, property, note: 'Site address from official response — not owner mailing address' };
}

export function crosswalkTemplateCsv() {
  return [
    'project_code,community_name,lot_label,housetype,site_address,city,state,zip,parcel_apn,parcel_jurisdiction',
    'PROJ1,Example Community,10,Townhome A,10 Example Rd,Demo City,VA,20100,,',
    'PROJ1,Example Community,1-4,Townhome A,99 Range Ave,Demo City,VA,20100,,',
  ].join('\n');
}

export { recordChange };
