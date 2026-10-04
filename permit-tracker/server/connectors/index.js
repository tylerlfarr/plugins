import { JURISDICTIONS, FAIRFAX_FIELD_AVAILABILITY } from './types.js';
import { checkFairfaxPermit } from './fairfax.js';
import { checkSyntheticPermit } from './synthetic.js';
import { isFairfaxShapedId, guessJurisdictionFromId } from '../gospelImport.js';

export { JURISDICTIONS, FAIRFAX_FIELD_AVAILABILITY };

/**
 * Route checks:
 * - Fairfax-shaped IDs always try live Fairfax first (workbook-native Fairfax sync).
 * - Otherwise use jurisdiction adapter (synthetic unless live).
 */
export async function checkPermit({ jurisdictionCode, officialId, forceFail = false }) {
  const checkedAt = new Date().toISOString();
  if (!officialId) {
    return { outcome: 'failed', mode: 'synthetic', error: 'officialId required', checkedAt };
  }

  if (forceFail) {
    return checkSyntheticPermit({ jurisdictionCode, officialId, forceFail: true });
  }

  if (isFairfaxShapedId(officialId) || jurisdictionCode === 'fairfax_county') {
    const live = await checkFairfaxPermit({ officialId });
    // If Fairfax-shaped but not in Fairfax layer, fall through to synthetic jurisdiction guess
    if (live.outcome === 'not_found' && jurisdictionCode !== 'fairfax_county') {
      const guess = guessJurisdictionFromId(officialId);
      const syn = await checkSyntheticPermit({
        jurisdictionCode: guess !== 'unknown' ? guess : jurisdictionCode,
        officialId,
      });
      return {
        ...syn,
        fairfaxAttempt: 'not_found',
        note: 'Fairfax-shaped ID not in Fairfax Building Records PLUS; synthetic/other adapter used if available.',
      };
    }
    return live;
  }

  const meta = JURISDICTIONS[jurisdictionCode];
  if (!meta) {
    return {
      outcome: 'unavailable',
      mode: 'synthetic',
      error: `Unknown jurisdiction ${jurisdictionCode}`,
      checkedAt,
    };
  }
  return checkSyntheticPermit({ jurisdictionCode, officialId, forceFail });
}

export function listConnectors() {
  return Object.values(JURISDICTIONS).map((j) => ({
    ...j,
    live: j.mode === 'live',
    fieldAvailability: j.code === 'fairfax_county' ? FAIRFAX_FIELD_AVAILABILITY : null,
  }));
}
