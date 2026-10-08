import { epochMsToDate, normalizeOfficialStatus, FAIRFAX_FIELD_AVAILABILITY } from './types.js';
import { assertSafeOutboundUrl } from '../sources/ssrf.js';

const LAYER =
  'https://services1.arcgis.com/ioennV6PpG5Xodq0/arcgis/rest/services/Building_Records_PLUS/FeatureServer/0/query';

const OUT_FIELDS =
  'RECORDID,APPTYPEALIAS,RECORD_STATUS,RECORD_STATUS_DATE,SUBMITTED_DATE,ACCEPTED_DATE,APPROVED_DATE,ISSUED_DATE,CLOSED_DATE,ADDRESS_1,CITY,STATE,ZIP_CODE,PARCEL_ID,LINK_URL,DOCUMENT_URL';

export { FAIRFAX_FIELD_AVAILABILITY };

const MAX_DISCOVER = 50;

/**
 * Workbook-free Fairfax GIS browse (Phase 5).
 * Queries PLUS by date / APPTYPEALIAS / status / address — not by known RECORDID.
 * Caps page size ≤50. Does not invent company/role fields (unavailable on layer).
 */
export async function discoverFairfaxPermits({
  issuedFrom = null,
  issuedTo = null,
  appTypeAlias = null,
  recordStatus = null,
  addressContains = null,
  resultOffset = 0,
  resultRecordCount = 25,
  fetchImpl = fetch,
} = {}) {
  const observedAt = new Date().toISOString();
  const limit = Math.min(MAX_DISCOVER, Math.max(1, Number(resultRecordCount) || 25));
  const offset = Math.max(0, Number(resultOffset) || 0);

  const whereParts = [];
  if (issuedFrom) {
    whereParts.push(`ISSUED_DATE >= DATE '${escapeSqlDate(issuedFrom)}'`);
  }
  if (issuedTo) {
    whereParts.push(`ISSUED_DATE <= DATE '${escapeSqlDate(issuedTo)}'`);
  }
  if (appTypeAlias) {
    const t = escapeSqlLiteral(appTypeAlias);
    whereParts.push(`APPTYPEALIAS LIKE '%${t}%'`);
  }
  if (recordStatus) {
    whereParts.push(`RECORD_STATUS = '${escapeSqlLiteral(recordStatus)}'`);
  }
  if (addressContains) {
    whereParts.push(`UPPER(ADDRESS_1) LIKE '%${escapeSqlLiteral(String(addressContains).toUpperCase())}%'`);
  }
  if (!whereParts.length) {
    return {
      outcome: 'failed',
      mode: 'live',
      error: 'At least one discover filter is required',
      observedAt,
      features: [],
    };
  }

  const where = whereParts.join(' AND ');
  try {
    await assertSafeOutboundUrl(LAYER.split('/query')[0]);
  } catch (err) {
    return {
      outcome: 'failed',
      mode: 'live',
      error: err.message || String(err),
      observedAt,
      features: [],
    };
  }

  // Fixture mode for offline tests — never hits the network.
  if (process.env.PERMIT_FAIRFAX_DISCOVER_FIXTURE === '1') {
    return fixtureDiscover({
      where,
      issuedFrom,
      issuedTo,
      appTypeAlias,
      recordStatus,
      addressContains,
      offset,
      limit,
      observedAt,
    });
  }

  const params = new URLSearchParams({
    where,
    outFields: OUT_FIELDS,
    returnGeometry: 'false',
    orderByFields: 'ISSUED_DATE DESC',
    resultOffset: String(offset),
    resultRecordCount: String(limit),
    f: 'json',
  });

  try {
    const res = await fetchImpl(`${LAYER}?${params.toString()}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'permit-ledger-opportunities/1.0' },
    });
    if (!res.ok) {
      return {
        outcome: 'failed',
        mode: 'live',
        error: `HTTP ${res.status}`,
        observedAt,
        features: [],
      };
    }
    const data = await res.json();
    if (data.error) {
      return {
        outcome: 'failed',
        mode: 'live',
        error: data.error.message || 'ArcGIS error',
        observedAt,
        features: [],
      };
    }
    const seen = new Set();
    const features = [];
    for (const feat of data.features || []) {
      const a = feat.attributes || {};
      const id = a.RECORDID;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      features.push(mapDiscoverAttrs(a));
    }
    return {
      outcome: 'ok',
      mode: 'live',
      where,
      observedAt,
      features,
      truncated: features.length >= limit || Boolean(data.exceededTransferLimit),
      exceededTransferLimit: Boolean(data.exceededTransferLimit),
      fieldAvailability: FAIRFAX_FIELD_AVAILABILITY,
    };
  } catch (err) {
    return {
      outcome: 'unavailable',
      mode: 'live',
      error: err.message || String(err),
      observedAt,
      features: [],
    };
  }
}

function mapDiscoverAttrs(a) {
  const sourceEventAt = epochMsToDate(a.RECORD_STATUS_DATE);
  return {
    officialId: a.RECORDID,
    permitType: a.APPTYPEALIAS || '',
    sourceNativeStatus: a.RECORD_STATUS || '',
    officialStatus: normalizeOfficialStatus(a.RECORD_STATUS || ''),
    address: a.ADDRESS_1 || '',
    city: a.CITY || '',
    state: a.STATE || '',
    zip: a.ZIP_CODE || '',
    parcel: a.PARCEL_ID || '',
    issuedDate: epochMsToDate(a.ISSUED_DATE),
    submittedDate: epochMsToDate(a.SUBMITTED_DATE),
    approvedDate: epochMsToDate(a.APPROVED_DATE),
    closedDate: epochMsToDate(a.CLOSED_DATE),
    sourceEventAt,
    sourceUrl: a.LINK_URL || '',
    companyEvidence: null,
    roleEvidence: null,
  };
}

function escapeSqlLiteral(s) {
  return String(s).replace(/'/g, "''");
}

function escapeSqlDate(s) {
  const d = String(s).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    throw new Error(`Invalid date: ${s}`);
  }
  return d;
}

function fixtureDiscover({
  issuedFrom,
  issuedTo,
  appTypeAlias,
  recordStatus,
  addressContains,
  offset,
  limit,
  observedAt,
}) {
  const all = [
    {
      RECORDID: 'BLDR-2026-90001',
      APPTYPEALIAS: 'Residential New',
      RECORD_STATUS: 'Issued',
      RECORD_STATUS_DATE: Date.parse('2026-09-20'),
      ISSUED_DATE: Date.parse('2026-09-20'),
      SUBMITTED_DATE: Date.parse('2026-06-01'),
      APPROVED_DATE: Date.parse('2026-09-01'),
      ADDRESS_1: '100 MAPLE RUN DR',
      CITY: 'CENTREVILLE',
      STATE: 'VA',
      ZIP_CODE: '20120',
      PARCEL_ID: '0542-01-001A',
      LINK_URL: 'https://example.invalid/bldr-90001',
    },
    {
      RECORDID: 'BLDR-2026-90002',
      APPTYPEALIAS: 'Residential Alteration',
      RECORD_STATUS: 'Issued',
      RECORD_STATUS_DATE: Date.parse('2026-09-22'),
      ISSUED_DATE: Date.parse('2026-09-22'),
      SUBMITTED_DATE: Date.parse('2026-07-01'),
      APPROVED_DATE: Date.parse('2026-09-10'),
      ADDRESS_1: '100 MAPLE RUN DR',
      CITY: 'CENTREVILLE',
      STATE: 'VA',
      ZIP_CODE: '20120',
      PARCEL_ID: '0542-01-001A',
      LINK_URL: 'https://example.invalid/bldr-90002',
    },
    {
      RECORDID: 'BLDR-2026-90003',
      APPTYPEALIAS: 'Commercial New',
      RECORD_STATUS: 'Issued',
      RECORD_STATUS_DATE: Date.parse('2026-08-15'),
      ISSUED_DATE: Date.parse('2026-08-15'),
      ADDRESS_1: '500 MARKET ST',
      CITY: 'FAIRFAX',
      STATE: 'VA',
      ZIP_CODE: '22030',
      PARCEL_ID: '0999-02-010',
      LINK_URL: 'https://example.invalid/bldr-90003',
    },
  ];
  let filtered = all;
  if (appTypeAlias) {
    const t = String(appTypeAlias).toLowerCase();
    filtered = filtered.filter((a) => String(a.APPTYPEALIAS || '').toLowerCase().includes(t));
  }
  if (recordStatus) {
    filtered = filtered.filter((a) => a.RECORD_STATUS === recordStatus);
  }
  if (addressContains) {
    const t = String(addressContains).toUpperCase();
    filtered = filtered.filter((a) => String(a.ADDRESS_1 || '').toUpperCase().includes(t));
  }
  if (issuedFrom) {
    const from = Date.parse(issuedFrom);
    filtered = filtered.filter((a) => a.ISSUED_DATE >= from);
  }
  if (issuedTo) {
    const to = Date.parse(issuedTo) + 86400000 - 1;
    filtered = filtered.filter((a) => a.ISSUED_DATE <= to);
  }
  const page = filtered.slice(offset, offset + limit).map(mapDiscoverAttrs);
  return {
    outcome: 'ok',
    mode: 'fixture',
    observedAt,
    features: page,
    truncated: filtered.length > offset + limit,
    exceededTransferLimit: false,
    fieldAvailability: FAIRFAX_FIELD_AVAILABILITY,
  };
}

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
