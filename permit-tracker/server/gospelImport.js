import fs from 'node:fs';
import XLSX from 'xlsx';
import { db, getSetting, recordChange } from './db.js';

export const OFFICIAL_ID_RE =
  /\b((?:ZNA|ZONC|BLD|BLDC|BLDR|ALTC|ALTR|BPR|MST|MASTRR|MASTR|MASTC)-?\d{4}-?\d+)\b/gi;

const SKIP_SHEETS = new Set([
  'Indirect Cost',
  '2018 IRC Tracker',
  'Corewall Alternative Tracker',
  'WHSD Masterfile',
]);

export function extractOfficialIds(text) {
  if (!text) return [];
  const found = [];
  const re = new RegExp(OFFICIAL_ID_RE.source, 'gi');
  let m;
  while ((m = re.exec(String(text)))) {
    found.push(normalizeOfficialId(m[1]));
  }
  return [...new Set(found)];
}

export function normalizeOfficialId(raw) {
  let s = String(raw).toUpperCase().replace(/\s+/g, '');
  // BLD2026-04765 → keep; BLDC-2026-013456 → keep
  const m = s.match(/^([A-Z]+)(-?)(\d{4})(-?)(\d+)$/);
  if (!m) return s;
  const [, prefix, , year, , seq] = m;
  // Prefer hyphenated TYPE-YEAR-SEQ for Fairfax-shaped codes
  if (['BLDC', 'BLDR', 'ALTC', 'ALTR', 'ZONC', 'MASTR', 'MASTRR', 'MASTC'].includes(prefix)) {
    return `${prefix}-${year}-${seq}`;
  }
  // PWC-ish compact: BLD2026-04765 or BLD202604765
  if (['BLD', 'ZNA', 'BPR', 'MST'].includes(prefix)) {
    return `${prefix}${year}-${seq}`;
  }
  return `${prefix}-${year}-${seq}`;
}

export function guessJurisdictionFromId(id) {
  const u = String(id).toUpperCase();
  if (/^(ALTC|ALTR|BLDR)-/.test(u)) return 'fairfax_county';
  if (/^(MASTRR?|MASTC|BLDC)-/.test(u)) return 'loudoun_county'; // LandMARC-shaped; may collide with Fairfax BLDC
  if (/^(MST|BPR|BLD|ZNA)\d{4}-/.test(u) || /^(MST|BPR)\d{4}-/.test(u)) return 'prince_william_county';
  if (/^ZONC-/.test(u)) return 'loudoun_county';
  return 'unknown';
}

export function isFairfaxShapedId(id) {
  return /^(ALTC|ALTR|BLDC|BLDR|XXXX)-\d{4}-\d+$/i.test(id);
}

export function parseWorkbookDate(value) {
  if (value == null || value === '') return { ok: true, value: null, kind: 'empty' };
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return { ok: true, value: value.toISOString().slice(0, 10), kind: 'date' };
  }
  const s = String(value).trim();
  if (!s) return { ok: true, value: null, kind: 'empty' };
  // status-like text, not a date
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
  // m/d/yy or m/d/yyyy
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

function inferJurisdiction(section) {
  const blob = `${section.project_code} ${section.community_name} ${section.permit_time_note} ${JSON.stringify(section.headers)}`.toLowerCase();
  if (blob.includes('loco') || blob.includes('loudoun') || blob.includes('cascades') || blob.includes('tuscarora')) {
    return 'loudoun_county';
  }
  if (
    blob.includes('pw ') ||
    blob.includes('pwc') ||
    blob.includes('prince william') ||
    blob.includes('bradley') ||
    blob.includes('innovation') ||
    blob.includes('potomac shores') ||
    blob.includes('quartz')
  ) {
    return 'prince_william_county';
  }
  if (blob.includes('fairfax') || blob.includes('ffx')) return 'fairfax_county';
  if (blob.includes('houston')) return 'city_of_houston';
  if (blob.includes('harris')) return 'harris_county';
  if (blob.includes('ranson') || blob.includes('charles town') || blob.includes('wv')) return 'other';
  return 'unknown';
}

