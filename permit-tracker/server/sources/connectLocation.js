/**
 * "Connect a location" workflow — user picks state/county + record type.
 * Never implies every county auto-connects.
 */
import { listSources, upsertDiscoveryRun } from './registry.js';
import { inspectArcGisUrl } from './arcgisDiscover.js';

const JURISDICTION_ALIASES = {
  'fairfax county': 'fairfax_county',
  'fairfax county va': 'fairfax_county',
  'city of fairfax': 'city_of_fairfax',
  'loudoun county': 'loudoun_county',
  loudoun: 'loudoun_county',
  'prince william county': 'prince_william_county',
  'prince william': 'prince_william_county',
  pwc: 'prince_william_county',
  'houston': 'city_of_houston',
  'city of houston': 'city_of_houston',
  'harris county': 'harris_county',
};

export function normalizeJurisdiction({ state, city, county, town, jurisdiction_code }) {
  if (jurisdiction_code) return String(jurisdiction_code);
  const blob = [county, city, town, state].filter(Boolean).join(' ').toLowerCase().trim();
  for (const [k, v] of Object.entries(JURISDICTION_ALIASES)) {
    if (blob.includes(k)) return v;
  }
  if (blob.includes('virginia') || blob === 'va' || /\bva\b/.test(blob)) {
    return null; // need county
  }
  return null;
}

/**
 * @returns connection result object for UI
 */
export async function connectLocation({
  state,
  city,
  county,
  town,
  jurisdiction_code,
  record_type = 'building',
  portal_url,
  known_ids = [],
  activate = false,
  reviewed_by,
} = {}) {
  const code =
    normalizeJurisdiction({ state, city, county, town, jurisdiction_code }) || 'unresolved';

  const sources = code === 'unresolved' ? listSources() : listSources({ jurisdiction_code: code });
  const verified = sources.filter((s) => s.state === 'verified');
  const candidates = sources.filter((s) =>
    ['discovered', 'needs_review', 'degraded'].includes(s.state)
  );
  const unsupported = sources.filter((s) => s.state === 'unsupported');

  let discovery = null;
  if (portal_url) {
    discovery = await inspectArcGisUrl(portal_url, { sampleKnownIds: known_ids });
    upsertDiscoveryRun({ jurisdiction_code: code, url: portal_url, result: discovery });
  }

  // Match record type loosely
  const rt = String(record_type || 'building').toLowerCase();
  const matchesType = (s) =>
    !rt ||
    String(s.record_types || '')
      .toLowerCase()
      .split(',')
      .some((t) => t.trim().includes(rt) || rt.includes(t.trim()));

  const verifiedForType = verified.filter(matchesType);
  const connected = verifiedForType.filter((s) => s.activated);
  const activatable = verifiedForType.filter((s) => !s.activated);

  let status;
  let namedLimits = [];

  if (code === 'unresolved') {
    status = 'no_suitable_source';
    namedLimits.push('Could not resolve jurisdiction from state/city/county — specify county or jurisdiction_code');
  } else if (connected.length) {
    status = 'supported_connected';
    namedLimits = connected.flatMap((s) => [s.coverage_limitations].filter(Boolean));
  } else if (verifiedForType.length) {
    status = 'partially_supported';
    namedLimits = verifiedForType.flatMap((s) => [
      `${s.key}: verified but not activated — review required before operational use`,
      s.coverage_limitations,
    ]);
    if (activate && activatable[0]) {
      // Activation requires explicit review flag — handled by API separately
      namedLimits.push('Pass activate=true with reviewed_by after reviewing limitations');
    }
  } else if (candidates.filter(matchesType).length || discovery) {
    status = 'candidate_needs_verification';
    namedLimits.push('Discovery candidates exist; human review required before operational activation');
  } else if (unsupported.filter(matchesType).length) {
    const u = unsupported.filter(matchesType)[0];
    if (String(u.auth_access || '').includes('account') || String(u.auth_access || '').includes('login')) {
      status = 'authorization_required';
    } else {
      status = 'no_suitable_source';
    }
    namedLimits.push(u.coverage_limitations, u.evidence);
  } else {
    status = 'no_suitable_source';
    namedLimits.push(`No registry entry for ${code} / ${rt}`);
  }

  return {
    input: { state, city, county, town, jurisdiction_code: code, record_type: rt, portal_url },
    status,
    // never imply every county auto-connects
    autoConnect: false,
    verifiedSources: verifiedForType.map(summarize),
    connectedSources: connected.map(summarize),
    candidates: [
      ...candidates.filter(matchesType).map(summarize),
      ...(discovery
        ? [
            {
              key: 'ad_hoc_discovery',
              state: discovery.state,
              endpoint: discovery.endpoint,
              limitations: discovery.limitations,
              proposedMappings: discovery.proposedMappings,
              knownIdTests: discovery.knownIdTests,
              note: discovery.note,
            },
          ]
        : []),
    ],
    unsupportedSources: unsupported.filter(matchesType).map(summarize),
    namedLimits: namedLimits.filter(Boolean),
    message: statusMessage(status, code, rt),
  };
}

function summarize(s) {
  return {
    key: s.key,
    jurisdiction_code: s.jurisdiction_code,
    agency: s.agency,
    record_types: s.record_types,
    platform: s.platform,
    adapter_type: s.adapter_type,
    state: s.state,
    activated: Boolean(s.activated),
    official_url: s.official_url,
    endpoint: s.endpoint,
    coverage_limitations: s.coverage_limitations,
    auth_access: s.auth_access,
    reusable: Boolean(s.reusable),
  };
}

function statusMessage(status, code, rt) {
  switch (status) {
    case 'supported_connected':
      return `Verified source connected for ${code} (${rt}). See named limits.`;
    case 'partially_supported':
      return `Verified source exists for ${code} (${rt}) but is not activated for operational records until review.`;
    case 'candidate_needs_verification':
      return `Discovery candidates for ${code} need human verification before use.`;
    case 'authorization_required':
      return `Authoritative portal for ${code} requires authorization or has no verified public API.`;
    default:
      return `No suitable machine-readable source ready for ${code} (${rt}).`;
  }
}

/** Interface for optional external web search providers (no purchases; no fabricated results). */
export const discoveryProviderInterface = {
  name: 'DiscoveryProvider',
  methods: {
    searchOfficialSources: {
      args: ['jurisdiction', 'record_type'],
      returns: 'array of {url, title, snippet, evidence}',
      note: 'Optional. When unavailable, Connect a Location uses supplied URL + registry only.',
    },
  },
  status: 'interface_only_no_provider_configured',
};
