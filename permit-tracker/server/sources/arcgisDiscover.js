/**
 * Reusable ArcGIS FeatureServer / MapServer discovery + inspection.
 * Read-only. Does not auto-activate sources for operational records.
 * Outbound fetches go through SSRF hardening (private/link-local blocked).
 */
import { assertSafeOutboundUrl } from './ssrf.js';

const UA = 'permit-ledger-discovery/1.0 (+local prototype; read-only)';

async function fetchJson(url, { timeoutMs = 15000 } = {}) {
  await assertSafeOutboundUrl(url);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': UA },
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      return {
        ok: false,
        status: res.status,
        json: null,
        text: 'Redirects are not followed for source inspection (SSRF hardening)',
      };
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, text: text.slice(0, 500) };
  } finally {
    clearTimeout(t);
  }
}

function withF(url) {
  if (url.includes('f=json') || url.includes('f=pjson')) return url;
  return url.includes('?') ? `${url}&f=json` : `${url}?f=json`;
}

/** Heuristic: fields that look like permit identifiers / status / dates */
export function proposeFieldMappings(fields = []) {
  const names = fields.map((f) => f.name || f);
  const lower = Object.fromEntries(names.map((n) => [String(n).toLowerCase(), n]));
  const pick = (...cands) => {
    for (const c of cands) {
      if (lower[c]) return lower[c];
      const hit = names.find((n) => String(n).toLowerCase().includes(c));
      if (hit) return hit;
    }
    return null;
  };
  return {
    officialId: pick('recordid', 'permit_number', 'permitnumber', 'plannumber', 'casenumber', 'zoningcasenumber'),
    status: pick('record_status', 'permitstatus', 'planstatus', 'usepermitstatus', 'status'),
    submittedDate: pick('submitted_date', 'submitted', 'date_submitted', 'applicationdate'),
    approvedDate: pick('approved_date', 'dateapproved', 'date_approved'),
    issuedDate: pick('issued_date', 'bp_issue_date', 'dateissued', 'issue_date'),
    address: pick('address_1', 'street_address', 'address', 'siteaddress'),
    parcel: pick('pin', 'gpin', 'parcel', 'parcelpin', 'mcpi'),
    sourceUrl: pick('link_url', 'url', 'staffreportlink'),
  };
}

/**
 * Inspect an ArcGIS service or layer URL.
 * @returns discovery candidate (never auto-verified for ops)
 */
