/**
 * Phase 7 — Coordinated project + opportunity handoff packages.
 * Counts + preview; sensitive columns off by default.
 */
import XLSX from 'xlsx';
import { db } from './db.js';
import { buildPermitFilterClause, normalizePermitFilters } from './permitFilters.js';
import { getStoredAssessment, assessPermitReadiness } from './readiness.js';
import { listOpportunities, getOpportunity } from './opportunities.js';
import { listSources } from './sources/registry.js';

const SENSITIVE_PROJECT_COLS = Object.freeze([
  'notes_raw',
  'contact_email',
  'contact_phone',
  'contact_mailing',
  'contact_full_name',
]);

const SENSITIVE_OPP_COLS = Object.freeze([
  'contact_email',
  'contact_phone',
  'contact_full_name',
  'company_evidence_raw',
]);

function sheetFromRows(rows, headers) {
  if (!rows.length) return XLSX.utils.aoa_to_sheet([headers]);
  return XLSX.utils.json_to_sheet(rows, { header: headers });
}

function parseJson(raw, fallback) {
  try {
    return JSON.parse(raw || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

/**
 * Project coordination handoff rows: blockers / evidence / owner / action / due.
 */
export function buildProjectHandoffRows({
  filters = {},
  selectedIds = null,
  includeSensitive = false,
  limit = 500,
} = {}) {
  const f = normalizePermitFilters(filters);
  const selected =
    selectedIds == null
      ? null
      : Array.isArray(selectedIds)
        ? selectedIds.map(Number).filter((n) => Number.isFinite(n) && n > 0)
        : String(selectedIds)
            .split(',')
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isFinite(n));

  const { sql: filterSql, params } = buildPermitFilterClause(f, {
    selectedIds: selected,
    selectedOnly: Boolean(selected?.length),
  });

  const permits = db
    .prepare(
      `SELECT
         p.id AS permit_record_id,
         p.primary_official_id,
         p.jurisdiction_code,
         p.readiness_state,
         p.official_status,
         p.internal_status,
         p.owner,
         p.next_action,
         p.next_action_due,
         p.source_url,
         p.last_check_outcome,
         p.last_successful_check_at,
         lg.lot_label,
         lg.notes_raw,
         cs.project_code,
         cs.community_name,
         ra.summary AS readiness_summary,
         ra.outstanding_json,
         ra.gaps_json
       FROM permit_records p
       JOIN lot_groups lg ON lg.id = p.lot_group_id
       JOIN community_sections cs ON cs.id = lg.section_id
       LEFT JOIN readiness_assessments ra ON ra.permit_record_id = p.id
       WHERE 1=1${filterSql}
       ORDER BY
         CASE WHEN p.next_action_due IS NULL THEN 1 ELSE 0 END,
         p.next_action_due ASC,
         cs.community_name, lg.lot_label
       LIMIT ?`
    )
    .all(...params, Math.min(Number(limit) || 500, 2000));

  const contactStmt = db.prepare(
    `SELECT full_name, email, phone, mailing_address, role, status
     FROM contacts
     WHERE permit_record_id = ? AND status IN ('confirmed','candidate')
       AND record_origin NOT IN ('sandbox_demo','local_fixture')
     ORDER BY CASE status WHEN 'confirmed' THEN 0 ELSE 1 END, id
     LIMIT 1`
  );

  const rows = permits.map((p) => {
    const outstanding = parseJson(p.outstanding_json, []);
    const gaps = parseJson(p.gaps_json, []);
    const blockers = [
      ...outstanding.map((o) => o.label || o.id || 'outstanding'),
      ...gaps.map((g) => `gap:${g.label || g.id || 'unknown'}`),
    ].join('; ');

    // Fresh assessment if stored missing
    let readinessState = p.readiness_state || 'unknown';
    if (!p.readiness_summary) {
      const a = assessPermitReadiness(p.permit_record_id) || getStoredAssessment(p.permit_record_id);
      if (a) readinessState = a.state || readinessState;
    }

    const evidenceBits = [
      p.primary_official_id ? `id:${p.primary_official_id}` : 'id:unknown',
      p.official_status ? `official:${p.official_status}` : null,
      p.last_check_outcome ? `check:${p.last_check_outcome}` : null,
      p.last_successful_check_at ? `checked:${p.last_successful_check_at}` : null,
      p.source_url ? `source:${p.source_url}` : null,
    ].filter(Boolean);

    const contact = includeSensitive ? contactStmt.get(p.permit_record_id) : null;

    const row = {
      permit_record_id: p.permit_record_id,
      project_code: p.project_code,
      community_name: p.community_name,
      lot_label: p.lot_label,
      jurisdiction_code: p.jurisdiction_code,
      primary_official_id: p.primary_official_id || '',
      readiness_state: readinessState,
      blockers: blockers || '(none listed in evidence)',
      evidence: evidenceBits.join(' · '),
      owner: p.owner || '',
      next_action: p.next_action || '',
      next_action_due: p.next_action_due || '',
      internal_status: p.internal_status || '',
      source_url: p.source_url || '',
      disclaimer: 'Coordination handoff — not lending approval; not source verification',
    };

    if (includeSensitive) {
      row.notes_raw = p.notes_raw || '';
      row.contact_full_name = contact?.full_name || '';
      row.contact_email = contact?.email || '';
      row.contact_phone = contact?.phone || '';
      row.contact_mailing = contact?.mailing_address || '';
    }

    return row;
  });

  const withBlockers = rows.filter(
    (r) => r.blockers && !String(r.blockers).startsWith('(none')
  ).length;
  const withDue = rows.filter((r) => r.next_action_due).length;
  const withOwner = rows.filter((r) => r.owner).length;

  return {
    kind: 'project_handoff',
    count: rows.length,
    previewLimit: 10,
    preview: rows.slice(0, 10),
    counts: {
      total: rows.length,
      withBlockers,
      withDue,
      withOwner,
      blocked: rows.filter((r) => r.readiness_state === 'blocked').length,
      needsVerification: rows.filter((r) => r.readiness_state === 'needs_verification').length,
    },
    includeSensitive: Boolean(includeSensitive),
    sensitiveColumns: includeSensitive ? [...SENSITIVE_PROJECT_COLS] : [],
    sensitiveColumnsOmitted: includeSensitive ? [] : [...SENSITIVE_PROJECT_COLS],
    rows,
    note: 'Project coordination handoff. Sensitive columns off by default. Not a marketing lead list.',
  };
}

export function exportProjectHandoffXlsx(opts = {}) {
  const built = buildProjectHandoffRows(opts);
  const headers = [
    'permit_record_id',
    'project_code',
    'community_name',
    'lot_label',
    'jurisdiction_code',
    'primary_official_id',
    'readiness_state',
    'blockers',
    'evidence',
    'owner',
    'next_action',
    'next_action_due',
    'internal_status',
    'source_url',
    'disclaimer',
    ...(built.includeSensitive ? SENSITIVE_PROJECT_COLS : []),
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheetFromRows(built.rows, headers), 'Project Handoff');
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['field', 'value'],
      ['kind', 'project_handoff'],
      ['count', built.count],
      ['includeSensitive', String(built.includeSensitive)],
      ['note', built.note],
      [
        'disclaimer',
        'Operational coordination only. Workflow completeness is not lending approval or official verification.',
      ],
    ]),
    'Notes'
  );
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), meta: built };
}

