/** Official ID parsing — reusable, not employer-specific. */

export const OFFICIAL_ID_RE =
  /\b((?:ZNA|ZONC|BLD|BLDC|BLDR|ALTC|ALTR|BPR|MST|MASTRR|MASTR|MASTC)-?\d{4}-?\d+)\b/gi;

/** Prefixes confirmed Fairfax County PLUS (not City of Fairfax). */
const FAIRFAX_COUNTY_CONFIRMED_PREFIXES = new Set(['ALTC', 'ALTR', 'BLDR']);

/** Prefixes that suggest Loudoun LandMARC but collide with Fairfax BLDC shape. */
const LOUDOUN_SUGGEST_PREFIXES = new Set(['MASTR', 'MASTRR', 'MASTC', 'ZONC']);

/** Compact PWC-style prefixes (suggestion only). */
const PWC_SUGGEST_PREFIXES = new Set(['BLD', 'ZNA', 'BPR', 'MST']);

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
  const s = String(raw).toUpperCase().replace(/\s+/g, '');
  const m = s.match(/^([A-Z]+)(-?)(\d{4})(-?)(\d+)$/);
  if (!m) return s;
  const [, prefix, , year, , seq] = m;
  if (['BLDC', 'BLDR', 'ALTC', 'ALTR', 'ZONC', 'MASTR', 'MASTRR', 'MASTC'].includes(prefix)) {
    return `${prefix}-${year}-${seq}`;
  }
  if (['BLD', 'ZNA', 'BPR', 'MST'].includes(prefix)) {
    return `${prefix}${year}-${seq}`;
  }
  return `${prefix}-${year}-${seq}`;
}

export function idPrefix(id) {
  const m = String(id).toUpperCase().match(/^([A-Z]+)/);
  return m ? m[1] : 'UNK';
}

/**
 * Suggest jurisdiction from ID shape only — never confirms.
 * BLDC is ambiguous (Fairfax PLUS vs Loudoun LandMARC) → unresolved suggestion.
 */
export function suggestJurisdictionFromId(id) {
  const u = String(id).toUpperCase();
  const prefix = idPrefix(u);
  if (FAIRFAX_COUNTY_CONFIRMED_PREFIXES.has(prefix) && /^[A-Z]+-\d{4}-\d+$/.test(u)) {
    return { code: 'fairfax_county', confidence: 'suggest_strong', reason: `prefix ${prefix}` };
  }
  if (prefix === 'BLDC' && /^BLDC-\d{4}-\d+$/.test(u)) {
    return {
      code: 'unresolved',
      confidence: 'ambiguous',
      reason: 'BLDC-YYYY-n used by Fairfax PLUS and Loudoun LandMARC',
    };
  }
  if (LOUDOUN_SUGGEST_PREFIXES.has(prefix)) {
    return { code: 'loudoun_county', confidence: 'suggest', reason: `prefix ${prefix}` };
  }
  if (PWC_SUGGEST_PREFIXES.has(prefix) && /^(BLD|ZNA|BPR|MST)\d{4}-/.test(u)) {
    return { code: 'prince_william_county', confidence: 'suggest', reason: `compact prefix ${prefix}` };
  }
  return { code: 'unresolved', confidence: 'none', reason: 'unrecognized pattern' };
}

/** True if ID shape is eligible for Fairfax County live FeatureServer query. */
export function isFairfaxCountyQueryCandidate(id) {
  return /^(ALTC|ALTR|BLDC|BLDR)-\d{4}-\d+$/i.test(String(id));
}

/** @deprecated use suggestJurisdictionFromId */
export function guessJurisdictionFromId(id) {
  const s = suggestJurisdictionFromId(id);
  return s.code === 'unresolved' ? 'unknown' : s.code;
}

/** @deprecated use isFairfaxCountyQueryCandidate */
export function isFairfaxShapedId(id) {
  return isFairfaxCountyQueryCandidate(id);
}

/**
 * Confirmed jurisdiction from import profile mapping (community/section), not ID heuristics.
 */
export function resolveJurisdiction({ confirmedCode, suggestedFromId }) {
  if (confirmedCode && confirmedCode !== 'unknown' && confirmedCode !== 'unresolved') {
    return {
      code: confirmedCode,
      jurisdiction_source: 'confirmed_mapping',
      jurisdiction_confirmed: 1,
    };
  }
  if (suggestedFromId && suggestedFromId.code && suggestedFromId.code !== 'unresolved') {
    return {
      code: suggestedFromId.code,
      jurisdiction_source: 'inferred',
      jurisdiction_confirmed: 0,
    };
  }
  return {
    code: 'unresolved',
    jurisdiction_source: 'unresolved',
    jurisdiction_confirmed: 0,
  };
}

export function stableLotKey(projectCode, communityName, lotLabel, housetype) {
  return [projectCode, communityName, lotLabel, housetype]
    .map((x) => String(x || '').trim().toLowerCase())
    .join('||');
}