/**
 * Detect repeating 2-row headers on Permit Tracker sheet.
 */
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
      if (c === 0 || c === 1 || c === 2) continue; // community/lot/housetype structural
      const label = combineHeader(h1, h2, c);
      if (!label || label.startsWith('col_')) continue;
      headers.push({ col: c, key: slugKey(label, c), label });
    }
    const permitTime = String(h1[18] ?? h2[18] ?? '').trim();
    // community name: first data row with a longer name in col A, else project code
    let communityName = projectCode;
    for (let r = start + 2; r < end; r += 1) {
      const a = String(rows[r]?.[0] ?? '').trim();
      if (a && !/^proj id/i.test(a) && a.length > projectCode.length) {
        communityName = a;
        break;
      }
    }
    sections.push({
      headerRow: start + 1,
      dataStart: start + 2,
      dataEnd: end,
      project_code: projectCode,
      community_name: communityName,
      permit_time_note: permitTime,
      headers,
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

export function parseGospelBuffer(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: false });
  const result = {
    sheets: wb.SheetNames,
    permitTracker: { sections: [], rows: [] },
    revisions: [],
    masterfile: [],
    mstIds: [],
    reviews: [],
    ignoredSheets: [...SKIP_SHEETS].filter((s) => wb.SheetNames.includes(s)),
  };

  if (wb.Sheets['Permit Tracker']) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['Permit Tracker'], {
      header: 1,
      defval: null,
      raw: false,
    });
    const sections = detectPermitTrackerSections(rows);
    result.permitTracker.sections = sections.map((s) => ({
      ...s,
      jurisdiction_code: inferJurisdiction(s),
    }));

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
          if (h.col === 18) continue; // notes/permit time column kept raw
          const parsed = parseWorkbookDate(row[h.col]);
          milestones[h.key] = {
            label: h.label,
            value: parsed.value,
            value_kind: parsed.kind,
          };
        }
        const primary = ids[0] || null;
        let jurisdiction = section.jurisdiction_code;
        if (primary) {
          const g = guessJurisdictionFromId(primary);
          if (g !== 'unknown') jurisdiction = g;
        }
        const ambiguous = ids.length > 1 && !primary;
        if (ids.length > 2) {
          // multiple IDs OK; primary is first. Flag review if mixed jurisdictions
          const jurisdictions = new Set(ids.map(guessJurisdictionFromId));
          if (jurisdictions.size > 1) {
            result.reviews.push({
              reason: 'Mixed jurisdiction official IDs in one notes cell',
              candidate_official_id: ids.join(', '),
              jurisdiction_code: jurisdiction,
              payload: { row: r + 1, ids, notes, lot, housetype, community: section.community_name },
            });
          }
        }
        result.permitTracker.rows.push({
          sectionKey: `${section.project_code}::${section.community_name}`,
          project_code: section.project_code,
          community_name: section.community_name,
          jurisdiction_code: jurisdiction,
          permit_time_note: section.permit_time_note,
          headers: section.headers,
          headerRow: section.headerRow,
          source_row: r + 1,
          lot_label: lot,
          housetype,
          notes_raw: notes,
          official_ids: ids,
          primary_official_id: primary,
          milestones,
          duplicate_key: `${section.community_name}|${lot}|${housetype}|${primary || ''}`,
        });
        void ambiguous;
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
      const ids = extractOfficialIds(`${notes} ${product} ${r[2] ?? ''}`);
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
        official_ids: ids,
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
    // column jurisdiction hints from row 3
    const hintRow = rows[2] || [];
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i];
      if (!r) continue;
      for (let c = 0; c < r.length; c += 1) {
        const cell = String(r[c] ?? '');
        const ids = extractOfficialIds(cell);
        if (!ids.length) continue;
        let hint = 'unknown';
        const colLetter = XLSX.utils.encode_col(c);
        if (c <= 2) hint = 'loudoun_county';
        else if (c <= 4) hint = 'prince_william_county';
        else if (c <= 7) hint = 'fairfax_county';
        else hint = 'misc';
        // override from header labels if present
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
            source_col: colLetter,
          });
        }
      }
    }
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
      `UPDATE community_sections SET jurisdiction_code = ?, permit_time_note = ?, header_json = ?, source_header_row = ? WHERE id = ?`
    ).run(
      section.jurisdiction_code,
      section.permit_time_note || '',
      JSON.stringify(section.headers || []),
      section.headerRow || null,
      existing.id
    );
    return existing.id;
  }
  const info = db
    .prepare(
      `INSERT INTO community_sections(project_code, community_name, jurisdiction_code, permit_time_note, header_json, source_header_row)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      section.project_code,
      section.community_name,
      section.jurisdiction_code,
      section.permit_time_note || '',
      JSON.stringify(section.headers || []),
      section.headerRow || null
    );
  return Number(info.lastInsertRowid);
}

function upsertLotGroup(sectionId, row) {
  const existing = db
    .prepare(
      `SELECT id, notes_raw FROM lot_groups WHERE section_id = ? AND lot_label = ? AND housetype = ?`
    )
    .get(sectionId, row.lot_label, row.housetype);
  if (existing) {
    db.prepare(`UPDATE lot_groups SET notes_raw = ?, source_row = ? WHERE id = ?`).run(
      row.notes_raw || '',
      row.source_row,
      existing.id
    );
    return existing.id;
  }
  const info = db
    .prepare(
      `INSERT INTO lot_groups(section_id, lot_label, housetype, source_row, notes_raw) VALUES (?, ?, ?, ?, ?)`
    )
    .run(sectionId, row.lot_label, row.housetype, row.source_row, row.notes_raw || '');
  return Number(info.lastInsertRowid);
}

/**
 * Commit parsed gospel data. Internal milestones: blank incoming does not clear existing.
 */
export function commitGospelParse(parsed, { changedBy } = {}) {
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
    duplicates: 0,
  };

  const tx = db.transaction(() => {
    // clear secondary sheets each full gospel import (reference data)
    db.exec(`DELETE FROM permit_revisions; DELETE FROM plan_tracker_rows; DELETE FROM mst_reference_ids;`);

    const sectionIds = new Map();
    for (const s of parsed.permitTracker.sections) {
      const id = upsertSection(s);
      sectionIds.set(`${s.project_code}::${s.community_name}`, id);
      summary.sections += 1;
    }

    for (const row of parsed.permitTracker.rows) {
      const sectionId = sectionIds.get(row.sectionKey);
      if (!sectionId) continue;
      const lotId = upsertLotGroup(sectionId, row);
      summary.lot_groups += 1;

      let permit = null;
      if (row.primary_official_id) {
        permit = db
          .prepare(
            `SELECT p.* FROM permit_records p
             JOIN lot_groups lg ON lg.id = p.lot_group_id
             WHERE lg.section_id = ? AND lg.lot_label = ? AND lg.housetype = ?
               AND p.primary_official_id = ?`
          )
          .get(sectionId, row.lot_label, row.housetype, row.primary_official_id);
      }
      if (!permit) {
        permit = db
          .prepare(
            `SELECT p.* FROM permit_records p
             WHERE p.lot_group_id = ? AND IFNULL(p.primary_official_id,'') = IFNULL(?, '')`
          )
          .get(lotId, row.primary_official_id);
      }

      if (!permit) {
        const info = db
          .prepare(
            `INSERT INTO permit_records(lot_group_id, primary_official_id, jurisdiction_code, internal_status)
             VALUES (?, ?, ?, 'watching')`
          )
          .run(lotId, row.primary_official_id, row.jurisdiction_code);
        const permitId = Number(info.lastInsertRowid);
        recordChange(permitId, 'created', '', 'gospel_import', user, 'import');
        summary.permits_created += 1;
        permit = db.prepare('SELECT * FROM permit_records WHERE id = ?').get(permitId);
      } else {
        summary.permits_updated += 1;
        summary.duplicates += 1;
        if (permit.jurisdiction_code !== row.jurisdiction_code && row.jurisdiction_code !== 'unknown') {
          recordChange(
            permit.id,
            'jurisdiction_code',
            permit.jurisdiction_code,
            row.jurisdiction_code,
            user,
            'import'
          );
          db.prepare(`UPDATE permit_records SET jurisdiction_code = ?, updated_at = datetime('now') WHERE id = ?`).run(
            row.jurisdiction_code,
            permit.id
          );
        }
      }

      // official ids — additive
      for (let i = 0; i < row.official_ids.length; i += 1) {
        const oid = row.official_ids[i];
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
          guessJurisdictionFromId(oid),
          i === 0 ? 1 : 0
        );
        summary.official_ids += 1;
      }
      if (row.primary_official_id && permit.primary_official_id !== row.primary_official_id) {
        recordChange(
          permit.id,
          'primary_official_id',
          permit.primary_official_id,
          row.primary_official_id,
          user,
          'import'
        );
        db.prepare(
          `UPDATE permit_records SET primary_official_id = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(row.primary_official_id, permit.id);
      }

      // internal milestones — never clear with blank
      for (const [key, m] of Object.entries(row.milestones || {})) {
        if (m.value == null || m.value === '') continue;
        const existing = db
          .prepare(`SELECT value FROM internal_milestones WHERE permit_record_id = ? AND key = ?`)
          .get(permit.id, key);
        if (existing) {
          if (String(existing.value ?? '') === String(m.value)) continue;
          recordChange(permit.id, `milestone:${key}`, existing.value, m.value, user, 'import');
          db.prepare(
            `UPDATE internal_milestones SET value = ?, label = ?, value_kind = ? WHERE permit_record_id = ? AND key = ?`
          ).run(String(m.value), m.label, m.value_kind, permit.id, key);
        } else {
          db.prepare(
            `INSERT INTO internal_milestones(permit_record_id, key, label, value, value_kind) VALUES (?, ?, ?, ?, ?)`
          ).run(permit.id, key, m.label, String(m.value), m.value_kind);
          recordChange(permit.id, `milestone:${key}`, '', m.value, user, 'import');
        }
      }
    }

    for (const rev of parsed.revisions) {
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

    for (const mf of parsed.masterfile) {
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

    for (const m of parsed.mstIds) {
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

    for (const rev of parsed.reviews) {
      db.prepare(
        `INSERT INTO match_reviews(jurisdiction_code, candidate_official_id, reason, payload_json)
         VALUES (?, ?, ?, ?)`
      ).run(
        rev.jurisdiction_code || 'unknown',
        rev.candidate_official_id || '',
        rev.reason,
        JSON.stringify(rev.payload || {})
      );
      summary.reviews += 1;
    }
  });
  tx();

  db.prepare(`INSERT INTO import_runs(filename, summary_json) VALUES (?, ?)`).run(
    'gospel',
    JSON.stringify(summary)
  );
  return summary;
}

export function importGospelFile(filePathOrBuffer, filename = 'gospel.xlsx') {
  const buffer = Buffer.isBuffer(filePathOrBuffer)
    ? filePathOrBuffer
    : fs.readFileSync(filePathOrBuffer);
  const parsed = parseGospelBuffer(buffer);
  const summary = commitGospelParse(parsed);
  return { parsed, summary, filename };
}
