import { normalizeOfficialStatus } from './types.js';

/**
 * Labeled synthetic connectors for jurisdictions without verified machine APIs.
 * Never present as live.
 */
const FIXTURES = {
  city_of_fairfax: {
    'CFX-DEMO-1001': {
      sourceNativeStatus: 'In Review',
      submittedDate: '2026-08-12',
      approvedDate: null,
      issuedDate: null,
      sourceUrl: 'https://aca-prod.accela.com/FAIRFAX/Default.aspx',
      permitType: 'Residential New',
    },
    'CFX-DEMO-1002': {
      sourceNativeStatus: 'Issued',
      submittedDate: '2026-05-01',
      approvedDate: '2026-06-15',
      issuedDate: '2026-06-20',
      sourceUrl: 'https://aca-prod.accela.com/FAIRFAX/Default.aspx',
      permitType: 'Building Permit',
    },
  },
  city_of_houston: {
    'HOU-DEMO-55001': {
      sourceNativeStatus: 'Sold / Issued',
      submittedDate: '2026-03-10',
      approvedDate: '2026-04-02',
      issuedDate: '2026-04-05',
      expirationDate: '2027-04-05',
      sourceUrl: 'https://permits.houstontx.gov/',
      permitType: 'Residential New Construction',
    },
    'HOU-DEMO-55002': {
      sourceNativeStatus: 'Plan Review',
      submittedDate: '2026-09-01',
      approvedDate: null,
      issuedDate: null,
      sourceUrl: 'https://permits.houstontx.gov/',
      permitType: 'Electrical',
    },
  },
  harris_county: {
    'HAR-DEMO-7701': {
      sourceNativeStatus: 'Active',
      submittedDate: '2026-07-18',
      approvedDate: '2026-08-01',
      issuedDate: '2026-08-03',
      sourceUrl: 'https://oce.harriscountytx.gov/Services/Permits',
      permitType: 'Building',
    },
  },
};

export async function checkSyntheticPermit({ jurisdictionCode, officialId, forceFail = false }) {
  const checkedAt = new Date().toISOString();
  if (forceFail) {
    return {
      outcome: 'failed',
      mode: 'synthetic',
      error: 'Simulated check failure',
      checkedAt,
    };
  }
  const table = FIXTURES[jurisdictionCode];
  if (!table) {
    return {
      outcome: 'unavailable',
      mode: 'synthetic',
      error: `No synthetic fixture table for ${jurisdictionCode}`,
      checkedAt,
    };
  }
  const row = table[officialId];
  if (!row) {
    return { outcome: 'not_found', mode: 'synthetic', checkedAt };
  }
  return {
    outcome: 'updated',
    mode: 'synthetic',
    sourceNativeStatus: row.sourceNativeStatus,
    officialStatus: normalizeOfficialStatus(row.sourceNativeStatus),
    fields: {
      permitType: row.permitType,
      submittedDate: row.submittedDate,
      approvedDate: row.approvedDate,
      issuedDate: row.issuedDate,
      expirationDate: row.expirationDate,
      sourceUrl: row.sourceUrl,
    },
    checkedAt,
  };
}

export function listSyntheticIds(jurisdictionCode) {
  return Object.keys(FIXTURES[jurisdictionCode] || {});
}
