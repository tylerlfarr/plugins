import { epochMsToDate, normalizeOfficialStatus } from './types.js';

const LAYER =
  'https://services1.arcgis.com/ioennV6PpG5Xodq0/arcgis/rest/services/Building_Records_PLUS/FeatureServer/0/query';

/**
 * Live read-only Fairfax County connector.
 * Evidence: public FeatureServer query returns RECORDID + status + milestone dates.
 */
export async function checkFairfaxPermit({ officialId }) {
  const checkedAt = new Date().toISOString();
  if (!officialId) {
    return {
      outcome: 'failed',
      mode: 'live',
      error: 'officialId required',
      checkedAt,
    };
  }

  const escaped = String(officialId).replace(/'/g, "''");
  const params = new URLSearchParams({
    where: `RECORDID='${escaped}'`,
    outFields:
      'RECORDID,APPTYPEALIAS,RECORD_STATUS,SUBMITTED_DATE,ACCEPTED_DATE,APPROVED_DATE,ISSUED_DATE,CLOSED_DATE,ADDRESS_1,LINK_URL',
    returnGeometry: 'false',
    f: 'json',
  });

  try {
    const res = await fetch(`${LAYER}?${params.toString()}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      return {
        outcome: 'failed',
        mode: 'live',
        error: `HTTP ${res.status}`,
        checkedAt,
      };
    }
    const data = await res.json();
    if (data.error) {
      return {
        outcome: 'failed',
        mode: 'live',
        error: data.error.message || 'ArcGIS error',
        checkedAt,
      };
    }
    const features = data.features || [];
    if (features.length === 0) {
      return { outcome: 'not_found', mode: 'live', checkedAt };
    }
    if (features.length > 1) {
      return {
        outcome: 'failed',
        mode: 'live',
        error: `Ambiguous: ${features.length} records for RECORDID`,
        checkedAt,
        ambiguous: true,
        candidates: features.map((f) => f.attributes),
      };
    }

    const a = features[0].attributes;
    const native = a.RECORD_STATUS || '';
    return {
      outcome: 'updated', // caller decides no_change after compare
      mode: 'live',
      sourceNativeStatus: native,
      officialStatus: normalizeOfficialStatus(native),
      fields: {
        permitType: a.APPTYPEALIAS || undefined,
        submittedDate: epochMsToDate(a.SUBMITTED_DATE),
        approvedDate: epochMsToDate(a.APPROVED_DATE),
        issuedDate: epochMsToDate(a.ISSUED_DATE),
        // CLOSED is not treated as expiration; leave expiration unset unless source has it
        sourceUrl: a.LINK_URL || undefined,
        address: a.ADDRESS_1 || undefined,
      },
      checkedAt,
      raw: a,
    };
  } catch (err) {
    return {
      outcome: 'unavailable',
      mode: 'live',
      error: err.message || String(err),
      checkedAt,
    };
  }
}
