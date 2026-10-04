#!/usr/bin/env node
/**
 * Real coverage report for imported workbook records only.
 * Excludes synthetic fixtures and Fairfax demo probes (record_origin != import).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, migrate } from '../db.js';
import { importWorkbookFile } from '../workbookImport.js';
import { checkPermit } from '../connectors/index.js';
import { isFairfaxCountyQueryCandidate } from '../ids.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', '..', 'docs', 'coverage-report.json');
const MD_OUT = path.join(__dirname, '..', '..', 'docs', 'coverage-matrix.md');

const WORKBOOK =
  process.env.SOURCE_WORKBOOK_XLSX ||
  '/cursor/stores/self/internal/Permit_Tracker_9.1.2026.xlsx';

migrate();

function importOnly(sql, ...params) {
  return db.prepare(sql).all(...params);
}

async function main() {
  if (!fs.existsSync(WORKBOOK)) {
    console.error('Source workbook missing:', WORKBOOK);
    process.exit(1);
  }

  // Fresh import into current DB path (caller should set PERMIT_DB_PATH for isolation)
  db.exec(`
    DELETE FROM attention_events; DELETE FROM match_reviews; DELETE FROM import_conflicts;
    DELETE FROM field_changes; DELETE FROM official_snapshots; DELETE FROM official_ids;
    DELETE FROM internal_milestones; DELETE FROM permit_records; DELETE FROM lot_groups;
    DELETE FROM community_sections; DELETE FROM permit_revisions; DELETE FROM plan_tracker_rows;
    DELETE FROM mst_reference_ids; DELETE FROM archived_sheet_rows; DELETE FROM import_runs;
  `);
  const { summary, parsed } = importWorkbookFile(WORKBOOK);

  const originFilter = `record_origin = 'import'`;

  const sections = importOnly(
    `SELECT jurisdiction_code, jurisdiction_source, jurisdiction_confirmed, COUNT(*) AS c
     FROM community_sections WHERE ${originFilter} GROUP BY 1,2,3`
  );
  const lotGroups = db
    .prepare(`SELECT COUNT(*) AS c FROM lot_groups WHERE ${originFilter}`)
    .get().c;
  const permits = db
    .prepare(`SELECT COUNT(*) AS c FROM permit_records WHERE ${originFilter}`)
    .get().c;
  const withIds = db
    .prepare(
      `SELECT COUNT(*) AS c FROM permit_records WHERE ${originFilter}
       AND primary_official_id IS NOT NULL AND primary_official_id != ''`
    )
    .get().c;
  const withoutIds = permits - withIds;

  const jurBreakdown = importOnly(
    `SELECT jurisdiction_code, jurisdiction_source, jurisdiction_confirmed, COUNT(*) AS c
     FROM permit_records WHERE ${originFilter} GROUP BY 1,2,3 ORDER BY c DESC`
  );

  const uniqueIds = importOnly(
    `SELECT oi.official_id, p.jurisdiction_code, cs.community_name, cs.source_sheet
     FROM official_ids oi
     JOIN permit_records p ON p.id = oi.permit_record_id
     JOIN lot_groups lg ON lg.id = p.lot_group_id
     JOIN community_sections cs ON cs.id = lg.section_id
     WHERE p.${originFilter}
     ORDER BY oi.official_id`
  );

  const byPrefix = {};
  for (const row of uniqueIds) {
    const prefix = (row.official_id.match(/^[A-Z]+/) || ['UNK'])[0];
    byPrefix[prefix] = (byPrefix[prefix] || 0) + 1;
  }

  // Live Fairfax checks for confirmed fairfax_county import records only
  const fairfaxCandidates = importOnly(
    `SELECT p.id, p.primary_official_id AS official_id, p.jurisdiction_code, p.jurisdiction_confirmed
     FROM permit_records p
     WHERE p.record_origin = 'import'
       AND p.primary_official_id IS NOT NULL AND p.primary_official_id != ''
       AND p.jurisdiction_code = 'fairfax_county'
       AND p.jurisdiction_confirmed = 1`
  );

  const liveResults = [];
  const seen = new Set();
  for (const row of fairfaxCandidates) {
    if (seen.has(row.official_id)) continue;
    seen.add(row.official_id);
    // eslint-disable-next-line no-await-in-loop
    const result = await checkPermit({
      jurisdictionCode: 'fairfax_county',
      officialId: row.official_id,
      allowSynthetic: false,
      recordOrigin: 'import',
    });
    liveResults.push({
      official_id: row.official_id,
      jurisdiction_code: row.jurisdiction_code,
      outcome: result.outcome,
      mode: result.mode,
      native: result.sourceNativeStatus || null,
      error: result.error || null,
      usefulFields: result.fields
        ? Object.keys(result.fields).filter((k) => result.fields[k] != null && result.fields[k] !== '')
        : [],
    });
  }

  // MST Fairfax-hint reference IDs (not Permit Tracker lots — separate from probes)
  const mstFairfax = importOnly(
    `SELECT DISTINCT official_id FROM mst_reference_ids
     WHERE jurisdiction_hint = 'fairfax_county' LIMIT 10`
  );
  const mstLiveResults = [];
  for (const row of mstFairfax) {
    if (!isFairfaxCountyQueryCandidate(row.official_id)) continue;
    // eslint-disable-next-line no-await-in-loop
    const result = await checkPermit({
      jurisdictionCode: 'fairfax_county',
      officialId: row.official_id,
      allowSynthetic: false,
      recordOrigin: 'import',
    });
    mstLiveResults.push({
      official_id: row.official_id,
      source: 'MST_reference',
      outcome: result.outcome,
      mode: result.mode,
      native: result.sourceNativeStatus || null,
      error: result.error || null,
      usefulFields: result.fields
        ? Object.keys(result.fields).filter((k) => result.fields[k] != null && result.fields[k] !== '')
        : [],
    });
  }

  // BLDC with confirmed Loudoun must NOT be queried as Fairfax live
  const bldcLoudoun = importOnly(
    `SELECT primary_official_id AS official_id, jurisdiction_code FROM permit_records
     WHERE record_origin = 'import' AND primary_official_id GLOB 'BLDC-*'
       AND jurisdiction_code = 'loudoun_county' LIMIT 3`
  );
  const bldcGuard = [];
  for (const row of bldcLoudoun) {
    // eslint-disable-next-line no-await-in-loop
    const result = await checkPermit({
      jurisdictionCode: row.jurisdiction_code,
      officialId: row.official_id,
      allowSynthetic: false,
      recordOrigin: 'import',
    });
    bldcGuard.push({
      official_id: row.official_id,
      outcome: result.outcome,
      mode: result.mode,
      error: result.error || null,
    });
  }

  // Sample unsupported jurisdictions (no live call — expect unavailable)
  const unsupportedSample = importOnly(
    `SELECT primary_official_id AS official_id, jurisdiction_code FROM permit_records
     WHERE ${originFilter} AND primary_official_id IS NOT NULL AND primary_official_id != ''
       AND jurisdiction_code IN ('loudoun_county','prince_william_county','unresolved')
     LIMIT 8`
  );
  const unsupportedResults = [];
  for (const row of unsupportedSample) {
    // eslint-disable-next-line no-await-in-loop
    const result = await checkPermit({
      jurisdictionCode: row.jurisdiction_code,
      officialId: row.official_id,
      allowSynthetic: false,
      recordOrigin: 'import',
    });
    unsupportedResults.push({
      official_id: row.official_id,
      jurisdiction_code: row.jurisdiction_code,
      outcome: result.outcome,
      mode: result.mode,
      error: result.error || null,
    });
  }

  const demoCount = db
    .prepare(`SELECT COUNT(*) AS c FROM permit_records WHERE record_origin != 'import'`)
    .get().c;

  const report = {
    generatedAt: new Date().toISOString(),
    workbook: WORKBOOK,
    exclusions: {
      demo_fixture_permits: demoCount,
      note: 'Coverage counts use record_origin=import only. Fixtures/probes excluded.',
    },
    entityCounts: {
      sheets_in_workbook: parsed.sheets,
      active_import_sheets: ['Permit Tracker', 'Permit Revisions', 'Masterfile Plan Tracker', "MST's"],
      archived_sheets: parsed.ignoredSheets,
      community_sections: summary.sections,
      lot_groups: lotGroups,
      permit_records: permits,
      with_official_id: withIds,
      without_official_id: withoutIds,
      official_id_links: summary.official_ids,
      revisions: summary.revisions,
      masterfile: summary.masterfile,
      mst_ids: summary.mst_ids,
      match_reviews: summary.reviews,
      archived_rows_stored: summary.archived_rows,
      multi_record_rows: summary.multi_records,
    },
    meanings: {
      community_section: 'One Permit Tracker header block (Proj ID + column set)',
      lot_group: 'Stable identity: project + community + lot label + housetype (lot ranges preserved)',
      permit_record: 'One official-record shell per official ID (or one no-ID shell per lot)',
      discrepancy:
        'Lot groups ≠ permit records when a notes cell has multiple IDs (multi-record) or when ID-less lots still get a tracking shell',
    },
    jurisdictionBreakdown: jurBreakdown,
    sectionJurisdiction: sections,
    uniqueOfficialIds: uniqueIds.length,
    idsByPrefix: byPrefix,
    liveFairfaxChecks: {
      note: 'Confirmed Fairfax County Permit Tracker rows only (this workbook has none)',
      attempted: liveResults.length,
      matched: liveResults.filter((r) => r.native || ['updated', 'no_change'].includes(r.outcome)).length,
      not_found: liveResults.filter((r) => r.outcome === 'not_found').length,
      unavailable: liveResults.filter((r) => r.outcome === 'unavailable').length,
      failed: liveResults.filter((r) => r.outcome === 'failed').length,
      results: liveResults,
    },
    mstFairfaxReferenceLiveChecks: {
      note: 'MST sheet Fairfax-column reference IDs — not auto-linked to lots; not demo probes',
      attempted: mstLiveResults.length,
      matched: mstLiveResults.filter((r) => r.native).length,
      results: mstLiveResults,
    },
    bldcConfirmedLoudounGuard: {
      note: 'BLDC under confirmed Loudoun must return unavailable — no Fairfax live guess, no synthetic',
      results: bldcGuard,
    },
    unsupportedChecks: {
      note: 'No synthetic fallback — outcome must be unavailable/not_found',
      results: unsupportedResults,
    },
    addressParcelMatching:
      'Not implemented. ID-less rows require human review; no automatic address/parcel matching in this milestone.',
    mstLinking:
      'MST sheet IDs stored as reference only; no automatic link to Permit Tracker lots without explicit evidence.',
    fieldAvailabilityFairfax: {
      live: ['RECORDID', 'RECORD_STATUS', 'SUBMITTED_DATE', 'APPROVED_DATE', 'ISSUED_DATE', 'LINK_URL'],
      unavailable_on_plus_layer: ['pending', 'reviewer_comments', 'holds', 'inspections'],
    },
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

  const md = `# Coverage matrix (import-origin only)

Generated: ${report.generatedAt}

Workbook: \`${WORKBOOK}\`

## Exclusions
- Demo/fixture permits excluded: **${demoCount}**
- Counts below are \`record_origin = import\` only.

## Entity counts
| Entity | Count | Meaning |
|--------|------:|---------|
| Community sections | ${summary.sections} | Header blocks on Permit Tracker |
| Lot groups | ${lotGroups} | Stable lot identity (ranges kept) |
| Permit records | ${permits} | Official-record shells |
| With official ID | ${withIds} | |
| Without official ID | ${withoutIds} | Human review / address match later |
| Official ID links | ${summary.official_ids} | |
| Permit Revisions | ${summary.revisions} | |
| Masterfile Plan Tracker | ${summary.masterfile} | |
| MST reference IDs | ${summary.mst_ids} | Reference only — no auto-link |
| Archived sheet rows | ${summary.archived_rows} | Stored, not wiped |

## Jurisdiction (permits)
${jurBreakdown.map((j) => `- **${j.jurisdiction_code}** (${j.jurisdiction_source}, confirmed=${j.jurisdiction_confirmed}): ${j.c}`).join('\n')}

## IDs by prefix
${Object.entries(byPrefix)
  .map(([k, v]) => `- ${k}: ${v}`)
  .join('\n')}

## Live Fairfax checks (confirmed Fairfax Permit Tracker rows)
- Attempted: ${report.liveFairfaxChecks.attempted}
- Matched: ${report.liveFairfaxChecks.matched}
- Note: ${report.liveFairfaxChecks.note}

${liveResults.length
  ? liveResults
      .map(
        (r) =>
          `- \`${r.official_id}\` → ${r.outcome}${r.native ? ` (${r.native})` : ''}${r.error ? ` — ${r.error}` : ''}`
      )
      .join('\n')
  : '_None — this source workbook’s Permit Tracker rows are Loudoun/PWC/unresolved only._'}

## MST Fairfax reference live checks
- Attempted: ${mstLiveResults.length} · Matched: ${mstLiveResults.filter((r) => r.native).length}
${mstLiveResults
  .map(
    (r) =>
      `- \`${r.official_id}\` → ${r.outcome}${r.native ? ` (${r.native})` : ''}${
        r.usefulFields?.length ? ` · fields: ${r.usefulFields.join(', ')}` : ''
      }`
  )
  .join('\n')}

## BLDC + confirmed Loudoun guard
${bldcGuard.map((r) => `- \`${r.official_id}\` → ${r.outcome} (${r.mode})`).join('\n')}

## Unsupported AHJ checks (no synthetic fallback)
${unsupportedResults.map((r) => `- \`${r.official_id}\` [${r.jurisdiction_code}] → ${r.outcome}`).join('\n')}

## Limits
- Address/parcel matching for ID-less rows: **not implemented** (review required).
- MST linking: reference storage only; no evidence-free auto-link.
- Fairfax PLUS: pending/comments/holds/inspections **unavailable** on this layer.
`;

  fs.writeFileSync(MD_OUT, md);
  console.log(JSON.stringify({ out: OUT, md: MD_OUT, ...report.entityCounts, live: report.liveFairfaxChecks }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
