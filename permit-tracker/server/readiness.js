import { db, getSetting, setSetting } from './db.js';

/** Operational assessment states (under configured rules — not silent issuance). */
export const READINESS_STATES = Object.freeze({
  READY: 'ready',
  BLOCKED: 'blocked',
  NEEDS_VERIFICATION: 'needs_verification',
});

/** Patterns are strings (not RegExp) so rulesets survive JSON settings round-trips. */
export const DEFAULT_RULESET = Object.freeze({
  key: 'default_workbook_v1',
  label: 'Workbook lot-readiness v1',
  approachingStartDays: 45,
  note:
    'Operational assessment from workbook milestones + confirmed revisions. Missing evidence never counts as Ready. Official AHJ status is supporting evidence when live; unavailable sources stay honest gaps.',
  prerequisites: [
    {
      id: 'permit_release',
      label: 'Permit Release',
      role: 'internal_release',
      required: 'if_present',
      completionRole: true,
      match: ['permit\\s*release'],
    },
    {
      id: 'permit_ordered',
      label: 'Permit Ordered',
      role: 'permit_ordered',
      required: 'if_present',
      completionRole: true,
      match: ['permit\\s*ordered', 'tol\\s*permit\\s*ordered'],
    },
    {
      id: 'combined_ws_requested',
      label: 'Water & Sewer Requested',
      role: 'combined_ws_requested',
      required: 'if_present',
      completionRole: true,
      // Combined W/S column only — do not treat as water-only or sewer-only
      match: [
        'w\\/?s\\s*(ordered|requested)',
        'water\\s*&\\s*sewer.*(ordered|requested)',
        'water\\s*and\\s*sewer.*(ordered|requested)',
        'water\\s*&\\s*sewer\\s*pww\\s*requested',
      ],
    },
    {
      id: 'water_requested',
      label: 'Water Requested',
      role: 'water_requested',
      required: 'if_present',
      completionRole: true,
      excludeIf: ['water\\s*&\\s*sewer', 'w\\/?s\\s'],
      match: ['loco\\s*water\\s*(ordered|requested)', '\\bwater\\s*(ordered|requested)'],
    },
    {
      id: 'sewer_requested',
      label: 'Sewer Requested',
      role: 'sewer_requested',
      required: 'if_present',
      completionRole: true,
      excludeIf: ['water\\s*&\\s*sewer', 'w\\/?s\\s'],
      match: ['pw\\s*sewer\\s*(ordered|requested)', '\\bsewer\\s*(ordered|requested)'],
    },
    {
      id: 'permit_received',
      label: 'Permit Received',
      role: 'permit_received',
      required: 'if_present',
      completionRole: true,
      match: ['permit\\s*received'],
    },
    {
      id: 'combined_ws_received',
      label: 'Water & Sewer Received',
      role: 'combined_ws_received',
      required: 'if_present',
      completionRole: true,
      match: ['w\\/?s\\s*received', 'water\\s*&\\s*sewer.*received'],
    },
    {
      id: 'water_received',
      label: 'Water Received',
      role: 'water_received',
      required: 'if_present',
      completionRole: true,
      excludeIf: ['water\\s*&\\s*sewer', 'w\\/?s\\s'],
      match: ['loco\\s*water\\s*received', '\\bwater\\s*received\\b'],
    },
    {
      id: 'sewer_received',
      label: 'Sewer Received',
      role: 'sewer_received',
      required: 'if_present',
      completionRole: true,
      excludeIf: ['water\\s*&\\s*sewer', 'w\\/?s\\s'],
      match: ['\\bsewer\\s*received\\b'],
    },
    {
      id: 'combined_ws_paid',
      label: 'Water & Sewer Paid',
      role: 'combined_ws_paid',
      required: 'if_present',
      completionRole: true,
      match: ['water\\s*&\\s*sewer.*\\bpaid\\b', 'w\\/?s.*\\bpaid\\b'],
    },
    {
      id: 'water_paid',
      label: 'Water Paid',
      role: 'water_paid',
      required: 'if_present',
      completionRole: true,
      excludeIf: ['water\\s*&\\s*sewer', 'w\\/?s\\s'],
      match: ['\\bwater\\s*paid\\b'],
    },
    {
      id: 'sewer_paid',
      label: 'Sewer Paid',
      role: 'sewer_paid',
      required: 'if_present',
      completionRole: true,
      excludeIf: ['water\\s*&\\s*sewer', 'w\\/?s\\s'],
      match: ['\\bsewer\\s*paid\\b'],
    },
    {
      id: 'startsheet',
      label: 'StartSheet Distributed',
      role: 'startsheet',
      required: 'if_present',
      completionRole: true,
      match: ['start\\s*sheet', 'startsheet'],
    },
  ],
  informational: [
    {
      id: 'target_start',
      label: 'Target Start Date',
      role: 'target_start',
      match: ['target\\s*start'],
    },
  ],
  optional: [
    {
      id: 'deck_path',
      label: 'Deck zoning / permit',
      role: 'deck',
      match: ['deck'],
    },
  ],
});

