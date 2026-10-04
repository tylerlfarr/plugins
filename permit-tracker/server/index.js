import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db, getSetting, setSetting, recordChange, migrate } from './db.js';
import { listConnectors } from './connectors/index.js';
import { syncPermitById, syncAllLinked, rebuildAttention } from './sync.js';
import {
  parseWorkbook,
  suggestMapping,
  validateMappedRows,
  commitImport,
  exportPermitsXlsx,
  buildSampleWorkbook,
  TARGET_FIELDS,
} from './excel.js';
import { seed } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const clientDist = path.join(root, 'client', 'dist');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

migrate();
const permitCount = db.prepare('SELECT COUNT(*) AS c FROM permits').get().c;
if (permitCount === 0) seed();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

function currentUser() {
  return getSetting('current_user', 'demo.user');
}

function permitSelectSql() {
  return `SELECT p.*,
            l.lot_number, l.address, l.parcel_id, l.project_id,
            pr.name AS project_name, pr.community_id,
            c.name AS community_name
          FROM permits p
          JOIN lots l ON l.id = p.lot_id
          JOIN projects pr ON pr.id = l.project_id
          JOIN communities c ON c.id = pr.community_id`;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'permit-tracker', mode: 'local-prototype' });
});

app.get('/api/meta', (_req, res) => {
  res.json({
    user: currentUser(),
    staleDays: Number(getSetting('stale_days', '14')),
    connectors: listConnectors(),
    targetFields: TARGET_FIELDS,
    workbookEvidence: 'missing_upload',
  });
});

app.post('/api/settings', (req, res) => {
  const { staleDays, user } = req.body || {};
  if (staleDays != null) setSetting('stale_days', Number(staleDays));
  if (user) setSetting('current_user', String(user));
  rebuildAttention();
  res.json({ ok: true, staleDays: Number(getSetting('stale_days', '14')), user: currentUser() });
});

app.get('/api/communities', (_req, res) => {
  const communities = db
    .prepare(
      `SELECT c.*,
         (SELECT COUNT(*) FROM projects p WHERE p.community_id = c.id) AS project_count,
         (SELECT COUNT(*) FROM permits pe
            JOIN lots l ON l.id = pe.lot_id
            JOIN projects p ON p.id = l.project_id
            WHERE p.community_id = c.id) AS permit_count
       FROM communities c ORDER BY c.name`
    )
    .all();
  res.json({ communities });
});

app.get('/api/permits', (req, res) => {
  const {
    q,
    jurisdiction_code,
    official_status,
    internal_status,
    owner,
    community_id,
    sort = 'updated_at',
    dir = 'desc',
  } = req.query;

  const allowedSort = new Set([
    'updated_at',
    'community_name',
    'lot_number',
    'official_status',
    'internal_status',
    'next_action_due',
    'issued_date',
    'owner',
  ]);
  const sortCol = allowedSort.has(String(sort)) ? String(sort) : 'updated_at';
  const sortDir = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  let sql = `${permitSelectSql()} WHERE 1=1`;
  const params = [];
  if (q) {
    sql += ` AND (
      c.name LIKE ? OR pr.name LIKE ? OR l.lot_number LIKE ? OR l.address LIKE ?
      OR IFNULL(p.official_id,'') LIKE ? OR p.notes LIKE ? OR p.owner LIKE ?
      OR p.permit_type LIKE ? OR p.next_action LIKE ?
    )`;
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like, like, like, like);
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
  if (owner) {
    sql += ' AND p.owner = ?';
    params.push(owner);
  }
  if (community_id) {
    sql += ' AND c.id = ?';
    params.push(Number(community_id));
  }
  sql += ` ORDER BY ${sortCol} ${sortDir}, p.id ASC`;
  res.json({ permits: db.prepare(sql).all(...params) });
});

app.get('/api/permits/:id', (req, res) => {
  const permit = db.prepare(`${permitSelectSql()} WHERE p.id = ?`).get(Number(req.params.id));
  if (!permit) return res.status(404).json({ error: 'Not found' });
  const history = db
    .prepare(
      `SELECT * FROM change_history WHERE permit_id = ? ORDER BY created_at DESC, id DESC LIMIT 200`
    )
    .all(permit.id);
  res.json({ permit, history });
});

