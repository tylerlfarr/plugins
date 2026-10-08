/**
 * Compatibility shim — prefer workbookImport.js.
 * Kept so existing imports/tests continue to resolve.
 */
export {
  parseWorkbookBuffer,
  commitWorkbookParse,
  importWorkbookFile,
  parseWorkbookDate,
  extractOfficialIds,
  normalizeOfficialId,
  suggestJurisdictionFromId,
  stableLotKey,
  detectPermitTrackerSections,
  parseGospelBuffer,
  commitGospelParse,
  importGospelFile,
  isFairfaxShapedId,
  guessJurisdictionFromId,
} from './workbookImport.js';