function cloneRuleset(ruleset = DEFAULT_RULESET) {
  return JSON.parse(JSON.stringify(ruleset));
}

export function getReadinessRuleset() {
  const raw = getSetting('readiness_ruleset_json', '');
  if (!raw) return cloneRuleset(DEFAULT_RULESET);
  try {
    const parsed = JSON.parse(raw);
    return {
      ...cloneRuleset(DEFAULT_RULESET),
      ...parsed,
      prerequisites: Array.isArray(parsed.prerequisites)
        ? parsed.prerequisites
        : cloneRuleset(DEFAULT_RULESET).prerequisites,
      informational: Array.isArray(parsed.informational)
        ? parsed.informational
        : cloneRuleset(DEFAULT_RULESET).informational,
    };
  } catch {
    return cloneRuleset(DEFAULT_RULESET);
  }
}

export function setReadinessRuleset(ruleset) {
  const next = {
    ...cloneRuleset(DEFAULT_RULESET),
    ...ruleset,
    key: ruleset?.key || DEFAULT_RULESET.key,
  };
  setSetting('readiness_ruleset_json', JSON.stringify(next));
  return next;
}

function labelMatches(label, patterns) {
  const text = String(label || '');
  return (patterns || []).some((p) => {
    if (p instanceof RegExp) return p.test(text);
    if (p && typeof p === 'object') return false; // reject JSON-ruined RegExp stubs
    const src = String(p || '').trim();
    if (!src) return false;
    try {
      return new RegExp(src, 'i').test(text);
    } catch {
      return text.toLowerCase().includes(src.toLowerCase());
    }
  });
}

/**
 * Classify a milestone cell. `na` is preserved as unconfirmed_na (never global completion)
 * unless an explicit record-level waiver exists. Future completion dates are not proof today.
 */
export function classifyMilestoneValue(value, valueKind = 'text', { today, waived = false, completionRole = false } = {}) {
  if (value == null || String(value).trim() === '') {
    return { status: 'missing', detail: 'empty' };
  }
  const s = String(value).trim();
  const asOf = today || new Date();
  if (/^(na|n\/a|n\.a\.?)$/i.test(s)) {
    if (waived) {
      return { status: 'waived', detail: 'explicit record-level waiver for n/a' };
    }
    return {
      status: 'unconfirmed_na',
      detail: 'n/a preserved — needs community/field rule or record-level waiver',
    };
  }
  if (valueKind === 'date' || /^\d{4}-\d{2}-\d{2}/.test(s)) {
    const date = s.slice(0, 10);
    const days = daysUntil(date, asOf);
    if (completionRole && days != null && days > 0) {
      return {
        status: 'future',
        detail: `future date ${date} is not proof of completion today`,
        date,
      };
    }
    return { status: 'satisfied', detail: 'date evidence', date };
  }
  if (
    /^(apply|can apply|rqst|request(ed)?|need\b|submitted|resubmitted|john\/bk|ayes|pending)/i.test(
      s
    )
  ) {
    return { status: 'in_progress', detail: `status text: ${s}` };
  }
  return { status: 'ambiguous', detail: `non-date text: ${s}` };
}

function findMilestonesForRule(milestones, rule) {
  return milestones.filter((m) => {
    if (!labelMatches(m.label, rule.match)) return false;
    if (rule.excludeIf && labelMatches(m.label, rule.excludeIf)) return false;
    return true;
  });
}

function findHeadersForRule(headers, rule) {
  return (headers || []).filter((h) => {
    if (!labelMatches(h.label, rule.match)) return false;
    if (rule.excludeIf && labelMatches(h.label, rule.excludeIf)) return false;
    return true;
  });
}

