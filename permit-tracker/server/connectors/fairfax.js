import { epochMsToDate, normalizeOfficialStatus, FAIRFAX_FIELD_AVAILABILITY } from './types.js';

const LAYER =
  'https://services1.arcgis.com/ioennV6PpG5Xodq0/arcgis/rest/services/Building_Records_PLUS/FeatureServer/0/query';

export { FAIRFAX_FIELD_AVAILABILITY };

/**
 * Live read-only Fairfax County connector.
 * Evidence: public FeatureServer query. Fields listed in FAIRFAX_FIELD_AVAILABILITY.
 * Does NOT expose pending/comments/holds/inspections (unavailable on this layer).
 */
export async function checkFairfaxPermit({ officialId }) {
  const checkedAt = new Date().toISOString();
  if (!officialId) {
    return { outcome: 'failed', mode: 'live', error: 'officialId required', checkedAt };
  }

  const candidates = expandIdCandidates(officialId);
  try {
    for (const cand of candidates) {
      const escaped = String(cand).replace(/'/g, "''");
      const params = new URLSearchParams({
        where: `RECORDID='${escaped}'`,
        outFields:
          'RECORDID,APPTYPEALIAS,RECORD_STATUS,RECORD_STATUS_DATE,SUBMITTED_DATE,ACCEPTED_DATE,APPROVED_DATE,ISSUED_DATE,CLOSED_DATE,ADDRESS_1,CITY,STATE,ZIP_CODE,PARCEL_ID,LINK_URL,DOCUMENT_URL',
        returnGeometry: 'false',
        f: 'json',
      });
      const res = await fetch(`${LAYER}?${params.toString()}`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        return { outcome: 'failed', mode: 'live', error: `HTTP ${res.status}`, checkedAt };
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
      if (features.length > 1) {
        return {
          outcome: 'failed',
          mode: 'live',
          error: `Ambiguous: ${features.length} records for ${cand}`,
          checkedAt,
          ambiguous: true,
          candidates: features.map((f) => f.attributes),
        };
      }
      if (features.length === 1) {
        const a = features[0].attributes;
        const native = a.RECORD_STATUS || '';
        // Date semantics (Phase 4):
        // - sourceEventAt: when the source says the status/event occurred (RECORD_STATUS_DATE)
        // - publicationAt: distinct publication timestamp — unavailable on this layer
        // - observedAt / checkedAt: when this process observed the payload
        const sourceEventAt = epochMsToDate(a.RECORD_STATUS_DATE);
        return {
          outcome: 'updated',
          mode: 'live',
          matchedId: a.RECORDID,
          sourceNativeStatus: native,
          officialStatus: normalizeOfficialStatus(native),
          sourceEventAt,
          publicationAt: null,
          observedAt: checkedAt,
          fields: {
            permitType: a.APPTYPEALIAS || undefined,
            submittedDate: epochMsToDate(a.SUBMITTED_DATE),
            acceptedDate: epochMsToDate(a.ACCEPTED_DATE),
            approvedDate: epochMsToDate(a.APPROVED_DATE),
            issuedDate: epochMsToDate(a.ISSUED_DATE),
            closedDate: epochMsToDate(a.CLOSED_DATE),
            sourceEventDate: sourceEventAt,
            publicationDate: null,
            sourceUrl: a.LINK_URL || undefined,
            address: a.ADDRESS_1 || undefined,
            city: a.CITY || undefined,
            state: a.STATE || undefined,
            zip: a.ZIP_CODE || undefined,
            parcel: a.PARCEL_ID || undefined,
          },
          fieldAvailability: FAIRFAX_FIELD_AVAILABILITY,
          checkedAt,
          raw: a,
        };
      }
    }
    return { outcome: 'not_found', mode: 'live', checkedAt, tried: candidates };
  } catch (err) {
    return {
      outcome: 'unavailable',
      mode: 'live',
      error: err.message || String(err),
      checkedAt,
    };
  }
}

function expandIdCandidates(officialId) {
  const id = String(officialId).trim().toUpperCase();
  const out = new Set([id]);
  // BLD2026-04765 ↔ BLD-2026-04765
  const compact = id.match(/^([A-Z]+)(\d{4})-(\d+)$/);
  if (compact) out.add(`${compact[1]}-${compact[2]}-${compact[3]}`);
  const hyphen = id.match(/^([A-Z]+)-(\d{4})-(\d+)$/);
  if (hyphen) out.add(`${hyphen[1]}${hyphen[2]}-${hyphen[3]}`);
  return [...out];
}
