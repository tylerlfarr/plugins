export const JURISDICTIONS = {
  fairfax_county: {
    code: 'fairfax_county',
    label: 'Fairfax County, VA',
    mode: 'live',
    notes:
      'Live Building Records PLUS FeatureServer. Issued-heavy; no pending/comments/holds/inspections fields.',
  },
  loudoun_county: {
    code: 'loudoun_county',
    label: 'Loudoun County, VA',
    mode: 'unsupported',
    notes:
      'LandMARC portal + annual issued-permit apps exist; no verified per-permit status API. Checks return unavailable (fixtures only in demo mode).',
  },
  prince_william_county: {
    code: 'prince_william_county',
    label: 'Prince William County, VA',
    mode: 'unsupported',
    notes:
      'ePortal HTML search exists; no verified public FeatureServer for BLD/ZNA/MST sync. Checks return unavailable.',
  },
  city_of_fairfax: {
    code: 'city_of_fairfax',
    label: 'City of Fairfax, VA',
    mode: 'unsupported',
    notes: 'Distinct from Fairfax County. Accela portal only.',
  },
  city_of_houston: {
    code: 'city_of_houston',
    label: 'City of Houston, TX',
    mode: 'unsupported',
    notes: 'Not in source workbook. Per-permit API not verified.',
  },
  harris_county: {
    code: 'harris_county',
    label: 'Harris County, TX',
    mode: 'unsupported',
    notes: 'Distinct from City of Houston. Unsupported.',
  },
  unresolved: {
    code: 'unresolved',
    label: 'Unresolved jurisdiction',
    mode: 'unsupported',
    notes: 'Needs confirmed mapping; ID heuristics alone are insufficient.',
  },
  unknown: {
    code: 'unresolved',
    label: 'Unresolved jurisdiction',
    mode: 'unsupported',
    notes: 'Legacy alias for unresolved.',
  },
  other: {
    code: 'other',
    label: 'Other',
    mode: 'unsupported',
    notes: 'Out-of-scope jurisdictions.',
  },
};

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