function hasWaiver(permitId, milestoneKey) {
  if (!milestoneKey) return false;
  return Boolean(
    db
      .prepare(
        `SELECT id FROM milestone_waivers WHERE permit_record_id = ? AND milestone_key = ?`
      )
      .get(permitId, milestoneKey)
  );
}

function daysUntil(isoDate, today = new Date()) {
  if (!isoDate) return null;
  const t = Date.parse(isoDate);
  if (Number.isNaN(t)) return null;
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const end = Date.UTC(
    new Date(t).getUTCFullYear(),
    new Date(t).getUTCMonth(),
    new Date(t).getUTCDate()
  );
  return Math.round((end - start) / 86400000);
}

function lotMatchesRevision(lotLabel, revLot) {
  const lot = String(lotLabel || '').trim().toLowerCase();
  const rev = String(revLot || '').trim().toLowerCase();
  if (!lot || !rev) return false;
  if (lot === rev) return true;
  // Match discrete lot tokens only (avoid "7" matching "27" via substring)
  const lotTokens = lot.split(/[^0-9a-z]+/).filter(Boolean);
  const revTokens = rev.split(/[^0-9a-z]+/).filter(Boolean);
  if (revTokens.length === 1) {
    if (lotTokens.includes(revTokens[0])) return true;
    // Single lot number inside a workbook range label, e.g. rev "7" → "1-8 (M1)"
    if (/^\d+$/.test(revTokens[0])) {
      const n = Number(revTokens[0]);
      const ranges = [...lot.matchAll(/(\d+)\s*-\s*(\d+)/g)];
      for (const m of ranges) {
        const a = Number(m[1]);
        const b = Number(m[2]);
        if (n >= Math.min(a, b) && n <= Math.max(a, b)) return true;
      }
    }
    return false;
  }
  // Range-style revision labels: require all tokens present
  return revTokens.every((t) => lotTokens.includes(t));
}

function findOpenRevisions(projectCode, lotLabel) {
  const rows = db
    .prepare(
      `SELECT * FROM permit_revisions
       WHERE UPPER(IFNULL(community_code,'')) = UPPER(?)`
    )
    .all(projectCode || '');
  return rows.filter((r) => {
    const received = r.received_revised_permit;
    const open = received == null || String(received).trim() === '';
    return open && lotMatchesRevision(lotLabel, r.lot);
  });
}

/**
 * Official AHJ verification is supporting evidence — not required for every internal Ready.
 * Preserve last-known official_status on failed checks (caller never clears it).
 */
function evaluateOfficialSupport(permit) {
  const evidence = [];
  const freshness = {
    last_check_outcome: permit.last_check_outcome || 'never',
    last_successful_check_at: permit.last_successful_check_at || null,
    last_check_error: permit.last_check_error || '',
    stale_or_failed: ['failed', 'unavailable'].includes(permit.last_check_outcome),
  };
  let status = 'not_applicable';
  if (['issued', 'approved'].includes(permit.official_status)) {
    status = 'verified';
    evidence.push({
      id: 'official_status',
      label: 'Official status',
      status: 'satisfied',
      detail: `${permit.official_status} (live verification)`,
      source: 'connector',
    });
  } else if (['revision_required', 'cancelled'].includes(permit.official_status)) {
    status = 'blocked';
    evidence.push({
      id: 'official_status',
      label: 'Official status',
      status: 'in_progress',
      detail: permit.official_status,
      source: 'connector',
    });
  } else if (permit.primary_official_id) {
    if (freshness.stale_or_failed) {
      status = 'stale_or_failed';
    } else if (permit.last_check_outcome === 'never' || !permit.last_successful_check_at) {
      status = 'unverified';
    } else {
      status = 'observed';
      if (permit.official_status && permit.official_status !== 'unknown') {
        evidence.push({
          id: 'official_status',
          label: 'Official status',
          status: 'ambiguous',
          detail: permit.official_status,
          source: 'connector',
        });
      }
    }
  }
  return { status, evidence, freshness };
}

/**
 * Assess one permit/lot under the configured ruleset.
 * Unknown / stale / missing ≠ Ready.
 */