/**
 * Opportunity handoff: qualification / role / contact review / source freshness / permitted scope.
 */
export function buildOpportunityHandoffRows({
  ids = null,
  includeSensitive = false,
  limit = 500,
} = {}) {
  let opps;
  if (ids?.length) {
    opps = ids.map((id) => getOpportunity(id)).filter(Boolean);
  } else {
    opps = listOpportunities({}).slice(0, Math.min(Number(limit) || 500, 2000));
  }

  const sourcesByJuris = new Map();
  for (const s of listSources()) {
    const list = sourcesByJuris.get(s.jurisdiction_code) || [];
    list.push(s);
    sourcesByJuris.set(s.jurisdiction_code, list);
  }

  const contactByOpp = db.prepare(
    `SELECT full_name, email, phone, role, sought_role, status, retrieved_at
     FROM contacts WHERE opportunity_id = ? ORDER BY id DESC LIMIT 1`
  );

  const rows = opps.map((o) => {
    const jurisSources = sourcesByJuris.get(o.jurisdiction_code) || [];
    const verified = jurisSources.find((s) => s.state === 'verified');
    const freshness = verified?.last_verified_at || o.updated_at || o.created_at || '';
    const contact = includeSensitive ? contactByOpp.get(o.id) : null;
    const matchReasons = (o.match_reasons || [])
      .map((m) => m.detail || m.rule || m)
      .join('; ');
    const limitations = (o.limitations || []).join('; ');

    const row = {
      opportunity_id: o.id,
      official_id: o.official_id || '',
      jurisdiction_code: o.jurisdiction_code,
      disposition: o.disposition,
      qualification: o.disposition === 'qualified' || o.disposition === 'follow_up' ? o.disposition : 'not_qualified_yet',
      activity_summary: o.activity_summary || '',
      permit_type: o.permit_type || '',
      official_status: o.official_status || '',
      address: o.address || '',
      parcel: o.parcel || '',
      issued_date: o.issued_date || '',
      assignee: o.assignee || '',
      reason: o.reason || '',
      next_action: o.next_action || '',
      next_action_due: o.next_action_due || '',
      role_evidence: o.role_evidence || 'unavailable',
      company_evidence: o.company_evidence || 'unavailable',
      contact_review_status: contact ? contact.status : 'none',
      sought_role: contact?.sought_role || '',
      source_freshness: freshness || 'unknown',
      source_state: verified?.state || jurisSources[0]?.state || 'unknown',
      permitted_scope:
        'Relationship / builder-developer follow-up prep only. Not borrower ID. Not auto marketing lead. Issued-layer activity ≠ early intent.',
      intent_label: 'issued_activity',
      match_reasons: matchReasons,
      limitations,
      source_url: o.source_url || '',
      linked_permit_record_id: o.linked_permit_record_id || '',
      disclaimer: 'Opportunity handoff — not lending approval; contact channels require separate rights',
    };

    if (includeSensitive) {
      row.contact_full_name = contact?.full_name || '';
      row.contact_email = contact?.email || '';
      row.contact_phone = contact?.phone || '';
      row.company_evidence_raw = o.company_evidence || '';
    }

    return row;
  });

  return {
    kind: 'opportunity_handoff',
    count: rows.length,
    previewLimit: 10,
    preview: rows.slice(0, 10),
    counts: {
      total: rows.length,
      qualified: rows.filter((r) => r.disposition === 'qualified').length,
      followUp: rows.filter((r) => r.disposition === 'follow_up').length,
      needsContactReview: rows.filter((r) => r.contact_review_status === 'candidate').length,
      withRoleEvidence: rows.filter((r) => r.role_evidence && r.role_evidence !== 'unavailable').length,
      linkedToProject: rows.filter((r) => r.linked_permit_record_id).length,
    },
    includeSensitive: Boolean(includeSensitive),
    sensitiveColumns: includeSensitive ? [...SENSITIVE_OPP_COLS] : [],
    sensitiveColumnsOmitted: includeSensitive ? [] : [...SENSITIVE_OPP_COLS],
    rows,
    note: 'Opportunity handoff for permitted follow-up prep. Sensitive columns off by default. Paid enrichment still hard-locked.',
  };
}

