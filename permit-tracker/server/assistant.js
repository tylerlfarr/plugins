/**
 * Phase 7 — Bounded AI assistance (optional) + deterministic evidence helpers.
 *
 * Hard bounds:
 * - Never invent IDs, dates, or contacts.
 * - Never run arbitrary SQL, activate sources, or spend.
 * - Notes/public text are untrusted (prompt-injection resistant).
 * - Workflow completeness ≠ lending approval or source verification.
 * - If no API key / unsafe, ship deterministic NL→filter + evidence summaries.
 */
import { db, getSetting, setSetting } from './db.js';
import { normalizePermitFilters, PERMIT_FILTER_KEYS } from './permitFilters.js';
import { getStoredAssessment, assessPermitReadiness } from './readiness.js';
import { listSources } from './sources/registry.js';
import { SEED_ARCGIS_CANDIDATES } from './sources/arcgisDiscover.js';

export const ASSISTANT_PROMPT_VERSION = 'permit-assistant-v1';
export const ASSISTANT_MODEL_DETERMINISTIC = 'deterministic-evidence-v1';

/** Tools the assistant may request; server executes only these. */
export const ALLOWED_ASSISTANT_TOOLS = Object.freeze([
  'map_filters',
  'summarize_evidence',
  'preview_project_handoff',
  'preview_opportunity_handoff',
  'list_source_links',
  'propose_source_discovery', // owner-only; proposal rows only
]);

/** Explicitly disallowed — always refuse. */
export const DISALLOWED_ASSISTANT_ACTIONS = Object.freeze([
  'activate_source',
  'run_sql',
  'spend_credits',
  'purchase_contacts',
  'send_outreach',
  'invent_id',
  'invent_date',
  'invent_contact',
  'approve_lending',
  'verify_source',
  'mutate_status',
  'upload_gospel',
]);

const UNSUPPORTED_GEO_HINTS = [
  { re: /\bloudoun\b|\bleesburg\b/i, code: 'loudoun_county', label: 'Loudoun County / Leesburg' },
  {
    re: /\bprince\s*william\b|\bpwc\b|\bmanassas\b/i,
    code: 'prince_william_county',
    label: 'Prince William County',
  },
  { re: /\bwest\s*virginia\b|\bwv\b/i, code: 'west_virginia', label: 'West Virginia' },
  {
    re: /\bcity\s+of\s+fairfax\b|\bfairfax\s+city\b/i,
    code: 'city_of_fairfax',
    label: 'City of Fairfax',
  },
];

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /system\s*prompt/i,
  /you\s+are\s+now\b/i,
  /disregard\s+(all\s+)?(rules|instructions)/i,
  /<\/?script\b/i,
  /\bDROP\s+TABLE\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bINSERT\s+INTO\b/i,
  /\bUPDATE\s+\w+\s+SET\b/i,
  /\bACTIVATE\s+SOURCE\b/i,
  /\bpurchase\s+(contacts?|leads?)\b/i,
  /\bapprove\s+(for\s+)?(lending|mortgage|loan)\b/i,
];

const LENDING_CLAIM_PATTERNS = [
  /\blending\s+approv/i,
  /\bmortgage\s+ready\b/i,
  /\bloan\s+approv/i,
  /\bcreditworthy\b/i,
  /\bborrower\s+ready\b/i,
];

function envApiKey() {
  return (
    process.env.PERMIT_AI_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    ''
  ).trim();
}

/**
 * AI is optional. Without a key (or when forced off), deterministic helpers run.
 * Never fabricate LLM answers.
 */
