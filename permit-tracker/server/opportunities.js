/**
 * Phase 5 — workbook-free discovery and private opportunity qualification.
 *
 * Opportunities are workspace-private. Never auto-convert into marketing leads
 * or invent lots. Transparent match rules only (no opaque AI scores).
 */
import XLSX from 'xlsx';
import { db } from './db.js';
import { getAdapter } from './connectors/adapters.js';
import { JURISDICTIONS } from './connectors/types.js';
import { discoverFairfaxPermits } from './connectors/fairfax.js';
import { getSource, ensureSourceRegistrySeeded } from './sources/registry.js';

export const OPPORTUNITY_DISPOSITIONS = [
  'new',
  'reviewing',
  'qualified',
  'follow_up',
  'not_relevant',
  'archived',
];

export const DISPOSITION_LABELS = {
  new: 'New',
  reviewing: 'Reviewing',
  qualified: 'Qualified',
  follow_up: 'Follow-up',
  not_relevant: 'Not relevant',
  archived: 'Archived',
};

const MAX_PAGE = 50;
const DEFAULT_PAGE = 25;

/** Honest coverage for the LO residential builder/developer pilot. */
export function getDiscoveryCoverage() {
  ensureSourceRegistrySeeded();
  const fairfax = getSource('fairfax_county_building_records_plus');
  const adapter = getAdapter('fairfax_plus');
  const sources = [
    {
      jurisdiction_code: 'fairfax_county',
      label: JURISDICTIONS.fairfax_county.label,
      status: 'supported',
      adapter_type: 'fairfax_plus',
      source_key: 'fairfax_county_building_records_plus',
      activated: Boolean(fairfax?.activated),
      record_types: ['building_records_plus_issued'],
      date_fields: ['ISSUED_DATE', 'SUBMITTED_DATE', 'APPROVED_DATE', 'RECORD_STATUS_DATE'],
      filters: ['issued_from', 'issued_to', 'app_type_alias', 'record_status', 'address_contains'],
      capabilities: adapter?.capabilities || {},
      limitations: [
        'Issued-heavy Building Records PLUS layer — not an applications/pending queue.',
        'Pending reviews, holds, comments, and inspections are unavailable on this layer.',
        'No applicant / company / role fields on this public layer — role/company evidence is absent unless later linked manually.',
        'City of Fairfax is a separate unsupported AHJ.',
        'This feed is not early-intent LO signal; do not relabel issued activity as early intent.',
        'Loudoun, Prince William, and West Virginia discovery are unsupported in this pilot.',
      ],
      intent_fit:
        'Useful for residential builder/developer relationship prospecting after permits appear on the issued-heavy layer. Not suitable for pre-application early-intent prospecting.',
    },
    {
      jurisdiction_code: 'loudoun_county',
      label: JURISDICTIONS.loudoun_county.label,
      status: 'unsupported',
      limitations: [JURISDICTIONS.loudoun_county.notes],
    },
    {
      jurisdiction_code: 'prince_william_county',
      label: JURISDICTIONS.prince_william_county.label,
      status: 'unsupported',
      limitations: [JURISDICTIONS.prince_william_county.notes],
    },
    {
      jurisdiction_code: 'west_virginia',
      label: JURISDICTIONS.west_virginia.label,
      status: 'unsupported',
      limitations: [JURISDICTIONS.west_virginia.notes],
    },
    {
      jurisdiction_code: 'city_of_fairfax',
      label: JURISDICTIONS.city_of_fairfax.label,
      status: 'unsupported',
      limitations: [JURISDICTIONS.city_of_fairfax.notes],
    },
  ];
  return {
    pilot_profile: 'residential_builder_developer_relationship_nova',
    geography: 'Fairfax County, VA (live). Other NoVA / WV AHJs unsupported for discovery.',
    separation: {
      imported_search: 'Permits tab q/filters only narrow saved workbook rows.',
      known_id_check: 'Run Fairfax checks re-queries RECORDID for imported IDs only.',
      discovery: 'Opportunities browse queries the public PLUS layer without requiring imports.',
    },
    result_statuses: ['ok', 'zero', 'partial', 'unsupported', 'failed'],
    dispositions: OPPORTUNITY_DISPOSITIONS.map((d) => ({
      value: d,
      label: DISPOSITION_LABELS[d],
    })),
    match_rules: MATCH_RULES,
    sources,
    shown_before_search: true,
  };
}

