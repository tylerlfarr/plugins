import XLSX from 'xlsx';
import { db, getSetting, recordChange } from './db.js';

export const TARGET_FIELDS = [
  { key: 'community', label: 'Community', required: true },
  { key: 'project', label: 'Project', required: true },
  { key: 'lot_number', label: 'Lot', required: true },
  { key: 'address', label: 'Address', required: false },
  { key: 'parcel_id', label: 'Parcel ID', required: false },
  { key: 'jurisdiction_code', label: 'Jurisdiction', required: true },
  { key: 'official_id', label: 'Official Permit ID', required: false },
  { key: 'permit_type', label: 'Permit Type', required: false },
  { key: 'source_native_status', label: 'Source Status', required: false },
  { key: 'official_status', label: 'Official Status', required: false },
  { key: 'internal_status', label: 'Internal Status', required: false },
  { key: 'submitted_date', label: 'Submitted Date', required: false },
  { key: 'approved_date', label: 'Approved Date', required: false },
  { key: 'issued_date', label: 'Issued Date', required: false },
  { key: 'revision_date', label: 'Revision Date', required: false },
  { key: 'construction_start_date', label: 'Construction Start', required: false },
  { key: 'expiration_date', label: 'Expiration Date', required: false },
  { key: 'predicted_issue_date', label: 'Predicted Issue (non-official)', required: false },
  { key: 'owner', label: 'Owner', required: false },
  { key: 'notes', label: 'Notes', required: false },
  { key: 'next_action', label: 'Next Action', required: false },
  { key: 'next_action_due', label: 'Next Action Due', required: false },
  { key: 'source_url', label: 'Source URL', required: false },
];

const DATE_KEYS = new Set([
  'submitted_date',
  'approved_date',
  'issued_date',
  'revision_date',
  'construction_start_date',
  'expiration_date',
  'predicted_issue_date',
  'next_action_due',
]);

export function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  const headers = rows.length ? Object.keys(rows[0]) : XLSX.utils.sheet_to_json(sheet, { header: 1 })[0] || [];
  return { sheetName, headers, rows };
}

export function suggestMapping(headers) {
  const mapping = {};
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const aliases = {
    community: ['community', 'community name', 'subdivision'],
    project: ['project', 'project name', 'phase'],
    lot_number: ['lot', 'lot number', 'lot #', 'lot no'],
    address: ['address', 'site address', 'street'],
    parcel_id: ['parcel', 'parcel id', 'pin', 'tax map'],
    jurisdiction_code: ['jurisdiction', 'county', 'city', 'ahj'],
    official_id: ['permit number', 'permit #', 'permit id', 'official id', 'record id', 'record number'],
    permit_type: ['permit type', 'type', 'record type'],
    source_native_status: ['source status', 'ahj status', 'portal status'],
    official_status: ['official status', 'status'],
    internal_status: ['internal status', 'workflow', 'internal'],
    submitted_date: ['submitted', 'submission date', 'submitted date', 'date submitted'],
    approved_date: ['approved', 'approval date', 'approved date', 'date approved'],
    issued_date: ['issued', 'issue date', 'issued date', 'date issued'],
    revision_date: ['revision', 'revision date', 'resubmittal'],
    construction_start_date: ['construction start', 'start date', 'start construction'],
    expiration_date: ['expiration', 'expires', 'expiration date'],
    predicted_issue_date: ['predicted issue', 'forecast issue', 'eta issue'],
    owner: ['owner', 'assignee', 'pm', 'coordinator'],
    notes: ['notes', 'comments', 'comment'],
    next_action: ['next action', 'action', 'follow up'],
    next_action_due: ['next action due', 'action due', 'due date'],
    source_url: ['source url', 'link', 'url', 'portal link'],
  };

  for (const field of TARGET_FIELDS) {
    const list = aliases[field.key] || [field.key];
    const hit = headers.find((h) => list.includes(norm(h)));
    if (hit) mapping[field.key] = hit;
  }
  return mapping;
}

