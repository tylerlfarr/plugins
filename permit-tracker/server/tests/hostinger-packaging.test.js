/**
 * Hostinger/production packaging: health diagnostics + multer multipart import path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permit-hostinger-'));
process.env.PERMIT_DB_PATH = path.join(tmpDir, 'hostinger.sqlite');
process.env.PERMIT_DEMO = '0';
process.env.AUTO_SEED = '0';
process.env.PILOT_AUTH = '0';
process.env.PERMIT_NO_LISTEN = '1';
process.env.TRACERFY_MODE = 'local_fixture';
delete process.env.TRACERFY_API_TOKEN;

const { app } = await import('../index.js');
const { migrate, getDbPath } = await import('../db.js');
const { buildSanitizedWorkbookBuffer } = await import('../fixtures/buildSanitizedWorkbook.js');

migrate();

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const clientIndex = path.join(repoRoot, 'client', 'dist', 'index.html');

function listen() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        async json(method, urlPath, body, headers = {}) {
          const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
            method,
            headers: {
              'Content-Type': 'application/json',
              'X-Requested-With': 'PermitLedger',
              ...headers,
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
          return { status: res.status, data, headers: res.headers };
        },
        async multipart(urlPath, fieldName, filename, buffer) {
          const form = new FormData();
          form.append(fieldName, new Blob([buffer]), filename);
          const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
            method: 'POST',
            headers: { 'X-Requested-With': 'PermitLedger' },
            body: form,
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

test('health reports frontendBuilt and writable sqlite path', async () => {
  const { server, json } = await listen();
  try {
    const health = await json('GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.ok, true);
    assert.equal(typeof health.data.frontendBuilt, 'boolean');
    assert.equal(health.data.frontendBuilt, fs.existsSync(clientIndex));
    assert.equal(health.data.dbPath, getDbPath());
    assert.ok(fs.existsSync(getDbPath()), 'sqlite file should exist after migrate');
    // Prove the path is writable under PERMIT_DB_PATH
    fs.accessSync(path.dirname(getDbPath()), fs.constants.W_OK);
  } finally {
    server.close();
  }
});

test('multer 2.x memory upload still previews workbook via multipart', async () => {
  const { server, multipart } = await listen();
  try {
    const buf = buildSanitizedWorkbookBuffer();
    const preview = await multipart(
      '/api/import/workbook/preview',
      'file',
      'sanitized-source-workbook.xlsx',
      buf
    );
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    assert.equal(preview.data.filename, 'sanitized-source-workbook.xlsx');
    assert.ok(Array.isArray(preview.data.sheets));
    assert.ok(preview.data.sheets.length >= 1);
    assert.ok(preview.data.sectionCount >= 1);
  } finally {
    server.close();
  }
});
