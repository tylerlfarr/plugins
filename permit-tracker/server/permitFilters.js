/**
 * Shared permit filter definition for list, saved presets, and export.
 * Keep listing and export in exact ID agreement for the same query params.
 */
import { getReadinessRuleset } from './readiness.js';

export const PERMIT_FILTER_KEYS = [
  'q',
  'jurisdiction_code',
  'official_status',
  'internal_status',
  'readiness_state',
  'approaching_start',
  'missing_property',
  'contacts_available',
  'contact_review_needed',
  'has_official_id',
  'fairfax_shaped',
  'use_classification',
  'include_demo',
];

/** Normalize query/body filters into a plain object of non-empty strings. */
export function normalizePermitFilters(raw = {}) {
  const out = {};
  for (const key of PERMIT_FILTER_KEYS) {
    if (raw[key] == null || raw[key] === '') continue;
    out[key] = String(raw[key]);
  }
  return out;
}

/**
 * Build WHERE fragment + params for permit_records joins used by list/export.
 * Assumes aliases: p (permit_records), lg (lot_groups), cs (community_sections),
 * and LEFT JOIN readiness_assessments ra.
 *
 * @param {object} filters normalized filters
 * @param {{ selectedIds?: number[], selectedOnly?: boolean }} opts
 *   - selectedIds: restrict to those IDs (import origin unless include_demo)
 *   - selectedOnly: when true with selectedIds, ignore q/status/etc. filters
 *     so Export selected is independent of the current table filter
 */
export function buildPermitFilterClause(filters = {}, opts = {}) {
  const selectedIds = Array.isArray(opts.selectedIds)
    ? opts.selectedIds.map(Number).filter((n) => Number.isFinite(n) && n > 0)
    : null;
  const selectedOnly = Boolean(opts.selectedOnly) && selectedIds && selectedIds.length > 0;
  const f = selectedOnly ? normalizePermitFilters({ include_demo: filters.include_demo }) : normalizePermitFilters(filters);
  let sql = '';
  const params = [];

  if (f.include_demo !== 'true') {
    sql += ` AND p.record_origin = 'import'`;
  }

  if (selectedIds && selectedIds.length) {
    sql += ` AND p.id IN (${selectedIds.map(() => '?').join(',')})`;
    params.push(...selectedIds);
  } else if (opts.selectedIds && Array.isArray(opts.selectedIds) && opts.selectedIds.length === 0) {
    sql += ' AND 1=0';
  }

  if (f.q) {
    sql += ` AND (
      cs.community_name LIKE ? OR cs.project_code LIKE ? OR lg.lot_label LIKE ?
      OR lg.housetype LIKE ? OR IFNULL(p.primary_official_id,'') LIKE ?
      OR lg.notes_raw LIKE ? OR p.owner LIKE ?
    )`;
    const like = `%${f.q}%`;
    params.push(like, like, like, like, like, like, like);
  }
  if (f.jurisdiction_code) {
    sql += ' AND p.jurisdiction_code = ?';
    params.push(f.jurisdiction_code);
  }
  if (f.official_status) {
    sql += ' AND p.official_status = ?';
    params.push(f.official_status);
  }
  if (f.internal_status) {
    sql += ' AND p.internal_status = ?';
    params.push(f.internal_status);
  }
  if (f.use_classification) {
    sql += ' AND p.use_classification = ?';
    params.push(f.use_classification);
  }
  if (f.readiness_state) {
    sql += ' AND p.readiness_state = ?';
    params.push(f.readiness_state);
  }
  if (f.approaching_start === 'true') {
    sql += ` AND ra.target_start IS NOT NULL AND ra.days_to_start IS NOT NULL
             AND ra.days_to_start >= 0 AND ra.days_to_start <= ?`;
    params.push(Number(getReadinessRuleset().approachingStartDays || 45));
  }
  if (f.missing_property === 'true') {
    sql += ` AND NOT EXISTS (
      SELECT 1 FROM property_links pl
      WHERE pl.lot_group_id = lg.id AND pl.link_state IN ('candidate','confirmed')
    )`;
  }
  if (f.contacts_available === 'true') {
    sql += ` AND EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.lot_group_id = lg.id AND c.status IN ('candidate','confirmed')
        AND c.record_origin != 'sandbox_demo'
    )`;
  }
  if (f.contact_review_needed === 'true') {
    sql += ` AND EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.lot_group_id = lg.id AND c.status = 'candidate'
        AND c.record_origin != 'sandbox_demo'
    )`;
  }
  if (f.has_official_id === 'true') {
    sql += ` AND p.primary_official_id IS NOT NULL AND p.primary_official_id != ''`;
  }
  if (f.fairfax_shaped === 'true') {
    sql += ` AND (
      p.primary_official_id GLOB 'ALTC-*'
      OR p.primary_official_id GLOB 'ALTR-*'
      OR p.primary_official_id GLOB 'BLDR-*'
      OR p.primary_official_id GLOB 'BLDC-*'
    )`;
  }

  return { sql, params, filters: f };
}

/** True when any operator filter (including q) is active. */
export function hasActivePermitFilters(filters = {}) {
  const f = normalizePermitFilters(filters);
  return Object.keys(f).some((k) => k !== 'include_demo' && f[k]);
}