/** Transparent, deterministic match rules (not AI scores). */
export const MATCH_RULES = [
  {
    id: 'jurisdiction_fairfax_county',
    label: 'Jurisdiction is Fairfax County PLUS layer',
    description: 'Only Fairfax County Building Records PLUS is queried for live discovery.',
  },
  {
    id: 'issued_date_window',
    label: 'ISSUED_DATE within selected window',
    description: 'ArcGIS DATE literals on ISSUED_DATE when issued_from / issued_to are set.',
  },
  {
    id: 'app_type_alias_contains',
    label: 'APPTYPEALIAS contains filter text',
    description: 'Official type string (e.g. Residential). Not the internal use-classification enum.',
  },
  {
    id: 'record_status_equals',
    label: 'RECORD_STATUS equals filter',
    description: 'Exact status string match when provided.',
  },
  {
    id: 'address_contains',
    label: 'ADDRESS_1 contains filter text',
    description: 'Case-insensitive substring on ADDRESS_1.',
  },
  {
    id: 'no_protected_trait_inference',
    label: 'No protected-trait or creditworthiness inference',
    description: 'Rules never score people, protected classes, or creditworthiness.',
  },
];

function clampPageSize(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_PAGE;
  return Math.min(MAX_PAGE, Math.floor(v));
}

