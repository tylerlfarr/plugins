import { JURISDICTIONS } from './types.js';
import { checkFairfaxPermit } from './fairfax.js';
import { checkSyntheticPermit } from './synthetic.js';

export { JURISDICTIONS };

export async function checkPermit({ jurisdictionCode, officialId, forceFail = false }) {
  const meta = JURISDICTIONS[jurisdictionCode];
  if (!meta) {
    return {
      outcome: 'unavailable',
      mode: 'synthetic',
      error: `Unknown jurisdiction ${jurisdictionCode}`,
      checkedAt: new Date().toISOString(),
    };
  }

  if (jurisdictionCode === 'fairfax_county') {
    return checkFairfaxPermit({ officialId });
  }

  return checkSyntheticPermit({ jurisdictionCode, officialId, forceFail });
}

export function listConnectors() {
  return Object.values(JURISDICTIONS).map((j) => ({
    ...j,
    live: j.mode === 'live',
  }));
}