export function assessPermitReadiness(permitId, { ruleset, today } = {}) {
  const rules = ruleset || getReadinessRuleset();
  const asOf = today || new Date();
  const permit = db
    .prepare(
      `SELECT p.*, lg.lot_label, lg.housetype, lg.section_id, cs.project_code, cs.community_name,
              cs.jurisdiction_code AS section_jurisdiction
       FROM permit_records p
       JOIN lot_groups lg ON lg.id = p.lot_group_id
       JOIN community_sections cs ON cs.id = lg.section_id
       WHERE p.id = ?`
    )
    .get(permitId);
  if (!permit) return null;

  const milestones = db
    .prepare(
      `SELECT * FROM internal_milestones
       WHERE permit_record_id = ? AND key NOT LIKE 'official_%'
       ORDER BY key`
    )
    .all(permitId);

  const section = db
    .prepare(`SELECT header_json FROM community_sections WHERE id = ?`)
    .get(permit.section_id);
  let sectionHeaders = [];
  try {
    sectionHeaders = JSON.parse(section?.header_json || '[]');
  } catch {
    sectionHeaders = [];
  }

  const outstanding = [];
  const satisfied = [];
  const gaps = [];
  const informational = [];

  // Target start (informational)
  for (const info of rules.informational || []) {
    const hits = findMilestonesForRule(milestones, info);
    if (hits.length) {
      const m = hits[0];
      const ev = classifyMilestoneValue(m.value, m.value_kind, { today: asOf, completionRole: false });
      informational.push({
        id: info.id,
        label: m.label || info.label,
        key: m.key,
        value: m.value,
        ...ev,
      });
    }
  }

  const targetInfo = informational.find((i) => i.id === 'target_start' && i.date);
  const targetStart = targetInfo?.date || null;
  const daysToStart = daysUntil(targetStart, asOf);
  const approachingDays = Number(rules.approachingStartDays || 45);
  const approaching_start =
    targetStart != null && daysToStart != null && daysToStart >= 0 && daysToStart <= approachingDays;
  const overdue_target = targetStart != null && daysToStart != null && daysToStart < 0;

  let applicableRuleCount = 0;
  for (const rule of rules.prerequisites || []) {
    const hits = findMilestonesForRule(milestones, rule);
    const headerHits = findHeadersForRule(sectionHeaders, rule);
    const presentInSection = headerHits.length > 0 || hits.length > 0;

    if (!presentInSection) {
      if (rule.required === 'always') {
        applicableRuleCount += 1;
        outstanding.push({
          id: rule.id,
          label: rule.label,
          status: 'missing',
          detail: 'prerequisite column not present for this community section',
        });
      }
      continue;
    }
    applicableRuleCount += 1;

    if (!hits.length) {
      outstanding.push({
        id: rule.id,
        label: headerHits[0]?.label || rule.label,
        key: headerHits[0]?.key || null,
        value: null,
        status: 'missing',
        detail: 'blank on lot — section tracks this prerequisite',
        role: rule.role,
      });
      continue;
    }

    const evals = hits.map((m) => ({
      milestone: m,
      ...classifyMilestoneValue(m.value, m.value_kind, {
        today: asOf,
        waived: hasWaiver(permitId, m.key),
        completionRole: Boolean(rule.completionRole),
      }),
    }));
    const best =
      evals.find((e) => e.status === 'satisfied') ||
      evals.find((e) => e.status === 'waived') ||
      evals.find((e) => e.status === 'in_progress') ||
      evals.find((e) => e.status === 'future') ||
      evals.find((e) => e.status === 'unconfirmed_na') ||
      evals.find((e) => e.status === 'ambiguous') ||
      evals[0];
    const row = {
      id: rule.id,
      label: best.milestone.label || rule.label,
      key: best.milestone.key,
      value: best.milestone.value,
      status: best.status,
      detail: best.detail,
      role: rule.role,
    };
    if (best.status === 'satisfied' || best.status === 'waived') {
      satisfied.push(row);
    } else if (['ambiguous', 'unconfirmed_na', 'future'].includes(best.status)) {
      gaps.push(row);
    } else {
      outstanding.push(row);
    }
  }

  // Deck/shed/sprinkler applicability review when columns exist
  for (const opt of rules.optional || []) {
    const headerHits = findHeadersForRule(sectionHeaders, opt);
    const hits = findMilestonesForRule(milestones, opt);
    if (!headerHits.length && !hits.length) continue;
    const cfg = db
      .prepare(
        `SELECT state FROM applicability_config
         WHERE feature_key = ? AND (lot_group_id = ? OR community_section_id = ?)
         ORDER BY lot_group_id DESC LIMIT 1`
      )
      .get(opt.role || opt.id, permit.lot_group_id, permit.section_id);
    if (!cfg || cfg.state === 'needs_confirmation') {
      gaps.push({
        id: `applicability:${opt.id}`,
        label: opt.label,
        status: 'needs_confirmation',
        detail: 'Applicability Needs confirmation (Required / Not applicable / Needs confirmation)',
      });
    }
  }

  const openRevisions = findOpenRevisions(permit.project_code, permit.lot_label);
  const revisionFlags = openRevisions.map((r) => ({
    id: `revision:${r.id}`,
    label: 'Permit revision open',
    status: 'needs_review',
    detail: `${r.reason || 'revision'} (submitted ${r.date_submitted || '—'}; revised permit not received)`,
    revision_id: r.id,
    lots_potentially_affected: true,
  }));
  gaps.push(...revisionFlags);

  const official = evaluateOfficialSupport(permit);
  // Official revision/cancel blocks workbook Ready; unverified AHJ does not.
  if (official.status === 'blocked') {
    for (const e of official.evidence) outstanding.push(e);
  }

  let state = READINESS_STATES.READY;
  if (outstanding.length) {
    state = READINESS_STATES.BLOCKED;
  } else if (gaps.length) {
    state = READINESS_STATES.NEEDS_VERIFICATION;
  } else if (applicableRuleCount === 0) {
    state = READINESS_STATES.NEEDS_VERIFICATION;
    gaps.push({
      id: 'no_applicable_rules',
      label: 'No applicable prerequisite rules',
      status: 'gap',
      detail: 'Cannot be Ready with zero confirmed applicable prerequisites',
    });
  }

  const summaryParts = [];
  if (targetStart) {
    summaryParts.push(
      `Target start ${targetStart}` +
        (daysToStart == null
          ? ''
          : overdue_target
            ? ` (${Math.abs(daysToStart)}d overdue — not actual start)`
            : ` (in ${daysToStart}d)`)
    );
  }
  if (state === READINESS_STATES.READY) {
    summaryParts.push('Ready under workbook rules');
  } else if (state === READINESS_STATES.BLOCKED) {
    summaryParts.push(
      `Blocked: ${outstanding
        .slice(0, 3)
        .map((o) => o.label)
        .join(', ')}`
    );
  } else {
    summaryParts.push(
      `Needs verification: ${gaps
        .slice(0, 3)
        .map((g) => g.label)
        .join(', ')}`
    );
  }
  if (official.status && official.status !== 'not_applicable') {
    summaryParts.push(`AHJ verification: ${official.status}`);
  }

  // Lot-group summary across permit siblings (shared milestones / worst state)
  const siblingIds = db
    .prepare(
      `SELECT id FROM permit_records WHERE lot_group_id = ? AND record_origin = 'import' ORDER BY id`
    )
    .all(permit.lot_group_id)
    .map((r) => r.id);

  return {
    permit_record_id: permitId,
    lot_group_id: permit.lot_group_id,
    project_code: permit.project_code,
    community_name: permit.community_name,
    lot_label: permit.lot_label,
    housetype: permit.housetype,
    state,
    state_label:
      state === READINESS_STATES.READY
        ? 'Ready'
        : state === READINESS_STATES.BLOCKED
          ? 'Blocked'
          : 'Needs verification',
    ruleset_key: rules.key,
    assessment_note: rules.note,
    target_start: targetStart,
    days_to_start: daysToStart,
    approaching_start,
    overdue_target,
    applicable_rule_count: applicableRuleCount,
    outstanding,
    satisfied,
    gaps,
    informational,
    open_revisions: openRevisions,
    official_verification: official,
    sibling_permit_ids: siblingIds,
    owner: permit.owner,
    next_action: permit.next_action,
    next_action_due: permit.next_action_due,
    official_status: permit.official_status,
    last_check_outcome: permit.last_check_outcome,
    assessed_at: new Date().toISOString(),
    summary: summaryParts.join(' · '),
  };
}