function isoDateOrNull(v) {
  if (v == null || String(v).trim() === '') return null;
  const s = String(v).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

function buildMatchReasons(criteria, attrs) {
  const reasons = [];
  reasons.push({
    rule: 'jurisdiction_fairfax_county',
    detail: 'Returned from Fairfax County Building Records PLUS',
  });
  if (criteria.issued_from || criteria.issued_to) {
    reasons.push({
      rule: 'issued_date_window',
      detail: `ISSUED_DATE ${attrs.issuedDate || '∅'} in window ${criteria.issued_from || '…'} → ${criteria.issued_to || '…'}`,
    });
  }
  if (criteria.app_type_alias) {
    reasons.push({
      rule: 'app_type_alias_contains',
      detail: `APPTYPEALIAS "${attrs.permitType || ''}" matches "${criteria.app_type_alias}"`,
    });
  }
  if (criteria.record_status) {
    reasons.push({
      rule: 'record_status_equals',
      detail: `RECORD_STATUS "${attrs.sourceNativeStatus || ''}" equals filter`,
    });
  }
  if (criteria.address_contains) {
    reasons.push({
      rule: 'address_contains',
      detail: `ADDRESS_1 "${attrs.address || ''}" contains "${criteria.address_contains}"`,
    });
  }
  return reasons;
}

function rowLimitations() {
  return [
    'Issued-heavy source — not early-intent application signal.',
    'Company/role fields unavailable on this public layer.',
    'Pending/holds/inspections unavailable.',
  ];
}

/**
 * Discover public activity. Blank workspace OK — does not require imports.
 * @returns {{ status, results, coverage, criteria, page, error? }}
 */
export async function searchOpportunities(rawCriteria = {}, { fetchImpl } = {}) {
  const coverage = getDiscoveryCoverage();
  const jurisdiction = String(rawCriteria.jurisdiction_code || 'fairfax_county').trim();

  if (jurisdiction !== 'fairfax_county') {
    const src = coverage.sources.find((s) => s.jurisdiction_code === jurisdiction);
    return {
      status: 'unsupported',
      results: [],
      coverage,
      criteria: { ...rawCriteria, jurisdiction_code: jurisdiction },
      page: { offset: 0, limit: 0, limitRequested: 0 },
      message:
        src?.limitations?.[0] ||
        `Discovery unsupported for jurisdiction ${jurisdiction}. Fairfax County is the only live discovery source in this pilot.`,
    };
  }

  const criteria = {
    jurisdiction_code: 'fairfax_county',
    issued_from: isoDateOrNull(rawCriteria.issued_from),
    issued_to: isoDateOrNull(rawCriteria.issued_to),
    app_type_alias: String(rawCriteria.app_type_alias || '').trim() || null,
    record_status: String(rawCriteria.record_status || '').trim() || null,
    address_contains: String(rawCriteria.address_contains || '').trim() || null,
    result_offset: Math.max(0, Number(rawCriteria.result_offset) || 0),
    result_record_count: clampPageSize(rawCriteria.result_record_count),
  };

  if (!criteria.issued_from && !criteria.issued_to && !criteria.app_type_alias && !criteria.address_contains) {
    // Require at least one narrowing filter to avoid dumping the whole county.
    return {
      status: 'failed',
      results: [],
      coverage,
      criteria,
      page: { offset: 0, limit: 0, limitRequested: criteria.result_record_count },
      error: 'criteria_required',
      message:
        'Set at least one of issued date window, building-use (APPTYPEALIAS), or address contains before searching. Countywide dump is not allowed.',
    };
  }

  const browse = await discoverFairfaxPermits({
    issuedFrom: criteria.issued_from,
    issuedTo: criteria.issued_to,
    appTypeAlias: criteria.app_type_alias,
    recordStatus: criteria.record_status,
    addressContains: criteria.address_contains,
    resultOffset: criteria.result_offset,
    resultRecordCount: criteria.result_record_count,
    fetchImpl,
  });

  if (browse.outcome === 'unavailable' || browse.outcome === 'failed') {
    return {
      status: 'failed',
      results: [],
      coverage,
      criteria,
      page: {
        offset: criteria.result_offset,
        limit: criteria.result_record_count,
        limitRequested: criteria.result_record_count,
      },
      error: browse.error || browse.outcome,
      message: browse.error || 'Fairfax discovery request failed',
    };
  }

  const existing = new Set(
    db
      .prepare(
        `SELECT official_id FROM opportunities WHERE jurisdiction_code = 'fairfax_county'`
      )
      .all()
      .map((r) => String(r.official_id).toUpperCase())
  );

  const results = (browse.features || []).map((f) => {
    const attrs = {
      officialId: f.officialId,
      permitType: f.permitType || '',
      sourceNativeStatus: f.sourceNativeStatus || '',
      officialStatus: f.officialStatus || '',
      address: f.address || '',
      city: f.city || '',
      state: f.state || '',
      zip: f.zip || '',
      parcel: f.parcel || '',
      issuedDate: f.issuedDate,
      submittedDate: f.submittedDate,
      approvedDate: f.approvedDate,
      sourceEventAt: f.sourceEventAt,
      sourceUrl: f.sourceUrl || '',
      companyEvidence: null,
      roleEvidence: null,
    };
    return {
      ...attrs,
      activity_summary: summarizeActivity(attrs),
      match_reasons: buildMatchReasons(criteria, attrs),
      limitations: rowLimitations(),
      already_saved: existing.has(String(attrs.officialId).toUpperCase()),
      intent_label: 'issued_activity',
      intent_note:
        'Issued-layer activity suitable for builder/developer relationship follow-up — not early-intent application signal.',
    };
  });

  let status = 'ok';
  if (results.length === 0) status = 'zero';
  else if (browse.truncated || results.length >= criteria.result_record_count) status = 'partial';

  return {
    status,
    results,
    coverage,
    criteria,
    page: {
      offset: criteria.result_offset,
      limit: results.length,
      limitRequested: criteria.result_record_count,
      truncated: Boolean(browse.truncated),
      exceededTransferLimit: Boolean(browse.exceededTransferLimit),
    },
    observed_at: browse.observedAt,
    message:
      status === 'zero'
        ? 'No Fairfax PLUS records matched these filters in the requested page.'
        : status === 'partial'
          ? `Showing up to ${criteria.result_record_count} matches (page capped). Narrow filters or page forward for more.`
          : `Found ${results.length} public Fairfax activity record(s).`,
  };
}

function summarizeActivity(attrs) {
  const bits = [];
  if (attrs.permitType) bits.push(attrs.permitType);
  if (attrs.sourceNativeStatus) bits.push(attrs.sourceNativeStatus);
  if (attrs.issuedDate) bits.push(`issued ${attrs.issuedDate}`);
  else if (attrs.approvedDate) bits.push(`approved ${attrs.approvedDate}`);
  if (attrs.address) bits.push(attrs.address);
  return bits.join(' · ') || attrs.officialId || 'Fairfax permit activity';
}

export function dedupeKeyFor(jurisdictionCode, officialId) {
  return `${jurisdictionCode}|${String(officialId || '')
    .trim()
    .toUpperCase()}`;
}

/**
 * Save discovery hits into the private opportunity pipeline (dedupe by official ID).
 * Does not create permit_records or lots.
 */
export function saveOpportunities(candidates = [], { actor = '', searchId = null } = {}) {
  const insert = db.prepare(
    `INSERT INTO opportunities(
       source_key, jurisdiction_code, official_id, activity_summary, permit_type,
       official_status, source_native_status, address, city, state, zip, parcel,
       company_evidence, role_evidence, issued_date, submitted_date, approved_date,
       source_event_at, source_url, match_reasons_json, limitations_json, evidence_json,
       disposition, search_id, dedupe_key, record_origin, created_by, updated_at
     ) VALUES (
       'fairfax_county_building_records_plus', ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       'new', ?, ?, 'discovery', ?, datetime('now')
     )
     ON CONFLICT(dedupe_key) DO UPDATE SET
       activity_summary = excluded.activity_summary,
       permit_type = excluded.permit_type,
       official_status = excluded.official_status,
       source_native_status = excluded.source_native_status,
       address = excluded.address,
       city = excluded.city,
       state = excluded.state,
       zip = excluded.zip,
       parcel = excluded.parcel,
       issued_date = excluded.issued_date,
       submitted_date = excluded.submitted_date,
       approved_date = excluded.approved_date,
       source_event_at = excluded.source_event_at,
       source_url = excluded.source_url,
       match_reasons_json = excluded.match_reasons_json,
       limitations_json = excluded.limitations_json,
       evidence_json = excluded.evidence_json,
       search_id = COALESCE(excluded.search_id, opportunities.search_id),
       updated_at = datetime('now')`
  );

  const saved = [];
  const deduped = [];
  const tx = db.transaction((rows) => {
    for (const c of rows) {
      const officialId = String(c.officialId || c.official_id || '').trim();
      if (!officialId) continue;
      const jurisdiction = String(c.jurisdiction_code || 'fairfax_county');
      const key = dedupeKeyFor(jurisdiction, officialId);
      const before = db.prepare('SELECT id FROM opportunities WHERE dedupe_key = ?').get(key);
      const attrs = {
        officialId,
        permitType: c.permitType || c.permit_type || '',
        sourceNativeStatus: c.sourceNativeStatus || c.source_native_status || '',
        officialStatus: c.officialStatus || c.official_status || '',
        address: c.address || '',
        city: c.city || '',
        state: c.state || '',
        zip: c.zip || '',
        parcel: c.parcel || '',
        issuedDate: c.issuedDate || c.issued_date || null,
        submittedDate: c.submittedDate || c.submitted_date || null,
        approvedDate: c.approvedDate || c.approved_date || null,
        sourceEventAt: c.sourceEventAt || c.source_event_at || null,
        sourceUrl: c.sourceUrl || c.source_url || '',
      };
      insert.run(
        jurisdiction,
        officialId,
        c.activity_summary || summarizeActivity(attrs),
        attrs.permitType,
        attrs.officialStatus,
        attrs.sourceNativeStatus,
        attrs.address,
        attrs.city,
        attrs.state,
        attrs.zip,
        attrs.parcel,
        c.companyEvidence || c.company_evidence || '',
        c.roleEvidence || c.role_evidence || '',
        attrs.issuedDate,
        attrs.submittedDate,
        attrs.approvedDate,
        attrs.sourceEventAt,
        attrs.sourceUrl,
        JSON.stringify(c.match_reasons || c.match_reasons_json || []),
        JSON.stringify(c.limitations || c.limitations_json || rowLimitations()),
        JSON.stringify(c.evidence || c.evidence_json || attrs),
        searchId,
        key,
        actor || ''
      );
      const row = db.prepare('SELECT * FROM opportunities WHERE dedupe_key = ?').get(key);
      if (before) deduped.push(hydrateOpportunity(row));
      else saved.push(hydrateOpportunity(row));
    }
  });
  tx(candidates);
  return { saved, deduped, total: saved.length + deduped.length };
}

export function listOpportunities({ disposition = null, q = '', groupId = null } = {}) {
  const clauses = [`record_origin = 'discovery'`];
  const params = [];
  if (disposition) {
    clauses.push('disposition = ?');
    params.push(disposition);
  }
  if (groupId != null && groupId !== '') {
    clauses.push('group_id = ?');
    params.push(Number(groupId));
  }
  if (q) {
    clauses.push(
      `(official_id LIKE ? OR address LIKE ? OR activity_summary LIKE ? OR assignee LIKE ? OR permit_type LIKE ?)`
    );
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  const rows = db
    .prepare(
      `SELECT * FROM opportunities WHERE ${clauses.join(' AND ')}
       ORDER BY updated_at DESC, id DESC LIMIT 500`
    )
    .all(...params);
  return rows.map(hydrateOpportunity);
}

export function getOpportunity(id) {
  const row = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(Number(id));
  return row ? hydrateOpportunity(row) : null;
}

function hydrateOpportunity(row) {
  if (!row) return null;
  let match_reasons = [];
  let limitations = [];
  let evidence = {};
  try {
    match_reasons = JSON.parse(row.match_reasons_json || '[]');
  } catch {
    match_reasons = [];
  }
  try {
    limitations = JSON.parse(row.limitations_json || '[]');
  } catch {
    limitations = [];
  }
  try {
    evidence = JSON.parse(row.evidence_json || '{}');
  } catch {
    evidence = {};
  }
  return {
    ...row,
    disposition_label: DISPOSITION_LABELS[row.disposition] || row.disposition,
    match_reasons,
    limitations,
    evidence,
    company_evidence: row.company_evidence || null,
    role_evidence: row.role_evidence || null,
    intent_label: 'issued_activity',
  };
}

export function updateOpportunity(id, patch = {}, { actor = '' } = {}) {
  const row = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(Number(id));
  if (!row) {
    const err = new Error('Opportunity not found');
    err.code = 'not_found';
    throw err;
  }
  const next = { ...row };
  if (patch.disposition != null) {
    const d = String(patch.disposition);
    if (!OPPORTUNITY_DISPOSITIONS.includes(d)) {
      const err = new Error(`Invalid disposition: ${d}`);
      err.code = 'invalid_disposition';
      throw err;
    }
    next.disposition = d;
  }
  for (const field of ['reason', 'assignee', 'next_action']) {
    if (patch[field] != null) next[field] = String(patch[field]);
  }
  if (patch.next_action_due !== undefined) {
    next.next_action_due = isoDateOrNull(patch.next_action_due);
  }
  if (patch.group_id !== undefined) {
    next.group_id = patch.group_id == null || patch.group_id === '' ? null : Number(patch.group_id);
  }

  db.prepare(
    `UPDATE opportunities SET
       disposition = ?, reason = ?, assignee = ?, next_action = ?, next_action_due = ?,
       group_id = ?, updated_at = datetime('now'), updated_by = ?
     WHERE id = ?`
  ).run(
    next.disposition,
    next.reason || '',
    next.assignee || '',
    next.next_action || '',
    next.next_action_due,
    next.group_id,
    actor || '',
    Number(id)
  );
  return getOpportunity(id);
}

/**
 * Link opportunity to an existing project permit/lot — never invents a lot.
 */
export function linkOpportunityToProject(opportunityId, { permitRecordId = null, lotGroupId = null } = {}) {
  const opp = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(Number(opportunityId));
  if (!opp) {
    const err = new Error('Opportunity not found');
    err.code = 'not_found';
    throw err;
  }
  let permit = null;
  let lotId = lotGroupId != null ? Number(lotGroupId) : null;
  if (permitRecordId != null) {
    permit = db
      .prepare(`SELECT * FROM permit_records WHERE id = ? AND record_origin = 'import'`)
      .get(Number(permitRecordId));
    if (!permit) {
      const err = new Error('Import permit not found — cannot invent a project link');
      err.code = 'permit_not_found';
      throw err;
    }
    lotId = permit.lot_group_id;
  } else if (lotId != null) {
    const lot = db
      .prepare(`SELECT * FROM lot_groups WHERE id = ? AND record_origin = 'import'`)
      .get(lotId);
    if (!lot) {
      const err = new Error('Import lot group not found — cannot invent a lot');
      err.code = 'lot_not_found';
      throw err;
    }
  } else {
    const err = new Error('Provide permitRecordId or lotGroupId for an existing import project');
    err.code = 'link_target_required';
    throw err;
  }

  db.prepare(
    `UPDATE opportunities SET
       linked_permit_record_id = ?, linked_lot_group_id = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(permit?.id ?? null, lotId, Number(opportunityId));
  return getOpportunity(opportunityId);
}

export function unlinkOpportunityFromProject(opportunityId) {
  db.prepare(
    `UPDATE opportunities SET
       linked_permit_record_id = NULL, linked_lot_group_id = NULL, updated_at = datetime('now')
     WHERE id = ?`
  ).run(Number(opportunityId));
  return getOpportunity(opportunityId);
}

/** Saved dynamic search criteria (not a frozen ID list). */
export function saveSearch({ name, criteria, kind = 'dynamic', actor = '' } = {}) {
  if (kind !== 'dynamic' && kind !== 'static_list') {
    const err = new Error('kind must be dynamic or static_list');
    err.code = 'invalid_kind';
    throw err;
  }
  const r = db
    .prepare(
      `INSERT INTO opportunity_searches(name, criteria_json, kind, created_by, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    )
    .run(String(name || 'Untitled search').slice(0, 120), JSON.stringify(criteria || {}), kind, actor);
  return getSearch(Number(r.lastInsertRowid));
}

export function listSearches() {
  return db
    .prepare(`SELECT * FROM opportunity_searches ORDER BY updated_at DESC, id DESC LIMIT 100`)
    .all()
    .map(hydrateSearch);
}

export function getSearch(id) {
  const row = db.prepare('SELECT * FROM opportunity_searches WHERE id = ?').get(Number(id));
  return row ? hydrateSearch(row) : null;
}

function hydrateSearch(row) {
  let criteria = {};
  try {
    criteria = JSON.parse(row.criteria_json || '{}');
  } catch {
    criteria = {};
  }
  return { ...row, criteria };
}

export function markSearchReviewed(id) {
  const at = new Date().toISOString();
  db.prepare(
    `UPDATE opportunity_searches SET last_reviewed_at = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(at, Number(id));
  return getSearch(id);
}

/**
 * Re-run a saved dynamic search and annotate "new since last review".
 */
export async function runSavedSearch(id, { fetchImpl } = {}) {
  const search = getSearch(id);
  if (!search) {
    const err = new Error('Saved search not found');
    err.code = 'not_found';
    throw err;
  }
  if (search.kind === 'static_list') {
    const ids = Array.isArray(search.criteria.official_ids) ? search.criteria.official_ids : [];
    const rows = listOpportunities({}).filter((o) =>
      ids.map((x) => String(x).toUpperCase()).includes(String(o.official_id).toUpperCase())
    );
    return {
      search,
      status: rows.length ? 'ok' : 'zero',
      results: rows.map((r) => ({
        ...r,
        new_since_last_review: Boolean(
          search.last_reviewed_at && r.updated_at && r.updated_at > search.last_reviewed_at
        ),
      })),
      message: 'Static selected list — not a live GIS re-query.',
    };
  }
  const live = await searchOpportunities(search.criteria, { fetchImpl });
  const watermark = search.last_reviewed_at;
  const results = (live.results || []).map((r) => {
    const issued = r.issuedDate || r.sourceEventAt || null;
    const newSince = Boolean(
      watermark && issued && String(issued).slice(0, 10) > String(watermark).slice(0, 10)
    );
    return { ...r, new_since_last_review: newSince };
  });
  return { ...live, search, results };
}

/**
 * Group related opportunities when evidence allows (parcel or normalized address).
 * Creates reversible proposed links; human can mark reviewed or unlink.
 */
export function proposeGroups({ opportunityIds = [] } = {}) {
  const ids = opportunityIds.map(Number).filter((n) => Number.isFinite(n));
  const rows =
    ids.length > 0
      ? db
          .prepare(
            `SELECT * FROM opportunities WHERE id IN (${ids.map(() => '?').join(',')})`
          )
          .all(...ids)
      : db
          .prepare(
            `SELECT * FROM opportunities WHERE disposition NOT IN ('archived','not_relevant') LIMIT 200`
          )
          .all();

  const buckets = new Map();
  for (const row of rows) {
    const key = groupEvidenceKey(row);
    if (!key) continue;
    if (!buckets.has(key.value)) buckets.set(key.value, { evidence: key, members: [] });
    buckets.get(key.value).members.push(row);
  }

  const created = [];
  const tx = db.transaction(() => {
    for (const [, bucket] of buckets) {
      if (bucket.members.length < 2) continue;
      const label =
        bucket.evidence.kind === 'parcel'
          ? `Parcel ${bucket.evidence.raw}`
          : `Address ${bucket.evidence.raw}`;
      const g = db
        .prepare(
          `INSERT INTO opportunity_groups(label, group_kind, evidence_json, link_status, disposition)
           VALUES (?, 'company_or_project', ?, 'proposed', 'new')`
        )
        .run(label, JSON.stringify(bucket.evidence));
      const groupId = Number(g.lastInsertRowid);
      for (const m of bucket.members) {
        db.prepare(
          `UPDATE opportunities SET group_id = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(groupId, m.id);
      }
      created.push(getGroup(groupId));
    }
  });
  tx();
  return { groups: created, skipped_singletons: rows.length - created.reduce((n, g) => n + g.member_count, 0) };
}