export function exportOpportunityHandoffXlsx(opts = {}) {
  const built = buildOpportunityHandoffRows(opts);
  const headers = [
    'opportunity_id',
    'official_id',
    'jurisdiction_code',
    'disposition',
    'qualification',
    'activity_summary',
    'permit_type',
    'official_status',
    'address',
    'parcel',
    'issued_date',
    'assignee',
    'reason',
    'next_action',
    'next_action_due',
    'role_evidence',
    'company_evidence',
    'contact_review_status',
    'sought_role',
    'source_freshness',
    'source_state',
    'permitted_scope',
    'intent_label',
    'match_reasons',
    'limitations',
    'source_url',
    'linked_permit_record_id',
    'disclaimer',
    ...(built.includeSensitive ? SENSITIVE_OPP_COLS : []),
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheetFromRows(built.rows, headers), 'Opportunity Handoff');
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['field', 'value'],
      ['kind', 'opportunity_handoff'],
      ['count', built.count],
      ['includeSensitive', String(built.includeSensitive)],
      ['note', built.note],
      [
        'disclaimer',
        'Issued-layer construction activity for relationship prospecting. Not borrower identification. Not early-intent LO signal.',
      ],
    ]),
    'Notes'
  );
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), meta: built };
}

export function inspectHandoffBuffer(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const project = XLSX.utils.sheet_to_json(wb.Sheets['Project Handoff'] || {});
  const opportunity = XLSX.utils.sheet_to_json(wb.Sheets['Opportunity Handoff'] || {});
  return {
    sheetNames: wb.SheetNames,
    projectCount: project.length,
    opportunityCount: opportunity.length,
    projectHeaders: project[0] ? Object.keys(project[0]) : [],
    opportunityHeaders: opportunity[0] ? Object.keys(opportunity[0]) : [],
    projectSample: project.slice(0, 3),
    opportunitySample: opportunity.slice(0, 3),
  };
}
