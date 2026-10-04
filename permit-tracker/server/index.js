import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db, getSetting, setSetting, recordChange, migrate } from './db.js';
import { listConnectors, FAIRFAX_FIELD_AVAILABILITY } from './connectors/index.js';
import {
  syncPermitById,
  syncAllLinked,
  rebuildAttention,
  getSchedulePreview,
} from './sync.js';
import {
  parseWorkbookBuffer,
  commitWorkbookParse,
  importWorkbookFile,
  isFairfaxShapedId,
} from './workbookImport.js';
import { exportCoexistenceXlsx } from './excelExport.js';
import { seed } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const clientDist = path.join(root, 'client', 'dist');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const SOURCE_WORKBOOK =
  process.env.SOURCE_WORKBOOK_XLSX ||
  '/cursor/stores/self/internal/Permit_Tracker_9.1.2026.xlsx';

migrate();
if (db.prepare('SELECT COUNT(*) AS c FROM community_sections').get().c === 0) {
  seed({ includeDemoProbe: process.env.PERMIT_DEMO === '1' });
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

function currentUser() {
  return getSetting('current_user', 'demo.user');
}

const PERMIT_SQL = `SELECT p.*,
  lg.lot_label, lg.housetype, lg.notes_raw, lg.section_id,
  cs.project_code, cs.community_name, cs.permit_time_note, cs.jurisdiction_code AS section_jurisdiction
  FROM permit_records p
  JOIN lot_groups lg ON lg.id = p.lot_group_id
  JOIN community_sections cs ON cs.id = lg.section_id`;

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'permit-tracker', mode: 'workbook-native-prototype' });
});

app.get('/api/meta', (_req, res) => {
  res.json({
    user: currentUser(),
    staleDays: Number(getSetting('stale_days', '14')),
    demoMode: getSetting('demo_mode', '0') === '1',
    connectors: listConnectors(),
    fairfaxFieldAvailability: FAIRFAX_FIELD_AVAILABILITY,
    productPromise:
      'Automatically run specific permit checks for communities/lots, preserve internal spreadsheet workflow, show what changed before morning meeting.',
    importProfile: 'source workbook (employer-specific mapping separate from reusable core)',
  });
});

app.post('/api/settings', (req, res) => {
  const { staleDays, user, demoMode } = req.body || {};
  if (staleDays != null) setSetting('stale_days', Number(staleDays));
  if (user) setSetting('current_user', String(user));
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
    has_official_id,
    fairfax_shaped,
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
    'next_action_due',
    'primary_official_id',
  ]);
  const sortCol = allowed.has(String(sort)) ? String(sort) : 'updated_at';
  const sortDir = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  let sql = `${PERMIT_SQL} WHERE 1=1`;
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
  sql += ` ORDER BY ${sortCol} ${sortDir}, p.id ASC`;
  const permits = db.prepare(sql).all(...params).map((p) => ({
    ...p,
    fairfax_shaped: p.primary_official_id ? isFairfaxShapedId(p.primary_official_id) : false,
  }));
  res.json({ permits });
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
  res.json({ permit, milestones, officialIds, history, snapshots });
});

app.patch('/api/permits/:id', (req, res) => {
  const permit = db.prepare('SELECT * FROM permit_records WHERE id = ?').get(Number(req.params.id));
  if (!permit) return res.status(404).json({ error: 'Not found' });
  const editable = [
    'primary_official_id',
    'jurisdiction_code',
    'source_native_status',
    'official_status',
    'internal_status',
    'owner',
    'next_action',
    'next_action_due',
    'source_url',
    'permit_kind',
  ];
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
      if (!m?.key || m.value == null || m.value === '') continue;
      const existing = db
        .prepare(`SELECT value FROM internal_milestones WHERE permit_record_id = ? AND key = ?`)
        .get(permit.id, m.key);
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
  rebuildAttention();
  const updated = db.prepare(`${PERMIT_SQL} WHERE p.id = ?`).get(permit.id);
  res.json({ permit: updated });
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

app.post('/api/sync/:id', async (req, res) => {
  try {
    const result = await syncPermitById(Number(req.params.id), {
      forceFail: Boolean(req.body?.forceFail),
      officialId: req.body?.officialId,
      allowSynthetic: Boolean(req.body?.allowSynthetic),
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

app.get('/api/export.xlsx', (_req, res) => {
  const buf = exportCoexistenceXlsx();
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
  });
});

app.post('/api/seed', (req, res) => {
  const result = seed({ includeDemoProbe: Boolean(req.body?.demo) });
  res.json(result);
});

if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

const port = Number(process.env.PORT || 4173);
app.listen(port, () => {
  console.log(`Permit tracker (workbook-native) on http://localhost:${port}`);
});
