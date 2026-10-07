import {
  db,
  getSetting,
  recordChange,
  upsertAttention,
  resolveAttentionByCondition,
  resolveSourceAttentionForPermit,
  isDemoMode,
} from './db.js';
import { checkPermit } from './connectors/index.js';
import {
  updateLotReadiness,
  rebuildAllReadiness,
  getStoredAssessment,
  READINESS_STATES,
} from './readiness.js';
import { applyOfficialUseToPermit } from './useClassification.js';
import { listSources } from './sources/registry.js';
import { bumpPermitRowVersion } from './rowVersion.js';

/** Explicit test bypass only — never enable on Hostinger / production. */
export function sourceEligibilityBypassed() {
  return process.env.PERMIT_BYPASS_SOURCE_ELIGIBILITY === '1';
}

/**
 * Operational live checks require an activated verified/degraded source for the
 * permit's jurisdiction AND confirmed jurisdiction mapping.
 * Demo/fixture records skip this gate (still cannot invent live statuses).
 */
export function evaluateCheckEligibility(permit) {
  if (sourceEligibilityBypassed()) {
    return { ok: true, bypass: true };
  }
  const origin = permit.record_origin || 'import';
  if (origin === 'demo' || origin === 'fixture') {
    return { ok: true, demo: true };
  }
  if (!permit.jurisdiction_confirmed) {
    return {
      ok: false,
      outcome: 'blocked',
      error:
        'Jurisdiction not confirmed. Confirm AHJ mapping before operational live checks.',
    };
  }
  const code = permit.jurisdiction_code;
  if (!code || code === 'unresolved' || code === 'unknown') {
    return {
      ok: false,
      outcome: 'blocked',
      error: 'Jurisdiction unresolved — confirm AHJ before live checks.',
    };
  }
  const sources = listSources({ jurisdiction_code: code });
  const activated = sources.filter(
    (s) => s.activated && (s.state === 'verified' || s.state === 'degraded') && s.adapter_type && s.adapter_type !== 'none'
  );
  if (!activated.length) {
    const verified = sources.filter((s) => s.state === 'verified' || s.state === 'degraded');
    if (verified.length) {
      return {
        ok: false,
        outcome: 'blocked',
        error: `Verified source for ${code} is not activated. Review Sources and activate after confirming coverage limits.`,
      };
    }
    return {
      ok: false,
      outcome: 'unsupported',
      error: `No verified operational source registered for ${code}.`,
    };
  }
  return { ok: true, sources: activated.map((s) => s.key) };
}

const OFFICIAL_DATE_FIELDS = [
  ['submittedDate', 'submitted_date'],
  ['approvedDate', 'approved_date'],
  ['issuedDate', 'issued_date'],
];

/**
 * Apply connector result.
 * - Synthetic/demo modes never update import-origin records.
 * - Snapshot always names the official ID queried.
 * - First successful lookup is baseline (not treated as "new issuance" attention).
 * - Successful checks do not reset progress_anchor_at.
 */
