/**
 * Stable jurisdiction identifiers (snake_case codes).
 * mode=live only when an operational adapter can refresh import records.
 * Unsupported jurisdictions must stay honest — never fabricate live outcomes.
 */
export const JURISDICTIONS = {
  fairfax_county: {
    code: 'fairfax_county',
    label: 'Fairfax County, VA',
    mode: 'live',
    capabilities: {
      applications: false,
      issued: true,
      active_status: true,
      pending: false,
      inspections: false,
    },
    notes:
      'Live Building Records PLUS FeatureServer. Issued-heavy; no pending/comments/holds/inspections fields.',
  },
  loudoun_county: {
    code: 'loudoun_county',
    label: 'Loudoun County, VA',
    mode: 'unsupported',
    capabilities: {
      applications: false,
      issued: false,
      active_status: false,
      pending: false,
      inspections: false,
    },
    notes:
      'UNSUPPORTED for operational sync: LandMARC HTML + issued-only GIS (wrong ID scheme for BLDC-2026-*). Checks return unavailable — not fabricated.',
  },
  prince_william_county: {
    code: 'prince_william_county',
    label: 'Prince William County, VA',
    mode: 'unsupported',
    capabilities: {
      applications: false,
      issued: false,
      active_status: false,
      pending: false,
      inspections: false,
    },
    notes:
      'UNSUPPORTED for workbook BLD/ZNA sync: ePortal HTML; GIS Use Permits are PLN* zoning only. Checks return unavailable.',
  },
  west_virginia: {
    code: 'west_virginia',
    label: 'West Virginia (state / local AHJs)',
    mode: 'unsupported',
    capabilities: {
      applications: false,
      issued: false,
      active_status: false,
      pending: false,
      inspections: false,
    },
    notes:
      'UNSUPPORTED: no verified statewide or pilot-county per-permit connector in this build. Inventory only — do not show as verified.',
  },
  city_of_fairfax: {
    code: 'city_of_fairfax',
    label: 'City of Fairfax, VA',
    mode: 'unsupported',
    capabilities: {
      applications: false,
      issued: false,
      active_status: false,
      pending: false,
      inspections: false,
    },
    notes: 'Distinct from Fairfax County. Accela portal only — unsupported here.',
  },
  city_of_houston: {
    code: 'city_of_houston',
    label: 'City of Houston, TX',
    mode: 'unsupported',
    capabilities: {
      applications: false,
      issued: false,
      active_status: false,
      pending: false,
      inspections: false,
    },
    notes: 'Not in source workbook. Per-permit API not verified.',
  },
  harris_county: {
    code: 'harris_county',
    label: 'Harris County, TX',
    mode: 'unsupported',
    capabilities: {
      applications: false,
      issued: false,
      active_status: false,
      pending: false,
      inspections: false,
    },
    notes: 'Distinct from City of Houston. Unsupported.',
  },
  unresolved: {
    code: 'unresolved',
    label: 'Unresolved jurisdiction',
    mode: 'unsupported',
    capabilities: {
      applications: false,
      issued: false,
      active_status: false,
      pending: false,
      inspections: false,
    },
    notes: 'Needs confirmed mapping; ID heuristics alone are insufficient.',
  },
  other: {
    code: 'other',
    label: 'Other',
    mode: 'unsupported',
    capabilities: {
      applications: false,
      issued: false,
      active_status: false,
      pending: false,
      inspections: false,
    },
    notes: 'Out-of-scope jurisdictions.',
  },
};

/** Legacy alias — kept for lookups only; not listed as a separate UI option. */
JURISDICTIONS.unknown = JURISDICTIONS.unresolved;

export const FAIRFAX_FIELD_AVAILABILITY = {
  RECORDID: 'live',
  APPTYPEALIAS: 'live',
  RECORD_STATUS: 'live',
  RECORD_STATUS_DATE: 'live',
  SUBMITTED_DATE: 'live',
  ACCEPTED_DATE: 'live',
  APPROVED_DATE: 'live',
  ISSUED_DATE: 'live',
  CLOSED_DATE: 'live',
  ADDRESS_1: 'live',
  CITY: 'live',
  STATE: 'live',
  ZIP_CODE: 'live',
  PARCEL_ID: 'live',
  LINK_URL: 'live',
  DOCUMENT_URL: 'live',
  pending_state: 'unavailable',
  reviewer_comments: 'unavailable',
  holds: 'unavailable',
  revision_cycle: 'manual-only',
  inspections: 'unavailable',
};

export function normalizeOfficialStatus(native) {
  if (!native) return 'unknown';
  const s = String(native).trim().toLowerCase();
  if (!s) return 'unknown';
  if (s.includes('issu')) return 'issued';
  if (s.includes('approv')) return 'approved';
  if (s.includes('accept')) return 'accepted';
  if (s.includes('submit') || s.includes('in review') || s.includes('under review')) return 'in_review';
  if (s.includes('revis') || s.includes('correction')) return 'revision_required';
  if (s.includes('clos') || s.includes('final') || s.includes('complete')) return 'closed';
  if (s.includes('expir')) return 'expired';
  if (s.includes('withdraw') || s.includes('void') || s.includes('cancel')) return 'cancelled';
  return 'other';
}

export function epochMsToDate(ms) {
  if (ms == null || ms === '') return null;
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  return new Date(n).toISOString().slice(0, 10);
}