app.patch('/api/permits/:id', (req, res) => {
  const permit = db.prepare('SELECT * FROM permits WHERE id = ?').get(Number(req.params.id));
  if (!permit) return res.status(404).json({ error: 'Not found' });
  const editable = [
    'official_id',
    'permit_type',
    'source_native_status',
    'official_status',
    'internal_status',
    'submitted_date',
    'approved_date',
    'issued_date',
    'revision_date',
    'construction_start_date',
    'expiration_date',
    'predicted_issue_date',
    'owner',
    'notes',
    'next_action',
    'next_action_due',
    'source_url',
    'jurisdiction_code',
  ];
  const user = currentUser();
  for (const key of editable) {
    if (!(key in (req.body || {}))) continue;
    let value = req.body[key];
    if (value === '') value = key.endsWith('_date') || key === 'next_action_due' || key === 'official_id' ? null : '';
    if (String(permit[key] ?? '') === String(value ?? '')) continue;
    recordChange(permit.id, key, permit[key], value, user, 'ui');
    db.prepare(`UPDATE permits SET ${key} = ?, updated_at = datetime('now') WHERE id = ?`).run(value, permit.id);
    if (key === 'official_status') {
      db.prepare(
        `UPDATE permits SET official_last_changed_at = datetime('now') WHERE id = ?`
      ).run(permit.id);
    }
  }
  rebuildAttention();
  const updated = db.prepare(`${permitSelectSql()} WHERE p.id = ?`).get(permit.id);
  res.json({ permit: updated });
});

app.post('/api/permits/bulk', (req, res) => {
  const { ids, patch } = req.body || {};
  if (!Array.isArray(ids) || !patch || typeof patch !== 'object') {
    return res.status(400).json({ error: 'ids and patch required' });
  }
  const user = currentUser();
  const allowed = ['internal_status', 'owner', 'next_action', 'next_action_due'];
  const tx = db.transaction(() => {
    for (const id of ids) {
      const permit = db.prepare('SELECT * FROM permits WHERE id = ?').get(Number(id));
      if (!permit) continue;
      for (const key of allowed) {
        if (!(key in patch)) continue;
        const value = patch[key] === '' ? null : patch[key];
        if (String(permit[key] ?? '') === String(value ?? '')) continue;
        recordChange(permit.id, key, permit[key], value, user, 'bulk');
        db.prepare(`UPDATE permits SET ${key} = ?, updated_at = datetime('now') WHERE id = ?`).run(
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

app.delete('/api/filters/:id', (req, res) => {
  db.prepare('DELETE FROM saved_filters WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/attention', (_req, res) => {
  rebuildAttention();
  const items = db
    .prepare(
      `SELECT a.*, p.official_id, p.official_status, p.internal_status, p.owner,
              l.lot_number, pr.name AS project_name, c.name AS community_name
       FROM attention_events a
       JOIN permits p ON p.id = a.permit_id
       JOIN lots l ON l.id = p.lot_id
       JOIN projects pr ON pr.id = l.project_id
       JOIN communities c ON c.id = pr.community_id
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
  res.json({ connectors: listConnectors() });
});

app.post('/api/sync/:id', async (req, res) => {
  try {
    const result = await syncPermitById(Number(req.params.id), {
      forceFail: Boolean(req.body?.forceFail),
    });
    rebuildAttention();
    const permit = db.prepare(`${permitSelectSql()} WHERE p.id = ?`).get(Number(req.params.id));
    res.json({ result, permit });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/sync', async (_req, res) => {
  const results = await syncAllLinked();
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

app.post('/api/import/preview', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  const parsed = parseWorkbook(req.file.buffer);
  const mapping = req.body.mapping ? JSON.parse(req.body.mapping) : suggestMapping(parsed.headers);
  const preview = validateMappedRows(parsed.rows, mapping);
  const info = db
    .prepare(
      `INSERT INTO import_sessions(filename, mapping_json, preview_json) VALUES (?, ?, ?)`
    )
    .run(req.file.originalname, JSON.stringify(mapping), JSON.stringify(preview.slice(0, 200)));
  res.json({
    sessionId: info.lastInsertRowid,
    sheetName: parsed.sheetName,
    headers: parsed.headers,
    mapping,
    targetFields: TARGET_FIELDS,
    preview,
    summary: {
      rows: preview.length,
      ok: preview.filter((p) => p.ok).length,
      errors: preview.filter((p) => !p.ok).length,
      updates: preview.filter((p) => p.match.startsWith('update')).length,
      creates: preview.filter((p) => p.match === 'create' && p.ok).length,
    },
  });
});

app.post('/api/import/commit', (req, res) => {
  const { preview } = req.body || {};
  if (!Array.isArray(preview)) return res.status(400).json({ error: 'preview required' });
  const result = commitImport(preview, { changedBy: currentUser() });
  rebuildAttention();
  res.json(result);
});

app.get('/api/export.xlsx', (_req, res) => {
  const buf = exportPermitsXlsx();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="permits-export.xlsx"');
  res.send(Buffer.from(buf));
});

app.get('/api/sample-import.xlsx', (_req, res) => {
  const buf = buildSampleWorkbook();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="sample-import.xlsx"');
  res.send(Buffer.from(buf));
});

app.post('/api/seed', (_req, res) => {
  seed();
  res.json({ ok: true });
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
  console.log(`Permit tracker listening on http://localhost:${port}`);
});
