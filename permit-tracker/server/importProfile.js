/**
 * Source-workbook import profile — separate from reusable core.
 * Confirmed jurisdiction mappings are evidence-based from sheet headers
 * (e.g. "LoCo Water", "PW W/S"), not employee names.
 */

/** Project codes → confirmed jurisdiction when workbook headers prove AHJ. */
export const CONFIRMED_PROJECT_JURISDICTIONS = {
  // Loudoun — LoCo Water columns / Cascades blocks
  CAM1: 'loudoun_county',
  CAM2: 'loudoun_county',
  LE2: 'loudoun_county',
  // Prince William — PW water/sewer, MST/BPR patterns in section headers
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

/** Header-text signals that confirm jurisdiction for a section. */
export function confirmJurisdictionFromHeaders(headers, permitTimeNote, projectCode) {
  const blob = `${JSON.stringify(headers)} ${permitTimeNote} ${projectCode}`.toLowerCase();
  if (blob.includes('loco') || blob.includes('loudoun')) {
    return { code: 'loudoun_county', source: 'confirmed_mapping', confirmed: 1 };
  }
  if (
    blob.includes('pw w') ||
    blob.includes('pw sewer') ||
    blob.includes('pww') ||
    blob.includes('prince william') ||
    /\bpw\b/.test(blob)
  ) {
    return { code: 'prince_william_county', source: 'confirmed_mapping', confirmed: 1 };
  }
  if (blob.includes('fairfax county') || blob.includes('ffx county')) {
    return { code: 'fairfax_county', source: 'confirmed_mapping', confirmed: 1 };
  }
  // City of Fairfax must be explicit — never infer from "Fairfax" alone in ambiguous text
  if (blob.includes('city of fairfax')) {
    return { code: 'city_of_fairfax', source: 'confirmed_mapping', confirmed: 1 };
  }

  const byCode = CONFIRMED_PROJECT_JURISDICTIONS[projectCode];
  if (byCode) {
    return { code: byCode, source: 'confirmed_mapping', confirmed: 1 };
  }

  // Normalize project code variants
  const base = String(projectCode || '').split(/\s+/)[0];
  if (CONFIRMED_PROJECT_JURISDICTIONS[base]) {
    return {
      code: CONFIRMED_PROJECT_JURISDICTIONS[base],
      source: 'confirmed_mapping',
      confirmed: 1,
    };
  }

  return { code: 'unresolved', source: 'unresolved', confirmed: 0 };
}

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