function excelDateToIso(value) {
  if (value == null || value === '') return { ok: true, value: null };
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return { ok: true, value: value.toISOString().slice(0, 10) };
  }
  const s = String(value).trim();
  if (!s) return { ok: true, value: null };
  // Excel serial as number string
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 20000 && n < 80000) {
      const utc = Math.round((n - 25569) * 86400 * 1000);
      return { ok: true, value: new Date(utc).toISOString().slice(0, 10) };
    }
  }
  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) {
    return { ok: true, value: new Date(parsed).toISOString().slice(0, 10) };
  }
  // common m/d/yyyy
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    const iso = `${year.padStart(4, '0')}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    if (!Number.isNaN(Date.parse(iso))) return { ok: true, value: iso };
  }
  return { ok: false, value: s, error: `Unparseable date: ${s}` };
}

function normalizeJurisdiction(raw) {
  const s = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
  const map = {
    fairfax_county: 'fairfax_county',
    fairfax: 'fairfax_county',
    fairfax_county_va: 'fairfax_county',
    city_of_fairfax: 'city_of_fairfax',
    fairfax_city: 'city_of_fairfax',
    city_of_houston: 'city_of_houston',
    houston: 'city_of_houston',
    harris_county: 'harris_county',
    harris: 'harris_county',
  };
  return map[s] || s;
}

export function validateMappedRows(rows, mapping) {
  const preview = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const mapped = {};
    const errors = [];
    const warnings = [];

    for (const field of TARGET_FIELDS) {
      const header = mapping[field.key];
      let value = header ? row[header] : '';
      if (DATE_KEYS.has(field.key)) {
        const d = excelDateToIso(value);
        if (!d.ok) errors.push(d.error);
        value = d.value;
      } else if (field.key === 'jurisdiction_code') {
        value = normalizeJurisdiction(value);
      } else {
        value = value == null ? '' : String(value).trim();
      }
      mapped[field.key] = value;
      if (field.required && !value) errors.push(`Missing ${field.label}`);
    }

    let match = 'create';
    if (mapped.jurisdiction_code && mapped.official_id) {
      const existing = db
        .prepare(
          `SELECT id FROM permits WHERE jurisdiction_code = ? AND official_id = ?`
        )
        .get(mapped.jurisdiction_code, mapped.official_id);
      if (existing) match = 'update_by_official_id';
    } else if (mapped.community && mapped.project && mapped.lot_number && mapped.permit_type) {
      const existing = db
        .prepare(
          `SELECT p.id FROM permits p
           JOIN lots l ON l.id = p.lot_id
           JOIN projects pr ON pr.id = l.project_id
           JOIN communities c ON c.id = pr.community_id
           WHERE c.name = ? AND pr.name = ? AND l.lot_number = ? AND p.permit_type = ?`
        )
        .get(mapped.community, mapped.project, mapped.lot_number, mapped.permit_type || 'Building');
      if (existing) {
        match = 'update_by_lot_type';
        warnings.push('Matched by community/project/lot/type (no official ID)');
      }
    }

    if (mapped.official_id && !mapped.jurisdiction_code) {
      errors.push('Official ID without jurisdiction is ambiguous');
    }

    preview.push({
      rowNumber: i + 2,
      mapped,
      errors,
      warnings,
      match,
      ok: errors.length === 0,
    });
  }
  return preview;
}

function ensureLot(mapped) {
  let community = db.prepare('SELECT * FROM communities WHERE name = ?').get(mapped.community);
  if (!community) {
    const info = db
      .prepare('INSERT INTO communities(name, jurisdiction_code) VALUES (?, ?)')
      .run(mapped.community, mapped.jurisdiction_code);
    community = db.prepare('SELECT * FROM communities WHERE id = ?').get(info.lastInsertRowid);
  }
  let project = db
    .prepare('SELECT * FROM projects WHERE community_id = ? AND name = ?')
    .get(community.id, mapped.project);
  if (!project) {
    const info = db
      .prepare('INSERT INTO projects(community_id, name) VALUES (?, ?)')
      .run(community.id, mapped.project);
    project = db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid);
  }
  let lot = db
    .prepare('SELECT * FROM lots WHERE project_id = ? AND lot_number = ?')
    .get(project.id, mapped.lot_number);
  if (!lot) {
    const info = db
      .prepare('INSERT INTO lots(project_id, lot_number, address, parcel_id) VALUES (?, ?, ?, ?)')
      .run(project.id, mapped.lot_number, mapped.address || '', mapped.parcel_id || '');
    lot = db.prepare('SELECT * FROM lots WHERE id = ?').get(info.lastInsertRowid);
  } else {
    db.prepare(
      "UPDATE lots SET address = COALESCE(NULLIF(?, ''), address), parcel_id = COALESCE(NULLIF(?, ''), parcel_id) WHERE id = ?"
    ).run(mapped.address || '', mapped.parcel_id || '', lot.id);
  }
  return lot;
}

const IMPORTABLE = [
  'permit_type',
  'source_native_status',
  'official_status',
  'internal_status',
  'submitted_date',
  'approved_date',
  'issued_date',
  'revision_date',
  'construction_start_date',
  'expiration_date',
  'predicted_issue_date',
  'owner',
  'notes',
  'next_action',
  'next_action_due',
  'source_url',
  'official_id',
  'jurisdiction_code',
];

/**
 * Non-destructive update: blank import cells do not clear existing values.
 * Explicit values overwrite corresponding fields and are history-logged.
 */
export function commitImport(previewRows, { changedBy } = {}) {
  const user = changedBy || getSetting('current_user', 'demo.user');
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const duplicates = [];

  const tx = db.transaction(() => {
    for (const row of previewRows) {
      if (!row.ok) {
        skipped += 1;
        continue;
      }
      const m = row.mapped;
      const lot = ensureLot(m);

      let existing = null;
      if (m.jurisdiction_code && m.official_id) {
        existing = db
          .prepare('SELECT * FROM permits WHERE jurisdiction_code = ? AND official_id = ?')
          .get(m.jurisdiction_code, m.official_id);
      }
      if (!existing && row.match === 'update_by_lot_type') {
        existing = db
          .prepare(
            `SELECT * FROM permits WHERE lot_id = ? AND permit_type = ?`
          )
          .get(lot.id, m.permit_type || 'Building');
      }

      if (!existing) {
        const info = db
          .prepare(
            `INSERT INTO permits(
              lot_id, jurisdiction_code, official_id, permit_type, source_native_status, official_status,
              internal_status, submitted_date, approved_date, issued_date, revision_date,
              construction_start_date, expiration_date, predicted_issue_date, owner, notes,
              next_action, next_action_due, source_url
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          )
          .run(
            lot.id,
            m.jurisdiction_code,
            m.official_id || null,
            m.permit_type || 'Building',
            m.source_native_status || '',
            m.official_status || 'unknown',
            m.internal_status || 'watching',
            m.submitted_date,
            m.approved_date,
            m.issued_date,
            m.revision_date,
            m.construction_start_date,
            m.expiration_date,
            m.predicted_issue_date,
            m.owner || '',
            m.notes || '',
            m.next_action || '',
            m.next_action_due,
            m.source_url || ''
          );
        recordChange(info.lastInsertRowid, 'created', '', 'import', user, 'import');
        created += 1;
      } else {
        duplicates.push({ permitId: existing.id, official_id: existing.official_id, rowNumber: row.rowNumber });
        for (const key of IMPORTABLE) {
          const incoming = m[key];
          if (incoming == null || incoming === '') continue;
          const col = key;
          if (String(existing[col] ?? '') === String(incoming)) continue;
          recordChange(existing.id, col, existing[col], incoming, user, 'import');
          db.prepare(`UPDATE permits SET ${col} = ?, updated_at = datetime('now') WHERE id = ?`).run(
            incoming,
            existing.id
          );
          existing[col] = incoming;
        }
        updated += 1;
      }
    }
  });
  tx();
  return { created, updated, skipped, duplicates };
}

