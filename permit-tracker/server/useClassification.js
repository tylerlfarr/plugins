/**
 * Building use classification (residential / commercial / mixed-use / unknown).
 *
 * Separate from work type (permit_kind: building, alteration, demolition, trade).
 * Prefer explicit official use labels. Map jurisdiction-specific permit types only
 * where the official type string itself states the use. Never infer from permit-ID
 * prefixes, zoning codes, or property-owner names.
 */

export const USE_CLASSES = Object.freeze({
  RESIDENTIAL: 'residential',
  COMMERCIAL: 'commercial',
  MIXED_USE: 'mixed_use',
  UNKNOWN: 'unknown',
});

export const USE_CLASS_LABELS = Object.freeze({
  residential: 'Residential',
  commercial: 'Commercial',
  mixed_use: 'Mixed-use',
  unknown: 'Unknown',
});

export const USE_SOURCES = Object.freeze({
  OFFICIAL_LABEL: 'official_label',
  IMPORT_EXPLICIT: 'import_explicit',
  MANUAL_OVERRIDE: 'manual_override',
  UNKNOWN_DEFAULT: 'unknown_default',
});

const VALID = new Set(Object.values(USE_CLASSES));

/**
 * Classify from an official jurisdiction use/type label.
 * Only when the label itself explicitly names residential, commercial, or mixed-use.
 * Ambiguous / trade / work-type-only labels → unknown.
 */
export function classifyFromOfficialLabel(rawLabel) {
  const label = String(rawLabel || '').trim();
  if (!label) {
    return { use: USE_CLASSES.UNKNOWN, source: USE_SOURCES.UNKNOWN_DEFAULT, label: '' };
  }
  const lower = label.toLowerCase();

  // Explicit mixed-use first
  if (/\bmixed[\s-]?use\b/.test(lower) || /\bmixed\s+occupancy\b/.test(lower)) {
    return { use: USE_CLASSES.MIXED_USE, source: USE_SOURCES.OFFICIAL_LABEL, label };
  }

  const hasRes =
    /\bresidential\b/.test(lower) ||
    /\bsingle[\s-]?family\b/.test(lower) ||
    /\bmulti[\s-]?family\b/.test(lower) ||
    /\btownhome\b/.test(lower) ||
    /\btownhouse\b/.test(lower) ||
    /\bcondo(minium)?\b/.test(lower) ||
    /\bdwelling\b/.test(lower);
  const hasCom =
    /\bcommercial\b/.test(lower) ||
    /\bindustrial\b/.test(lower) ||
    /\boffice\b/.test(lower) ||
    /\bretail\b/.test(lower) ||
    /\bwarehouse\b/.test(lower);

  if (hasRes && hasCom) {
    return { use: USE_CLASSES.MIXED_USE, source: USE_SOURCES.OFFICIAL_LABEL, label };
  }
  if (hasRes) {
    return { use: USE_CLASSES.RESIDENTIAL, source: USE_SOURCES.OFFICIAL_LABEL, label };
  }
  if (hasCom) {
    return { use: USE_CLASSES.COMMERCIAL, source: USE_SOURCES.OFFICIAL_LABEL, label };
  }

  // Documented Fairfax APPTYPEALIAS patterns that state use in the alias text only.
  // No ID-prefix inference (BLD/BLDC/COMM codes alone → unknown).
  return { use: USE_CLASSES.UNKNOWN, source: USE_SOURCES.UNKNOWN_DEFAULT, label };
}

/**
 * Fairfax: use APPTYPEALIAS / permitType only when the alias text states use.
 * Availability: APPTYPEALIAS is live; many records are work-type-only → Unknown.
 */
export function classifyFairfaxPermitType(permitTypeAlias) {
  return classifyFromOfficialLabel(permitTypeAlias);
}

export function normalizeUseClass(value) {
  const v = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  if (v === 'mixed-use' || v === 'mixeduse') return USE_CLASSES.MIXED_USE;
  if (VALID.has(v)) return v;
  return null;
}

