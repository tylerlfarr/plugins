/**
 * Short daily-workflow demo for lot-readiness.
 * Uses sanitized fixture by default; pass --source to use store workbook if present.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const useSource = process.argv.includes('--source');
const sourcePath =
  process.env.SOURCE_WORKBOOK_XLSX ||
  '/cursor/stores/self/internal/Permit_Tracker_9.1.2026.xlsx';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permit-lr-demo-'));
process.env.PERMIT_DB_PATH = path.join(tmpDir, 'demo.sqlite');
process.env.PERMIT_DEMO = '0';

const { buildSanitizedWorkbookBuffer } = await import('../fixtures/buildSanitizedWorkbook.js');
const { parseWorkbookBuffer, commitWorkbookParse, importWorkbookFile } = await import(
  '../workbookImport.js'
);
const { db } = await import('../db.js');
const { rebuildAttention } = await import('../sync.js');
const { assessPermitReadiness, rebuildAllReadiness } = await import('../readiness.js');

let label = 'sanitized fixture';
if (useSource && fs.existsSync(sourcePath)) {
  importWorkbookFile(sourcePath, path.basename(sourcePath));
  label = sourcePath;
} else {
  commitWorkbookParse(parseWorkbookBuffer(buildSanitizedWorkbookBuffer()));
}

const counts = rebuildAllReadiness().counts;
rebuildAttention();

const samples = db
  .prepare(
    `SELECT p.id, p.readiness_state, p.primary_official_id, lg.lot_label, cs.project_code, cs.community_name,
            ra.target_start, ra.days_to_start, ra.summary
     FROM permit_records p
     JOIN lot_groups lg ON lg.id = p.lot_group_id
     JOIN community_sections cs ON cs.id = lg.section_id
     LEFT JOIN readiness_assessments ra ON ra.permit_record_id = p.id
     WHERE p.record_origin = 'import'
     ORDER BY
       CASE p.readiness_state WHEN 'blocked' THEN 0 WHEN 'needs_verification' THEN 1 ELSE 2 END,
       IFNULL(ra.days_to_start, 9999), p.id
     LIMIT 8`
  )
  .all();

const attention = db
  .prepare(
    `SELECT kind, COUNT(*) AS c FROM attention_events
     WHERE resolved_at IS NULL AND acknowledged = 0 GROUP BY kind ORDER BY c DESC`
  )
  .all();

const demo = {
  title: 'Daily lot-readiness demo',
  source: label,
  counts,
  attentionByKind: Object.fromEntries(attention.map((a) => [a.kind, a.c])),
  morningList: samples.map((s) => {
    const a = assessPermitReadiness(s.id);
    return {
      project: s.project_code,
      community: s.community_name,
      lot: s.lot_label,
      official_id: s.primary_official_id,
      readiness: s.readiness_state,
      target_start: s.target_start,
      days_to_start: s.days_to_start,
      outstanding: (a?.outstanding || []).map((o) => o.label),
      gaps: (a?.gaps || []).map((g) => g.label),
      summary: s.summary,
    };
  }),
  operatorNotes: [
    'Ready = all configured workbook prerequisites satisfied/waived under rules.',
    'Blocked = outstanding date/status evidence (blank section columns or APPLY/rqst).',
    'Needs verification = ambiguous text, open revision impact, or AHJ automation gap.',
    'Open revisions flag lots for review — do not auto-declare permits invalid.',
  ],
};

const outPath = path.join(__dirname, '../../docs/lot-readiness-demo.json');
fs.writeFileSync(outPath, JSON.stringify(demo, null, 2));
console.log(JSON.stringify(demo, null, 2));
console.log('Wrote', outPath);
