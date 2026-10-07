import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { db, getSetting, setSetting, recordChange, migrate, getDbPath, dbIsReady } from './db.js';
import { listConnectors, FAIRFAX_FIELD_AVAILABILITY } from './connectors/index.js';
import {
  syncPermitById,
  syncAllLinked,
  rebuildAttention,
  getSchedulePreview,
} from './sync.js';
import {
  getReadinessRuleset,
  setReadinessRuleset,
  assessPermitReadiness,
  getStoredAssessment,
  rebuildAllReadiness,
  updateLotReadiness,
  DEFAULT_RULESET,
} from './readiness.js';
import {
  parseWorkbookBuffer,
  commitWorkbookParse,
  importWorkbookFile,
  isFairfaxShapedId,
} from './workbookImport.js';
import { exportCoexistenceXlsx } from './excelExport.js';
import { seed } from './seed.js';
import {
  ensureSourceRegistrySeeded,
  listSources,
  getSource,
  activateSource,
  setSourceState,
} from './sources/registry.js';
import { inspectArcGisUrl, SEED_ARCGIS_CANDIDATES } from './sources/arcgisDiscover.js';
import { connectLocation, discoveryProviderInterface } from './sources/connectLocation.js';
import {
  upsertProperty,
  linkPropertyToLot,
  listPropertiesForPermit,
  previewCrosswalk,
  commitCrosswalk,
  confirmationHistory,
  getProperty,
  missingPropertyLotCount,
  missingPropertyQueue,
  offerOfficialSiteAddressCandidate,
  crosswalkTemplateCsv,
  propertyBelongsToPermit,
} from './property.js';
import {
  listContacts,
  addManualContact,
  setContactStatus,
  findContactsForProperty,
  contactsReviewNeededCount,
  contactsAvailableLotCount,
  CONTACT_ROLES,
  tracerfyConfig,
  reconcileTimedOutJob,
} from './contacts.js';
import { setProviderMode, PROVIDER_MODES } from './providers/tracerfy.js';
import {
  USE_CLASSES,
  USE_CLASS_LABELS,
  USE_SOURCES,
  setManualUseOverride,
} from './useClassification.js';
import {
  attachAuth,
  requireAuth,
  requireOwner,
  protectStateChange,
  authEnabled,
  authStatus,
  assertPilotAuthConfig,
  login,
  logout,
  acceptInvite,
  createInvite,
  publicUser,
  serializeCookie,
  clearCookie,
  assertLoginAllowed,
  recordLoginFailure,
  clearLoginFailures,
  loginThrottleKey,
  COOKIE_NAME,
} from './auth.js';
import XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const clientDist = path.join(root, 'client', 'dist');
const clientIndex = path.join(clientDist, 'index.html');
const frontendBuilt = () => fs.existsSync(clientIndex);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const requestActor = new AsyncLocalStorage();

function readReleaseInfo() {
  const candidates = [
    path.join(__dirname, 'release-info.json'),
    path.join(root, 'server', 'release-info.json'),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return {
        version: String(raw.version || '0.0.0'),
        gitSha: String(raw.gitSha || 'unknown'),
        gitShaShort: String(raw.gitShaShort || (raw.gitSha || 'unknown').toString().slice(0, 7)),
        builtAt: raw.builtAt || null,
      };
    } catch {
      /* try next */
    }
  }
  let pkgVersion = '0.0.0';
  try {
    pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    /* ignore */
  }
  const envSha =
    process.env.SOURCE_COMMIT || process.env.GITHUB_SHA || process.env.GIT_SHA || 'unknown';
  return {
    version: pkgVersion,
    gitSha: envSha,
    gitShaShort: envSha === 'unknown' ? 'unknown' : String(envSha).slice(0, 7),
    builtAt: null,
  };
}

const releaseInfo = readReleaseInfo();

const SOURCE_WORKBOOK =
  process.env.SOURCE_WORKBOOK_XLSX ||
  process.env.GOSPEL_XLSX ||
  '';

migrate();
let authConfig;
try {
  authConfig = assertPilotAuthConfig();
} catch (e) {
  if (process.env.PERMIT_NO_LISTEN === '1') {
    // Tests may import the app without pilot bootstrap; surface via readiness later.
    authConfig = { ok: false, mode: 'config_error', error: String(e.message || e) };
  } else {
    console.error(`Permit Ledger auth config error: ${e.message || e}`);
    process.exit(1);
  }
}
ensureSourceRegistrySeeded();
// Clean deploy: do NOT auto-seed from /cursor/stores. Only seed when a workbook path
// is configured and present, or PERMIT_DEMO=1 requests the isolated probe.
const autoSeed = process.env.AUTO_SEED !== '0';
if (autoSeed && db.prepare('SELECT COUNT(*) AS c FROM community_sections').get().c === 0) {
  const workbookReady = SOURCE_WORKBOOK && fs.existsSync(SOURCE_WORKBOOK);
  if (workbookReady || process.env.PERMIT_DEMO === '1') {
    seed({ includeDemoProbe: process.env.PERMIT_DEMO === '1' });
  }
}

const app = express();
// Same-origin deploy: when auth is on, do not reflect arbitrary Origins (credentials).
app.use(
  cors({
    origin(origin, callback) {
      if (!authEnabled()) return callback(null, true);
      if (!origin) return callback(null, true);
      // Cross-origin credentialed access is not part of the private trial packaging.
      return callback(null, false);
    },
    credentials: true,
  })
);
app.use(express.json({ limit: '4mb' }));
app.use(attachAuth);
app.use((req, res, next) => {
  requestActor.run({ actor: req.actor }, next);
});
app.use(protectStateChange);
// Invite-only when auth on — public health + auth endpoints stay reachable.
app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/auth')) return next();
  return requireAuth(req, res, next);
});

function currentUser() {
  const store = requestActor.getStore();
  if (store?.actor) return store.actor;
  if (authEnabled()) return 'anonymous';
  return getSetting('current_user', 'local.dev');
}

const PERMIT_SQL = `SELECT p.*,
  lg.lot_label, lg.housetype, lg.notes_raw, lg.section_id,
  cs.project_code, cs.community_name, cs.permit_time_note, cs.jurisdiction_code AS section_jurisdiction
  FROM permit_records p
  JOIN lot_groups lg ON lg.id = p.lot_group_id
  JOIN community_sections cs ON cs.id = lg.section_id`;

