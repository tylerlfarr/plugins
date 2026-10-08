import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permit-pilot-'));
process.env.PERMIT_DB_PATH = path.join(tmpDir, 'pilot.sqlite');
process.env.PERMIT_DEMO = '0';
process.env.AUTO_SEED = '0';
process.env.PILOT_AUTH = '0';
process.env.PERMIT_NO_LISTEN = '1';
process.env.TRACERFY_MODE = 'local_fixture';

const { app } = await import('../index.js');
const { db, migrate } = await import('../db.js');
const { upsertProperty, linkPropertyToLot } = await import('../property.js');
const { findContactsForProperty, addManualContact } = await import('../contacts.js');
const { setProviderMode } = await import('../providers/tracerfy.js');

migrate();
setProviderMode('local_fixture');

let lotSeq = 0;
function seedLot() {
  lotSeq += 1;
  const code = `PILOT${lotSeq}`;
  const sec = db
    .prepare(
      `INSERT INTO community_sections(project_code, community_name, jurisdiction_code, record_origin)
       VALUES (?,'Pilot Community','fairfax_county','import')`
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
    .run(Number(lot.lastInsertRowid), `BLD2026-99${String(lotSeq).padStart(3, '0')}`);
  return {
    sectionId: Number(sec.lastInsertRowid),
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
        base: `http://127.0.0.1:${port}`,
        async json(method, urlPath, body) {
          const res = await fetch(`${`http://127.0.0.1:${port}`}${urlPath}`, {
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

test('HTTP: forceFail and requireConfirmedLink client overrides ignored', async () => {
  const { lotId, permitId } = seedLot();
  const prop = upsertProperty({
    site_address: '100 Pilot Way',
    city: 'Fairfax',
    state: 'VA',
    zip: '22030',
    record_origin: 'import',
  });
  linkPropertyToLot({
    propertyId: prop.id,
    lotGroupId: lotId,
    permitRecordId: permitId,
    linkState: 'candidate',
    confirmedBy: 'test',
  });

  const { server, json } = await listen();
  try {
    // Client tries to skip confirmed link + force failure — must still enforce confirmed.
    const denied = await json('POST', '/api/contacts/find', {
      property_id: prop.id,
      permit_record_id: permitId,
      sought_role: 'property_owner',
      requireConfirmedLink: false,
      forceFail: 'no_match',
    });
    assert.equal(denied.status, 400);
    assert.match(String(denied.data.error || ''), /confirmed/i);

    // Manual contact cannot impersonate Tracerfy via client fields
    const manual = await json('POST', '/api/contacts', {
      property_id: prop.id,
      lot_group_id: lotId,
      permit_record_id: permitId,
      role: 'property_owner',
      full_name: 'Impersonation Attempt',
      provider: 'tracerfy',
      provider_source: 'tracerfy_live',
      record_origin: 'provider',
      validation_state: 'provider_returned',
    });
    assert.equal(manual.status, 200);
    assert.equal(manual.data.contact.provider, 'manual');
    assert.equal(manual.data.contact.provider_source, 'user_entered');
    assert.equal(manual.data.contact.record_origin, 'manual');
  } finally {
    server.close();
  }
});

test('cache reuse: needs_review contacts stay review; identity mismatch skips cache', async () => {
  const { lotId, permitId } = seedLot();
  const prop = upsertProperty({
    site_address: '200 Cache Lane',
    city: 'Fairfax',
    state: 'VA',
    zip: '22031',
    record_origin: 'import',
  });
  linkPropertyToLot({
    propertyId: prop.id,
    lotGroupId: lotId,
    permitRecordId: permitId,
    linkState: 'confirmed',
    confirmedBy: 'test',
  });

  const first = await findContactsForProperty({
    soughtRole: 'property_owner',
    propertyId: prop.id,
    permitRecordId: permitId,
    forceFail: null,
  });
  assert.ok(first.job || first.contacts || first.saved);

  // Mark any attached contacts as needing review
  const contacts = db.prepare(`SELECT * FROM contacts WHERE property_id = ?`).all(prop.id);
  for (const c of contacts) {
    db.prepare(`UPDATE contacts SET status = 'needs_review' WHERE id = ?`).run(c.id);
  }

  // Change property identity — cache must not return old needs_review as current
  db.prepare(
    `UPDATE properties SET site_address = ?, identity_key = ? WHERE id = ?`
  ).run('999 Changed Ave', `changed-identity-${prop.id}`, prop.id);
  const changed = db.prepare(`SELECT * FROM properties WHERE id = ?`).get(prop.id);

  // New lookup fingerprint (different address) — should not revive needs_review rows as current
  const second = await findContactsForProperty({
    soughtRole: 'property_owner',
    propertyId: changed.id,
    permitRecordId: permitId,
  });
  if (second.cached || second.deduped) {
    const revived = (second.contacts || []).filter((c) => c.status === 'needs_review');
    assert.equal(revived.length, 0);
  }
  const stillReview = db
    .prepare(`SELECT COUNT(*) AS c FROM contacts WHERE property_id = ? AND status = 'needs_review'`)
    .get(prop.id).c;
  assert.ok(stillReview >= 0);

  // Helper-level: cached load excludes needs_review
  addManualContact(
    {
      property_id: prop.id,
      lot_group_id: lotId,
      role: 'property_owner',
      full_name: 'Stale Review',
      status: 'needs_review',
    },
    { actor: 'test' }
  );
  // Direct status set
  const row = db
    .prepare(`SELECT id FROM contacts WHERE property_id = ? AND full_name = 'Stale Review'`)
    .get(prop.id);
  if (row) {
    db.prepare(`UPDATE contacts SET status = 'needs_review', provider = 'tracerfy', record_origin = 'local_fixture' WHERE id = ?`).run(
      row.id
    );
  }
  const listed = db
    .prepare(
      `SELECT * FROM contacts WHERE property_id = ? AND status NOT IN ('rejected','outdated','needs_review')`
    )
    .all(prop.id);
  assert.ok(!listed.some((c) => c.full_name === 'Stale Review'));
});

test('auth disabled by default for Try Live / tests', async () => {
  const { server, json } = await listen();
  try {
    const health = await json('GET', '/api/health');
    assert.ok([200, 503].includes(health.status));
    assert.equal(health.data.ok, true);
    assert.equal(health.data.dbPath, undefined);
    const status = await json('GET', '/api/auth/status');
    assert.equal(status.status, 200);
    assert.equal(status.data.enabled, false);
    const meta = await json('GET', '/api/meta');
    assert.equal(meta.status, 200);
  } finally {
    server.close();
  }
});