export function persistAssessment(assessment) {
  if (!assessment) return;
  db.prepare(
    `INSERT INTO readiness_assessments(
       permit_record_id, state, target_start, days_to_start, summary,
       outstanding_json, satisfied_json, gaps_json, informational_json,
       ruleset_key, assessed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(permit_record_id) DO UPDATE SET
       state = excluded.state,
       target_start = excluded.target_start,
       days_to_start = excluded.days_to_start,
       summary = excluded.summary,
       outstanding_json = excluded.outstanding_json,
       satisfied_json = excluded.satisfied_json,
       gaps_json = excluded.gaps_json,
       informational_json = excluded.informational_json,
       ruleset_key = excluded.ruleset_key,
       assessed_at = excluded.assessed_at`
  ).run(
    assessment.permit_record_id,
    assessment.state,
    assessment.target_start,
    assessment.days_to_start,
    assessment.summary,
    JSON.stringify(assessment.outstanding || []),
    JSON.stringify(assessment.satisfied || []),
    JSON.stringify(assessment.gaps || []),
    JSON.stringify(assessment.informational || []),
    assessment.ruleset_key,
    assessment.assessed_at
  );
  // Do not bump business-modified updated_at on assessment recalc alone
  db.prepare(`UPDATE permit_records SET readiness_state = ? WHERE id = ?`).run(
    assessment.state,
    assessment.permit_record_id
  );
}

