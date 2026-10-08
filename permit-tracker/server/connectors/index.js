import { JURISDICTIONS, FAIRFAX_FIELD_AVAILABILITY } from './types.js';
import { checkFairfaxPermit } from './fairfax.js';
import { checkSyntheticPermit } from './synthetic.js';
import { isFairfaxCountyQueryCandidate } from '../ids.js';

export { JURISDICTIONS, FAIRFAX_FIELD_AVAILABILITY };

/**
 * Route checks — integrity rules:
 * - Never fall back from failed/not_found live lookups to synthetic updates.
 * - Synthetic only when explicitly allowed AND record is demo/fixture origin.
 * - Unsupported jurisdiction without live adapter → unavailable (not synthetic invent).
 */
export async function checkPermit({
  jurisdictionCode,
  officialId,
  forceFail = false,
  allowSynthetic = false,
  recordOrigin = 'import',
}) {
  const checkedAt = new Date().toISOString();
  if (!officialId) {
    return { outcome: 'failed', mode: 'none', error: 'officialId required', checkedAt };
  }

  const isDemoRecord = recordOrigin === 'demo' || recordOrigin === 'fixture';

  if (forceFail) {
    if (allowSynthetic && isDemoRecord) {
      return checkSyntheticPermit({ jurisdictionCode, officialId, forceFail: true });
    }
    return {
      outcome: 'failed',
      mode: 'live',
      error: 'Simulated check failure',
      checkedAt,
    };
  }

  const prefix = String(officialId).toUpperCase().match(/^([A-Z]+)/)?.[1];
  const strongFairfax = ['ALTC', 'ALTR', 'BLDR'].includes(prefix);
  const meta = JURISDICTIONS[jurisdictionCode] || JURISDICTIONS.unresolved;

  // Confirmed Fairfax mapping OR strong Fairfax prefixes → live FeatureServer only
  if (jurisdictionCode === 'fairfax_county' || (strongFairfax && jurisdictionCode === 'unresolved')) {
    // Strong prefix with unresolved jurisdiction: still try Fairfax live (suggest path)
    const live = await checkFairfaxPermit({ officialId });
    // Do NOT fall back to synthetic on not_found / unavailable / failed
    return live;
  }

  if (strongFairfax && jurisdictionCode !== 'fairfax_county' && jurisdictionCode !== 'unresolved') {
    // e.g. ALTC under a confirmed non-Fairfax section — do not silently query Fairfax
    return {
      outcome: 'unavailable',
      mode: 'none',
      error: `${prefix} ID under confirmed ${meta.label}; confirm whether Fairfax live applies before querying`,
      checkedAt,
      connectorStatus: 'jurisdiction_mismatch',
    };
  }

  // BLDC without confirmed Fairfax: ambiguous only when jurisdiction unresolved
  if (prefix === 'BLDC' && jurisdictionCode === 'unresolved') {
    return {
      outcome: 'unavailable',
      mode: 'none',
      error:
        'BLDC ID is jurisdiction-ambiguous (Fairfax PLUS vs Loudoun). Confirm jurisdiction before live check; no synthetic fallback.',
      checkedAt,
      connectorStatus: 'ambiguous',
    };
  }

  // Confirmed Fairfax + BLDC → live
  if (prefix === 'BLDC' && jurisdictionCode === 'fairfax_county') {
    return checkFairfaxPermit({ officialId });
  }

  // Non-live / unsupported jurisdictions for import records
  if (!allowSynthetic || !isDemoRecord) {
    return {
      outcome: 'unavailable',
      mode: 'none',
      error: `${meta.label} has no verified read-only connector in this build`,
      checkedAt,
      connectorStatus: 'unsupported',
    };
  }

  // Isolated demo/fixture only
  return checkSyntheticPermit({ jurisdictionCode, officialId, forceFail: false });
}

export function listConnectors() {
  const seen = new Set();
  return Object.values(JURISDICTIONS)
    .filter((j) => {
      if (seen.has(j.code)) return false;
      seen.add(j.code);
      return true;
    })
    .map((j) => ({
      ...j,
      live: j.mode === 'live',
      fieldAvailability: j.code === 'fairfax_county' ? FAIRFAX_FIELD_AVAILABILITY : null,
      capabilities: j.capabilities || null,
      honestLabel:
        j.mode === 'live'
          ? 'Operational live connector'
          : 'Unsupported — checks return unavailable (not fabricated)',
    }));
}
