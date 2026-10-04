import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db, getSetting, setSetting, recordChange, migrate } from './db.js';
import { listConnectors, FAIRFAX_FIELD_AVAILABILITY } from './connectors/index.js';
import { syncPermitById, syncAllLinked, rebuildAttention } from './sync.js';
import {
  parseGospelBuffer,
  commitGospelParse,
  importGospelFile,
  isFairfaxShapedId,
} from './gospelImport.js';
import { exportCoexistenceXlsx } from './excelExport.js';
import { seed } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const clientDist = path.join(root, 'client', 'dist');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

migrate();
if (db.prepare('SELECT COUNT(*) AS c FROM community_sections').get().c === 0) {
  seed();
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
    connectors: listConnectors(),
    fairfaxFieldAvailability: FAIRFAX_FIELD_AVAILABILITY,
    productPromise:
      'Automatically run specific permit checks for communities/lots, preserve internal spreadsheet workflow, show what changed before morning meeting.',
  });
});

app.post('/api/settings', (req, res) => {
  const { staleDays, user } = req.body || {};
  if (staleDays != null) setSetting('stale_days', Number(staleDays));
  if (user) setSetting('current_user', String(user));
  rebuildAttention();
  res.json({ ok: true, staleDays: Number(getSetting('stale_days', '14')), user: currentUser() });
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
      p.primary_official_id GLOB '[A-Z][A-Z][A-Z][A-Z]-*'
      OR EXISTS (
        SELECT 1 FROM official_ids oi WHERE oi.permit_record_id = p.id
          AND oi.official_id GLOB '[A-Z][A-Z][A-Z][A-Z]-*'
      )
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
      `SELECT id, official_id, mode, outcome, checked_at FROM official_snapshots
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
          `UPDATE internal_milestones SET value = ?, label = COALESCE(?, label) WHERE permit_record_id = ? AND key = ?`
        ).run(String(m.value), m.label || null, permit.id, m.key);
      } else {
        db.prepare(
          `INSERT INTO internal_milestones(permit_record_id, key, label, value, value_kind) VALUES (?, ?, ?, ?, ?)`
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
              lg.lot_label, cs.community_name, cs.project_code
       FROM attention_events a
       LEFT JOIN permit_records p ON p.id = a.permit_record_id
       LEFT JOIN lot_groups lg ON lg.id = p.lot_group_id
       LEFT JOIN community_sections cs ON cs.id = lg.section_id
       WHERE a.acknowledged = 0
       ORDER BY a.created_at DESC`
    )
    .all();
  res.json({ items, staleDays: Number(getSetting('stale_days', '14')) });
});

app.post('/api/attention/:id/ack', (req, res) => {
  db.prepare('UPDATE attention_events SET acknowledged = 1 WHERE id = ?').run(Number(req.params.id));
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
    });
    rebuildAttention();
    const permit = db.prepare(`${PERMIT_SQL} WHERE p.id = ?`).get(Number(req.params.id));
    res.json({ result, permit });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/sync', async (req, res) => {
  const results = await syncAllLinked({ fairfaxOnly: Boolean(req.body?.fairfaxOnly) });
  rebuildAttention();
  res.json({ results });
});

app.get('/api/reviews', (_req, res) => {
  res.json({
    reviews: db
      .prepare(`SELECT * FROM match_reviews WHERE status = 'pending' ORDER BY created_at DESC`)
      .all(),
  });
});

app.post('/api/import/gospel/preview', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  const parsed = parseGospelBuffer(req.file.buffer);
  res.json({
    filename: req.file.originalname,
    sheets: parsed.sheets,
    ignoredSheets: parsed.ignoredSheets,
    sectionCount: parsed.permitTracker.sections.length,
    sections: parsed.permitTracker.sections.map((s) => ({
      project_code: s.project_code,
      community_name: s.community_name,
      jurisdiction_code: s.jurisdiction_code,
      headerRow: s.headerRow,
      headerCount: s.headers.length,
    })),
    rowCount: parsed.permitTracker.rows.length,
    sampleRows: parsed.permitTracker.rows.slice(0, 25),
    revisions: parsed.revisions.length,
    masterfile: parsed.masterfile.length,
    mstIds: parsed.mstIds.length,
    reviews: parsed.reviews,
  });
});

app.post('/api/import/gospel/commit', upload.single('file'), (req, res) => {
  let buffer = req.file?.buffer;
  if (!buffer && req.body?.useStoreGospel) {
    const p = '/cursor/stores/self/internal/Permit_Tracker_9.1.2026.xlsx';
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'Gospel workbook not found in store' });
    buffer = fs.readFileSync(p);
  }
  if (!buffer) return res.status(400).json({ error: 'file or useStoreGospel required' });
  const parsed = parseGospelBuffer(buffer);
  const summary = commitGospelParse(parsed, { changedBy: currentUser() });
  rebuildAttention();
  res.json({ summary, sectionCount: parsed.permitTracker.sections.length });
});

app.post('/api/import/gospel/store', (_req, res) => {
  const p = '/cursor/stores/self/internal/Permit_Tracker_9.1.2026.xlsx';
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Gospel workbook not found' });
  const { summary } = importGospelFile(p);
  rebuildAttention();
  res.json({ summary, path: p });
});

app.get('/api/export.xlsx', (_req, res) => {
  const buf = exportCoexistenceXlsx();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="permit-ledger-coexistence.xlsx"');
  res.send(Buffer.from(buf));
});

app.get('/api/stats', (_req, res) => {
  res.json({
    sections: db.prepare('SELECT COUNT(*) AS c FROM community_sections').get().c,
    lotGroups: db.prepare('SELECT COUNT(*) AS c FROM lot_groups').get().c,
    permits: db.prepare('SELECT COUNT(*) AS c FROM permit_records').get().c,
    withIds: db
      .prepare(
        `SELECT COUNT(*) AS c FROM permit_records WHERE primary_official_id IS NOT NULL AND primary_official_id != ''`
      )
      .get().c,
    officialIds: db.prepare('SELECT COUNT(*) AS c FROM official_ids').get().c,
    revisions: db.prepare('SELECT COUNT(*) AS c FROM permit_revisions').get().c,
    masterfile: db.prepare('SELECT COUNT(*) AS c FROM plan_tracker_rows').get().c,
    mstIds: db.prepare('SELECT COUNT(*) AS c FROM mst_reference_ids').get().c,
    attention: db.prepare('SELECT COUNT(*) AS c FROM attention_events WHERE acknowledged = 0').get().c,
  });
});

app.post('/api/seed', (_req, res) => {
  const result = seed();
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
