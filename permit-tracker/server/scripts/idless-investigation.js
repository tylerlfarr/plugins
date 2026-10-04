#!/usr/bin/env node
/**
 * ID-less matching investigation for source workbook rows.
 * Candidate matching only with evidence; lot alone is not unique.
 * No auto-associate MST IDs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, migrate } from '../db.js';
import { importWorkbookFile } from '../workbookImport.js';

const WORKBOOK =
  process.env.SOURCE_WORKBOOK_XLSX ||
  '/cursor/stores/self/internal/Permit_Tracker_9.1.2026.xlsx';

migrate();
db.exec(`
  DELETE FROM idless_match_candidates; DELETE FROM attention_events; DELETE FROM match_reviews;
  DELETE FROM import_conflicts; DELETE FROM field_changes; DELETE FROM official_snapshots;
  DELETE FROM official_ids; DELETE FROM internal_milestones; DELETE FROM permit_records;
  DELETE FROM lot_groups; DELETE FROM community_sections; DELETE FROM permit_revisions;
  DELETE FROM plan_tracker_rows; DELETE FROM mst_reference_ids; DELETE FROM archived_sheet_rows;
`);
const { summary } = importWorkbookFile(WORKBOOK);

const idless = db
  .prepare(
    `SELECT p.id, cs.project_code, cs.community_name, lg.lot_label, lg.housetype, lg.notes_raw,
            p.jurisdiction_code, p.jurisdiction_source
     FROM permit_records p
     JOIN lot_groups lg ON lg.id = p.lot_group_id
     JOIN community_sections cs ON cs.id = lg.section_id
     WHERE p.record_origin = 'import'
       AND (p.primary_official_id IS NULL OR p.primary_official_id = '')`
  )
  .all();

const mst = db.prepare(`SELECT official_id, jurisdiction_hint, product_or_context FROM mst_reference_ids`).all();
const masterfile = db
  .prepare(`SELECT neighborhood, product_name, counties, notes, official_ids_json FROM plan_tracker_rows`)
  .all();

const signals = {
  total_idless: idless.length,
  with_lot_label: idless.filter((r) => r.lot_label && r.lot_label !== '(no lot)').length,
  with_lot_range: idless.filter((r) => /\d+\s*[-&]\s*\d+|lots\s+\d+/i.test(r.lot_label || '')).length,
  with_housetype: idless.filter((r) => r.housetype).length,
  with_notes: idless.filter((r) => (r.notes_raw || '').trim()).length,
  with_street_like_notes: idless.filter((r) =>
    /\d+\s+\w+.*(st|rd|dr|ln|ave|ct|way|pl|blvd)/i.test(r.notes_raw || '')
  ).length,
  with_parcel_like: idless.filter((r) => /gpin|parcel|mcpi|pin\s*\d/i.test(r.notes_raw || '')).length,
};

// Duplicate lot labels across communities — lot alone not unique
const lotDupes = db
  .prepare(
    `SELECT lot_label, COUNT(DISTINCT community_name) AS communities, COUNT(*) AS rows
     FROM (
       SELECT lg.lot_label, cs.community_name FROM lot_groups lg
       JOIN community_sections cs ON cs.id = lg.section_id
       JOIN permit_records p ON p.lot_group_id = lg.id
       WHERE p.record_origin = 'import'
         AND (p.primary_official_id IS NULL OR p.primary_official_id = '')
     )
     GROUP BY lot_label HAVING communities > 1 OR rows > 3
     ORDER BY rows DESC LIMIT 15`
  )
  .all();

// Candidate strategies (evidence-only; none auto-accepted)
const candidates = [];
for (const row of idless.slice(0, 50)) {
  const evidence = {
    project_code: row.project_code,
    community_name: row.community_name,
    lot_label: row.lot_label,
    housetype: row.housetype,
    jurisdiction_suggestion: row.jurisdiction_code,
    notes_excerpt: (row.notes_raw || '').slice(0, 120),
  };

  // Community + housetype soft match to masterfile neighborhood/product
  const mfHits = masterfile.filter(
    (m) =>
      m.neighborhood &&
      row.community_name &&
      String(m.neighborhood).toLowerCase().includes(String(row.community_name).toLowerCase().slice(0, 6))
  );
  if (mfHits.length === 1 && JSON.parse(mfHits[0].official_ids_json || '[]').length) {
    candidates.push({
      permit_record_id: row.id,
      strategy: 'masterfile_neighborhood_unique',
      confidence: 'low',
      evidence: { ...evidence, masterfile: mfHits[0], note: 'Unique neighborhood hit — still needs review; not auto-linked' },
      status: 'needs_review',
    });
  } else if (mfHits.length > 1) {
    candidates.push({
      permit_record_id: row.id,
      strategy: 'masterfile_neighborhood_ambiguous',
      confidence: 'none',
      evidence: { ...evidence, hitCount: mfHits.length },
      status: 'needs_review',
    });
  }

  // MST: never auto-associate — only flag if community text appears in MST context
  const mstHits = mst.filter(
    (m) =>
      row.community_name &&
      String(m.product_or_context || '')
        .toLowerCase()
        .includes(String(row.community_name).toLowerCase().slice(0, 8))
  );
  if (mstHits.length) {
    candidates.push({
      permit_record_id: row.id,
      strategy: 'mst_context_mention',
      confidence: 'none',
      evidence: {
        ...evidence,
        mstHits: mstHits.slice(0, 3),
        note: 'MST context mention only — NO auto-associate with lot permits',
      },
      status: 'needs_review',
    });
  }
}

const ins = db.prepare(
  `INSERT INTO idless_match_candidates(permit_record_id, strategy, evidence_json, confidence, status)
   VALUES (?, ?, ?, ?, ?)`
);
const tx = db.transaction(() => {
  for (const c of candidates) {
    ins.run(c.permit_record_id, c.strategy, JSON.stringify(c.evidence), c.confidence, c.status);
  }
});
tx();

const accepted = candidates.filter((c) => c.status === 'accepted'); // always empty this milestone

const report = {
  generatedAt: new Date().toISOString(),
  workbook: WORKBOOK,
  importSummary: summary,
  signals,
  lotLabelNotUnique: lotDupes,
  candidateStrategiesTried: [
    'masterfile_neighborhood_unique (low confidence, review only)',
    'masterfile_neighborhood_ambiguous',
    'mst_context_mention (explicitly not auto-linked)',
  ],
  candidatesStored: candidates.length,
  acceptedMatches: accepted.length,
  minimalAdditionalInputNeeded: [
    'Site address or GPIN/parcel for official portal search',
    'Operator-confirmed AHJ per record type (town vs county)',
    'Authorized company system export if addresses live only in internal tools',
  ],
  conclusion:
    'Workbook ID-less rows have community + lot/range + housetype + occasional notes. Lot alone is not unique. No public search can reconstruct missing addresses/parcels. No accepted automatic matches this milestone; MST never auto-associated.',
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outJson = path.join(__dirname, '..', '..', 'docs', 'idless-matching.json');
const outMd = path.join(__dirname, '..', '..', 'docs', 'idless-matching.md');
fs.writeFileSync(outJson, JSON.stringify(report, null, 2));
fs.writeFileSync(
  outMd,
  `# ID-less matching investigation

Generated: ${report.generatedAt}

## Signals (import-origin ID-less shells)
| Signal | Count |
|--------|------:|
| Total ID-less | ${signals.total_idless} |
| With lot label | ${signals.with_lot_label} |
| Lot ranges | ${signals.with_lot_range} |
| Housetype | ${signals.with_housetype} |
| Notes text | ${signals.with_notes} |
| Street-like notes | ${signals.with_street_like_notes} |
| Parcel-like notes | ${signals.with_parcel_like} |

## Lot uniqueness
Lot labels repeat across communities — **lot alone is not unique**.

Sample duplicates:
${lotDupes.map((d) => `- \`${d.lot_label}\`: ${d.rows} rows across ${d.communities} communities`).join('\n')}

## Candidates
- Stored for review: **${candidates.length}**
- Auto-accepted: **${accepted.length}** (none)

MST IDs are **never** auto-associated with lot permits.

## Minimal additional input
${report.minimalAdditionalInputNeeded.map((x) => `- ${x}`).join('\n')}

## Conclusion
${report.conclusion}
`
);
console.log(JSON.stringify({ outJson, outMd, signals, candidates: candidates.length }, null, 2));