app.get('/api/health', (_req, res) => {
  const processOk = true;
  const dbOk = dbIsReady();
  const built = frontendBuilt();
  const authOk = !authEnabled() || authConfig?.ok !== false;
  const ready = processOk && dbOk && built && authOk;
  // Public health stays lean — release id only (no paths/secrets) to identify Hostinger builds.
  res.status(ready ? 200 : 503).json({
    ok: processOk,
    ready,
    service: 'permit-ledger',
    release: {
      version: releaseInfo.version,
      gitShaShort: releaseInfo.gitShaShort,
    },
  });
});

app.get('/api/health/details', requireAuth, requireOwner, (_req, res) => {
  const built = frontendBuilt();
  res.json({
    ok: true,
    ready: dbIsReady() && built && (!authEnabled() || authConfig?.ok !== false),
    service: 'permit-ledger',
    mode: 'workbook-native-prototype',
    release: releaseInfo,
    auth: authEnabled(),
    authConfigMode: authConfig?.mode || null,
    dbPathConfigured: Boolean(process.env.PERMIT_DB_PATH),
    dbPath: getDbPath(),
    dbReady: dbIsReady(),
    frontendBuilt: built,
    clientDist: 'client/dist',
    diagnostic: built
      ? null
      : 'Frontend assets missing: run `npm run build` so client/dist/index.html exists before start.',
  });
});

app.get('/api/auth/status', (req, res) => {
  res.json({
    ...authStatus(),
    user: publicUser(req.user),
  });
});

app.post('/api/auth/login', (req, res) => {
  const email = req.body?.email;
  const key = loginThrottleKey(email, req.ip || req.socket?.remoteAddress || '');
  try {
    assertLoginAllowed(key);
    const result = login(email, req.body?.password);
    clearLoginFailures(key);
    const secure = process.env.COOKIE_SECURE === '1' || req.secure;
    res.setHeader('Set-Cookie', serializeCookie(result.token, { secure }));
    res.json({ user: result.user, expires_at: result.expires_at });
  } catch (e) {
    if (e.code === 'LOGIN_THROTTLED') {
      return res.status(429).json({ error: String(e.message || e) });
    }
    recordLoginFailure(key);
    res.status(401).json({ error: String(e.message || e) });
  }
});

app.post('/api/auth/logout', (req, res) => {
  logout(req.authToken);
  const secure = process.env.COOKIE_SECURE === '1' || req.secure;
  res.setHeader('Set-Cookie', clearCookie({ secure }));
  res.json({ ok: true });
});