export async function inspectArcGisUrl(rawUrl, { sampleKnownIds = [] } = {}) {
  const url = String(rawUrl || '').trim();
  if (!url) return { state: 'needs_review', error: 'URL required' };
  if (!/^https?:\/\//i.test(url)) return { state: 'needs_review', error: 'URL must be http(s)' };
  try {
    await assertSafeOutboundUrl(url);
  } catch (err) {
    return {
      state: 'unsupported',
      error: err.message || 'URL blocked by SSRF policy',
      code: err.code || 'ssrf_blocked',
      endpoint: url,
    };
  }

  const serviceUrl = url.replace(/\/(FeatureServer|MapServer)\/\d+\/?$/i, (_, m) => `/${m}`);
  const layerMatch = url.match(/\/(FeatureServer|MapServer)\/(\d+)\/?$/i);
  const platform = /FeatureServer/i.test(url) ? 'arcgis_featureserver' : 'arcgis_mapserver';

  const serviceMeta = await fetchJson(withF(serviceUrl));
  if (!serviceMeta.ok || !serviceMeta.json) {
    return {
      state: 'unsupported',
      platform,
      endpoint: url,
      error: `Service metadata fetch failed (${serviceMeta.status})`,
      evidence: serviceMeta.text,
    };
  }

  const layers = (serviceMeta.json.layers || []).map((l) => ({
    id: l.id,
    name: l.name,
    type: l.type || 'Feature Layer',
  }));
  const tables = (serviceMeta.json.tables || []).map((t) => ({
    id: t.id,
    name: t.name,
    type: 'Table',
  }));

  const targetId = layerMatch ? Number(layerMatch[2]) : layers[0]?.id ?? tables[0]?.id ?? null;
  let layerMeta = null;
  let sample = [];
  let sampleError = null;
  let proposedMappings = {};
  let knownIdTests = [];

  if (targetId != null) {
    const layerUrl = `${serviceUrl.replace(/\/$/, '')}/${targetId}`;
    const lm = await fetchJson(withF(layerUrl));
    if (lm.ok && lm.json && !lm.json.error) {
      layerMeta = {
        id: targetId,
        name: lm.json.name,
        geometryType: lm.json.geometryType || null,
        fields: (lm.json.fields || []).map((f) => ({
          name: f.name,
          type: f.type,
          alias: f.alias,
        })),
        maxRecordCount: lm.json.maxRecordCount || serviceMeta.json.maxRecordCount || null,
        supportsPagination: Boolean(lm.json.advancedQueryCapabilities?.supportsPagination),
      };
      proposedMappings = proposeFieldMappings(layerMeta.fields);

      const qUrl =
        `${layerUrl}/query?` +
        new URLSearchParams({
          where: '1=1',
          outFields: '*',
          returnGeometry: 'false',
          resultRecordCount: '3',
          f: 'json',
        });
      const q = await fetchJson(qUrl);
      if (q.json?.error) {
        sampleError = q.json.error.message || JSON.stringify(q.json.error);
      } else {
        sample = (q.json?.features || []).map((f) => f.attributes).slice(0, 3);
      }

      const idField = proposedMappings.officialId;
      for (const kid of sampleKnownIds.slice(0, 5)) {
        if (!idField) {
          knownIdTests.push({ id: kid, outcome: 'unavailable', error: 'No ID field mapping proposed' });
          continue;
        }
        const w = `${idField}='${String(kid).replace(/'/g, "''")}'`;
        const tUrl =
          `${layerUrl}/query?` +
          new URLSearchParams({
            where: w,
            outFields: '*',
            returnGeometry: 'false',
            resultRecordCount: '2',
            f: 'json',
          });
        const tq = await fetchJson(tUrl);
        if (tq.json?.error) {
          knownIdTests.push({
            id: kid,
            outcome: 'failed',
            error: tq.json.error.message || 'query error',
          });
        } else {
          const n = (tq.json?.features || []).length;
          knownIdTests.push({
            id: kid,
            outcome: n ? 'matched' : 'not_found',
            matchCount: n,
            sample: n ? tq.json.features[0].attributes : null,
          });
        }
      }
    } else {
      sampleError = lm.json?.error?.message || `Layer metadata failed (${lm.status})`;
    }
  }

  // Issued-only / relevance hints + known Fairfax PLUS coverage honesty
  const fieldBlob = JSON.stringify(layerMeta?.fields || []).toLowerCase();
  const endpointLower = String(serviceUrl || url).toLowerCase();
  const limitations = [];
  if (sampleError) limitations.push(`Query sample failed: ${sampleError}`);
  if (fieldBlob.includes('bp_issue') && !fieldBlob.includes('status')) {
    limitations.push('Appears issued-date oriented; may lack active workflow status');
  }
  if (!proposedMappings.officialId) {
    limitations.push('Could not propose an official ID field mapping');
  }
  if (knownIdTests.length && knownIdTests.every((t) => t.outcome !== 'matched')) {
    limitations.push('Known workbook IDs did not match sample queries');
  }
  if (endpointLower.includes('building_records_plus')) {
    limitations.push(
      'Fairfax Building Records PLUS: issued-heavy layer; pending / reviewer comments / holds / inspections unavailable. City of Fairfax is a separate AHJ.'
    );
  }

  return {
    state: sampleError && !sample.length ? 'needs_review' : 'discovered',
    platform,
    endpoint: serviceUrl,
    layerId: targetId,
    serviceDescription: serviceMeta.json.serviceDescription || serviceMeta.json.description || '',
    layers,
    tables,
    layer: layerMeta,
    proposedMappings,
    sampleRecords: sample,
    sampleError,
    knownIdTests,
    limitations,
    pagination: {
      maxRecordCount: layerMeta?.maxRecordCount || serviceMeta.json.maxRecordCount || null,
      supportsPagination: layerMeta?.supportsPagination ?? null,
    },
    note: 'Discovery candidate only — requires human review before operational activation',
  };
}

/** Built-in seed URLs for VA NOVA research */
export const SEED_ARCGIS_CANDIDATES = [
  {
    jurisdiction_code: 'fairfax_county',
    label: 'Fairfax Building Records PLUS',
    url: 'https://services1.arcgis.com/ioennV6PpG5Xodq0/arcgis/rest/services/Building_Records_PLUS/FeatureServer/0',
  },
  {
    jurisdiction_code: 'loudoun_county',
    label: 'Loudoun ResBuildingPermits (issued residential)',
    url: 'https://logis.loudoun.gov/gis/rest/services/Projects/ResBuildingPermits/MapServer/0',
  },
  {
    jurisdiction_code: 'loudoun_county',
    label: 'Loudoun Landmarc_GUIDs plans table',
    url: 'https://logis.loudoun.gov/gis/rest/services/Projects/Landmarc_GUIDs/FeatureServer/1',
  },
  {
    jurisdiction_code: 'prince_william_county',
    label: 'PWC Use Permits (zoning SUP/NCU)',
    url: 'https://gisweb.pwcva.gov/arcgis/rest/services/Planning/Zoning/MapServer/6',
  },
  {
    jurisdiction_code: 'prince_william_county',
    label: 'PWC Planning Pending Cases',
    url: 'https://gisweb.pwcva.gov/arcgis/rest/services/Planning/Land_Development/MapServer/4',
  },
];
