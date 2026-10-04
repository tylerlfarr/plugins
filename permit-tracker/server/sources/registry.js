/**
 * Small reusable source registry.
 * States: discovered | needs_review | verified | degraded | unsupported
 */
import { db } from '../db.js';

export const SOURCE_STATES = [
  'discovered',
  'needs_review',
  'verified',
  'degraded',
  'unsupported',
];

/** Seed entries — verified vs speculative clearly separated */
export const SEED_SOURCES = [
  {
    key: 'fairfax_county_building_records_plus',
    jurisdiction_code: 'fairfax_county',
    agency: 'Fairfax County Department of Public Works and Environmental Services / GIS',
    record_types: 'building,alteration,commercial',
    official_url: 'https://www.fairfaxcounty.gov/',
    endpoint:
      'https://services1.arcgis.com/ioennV6PpG5Xodq0/arcgis/rest/services/Building_Records_PLUS/FeatureServer/0',
    platform: 'arcgis_featureserver',
    adapter_type: 'fairfax_plus',
    available_fields_json: JSON.stringify({
      live: [
        'RECORDID',
        'RECORD_STATUS',
        'SUBMITTED_DATE',
        'APPROVED_DATE',
        'ISSUED_DATE',
        'LINK_URL',
      ],
      unavailable: ['pending', 'reviewer_comments', 'holds', 'inspections'],
    }),
    auth_access: 'public_no_auth',
    refresh_frequency: 'near_real_time_gis',
    state: 'verified',
    coverage_limitations:
      'Issued-heavy Building Records PLUS layer; pending/comments/holds/inspections unavailable on this layer. City of Fairfax is separate.',
    evidence:
      'Live RO queries return status + milestone dates for ALTC/ALTR/BLDR (BLDC only with confirmed Fairfax mapping).',
    // Seed metadata only — real verification timestamp set after live check
    last_verified_at: null,
    reusable: 1,
  },
  {
    key: 'pwc_eportal_energov',
    jurisdiction_code: 'prince_william_county',
    agency: 'Prince William County Department of Development Services',
    record_types: 'building,zoning,inspections,plans',
    official_url: 'https://egcss.pwcgov.org/SelfService#/home',
    endpoint: 'https://egcss.pwcgov.org/SelfService',
    platform: 'energov_html_portal',
    adapter_type: 'none',
    available_fields_json: JSON.stringify({
      portal: ['search', 'status', 'inspections', 'documents'],
      machine_readable_api: false,
    }),
    auth_access: 'public_search_html; account_for_apply_pay',
    refresh_frequency: 'unknown',
    state: 'unsupported',
    coverage_limitations:
      'Authoritative for BLD/ZNA/BPR/MST active workflow, but no verified public per-permit status API matching workbook IDs. HTML portal; do not bypass login/CAPTCHA.',
    evidence:
      'ePortal documented at pwcva.gov; GIS EGov/EGov_ePortal MapServer is basemap/parcels only (no permit record layer). Workbook IDs BLD2026-*/ZNA2026-* not present on public Use Permits or Planning Pending Cases layers.',
    last_verified_at: null,
    reusable: 0,
  },
  {
    key: 'pwc_gis_use_permits',
    jurisdiction_code: 'prince_william_county',
    agency: 'Prince William County Planning / GTS',
    record_types: 'zoning_special_use,nonconforming_use',
    official_url: 'https://gisdata-pwcgov.opendata.arcgis.com/datasets/PWCGOV::use-permits',
    endpoint: 'https://gisweb.pwcva.gov/arcgis/rest/services/Planning/Zoning/MapServer/6',
    platform: 'arcgis_mapserver',
    adapter_type: 'arcgis_generic',
    available_fields_json: JSON.stringify({
      fields: [
        'ZoningCaseNumber',
        'UsePermitType',
        'UsePermitStatus',
        'DateApproved',
        'EGOV_CaseID',
      ],
    }),
    auth_access: 'public_no_auth',
    refresh_frequency: 'continual_gis',
    state: 'verified',
    coverage_limitations:
      'Zoning SUP/NCU only (PLN* case numbers). Does NOT cover workbook building/zoning permits BLD*/ZNA*/BPR*/MST*. Not an active building-permit tracker.',
    evidence:
      'RO query returns features with ZoningCaseNumber/UsePermitStatus. Query for ZNA%/BLD% returned zero features.',
    last_verified_at: null,
    reusable: 1,
  },
  {
    key: 'pwc_gis_planning_pending',
    jurisdiction_code: 'prince_william_county',
    agency: 'Prince William County Planning Office',
    record_types: 'planning_cases,rezoning',
    official_url: 'https://gisdata-pwcgov.opendata.arcgis.com/datasets/PWCGOV::planning-pending-cases',
    endpoint: 'https://gisweb.pwcva.gov/arcgis/rest/services/Planning/Land_Development/MapServer/4',
    platform: 'arcgis_mapserver',
    adapter_type: 'arcgis_generic',
    available_fields_json: JSON.stringify({
      fields: ['PlanningCaseNumber', 'PlanningCaseType', 'PlanningCaseName', 'StaffReportLink'],
    }),
    auth_access: 'public_no_auth',
    refresh_frequency: 'continual_gis',
    state: 'discovered',
    coverage_limitations: 'Planning cases (PLN/PFR), not building permits. Candidate for planning ops only.',
    evidence: 'RO sample returned PLN*/PFR* cases with staff report links.',
    last_verified_at: null,
    reusable: 1,
  },
  {
    key: 'loudoun_landmarc_portal',
    jurisdiction_code: 'loudoun_county',
    agency: 'Loudoun County Building & Development / LandMARC',
    record_types: 'building,zoning,plans,inspections',
    official_url: 'https://www.loudoun.gov/landmarc',
    endpoint: 'https://www.loudoun.gov/landmarc',
    platform: 'landmarc_html_portal',
    adapter_type: 'none',
    available_fields_json: JSON.stringify({
      portal: ['public_search', 'status', 'inspections', 'attachments'],
      machine_readable_api: false,
    }),
    auth_access: 'public_search_html; account_for_apply_pay',
    refresh_frequency: 'unknown',
    state: 'unsupported',
    coverage_limitations:
      'Authoritative for active BLDC/ZONC/MASTR workflow. No verified public per-permit API. Public HTML search only; do not bypass controls. Town AHJs may still apply by record type.',
    evidence:
      'LandMARC docs + public search tutorials. Landmarc_GUIDs FeatureServer tables advertise PlanNumber/PlanStatus but all public queries return HTTP 400 — practical blocker.',
    last_verified_at: null,
    reusable: 0,
  },
  {
    key: 'loudoun_res_building_permits_issued',
    jurisdiction_code: 'loudoun_county',
    agency: 'Loudoun County GIS / Planning',
    record_types: 'residential_building_issued_historical',
    official_url: 'https://geohub-loudoungis.opendata.arcgis.com/',
    endpoint: 'https://logis.loudoun.gov/gis/rest/services/Projects/ResBuildingPermits/MapServer/0',
    platform: 'arcgis_mapserver',
    adapter_type: 'arcgis_generic',
    available_fields_json: JSON.stringify({
      fields: ['PERMIT_NUMBER', 'BP_ISSUE_DATE', 'BP_FINAL_DATE', 'STREET_ADDRESS', 'PIN', 'UNIT_TYPE'],
    }),
    auth_access: 'public_no_auth',
    refresh_frequency: 'stale_or_batch',
    state: 'needs_review',
    coverage_limitations:
      'Issued residential only; old LMIS-style permit numbers (B80…), not LandMARC BLDC-YYYY-n. Latest sampled issue dates ~2018–2019. 0 matches for workbook BLDC-2026-* IDs. Not suitable for active workflow tracking.',
    evidence:
      'RO query count=3916; PERMIT_NUMBER LIKE BLDC% → 0; workbook IDs unmatched. Useful as historical issued geography only after ID-scheme mapping research.',
    last_verified_at: null,
    reusable: 1,
  },
  {
    key: 'loudoun_landmarc_guids_table',
    jurisdiction_code: 'loudoun_county',
    agency: 'Loudoun County GIS',
    record_types: 'plans',
    official_url: 'https://logis.loudoun.gov/gis/rest/services/Projects/Landmarc_GUIDs/FeatureServer',
    endpoint: 'https://logis.loudoun.gov/gis/rest/services/Projects/Landmarc_GUIDs/FeatureServer/1',
    platform: 'arcgis_featureserver',
    adapter_type: 'arcgis_generic',
    available_fields_json: JSON.stringify({ fields: ['PlanNumber', 'PlanGuid', 'PlanStatus', 'ESRI_OID'] }),
    auth_access: 'metadata_public_queries_fail',
    refresh_frequency: 'unknown',
    state: 'unsupported',
    coverage_limitations:
      'Metadata lists PlanNumber/PlanStatus but Query operations fail (400). Practical access blocker — not not-yet-investigated.',
    evidence: 'Layer metadata OK; query/count/ids all return Unable to complete operation / Failed to execute query.',
    last_verified_at: null,
    reusable: 1,
  },
  {
    key: 'loudoun_issued_permit_reports',
    jurisdiction_code: 'loudoun_county',
    agency: 'Loudoun County Building & Development',
    record_types: 'building_issued_monthly_reports',
    official_url: 'https://www.loudoun.gov/1164/Issued-Building-Permit-Reports',
    endpoint: 'https://www.loudoun.gov/1164/Issued-Building-Permit-Reports',
    platform: 'official_download_excel_pdf',
    adapter_type: 'none',
    available_fields_json: JSON.stringify({ formats: ['excel', 'pdf'], cadence: 'monthly_halves_since_2023' }),
    auth_access: 'public_download',
    refresh_frequency: 'monthly',
    state: 'discovered',
    coverage_limitations: 'Issued-only historical reports; not active status. Manual/batch import candidate only.',
    evidence: 'County page documents Excel/PDF monthly issued reports; additional detail still in LandMARC.',
    last_verified_at: null,
    reusable: 0,
  },
];