export function applyConnectorResult(permit, result, changedBy = 'connector', queriedId = null) {
  const now = result.checkedAt || new Date().toISOString();
  const officialId = queriedId || permit.primary_official_id;

  // Integrity: synthetic must not update imported operational records
  if (result.mode === 'synthetic' && permit.record_origin === 'import') {
    db.prepare(
      `INSERT INTO official_snapshots(permit_record_id, official_id, payload_json, mode, outcome, checked_at)
       VALUES (?, ?, ?, 'synthetic_rejected', 'unavailable', ?)`
    ).run(
      permit.id,
      officialId,
      JSON.stringify({ ...result, rejected: 'synthetic_blocked_for_import_record' }),
      now
    );
    db.prepare(
      `UPDATE permit_records SET last_checked_at = ?, last_check_outcome = 'unavailable',
       last_check_error = 'Synthetic result blocked for imported record', updated_at = datetime('now')
       WHERE id = ?`
    ).run(now, permit.id);
    return { outcome: 'unavailable', mode: 'none', reason: 'synthetic_blocked' };
  }

  const isBaseline = !permit.baseline_snapshot_at && ['updated', 'no_change'].includes(result.outcome) === false
    ? 0
    : !permit.baseline_snapshot_at && (result.outcome === 'updated' || result.sourceNativeStatus)
      ? 1
      : 0;

  // Will set baseline after successful apply
  db.prepare(
    `INSERT INTO official_snapshots(permit_record_id, official_id, payload_json, mode, outcome, is_baseline, checked_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`
  ).run(
    permit.id,
    officialId,
    JSON.stringify(result),
    result.mode || 'none',
    result.outcome || 'failed',
    now
  );

  if (result.ambiguous) {
    db.prepare(
      `INSERT INTO match_reviews(jurisdiction_code, candidate_official_id, reason, payload_json)
       VALUES (?, ?, ?, ?)`
    ).run(
      permit.jurisdiction_code,
      officialId,
      'Ambiguous official ID match',
      JSON.stringify(result.candidates || [])
    );
    db.prepare(
      `UPDATE permit_records SET last_checked_at = ?, last_check_outcome = 'failed',
       last_check_error = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(now, result.error || 'ambiguous', permit.id);
    upsertAttention(
      permit.id,
      'unresolved_matching',
      `Ambiguous match for ${officialId}`,
      `match:${permit.id}:${officialId}`,
      `match:${permit.id}`
    );
    return { outcome: 'failed', reason: 'ambiguous', mode: result.mode };
  }

  if (['not_found', 'unavailable', 'failed'].includes(result.outcome)) {
    db.prepare(
      `UPDATE permit_records SET last_checked_at = ?, last_check_outcome = ?, last_check_error = ?,
       updated_at = datetime('now') WHERE id = ?`
    ).run(now, result.outcome, result.error || '', permit.id);

    if (result.outcome === 'not_found') {
      upsertAttention(
        permit.id,
        'source_missing',
        `Not found at source for ${officialId}`,
        `notfound:${permit.id}:${officialId}`,
        `source:${permit.id}:${officialId}`
      );
    } else {
      upsertAttention(
        permit.id,
        'check_failed',
        `Source check ${result.outcome}: ${result.error || result.outcome}`,
        `fail:${permit.id}:${result.outcome}:${(result.error || '').slice(0, 40)}`,
        `source:${permit.id}:${officialId}`
      );
    }
    return { outcome: result.outcome, mode: result.mode || 'none' };
  }

  // Success path — clear all source-error Attention for this permit (any prior ID)
  resolveAttentionByCondition(`source:${permit.id}:${officialId}`);
  resolveSourceAttentionForPermit(permit.id);

  let changed = false;
  const sets = [
    'last_checked_at = ?',
    'last_successful_check_at = ?',
    "last_check_error = ''",
    "updated_at = datetime('now')",
  ];
  const params = [now, now];

  // Establish baseline on first success without status-change attention
  const establishingBaseline = !permit.baseline_snapshot_at;

  const native = result.sourceNativeStatus ?? '';
  if (String(permit.source_native_status || '') !== String(native)) {
    recordChange(permit.id, 'source_native_status', permit.source_native_status, native, changedBy, 'connector');
    sets.push('source_native_status = ?');
    params.push(native);
    changed = true;
  }

  if (result.officialStatus && String(permit.official_status || '') !== String(result.officialStatus)) {
    recordChange(permit.id, 'official_status', permit.official_status, result.officialStatus, changedBy, 'connector');
    sets.push('official_status = ?');
    params.push(result.officialStatus);
    sets.push('official_last_changed_at = ?');
    params.push(now);
    // progress clock advances on official change
    sets.push('progress_anchor_at = ?');
    params.push(now);
    changed = true;
    if (!establishingBaseline) {
      upsertAttention(
        permit.id,
        'status_change',
        `Official status: ${permit.official_status || '—'} → ${result.officialStatus} (${officialId})`,
        `status:${permit.id}:${permit.official_status}->${result.officialStatus}:${officialId}`,
        `status:${permit.id}`
      );
    }
  }

  const fields = result.fields || {};
  for (const [src, col] of OFFICIAL_DATE_FIELDS) {
    const incoming = fields[src];
    if (incoming == null || incoming === '') continue;
    const key = `official_${col}`;
    const existing = db
      .prepare(`SELECT value FROM internal_milestones WHERE permit_record_id = ? AND key = ?`)
      .get(permit.id, key);
    if (!existing) {
      db.prepare(
        `INSERT INTO internal_milestones(permit_record_id, key, label, value, value_kind, source)
         VALUES (?, ?, ?, ?, 'date', 'connector')`
      ).run(permit.id, key, `Official ${col}`, incoming);
      recordChange(permit.id, key, '', incoming, changedBy, 'connector');
      changed = true;
    } else if (String(existing.value) !== String(incoming)) {
      recordChange(permit.id, key, existing.value, incoming, changedBy, 'connector');
      db.prepare(
        `UPDATE internal_milestones SET value = ?, source = 'connector' WHERE permit_record_id = ? AND key = ?`
      ).run(incoming, permit.id, key);
      changed = true;
      if (!establishingBaseline) {
        upsertAttention(
          permit.id,
          'status_change',
          `${key} changed for ${officialId}`,
          `field:${permit.id}:${key}:${incoming}`,
          `field:${permit.id}:${key}`
        );
      }
    }
  }

  if (fields.sourceUrl && String(permit.source_url || '') !== String(fields.sourceUrl)) {
    recordChange(permit.id, 'source_url', permit.source_url, fields.sourceUrl, changedBy, 'connector');
    sets.push('source_url = ?');
    params.push(fields.sourceUrl);
    changed = true;
  }

  // Use classification from official permit type label (not ID prefixes). Manual override preserved.
  if (fields.permitType || fields.useClassificationLabel) {
    const beforeUse = permit.use_classification;
    const beforeSrc = permit.use_classification_source;
    const updated = applyOfficialUseToPermit(
      db,
      permit.id,
      fields.useClassificationLabel || fields.permitType,
      { actor: changedBy }
    );
    if (
      updated &&
      (String(beforeUse) !== String(updated.use_classification) ||
        String(beforeSrc) !== String(updated.use_classification_source) ||
        String(permit.use_classification_official_label || '') !==
          String(updated.use_classification_official_label || ''))
    ) {
      recordChange(
        permit.id,
        'use_classification',
        beforeUse,
        updated.use_classification,
        changedBy,
        'connector'
      );
      changed = true;
      // Refresh local permit snapshot for subsequent reads in this function
      permit.use_classification = updated.use_classification;
      permit.use_classification_source = updated.use_classification_source;
      permit.use_classification_official_label = updated.use_classification_official_label;
    }
  }

  const outcome = changed ? 'updated' : 'no_change';
  sets.push('last_check_outcome = ?');
  params.push(outcome);

  if (establishingBaseline) {
    sets.push('baseline_snapshot_at = ?');
    params.push(now);
    if (!permit.progress_anchor_at) {
      sets.push('progress_anchor_at = ?');
      params.push(now);
    }
    // Mark latest snapshot as baseline
    db.prepare(
      `UPDATE official_snapshots SET is_baseline = 1
       WHERE id = (SELECT id FROM official_snapshots WHERE permit_record_id = ? ORDER BY id DESC LIMIT 1)`
    ).run(permit.id);
  }

  // Note: do NOT reset progress_anchor_at on successful no_change checks
  params.push(permit.id);
  db.prepare(`UPDATE permit_records SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  // Phase 1: bump row_version only when operator-visible fields changed.
  // Check-timestamp-only / pure no_change stay orthogonal (see docs/cas-bump-policy.md).
  let rowVersion = null;
  if (changed) {
    rowVersion = bumpPermitRowVersion(permit.id);
  }

  updateReadiness(permit.id);
  return {
    outcome,
    mode: result.mode,
    fieldAvailability: result.fieldAvailability,
    baseline: establishingBaseline,
    row_version: rowVersion,
    version_bumped: Boolean(changed),
  };
}

/** Lot-readiness under configured workbook rules (not silent official-status Ready). */
export function updateReadiness(permitId) {
  return updateLotReadiness(permitId);
}

export async function syncPermitById(
  id,
  { forceFail = false, officialId, allowSynthetic, actor, enforceEligibility } = {}
) {
  const permit = db.prepare('SELECT * FROM permit_records WHERE id = ?').get(id);
  if (!permit) throw new Error('Permit not found');
  const oid = officialId || permit.primary_official_id;
  if (!oid) {
    db.prepare(
      `UPDATE permit_records SET last_checked_at = datetime('now'), last_check_outcome = 'failed',
       last_check_error = 'No official ID', updated_at = datetime('now') WHERE id = ?`
    ).run(id);
    return { outcome: 'failed', error: 'No official ID' };
  }

  const gate =
    enforceEligibility === false || sourceEligibilityBypassed()
      ? { ok: true, bypass: true }
      : evaluateCheckEligibility(permit);
  if (!gate.ok) {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE permit_records SET last_checked_at = ?, last_check_outcome = ?, last_check_error = ?,
       updated_at = datetime('now') WHERE id = ?`
    ).run(now, gate.outcome, gate.error, id);
    return {
      outcome: gate.outcome,
      mode: 'none',
      error: gate.error,
      blocked: gate.outcome === 'blocked',
      checkedAt: now,
    };
  }

  const demo = isDemoMode() || permit.record_origin === 'demo' || permit.record_origin === 'fixture';
  const result = await checkPermit({
    jurisdictionCode: permit.jurisdiction_code,
    officialId: oid,
    forceFail,
    allowSynthetic: allowSynthetic ?? demo,
    recordOrigin: permit.record_origin,
  });
  const changedBy =
    actor ||
    getSetting('current_user', null) ||
    'system_job';
  return applyConnectorResult(permit, result, changedBy, oid);
}

export async function syncAllLinked({ fairfaxOnly = false, trigger = 'manual' } = {}) {
  const started = new Date().toISOString();
  const run = db
    .prepare(
      `INSERT INTO check_runs(started_at, trigger, scope) VALUES (?, ?, ?)`
    )
    .run(started, trigger, fairfaxOnly ? 'fairfax_candidates' : 'linked');
  const runId = Number(run.lastInsertRowid);

  let rows;
  if (fairfaxOnly) {
    rows = db
      .prepare(
        `SELECT p.id, p.primary_official_id AS official_id, p.record_origin
         FROM permit_records p
         WHERE p.record_origin = 'import'
           AND p.jurisdiction_code = 'fairfax_county'
           AND p.primary_official_id IS NOT NULL AND p.primary_official_id != ''
         ORDER BY p.id`
      )
      .all();
  } else {
    rows = db
      .prepare(
        `SELECT id, primary_official_id AS official_id, record_origin FROM permit_records
         WHERE primary_official_id IS NOT NULL AND primary_official_id != ''
           AND record_origin = 'import'
         ORDER BY id`
      )
      .all();
  }

  const counts = {
    total: 0,
    updated: 0,
    no_change: 0,
    not_found: 0,
    unavailable: 0,
    failed: 0,
    blocked: 0,
    unsupported: 0,
    skipped_demo: 0,
  };
  const results = [];
  for (const row of rows) {
    counts.total += 1;
    // eslint-disable-next-line no-await-in-loop
    const r = await syncPermitById(row.id, {
      officialId: row.official_id,
      allowSynthetic: false,
      actor: getSetting('current_user', null) || 'system_job',
    });
    results.push({ id: row.id, official_id: row.official_id, ...r });
    if (counts[r.outcome] != null) counts[r.outcome] += 1;
    else counts.failed += 1;
  }

  db.prepare(
    `UPDATE check_runs SET finished_at = datetime('now'), total = ?, updated = ?, no_change = ?,
     not_found = ?, unavailable = ?, failed = ?, skipped_demo = ?, summary_json = ? WHERE id = ?`
  ).run(
    counts.total,
    counts.updated,
    counts.no_change,
    counts.not_found,
    counts.unavailable,
    counts.failed,
    counts.skipped_demo,
    JSON.stringify({
      fairfaxOnly,
      blocked: counts.blocked,
      unsupported: counts.unsupported,
    }),
    runId
  );

  rebuildAttention();
  let diagnostic = null;
  if (fairfaxOnly && counts.total === 0) {
    const imported = db.prepare(`SELECT COUNT(*) AS c FROM permit_records WHERE record_origin = 'import'`).get()
      .c;
    diagnostic =
      imported === 0
        ? 'No imported permits yet. Import a workbook first. Run Fairfax checks only re-checks saved Fairfax County IDs — it does not search the county GIS for new permits.'
        : 'No imported Fairfax County permits with official IDs matched this run. Table search/filters only narrow saved workbook rows; they do not discover new Fairfax permits.';
  }
  return { results, runId, counts, diagnostic };
}

export function rebuildAttention() {
  const staleDays = Number(getSetting('stale_days', '14'));
  const today = new Date();
  const isoToday = today.toISOString().slice(0, 10);

  // Refresh lot-readiness assessments first (prereqs, revisions, automation gaps)
  rebuildAllReadiness({ today });

  const permits = db
    .prepare(
      `SELECT p.*, lg.lot_label, cs.community_name, cs.project_code
       FROM permit_records p
       JOIN lot_groups lg ON lg.id = p.lot_group_id
       JOIN community_sections cs ON cs.id = lg.section_id
       WHERE p.record_origin = 'import'`
    )
    .all();

  for (const p of permits) {
    // Overdue internal actions
    if (p.next_action_due && p.next_action_due < isoToday && p.internal_status !== 'done') {
      upsertAttention(
        p.id,
        'overdue_action',
        `Overdue: ${p.next_action || 'action'} (due ${p.next_action_due})`,
        `overdue:${p.id}:${p.next_action_due}`,
        `overdue:${p.id}`
      );
    } else {
      resolveAttentionByCondition(`overdue:${p.id}`);
    }

    // Lack of progress uses progress_anchor_at — NOT last_successful_check_at
    const anchor = p.progress_anchor_at || p.official_last_changed_at || p.created_at;
    if (anchor && p.primary_official_id) {
      const ageDays = (today - new Date(anchor)) / (86400 * 1000);
      if (ageDays >= staleDays && !['closed', 'cancelled', 'issued'].includes(p.official_status)) {
        upsertAttention(
          p.id,
          'no_progress',
          `No official progress for ~${Math.floor(ageDays)} days (threshold ${staleDays})`,
          `noprogress:${p.id}:${staleDays}`,
          `noprogress:${p.id}`
        );
      } else {
        resolveAttentionByCondition(`noprogress:${p.id}`);
      }
    }

    if (p.jurisdiction_code === 'unresolved' || !p.jurisdiction_confirmed) {
      if (p.primary_official_id) {
        upsertAttention(
          p.id,
          'unresolved_matching',
          `Jurisdiction not confirmed (${p.jurisdiction_source})`,
          `jur:${p.id}`,
          `jur:${p.id}`
        );
      }
    } else {
      resolveAttentionByCondition(`jur:${p.id}`);
    }

    const assessment = getStoredAssessment(p.id);
    const stateLabel =
      assessment?.state === READINESS_STATES.READY
        ? 'Ready'
        : assessment?.state === READINESS_STATES.BLOCKED
          ? 'Blocked'
          : assessment?.state === READINESS_STATES.NEEDS_VERIFICATION
            ? 'Needs verification'
            : assessment?.state || 'unknown';
    const approaching =
      assessment &&
      assessment.target_start &&
      assessment.days_to_start != null &&
      assessment.days_to_start >= 0 &&
      assessment.days_to_start <= Number(getSetting('approaching_start_days', '45'));

    if (approaching && assessment.state !== READINESS_STATES.READY) {
      upsertAttention(
        p.id,
        'approaching_start',
        `Target start ${assessment.target_start} in ${assessment.days_to_start}d — ${stateLabel}: ${
          (assessment.outstanding || []).map((o) => o.label).slice(0, 3).join(', ') ||
          (assessment.gaps || []).map((g) => g.label).slice(0, 2).join(', ') ||
          'review readiness'
        }`,
        `approach:${p.id}:${assessment.target_start}`,
        `approach:${p.id}`
      );
    } else {
      resolveAttentionByCondition(`approach:${p.id}`);
    }

    if (assessment?.state === READINESS_STATES.BLOCKED) {
      const labels = (assessment.outstanding || []).map((o) => o.label).slice(0, 4);
      upsertAttention(
        p.id,
        'readiness_blocked',
        `Blocked under workbook rules: ${labels.join(', ') || assessment.summary}`,
        `blocked:${p.id}:${labels.join('|')}`,
        `blocked:${p.id}`
      );
    } else {
      resolveAttentionByCondition(`blocked:${p.id}`);
    }

    if (assessment?.state === READINESS_STATES.NEEDS_VERIFICATION) {
      const labels = (assessment.gaps || []).map((g) => g.label).slice(0, 4);
      upsertAttention(
        p.id,
        'needs_verification',
        `Needs verification: ${labels.join(', ') || assessment.summary}`,
        `verify:${p.id}:${labels.join('|')}`,
        `verify:${p.id}`
      );
    } else {
      resolveAttentionByCondition(`verify:${p.id}`);
    }

    const revGaps = (assessment?.gaps || []).filter((g) => String(g.id || '').startsWith('revision:'));
    if (revGaps.length) {
      upsertAttention(
        p.id,
        'revision_impact',
        `Open permit revision may affect this lot — review (do not auto-invalidate): ${revGaps
          .map((g) => g.detail)
          .join('; ')}`,
        `revimpact:${p.id}`,
        `revimpact:${p.id}`
      );
    } else {
      resolveAttentionByCondition(`revimpact:${p.id}`);
    }

    // Official change Attention is created only in applyConnectorResult for subsequent
    // (non-baseline) observations — never re-emitted from rebuildAttention.
    if (assessment?.overdue_target && assessment.state !== READINESS_STATES.READY) {
      upsertAttention(
        p.id,
        'overdue_target',
        `Target start ${assessment.target_start} is overdue by ${Math.abs(assessment.days_to_start)}d (not inferred as actual start)`,
        `overdue_target:${p.id}:${assessment.target_start}`,
        `overdue_target:${p.id}`
      );
    } else {
      resolveAttentionByCondition(`overdue_target:${p.id}`);
    }
  }
}

export function getSchedulePreview() {
  const cfg = db.prepare('SELECT * FROM schedule_config WHERE id = 1').get();
  const lastRuns = db
    .prepare(`SELECT * FROM check_runs ORDER BY id DESC LIMIT 10`)
    .all();
  const openAttention = db
    .prepare(
      `SELECT kind, COUNT(*) AS c FROM attention_events
       WHERE resolved_at IS NULL AND acknowledged = 0 GROUP BY kind`
    )
    .all();
  const nextDue = cfg?.enabled
    ? new Date(Date.now() + (cfg.interval_minutes || 360) * 60000).toISOString()
    : null;
  db.prepare(`UPDATE schedule_config SET last_preview_at = datetime('now') WHERE id = 1`).run();
  return {
    config: cfg,
    nextDue,
    lastRuns,
    openAttention,
    digestPreview: {
      subject: 'Morning permit attention (local preview — not sent)',
      bullets: openAttention.map((a) => `${a.kind}: ${a.c}`),
      note: 'No email/Slack recipients connected.',
    },
  };
}
