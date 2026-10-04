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
      match: ['permit\\s*release'],
    },
    {
      id: 'permit_ordered',
      label: 'Permit Ordered',
      role: 'permit_ordered',
      required: 'if_present',
      match: ['permit\\s*ordered', 'tol\\s*permit\\s*ordered'],
    },
    {
      id: 'utility_ordered',
      label: 'Utility Ordered / Requested',
      role: 'utility_ordered',
      required: 'if_present',
      match: [
        'w\\/?s\\s*(ordered|requested)',
        '(pw|loco|pww).*(ordered|requested)',
        '(water|sewer).*(ordered|requested)',
        'water\\s*&\\s*sewer.*(ordered|requested)',
      ],
    },
    {
      id: 'permit_received',
      label: 'Permit Received',
      role: 'permit_received',
      required: 'if_present',
      match: ['permit\\s*received'],
    },
    {
      id: 'utility_received',
      label: 'Utility Received',
      role: 'utility_received',
      required: 'if_present',
      match: [
        'w\\/?s\\s*received',
        '(pw|loco|pww).*(received)',
        '(water|sewer).*(received)',
      ],
    },
    {
      id: 'utility_paid',
      label: 'Water / Sewer Paid',
      role: 'utility_paid',
      required: 'if_present',
      match: ['(water|sewer|w\\/?s).*\\bpaid\\b', '\\b(water|sewer)\\s*paid\\b'],
    },
    {
      id: 'startsheet',
      label: 'StartSheet Distributed',
      role: 'startsheet',
      required: 'if_present',
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

export function classifyMilestoneValue(value, valueKind = 'text') {
  if (value == null || String(value).trim() === '') {
    return { status: 'missing', detail: 'empty' };
  }
  const s = String(value).trim();
  if (/^(na|n\/a|n\.a\.?)$/i.test(s)) {
    return { status: 'waived', detail: 'marked n/a' };
  }
  if (valueKind === 'date' || /^\d{4}-\d{2}-\d{2}/.test(s)) {
    return { status: 'satisfied', detail: 'date evidence', date: s.slice(0, 10) };
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
  return milestones.filter((m) => labelMatches(m.label, rule.match));
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

function evaluateOfficialSupport(permit) {
  const gaps = [];
  const evidence = [];
  if (['issued', 'approved'].includes(permit.official_status)) {
    evidence.push({
      id: 'official_status',
      label: 'Official status',
      status: 'satisfied',
      detail: permit.official_status,
      source: 'connector',
    });
  } else if (['revision_required', 'cancelled'].includes(permit.official_status)) {
    return {
      status: 'blocked',
      evidence: [
        {
          id: 'official_status',
          label: 'Official status',
          status: 'in_progress',
          detail: permit.official_status,
          source: 'connector',
        },
      ],
      gaps: [],
    };
  } else if (permit.primary_official_id) {
    if (permit.last_check_outcome === 'unavailable' || permit.last_check_outcome === 'failed') {
      gaps.push({
        id: 'automation_gap',
        label: 'AHJ automation',
        status: 'gap',
        detail:
          permit.last_check_error ||
          `Last check ${permit.last_check_outcome} — keep workbook evidence; do not invent Ready`,
        source: 'connector',
      });
    } else if (permit.last_check_outcome === 'never' || !permit.last_successful_check_at) {
      gaps.push({
        id: 'official_unverified',
        label: 'Official status unverified',
        status: 'gap',
        detail: 'No successful AHJ check yet',
        source: 'connector',
      });
    } else if (permit.official_status && permit.official_status !== 'unknown') {
      evidence.push({
        id: 'official_status',
        label: 'Official status',
        status: 'ambiguous',
        detail: permit.official_status,
        source: 'connector',
      });
    }
  }
  return { status: 'ok', evidence, gaps };
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

  // Target start (informational) — lot milestone first, else section header presence only
  for (const info of rules.informational || []) {
    const hits = findMilestonesForRule(milestones, info);
    if (hits.length) {
      const m = hits[0];
      const ev = classifyMilestoneValue(m.value, m.value_kind);
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

  for (const rule of rules.prerequisites || []) {
    const hits = findMilestonesForRule(milestones, rule);
    const headerHits = (sectionHeaders || []).filter((h) => labelMatches(h.label, rule.match));
    const presentInSection = headerHits.length > 0 || hits.length > 0;

    if (!presentInSection) {
      if (rule.required === 'always') {
        outstanding.push({
          id: rule.id,
          label: rule.label,
          status: 'missing',
          detail: 'prerequisite column not present for this community section',
        });
      }
      continue;
    }

    if (!hits.length) {
      // Column exists on the section (or sibling lots) but this lot cell was blank — not Ready
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

    // Aggregate: satisfied if any hit satisfied/waived; else worst status across hits
    const evals = hits.map((m) => ({
      milestone: m,
      ...classifyMilestoneValue(m.value, m.value_kind),
    }));
    const best =
      evals.find((e) => e.status === 'satisfied') ||
      evals.find((e) => e.status === 'waived') ||
      evals.find((e) => e.status === 'in_progress') ||
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
    } else if (best.status === 'ambiguous') {
      gaps.push({ ...row, status: 'ambiguous' });
    } else {
      outstanding.push(row);
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

  const official = evaluateOfficialSupport(permit);
  for (const e of official.evidence) {
    if (e.status === 'satisfied') satisfied.push(e);
    else if (e.status === 'in_progress') outstanding.push(e);
    else gaps.push(e);
  }
  gaps.push(...official.gaps);
  gaps.push(...revisionFlags);

  let state = READINESS_STATES.READY;
  if (outstanding.length) {
    state = READINESS_STATES.BLOCKED;
  } else if (gaps.length || official.status === 'blocked') {
    state = READINESS_STATES.NEEDS_VERIFICATION;
  } else if (!satisfied.length && !milestones.length) {
    state = READINESS_STATES.NEEDS_VERIFICATION;
    gaps.push({
      id: 'no_milestones',
      label: 'No workbook milestones',
      status: 'gap',
      detail: 'Cannot assess Ready without evidence',
    });
  }

  // Official hard block overrides ready
  if (official.status === 'blocked') {
    state = READINESS_STATES.BLOCKED;
  }

  const summaryParts = [];
  if (targetStart) {
    summaryParts.push(
      `Target start ${targetStart}` +
        (daysToStart == null
          ? ''
          : daysToStart < 0
            ? ` (${Math.abs(daysToStart)}d past)`
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

  return {
    permit_record_id: permitId,
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
    approaching_start:
      targetStart != null &&
      daysToStart != null &&
      daysToStart >= 0 &&
      daysToStart <= Number(rules.approachingStartDays || 21),
    outstanding,
    satisfied,
    gaps,
    informational,
    open_revisions: openRevisions,
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
  db.prepare(`UPDATE permit_records SET readiness_state = ?, updated_at = datetime('now') WHERE id = ?`).run(
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

export function rebuildAllReadiness(opts = {}) {
  const ruleset = opts.ruleset || getReadinessRuleset();
  const ids = db
    .prepare(`SELECT id FROM permit_records WHERE record_origin = 'import' ORDER BY id`)
    .all()
    .map((r) => r.id);
  const counts = { ready: 0, blocked: 0, needs_verification: 0, total: 0 };
  const assessments = [];
  for (const id of ids) {
    const a = updateLotReadiness(id, { ...opts, ruleset });
    if (!a) continue;
    counts.total += 1;
    counts[a.state] = (counts[a.state] || 0) + 1;
    assessments.push(a);
  }
  return { counts, assessments, ruleset_key: ruleset.key };
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