export function computeEffectiveUse({
  officialUse = '',
  officialLabel = '',
  manualUse = null,
  importUse = null,
} = {}) {
  const manual = normalizeUseClass(manualUse);
  if (manual) {
    return {
      use_classification: manual,
      use_classification_source: USE_SOURCES.MANUAL_OVERRIDE,
      use_classification_official: normalizeUseClass(officialUse) || USE_CLASSES.UNKNOWN,
      use_classification_official_label: officialLabel || '',
    };
  }
  const official = normalizeUseClass(officialUse);
  if (official && official !== USE_CLASSES.UNKNOWN) {
    return {
      use_classification: official,
      use_classification_source: USE_SOURCES.OFFICIAL_LABEL,
      use_classification_official: official,
      use_classification_official_label: officialLabel || '',
    };
  }
  const imported = normalizeUseClass(importUse);
  if (imported && imported !== USE_CLASSES.UNKNOWN) {
    return {
      use_classification: imported,
      use_classification_source: USE_SOURCES.IMPORT_EXPLICIT,
      use_classification_official: official || USE_CLASSES.UNKNOWN,
      use_classification_official_label: officialLabel || '',
    };
  }
  return {
    use_classification: USE_CLASSES.UNKNOWN,
    use_classification_source: USE_SOURCES.UNKNOWN_DEFAULT,
    use_classification_official: official || USE_CLASSES.UNKNOWN,
    use_classification_official_label: officialLabel || '',
  };
}

/** Apply official classification from a connector result without clearing manual override. */
export function applyOfficialUseToPermit(db, permitId, officialLabel, { actor = 'connector' } = {}) {
  const classified = classifyFromOfficialLabel(officialLabel);
  const row = db.prepare(`SELECT * FROM permit_records WHERE id = ?`).get(Number(permitId));
  if (!row) return null;
  const effective = computeEffectiveUse({
    officialUse: classified.use,
    officialLabel: classified.label || officialLabel || '',
    manualUse: row.use_classification_manual,
  });
  db.prepare(
    `UPDATE permit_records SET
       use_classification = ?,
       use_classification_official = ?,
       use_classification_official_label = ?,
       use_classification_source = ?,
       updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    effective.use_classification,
    effective.use_classification_official,
    effective.use_classification_official_label,
    effective.use_classification_source,
    permitId
  );
  return db.prepare(`SELECT * FROM permit_records WHERE id = ?`).get(Number(permitId));
}

export function setManualUseOverride(db, permitId, useClass, { actor = 'ui' } = {}) {
  const row = db.prepare(`SELECT * FROM permit_records WHERE id = ?`).get(Number(permitId));
  if (!row) throw new Error('Permit not found');
  // Clearing override: pass empty string / null
  const clear = useClass === '' || useClass === null || useClass === undefined;
  const normalized = clear ? null : normalizeUseClass(useClass);
  if (!clear && !normalized) throw new Error(`Invalid use classification: ${useClass}`);
  db.prepare(
    `UPDATE permit_records SET
       use_classification_manual = ?,
       use_classification_manual_by = ?,
       use_classification_manual_at = CASE WHEN ? THEN NULL ELSE datetime('now') END,
       updated_at = datetime('now')
     WHERE id = ?`
  ).run(clear ? null : normalized, clear ? null : actor, clear ? 1 : 0, permitId);

  const refreshed = db.prepare(`SELECT * FROM permit_records WHERE id = ?`).get(Number(permitId));
  const effective = computeEffectiveUse({
    officialUse: refreshed.use_classification_official,
    officialLabel: refreshed.use_classification_official_label,
    manualUse: refreshed.use_classification_manual,
  });
  db.prepare(
    `UPDATE permit_records SET
       use_classification = ?,
       use_classification_source = ?,
       updated_at = datetime('now')
     WHERE id = ?`
  ).run(effective.use_classification, effective.use_classification_source, permitId);
  return db.prepare(`SELECT * FROM permit_records WHERE id = ?`).get(Number(permitId));
}