export function exportPermitsXlsx() {
  const rows = db
    .prepare(
      `SELECT
         c.name AS community,
         pr.name AS project,
         l.lot_number,
         l.address,
         l.parcel_id,
         p.jurisdiction_code,
         p.official_id,
         p.permit_type,
         p.source_native_status,
         p.official_status,
         p.internal_status,
         p.submitted_date,
         p.approved_date,
         p.issued_date,
         p.revision_date,
         p.construction_start_date,
         p.expiration_date,
         p.predicted_issue_date,
         p.owner,
         p.notes,
         p.next_action,
         p.next_action_due,
         p.source_url,
         p.last_successful_check_at,
         p.last_check_outcome
       FROM permits p
       JOIN lots l ON l.id = p.lot_id
       JOIN projects pr ON pr.id = l.project_id
       JOIN communities c ON c.id = pr.community_id
       ORDER BY c.name, pr.name, l.lot_number, p.id`
    )
    .all();
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Permits');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

export function buildSampleWorkbook() {
  const data = [
    {
      Community: 'Oakridge Estates',
      Project: 'Phase 2',
      Lot: '12',
      Address: '100 Demo Oak Ln',
      Jurisdiction: 'fairfax_county',
      'Permit ID': 'ALTC-2026-00970',
      'Permit Type': 'Building',
      'Official Status': 'issued',
      'Internal Status': 'watching',
      Owner: 'Alex PM',
      Notes: 'Keep internal note on re-import',
      'Next Action': 'Confirm inspection',
      'Next Action Due': '2026-10-10',
      'Submitted Date': '2026-03-01',
      'Approved Date': '',
      'Issued Date': '2026-09-28',
    },
    {
      Community: 'Oakridge Estates',
      Project: 'Phase 2',
      Lot: '12',
      Address: '100 Demo Oak Ln',
      Jurisdiction: 'fairfax_county',
      'Permit ID': 'FFX-TRADE-DEMO-12',
      'Permit Type': 'Electrical',
      'Official Status': 'in_review',
      'Internal Status': 'needs_followup',
      Owner: 'Alex PM',
      Notes: 'Second permit on same lot',
      'Next Action': 'Call AHJ',
      'Next Action Due': '2026-10-01',
      'Submitted Date': '2026-09-15',
    },
    {
      Community: 'Bayou Bend',
      Project: 'Section A',
      Lot: '3',
      Address: '220 Synthetic Bayou Rd',
      Jurisdiction: 'city_of_houston',
      'Permit ID': 'HOU-DEMO-55001',
      'Permit Type': 'Building',
      'Official Status': 'issued',
      'Internal Status': 'watching',
      Owner: 'Jordan PM',
      Notes: 'Houston synthetic connector',
      'Expiration Date': '2027-04-05',
      'Predicted Issue': '2026-04-01',
    },
  ];
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Import');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