app.post('/api/auth/accept-invite', (req, res) => {
  try {
    const user = acceptInvite({
      token: req.body?.token,
      password: req.body?.password,
      displayName: req.body?.displayName || '',
    });
    const result = login(user.email, req.body?.password);
    const secure = process.env.COOKIE_SECURE === '1' || req.secure;
    res.setHeader('Set-Cookie', serializeCookie(result.token, { secure }));
    res.json({ user: result.user });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post('/api/auth/invite', requireAuth, requireOwner, (req, res) => {
  try {
    const invite = createInvite({
      email: req.body?.email,
      role: req.body?.role || 'operator',
      createdBy: req.user?.id,
    });
    res.json({
      email: invite.email,
      role: invite.role,
      expires_at: invite.expires_at,
      // Token returned once to owner for out-of-band delivery — not logged.
      invite_token: invite.token,
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.get('/api/meta', requireAuth, (req, res) => {
  const rules = getReadinessRuleset();
  res.json({
    user: currentUser(),
    authUser: publicUser(req.user),
    authEnabled: authEnabled(),
    staleDays: Number(getSetting('stale_days', '14')),
    approachingStartDays: Number(rules.approachingStartDays || 21),
    demoMode: getSetting('demo_mode', '0') === '1',
    connectors: listConnectors(),
    fairfaxFieldAvailability: FAIRFAX_FIELD_AVAILABILITY,
    readinessRulesetKey: rules.key,
    useClasses: USE_CLASSES,
    useClassLabels: USE_CLASS_LABELS,
    useSources: USE_SOURCES,
    useClassificationNote:
      'Use (residential/commercial/mixed/unknown) is separate from work type. Official labels preferred; unreliable → Unknown. Manual override survives later syncs.',
    productPromise:
      'Automatically run specific permit checks for communities/lots, preserve internal spreadsheet workflow, show what changed before morning meeting.',
    importProfile: 'source workbook (employer-specific mapping separate from reusable core)',
    trialSequence:
      'Import workbook → fill missing property info → confirm property → retrieve supported official info → optionally find contacts → review → export → inspect Attention',
    businessName: getSetting('business_name', ''),
    tracerfy: tracerfyConfig(),
    tracerfySetupNote:
      'Connect Tracerfy to enable live lookups: set TRACERFY_API_TOKEN, tracerfy_spend_limit_credits, tracerfy_commercial_confirmed=1, and tracerfy_production_enabled=1 in the host environment/secrets (see docs/deploy.md). Never paste tokens in chat.',
  });
});

app.post('/api/permits/:id/use-classification', (req, res) => {
  try {
    const permitId = Number(req.params.id);
    const { use_classification, clear } = req.body || {};
    const updated = setManualUseOverride(db, permitId, clear ? '' : use_classification, {
      actor: currentUser(),
    });
    recordChange(
      permitId,
      'use_classification_manual',
      '',
      clear ? '' : use_classification,
      currentUser(),
      'ui'
    );
    res.json({ permit: updated });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post('/api/settings', requireAuth, requireOwner, (req, res) => {
  const { staleDays, user, demoMode } = req.body || {};
  if (staleDays != null) setSetting('stale_days', Number(staleDays));
  // When auth is on, identity comes from the session — do not allow global demo.user override.
  if (user && !authEnabled()) setSetting('current_user', String(user));
  if (demoMode != null) setSetting('demo_mode', demoMode ? '1' : '0');
  rebuildAttention();
  res.json({
    ok: true,
    staleDays: Number(getSetting('stale_days', '14')),
    user: currentUser(),
    demoMode: getSetting('demo_mode', '0') === '1',
  });
});

app.get('/api/sections', (_req, res) => {
  const sections = db
    .prepare(
      `SELECT cs.*,
        (SELECT COUNT(*) FROM lot_groups lg WHERE lg.section_id = cs.id) AS lot_group_count,
        (SELECT COUNT(*) FROM permit_records p
           JOIN lot_groups lg ON lg.id = p.lot_group_id
           WHERE lg.section_id = cs.id) AS permit_count
       FROM community_sections cs ORDER BY cs.community_name`
    )
    .all();
  res.json({ sections });
});

app.get('/api/permits', (req, res) => {
  const {
    q,
    jurisdiction_code,
    official_status,
    internal_status,
    readiness_state,
    approaching_start,
    missing_property,
    contacts_available,
    contact_review_needed,
    has_official_id,
    fairfax_shaped,
    use_classification,
    include_demo,
    sort = 'updated_at',
    dir = 'desc',
  } = req.query;
  const allowed = new Set([
    'updated_at',
    'community_name',
    'lot_label',
    'official_status',
    'internal_status',
    'readiness_state',
    'next_action_due',
    'primary_official_id',
    'use_classification',
  ]);
  const sortCol = allowed.has(String(sort)) ? String(sort) : 'updated_at';
  const sortDir = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  let sql = `SELECT p.*,
    lg.lot_label, lg.housetype, lg.notes_raw, lg.section_id,
    cs.project_code, cs.community_name, cs.permit_time_note, cs.jurisdiction_code AS section_jurisdiction,
    ra.target_start AS target_start, ra.days_to_start AS days_to_start, ra.summary AS readiness_summary
    FROM permit_records p
    JOIN lot_groups lg ON lg.id = p.lot_group_id
    JOIN community_sections cs ON cs.id = lg.section_id
    LEFT JOIN readiness_assessments ra ON ra.permit_record_id = p.id
    WHERE 1=1`;
  const params = [];
  if (include_demo !== 'true') {
    sql += ` AND p.record_origin = 'import'`;
  }
  if (q) {
    sql += ` AND (
      cs.community_name LIKE ? OR cs.project_code LIKE ? OR lg.lot_label LIKE ?
      OR lg.housetype LIKE ? OR IFNULL(p.primary_official_id,'') LIKE ?
      OR lg.notes_raw LIKE ? OR p.owner LIKE ?
    )`;
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like, like);
  }
  if (jurisdiction_code) {
    sql += ' AND p.jurisdiction_code = ?';
    params.push(jurisdiction_code);
  }
  if (official_status) {
    sql += ' AND p.official_status = ?';
    params.push(official_status);
  }
  if (internal_status) {
    sql += ' AND p.internal_status = ?';
    params.push(internal_status);
  }
  if (use_classification) {
    sql += ' AND p.use_classification = ?';
    params.push(use_classification);
  }
  if (readiness_state) {
    sql += ' AND p.readiness_state = ?';
    params.push(readiness_state);
  }
  if (approaching_start === 'true') {
    sql += ` AND ra.target_start IS NOT NULL AND ra.days_to_start IS NOT NULL
             AND ra.days_to_start >= 0 AND ra.days_to_start <= ?`;
    params.push(Number(getReadinessRuleset().approachingStartDays || 45));
  }
  if (missing_property === 'true') {
    sql += ` AND NOT EXISTS (
      SELECT 1 FROM property_links pl
      WHERE pl.lot_group_id = lg.id AND pl.link_state IN ('candidate','confirmed')
    )`;
  }
  if (contacts_available === 'true') {
    sql += ` AND EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.lot_group_id = lg.id AND c.status IN ('candidate','confirmed')
        AND c.record_origin != 'sandbox_demo'
    )`;
  }
  if (contact_review_needed === 'true') {
    sql += ` AND EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.lot_group_id = lg.id AND c.status = 'candidate'
        AND c.record_origin != 'sandbox_demo'
    )`;
  }
  if (has_official_id === 'true') {
    sql += ` AND p.primary_official_id IS NOT NULL AND p.primary_official_id != ''`;
  }
  if (fairfax_shaped === 'true') {
    sql += ` AND (
      p.primary_official_id GLOB 'ALTC-*'
      OR p.primary_official_id GLOB 'ALTR-*'
      OR p.primary_official_id GLOB 'BLDR-*'
      OR p.primary_official_id GLOB 'BLDC-*'
    )`;
  }
  const sortExpr =
    sortCol === 'community_name'
      ? 'cs.community_name'
      : sortCol === 'lot_label'
        ? 'lg.lot_label'
        : `p.${sortCol}`;
  sql += ` ORDER BY ${sortExpr} ${sortDir}, p.id ASC`;
  const permits = db.prepare(sql).all(...params).map((p) => ({
    ...p,
    fairfax_shaped: p.primary_official_id ? isFairfaxShapedId(p.primary_official_id) : false,
  }));
  res.json({ permits });
});

app.get('/api/readiness/rules', (_req, res) => {
  res.json({ ruleset: getReadinessRuleset(), defaults: DEFAULT_RULESET });
});

app.put('/api/readiness/rules', (req, res) => {
  const body = req.body || {};
  const next = setReadinessRuleset({
    ...getReadinessRuleset(),
    ...body,
    approachingStartDays:
      body.approachingStartDays != null
        ? Number(body.approachingStartDays)
        : getReadinessRuleset().approachingStartDays,
  });
  setSetting('approaching_start_days', String(next.approachingStartDays || 45));
  const rebuilt = rebuildAllReadiness();
  rebuildAttention();
  res.json({ ruleset: next, counts: rebuilt.counts });
});

app.post('/api/readiness/rebuild', (_req, res) => {
  const rebuilt = rebuildAllReadiness();
  rebuildAttention();
  res.json(rebuilt.counts);
});

app.get('/api/permits/:id', (req, res) => {
  const permit = db.prepare(`${PERMIT_SQL} WHERE p.id = ?`).get(Number(req.params.id));
  if (!permit) return res.status(404).json({ error: 'Not found' });
  const milestones = db
    .prepare(`SELECT * FROM internal_milestones WHERE permit_record_id = ? ORDER BY key`)
    .all(permit.id);
  const officialIds = db
    .prepare(`SELECT * FROM official_ids WHERE permit_record_id = ? ORDER BY is_primary DESC, id`)
    .all(permit.id);
  const history = db
    .prepare(
      `SELECT * FROM field_changes WHERE permit_record_id = ? ORDER BY created_at DESC, id DESC LIMIT 200`
    )
    .all(permit.id);
  const snapshots = db
    .prepare(
      `SELECT id, official_id, mode, outcome, is_baseline, checked_at FROM official_snapshots
       WHERE permit_record_id = ? ORDER BY checked_at DESC LIMIT 20`
    )
    .all(permit.id);
  const readiness =
    assessPermitReadiness(permit.id) || getStoredAssessment(permit.id) || null;
  const properties = listPropertiesForPermit(permit.id);
  const contacts = listContacts({ permitId: permit.id, includeDemo: true });
  const jobs = db
    .prepare(
      `SELECT id, provider, mode, endpoint, status, estimated_credits, actual_credits, error, created_at, finished_at
       FROM contact_jobs WHERE permit_record_id = ? OR lot_group_id = ? ORDER BY id DESC LIMIT 20`
    )
    .all(permit.id, permit.lot_group_id);
  res.json({
    permit,
    milestones,
    officialIds,
    history,
    snapshots,
    readiness,
    properties,
    contacts,
    contactJobs: jobs,
    contactRoles: CONTACT_ROLES,
    tracerfy: tracerfyConfig(),
  });
});

app.patch('/api/permits/:id', (req, res) => {
  const permit = db.prepare('SELECT * FROM permit_records WHERE id = ?').get(Number(req.params.id));
  if (!permit) return res.status(404).json({ error: 'Not found' });
  // official_status + source_native_status are connector-owned (read-only via API)
  const editable = [
    'primary_official_id',
    'jurisdiction_code',
    'internal_status',
    'owner',
    'next_action',
    'next_action_due',
    'source_url',
    'permit_kind',
  ];
  if ('official_status' in (req.body || {}) || 'source_native_status' in (req.body || {})) {
    return res.status(400).json({
      error: 'official_status and source_native_status are read-only (official connector fields)',
    });
  }
  const user = currentUser();
  for (const key of editable) {
    if (!(key in (req.body || {}))) continue;
    let value = req.body[key];
    if (value === '') value = ['next_action_due', 'primary_official_id'].includes(key) ? null : '';
    if (String(permit[key] ?? '') === String(value ?? '')) continue;
    recordChange(permit.id, key, permit[key], value, user, 'ui');
    db.prepare(`UPDATE permit_records SET ${key} = ?, updated_at = datetime('now') WHERE id = ?`).run(
      value,
      permit.id
    );
  }
  if (Array.isArray(req.body?.milestones)) {
    for (const m of req.body.milestones) {
      if (!m?.key) continue;
      if (String(m.key).startsWith('official_')) {
        return res.status(400).json({ error: `Milestone ${m.key} is official/read-only` });
      }
      const existing = db
        .prepare(`SELECT value FROM internal_milestones WHERE permit_record_id = ? AND key = ?`)
        .get(permit.id, m.key);
      // Deliberate clear (distinct from blank import cells which preserve prior values)
      if (m.clear === true || m.value === '') {
        if (!existing) continue;
        if (!m.clear && m.value === '') continue; // ignore accidental empty without clear flag
        recordChange(permit.id, `milestone:${m.key}`, existing.value, '', user, 'ui_clear');
        db.prepare(
          `UPDATE internal_milestones SET value = '', edited_in_app = 1 WHERE permit_record_id = ? AND key = ?`
        ).run(permit.id, m.key);
        continue;
      }
      if (m.value == null) continue;
      if (existing) {
        if (String(existing.value) === String(m.value)) continue;
        recordChange(permit.id, `milestone:${m.key}`, existing.value, m.value, user, 'ui');
        db.prepare(
          `UPDATE internal_milestones SET value = ?, label = COALESCE(?, label), edited_in_app = 1
           WHERE permit_record_id = ? AND key = ?`
        ).run(String(m.value), m.label || null, permit.id, m.key);
      } else {
        db.prepare(
          `INSERT INTO internal_milestones(permit_record_id, key, label, value, value_kind, source, edited_in_app)
           VALUES (?, ?, ?, ?, ?, 'ui', 1)`
        ).run(permit.id, m.key, m.label || m.key, String(m.value), m.value_kind || 'text');
      }
    }
  }
  updateLotReadiness(permit.id);
  rebuildAttention();
  const updated = db.prepare(`${PERMIT_SQL} WHERE p.id = ?`).get(permit.id);
  res.json({
    permit: updated,
    readiness: getStoredAssessment(permit.id) || assessPermitReadiness(permit.id),
  });
});

app.post('/api/permits/bulk', (req, res) => {
  const { ids, patch } = req.body || {};
  if (!Array.isArray(ids) || !patch) return res.status(400).json({ error: 'ids and patch required' });
  const user = currentUser();
  const allowed = ['internal_status', 'owner', 'next_action', 'next_action_due'];
  const tx = db.transaction(() => {
    for (const id of ids) {
      const permit = db.prepare('SELECT * FROM permit_records WHERE id = ?').get(Number(id));
      if (!permit) continue;
      for (const key of allowed) {
        if (!(key in patch)) continue;
        const value = patch[key] === '' ? null : patch[key];
        if (String(permit[key] ?? '') === String(value ?? '')) continue;
        recordChange(permit.id, key, permit[key], value, user, 'bulk');
        db.prepare(`UPDATE permit_records SET ${key} = ?, updated_at = datetime('now') WHERE id = ?`).run(
          value,
          permit.id
        );
      }
    }
  });
  tx();
  rebuildAttention();
  res.json({ ok: true, count: ids.length });
});

app.get('/api/filters', (_req, res) => {
  res.json({ filters: db.prepare('SELECT * FROM saved_filters ORDER BY name').all() });
});

app.post('/api/filters', (req, res) => {
  const { name, definition } = req.body || {};
  if (!name || !definition) return res.status(400).json({ error: 'name and definition required' });
  const info = db
    .prepare('INSERT INTO saved_filters(name, definition) VALUES (?, ?)')
    .run(name, JSON.stringify(definition));
  res.json({ id: info.lastInsertRowid });
});

app.get('/api/attention', (_req, res) => {
  rebuildAttention();
  const items = db
    .prepare(
      `SELECT a.*, p.primary_official_id, p.official_status, p.internal_status, p.owner,
              p.readiness_state, p.progress_anchor_at, p.last_successful_check_at,
              lg.lot_label, cs.community_name, cs.project_code
       FROM attention_events a
       LEFT JOIN permit_records p ON p.id = a.permit_record_id
       LEFT JOIN lot_groups lg ON lg.id = p.lot_group_id
       LEFT JOIN community_sections cs ON cs.id = lg.section_id
       WHERE a.acknowledged = 0 AND a.resolved_at IS NULL
         AND (p.id IS NULL OR p.record_origin = 'import')
       ORDER BY a.created_at DESC`
    )
    .all();
  res.json({ items, staleDays: Number(getSetting('stale_days', '14')) });
});

app.post('/api/attention/:id/ack', (req, res) => {
  db.prepare('UPDATE attention_events SET acknowledged = 1 WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/schedule/preview', (_req, res) => {
  res.json(getSchedulePreview());
});

app.post('/api/schedule', (req, res) => {
  const { enabled, interval_minutes, timeout_ms, max_retries, backoff_ms } = req.body || {};
  const cfg = db.prepare('SELECT * FROM schedule_config WHERE id = 1').get();
  db.prepare(
    `UPDATE schedule_config SET
       enabled = ?,
       interval_minutes = ?,
       timeout_ms = ?,
       max_retries = ?,
       backoff_ms = ?
     WHERE id = 1`
  ).run(
    enabled != null ? (enabled ? 1 : 0) : cfg.enabled,
    interval_minutes ?? cfg.interval_minutes,
    timeout_ms ?? cfg.timeout_ms,
    max_retries ?? cfg.max_retries,
    backoff_ms ?? cfg.backoff_ms
  );
  res.json(getSchedulePreview());
});

app.get('/api/check-runs', (_req, res) => {
  res.json({ runs: db.prepare(`SELECT * FROM check_runs ORDER BY id DESC LIMIT 25`).all() });
});

app.get('/api/conflicts', (_req, res) => {
  res.json({
    conflicts: db
      .prepare(
        `SELECT c.*, p.primary_official_id, lg.lot_label, cs.community_name
         FROM import_conflicts c
         LEFT JOIN permit_records p ON p.id = c.permit_record_id
         LEFT JOIN lot_groups lg ON lg.id = p.lot_group_id
         LEFT JOIN community_sections cs ON cs.id = lg.section_id
         WHERE c.status = 'pending'
         ORDER BY c.created_at DESC`
      )
      .all(),
  });
});

app.post('/api/conflicts/:id/resolve', (req, res) => {
  const id = Number(req.params.id);
  const conflict = db.prepare('SELECT * FROM import_conflicts WHERE id = ?').get(id);
  if (!conflict) return res.status(404).json({ error: 'Not found' });
  const choice = req.body?.resolution; // keep_app | take_incoming | clear
  if (!['keep_app', 'take_incoming', 'clear'].includes(choice)) {
    return res.status(400).json({ error: 'resolution must be keep_app | take_incoming | clear' });
  }
  const user = currentUser();
  if (choice === 'take_incoming' || choice === 'clear') {
    const value = choice === 'clear' ? null : conflict.incoming_value;
    const existing = db
      .prepare(`SELECT * FROM internal_milestones WHERE permit_record_id = ? AND key = ?`)
      .get(conflict.permit_record_id, conflict.field);
    if (existing) {
      recordChange(
        conflict.permit_record_id,
        `milestone:${conflict.field}`,
        existing.value,
        value,
        user,
        'conflict_resolve'
      );
      db.prepare(
        `UPDATE internal_milestones SET value = ?, last_import_value = ?, edited_in_app = 0, source = 'import'
         WHERE permit_record_id = ? AND key = ?`
      ).run(value, choice === 'clear' ? existing.last_import_value : value, conflict.permit_record_id, conflict.field);
    }
  }
  db.prepare(
    `UPDATE import_conflicts SET status = 'resolved', resolution = ? WHERE id = ?`
  ).run(choice, id);
  res.json({ ok: true });
});

app.get('/api/connectors', (_req, res) => {
  res.json({
    connectors: listConnectors(),
    fairfaxFieldAvailability: FAIRFAX_FIELD_AVAILABILITY,
  });
});

app.get('/api/sources', (req, res) => {
  res.json({
    sources: listSources({
      jurisdiction_code: req.query.jurisdiction_code,
      state: req.query.state,
      verifiedOnly: req.query.verifiedOnly === 'true',
    }),
    discoveryProvider: discoveryProviderInterface,
  });
});

app.get('/api/sources/:key', (req, res) => {
  const src = getSource(req.params.key);
  if (!src) return res.status(404).json({ error: 'Not found' });
  res.json({ source: src });
});

app.post('/api/sources/:key/activate', (req, res) => {
  try {
    const src = activateSource(req.params.key, {
      reviewedBy: req.body?.reviewedBy || currentUser(),
    });
    res.json({ source: src });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/sources/:key/state', (req, res) => {
  try {
    const src = setSourceState(req.params.key, req.body?.state, req.body?.evidence);
    res.json({ source: src });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/discover/arcgis', async (req, res) => {
  try {
    const result = await inspectArcGisUrl(req.body?.url, {
      sampleKnownIds: req.body?.knownIds || [],
    });
    res.json({ result, seedCandidates: SEED_ARCGIS_CANDIDATES });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/connect-location', async (req, res) => {
  try {
    const result = await connectLocation(req.body || {});
    if (req.body?.activate && req.body?.sourceKey) {
      const src = activateSource(req.body.sourceKey, {
        reviewedBy: req.body.reviewedBy || currentUser(),
      });
      result.activated = src;
      result.status = 'supported_connected';
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/idless-candidates', (_req, res) => {
  res.json({
    candidates: db
      .prepare(
        `SELECT c.*, p.primary_official_id, lg.lot_label, cs.community_name
         FROM idless_match_candidates c
         LEFT JOIN permit_records p ON p.id = c.permit_record_id
         LEFT JOIN lot_groups lg ON lg.id = p.lot_group_id
         LEFT JOIN community_sections cs ON cs.id = lg.section_id
         ORDER BY c.id DESC LIMIT 100`
      )
      .all(),
  });
});

app.post('/api/sync/:id', requireAuth, async (req, res) => {
  try {
    // forceFail / allowSynthetic are test-only — never accept from operational HTTP.
    const result = await syncPermitById(Number(req.params.id), {
      officialId: req.body?.officialId,
      allowSynthetic: false,
    });
    rebuildAttention();
    const permit = db.prepare(`${PERMIT_SQL} WHERE p.id = ?`).get(Number(req.params.id));
    res.json({ result, permit });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/sync', async (req, res) => {
  const results = await syncAllLinked({
    fairfaxOnly: Boolean(req.body?.fairfaxOnly),
    trigger: req.body?.trigger || 'manual',
  });
  rebuildAttention();
  res.json(results);
});

app.get('/api/reviews', (_req, res) => {
  res.json({
    reviews: db
      .prepare(`SELECT * FROM match_reviews WHERE status = 'pending' ORDER BY created_at DESC`)
      .all(),
  });
});

function workbookPreviewResponse(parsed, filename) {
  return {
    filename,
    sheets: parsed.sheets,
    ignoredSheets: parsed.ignoredSheets,
    archivedSheets: parsed.ignoredSheets,
    sectionCount: parsed.permitTracker.sections.length,
    sections: parsed.permitTracker.sections.map((s) => ({
      project_code: s.project_code,
      community_name: s.community_name,
      jurisdiction_code: s.jurisdiction_code,
      jurisdiction_source: s.jurisdiction_source,
      jurisdiction_confirmed: s.jurisdiction_confirmed,
      headerRow: s.headerRow,
      headerCount: s.headers.length,
    })),
    rowCount: parsed.permitTracker.rows.length,
    sampleRows: parsed.permitTracker.rows.slice(0, 25),
    revisions: parsed.revisions.length,
    masterfile: parsed.masterfile.length,
    mstIds: parsed.mstIds.length,
    reviews: parsed.reviews,
    archivedRowCount: parsed.archived?.length || 0,
  };
}

app.post('/api/import/workbook/preview', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  const parsed = parseWorkbookBuffer(req.file.buffer);
  res.json(workbookPreviewResponse(parsed, req.file.originalname));
});

app.post('/api/import/workbook/commit', upload.single('file'), (req, res) => {
  let buffer = req.file?.buffer;
  if (!buffer && req.body?.useStoreWorkbook) {
    if (!fs.existsSync(SOURCE_WORKBOOK)) {
      return res.status(404).json({ error: 'Source workbook not found in store' });
    }
    buffer = fs.readFileSync(SOURCE_WORKBOOK);
  }
  if (!buffer) return res.status(400).json({ error: 'file or useStoreWorkbook required' });
  const parsed = parseWorkbookBuffer(buffer);
  const summary = commitWorkbookParse(parsed, { changedBy: currentUser() });
  rebuildAttention();
  res.json({ summary, sectionCount: parsed.permitTracker.sections.length });
});

app.post('/api/import/workbook/store', (_req, res) => {
  if (!fs.existsSync(SOURCE_WORKBOOK)) {
    return res.status(404).json({ error: 'Source workbook not found' });
  }
  const { summary } = importWorkbookFile(SOURCE_WORKBOOK);
  rebuildAttention();
  res.json({ summary, path: SOURCE_WORKBOOK });
});

// Legacy aliases — same handlers
app.post('/api/import/gospel/preview', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  const parsed = parseWorkbookBuffer(req.file.buffer);
  res.json(workbookPreviewResponse(parsed, req.file.originalname));
});

app.post('/api/import/gospel/commit', upload.single('file'), (req, res) => {
  let buffer = req.file?.buffer;
  if (!buffer && (req.body?.useStoreGospel || req.body?.useStoreWorkbook)) {
    if (!fs.existsSync(SOURCE_WORKBOOK)) {
      return res.status(404).json({ error: 'Source workbook not found in store' });
    }
    buffer = fs.readFileSync(SOURCE_WORKBOOK);
  }
  if (!buffer) return res.status(400).json({ error: 'file or useStoreWorkbook required' });
  const parsed = parseWorkbookBuffer(buffer);
  const summary = commitWorkbookParse(parsed, { changedBy: currentUser() });
  rebuildAttention();
  res.json({ summary, sectionCount: parsed.permitTracker.sections.length });
});

app.post('/api/import/gospel/store', (_req, res) => {
  if (!fs.existsSync(SOURCE_WORKBOOK)) {
    return res.status(404).json({ error: 'Source workbook not found' });
  }
  const { summary } = importWorkbookFile(SOURCE_WORKBOOK);
  rebuildAttention();
  res.json({ summary, path: SOURCE_WORKBOOK });
});

app.get('/api/export.xlsx', (req, res) => {
  const includeReviewed = req.query.includeReviewed === '1' || req.query.includeReviewed === 'true';
  const filters = {};
  for (const key of [
    'use_classification',
    'jurisdiction_code',
    'internal_status',
    'official_status',
    'readiness_state',
    'approaching_start',
  ]) {
    if (req.query[key]) filters[key] = String(req.query[key]);
  }
  const buf = exportCoexistenceXlsx({
    contactStatuses: ['confirmed'],
    includeReviewedCandidates: includeReviewed,
    filters,
  });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="permit-ledger-structured-export.xlsx"');
  res.send(Buffer.from(buf));
});

app.get('/api/stats', (_req, res) => {
  res.json({
    sections: db
      .prepare(`SELECT COUNT(*) AS c FROM community_sections WHERE record_origin = 'import'`)
      .get().c,
    lotGroups: db.prepare(`SELECT COUNT(*) AS c FROM lot_groups WHERE record_origin = 'import'`).get()
      .c,
    permits: db.prepare(`SELECT COUNT(*) AS c FROM permit_records WHERE record_origin = 'import'`).get()
      .c,
    withIds: db
      .prepare(
        `SELECT COUNT(*) AS c FROM permit_records WHERE record_origin = 'import'
         AND primary_official_id IS NOT NULL AND primary_official_id != ''`
      )
      .get().c,
    officialIds: db
      .prepare(
        `SELECT COUNT(*) AS c FROM official_ids oi
         JOIN permit_records p ON p.id = oi.permit_record_id
         WHERE p.record_origin = 'import'`
      )
      .get().c,
    revisions: db.prepare('SELECT COUNT(*) AS c FROM permit_revisions').get().c,
    masterfile: db.prepare('SELECT COUNT(*) AS c FROM plan_tracker_rows').get().c,
    mstIds: db.prepare('SELECT COUNT(*) AS c FROM mst_reference_ids').get().c,
    attention: db
      .prepare(
        `SELECT COUNT(*) AS c FROM attention_events a
         LEFT JOIN permit_records p ON p.id = a.permit_record_id
         WHERE a.acknowledged = 0 AND a.resolved_at IS NULL
           AND (p.id IS NULL OR p.record_origin = 'import')`
      )
      .get().c,
    conflicts: db
      .prepare(`SELECT COUNT(*) AS c FROM import_conflicts WHERE status = 'pending'`)
      .get().c,
    demoPermits: db
      .prepare(`SELECT COUNT(*) AS c FROM permit_records WHERE record_origin != 'import'`)
      .get().c,
    readiness: rebuildAllReadiness().counts,
    readinessByPermit: {
      ready: db
        .prepare(
          `SELECT COUNT(*) AS c FROM permit_records WHERE record_origin = 'import' AND readiness_state = 'ready'`
        )
        .get().c,
      blocked: db
        .prepare(
          `SELECT COUNT(*) AS c FROM permit_records WHERE record_origin = 'import' AND readiness_state = 'blocked'`
        )
        .get().c,
      needs_verification: db
        .prepare(
          `SELECT COUNT(*) AS c FROM permit_records WHERE record_origin = 'import' AND readiness_state = 'needs_verification'`
        )
        .get().c,
    },
    missingPropertyLots: missingPropertyLotCount(),
    contactsAvailableLots: contactsAvailableLotCount(),
    contactReviewNeeded: contactsReviewNeededCount(),
    tracerfy: tracerfyConfig(),
  });
});

// —— Property identity ——
app.get('/api/properties/:id', (req, res) => {
  const property = getProperty(Number(req.params.id));
  if (!property) return res.status(404).json({ error: 'Not found' });
  res.json({
    property,
    history: confirmationHistory(property.id),
    contacts: listContacts({ propertyId: property.id, includeDemo: true }),
  });
});

/** Invented sandbox_demo property for labeled contact demos — never production Tracerfy. */
app.post('/api/properties/demo-sandbox', (req, res) => {
  try {
    const { permit_record_id, lot_group_id } = req.body || {};
    if (!lot_group_id) {
      return res.status(400).json({ error: 'lot_group_id required — never implicit attach' });
    }
    if (permit_record_id) {
      const permit = db.prepare('SELECT * FROM permit_records WHERE id = ?').get(Number(permit_record_id));
      if (!permit || Number(permit.lot_group_id) !== Number(lot_group_id)) {
        return res.status(400).json({ error: 'lot_group_id does not match selected permit' });
      }
    }
    const stamp = Date.now().toString(36);
    const property = upsertProperty(
      {
        site_address: `100 Invented Demo Way Unit ${stamp}`,
        city: 'Demo City',
        state: 'VA',
        zip: '20100',
        parcel_apn: `DEMO-APN-${stamp}`,
        parcel_jurisdiction: 'demo_sandbox',
        source: 'sandbox',
        match_state: 'manual',
        record_origin: 'sandbox_demo',
        notes: 'INVENTED sandbox_demo property — fabricated contacts only; not operational',
      },
      { actor: currentUser() }
    );
    linkPropertyToLot({
      propertyId: property.id,
      lotGroupId: Number(lot_group_id),
      permitRecordId: permit_record_id ? Number(permit_record_id) : null,
      linkState: 'confirmed',
      evidence: { source: 'invented_sandbox_demo', warning: 'not a real address' },
      confirmedBy: currentUser(),
    });
    res.json({
      property: getProperty(property.id),
      properties: permit_record_id
        ? listPropertiesForPermit(permit_record_id)
        : listPropertiesForLotSafe(lot_group_id),
      note: 'Invented sandbox_demo property confirmed for labeled demo contact lookups only.',
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post('/api/properties', (req, res) => {
  try {
    const body = req.body || {};
    // Never allow clients to create sandbox_demo via the operational property path.
    if (body.record_origin === 'sandbox_demo' || body.source === 'sandbox') {
      return res.status(400).json({
        error: 'Use POST /api/properties/demo-sandbox for invented demo properties',
      });
    }
    const { lot_group_id, permit_record_id, link_state } = body;
    if (!lot_group_id) {
      return res.status(400).json({ error: 'lot_group_id required — never implicit attach' });
    }
    if (permit_record_id) {
      const permit = db.prepare('SELECT * FROM permit_records WHERE id = ?').get(Number(permit_record_id));
      if (!permit || Number(permit.lot_group_id) !== Number(lot_group_id)) {
        return res.status(400).json({ error: 'lot_group_id does not match selected permit' });
      }
    }
    const property = upsertProperty(body, { actor: currentUser() });
    linkPropertyToLot({
      propertyId: property.id,
      lotGroupId: Number(lot_group_id),
      permitRecordId: permit_record_id ? Number(permit_record_id) : null,
      linkState: link_state || 'candidate',
      evidence: { source: 'manual_ui' },
      confirmedBy: link_state === 'confirmed' ? currentUser() : null,
    });
    res.json({
      property,
      properties: permit_record_id ? listPropertiesForPermit(permit_record_id) : listPropertiesForLotSafe(lot_group_id),
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

function listPropertiesForLotSafe(lotGroupId) {
  return listPropertiesForPermit(
    db.prepare(`SELECT id FROM permit_records WHERE lot_group_id = ? LIMIT 1`).get(Number(lotGroupId))?.id || 0
  );
}

app.post('/api/properties/:id/confirm-link', (req, res) => {
  const property = getProperty(Number(req.params.id));
  if (!property) return res.status(404).json({ error: 'Not found' });
  const { lot_group_id, permit_record_id } = req.body || {};
  if (!lot_group_id) return res.status(400).json({ error: 'lot_group_id required' });
  if (permit_record_id) {
    const belonging = propertyBelongsToPermit(property.id, permit_record_id);
    // Allow confirm when already linked OR when linking freshly with matching lot
    const permit = db.prepare('SELECT * FROM permit_records WHERE id = ?').get(Number(permit_record_id));
    if (!permit || Number(permit.lot_group_id) !== Number(lot_group_id)) {
      return res.status(400).json({ error: 'Property/permit/lot mismatch' });
    }
    if (belonging.ok === false) {
      // Fresh confirm path OK if lot matches
    }
  }
  linkPropertyToLot({
    propertyId: property.id,
    lotGroupId: Number(lot_group_id),
    permitRecordId: permit_record_id ? Number(permit_record_id) : null,
    linkState: 'confirmed',
    evidence: { source: 'manual_confirm' },
    confirmedBy: currentUser(),
  });
  res.json({
    property: getProperty(property.id),
    properties: permit_record_id ? listPropertiesForPermit(permit_record_id) : [],
  });
});

app.post('/api/properties/offer-official-address', (req, res) => {
  try {
    const permitId = Number(req.body?.permit_record_id);
    if (!permitId) return res.status(400).json({ error: 'permit_record_id required' });
    res.json(offerOfficialSiteAddressCandidate(permitId, { actor: currentUser() }));
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.get('/api/property-crosswalk/template.csv', (_req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="property-crosswalk-template.csv"');
  res.send(crosswalkTemplateCsv());
});

app.get('/api/property-crosswalk/missing', (_req, res) => {
  res.json({ rows: missingPropertyQueue(100) });
});

app.post('/api/property-crosswalk/preview', upload.single('file'), (req, res) => {
  try {
    let rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (req.file) {
      rows = parseCrosswalkUpload(req.file.buffer, req.file.originalname);
    } else if (typeof req.body?.csv === 'string') {
      rows = parseCrosswalkCsvText(req.body.csv);
    }
    res.json({ preview: previewCrosswalk(rows), rowCount: rows.length });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post('/api/property-crosswalk/commit', (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    // Always server-revalidates; ignores client match_status / lot IDs as proof
    const summary = commitCrosswalk(rows, {
      actor: currentUser(),
      confirmSelectedOnly: req.body?.confirmSelectedOnly !== false,
    });
    res.json({ summary });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

function parseCrosswalkCsvText(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line, i) => {
    const cols = line.split(',').map((c) => c.trim());
    const row = { source_row: i + 2 };
    headers.forEach((h, idx) => {
      row[h] = cols[idx] || '';
    });
    return row;
  });
}

function parseCrosswalkUpload(buffer, filename = '') {
  const lower = String(filename).toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    return parseCrosswalkCsvText(buffer.toString('utf8'));
  }
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: '' }).map((r, i) => ({ ...r, source_row: i + 2 }));
}

// —— Contacts / Tracerfy ——
app.get('/api/contacts/meta', (_req, res) => {
  const cfg = tracerfyConfig();
  // Never expose tokens
  res.json({
    roles: CONTACT_ROLES,
    tracerfy: cfg,
    modes: PROVIDER_MODES,
  });
});

app.post('/api/contacts/provider-mode', requireAuth, requireOwner, (req, res) => {
  try {
    const mode = req.body?.mode;
    res.json({ tracerfy: setProviderMode(mode) });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post('/api/contacts', requireAuth, (req, res) => {
  try {
    const body = req.body || {};
    // Strip client-supplied provenance — manual endpoint always assigns manual source.
    delete body.provider;
    delete body.provider_source;
    delete body.record_origin;
    delete body.validation_state;
    if (body.permit_record_id && body.property_id) {
      const belonging = propertyBelongsToPermit(body.property_id, body.permit_record_id);
      if (!belonging.ok) return res.status(400).json({ error: belonging.error });
    }
    const contact = addManualContact(body, { actor: currentUser() });
    res.json({ contact });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post('/api/contacts/:id/status', requireAuth, (req, res) => {
  try {
    const contact = setContactStatus(Number(req.params.id), req.body?.status, {
      reason: req.body?.reason || '',
      actor: currentUser(),
    });
    res.json({ contact });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post('/api/contacts/find', requireAuth, async (req, res) => {
  try {
    const permitRecordId = req.body?.permit_record_id ? Number(req.body.permit_record_id) : null;
    // When a permit is selected, always enforce confirmed property association server-side.
    // Standalone property lookups (no permit_record_id) stay property-level.
    // Never accept client forceFail / requireConfirmedLink overrides on this route.
    const result = await findContactsForProperty({
      propertyId: Number(req.body?.property_id),
      permitRecordId,
      endpointKey: req.body?.endpoint || 'instant_trace',
      forceFail: null,
      requireConfirmedLink: Boolean(permitRecordId),
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post('/api/contacts/jobs/:id/reconcile', requireAuth, requireOwner, (req, res) => {
  try {
    res.json(
      reconcileTimedOutJob(Number(req.params.id), {
        resolution: req.body?.resolution || 'manual_abandon',
        note: req.body?.note || '',
      })
    );
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post('/api/milestones/:permitId/waiver', (req, res) => {
  const permitId = Number(req.params.permitId);
  const { milestone_key, reason } = req.body || {};
  if (!milestone_key) return res.status(400).json({ error: 'milestone_key required' });
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: 'waiver reason required' });
  }
  db.prepare(
    `INSERT INTO milestone_waivers(permit_record_id, milestone_key, reason, waived_by, revoked_at, revoked_by)
     VALUES (?, ?, ?, ?, NULL, NULL)
     ON CONFLICT(permit_record_id, milestone_key) DO UPDATE SET
       reason = excluded.reason,
       waived_by = excluded.waived_by,
       revoked_at = NULL,
       revoked_by = NULL,
       created_at = datetime('now')`
  ).run(permitId, milestone_key, reason, currentUser());
  recordChange(permitId, `waiver:${milestone_key}`, '', reason, currentUser(), 'waiver');
  updateLotReadiness(permitId);
  rebuildAttention();
  res.json({ ok: true, readiness: getStoredAssessment(permitId) });
});

app.post('/api/milestones/:permitId/waiver/revoke', (req, res) => {
  const permitId = Number(req.params.permitId);
  const { milestone_key } = req.body || {};
  if (!milestone_key) return res.status(400).json({ error: 'milestone_key required' });
  db.prepare(
    `UPDATE milestone_waivers SET revoked_at = datetime('now'), revoked_by = ?
     WHERE permit_record_id = ? AND milestone_key = ? AND revoked_at IS NULL`
  ).run(currentUser(), permitId, milestone_key);
  recordChange(permitId, `waiver_revoke:${milestone_key}`, 'active', 'revoked', currentUser(), 'waiver');
  updateLotReadiness(permitId);
  rebuildAttention();
  res.json({ ok: true, readiness: getStoredAssessment(permitId) });
});

app.post('/api/seed', requireAuth, requireOwner, (req, res) => {
  const result = seed({ includeDemoProbe: Boolean(req.body?.demo) });
  res.json(result);
});

if (frontendBuilt()) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(clientIndex);
  });
} else {
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.status(503).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Permit Ledger — frontend not built</title></head>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5">
  <h1>Frontend assets missing</h1>
  <p>The API process is running, but <code>client/dist/index.html</code> was not found.</p>
  <p>On Hostinger / production hosts, ensure the build step runs <code>npm run build</code> after install so Vite writes <code>client/dist</code> into the deploy package, then restart.</p>
  <p>Check <code>GET /api/health</code> (<code>ready</code>) and owner <code>GET /api/health/details</code>.</p>
</body></html>`);
  });
}

export { app };

if (process.env.PERMIT_NO_LISTEN !== '1') {
  const port = Number(process.env.PORT || 4173);
  // Bind all interfaces so Cursor desktop / port-forward surfaces can reach the process.
  // Owner laptops still cannot use the VM's localhost — that requires open-desktop or a local run.
  const host = process.env.LISTEN_HOST || '0.0.0.0';
  app.listen(port, host, () => {
    console.log(
      `Permit Ledger on http://${host}:${port} · auth=${authEnabled() ? 'on' : 'off'} · db=${getDbPath()}`
    );
  });
}