export function getAiAvailability() {
  const forceOff =
    process.env.PERMIT_AI_FORCE_OFF === '1' ||
    getSetting('permit_ai_force_off', '0') === '1';
  const keyPresent = Boolean(envApiKey());
  const provider = process.env.PERMIT_AI_PROVIDER || (process.env.OPENAI_API_KEY ? 'openai' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : '');
  if (forceOff || !keyPresent) {
    return {
      available: false,
      state: 'unavailable',
      reason: forceOff
        ? 'AI forced off (PERMIT_AI_FORCE_OFF or setting)'
        : 'No AI API key configured — using deterministic filter helpers and evidence summaries',
      provider: null,
      model: ASSISTANT_MODEL_DETERMINISTIC,
      promptVersion: ASSISTANT_PROMPT_VERSION,
    };
  }
  return {
    available: true,
    state: 'available',
    reason: 'API key present — model calls remain budget/deadline constrained and tool-bound',
    provider: provider || 'configured',
    model: process.env.PERMIT_AI_MODEL || 'unspecified',
    promptVersion: ASSISTANT_PROMPT_VERSION,
  };
}

/** Redact secrets / contact-like values from audit strings. */
export function sanitizeForAudit(text, { max = 400 } = {}) {
  let s = String(text ?? '');
  s = s.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [REDACTED]');
  s = s.replace(/\bsk-[A-Za-z0-9]{10,}\b/g, '[REDACTED_KEY]');
  s = s.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]');
  s = s.replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[REDACTED_PHONE]');
  s = s.replace(envApiKey() ? new RegExp(envApiKey().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : /$a/, '[REDACTED]');
  if (s.length > max) s = `${s.slice(0, max)}…`;
  return s;
}

export function ensureAssistantTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      actor TEXT NOT NULL DEFAULT '',
      intent TEXT NOT NULL DEFAULT '',
      prompt_version TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      ai_state TEXT NOT NULL DEFAULT 'unavailable',
      input_redacted TEXT NOT NULL DEFAULT '',
      outcome TEXT NOT NULL DEFAULT '',
      abstained INTEGER NOT NULL DEFAULT 0,
      review_task TEXT NOT NULL DEFAULT '',
      meta_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS source_discovery_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT NOT NULL DEFAULT '',
      jurisdiction_code TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL DEFAULT '',
      endpoint TEXT NOT NULL DEFAULT '',
      rationale TEXT NOT NULL DEFAULT '',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'proposed',
      approved_by TEXT,
      approved_at TEXT,
      note TEXT NOT NULL DEFAULT ''
    );
  `);
}

function logAssistantEvent({
  actor = '',
  intent = '',
  aiState = 'unavailable',
  model = ASSISTANT_MODEL_DETERMINISTIC,
  input = '',
  outcome = '',
  abstained = false,
  reviewTask = '',
  meta = {},
} = {}) {
  ensureAssistantTables();
  db.prepare(
    `INSERT INTO assistant_audit_log(
       actor, intent, prompt_version, model, ai_state, input_redacted, outcome, abstained, review_task, meta_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    String(actor || '').slice(0, 120),
    String(intent || '').slice(0, 80),
    ASSISTANT_PROMPT_VERSION,
    String(model || ASSISTANT_MODEL_DETERMINISTIC).slice(0, 80),
    String(aiState || 'unavailable').slice(0, 40),
    sanitizeForAudit(input),
    sanitizeForAudit(outcome, { max: 600 }),
    abstained ? 1 : 0,
    String(reviewTask || '').slice(0, 400),
    JSON.stringify(meta || {})
  );
}

