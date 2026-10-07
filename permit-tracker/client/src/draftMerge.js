/** Editable permit fields subject to draft / server three-way merge. */
export const EDITABLE_PERMIT_FIELDS = [
  'primary_official_id',
  'jurisdiction_code',
  'internal_status',
  'owner',
  'next_action',
  'next_action_due',
  'source_url',
  'permit_kind',
  'jurisdiction_confirmed',
];

export const FIELD_LABELS = {
  primary_official_id: 'Primary official ID',
  jurisdiction_code: 'Jurisdiction',
  internal_status: 'Internal status',
  owner: 'Assigned to',
  next_action: 'Next action',
  next_action_due: 'Next action due',
  source_url: 'Source URL',
  permit_kind: 'Permit kind',
  jurisdiction_confirmed: 'Jurisdiction confirmed',
};

function norm(v) {
  if (v === true || v === 1 || v === '1') return '1';
  if (v === false || v === 0 || v === '0') return '0';
  if (v == null) return '';
  return String(v);
}

export function fieldEqual(a, b) {
  return norm(a) === norm(b);
}

/**
 * Three-way classify each editable field.
 * base = values when the draft started (last clean server copy)
 * draft = current form
 * server = latest server row
 */
export function classifyFieldDiffs(base, draft, server, fields = EDITABLE_PERMIT_FIELDS) {
  const rows = [];
  for (const key of fields) {
    const b = base?.[key];
    const d = draft?.[key];
    const s = server?.[key];
    const draftChanged = !fieldEqual(d, b);
    const serverChanged = !fieldEqual(s, b);
    let status = 'unchanged';
    if (draftChanged && serverChanged && !fieldEqual(d, s)) status = 'conflict';
    else if (draftChanged && serverChanged) status = 'same_change';
    else if (draftChanged) status = 'draft_only';
    else if (serverChanged) status = 'server_only';
    rows.push({
      key,
      label: FIELD_LABELS[key] || key,
      base: b,
      draft: d,
      server: s,
      status,
    });
  }
  return rows;
}

/**
 * Build PATCH body from merge decisions.
 * decisions: { [field]: 'draft' | 'server' } — required for conflict rows;
 * draft_only defaults to draft; server_only / unchanged / same_change → omit (keep server).
 * Only includes fields that should change relative to current server.
 */
export function buildPatchFromDecisions(diffs, decisions, server) {
  const patch = {};
  for (const row of diffs) {
    let choice = decisions[row.key];
    if (row.status === 'draft_only') choice = choice || 'draft';
    if (row.status === 'conflict') {
      if (choice !== 'draft' && choice !== 'server') {
        throw new Error(`Choice required for ${row.label}`);
      }
    }
    if (row.status === 'server_only' || row.status === 'unchanged' || row.status === 'same_change') {
      continue;
    }
    if (choice === 'draft') {
      const value = row.draft;
      if (!fieldEqual(value, server?.[row.key])) {
        patch[row.key] =
          row.key === 'jurisdiction_confirmed' ? Boolean(Number(value) || value === true) : value;
      }
    }
    // choice === 'server' → omit (already on server)
  }
  return patch;
}

/** Dirty vs last clean server copy (operator form fields only). */
export function isPermitDraftDirty(detail, detailServer) {
  if (!detail || !detailServer) return false;
  return EDITABLE_PERMIT_FIELDS.some((k) => !fieldEqual(detail[k], detailServer[k]));
}

/** Partial PATCH: only keys that differ from base (detailServer). */
export function dirtyPermitPatch(detail, detailServer) {
  if (!detail) return {};
  const patch = {};
  for (const key of EDITABLE_PERMIT_FIELDS) {
    if (detailServer && fieldEqual(detail[key], detailServer[key])) continue;
    let value = detail[key];
    if (key === 'jurisdiction_confirmed') {
      value = Boolean(Number(value) || value === true);
    }
    patch[key] = value ?? '';
  }
  return patch;
}