export function updateLotReadiness(permitId, opts = {}) {
  const assessment = assessPermitReadiness(permitId, opts);
  if (!assessment) return null;
  persistAssessment(assessment);
  return assessment;
}

function worstState(states) {
  if (states.includes(READINESS_STATES.BLOCKED)) return READINESS_STATES.BLOCKED;
  if (states.includes(READINESS_STATES.NEEDS_VERIFICATION)) return READINESS_STATES.NEEDS_VERIFICATION;
  if (states.includes(READINESS_STATES.READY)) return READINESS_STATES.READY;
  return READINESS_STATES.NEEDS_VERIFICATION;
}

export function rebuildAllReadiness(opts = {}) {
  const ruleset = opts.ruleset || getReadinessRuleset();
  const ids = db
    .prepare(`SELECT id FROM permit_records WHERE record_origin = 'import' ORDER BY id`)
    .all()
    .map((r) => r.id);
  const assessments = [];
  for (const id of ids) {
    const a = updateLotReadiness(id, { ...opts, ruleset });
    if (a) assessments.push(a);
  }

  // Lot/group counts: one row per lot_group (worst sibling state) — avoid duplicate lot counts
  const byLot = new Map();
  for (const a of assessments) {
    const key = a.lot_group_id;
    const prev = byLot.get(key);
    if (!prev) byLot.set(key, a);
    else byLot.set(key, { ...prev, state: worstState([prev.state, a.state]) });
  }
  const lotCounts = { ready: 0, blocked: 0, needs_verification: 0, total: byLot.size };
  for (const a of byLot.values()) {
    lotCounts[a.state] = (lotCounts[a.state] || 0) + 1;
  }
  const permitCounts = { ready: 0, blocked: 0, needs_verification: 0, total: assessments.length };
  for (const a of assessments) {
    permitCounts[a.state] = (permitCounts[a.state] || 0) + 1;
  }
  return {
    counts: lotCounts,
    permitCounts,
    assessments,
    ruleset_key: ruleset.key,
  };
}

export function getStoredAssessment(permitId) {
  const row = db
    .prepare(`SELECT * FROM readiness_assessments WHERE permit_record_id = ?`)
    .get(permitId);
  if (!row) return null;
  return {
    ...row,
    outstanding: JSON.parse(row.outstanding_json || '[]'),
    satisfied: JSON.parse(row.satisfied_json || '[]'),
    gaps: JSON.parse(row.gaps_json || '[]'),
    informational: JSON.parse(row.informational_json || '[]'),
  };
}

/** Lots confirmed linked to an open revision (for Attention / review — not silent invalidation). */
export function listRevisionImpactedLots() {
  const revisions = db
    .prepare(
      `SELECT * FROM permit_revisions
       WHERE received_revised_permit IS NULL OR trim(received_revised_permit) = ''`
    )
    .all();
  const impacted = [];
  for (const rev of revisions) {
    const permits = db
      .prepare(
        `SELECT p.id, lg.lot_label, cs.project_code, cs.community_name
         FROM permit_records p
         JOIN lot_groups lg ON lg.id = p.lot_group_id
         JOIN community_sections cs ON cs.id = lg.section_id
         WHERE p.record_origin = 'import'
           AND UPPER(cs.project_code) = UPPER(?)`
      )
      .all(rev.community_code || '');
    for (const p of permits) {
      if (!lotMatchesRevision(p.lot_label, rev.lot)) continue;
      impacted.push({
        permit_record_id: p.id,
        project_code: p.project_code,
        community_name: p.community_name,
        lot_label: p.lot_label,
        revision: rev,
      });
    }
  }
  return impacted;
}
