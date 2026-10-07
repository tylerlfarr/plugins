import fs from 'node:fs';
import XLSX from 'xlsx';
import { db, getSetting, recordChange } from './db.js';
import {
  extractOfficialIds,
  normalizeOfficialId,
  suggestJurisdictionFromId,
  stableLotKey,
  isFairfaxCountyQueryCandidate,
} from './ids.js';
import { confirmJurisdictionFromHeaders, ARCHIVED_SHEETS } from './importProfile.js';
import { rebuildAllReadiness } from './readiness.js';
import { bumpPermitRowVersion } from './rowVersion.js';

export { extractOfficialIds, normalizeOfficialId, suggestJurisdictionFromId, stableLotKey };

export function parseWorkbookDate(value) {
  if (value == null || value === '') return { ok: true, value: null, kind: 'empty' };
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return { ok: true, value: value.toISOString().slice(0, 10), kind: 'date' };
  }
  const s = String(value).trim();
  if (!s) return { ok: true, value: null, kind: 'empty' };
  if (/^(na|n\/a|apply|can apply|need |rqst|submitted|resubmitted|john\/bk|ayes)/i.test(s)) {
    return { ok: true, value: s, kind: 'text' };
  }
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 20000 && n < 80000) {
      const utc = Math.round((n - 25569) * 86400 * 1000);
      return { ok: true, value: new Date(utc).toISOString().slice(0, 10), kind: 'date' };
    }
  }
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) {
    let year = m[3];
    if (year.length === 2) year = `20${year}`;
    const iso = `${year.padStart(4, '0')}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    if (!Number.isNaN(Date.parse(iso))) return { ok: true, value: iso, kind: 'date' };
  }
  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed) && /\d/.test(s)) {
    return { ok: true, value: new Date(parsed).toISOString().slice(0, 10), kind: 'date' };
  }
  return { ok: true, value: s, kind: 'text' };
}

function combineHeader(row1, row2, col) {
  const a = String(row1?.[col] ?? '').trim();
  const b = String(row2?.[col] ?? '').trim();
  if (a && b) return `${a} ${b}`.replace(/\s+/g, ' ').trim();
  return a || b || `col_${XLSX.utils.encode_col(col)}`;
}

function slugKey(label, col) {
  const base = String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  return `${base || 'col'}_${XLSX.utils.encode_col(col)}`.slice(0, 64);
}

export function detectPermitTrackerSections(rows) {
  const headerIdx = [];
  for (let i = 0; i < rows.length; i += 1) {
    const a = String(rows[i][0] ?? '').trim();
    if (/^proj id/i.test(a)) headerIdx.push(i);
  }
  const sections = [];
  for (let h = 0; h < headerIdx.length; h += 1) {
    const start = headerIdx[h];
    const end = h + 1 < headerIdx.length ? headerIdx[h + 1] : rows.length;
    const h1 = rows[start] || [];
    const h2 = rows[start + 1] || [];
    const projectCode = String(h2[0] ?? '').trim() || `SECTION_${start + 1}`;
    const headers = [];
    const maxCol = Math.max(h1.length, h2.length, 19);
    for (let c = 0; c < maxCol; c += 1) {
      if (c === 0 || c === 1 || c === 2) continue;
      const label = combineHeader(h1, h2, c);
      if (!label || label.startsWith('col_')) continue;
      headers.push({ col: c, key: slugKey(label, c), label });
    }
    const permitTime = String(h1[18] ?? h2[18] ?? '').trim();
    let communityName = projectCode;
    for (let r = start + 2; r < end; r += 1) {
      const a = String(rows[r]?.[0] ?? '').trim();
      if (a && !/^proj id/i.test(a) && a.length > projectCode.length) {
        communityName = a;
        break;
      }
    }
    const jur = confirmJurisdictionFromHeaders(headers, permitTime, projectCode);
    sections.push({
      headerRow: start + 1,
      dataStart: start + 2,
      dataEnd: end,
      project_code: projectCode,
      community_name: communityName,
      permit_time_note: permitTime,
      headers,
      jurisdiction_code: jur.code,
      jurisdiction_source: jur.source,
      jurisdiction_confirmed: jur.confirmed ? 1 : 0,
      authority_note: jur.authority_note || '',
    });
  }
  return sections;
}

function isDataRow(row) {
  if (!row) return false;
  const lot = String(row[1] ?? '').trim();
  const ht = String(row[2] ?? '').trim();
  const a = String(row[0] ?? '').trim();
  if (!lot && !ht && !String(row[18] ?? '').trim()) return false;
  if (/^proj id/i.test(a)) return false;
  if (/^id$/i.test(lot)) return false;
  return Boolean(lot || ht || extractOfficialIds(row[18]).length);
}

export function parseWorkbookBuffer(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: false });
  const result = {
    sheets: wb.SheetNames,
    permitTracker: { sections: [], rows: [] },
    revisions: [],
    masterfile: [],
    mstIds: [],
    reviews: [],
    archived: [],
    ignoredSheets: ARCHIVED_SHEETS.filter((s) => wb.SheetNames.includes(s)),
  };

  if (wb.Sheets['Permit Tracker']) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['Permit Tracker'], {
      header: 1,
      defval: null,
      raw: false,
    });
    result.permitTracker.sections = detectPermitTrackerSections(rows);

    for (const section of result.permitTracker.sections) {
      for (let r = section.dataStart; r < section.dataEnd; r += 1) {
        const row = rows[r];
        if (!isDataRow(row)) continue;
        const lot = String(row[1] ?? '').trim() || '(no lot)';
        const housetype = String(row[2] ?? '').trim();
        const notes = String(row[18] ?? '').trim();
        const ids = extractOfficialIds(notes);
        const milestones = {};
        for (const h of section.headers) {
          if (h.col === 18) continue;
          const parsed = parseWorkbookDate(row[h.col]);
          milestones[h.key] = {
            label: h.label,
            value: parsed.value,
            value_kind: parsed.kind,
          };
        }

        // Stable identity is lot-group, NOT first ID
        const stable_key = stableLotKey(
          section.project_code,
          section.community_name,
          lot,
          housetype
        );

        // Multi-record: one logical row may yield multiple official records
        const idList = ids.length ? ids : [null];
        for (let i = 0; i < idList.length; i += 1) {
          const oid = idList[i];
          const suggestion = oid ? suggestJurisdictionFromId(oid) : { code: 'unresolved', confidence: 'none' };
          let jurisdiction_code = section.jurisdiction_code;
          let jurisdiction_source = section.jurisdiction_source;
          let jurisdiction_confirmed = section.jurisdiction_confirmed;

          // Confirmed AHJ wins. Otherwise keep section geography suggestion;
          // ID heuristics may refine only when non-ambiguous and section unresolved.
          if (!jurisdiction_confirmed) {
            if (suggestion.confidence === 'ambiguous') {
              // Keep section geography suggestion if present; flag for review
              if (jurisdiction_code === 'unresolved') {
                jurisdiction_source = 'ambiguous_id';
              }
              result.reviews.push({
                reason: suggestion.reason || 'Ambiguous ID jurisdiction',
                candidate_official_id: oid,
                jurisdiction_code,
                payload: {
                  row: r + 1,
                  lot,
                  housetype,
                  community: section.community_name,
                  section_suggestion: section.jurisdiction_code,
                  suggestion,
                },
              });
            } else if (
              jurisdiction_code === 'unresolved' &&
              suggestion.code !== 'unresolved' &&
              suggestion.confidence !== 'none'
            ) {
              jurisdiction_code = suggestion.code;
              jurisdiction_source = 'inferred';
              jurisdiction_confirmed = 0;
            }
          }

          result.permitTracker.rows.push({
            sectionKey: `${section.project_code}::${section.community_name}`,
            project_code: section.project_code,
            community_name: section.community_name,
            jurisdiction_code,
            jurisdiction_source,
            jurisdiction_confirmed,
            authority_note: section.authority_note || '',
            permit_time_note: section.permit_time_note,
            headers: section.headers,
            headerRow: section.headerRow,
            source_row: r + 1,
            lot_label: lot,
            housetype,
            notes_raw: notes,
            official_ids: ids,
            primary_official_id: oid,
            sibling_ids: ids,
            milestones,
            stable_key,
            is_multi: ids.length > 1,
            multi_index: i,
          });
        }
      }
    }
  }

  if (wb.Sheets['Permit Revisions']) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['Permit Revisions'], {
      header: 1,
      defval: null,
      raw: false,
    });
    for (let i = 2; i < rows.length; i += 1) {
      const r = rows[i];
      if (!r?.[0] && !r?.[1]) continue;
      result.revisions.push({
        community_code: String(r[0] ?? '').trim(),
        lot: String(r[1] ?? '').trim(),
        revised_start_sheet: parseWorkbookDate(r[2]).value,
        date_submitted: parseWorkbookDate(r[3]).value,
        received_revised_permit: parseWorkbookDate(r[4]).value,
        reason: String(r[5] ?? '').trim(),
        comments: String(r[11] ?? '').trim(),
        source_row: i + 1,
      });
    }
  }

  if (wb.Sheets['Masterfile Plan Tracker']) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['Masterfile Plan Tracker'], {
      header: 1,
      defval: null,
      raw: false,
    });
    for (let i = 1; i < rows.length; i += 1) {
      const r = rows[i];
      if (!r) continue;
      const notes = String(r[10] ?? '').trim();
      const product = String(r[1] ?? '').trim();
      const neighborhood = String(r[3] ?? '').trim();
      if (!product && !neighborhood && !notes) continue;
      if (/^approved$/i.test(String(r[0] ?? '').trim())) continue;
      result.masterfile.push({
        house_type: String(r[0] ?? '').trim(),
        product_name: product,
        counties: String(r[2] ?? '').trim(),
        neighborhood,
        date_requested: parseWorkbookDate(r[4]).value,
        date_ready: parseWorkbookDate(r[5]).value,
        date_submitted: parseWorkbookDate(r[6]).value,
        comments_received: String(r[7] ?? '').trim(),
        date_resubmitted: parseWorkbookDate(r[8]).value,
        date_approved: parseWorkbookDate(r[9]).value,
        notes,
        official_ids: extractOfficialIds(`${notes} ${product} ${r[2] ?? ''}`),
        source_row: i + 1,
      });
    }
  }

  if (wb.Sheets["MST's"]) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets["MST's"], {
      header: 1,
      defval: null,
      raw: false,
    });
    const hintRow = rows[2] || [];
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i];
      if (!r) continue;
      for (let c = 0; c < r.length; c += 1) {
        const cell = String(r[c] ?? '');
        const ids = extractOfficialIds(cell);
        if (!ids.length) continue;
        let hint = 'unresolved';
        if (c <= 2) hint = 'loudoun_county';
        else if (c <= 4) hint = 'prince_william_county';
        else if (c <= 7) hint = 'fairfax_county';
        else hint = 'other';
        const header = String(hintRow[c] ?? hintRow[c - 1] ?? '').toLowerCase();
        if (header.includes('loudoun')) hint = 'loudoun_county';
        if (header.includes('prince') || header.includes('william')) hint = 'prince_william_county';
        if (header.includes('fairfax')) hint = 'fairfax_county';
        for (const id of ids) {
          result.mstIds.push({
            jurisdiction_hint: hint,
            product_or_context: String(r[c] ?? '').slice(0, 160),
            official_id: id,
            cell_text: cell.slice(0, 240),
            source_row: i + 1,
            source_col: XLSX.utils.encode_col(c),
          });
        }
      }
    }
  }

  // Archive deferred sheets (no silent wipe — store payloads)
  for (const sheetName of ARCHIVED_SHEETS) {
    if (!wb.Sheets[sheetName]) continue;
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
      header: 1,
      defval: null,
      raw: false,
    });
    rows.forEach((row, idx) => {
      if (!row || !row.some((c) => c != null && String(c).trim() !== '')) return;
      result.archived.push({
        sheet_name: sheetName,
        source_row: idx + 1,
        payload_json: JSON.stringify(row.slice(0, 40)),
      });
    });
  }

  return result;
}

function upsertSection(section) {
  const existing = db
    .prepare(
      `SELECT id FROM community_sections WHERE project_code = ? AND community_name = ? AND source_sheet = 'Permit Tracker'`
    )
    .get(section.project_code, section.community_name);
  if (existing) {
    db.prepare(
      `UPDATE community_sections SET jurisdiction_code = ?, jurisdiction_source = ?,
       jurisdiction_confirmed = ?, authority_note = ?, permit_time_note = ?, header_json = ?, source_header_row = ?,
       record_origin = 'import' WHERE id = ?`
    ).run(
      section.jurisdiction_code,
      section.jurisdiction_source,
      section.jurisdiction_confirmed ? 1 : 0,
      section.authority_note || '',
      section.permit_time_note || '',
      JSON.stringify(section.headers || []),
      section.headerRow || null,
      existing.id
    );
    return existing.id;
  }
  const info = db
    .prepare(
      `INSERT INTO community_sections(
         project_code, community_name, jurisdiction_code, jurisdiction_source, jurisdiction_confirmed,
         authority_note, permit_time_note, header_json, source_header_row, record_origin
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'import')`
    )
    .run(
      section.project_code,
      section.community_name,
      section.jurisdiction_code,
      section.jurisdiction_source,
      section.jurisdiction_confirmed ? 1 : 0,
      section.authority_note || '',
      section.permit_time_note || '',
      JSON.stringify(section.headers || []),
      section.headerRow || null
    );
  return Number(info.lastInsertRowid);
}

function upsertLotGroup(sectionId, row) {
  let existing = db
    .prepare(`SELECT id FROM lot_groups WHERE stable_key = ?`)
    .get(row.stable_key);
  if (!existing) {
    existing = db
      .prepare(
        `SELECT id FROM lot_groups WHERE section_id = ? AND lot_label = ? AND housetype = ?`
      )
      .get(sectionId, row.lot_label, row.housetype);
  }
  if (existing) {
    db.prepare(
      `UPDATE lot_groups SET notes_raw = ?, source_row = ?, stable_key = ?, record_origin = 'import' WHERE id = ?`
    ).run(row.notes_raw || '', row.source_row, row.stable_key, existing.id);
    return existing.id;
  }
  const info = db
    .prepare(
      `INSERT INTO lot_groups(section_id, lot_label, housetype, stable_key, source_row, notes_raw, record_origin)
       VALUES (?, ?, ?, ?, ?, ?, 'import')`
    )
    .run(
      sectionId,
      row.lot_label,
      row.housetype,
      row.stable_key,
      row.source_row,
      row.notes_raw || ''
    );
  return Number(info.lastInsertRowid);
}

function findPermitForIdentity(lotId, officialId) {
  if (officialId) {
    // Prefer match by official ID on this lot OR any lot (ID correction/move)
    const byId = db
      .prepare(
        `SELECT p.* FROM permit_records p
         JOIN official_ids oi ON oi.permit_record_id = p.id
         WHERE oi.official_id = ? AND p.record_origin = 'import'
         LIMIT 1`
      )
      .get(officialId);
    if (byId) return byId;

    const byPrimary = db
      .prepare(
        `SELECT * FROM permit_records WHERE lot_group_id = ? AND primary_official_id = ? AND record_origin = 'import'`
      )
      .get(lotId, officialId);
    if (byPrimary) return byPrimary;

    // First ID appearing on an existing no-ID shell → attach (not a new project)
    const shell = db
      .prepare(
        `SELECT * FROM permit_records WHERE lot_group_id = ? AND (primary_official_id IS NULL OR primary_official_id = '')
         AND record_origin = 'import' LIMIT 1`
      )
      .get(lotId);
    if (shell) return shell;
    return null;
  }
  // No-ID placeholder on this lot (single shell)
  return db
    .prepare(
      `SELECT * FROM permit_records WHERE lot_group_id = ? AND (primary_official_id IS NULL OR primary_official_id = '')
       AND record_origin = 'import' LIMIT 1`
    )
    .get(lotId);
}

function applyMilestoneImport(permitId, milestones, user, conflicts) {
  for (const [key, m] of Object.entries(milestones || {})) {
    if (m.value == null || m.value === '') continue; // blanks don't wipe
    const existing = db
      .prepare(
        `SELECT * FROM internal_milestones WHERE permit_record_id = ? AND key = ?`
      )
      .get(permitId, key);

    if (!existing) {
      db.prepare(
        `INSERT INTO internal_milestones(permit_record_id, key, label, value, value_kind, source, last_import_value)
         VALUES (?, ?, ?, ?, ?, 'import', ?)`
      ).run(permitId, key, m.label, String(m.value), m.value_kind, String(m.value));
      recordChange(permitId, `milestone:${key}`, '', m.value, user, 'import');
      continue;
    }

    const incoming = String(m.value);
    const appVal = String(existing.value ?? '');
    const prevImport = existing.last_import_value != null ? String(existing.last_import_value) : null;

    // 3-way conflict: app edited away from previous import, and incoming differs from app
    if (
      existing.edited_in_app &&
      prevImport != null &&
      appVal !== prevImport &&
      incoming !== appVal &&
      incoming !== prevImport
    ) {
      conflicts.push({
        permit_record_id: permitId,
        field: key,
        previous_import_value: prevImport,
        app_value: appVal,
        incoming_value: incoming,
      });
      continue;
    }

    if (appVal === incoming) {
      db.prepare(
        `UPDATE internal_milestones SET last_import_value = ?, label = ? WHERE permit_record_id = ? AND key = ?`
      ).run(incoming, m.label, permitId, key);
      continue;
    }

    // Not app-edited (or only import history) → apply incoming
    if (!existing.edited_in_app || appVal === prevImport) {
      recordChange(permitId, `milestone:${key}`, appVal, incoming, user, 'import');
      db.prepare(
        `UPDATE internal_milestones SET value = ?, label = ?, value_kind = ?, last_import_value = ?, source = 'import'
         WHERE permit_record_id = ? AND key = ?`
      ).run(incoming, m.label, m.value_kind, incoming, permitId, key);
    } else {
      conflicts.push({
        permit_record_id: permitId,
        field: key,
        previous_import_value: prevImport,
        app_value: appVal,
        incoming_value: incoming,
      });
    }
  }
}

export function commitWorkbookParse(parsed, { changedBy, replaceSecondary = true } = {}) {
  const user = changedBy || getSetting('current_user', 'demo.user');
  const summary = {
    sections: 0,
    lot_groups: 0,
    permits_created: 0,
    permits_updated: 0,
    official_ids: 0,
    revisions: 0,
    masterfile: 0,
    mst_ids: 0,
    reviews: 0,
    conflicts: 0,
    archived_rows: 0,
    multi_records: 0,
  };
  const conflictRows = [];

  const tx = db.transaction(() => {
    // Secondary sheets: replace on full workbook import (pass replaceSecondary:false to keep prior)
    if (replaceSecondary) {
      db.exec(`DELETE FROM permit_revisions; DELETE FROM plan_tracker_rows; DELETE FROM mst_reference_ids;`);
    }

    const sectionIds = new Map();
    for (const s of parsed.permitTracker.sections) {
      const id = upsertSection(s);
      sectionIds.set(`${s.project_code}::${s.community_name}`, id);
      summary.sections += 1;
    }

    const seenLots = new Set();
    for (const row of parsed.permitTracker.rows) {
      const sectionId = sectionIds.get(row.sectionKey);
      if (!sectionId) continue;
      const lotId = upsertLotGroup(sectionId, row);
      if (!seenLots.has(lotId)) {
        seenLots.add(lotId);
        summary.lot_groups += 1;
      }
      if (row.is_multi) summary.multi_records += 1;

      let permit = findPermitForIdentity(lotId, row.primary_official_id);

      // If found by ID on a different lot, re-associate (ID correction) — do not create duplicate project
      if (permit && permit.lot_group_id !== lotId) {
        db.prepare(`UPDATE permit_records SET lot_group_id = ?, updated_at = datetime('now') WHERE id = ?`).run(
          lotId,
          permit.id
        );
        recordChange(permit.id, 'lot_group_id', String(permit.lot_group_id), String(lotId), user, 'import');
        bumpPermitRowVersion(permit.id);
        permit = db.prepare('SELECT * FROM permit_records WHERE id = ?').get(permit.id);
      }

      if (!permit) {
        const info = db
          .prepare(
            `INSERT INTO permit_records(
               lot_group_id, primary_official_id, jurisdiction_code, jurisdiction_source,
               jurisdiction_confirmed, authority_note, internal_status, record_origin, progress_anchor_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'watching', 'import', datetime('now'))`
          )
          .run(
            lotId,
            row.primary_official_id,
            row.jurisdiction_code,
            row.jurisdiction_source,
            row.jurisdiction_confirmed ? 1 : 0,
            row.authority_note || ''
          );
        const permitId = Number(info.lastInsertRowid);
        recordChange(permitId, 'created', '', 'workbook_import', user, 'import');
        summary.permits_created += 1;
        permit = db.prepare('SELECT * FROM permit_records WHERE id = ?').get(permitId);
      } else {
        summary.permits_updated += 1;
        let importTouched = false;
        // Update jurisdiction only if newly confirmed
        if (row.jurisdiction_confirmed && !permit.jurisdiction_confirmed) {
          recordChange(
            permit.id,
            'jurisdiction_code',
            permit.jurisdiction_code,
            row.jurisdiction_code,
            user,
            'import'
          );
          db.prepare(
            `UPDATE permit_records SET jurisdiction_code = ?, jurisdiction_source = ?,
             jurisdiction_confirmed = 1, updated_at = datetime('now') WHERE id = ?`
          ).run(row.jurisdiction_code, row.jurisdiction_source, permit.id);
          importTouched = true;
        }
        // Attaching/correcting primary ID on existing shell
        if (
          row.primary_official_id &&
          (!permit.primary_official_id || permit.primary_official_id !== row.primary_official_id)
        ) {
          // If shell had no ID, attach — not a new project
          if (!permit.primary_official_id) {
            recordChange(permit.id, 'primary_official_id', '', row.primary_official_id, user, 'import');
            db.prepare(
              `UPDATE permit_records SET primary_official_id = ?, updated_at = datetime('now') WHERE id = ?`
            ).run(row.primary_official_id, permit.id);
            importTouched = true;
          }
        }
        // Always bump on re-import touch so open editors cannot overwrite with stale milestone saves.
        bumpPermitRowVersion(permit.id);
        void importTouched;
      }

      // Sync official IDs for this permit record.
      // Multi-record rows: link only this row's primary ID (siblings are separate PermitRecords).
      // Single-record rows: link the full extracted set on one shell.
      const idsToLink = row.is_multi
        ? row.primary_official_id
          ? [row.primary_official_id]
          : []
        : row.sibling_ids || row.official_ids || [];
      for (const oid of idsToLink) {
        if (!oid) continue;
        const sug = suggestJurisdictionFromId(oid);
        db.prepare(
          `INSERT INTO official_ids(permit_record_id, official_id, id_prefix, jurisdiction_guess, is_primary, extracted_from)
           VALUES (?, ?, ?, ?, ?, 'notes')
           ON CONFLICT(permit_record_id, official_id) DO UPDATE SET
             is_primary = excluded.is_primary,
             jurisdiction_guess = excluded.jurisdiction_guess`
        ).run(
          permit.id,
          oid,
          (oid.match(/^[A-Z]+/) || ['UNK'])[0],
          sug.code,
          oid === row.primary_official_id ? 1 : 0
        );
        summary.official_ids += 1;
      }

      // Shared milestones only applied once per lot when multi-index 0 (avoid duplicate conflicts)
      if (!row.is_multi || row.multi_index === 0 || row.primary_official_id) {
        applyMilestoneImport(permit.id, row.milestones, user, conflictRows);
      }
    }

    for (const c of conflictRows) {
      db.prepare(
        `INSERT INTO import_conflicts(permit_record_id, field, previous_import_value, app_value, incoming_value)
         VALUES (?, ?, ?, ?, ?)`
      ).run(c.permit_record_id, c.field, c.previous_import_value, c.app_value, c.incoming_value);
      summary.conflicts += 1;
    }

    const revisions = Array.isArray(parsed.revisions) ? parsed.revisions : [];
    const masterfile = Array.isArray(parsed.masterfile) ? parsed.masterfile : [];
    const mstIds = Array.isArray(parsed.mstIds) ? parsed.mstIds : [];
    if (replaceSecondary) {
      for (const rev of revisions) {
        db.prepare(
          `INSERT INTO permit_revisions(community_code, lot, revised_start_sheet, date_submitted, received_revised_permit, reason, comments, source_row)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          rev.community_code,
          rev.lot,
          rev.revised_start_sheet,
          rev.date_submitted,
          rev.received_revised_permit,
          rev.reason,
          rev.comments,
          rev.source_row
        );
        summary.revisions += 1;
      }
      for (const mf of masterfile) {
        db.prepare(
          `INSERT INTO plan_tracker_rows(house_type, product_name, counties, neighborhood, date_requested, date_ready, date_submitted, comments_received, date_resubmitted, date_approved, notes, official_ids_json, source_row)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          mf.house_type,
          mf.product_name,
          mf.counties,
          mf.neighborhood,
          mf.date_requested,
          mf.date_ready,
          mf.date_submitted,
          mf.comments_received,
          mf.date_resubmitted,
          mf.date_approved,
          mf.notes,
          JSON.stringify(mf.official_ids || []),
          mf.source_row
        );
        summary.masterfile += 1;
      }
      for (const m of mstIds) {
        db.prepare(
          `INSERT INTO mst_reference_ids(jurisdiction_hint, product_or_context, official_id, cell_text, source_row, source_col)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          m.jurisdiction_hint,
          m.product_or_context,
          m.official_id,
          m.cell_text,
          m.source_row,
          m.source_col
        );
        summary.mst_ids += 1;
      }
    }

    for (const rev of parsed.reviews) {
      db.prepare(
        `INSERT INTO match_reviews(jurisdiction_code, candidate_official_id, reason, payload_json)
         VALUES (?, ?, ?, ?)`
      ).run(
        rev.jurisdiction_code || 'unresolved',
        rev.candidate_official_id || '',
        rev.reason,
        JSON.stringify(rev.payload || {})
      );
      summary.reviews += 1;
    }

    // Archived sheets — append (do not wipe prior archives silently)
    for (const a of parsed.archived || []) {
      db.prepare(
        `INSERT INTO archived_sheet_rows(sheet_name, source_row, payload_json) VALUES (?, ?, ?)`
      ).run(a.sheet_name, a.source_row, a.payload_json);
      summary.archived_rows += 1;
    }
  });
  tx();

  db.prepare(`INSERT INTO import_runs(filename, summary_json) VALUES (?, ?)`).run(
    'source_workbook',
    JSON.stringify(summary)
  );
  // Recompute lot-readiness after import (milestones + revisions changed)
  const readiness = rebuildAllReadiness();
  summary.readiness = readiness.counts;
  return summary;
}

export function importWorkbookFile(filePathOrBuffer, filename = 'source.xlsx') {
  const buffer = Buffer.isBuffer(filePathOrBuffer)
    ? filePathOrBuffer
    : fs.readFileSync(filePathOrBuffer);
  const parsed = parseWorkbookBuffer(buffer);
  const summary = commitWorkbookParse(parsed);
  return { parsed, summary, filename };
}

// Compatibility aliases (prefer workbook* names in new code)
export const parseGospelBuffer = parseWorkbookBuffer;
export const commitGospelParse = commitWorkbookParse;
export const importGospelFile = importWorkbookFile;
export function isFairfaxShapedId(id) {
  return isFairfaxCountyQueryCandidate(id);
}
export function guessJurisdictionFromId(id) {
  const s = suggestJurisdictionFromId(id);
  return s.code === 'unresolved' ? 'unknown' : s.code;
}
