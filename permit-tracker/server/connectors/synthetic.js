import { normalizeOfficialStatus } from './types.js';

const FIXTURES = {
  loudoun_county: {
    'BLDC-2026-013456': {
      sourceNativeStatus: 'Issued',
      submittedDate: '2026-03-19',
      issuedDate: '2026-05-11',
      sourceUrl: 'https://www.loudoun.gov/',
      permitType: 'Occupancy Only (Commercial)',
    },
    'BLDC-2026-040694': {
      sourceNativeStatus: 'In Review',
      submittedDate: '2026-08-17',
      sourceUrl: 'https://www.loudoun.gov/',
      permitType: 'Building',
    },
  },
  prince_william_county: {
    'BLD2026-04765': {
      sourceNativeStatus: 'Issued',
      submittedDate: '2026-04-06',
      issuedDate: '2026-04-08',
      sourceUrl: 'https://egcss.pwcgov.org/SelfService#/home',
      permitType: 'Building',
    },
    'ZNA2026-04510': {
      sourceNativeStatus: 'Issued',
      submittedDate: '2026-04-01',
      issuedDate: '2026-04-05',
      sourceUrl: 'https://egcss.pwcgov.org/SelfService#/home',
      permitType: 'Zoning',
    },
  },
  city_of_houston: {
    'HOU-DEMO-55001': {
      sourceNativeStatus: 'Sold / Issued',
      issuedDate: '2026-04-05',
      sourceUrl: 'https://permits.houstontx.gov/',
      permitType: 'Residential New',
    },
  },
  harris_county: {
    'HAR-DEMO-7701': {
      sourceNativeStatus: 'Active',
      issuedDate: '2026-08-03',
      sourceUrl: 'https://oce.harriscountytx.gov/Services/Permits',
      permitType: 'Building',
    },
  },
  city_of_fairfax: {
    'CFX-DEMO-1001': {
      sourceNativeStatus: 'In Review',
      submittedDate: '2026-08-12',
      sourceUrl: 'https://aca-prod.accela.com/FAIRFAX/Default.aspx',
      permitType: 'Residential New',
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
  const table = FIXTURES[jurisdictionCode] || {};
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
