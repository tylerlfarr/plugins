#!/usr/bin/env node
/**
 * Coverage for import-origin workbook records only.
 * Excludes fixtures, demo/test probes, and injected change-detection records.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, migrate } from '../db.js';
import { importWorkbookFile } from '../workbookImport.js';
import { checkPermit } from '../connectors/index.js';
import { ensureSourceRegistrySeeded, listSources } from '../sources/registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', '..', 'docs', 'coverage-report.json');
const MD_OUT = path.join(__dirname, '..', '..', 'docs', 'coverage-matrix.md');
const WORKBOOK =
  process.env.SOURCE_WORKBOOK_XLSX ||
  '/cursor/stores/self/internal/Permit_Tracker_9.1.2026.xlsx';

migrate();
ensureSourceRegistrySeeded();

async function main() {
  if (!fs.existsSync(WORKBOOK)) {
    console.error('Source workbook missing:', WORKBOOK);
    process.exit(1);
  }

  db.exec(`
    DELETE FROM attention_events; DELETE FROM match_reviews; DELETE FROM import_conflicts;
    DELETE FROM field_changes; DELETE FROM official_snapshots; DELETE FROM official_ids;
    DELETE FROM internal_milestones; DELETE FROM permit_records; DELETE FROM lot_groups;
    DELETE FROM community_sections; DELETE FROM permit_revisions; DELETE FROM plan_tracker_rows;
    DELETE FROM mst_reference_ids; DELETE FROM archived_sheet_rows; DELETE FROM import_runs;
    DELETE FROM idless_match_candidates;
  `);
  const { summary, parsed } = importWorkbookFile(WORKBOOK);

  const demoCount = db
    .prepare(`SELECT COUNT(*) AS c FROM permit_records WHERE record_origin != 'import'`)
    .get().c;

  const withIds = db
    .prepare(
      `SELECT p.id, p.primary_official_id AS official_id, p.jurisdiction_code,
              p.jurisdiction_source, p.jurisdiction_confirmed, p.authority_note
       FROM permit_records p
       WHERE p.record_origin = 'import'
         AND p.primary_official_id IS NOT NULL AND p.primary_official_id != ''
       ORDER BY p.jurisdiction_code, p.primary_official_id`
    )
    .all();

  const byJur = {};
  for (const row of withIds) {
    byJur[row.jurisdiction_code] = byJur[row.jurisdiction_code] || [];
    byJur[row.jurisdiction_code].push(row);
  }

  const attempts = [];
  for (const row of withIds) {
    // eslint-disable-next-line no-await-in-loop
    const result = await checkPermit({
      jurisdictionCode: row.jurisdiction_code,
      officialId: row.official_id,
      allowSynthetic: false,
      recordOrigin: 'import',
    });
    attempts.push({
      official_id: row.official_id,
      jurisdiction_code: row.jurisdiction_code,
      jurisdiction_source: row.jurisdiction_source,
      jurisdiction_confirmed: row.jurisdiction_confirmed,
      outcome: result.outcome,
      mode: result.mode,
      native: result.sourceNativeStatus || null,
      error: result.error || null,
      usefulFields: result.fields
        ? Object.keys(result.fields).filter((k) => result.fields[k] != null && result.fields[k] !== '')
        : [],
      connectorStatus: result.connectorStatus || null,
    });
  }

  const liveMatches = attempts.filter((a) => a.mode === 'live' && (a.native || ['updated', 'no_change'].includes(a.outcome)));
  const unsupported = attempts.filter((a) => a.outcome === 'unavailable');
  const idless = db
    .prepare(
      `SELECT COUNT(*) AS c FROM permit_records WHERE record_origin = 'import'
       AND (primary_official_id IS NULL OR primary_official_id = '')`
    )
    .get().c;

  const jurBreakdown = db
    .prepare(
      `SELECT jurisdiction_code, jurisdiction_source, jurisdiction_confirmed, COUNT(*) AS c
       FROM permit_records WHERE record_origin = 'import'
       GROUP BY 1,2,3 ORDER BY c DESC`
    )
    .all();

  const report = {
    generatedAt: new Date().toISOString(),
    workbook: WORKBOOK,
    exclusions: {
      demo_fixture_injected_permits: demoCount,
      note: 'Import-origin only. Fixtures, demo/test probes, and controlled change-detection injections excluded.',
    },
    entityCounts: {
      sheets_in_workbook: parsed.sheets,
      community_sections: summary.sections,
      lot_groups: db.prepare(`SELECT COUNT(*) AS c FROM lot_groups WHERE record_origin='import'`).get().c,
      permit_records: db.prepare(`SELECT COUNT(*) AS c FROM permit_records WHERE record_origin='import'`).get().c,
      with_official_id: withIds.length,
      without_official_id: idless,
      revisions: summary.revisions,
      masterfile: summary.masterfile,
      mst_ids: summary.mst_ids,
      multi_record_rows: summary.multi_records,
      match_reviews: summary.reviews,
    },
    jurisdictionNote:
      'Utility/geography headers suggest county only; jurisdiction_confirmed=0 until operator confirms AHJ per record type.',
    jurisdictionBreakdown: jurBreakdown,
    workbookIdsAttemptedByJurisdiction: Object.fromEntries(
      Object.entries(byJur).map(([k, rows]) => [k, rows.map((r) => r.official_id)])
    ),
    liveMatches: {
      count: liveMatches.length,
      results: liveMatches,
      note: 'Baselines only — no injected later changes counted as observed government transitions',
    },
    attempts,
    unsupported: {
      count: unsupported.length,
      reasons: [...new Set(unsupported.map((u) => u.error).filter(Boolean))],
      results: unsupported,
    },
    idless: {
      count: idless,
      acceptedMatches: 0,
      see: 'docs/idless-matching.md',
    },
    registry: listSources().map((s) => ({
      key: s.key,
      jurisdiction_code: s.jurisdiction_code,
      state: s.state,
      activated: s.activated,
      adapter_type: s.adapter_type,
    })),
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

  const md = `# Coverage matrix (import-origin only)

Generated: ${report.generatedAt}

## Exclusions
- Demo / fixture / injected test permits in DB after import: **${demoCount}**
- Controlled change-detection flips are **not** counted as observed government transitions.

## Entity counts
| Entity | Count |
|--------|------:|
| Sections | ${summary.sections} |
| Lot groups | ${report.entityCounts.lot_groups} |
| Permit records | ${report.entityCounts.permit_records} |
| With official ID | ${withIds.length} |
| ID-less | ${idless} |
| Multi-record expansions | ${summary.multi_records} |

## Jurisdiction (suggested ≠ confirmed)
${jurBreakdown.map((j) => `- **${j.jurisdiction_code}** (${j.jurisdiction_source}, confirmed=${j.jurisdiction_confirmed}): ${j.c}`).join('\n')}

${report.jurisdictionNote}

## Workbook IDs attempted
${Object.entries(report.workbookIdsAttemptedByJurisdiction)
  .map(([k, ids]) => `- ${k}: ${ids.length} → ${ids.join(', ')}`)
  .join('\n')}

## Live matches (mode=live)
- Count: **${liveMatches.length}**
${liveMatches.length ? liveMatches.map((r) => `- \`${r.official_id}\` → ${r.native || r.outcome} · fields: ${(r.usefulFields || []).join(', ')}`).join('\n') : '_None among import-origin workbook IDs (Fairfax County PLUS has no confirmed workbook rows)._'}

## Unsupported / unavailable
- Count: **${unsupported.length}**
${[...new Set(unsupported.map((u) => u.error))].map((e) => `- ${e}`).join('\n')}

## ID-less
- Shells: **${idless}** · accepted automatic matches: **0** (see idless-matching.md)

## Registry snapshot
${report.registry.map((s) => `- \`${s.key}\` [${s.jurisdiction_code}] state=${s.state} activated=${s.activated}`).join('\n')}
`;
  fs.writeFileSync(MD_OUT, md);
  console.log(
    JSON.stringify(
      {
        out: OUT,
        withIds: withIds.length,
        liveMatches: liveMatches.length,
        unavailable: unsupported.length,
        idless,
        jurBreakdown,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
