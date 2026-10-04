import { pathToFileURL } from 'node:url';
import { db, migrate, setSetting } from './db.js';
import { rebuildAttention } from './sync.js';

migrate();

function reset() {
  db.exec(`
    DELETE FROM attention_events;
    DELETE FROM match_reviews;
    DELETE FROM change_history;
    DELETE FROM import_sessions;
    DELETE FROM saved_filters;
    DELETE FROM permits;
    DELETE FROM lots;
    DELETE FROM projects;
    DELETE FROM communities;
  `);
}

export function seed() {
  reset();
  setSetting('stale_days', '14');
  setSetting('current_user', 'demo.user');

  const insertCommunity = db.prepare(
    'INSERT INTO communities(name, jurisdiction_code, notes) VALUES (?, ?, ?)'
  );
  const insertProject = db.prepare(
    'INSERT INTO projects(community_id, name, code) VALUES (?, ?, ?)'
  );
  const insertLot = db.prepare(
    'INSERT INTO lots(project_id, lot_number, address, parcel_id) VALUES (?, ?, ?, ?)'
  );
  const insertPermit = db.prepare(
    `INSERT INTO permits(
      lot_id, jurisdiction_code, official_id, permit_type, source_native_status, official_status,
      internal_status, submitted_date, approved_date, issued_date, revision_date,
      construction_start_date, expiration_date, predicted_issue_date, owner, notes,
      next_action, next_action_due, source_url, last_check_outcome, official_last_changed_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );

  const oak = insertCommunity.run(
    'Oakridge Estates',
    'fairfax_county',
    'Synthetic community for Fairfax County demo'
  );
  const bayou = insertCommunity.run(
    'Bayou Bend',
    'city_of_houston',
    'Synthetic Houston community — connector is synthetic'
  );
  const prairie = insertCommunity.run(
    'Prairie Ridge',
    'harris_county',
    'Harris County (not City of Houston)'
  );
  const cityFx = insertCommunity.run(
    'Fairfax City Mews',
    'city_of_fairfax',
    'City of Fairfax — distinct from Fairfax County'
  );

  const oakP2 = insertProject.run(oak.lastInsertRowid, 'Phase 2', 'OR-P2');
  const bayouA = insertProject.run(bayou.lastInsertRowid, 'Section A', 'BB-A');
  const prairie1 = insertProject.run(prairie.lastInsertRowid, 'Pod 1', 'PR-1');
  const mews = insertProject.run(cityFx.lastInsertRowid, 'Townhomes', 'FCM-TH');

  const lot12 = insertLot.run(oakP2.lastInsertRowid, '12', '100 Demo Oak Ln', '0294 10 DEMO');
  const lot13 = insertLot.run(oakP2.lastInsertRowid, '13', '102 Demo Oak Ln', '0294 11 DEMO');
  const lot3 = insertLot.run(bayouA.lastInsertRowid, '3', '220 Synthetic Bayou Rd', '');
  const lot7 = insertLot.run(prairie1.lastInsertRowid, '7', '15 County Line Dr', '');
  const lot1 = insertLot.run(mews.lastInsertRowid, '1', '40 City Center Way', '');

  // Live Fairfax ID (public record) — used only as demo link target
  insertPermit.run(
    lot12.lastInsertRowid,
    'fairfax_county',
    'ALTC-2026-00970',
    'Commercial Addition/Alteration',
    '',
    'unknown',
    'watching',
    '2026-03-18',
    null,
    null,
    null,
    null,
    null,
    null,
    'Alex PM',
    'Demo: sync via Fairfax live connector. Internal note must survive sync.',
    'Run source check',
    '2026-10-05',
    '',
    'never',
    null
  );

  insertPermit.run(
    lot12.lastInsertRowid,
    'fairfax_county',
    'FFX-TRADE-DEMO-12',
    'Electrical',
    'In Review',
    'in_review',
    'needs_followup',
    '2026-09-15',
    null,
    null,
    null,
    null,
    null,
    '2026-10-20',
    'Alex PM',
    'Second permit on same lot. Official ID is synthetic (will not_found on live check).',
    'Call electrician',
    '2026-09-20',
    '',
    'never',
    '2026-09-16'
  );

  insertPermit.run(
    lot13.lastInsertRowid,
    'fairfax_county',
    null,
    'Building',
    '',
    'unknown',
    'draft',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    'Sam Coordinator',
    'No official ID yet — import/manual entry.',
    'Obtain record number',
    '2026-10-12',
    '',
    'never',
    null
  );

  insertPermit.run(
    lot3.lastInsertRowid,
    'city_of_houston',
    'HOU-DEMO-55001',
    'Residential New Construction',
    'Sold / Issued',
    'issued',
    'watching',
    '2026-03-10',
    '2026-04-02',
    '2026-04-05',
    null,
    '2026-05-01',
    '2027-04-05',
    null,
    'Jordan PM',
    'SYNTHETIC connector only — not live Houston data.',
    'Schedule foundation',
    '2026-10-08',
    'https://permits.houstontx.gov/',
    'never',
    '2026-04-05'
  );

  insertPermit.run(
    lot3.lastInsertRowid,
    'city_of_houston',
    'HOU-DEMO-55002',
    'Electrical',
    'Plan Review',
    'in_review',
    'needs_followup',
    '2026-09-01',
    null,
    null,
    '2026-09-22',
    null,
    null,
    '2026-10-15',
    'Jordan PM',
    'Revision milestone recorded separately from approval/issuance.',
    'Upload revision set',
    '2026-09-25',
    'https://permits.houstontx.gov/',
    'never',
    '2026-09-22'
  );

  insertPermit.run(
    lot7.lastInsertRowid,
    'harris_county',
    'HAR-DEMO-7701',
    'Building',
    'Active',
    'issued',
    'watching',
    '2026-07-18',
    '2026-08-01',
    '2026-08-03',
    null,
    null,
    null,
    null,
    'Riley PM',
    'Harris County ≠ City of Houston.',
    '',
    null,
    'https://oce.harriscountytx.gov/Services/Permits',
    'never',
    '2026-08-03'
  );

  insertPermit.run(
    lot1.lastInsertRowid,
    'city_of_fairfax',
    'CFX-DEMO-1001',
    'Residential New',
    'In Review',
    'in_review',
    'watching',
    '2026-08-12',
    null,
    null,
    null,
    null,
    null,
    '2026-11-01',
    'Casey PM',
    'City of Fairfax Accela portal — synthetic check only.',
    'Monitor review comments',
    '2026-10-15',
    'https://aca-prod.accela.com/FAIRFAX/Default.aspx',
    'never',
    '2026-08-12'
  );

  db.prepare(
    `INSERT INTO saved_filters(name, definition) VALUES
     ('Needs follow-up', ?),
     ('Fairfax County', ?),
     ('Expiring / overdue', ?)`
  ).run(
    JSON.stringify({ internal_status: 'needs_followup' }),
    JSON.stringify({ jurisdiction_code: 'fairfax_county' }),
    JSON.stringify({ attention: true })
  );

  rebuildAttention();
  console.log('Seeded synthetic demo data.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seed();
}
