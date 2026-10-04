import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permit-discovery-'));
process.env.PERMIT_DB_PATH = path.join(tmpDir, 'discovery.sqlite');
process.env.PERMIT_DEMO = '0';

const { proposeFieldMappings } = await import('../sources/arcgisDiscover.js');
const {
  ensureSourceRegistrySeeded,
  listSources,
  activateSource,
  getSource,
} = await import('../sources/registry.js');
const { connectLocation, normalizeJurisdiction } = await import('../sources/connectLocation.js');
const { confirmJurisdictionFromHeaders } = await import('../importProfile.js');

test('field mapping proposals from ArcGIS-like fields', () => {
  const m = proposeFieldMappings([
    { name: 'PERMIT_NUMBER' },
    { name: 'BP_ISSUE_DATE' },
    { name: 'STREET_ADDRESS' },
    { name: 'PIN' },
  ]);
  assert.equal(m.officialId, 'PERMIT_NUMBER');
  assert.equal(m.issuedDate, 'BP_ISSUE_DATE');
  assert.equal(m.address, 'STREET_ADDRESS');
  assert.equal(m.parcel, 'PIN');
});

test('registry seeds verified vs unsupported separately', () => {
  ensureSourceRegistrySeeded();
  const all = listSources();
  assert.ok(all.length >= 6);
  const ffx = getSource('fairfax_county_building_records_plus');
  assert.equal(ffx.state, 'verified');
  const pwcPortal = getSource('pwc_eportal_energov');
  assert.equal(pwcPortal.state, 'unsupported');
  const loudounGis = getSource('loudoun_res_building_permits_issued');
  assert.equal(loudounGis.state, 'needs_review');
});

test('activate requires verified state', () => {
  ensureSourceRegistrySeeded();
  assert.throws(() => activateSource('pwc_eportal_energov'), /only verified/);
  const src = activateSource('fairfax_county_building_records_plus', { reviewedBy: 'test' });
  assert.equal(src.activated, 1);
});

test('connect location never auto-connects; PWC building → authorization/no suitable', async () => {
  const result = await connectLocation({
    state: 'VA',
    county: 'Prince William',
    record_type: 'building',
  });
  assert.equal(result.autoConnect, false);
  assert.ok(
    ['authorization_required', 'no_suitable_source', 'candidate_needs_verification', 'partially_supported'].includes(
      result.status
    )
  );
  // Building type should surface unsupported ePortal, not pretend connected
  assert.notEqual(result.status, 'supported_connected');
});

test('Fairfax building connect surfaces verified source', async () => {
  const result = await connectLocation({
    state: 'VA',
    county: 'Fairfax County',
    record_type: 'building',
  });
  assert.equal(result.autoConnect, false);
  assert.ok(result.verifiedSources.some((s) => s.key === 'fairfax_county_building_records_plus'));
  assert.ok(['partially_supported', 'supported_connected'].includes(result.status));
});

test('utility headers suggest geography without confirming AHJ', () => {
  const jur = confirmJurisdictionFromHeaders(
    [{ label: 'LoCo Water Ordered' }],
    'Permit time: LoCo',
    'CAM2'
  );
  assert.equal(jur.code, 'loudoun_county');
  assert.equal(jur.confirmed, 0);
  assert.match(jur.source, /suggestion|utility/);
});

test('normalize jurisdiction aliases', () => {
  assert.equal(
    normalizeJurisdiction({ state: 'VA', county: 'Loudoun County' }),
    'loudoun_county'
  );
  assert.equal(normalizeJurisdiction({ state: 'VA' }), null);
});
