import { buildSampleWorkbook, parseWorkbook, suggestMapping, validateMappedRows, commitImport } from '../excel.js';
import { seed } from '../seed.js';

seed();
const buf = buildSampleWorkbook();
const parsed = parseWorkbook(Buffer.from(buf));
const mapping = suggestMapping(parsed.headers);
const preview = validateMappedRows(parsed.rows, mapping);
const result = commitImport(preview);
console.log(JSON.stringify({ mapping, summary: result }, null, 2));
