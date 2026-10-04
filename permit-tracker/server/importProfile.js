/**
 * Source-workbook import profile — separate from reusable core.
 *
 * Utility/geography headers (LoCo Water, PW W/S) suggest county geography,
 * they do NOT confirm the building/zoning AHJ for every record type.
 * Confirmed AHJ requires explicit evidence or operator confirmation.
 */

/** Project codes → suggested geography (not confirmed AHJ). */
export const SUGGESTED_PROJECT_GEOGRAPHY = {
  CAM1: 'loudoun_county',
  CAM2: 'loudoun_county',
  LE2: 'loudoun_county',
  BSO1: 'prince_william_county',
  IN1: 'prince_william_county',
  'IN1 sec. 4': 'prince_william_county',
  'IN1 section 5': 'prince_william_county',
  'IN1 section 3': 'prince_william_county',
  IN2: 'prince_william_county',
  POS1: 'prince_william_county',
  PLS2: 'prince_william_county',
  QUE1: 'prince_william_county',
  QUE2: 'prince_william_county',
  QUW1: 'prince_william_county',
  QUW2: 'prince_william_county',
  COB3: 'prince_william_county',
};

/**
 * Infer jurisdiction suggestion from section headers.
 * Returns confirmed=1 only for explicit AHJ naming (not utility columns alone).
 */
export function confirmJurisdictionFromHeaders(headers, permitTimeNote, projectCode) {
  const blob = `${JSON.stringify(headers)} ${permitTimeNote} ${projectCode}`.toLowerCase();

  // Explicit AHJ naming — rare in this workbook; still suggestion unless operator confirms
  if (blob.includes('city of fairfax')) {
    return {
      code: 'city_of_fairfax',
      source: 'header_suggestion',
      confirmed: 0,
      authority_note: 'City of Fairfax named explicitly — still needs operator confirm for building AHJ',
    };
  }
  if (blob.includes('fairfax county') || blob.includes('ffx county')) {
    return {
      code: 'fairfax_county',
      source: 'header_suggestion',
      confirmed: 0,
      authority_note: 'Fairfax County named — operator confirm before treating as confirmed AHJ',
    };
  }

  // Utility / geography signals — suggest only
  if (blob.includes('loco') || blob.includes('loudoun')) {
    return {
      code: 'loudoun_county',
      source: 'utility_geography_suggestion',
      confirmed: 0,
      authority_note:
        'LoCo Water / Loudoun geography in headers suggests Loudoun County; not confirmed building/zoning AHJ (towns may differ by record type)',
    };
  }
  if (
    blob.includes('pw w') ||
    blob.includes('pw sewer') ||
    blob.includes('pww') ||
    blob.includes('prince william') ||
    /\bpw\b/.test(blob)
  ) {
    return {
      code: 'prince_william_county',
      source: 'utility_geography_suggestion',
      confirmed: 0,
      authority_note:
        'PW water/sewer geography suggests Prince William County; not confirmed building/zoning AHJ for every record',
    };
  }

  const byCode = SUGGESTED_PROJECT_GEOGRAPHY[projectCode];
  if (byCode) {
    return {
      code: byCode,
      source: 'project_code_suggestion',
      confirmed: 0,
      authority_note: 'Project-code geography suggestion from import profile — not operator-confirmed AHJ',
    };
  }

  const base = String(projectCode || '').split(/\s+/)[0];
  if (SUGGESTED_PROJECT_GEOGRAPHY[base]) {
    return {
      code: SUGGESTED_PROJECT_GEOGRAPHY[base],
      source: 'project_code_suggestion',
      confirmed: 0,
      authority_note: 'Project-code geography suggestion from import profile — not operator-confirmed AHJ',
    };
  }

  return { code: 'unresolved', source: 'unresolved', confirmed: 0, authority_note: '' };
}

/** @deprecated alias — name kept for call sites; does not confirm AHJ */
export const CONFIRMED_PROJECT_JURISDICTIONS = SUGGESTED_PROJECT_GEOGRAPHY;

export const ARCHIVED_SHEETS = [
  'Indirect Cost',
  '2018 IRC Tracker',
  'Corewall Alternative Tracker',
  'WHSD Masterfile',
];

export const ACTIVE_IMPORT_SHEETS = [
  'Permit Tracker',
  'Permit Revisions',
  'Masterfile Plan Tracker',
  "MST's",
];
