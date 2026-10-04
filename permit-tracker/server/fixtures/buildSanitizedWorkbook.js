/**
 * Build a sanitized mini workbook mirroring Permit Tracker structure.
 * No employer names, private addresses, or live credentials.
 */
import XLSX from 'xlsx';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function nearIso(daysFromNow) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const y = String(d.getUTCFullYear()).slice(2);
  return `${m}/${day}/${y}`;
}

export function buildSanitizedWorkbookBuffer() {
  const wb = XLSX.utils.book_new();

  const pt = [];
  pt.push([
    'Proj ID',
    'Lot',
    'Housetype',
    'Permit Release',
    'PW W/S Ordered',
    'PW W/S Received',
    'Target Start Date',
    'Water & Sewer Paid',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    'Permit time: PW sample',
  ]);
  pt.push([
    'DEMO1',
    'ID',
    '',
    'Release',
    'Ordered',
    'Received',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
  ]);
  // Blocked: Received still APPLY; open revision; approaching target start
  pt.push([
    'Demo Community Alpha',
    '1-4',
    'Townhome A',
    '4/1/26',
    '4/2/26',
    'APPLY',
    nearIso(10),
    '4/5/26',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    'ZNA2026-04510 / BLD2026-04765',
  ]);
  // Ready under workbook rules (no official ID → no AHJ gap)
  pt.push([
    'Demo Community Alpha',
    '10',
    'Single B',
    '4/3/26',
    '4/4/26',
    '4/6/26',
    nearIso(45),
    '4/7/26',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
  ]);
  pt.push([
    'Proj ID',
    'Lot',
    'Housetype',
    'Permit',
    'LoCo Water Ordered',
    'LoCo Water Received',
    'Target Start Date',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    'Permit time: LoCo sample',
  ]);
  pt.push([
    'CAMX',
    'ID',
    '',
    'Release',
    'Ordered',
    'Received',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
  ]);
  // Workbook prereqs complete (na waived) but ID never live-checked → needs_verification
  pt.push([
    'Demo Cascades Block',
    '96-100',
    'Condo C',
    '5/1/26',
    '5/2/26',
    'na',
    nearIso(5),
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    'BLDC-2026-040694',
  ]);
  // Missing utility ordered/received → blocked
  pt.push([
    'Demo Cascades Block',
    '200',
    'Alt Unit',
    '6/1/26',
    '',
    '',
    nearIso(60),
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    'ALTC-2026-00970',
  ]);

  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(pt), 'Permit Tracker');

  const rev = [
    ['Community', 'Lot', 'Revised', 'Submitted', 'Received', 'Reason'],
    ['code', '', 'start', '', 'permit', ''],
    ['DEMO1', '1-4', '4/10/26', '4/11/26', '', 'Sample revision'],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rev), 'Permit Revisions');

  const mf = [
    [
      'House',
      'Product',
      'Counties',
      'Neighborhood',
      'Requested',
      'Ready',
      'Submitted',
      'Comments',
      'Resub',
      'Approved',
      'Notes',
    ],
    [
      'TH',
      'Product X',
      'Prince William',
      'Alpha',
      '3/1/26',
      '3/5/26',
      '3/6/26',
      '',
      '',
      '',
      'MST2026-00001',
    ],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(mf), 'Masterfile Plan Tracker');

  const mst = [
    ['Loudoun', '', 'PWC', '', 'Fairfax', '', '', 'Other'],
    ['', '', '', '', '', '', '', ''],
    ['MASTR-2026-00001', '', 'MST2026-00002', '', 'ALTC-2026-00970', '', '', ''],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(mst), "MST's");

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['fee', 'amount'],
      ['sample', 1],
    ]),
    'Indirect Cost'
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['legacy']]), '2018 IRC Tracker');
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([['corewall']]),
    'Corewall Alternative Tracker'
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['whsd']]), 'WHSD Masterfile');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

export function writeSanitizedFixture(outPath) {
  const buf = buildSanitizedWorkbookBuffer();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
  return outPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = path.join(__dirname, 'sanitized-source-workbook.xlsx');
  writeSanitizedFixture(out);
  console.log('Wrote', out);
}