function groupEvidenceKey(row) {
  const parcel = String(row.parcel || '').trim().toUpperCase();
  if (parcel && parcel.length >= 4) {
    return { kind: 'parcel', value: `parcel:${parcel}`, raw: parcel, rule: 'same_parcel_id' };
  }
  const addr = String(row.address || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
  if (addr && addr.length >= 8) {
    // Street number + first street token — reversible proposal only.
    const m = addr.match(/^(\d+)\s+([A-Z0-9]+)/);
    if (m) {
      const value = `addr:${m[1]} ${m[2]}`;
      return { kind: 'address_stem', value, raw: `${m[1]} ${m[2]}`, rule: 'same_address_stem' };
    }
  }
  return null;
}

export function listGroups() {
  return db
    .prepare(`SELECT * FROM opportunity_groups ORDER BY updated_at DESC, id DESC LIMIT 200`)
    .all()
    .map((g) => getGroup(g.id));
}

export function getGroup(id) {
  const g = db.prepare('SELECT * FROM opportunity_groups WHERE id = ?').get(Number(id));
  if (!g) return null;
  let evidence = {};
  try {
    evidence = JSON.parse(g.evidence_json || '{}');
  } catch {
    evidence = {};
  }
  const members = db
    .prepare(`SELECT * FROM opportunities WHERE group_id = ? ORDER BY id`)
    .all(Number(id))
    .map(hydrateOpportunity);
  return { ...g, evidence, members, member_count: members.length };
}

export function reviewGroupLink(id, { status = 'reviewed' } = {}) {
  if (!['proposed', 'reviewed', 'unlinked'].includes(status)) {
    const err = new Error('link status must be proposed|reviewed|unlinked');
    err.code = 'invalid_link_status';
    throw err;
  }
  if (status === 'unlinked') {
    db.prepare(`UPDATE opportunities SET group_id = NULL, updated_at = datetime('now') WHERE group_id = ?`).run(
      Number(id)
    );
    db.prepare(
      `UPDATE opportunity_groups SET link_status = 'unlinked', updated_at = datetime('now') WHERE id = ?`
    ).run(Number(id));
  } else {
    db.prepare(
      `UPDATE opportunity_groups SET link_status = ?, reviewed_link = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(status, status === 'reviewed' ? 1 : 0, Number(id));
  }
  return getGroup(id);
}

export function updateGroup(id, patch = {}) {
  const g = db.prepare('SELECT * FROM opportunity_groups WHERE id = ?').get(Number(id));
  if (!g) {
    const err = new Error('Group not found');
    err.code = 'not_found';
    throw err;
  }
  const disposition = patch.disposition != null ? String(patch.disposition) : g.disposition;
  if (patch.disposition != null && !OPPORTUNITY_DISPOSITIONS.includes(disposition)) {
    const err = new Error(`Invalid disposition: ${disposition}`);
    err.code = 'invalid_disposition';
    throw err;
  }
  db.prepare(
    `UPDATE opportunity_groups SET
       disposition = ?, reason = ?, assignee = ?, next_action = ?, next_action_due = ?,
       label = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    disposition,
    patch.reason != null ? String(patch.reason) : g.reason,
    patch.assignee != null ? String(patch.assignee) : g.assignee,
    patch.next_action != null ? String(patch.next_action) : g.next_action,
    patch.next_action_due !== undefined ? isoDateOrNull(patch.next_action_due) : g.next_action_due,
    patch.label != null ? String(patch.label) : g.label,
    Number(id)
  );
  return getGroup(id);
}

export function exportOpportunitiesXlsx({ ids = null } = {}) {
  let rows;
  if (ids?.length) {
    rows = db
      .prepare(
        `SELECT * FROM opportunities WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`
      )
      .all(...ids.map(Number));
  } else {
    rows = db
      .prepare(`SELECT * FROM opportunities WHERE disposition != 'archived' ORDER BY id LIMIT 1000`)
      .all();
  }
  const headers = [
    'id',
    'official_id',
    'jurisdiction_code',
    'disposition',
    'activity_summary',
    'permit_type',
    'official_status',
    'address',
    'city',
    'parcel',
    'issued_date',
    'assignee',
    'reason',
    'next_action',
    'next_action_due',
    'group_id',
    'linked_permit_record_id',
    'linked_lot_group_id',
    'company_evidence',
    'role_evidence',
    'intent_label',
    'source_url',
    'match_reasons',
    'limitations',
  ];
  const data = rows.map((r) => {
    const h = hydrateOpportunity(r);
    return {
      id: h.id,
      official_id: h.official_id,
      jurisdiction_code: h.jurisdiction_code,
      disposition: h.disposition,
      activity_summary: h.activity_summary,
      permit_type: h.permit_type,
      official_status: h.official_status,
      address: h.address,
      city: h.city,
      parcel: h.parcel,
      issued_date: h.issued_date,
      assignee: h.assignee,
      reason: h.reason,
      next_action: h.next_action,
      next_action_due: h.next_action_due,
      group_id: h.group_id,
      linked_permit_record_id: h.linked_permit_record_id,
      linked_lot_group_id: h.linked_lot_group_id,
      company_evidence: h.company_evidence || '',
      role_evidence: h.role_evidence || '',
      intent_label: 'issued_activity',
      source_url: h.source_url,
      match_reasons: (h.match_reasons || []).map((m) => m.rule || m).join('; '),
      limitations: (h.limitations || []).join('; '),
    };
  });
  const sheet = data.length
    ? XLSX.utils.json_to_sheet(data, { header: headers })
    : XLSX.utils.aoa_to_sheet([headers]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'Opportunities');
  const note = XLSX.utils.aoa_to_sheet([
    ['note'],
    [
      'Workspace-private opportunity export. Issued-layer activity — not early-intent. No paid contacts. Not auto-converted to marketing leads.',
    ],
  ]);
  XLSX.utils.book_append_sheet(wb, note, 'Notes');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

export function ensureOpportunityTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS opportunity_searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      criteria_json TEXT NOT NULL DEFAULT '{}',
      kind TEXT NOT NULL DEFAULT 'dynamic',
      last_reviewed_at TEXT,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS opportunity_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL DEFAULT '',
      group_kind TEXT NOT NULL DEFAULT 'company_or_project',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      disposition TEXT NOT NULL DEFAULT 'new',
      reason TEXT NOT NULL DEFAULT '',
      assignee TEXT NOT NULL DEFAULT '',
      next_action TEXT NOT NULL DEFAULT '',
      next_action_due TEXT,
      reviewed_link INTEGER NOT NULL DEFAULT 0,
      link_status TEXT NOT NULL DEFAULT 'proposed',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS opportunities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_key TEXT NOT NULL DEFAULT 'fairfax_county_building_records_plus',
      jurisdiction_code TEXT NOT NULL DEFAULT 'fairfax_county',
      official_id TEXT NOT NULL,
      activity_summary TEXT NOT NULL DEFAULT '',
      permit_type TEXT NOT NULL DEFAULT '',
      official_status TEXT NOT NULL DEFAULT '',
      source_native_status TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT '',
      zip TEXT NOT NULL DEFAULT '',
      parcel TEXT NOT NULL DEFAULT '',
      company_evidence TEXT NOT NULL DEFAULT '',
      role_evidence TEXT NOT NULL DEFAULT '',
      issued_date TEXT,
      submitted_date TEXT,
      approved_date TEXT,
      source_event_at TEXT,
      source_url TEXT NOT NULL DEFAULT '',
      match_reasons_json TEXT NOT NULL DEFAULT '[]',
      limitations_json TEXT NOT NULL DEFAULT '[]',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      disposition TEXT NOT NULL DEFAULT 'new',
      reason TEXT NOT NULL DEFAULT '',
      assignee TEXT NOT NULL DEFAULT '',
      next_action TEXT NOT NULL DEFAULT '',
      next_action_due TEXT,
      group_id INTEGER REFERENCES opportunity_groups(id) ON DELETE SET NULL,
      linked_permit_record_id INTEGER REFERENCES permit_records(id) ON DELETE SET NULL,
      linked_lot_group_id INTEGER REFERENCES lot_groups(id) ON DELETE SET NULL,
      search_id INTEGER REFERENCES opportunity_searches(id) ON DELETE SET NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      record_origin TEXT NOT NULL DEFAULT 'discovery',
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_opp_disposition ON opportunities(disposition)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_opp_group ON opportunities(group_id)`);
}