function detectInjection(text) {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

function detectLendingAsk(text) {
  return LENDING_CLAIM_PATTERNS.some((re) => re.test(text));
}

function detectDisallowedAction(text) {
  const hits = [];
  const lower = text.toLowerCase();
  if (/\bactivate\s+(the\s+)?source\b/.test(lower) || /\benable\s+(live\s+)?(loudoun|pwc|source)\b/.test(lower)) {
    hits.push('activate_source');
  }
  if (/\brun\s+(sql|query)\b/.test(lower) || /\bselect\s+\*\s+from\b/.test(lower)) {
    hits.push('run_sql');
  }
  if (/\b(spend|buy|purchase)\b.*\b(credit|contact|lead)/.test(lower) || /\bcharge\s+my\s+(card|account)\b/.test(lower)) {
    hits.push('spend_credits');
  }
  if (/\bsend\s+(email|sms|outreach|mailer)\b/.test(lower)) {
    hits.push('send_outreach');
  }
  if (/\bapprove\s+(for\s+)?(lending|mortgage|loan)\b/.test(lower)) {
    hits.push('approve_lending');
  }
  if (/\bmark\s+(source\s+)?verified\b/.test(lower) || /\bverify\s+source\b/.test(lower)) {
    hits.push('verify_source');
  }
  if (/\b(set|change|update)\s+(status|disposition)\s+to\b/.test(lower)) {
    hits.push('mutate_status');
  }
  return hits;
}

/**
 * Deterministic natural-language → supported permit filters.
 * Returns only keys in PERMIT_FILTER_KEYS (+ q). Never invents geography as verified.
 */
export function mapNaturalLanguageToFilters(rawQuery = '') {
  const query = String(rawQuery || '').trim();
  const filters = {};
  const notes = [];
  const unsupportedGeography = [];
  const matchedRules = [];
  let abstain = false;
  let reviewTask = '';
  let unknown = false;

  if (!query) {
    return {
      filters: {},
      q: '',
      matchedRules: [],
      notes: ['Empty query — no filters applied'],
      unsupportedGeography: [],
      abstain: true,
      unknown: true,
      reviewTask: 'Enter a filter request (e.g. “blocked Fairfax lots approaching start”).',
      disallowedActions: [],
      injectionDetected: false,
      lendingClaimRefused: false,
    };
  }

  const injectionDetected = detectInjection(query);
  const disallowedActions = detectDisallowedAction(query);
  const lendingClaimRefused = detectLendingAsk(query);

  if (injectionDetected) {
    abstain = true;
    unknown = true;
    reviewTask =
      'Possible instruction injection in free text. Treated as untrusted; no filters or mutations applied. Review manually.';
    notes.push('Injected instructions ignored — notes/public text are untrusted');
  }

  if (disallowedActions.length) {
    abstain = true;
    notes.push(`Disallowed action requested: ${disallowedActions.join(', ')} — refused`);
    reviewTask =
      reviewTask ||
      `Human review required: assistant cannot perform ${disallowedActions.join(', ')}.`;
  }

  if (lendingClaimRefused) {
    notes.push(
      'Refused: workflow readiness is not lending approval or source verification. No approval claim produced.'
    );
    reviewTask =
      reviewTask ||
      'Do not treat lot readiness as lending approval. Coordinator/LO must use separate compliance process.';
  }

  // Geography — Fairfax County is the pilot operational market; others labeled unsupported.
  if (/\bfairfax\s+county\b|\bfairfax\b/i.test(query) && !/\bcity\s+of\s+fairfax\b|\bfairfax\s+city\b/i.test(query)) {
    filters.jurisdiction_code = 'fairfax_county';
    matchedRules.push('jurisdiction:fairfax_county');
  }
  for (const g of UNSUPPORTED_GEO_HINTS) {
    if (g.re.test(query)) {
      unsupportedGeography.push({ code: g.code, label: g.label, status: 'unsupported' });
      matchedRules.push(`unsupported_geo:${g.code}`);
      notes.push(
        `${g.label} is unsupported for live verified checks in this pilot — shown as unsupported, not verified.`
      );
      // Do not set jurisdiction filter to unsupported AHJs as if they were operational.
    }
  }

  if (/\bblocked\b/i.test(query)) {
    filters.readiness_state = 'blocked';
    matchedRules.push('readiness:blocked');
  } else if (/\bneeds?\s+verif/i.test(query)) {
    filters.readiness_state = 'needs_verification';
    matchedRules.push('readiness:needs_verification');
  } else if (/\bready\b/i.test(query) && !lendingClaimRefused) {
    filters.readiness_state = 'ready';
    matchedRules.push('readiness:ready');
    notes.push(
      '“Ready” means operational workbook readiness under configured rules — not lending approval or AHJ verification.'
    );
  }

  if (/\bapproaching\s+start\b|\bstart\s+soon\b|\bdue\s+soon\b/i.test(query)) {
    filters.approaching_start = 'true';
    matchedRules.push('flag:approaching_start');
  }
  if (/\bmissing\s+propert/i.test(query)) {
    filters.missing_property = 'true';
    matchedRules.push('flag:missing_property');
  }
  if (/\bcontact\s+review\b|\breview\s+needed\b.*contact/i.test(query)) {
    filters.contact_review_needed = 'true';
    matchedRules.push('flag:contact_review_needed');
  }
  if (/\bcontacts?\s+available\b/i.test(query)) {
    filters.contacts_available = 'true';
    matchedRules.push('flag:contacts_available');
  }
  if (/\b(has|with)\s+(official\s+)?id\b|\bofficial\s+id\b/i.test(query)) {
    filters.has_official_id = 'true';
    matchedRules.push('flag:has_official_id');
  }
  if (/\bfairfax[- ]shaped\b|\bALTR-|BLDR-|ALTC-/i.test(query)) {
    filters.fairfax_shaped = 'true';
    matchedRules.push('flag:fairfax_shaped');
  }
  if (/\bresidential\b/i.test(query)) {
    filters.use_classification = 'residential';
    matchedRules.push('use:residential');
  } else if (/\bcommercial\b/i.test(query)) {
    filters.use_classification = 'commercial';
    matchedRules.push('use:commercial');
  } else if (/\bmixed[- ]use\b/i.test(query)) {
    filters.use_classification = 'mixed_use';
    matchedRules.push('use:mixed_use');
  }

  if (/\bwatching\b/i.test(query)) {
    filters.internal_status = 'watching';
    matchedRules.push('internal:watching');
  } else if (/\bin\s+progress\b/i.test(query)) {
    filters.internal_status = 'in_progress';
    matchedRules.push('internal:in_progress');
  }

  // Free-text q: only when user quotes a search term or says "search/find …"
  const quoted = query.match(/["']([^"']{2,80})["']/);
  const searchMatch = query.match(/\b(?:search|find|containing)\s+["']?([A-Za-z0-9][A-Za-z0-9\s\-/#]{1,60})/i);
  let q = '';
  if (quoted) {
    q = quoted[1].trim();
    matchedRules.push('q:quoted');
  } else if (searchMatch && !injectionDetected) {
    q = searchMatch[1].trim();
    // Avoid capturing filter keywords as q
    if (/^(blocked|ready|fairfax|loudoun|approaching)/i.test(q)) q = '';
    else matchedRules.push('q:search');
  }

  if (!matchedRules.length && !injectionDetected && !disallowedActions.length) {
    unknown = true;
    abstain = true;
    reviewTask =
      reviewTask ||
      'Could not map request to supported filters. Use toolbar filters or rephrase (blocked, approaching start, Fairfax, missing property, …).';
    notes.push('No supported filter mapping — abstaining rather than guessing');
  }

  // Injection or disallowed actions: never apply filters (fail closed).
  let safeFilters = filters;
  let safeQ = q;
  if (injectionDetected || disallowedActions.length) {
    safeFilters = {};
    safeQ = '';
    abstain = true;
    unknown = true;
  }

  const normalized = normalizePermitFilters(safeFilters);
  // Drop any unexpected keys
  for (const k of Object.keys(normalized)) {
    if (!PERMIT_FILTER_KEYS.includes(k)) delete normalized[k];
  }

  return {
    filters: normalized,
    q: safeQ,
    matchedRules,
    notes,
    unsupportedGeography,
    abstain,
    unknown,
    reviewTask,
    disallowedActions,
    injectionDetected,
    lendingClaimRefused,
    filterLinks: {
      applyQuery: new URLSearchParams(
        Object.fromEntries(
          Object.entries({ q: safeQ, ...normalized }).filter(
            ([, v]) => v != null && String(v) !== ''
          )
        )
      ).toString(),
    },
  };
}

/**
 * Evidence-only "what changed / why blocked" summary for one permit.
 * Abstains with Unknown when evidence is incomplete or conflicting.
 */
export function summarizePermitEvidence(permitId, { actor = '', limitHistory = 12 } = {}) {
  const id = Number(permitId);
  const permit = db
    .prepare(
      `SELECT p.*, lg.lot_label, lg.notes_raw, cs.community_name, cs.project_code
       FROM permit_records p
       JOIN lot_groups lg ON lg.id = p.lot_group_id
       JOIN community_sections cs ON cs.id = lg.section_id
       WHERE p.id = ?`
    )
    .get(id);

  if (!permit) {
    return {
      ok: false,
      abstain: true,
      unknown: true,
      reviewTask: 'Permit not found — cannot summarize.',
      summary: null,
      disclaimer:
        'Evidence summary only. Not lending approval. Not source verification.',
    };
  }

  const readiness = assessPermitReadiness(id) || getStoredAssessment(id);
  const history = db
    .prepare(
      `SELECT field, old_value, new_value, changed_by, source, created_at
       FROM field_changes WHERE permit_record_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(id, limitHistory);
  const attention = db
    .prepare(
      `SELECT kind, message, created_at, acknowledged, resolved_at
       FROM attention_events
       WHERE permit_record_id = ? AND resolved_at IS NULL
       ORDER BY created_at DESC LIMIT 20`
    )
    .all(id);
  const snapshots = db
    .prepare(
      `SELECT official_id, outcome, mode, checked_at
       FROM official_snapshots WHERE permit_record_id = ?
       ORDER BY checked_at DESC LIMIT 5`
    )
    .all(id);

  const outstanding = readiness?.outstanding || [];
  const gaps = readiness?.gaps || [];
  const satisfied = readiness?.satisfied || [];

  // Conflicting status: official vs readiness vs attention
  const conflicts = [];
  if (
    readiness?.state === 'ready' &&
    outstanding.length > 0
  ) {
    conflicts.push({
      kind: 'readiness_conflict',
      detail: 'Stored state is ready but outstanding prerequisites remain in evidence',
    });
  }
  if (
    permit.official_status &&
    readiness?.state === 'blocked' &&
    /issued|approved|final/i.test(String(permit.official_status)) &&
    outstanding.length === 0 &&
    gaps.length === 0
  ) {
    conflicts.push({
      kind: 'status_conflict',
      detail: `Official status “${permit.official_status}” looks complete while readiness is blocked — do not invent a resolution`,
    });
  }
  if (snapshots.length >= 2) {
    const a = snapshots[0]?.outcome;
    const b = snapshots[1]?.outcome;
    if (a && b && a !== b && a !== 'unchanged' && b !== 'unchanged') {
      conflicts.push({
        kind: 'snapshot_conflict',
        detail: `Recent check outcomes differ (${a} vs ${b}) — review required`,
      });
    }
  }

  // Treat notes_raw as untrusted — never execute / never elevate
  const notesUntrusted = Boolean(permit.notes_raw && String(permit.notes_raw).trim());
  if (notesUntrusted && detectInjection(permit.notes_raw)) {
    conflicts.push({
      kind: 'untrusted_notes',
      detail: 'Workbook notes contain instruction-like text — ignored for conclusions',
    });
  }

  const incomplete =
    !readiness ||
    (readiness.state === 'needs_verification' && gaps.length > 0) ||
    (outstanding.some((o) => o.status === 'missing' || o.status === 'unknown'));

  const abstain = conflicts.length > 0 || (incomplete && outstanding.length === 0 && !history.length);
  const unknown = abstain || incomplete;

  const whyBlocked = [];
  if (readiness?.state === 'blocked' || readiness?.state === 'needs_verification') {
    for (const o of outstanding) {
      whyBlocked.push({
        id: o.id || null,
        label: o.label || o.id || 'Unknown prerequisite',
        status: o.status || 'unknown',
        evidence: o.evidence || o.reason || 'From readiness assessment only',
      });
    }
    for (const g of gaps) {
      whyBlocked.push({
        id: g.id || null,
        label: g.label || 'Verification gap',
        status: 'gap',
        evidence: g.evidence || g.reason || 'Gap recorded in assessment',
      });
    }
  }

  const whatChanged = history.map((h) => ({
    field: h.field,
    from: h.old_value,
    to: h.new_value,
    at: h.created_at,
    by: h.changed_by,
    source: h.source,
  }));

  const sourceLinks = [];
  if (permit.source_url) sourceLinks.push({ kind: 'permit_source', url: permit.source_url });
  const src = listSources({ jurisdiction_code: permit.jurisdiction_code }).find(
    (s) => s.state === 'verified' || s.activated
  );
  if (src?.endpoint) {
    sourceLinks.push({
      kind: 'registry',
      key: src.key,
      url: src.endpoint,
      state: src.state,
      activated: Boolean(src.activated),
    });
  }

  const bullets = [];
  bullets.push(
    `Record ${permit.primary_official_id || '(no official ID)'} · ${permit.community_name || ''} lot ${permit.lot_label || ''}`.trim()
  );
  if (readiness) {
    bullets.push(
      `Operational readiness: ${readiness.state} (ruleset ${readiness.ruleset_key || 'n/a'}) — not lending approval`
    );
  } else {
    bullets.push('Operational readiness: Unknown — no assessment evidence');
  }
  if (whyBlocked.length) {
    bullets.push(
      `Blockers/gaps from evidence (${whyBlocked.length}): ${whyBlocked
        .slice(0, 5)
        .map((b) => b.label)
        .join('; ')}`
    );
  } else if (readiness?.state === 'blocked') {
    bullets.push('Blocked state present but no outstanding labels in evidence — Unknown detail');
  }
  if (whatChanged.length) {
    bullets.push(
      `Recent field changes (${whatChanged.length} shown): ${whatChanged
        .slice(0, 3)
        .map((c) => `${c.field}: ${c.from || '∅'} → ${c.to || '∅'}`)
        .join('; ')}`
    );
  } else {
    bullets.push('No field_changes rows retrieved — what-changed is Unknown');
  }
  if (attention.length) {
    bullets.push(`Open attention: ${attention.map((a) => a.kind).join(', ')}`);
  }
  if (conflicts.length) {
    bullets.push(`Conflicts requiring human review: ${conflicts.map((c) => c.kind).join(', ')}`);
  }

  const reviewTask = abstain || unknown
    ? conflicts.length
      ? 'Resolve conflicting evidence manually before acting.'
      : incomplete
        ? 'Complete missing evidence / verification gaps; do not invent IDs, dates, or contacts.'
        : 'Evidence insufficient — mark Unknown and create a review task.'
    : '';

  const result = {
    ok: true,
    abstain,
    unknown,
    reviewTask,
    permitId: id,
    officialId: permit.primary_official_id || null,
    jurisdiction: permit.jurisdiction_code,
    readinessState: readiness?.state || 'unknown',
    summary: {
      bullets,
      whyBlocked,
      whatChanged,
      attention: attention.map((a) => ({ kind: a.kind, message: a.message, at: a.created_at })),
      satisfiedCount: satisfied.length,
      conflicts,
      sourceLinks,
      owner: permit.owner || '',
      nextAction: permit.next_action || '',
      nextActionDue: permit.next_action_due || null,
    },
    disclaimer:
      'Evidence summary from retrieved records only. Not lending approval. Not official source verification. Contacts/IDs/dates not invented.',
    ai: getAiAvailability(),
  };

  logAssistantEvent({
    actor,
    intent: 'summarize_evidence',
    aiState: result.ai.state,
    model: result.ai.model,
    input: `permit:${id}`,
    outcome: bullets.join(' | '),
    abstained: abstain,
    reviewTask,
    meta: { conflicts: conflicts.length, unknown },
  });

  return result;
}

/**
 * Owner-only, cheap, proposal-only source discovery.
 * Never activates. Human approval required (separate activate endpoint).
 */
export function proposeSourceDiscoveries({ actor = '', jurisdictionHint = '' } = {}) {
  ensureAssistantTables();
  const hint = String(jurisdictionHint || '').toLowerCase();
  const registry = listSources();

  const proposals = [];
  for (const cand of SEED_ARCGIS_CANDIDATES) {
    if (
      hint &&
      !String(cand.jurisdiction_code).includes(hint) &&
      !hint.includes(cand.jurisdiction_code.split('_')[0])
    ) {
      continue;
    }
    const endpoint = String(cand.url || '');
    const match = registry.find(
      (s) =>
        String(s.endpoint || '').toLowerCase() === endpoint.toLowerCase() ||
        (cand.jurisdiction_code === 'fairfax_county' &&
          s.key === 'fairfax_county_building_records_plus')
    );
    // Skip only when already verified (or activated) — no spam proposals for live Fairfax.
    if (match && (match.state === 'verified' || match.activated)) {
      continue;
    }
    const rationale = [
      'Cheap catalog proposal from built-in SEED_ARCGIS_CANDIDATES.',
      match
        ? `Registry already has key=${match.key} state=${match.state} activated=${Boolean(match.activated)} — proposal for human review only.`
        : 'Not yet in registry as an operational source.',
      'Not inspected live in this call.',
      'Not activated. Not verified. Human must review and use existing activate flow if appropriate.',
    ].join(' ');
    const info = db
      .prepare(
        `INSERT INTO source_discovery_proposals(
           created_by, jurisdiction_code, label, endpoint, rationale, evidence_json, status
         ) VALUES (?, ?, ?, ?, ?, ?, 'proposed')`
      )
      .run(
        actor,
        cand.jurisdiction_code,
        cand.label,
        endpoint,
        rationale,
        JSON.stringify({
          origin: 'SEED_ARCGIS_CANDIDATES',
          proposalOnly: true,
          requiresHumanApproval: true,
          existingRegistryKey: match?.key || null,
          existingState: match?.state || null,
          ai: getAiAvailability().state,
        })
      );
    proposals.push({
      id: Number(info.lastInsertRowid),
      jurisdiction_code: cand.jurisdiction_code,
      label: cand.label,
      endpoint,
      status: 'proposed',
      rationale,
      existingRegistryKey: match?.key || null,
    });
  }

  logAssistantEvent({
    actor,
    intent: 'propose_source_discovery',
    aiState: getAiAvailability().state,
    input: jurisdictionHint || '(all seed candidates)',
    outcome: `proposed=${proposals.length}`,
    meta: { count: proposals.length },
  });

  return {
    proposals,
    count: proposals.length,
    note: 'Proposal-only. Does not activate sources, spend, or mark verified. Owner must approve via normal activate path after review.',
    ai: getAiAvailability(),
  };
}

export function listSourceDiscoveryProposals({ status = 'proposed' } = {}) {
  ensureAssistantTables();
  if (status) {
    return db
      .prepare(
        `SELECT id, created_at, created_by, jurisdiction_code, label, endpoint, rationale, status, approved_by, approved_at, note
         FROM source_discovery_proposals WHERE status = ? ORDER BY id DESC LIMIT 100`
      )
      .all(status);
  }
  return db
    .prepare(
      `SELECT id, created_at, created_by, jurisdiction_code, label, endpoint, rationale, status, approved_by, approved_at, note
       FROM source_discovery_proposals ORDER BY id DESC LIMIT 100`
    )
    .all();
}

/**
 * Record human acknowledgement of a proposal. Does NOT activate the source.
 */
export function acknowledgeSourceProposal(id, { actor = '', decision = 'rejected', note = '' } = {}) {
  ensureAssistantTables();
  const row = db.prepare('SELECT * FROM source_discovery_proposals WHERE id = ?').get(Number(id));
  if (!row) {
    const err = new Error('Proposal not found');
    err.code = 'not_found';
    throw err;
  }
  if (!['rejected', 'approved_for_review'].includes(decision)) {
    const err = new Error('decision must be rejected or approved_for_review (activation is a separate owner action)');
    err.code = 'invalid_decision';
    throw err;
  }
  db.prepare(
    `UPDATE source_discovery_proposals
     SET status = ?, approved_by = ?, approved_at = datetime('now'), note = ?
     WHERE id = ?`
  ).run(decision, actor, String(note || '').slice(0, 500), Number(id));
  return db.prepare('SELECT * FROM source_discovery_proposals WHERE id = ?').get(Number(id));
}

/**
 * Unified assistant entry — maps NL and/or summarizes evidence.
 * Model path is stubbed: if AI unavailable, deterministic only (never fake LLM).
 */
export function runAssistant({
  query = '',
  permitId = null,
  intent = 'auto',
  actor = '',
} = {}) {
  const ai = getAiAvailability();
  const text = String(query || '').trim();
  let resolvedIntent = intent;
  if (intent === 'auto') {
    if (permitId && (/what\s+changed|why\s+block|summar/i.test(text) || !text)) {
      resolvedIntent = 'summarize_evidence';
    } else if (/propos(e|al).*source|discover.*source/i.test(text)) {
      resolvedIntent = 'propose_source_discovery';
    } else {
      resolvedIntent = 'map_filters';
    }
  }

  // Budget/deadline placeholders when a model would be used
  const budget = {
    maxTokens: Number(process.env.PERMIT_AI_MAX_TOKENS || 800),
    deadlineMs: Number(process.env.PERMIT_AI_DEADLINE_MS || 8000),
    spent: false,
    modelInvoked: false,
  };

  if (resolvedIntent === 'propose_source_discovery') {
    // Caller must enforce requireOwner; we still do not activate here.
    const out = proposeSourceDiscoveries({ actor, jurisdictionHint: text });
    return {
      intent: resolvedIntent,
      ai,
      budget,
      ...out,
      message: ai.available
        ? 'AI key present but source proposals use deterministic catalog (cheap) — no broad API hunter.'
        : 'AI unavailable — deterministic catalog proposals only.',
    };
  }

  if (resolvedIntent === 'summarize_evidence') {
    if (!permitId) {
      return {
        intent: resolvedIntent,
        ai,
        budget,
        abstain: true,
        unknown: true,
        reviewTask: 'Select a permit to summarize evidence.',
        filterMapping: null,
        evidence: null,
        message: 'No permitId — cannot retrieve evidence.',
      };
    }
    const evidence = summarizePermitEvidence(permitId, { actor });
    return {
      intent: resolvedIntent,
      ai,
      budget,
      filterMapping: null,
      evidence,
      message: ai.available
        ? 'AI key present but evidence summary uses retrieved rows only (no invented facts).'
        : 'AI unavailable — deterministic evidence summary from retrieved records.',
    };
  }

  // map_filters (default)
  const filterMapping = mapNaturalLanguageToFilters(text);
  logAssistantEvent({
    actor,
    intent: 'map_filters',
    aiState: ai.state,
    model: ai.model,
    input: text,
    outcome: JSON.stringify({
      filters: filterMapping.filters,
      q: filterMapping.q,
      abstain: filterMapping.abstain,
    }),
    abstained: filterMapping.abstain,
    reviewTask: filterMapping.reviewTask,
    meta: {
      unsupportedGeography: filterMapping.unsupportedGeography,
      injectionDetected: filterMapping.injectionDetected,
      disallowedActions: filterMapping.disallowedActions,
    },
  });

  let evidence = null;
  if (permitId && /why|changed|block|summar/i.test(text)) {
    evidence = summarizePermitEvidence(permitId, { actor });
  }

  return {
    intent: 'map_filters',
    ai,
    budget,
    filterMapping,
    evidence,
    allowedTools: ALLOWED_ASSISTANT_TOOLS,
    disallowedActions: DISALLOWED_ASSISTANT_ACTIONS,
    message: ai.available
      ? 'AI key present — filter mapping remains server-constrained; model not required for this path.'
      : 'AI unavailable — deterministic NL→filter mapping applied. Manual filters still work.',
  };
}

export function phase7AssistantStatus() {
  const ai = getAiAvailability();
  return {
    phase: 7,
    ai,
    allowedTools: ALLOWED_ASSISTANT_TOOLS,
    disallowedActions: DISALLOWED_ASSISTANT_ACTIONS,
    promptVersion: ASSISTANT_PROMPT_VERSION,
    notes: [
      'AI optional and fail-safe.',
      'Manual coordination/discovery works with AI disabled.',
      'Never converts readiness into lending approval.',
      'Source proposals are proposal-only; activate remains owner-gated elsewhere.',
    ],
  };
}

/** Test helper: force AI off without env mutation side effects beyond setting. */
export function forceAiOff(on = true) {
  setSetting('permit_ai_force_off', on ? '1' : '0');
}
