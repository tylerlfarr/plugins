import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permit-preview-'));
process.env.PERMIT_DB_PATH = path.join(tmpDir, 'preview.sqlite');
process.env.PERMIT_DEMO = '0';
process.env.AUTO_SEED = '0';
process.env.PILOT_AUTH = '0';
process.env.PERMIT_NO_LISTEN = '1';
process.env.TRACERFY_MODE = 'local_fixture';
delete process.env.TRACERFY_API_TOKEN;

const { app } = await import('../index.js');
const { db, migrate } = await import('../db.js');
const { findContactsForProperty } = await import('../contacts.js');
const { exportCoexistenceXlsx, inspectExportBuffer } = await import('../excelExport.js');
const { setProviderMode } = await import('../providers/tracerfy.js');

migrate();
setProviderMode('local_fixture');

function seedPermit() {
  const code = `PV${Date.now().toString(36)}`;
  const sec = db
    .prepare(
      `INSERT INTO community_sections(project_code, community_name, jurisdiction_code, record_origin)
       VALUES (?,'Preview Community','fairfax_county','import')`
    )
    .run(code);
  const lot = db
    .prepare(
      `INSERT INTO lot_groups(section_id, lot_label, housetype, stable_key, record_origin)
       VALUES (?, '1', 'TH', ?, 'import')`
    )
    .run(Number(sec.lastInsertRowid), `${code}||1||th`);
  const p = db
    .prepare(
      `INSERT INTO permit_records(lot_group_id, primary_official_id, jurisdiction_code, record_origin)
       VALUES (?, ?, 'fairfax_county', 'import')`
    )
    .run(Number(lot.lastInsertRowid), `BLD2026-${code.slice(-5)}`);
  return {
    lotId: Number(lot.lastInsertRowid),
    permitId: Number(p.lastInsertRowid),
  };
}

function listen() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        async json(method, urlPath, body) {
          const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
            method,
            headers: {
              'Content-Type': 'application/json',
              'X-Requested-With': 'PermitLedger',
            },
            body: body ? JSON.stringify(body) : undefined,
          });
          const text = await res.text();
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }
          return { status: res.status, data };
        },
      });
    });
  });
}

test('meta exposes Tracerfy setup note when live lookups unconfigured', async () => {
  const { server, json } = await listen();
  try {
    const meta = await json('GET', '/api/meta');
    assert.equal(meta.status, 200);
    assert.ok(meta.data.tracerfySetupNote);
    assert.match(meta.data.tracerfySetupNote, /Connect Tracerfy to enable live lookups/i);
    assert.equal(meta.data.tracerfy.tokenPresent, false);
    assert.equal(meta.data.tracerfy.productionGatesOk, false);
  } finally {
    server.close();
  }
});

test('invented sandbox_demo property gets labeled demo contacts; export excludes them', async () => {
  const { lotId, permitId } = seedPermit();
  const { server, json } = await listen();
  try {
    const created = await json('POST', '/api/properties/demo-sandbox', {
      lot_group_id: lotId,
      permit_record_id: permitId,
    });
    assert.equal(created.status, 200);
    assert.equal(created.data.property.record_origin, 'sandbox_demo');
    assert.match(created.data.property.site_address, /Invented Demo/i);

    const result = await findContactsForProperty({
    soughtRole: 'property_owner',
      propertyId: created.data.property.id,
      permitRecordId: permitId,
    });
    assert.ok(!result.isolation, `unexpected isolation: ${result.isolation}`);
    assert.ok((result.saved || []).length >= 1);
    assert.ok(
      result.saved.every(
        (c) => c.record_origin === 'local_fixture' || c.record_origin === 'sandbox_demo'
      )
    );
    assert.ok(result.saved.some((c) => /DEMO|SANDBOX/i.test(c.full_name || c.notes || '')));

    const inspected = inspectExportBuffer(exportCoexistenceXlsx());
    assert.ok(!inspected.contacts.some((c) => /SANDBOX|DEMO-OWNER/i.test(c.full_name || '')));
    assert.ok(!inspected.contactOrigins.includes('local_fixture'));
    assert.ok(!inspected.contactOrigins.includes('sandbox_demo'));
  } finally {
    server.close();
  }
});