export function ensureSourceRegistrySeeded() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM source_registry').get().c;
  if (count > 0) return count;
  const ins = db.prepare(
    `INSERT INTO source_registry(
       key, jurisdiction_code, agency, record_types, official_url, endpoint, platform, adapter_type,
       available_fields_json, auth_access, refresh_frequency, state, coverage_limitations, evidence,
       last_verified_at, reusable, activated
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  );
  const tx = db.transaction(() => {
    for (const s of SEED_SOURCES) {
      ins.run(
        s.key,
        s.jurisdiction_code,
        s.agency,
        s.record_types,
        s.official_url,
        s.endpoint,
        s.platform,
        s.adapter_type,
        s.available_fields_json,
        s.auth_access,
        s.refresh_frequency,
        s.state,
        s.coverage_limitations,
        s.evidence,
        s.last_verified_at,
        s.reusable
      );
    }
  });
  tx();
  return SEED_SOURCES.length;
}

export function listSources({ jurisdiction_code, state, verifiedOnly } = {}) {
  ensureSourceRegistrySeeded();
  let sql = 'SELECT * FROM source_registry WHERE 1=1';
  const params = [];
  if (jurisdiction_code) {
    sql += ' AND jurisdiction_code = ?';
    params.push(jurisdiction_code);
  }
  if (state) {
    sql += ' AND state = ?';
    params.push(state);
  }
  if (verifiedOnly) {
    sql += " AND state = 'verified'";
  }
  sql += ` ORDER BY CASE state
    WHEN 'verified' THEN 0 WHEN 'degraded' THEN 1 WHEN 'needs_review' THEN 2
    WHEN 'discovered' THEN 3 ELSE 4 END, jurisdiction_code, key`;
  return db.prepare(sql).all(...params);
}

export function getSource(keyOrId) {
  ensureSourceRegistrySeeded();
  return (
    db.prepare('SELECT * FROM source_registry WHERE key = ? OR id = ?').get(String(keyOrId), Number(keyOrId)) ||
    null
  );
}

export function upsertDiscoveryRun({ jurisdiction_code, url, result }) {
  const info = db
    .prepare(
      `INSERT INTO discovery_runs(jurisdiction_code, url, result_json, state)
       VALUES (?, ?, ?, ?)`
    )
    .run(
      jurisdiction_code || null,
      url,
      JSON.stringify(result),
      result.state || 'discovered'
    );
  return Number(info.lastInsertRowid);
}

export function activateSource(key, { reviewedBy = 'operator' } = {}) {
  const src = getSource(key);
  if (!src) throw new Error('Source not found');
  if (src.state !== 'verified' && src.state !== 'degraded') {
    throw new Error(`Source state=${src.state}; only verified/degraded may activate after review`);
  }
  // Metadata ≠ operational connection — require a real adapter
  if (!src.adapter_type || src.adapter_type === 'none') {
    throw new Error('Source has no operational adapter; metadata-only entries cannot activate');
  }
  db.prepare(
    `UPDATE source_registry SET activated = 1, activated_at = datetime('now'), activated_by = ? WHERE id = ?`
  ).run(reviewedBy, src.id);
  return getSource(src.id);
}

export function setSourceState(key, state, evidenceNote) {
  if (!SOURCE_STATES.includes(state)) throw new Error(`Invalid state ${state}`);
  const src = getSource(key);
  if (!src) throw new Error('Source not found');
  db.prepare(
    `UPDATE source_registry SET state = ?, evidence = COALESCE(?, evidence), last_verified_at = datetime('now'),
     activated = CASE WHEN ? IN ('verified','degraded') THEN activated ELSE 0 END
     WHERE id = ?`
  ).run(state, evidenceNote || null, state, src.id);
  return getSource(src.id);
}
