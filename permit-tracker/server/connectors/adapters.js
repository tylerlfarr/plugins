/**
 * Executable adapter contract for the source registry.
 * Activation must resolve an adapter here — adapter_type string alone is insufficient.
 *
 * Capabilities (honest):
 * - inspect: metadata / field discovery
 * - discover: workbook-free GIS browse (Opportunities); distinct from known-ID fetch
 * - fetch: per-permit status read
 * - refresh: eligible for operational sync jobs
 * - health: endpoint reachability check
 */
import { checkFairfaxPermit, discoverFairfaxPermits, FAIRFAX_FIELD_AVAILABILITY } from './fairfax.js';
import { assertSafeOutboundUrl } from '../sources/ssrf.js';

const UA = 'permit-ledger-adapter-health/1.0 (+read-only)';

async function fairfaxHealth({ endpoint } = {}) {
  const layer =
    endpoint ||
    'https://services1.arcgis.com/ioennV6PpG5Xodq0/arcgis/rest/services/Building_Records_PLUS/FeatureServer/0';
  await assertSafeOutboundUrl(layer);
  const url = layer.includes('?') ? `${layer}&f=json` : `${layer}?f=json`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': UA },
    });
    const ok = res.ok;
    let error = null;
    if (!ok) error = `HTTP ${res.status}`;
    else {
      const json = await res.json().catch(() => null);
      if (json?.error) error = json.error.message || 'ArcGIS error';
    }
    return {
      ok: ok && !error,
      checkedAt: new Date().toISOString(),
      endpoint: layer,
      error,
    };
  } catch (err) {
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      endpoint: layer,
      error: err.message || String(err),
    };
  } finally {
    clearTimeout(t);
  }
}

/**
 * @typedef {object} AdapterCapabilities
 * @property {boolean} inspect
 * @property {boolean} discover
 * @property {boolean} fetch
 * @property {boolean} refresh
 * @property {boolean} health
 * @property {boolean} applications  active application / pending workflow
 * @property {boolean} issued        issued/closed records present
 * @property {string} coverageNote
 */

/** @type {Record<string, object>} */
export const ADAPTERS = {
  fairfax_plus: {
    type: 'fairfax_plus',
    label: 'Fairfax County Building Records PLUS',
    jurisdiction_code: 'fairfax_county',
    operational: true,
    requiredConfig: ['endpoint'],
    capabilities: {
      inspect: true,
      discover: true,
      fetch: true,
      refresh: true,
      health: true,
      applications: false,
      issued: true,
      coverageNote:
        'Issued-heavy FeatureServer; pending/comments/holds/inspections unavailable. Not City of Fairfax.',
    },
    fieldAvailability: FAIRFAX_FIELD_AVAILABILITY,
    async fetch({ officialId }) {
      return checkFairfaxPermit({ officialId });
    },
    async discover(criteria = {}) {
      return discoverFairfaxPermits(criteria);
    },
    async health(config) {
      return fairfaxHealth(config);
    },
    validateConfig(source) {
      if (!source?.endpoint || !/^https:\/\//i.test(source.endpoint)) {
        return 'fairfax_plus requires an https FeatureServer endpoint';
      }
      if (!/Building_Records_PLUS/i.test(source.endpoint) && !/arcgis/i.test(source.endpoint)) {
        return 'fairfax_plus endpoint must be the Building Records PLUS ArcGIS layer';
      }
      return null;
    },
  },
  /** Discovery-only — not activatable for operational sync */
  arcgis_generic: {
    type: 'arcgis_generic',
    label: 'ArcGIS generic inspector',
    jurisdiction_code: null,
    operational: false,
    requiredConfig: ['endpoint'],
    capabilities: {
      inspect: true,
      discover: true,
      fetch: false,
      refresh: false,
      health: false,
      applications: false,
      issued: false,
      coverageNote:
        'Inspection/discovery helper only. Does not provide per-permit operational fetch or refresh.',
    },
    validateConfig(source) {
      if (!source?.endpoint) return 'arcgis_generic requires an endpoint URL';
      return null;
    },
  },
  none: {
    type: 'none',
    label: 'No adapter',
    operational: false,
    requiredConfig: [],
    capabilities: {
      inspect: false,
      discover: false,
      fetch: false,
      refresh: false,
      health: false,
      applications: false,
      issued: false,
      coverageNote: 'Metadata-only registry entry; cannot activate for operational checks.',
    },
    validateConfig() {
      return 'Source has no operational adapter';
    },
  },
};

export function getAdapter(adapterType) {
  const key = String(adapterType || 'none');
  return ADAPTERS[key] || null;
}

/**
 * Validate that a registry row can be activated for operational live checks.
 * Requires executable operational adapter + config — not merely a nonempty adapter_type string.
 */
export function assertActivatableAdapter(source) {
  if (!source) {
    const err = new Error('Source not found');
    err.code = 'source_not_found';
    throw err;
  }
  const adapter = getAdapter(source.adapter_type);
  if (!adapter) {
    const err = new Error(
      `Unknown adapter_type=${source.adapter_type}; cannot activate without a registered executable adapter`
    );
    err.code = 'adapter_unknown';
    throw err;
  }
  if (!adapter.operational) {
    const err = new Error(
      adapter.type === 'none'
        ? 'Source has no operational adapter; metadata-only entries cannot activate'
        : `Adapter ${adapter.type} is not operational (inspect/discovery only); cannot activate for live sync`
    );
    err.code = 'adapter_not_operational';
    throw err;
  }
  const configError = adapter.validateConfig?.(source);
  if (configError) {
    const err = new Error(configError);
    err.code = 'adapter_config_invalid';
    throw err;
  }
  for (const field of adapter.requiredConfig || []) {
    if (!source[field]) {
      const err = new Error(`Adapter ${adapter.type} requires config field: ${field}`);
      err.code = 'adapter_config_missing';
      throw err;
    }
  }
  return adapter;
}

export function enrichSourceWithAdapter(source) {
  if (!source) return source;
  const adapter = getAdapter(source.adapter_type) || ADAPTERS.none;
  let activatable = false;
  let activationBlocker = null;
  try {
    if (source.state === 'verified' || source.state === 'degraded') {
      assertActivatableAdapter(source);
      activatable = true;
    } else {
      activationBlocker = `state=${source.state}; only verified/degraded may activate`;
    }
  } catch (err) {
    activationBlocker = err.message;
  }
  return {
    ...source,
    capabilities: adapter.capabilities,
    adapter_operational: Boolean(adapter.operational),
    adapter_label: adapter.label,
    activatable,
    activation_blocker: activationBlocker,
  };
}

export function listAdapterContracts() {
  return Object.values(ADAPTERS).map((a) => ({
    type: a.type,
    label: a.label,
    operational: a.operational,
    jurisdiction_code: a.jurisdiction_code,
    capabilities: a.capabilities,
    requiredConfig: a.requiredConfig,
  }));
}
