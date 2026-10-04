/**
 * Reusable connector contract.
 *
 * checkPermit({ jurisdictionCode, officialId }) =>
 *   {
 *     outcome: 'updated' | 'no_change' | 'not_found' | 'unavailable' | 'failed',
 *     mode: 'live' | 'synthetic',
 *     sourceNativeStatus?: string,
 *     officialStatus?: string, // normalized, only when confidently mapped
 *     fields?: { submittedDate?, approvedDate?, issuedDate?, expirationDate?, sourceUrl?, permitType?, address? },
 *     error?: string,
 *     checkedAt: ISO string
 *   }
 */

export const JURISDICTIONS = {
  fairfax_county: {
    code: 'fairfax_county',
    label: 'Fairfax County, VA',
    mode: 'live',
    notes: 'Public Building Records PLUS FeatureServer (issued-heavy).',
  },
  city_of_fairfax: {
    code: 'city_of_fairfax',
    label: 'City of Fairfax, VA',
    mode: 'synthetic',
    notes: 'Accela portal exists; no verified public API. Synthetic only.',
  },
  city_of_houston: {
    code: 'city_of_houston',
    label: 'City of Houston, TX',
    mode: 'synthetic',
    notes: 'Portals/HTML search exist; per-permit API not verified. Synthetic only.',
  },
  harris_county: {
    code: 'harris_county',
    label: 'Harris County, TX',
    mode: 'synthetic',
    notes: 'Distinct from City of Houston. No verified live connector.',
  },
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
