/**
 * Durable server-side sync jobs with leases and retries.
 * Bulk Fairfax / linked checks enqueue here so browser close does not cancel work.
 */
import crypto from 'node:crypto';
import { db } from './db.js';
import { syncAllLinked, rebuildAttention } from './sync.js';

const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const TICK_MS = 1500;

let workerTimer = null;
let ticking = false;
const ownerId = `worker-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

export function ensureSyncJobTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL DEFAULT 'linked',
      trigger TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'queued',
      fairfax_only INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      lease_owner TEXT,
      lease_until TEXT,
      next_run_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      finished_at TEXT,
      summary_json TEXT DEFAULT '{}',
      error TEXT DEFAULT '',
      created_by TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sync_jobs_status_next
      ON sync_jobs(status, next_run_at);
  `);
}

export function enqueueSyncJob({
  fairfaxOnly = false,
  trigger = 'manual',
  createdBy = '',
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
} = {}) {
  ensureSyncJobTables();
  // Coalesce an identical in-flight/queued job to avoid stampede from double-clicks
  const existing = db
    .prepare(
      `SELECT * FROM sync_jobs
       WHERE fairfax_only = ? AND status IN ('queued','running')
       ORDER BY id DESC LIMIT 1`
    )
    .get(fairfaxOnly ? 1 : 0);
  if (existing) {
    return { job: existing, coalesced: true };
  }
  const info = db
    .prepare(
      `INSERT INTO sync_jobs(scope, trigger, status, fairfax_only, max_attempts, created_by, next_run_at)
       VALUES (?, ?, 'queued', ?, ?, ?, datetime('now'))`
    )
    .run(
      fairfaxOnly ? 'fairfax_candidates' : 'linked',
      trigger,
      fairfaxOnly ? 1 : 0,
      maxAttempts,
      createdBy || ''
    );
  const job = getSyncJob(Number(info.lastInsertRowid));
  return { job, coalesced: false };
}

export function getSyncJob(id) {
  ensureSyncJobTables();
  return db.prepare('SELECT * FROM sync_jobs WHERE id = ?').get(Number(id)) || null;
}

export function listSyncJobs({ limit = 25 } = {}) {
  ensureSyncJobTables();
  return db
    .prepare(`SELECT * FROM sync_jobs ORDER BY id DESC LIMIT ?`)
    .all(Math.min(100, Math.max(1, Number(limit) || 25)));
}

function claimNextJob(leaseMs = DEFAULT_LEASE_MS) {
  ensureSyncJobTables();
  const nowIso = new Date().toISOString();
  // Recover expired leases
  db.prepare(
    `UPDATE sync_jobs SET status = 'queued', lease_owner = NULL, lease_until = NULL,
       error = COALESCE(error,'') || CASE WHEN error = '' THEN '' ELSE '; ' END || 'lease_expired',
       updated_at = datetime('now')
     WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?`
  ).run(nowIso);

  const candidate = db
    .prepare(
      `SELECT * FROM sync_jobs
       WHERE status = 'queued' AND next_run_at <= ?
         AND attempts < max_attempts
       ORDER BY id ASC LIMIT 1`
    )
    .get(nowIso);
  if (!candidate) return null;

  const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
  const claimed = db
    .prepare(
      `UPDATE sync_jobs SET status = 'running', lease_owner = ?, lease_until = ?,
       attempts = attempts + 1, started_at = COALESCE(started_at, datetime('now')),
       updated_at = datetime('now')
       WHERE id = ? AND status = 'queued'`
    )
    .run(ownerId, leaseUntil, candidate.id);
  if (claimed.changes !== 1) return null;
  return getSyncJob(candidate.id);
}

function finishJob(id, { status, summary, error }) {
  db.prepare(
    `UPDATE sync_jobs SET status = ?, finished_at = datetime('now'), lease_owner = NULL, lease_until = NULL,
       summary_json = ?, error = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(status, JSON.stringify(summary || {}), error || '', id);
}

function requeueJob(id, { error, backoffMs = 5000 }) {
  const job = getSyncJob(id);
  if (!job) return;
  if (job.attempts >= job.max_attempts) {
    finishJob(id, { status: 'failed', summary: {}, error: error || 'max_attempts' });
    return;
  }
  const next = new Date(Date.now() + backoffMs).toISOString();
  db.prepare(
    `UPDATE sync_jobs SET status = 'queued', lease_owner = NULL, lease_until = NULL,
       next_run_at = ?, error = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(next, error || '', id);
}

export async function processOneSyncJob() {
  const job = claimNextJob();
  if (!job) return null;
  try {
    const result = await syncAllLinked({
      fairfaxOnly: Boolean(job.fairfax_only),
      trigger: job.trigger || 'job',
    });
    rebuildAttention();
    finishJob(job.id, {
      status: 'succeeded',
      summary: {
        runId: result.runId,
        counts: result.counts,
        diagnostic: result.diagnostic || null,
      },
      error: '',
    });
    return getSyncJob(job.id);
  } catch (err) {
    const message = err?.message || String(err);
    requeueJob(job.id, { error: message, backoffMs: 4000 * Math.max(1, job.attempts) });
    return getSyncJob(job.id);
  }
}

export async function tickSyncJobs() {
  if (ticking) return;
  ticking = true;
  try {
    await processOneSyncJob();
  } finally {
    ticking = false;
  }
}

/** Start background worker (no-op if already running or disabled). */
export function startSyncJobWorker({ intervalMs = TICK_MS } = {}) {
  if (process.env.PERMIT_SYNC_JOBS === '0') return null;
  ensureSyncJobTables();
  if (workerTimer) return workerTimer;
  workerTimer = setInterval(() => {
    tickSyncJobs().catch((err) => {
      console.error('sync job tick failed', err?.message || err);
    });
  }, intervalMs);
  if (typeof workerTimer.unref === 'function') workerTimer.unref();
  // Kick once
  tickSyncJobs().catch(() => {});
  return workerTimer;
}

export function stopSyncJobWorker() {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}

/** Test helper: drain until idle or maxTicks. */
export async function drainSyncJobs({ maxTicks = 40 } = {}) {
  for (let i = 0; i < maxTicks; i += 1) {
    const before = db
      .prepare(`SELECT COUNT(*) AS c FROM sync_jobs WHERE status IN ('queued','running')`)
      .get().c;
    if (before === 0) return;
    // eslint-disable-next-line no-await-in-loop
    await processOneSyncJob();
  }
}
